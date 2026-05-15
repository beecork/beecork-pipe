import type Database from 'better-sqlite3';
import { getDb } from '../db/index.js';
import type { Tab, TabStatus } from '../types.js';

interface TabRow {
  id: string;
  name: string;
  session_id: string;
  status: TabStatus;
  working_dir: string;
  created_at: string;
  last_activity_at: string;
  pid: number | null;
  system_prompt: string | null;
}

function rowToTab(row: TabRow): Tab {
  return {
    id: row.id,
    name: row.name,
    sessionId: row.session_id,
    status: row.status,
    workingDir: row.working_dir,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    pid: row.pid,
    systemPrompt: row.system_prompt,
  };
}

/**
 * SQL helpers for the `tabs` table. Single place for any code that needs to
 * read/write tab rows. TabManager owns subprocess lifecycle; TabStore owns
 * the schema knowledge.
 *
 * All methods accept an optional `db` param so they're testable against an
 * in-memory database. The no-arg form uses the singleton.
 */
export const TabStore = {
  listAll(db: Database.Database = getDb()): Tab[] {
    return (db.prepare('SELECT * FROM tabs ORDER BY last_activity_at DESC').all() as TabRow[]).map(rowToTab);
  },

  findByName(name: string, db: Database.Database = getDb()): Tab | undefined {
    const row = db.prepare('SELECT * FROM tabs WHERE name = ?').get(name) as TabRow | undefined;
    return row ? rowToTab(row) : undefined;
  },

  getIdByName(name: string, db: Database.Database = getDb()): string | undefined {
    const row = db.prepare('SELECT id FROM tabs WHERE name = ?').get(name) as { id: string } | undefined;
    return row?.id;
  },

  countAll(db: Database.Database = getDb()): number {
    return (db.prepare('SELECT COUNT(*) as c FROM tabs').get() as { c: number }).c;
  },

  countRunning(db: Database.Database = getDb()): number {
    return (db.prepare("SELECT COUNT(*) as c FROM tabs WHERE status = 'running'").get() as { c: number }).c;
  },

  /** All tabs marked 'running' — used by daemon crash-recovery on startup. */
  findRunning(db: Database.Database = getDb()): Tab[] {
    return (db.prepare("SELECT * FROM tabs WHERE status = 'running'").all() as TabRow[]).map(rowToTab);
  },

  /** Most-recently-active tab — used by MCP to surface "current" context. */
  mostRecent(db: Database.Database = getDb()): Tab | undefined {
    const row = db.prepare('SELECT * FROM tabs ORDER BY last_activity_at DESC LIMIT 1').get() as TabRow | undefined;
    return row ? rowToTab(row) : undefined;
  },

  setStatus(name: string, status: TabStatus, db: Database.Database = getDb()): void {
    db.prepare('UPDATE tabs SET status = ?, last_activity_at = ?, pid = NULL WHERE name = ?')
      .run(status, new Date().toISOString(), name);
  },

  setIdleById(id: string, db: Database.Database = getDb()): void {
    db.prepare("UPDATE tabs SET status = 'idle', pid = NULL WHERE id = ?").run(id);
  },

  /** Used by MCP close-tab to nudge daemon recovery loop. */
  markRunningAsStopped(name: string, db: Database.Database = getDb()): void {
    db.prepare("UPDATE tabs SET status = 'stopped', pid = NULL WHERE name = ? AND status = 'running'").run(name);
  },

  setSystemPrompt(name: string, systemPrompt: string, db: Database.Database = getDb()): boolean {
    const result = db.prepare('UPDATE tabs SET system_prompt = ? WHERE name = ?').run(systemPrompt, name);
    return result.changes > 0;
  },

  /** Delete a tab and all of its messages atomically. Returns true if it existed. */
  deleteWithMessages(name: string, db: Database.Database = getDb()): boolean {
    const id = this.getIdByName(name, db);
    if (!id) return false;
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM messages WHERE tab_id = ?').run(id);
      db.prepare('DELETE FROM tabs WHERE id = ?').run(id);
    });
    tx();
    return true;
  },
};
