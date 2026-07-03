import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDbPath, ensureBeecorkDirs, expandHome } from '../util/paths.js';
import { runMigrations } from './migrations.js';
import { openDb } from './connection.js';
import { logger } from '../util/logger.js';

/** Base schema (the original v1 table shapes). Later columns/tables live in
 *  migrations — build a real schema in tests with `db.exec(SCHEMA); runMigrations(db)`. */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS tabs (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  working_dir TEXT NOT NULL,
  pid INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tab_id TEXT NOT NULL REFERENCES tabs(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  cost_usd REAL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_tab ON messages(tab_id, created_at);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  tab_name TEXT,
  source TEXT NOT NULL DEFAULT 'tool',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pending_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tab_name TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pending_unprocessed ON pending_messages(processed, created_at);
`;

let db: Database.Database | null = null;
let walInterval: NodeJS.Timeout | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  ensureBeecorkDirs();
  const dbPath = getDbPath();
  db = openDb(dbPath, { enforcePerms: true });
  db.exec(SCHEMA);
  runMigrations(db);

  // Periodic WAL checkpointing + table cleanup. Cheap precheck `LIMIT 1`
  // SELECTs skip the DELETE entirely when nothing matches — saves the WAL
  // write on a quiet system.
  walInterval = setInterval(
    () => {
      try {
        db?.pragma('wal_checkpoint(PASSIVE)');
        if (!db) return;

        // Prune old permission history (keep last 1000 entries). Two-pass: count
        // first, then bulk-delete the oldest N. The previous correlated-subquery
        // version re-evaluated the OFFSET 999 row per candidate, which scaled
        // poorly past ~5k rows.
        const permCount = (
          db.prepare('SELECT COUNT(*) as c FROM permission_history').get() as { c: number }
        ).c;
        if (permCount > 1000) {
          db.prepare(
            `DELETE FROM permission_history WHERE id IN (
             SELECT id FROM permission_history ORDER BY created_at ASC LIMIT ?
           )`,
          ).run(permCount - 1000);
        }

        // Activity log: only DELETE if a candidate row exists, otherwise no-op.
        const oldActivity = db
          .prepare(
            "SELECT 1 FROM activity_log WHERE created_at < datetime('now', '-90 days') LIMIT 1",
          )
          .get();
        if (oldActivity)
          db.exec("DELETE FROM activity_log WHERE created_at < datetime('now', '-90 days')");

        // Routing preferences: same precheck pattern.
        const stalePref = db
          .prepare(
            "SELECT 1 FROM routing_preferences WHERE hit_count < 3 AND created_at < datetime('now', '-30 days') LIMIT 1",
          )
          .get();
        if (stalePref) {
          db.exec(
            "DELETE FROM routing_preferences WHERE hit_count < 3 AND created_at < datetime('now', '-30 days')",
          );
        }
      } catch (err) {
        logger.warn('WAL checkpoint/cleanup error:', err);
      }
    },
    30 * 60 * 1000,
  ); // every 30 minutes

  return db;
}

export interface CreateTabOptions {
  name: string;
  workingDir?: string;
  systemPrompt?: string | null;
}

/**
 * Tab record creation for the dashboard and MCP `beecork_tab_create` paths
 * (both pass an explicit workingDir that must be validated here).
 * NOTE: TabManager.ensureTab() does NOT go through this — it has its own insert
 * with project-path resolution and channel-driven defaults. Keep the two INSERT
 * column lists in sync if either changes.
 */
export function createTabRecord(
  db: Database.Database,
  opts: CreateTabOptions,
): { id: string; name: string; created: boolean } {
  const existing = db.prepare('SELECT name FROM tabs WHERE name = ?').get(opts.name) as
    | { name: string }
    | undefined;
  if (existing) return { id: '', name: opts.name, created: false };

  // Resolve and validate workingDir. Done here so every caller (CLI, dashboard, MCP)
  // gets the same checks instead of each rolling its own.
  let dir = opts.workingDir || process.env.HOME || '/';
  dir = path.resolve(expandHome(dir));
  if (!fs.existsSync(dir)) {
    throw new Error(`workingDir does not exist: ${dir}`);
  }
  if (!fs.statSync(dir).isDirectory()) {
    throw new Error(`workingDir is not a directory: ${dir}`);
  }

  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO tabs (id, name, session_id, status, working_dir, system_prompt) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, opts.name, crypto.randomUUID(), 'idle', dir, opts.systemPrompt || null);
  return { id, name: opts.name, created: true };
}

export function closeDb(): void {
  if (walInterval) {
    clearInterval(walInterval);
    walInterval = null;
  }
  if (db) {
    db.close();
    db = null;
  }
}
