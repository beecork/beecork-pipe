/**
 * Small store wrapping the `memories` table. Used by the MCP and dashboard
 * layers instead of inline `INSERT INTO memories` so schema details stay in
 * one place.
 */

import type Database from 'better-sqlite3';
import { getDb } from '../db/index.js';

export interface MemoryRow {
  id: number;
  content: string;
  tabName: string | null;
  source: string;
  createdAt: string;
}

interface RawMemoryRow {
  id: number;
  content: string;
  tab_name: string | null;
  source: string;
  created_at: string;
}

function rowToMemory(r: RawMemoryRow): MemoryRow {
  return {
    id: r.id,
    content: r.content,
    tabName: r.tab_name,
    source: r.source,
    createdAt: r.created_at,
  };
}

export const MemoryStore = {
  add(
    content: string,
    opts?: { tabName?: string | null; source?: string },
    db: Database.Database = getDb(),
  ): void {
    db.prepare('INSERT INTO memories (content, tab_name, source) VALUES (?, ?, ?)').run(
      content,
      opts?.tabName ?? null,
      opts?.source ?? 'tool',
    );
  },

  delete(id: number | string, db: Database.Database = getDb()): boolean {
    const result = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    return result.changes > 0;
  },

  count(db: Database.Database = getDb()): number {
    return (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
  },

  list(
    opts: { limit?: number; offset?: number; query?: string } = {},
    db: Database.Database = getDb(),
  ): { memories: MemoryRow[]; total: number } {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    if (opts.query) {
      const rows = db
        .prepare(
          'SELECT id, content, tab_name, source, created_at FROM memories WHERE content LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
        )
        .all(`%${opts.query}%`, limit, offset) as RawMemoryRow[];
      const total = (
        db
          .prepare('SELECT COUNT(*) as c FROM memories WHERE content LIKE ?')
          .get(`%${opts.query}%`) as { c: number }
      ).c;
      return { memories: rows.map(rowToMemory), total };
    }
    const rows = db
      .prepare(
        'SELECT id, content, tab_name, source, created_at FROM memories ORDER BY created_at DESC LIMIT ? OFFSET ?',
      )
      .all(limit, offset) as RawMemoryRow[];
    const total = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
    return { memories: rows.map(rowToMemory), total };
  },
};
