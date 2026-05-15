/**
 * Inter-process IPC store for the `pending_messages` table.
 *
 * Beecork uses this table as a shared queue between writers (MCP handlers,
 * dashboard routes, watchers, delegations) and the daemon's poll loop. Before
 * this module the writes were inline `INSERT INTO pending_messages` calls
 * scattered across nine sites; the consumer in TabManager only branched on
 * type='notification' which meant every other type fell through to "send as
 * a plain user prompt" — including `type='media'` rows whose JSON envelope
 * was being handed to Claude as text instead of being rendered.
 *
 * This store owns:
 *   - the typed envelope (`PendingMessageType` union, no more magic strings)
 *   - 3-state status (`pending` → `processing` → `done|failed`) so the 5s
 *     poll loop doesn't re-dispatch long-running rows
 *   - the `_notify` sentinel removal (notifications now use type alone,
 *     tab_name is nullable)
 *   - claim/recover semantics so a daemon crash mid-dispatch resets in-flight
 *     rows back to pending after a 30-minute timeout
 */

import type Database from 'better-sqlite3';
import { getDb } from '../db/index.js';
import { logger } from '../util/logger.js';

export type PendingMessageType =
  | 'user'
  | 'notification'
  | 'media'
  | 'delegation'
  | 'delegation_result'
  | 'replay';

export interface PendingRow {
  id: number;
  tabName: string | null;
  message: string;
  type: PendingMessageType;
  status: 'pending' | 'processing' | 'done' | 'failed';
  createdAt: string;
}

interface MediaPayload {
  type: 'media';
  filePath: string;
  caption?: string;
}

interface RawPendingRow {
  id: number;
  tab_name: string | null;
  message: string;
  type: string | null;
  status: string | null;
  created_at: string;
}

function rowToPending(r: RawPendingRow): PendingRow {
  return {
    id: r.id,
    tabName: r.tab_name,
    message: r.message,
    type: (r.type as PendingMessageType) || 'user',
    status: (r.status as PendingRow['status']) || 'pending',
    createdAt: r.created_at,
  };
}

const STALE_PROCESSING_MS = 30 * 60 * 1000; // 30 minutes

// Private INSERT helper — all five enqueue* methods were the same INSERT with
// different literals. Notification rows use '' for tab_name since the consumer
// branches on type rather than reading the tab.
function insertPending(
  db: Database.Database,
  tabName: string,
  message: string,
  type: PendingMessageType,
): void {
  db.prepare(
    'INSERT INTO pending_messages (tab_name, message, type, status) VALUES (?, ?, ?, ?)',
  ).run(tabName, message, type, 'pending');
}

export const PendingMessageStore = {
  enqueueUser(tabName: string, message: string, db: Database.Database = getDb()): void {
    insertPending(db, tabName, message, 'user');
  },

  enqueueNotification(message: string, db: Database.Database = getDb()): void {
    insertPending(db, '', message, 'notification');
  },

  enqueueMedia(tabName: string, payload: MediaPayload, db: Database.Database = getDb()): void {
    insertPending(db, tabName, JSON.stringify(payload), 'media');
  },

  enqueueDelegation(tabName: string, message: string, db: Database.Database = getDb()): void {
    insertPending(db, tabName, message, 'delegation');
  },

  enqueueDelegationResult(tabName: string, message: string, db: Database.Database = getDb()): void {
    insertPending(db, tabName, message, 'delegation_result');
  },

  enqueueReplay(tabName: string, message: string, db: Database.Database = getDb()): void {
    insertPending(db, tabName, message, 'replay');
  },

  /**
   * Claim up to `limit` pending rows atomically. The rows are flipped to
   * status='processing' inside a transaction so a second poll tick can't pick
   * them up. Returns the claimed rows.
   */
  claimBatch(limit: number, db: Database.Database = getDb()): PendingRow[] {
    const claim = db.transaction((max: number): PendingRow[] => {
      const rows = db
        .prepare(
          "SELECT id, tab_name, message, type, status, created_at FROM pending_messages WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?",
        )
        .all(max) as RawPendingRow[];
      if (rows.length === 0) return [];
      const stmt = db.prepare(
        "UPDATE pending_messages SET status = 'processing' WHERE id = ? AND status = 'pending'",
      );
      const claimed: PendingRow[] = [];
      for (const r of rows) {
        const result = stmt.run(r.id);
        if (result.changes > 0) claimed.push(rowToPending(r));
      }
      return claimed;
    });
    return claim(limit);
  },

  markDone(id: number, db: Database.Database = getDb()): void {
    db.prepare("UPDATE pending_messages SET status = 'done', processed = 1 WHERE id = ?").run(id);
  },

  markFailed(id: number, db: Database.Database = getDb()): void {
    // 'failed' rows are kept for diagnostics until the periodic cleanup sweeps
    // them. They are NOT re-dispatched — preserves the original "no infinite
    // retries" policy while keeping the row visible for postmortem queries.
    db.prepare("UPDATE pending_messages SET status = 'failed', processed = 1 WHERE id = ?").run(id);
  },

  /**
   * Reset stuck `processing` rows back to `pending`. Run at daemon startup so
   * a crash mid-dispatch doesn't leave rows permanently in-flight. The 30min
   * window is well beyond the 30min subprocess runtime cap.
   */
  recoverProcessing(db: Database.Database = getDb()): number {
    const result = db
      .prepare(
        `UPDATE pending_messages SET status = 'pending'
       WHERE status = 'processing' AND created_at < datetime('now', '-' || ? || ' seconds')`,
      )
      .run(Math.floor(STALE_PROCESSING_MS / 1000));
    if (result.changes > 0) {
      logger.warn(
        `Recovered ${result.changes} stuck pending_messages rows from 'processing' state`,
      );
    }
    return result.changes;
  },

  /** Parse a media row's message JSON. Returns null on malformed JSON. */
  parseMediaPayload(message: string): MediaPayload | null {
    try {
      const parsed = JSON.parse(message) as MediaPayload;
      if (parsed?.type === 'media' && typeof parsed.filePath === 'string') return parsed;
      return null;
    } catch {
      return null;
    }
  },
};
