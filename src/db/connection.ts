/**
 * Single source of truth for opening the Beecork SQLite database.
 *
 * Previously three sites each opened the DB with their own pragma setup:
 *   - daemon side (db/index.ts) — applied migrations + WAL checkpoint interval
 *   - MCP side (mcp/server.ts)  — read-only-ish singleton, no migrations
 *   - doctor (cli/doctor.ts)    — ad-hoc read-only handle
 *
 * The pragmas matched today but the duplication was silent-drift bait. This
 * helper centralizes pragma setup so future tweaks land in one place.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';

export interface OpenDbOptions {
  /** Open the file read-only (used by `beecork-pipe doctor` for status snapshots). */
  readonly?: boolean;
  /**
   * If true, restrict file mode to 0o600 after open. Daemon side wants this;
   * read-only sidecar handles don't need to retouch perms.
   */
  enforcePerms?: boolean;
}

/**
 * Open a Beecork SQLite database with consistent pragmas.
 *
 * Migrations are NOT applied here — the daemon's `getDb()` runs migrations
 * separately, so this helper can be reused by the MCP child + doctor without
 * accidentally double-applying migrations.
 */
export function openDb(dbPath: string, opts: OpenDbOptions = {}): Database.Database {
  const db = new Database(dbPath, opts.readonly ? { readonly: true } : undefined);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (opts.enforcePerms && !opts.readonly) {
    for (const p of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
      try {
        fs.chmodSync(p, 0o600);
      } catch {
        /* sidecar may not exist yet */
      }
    }
  }
  return db;
}
