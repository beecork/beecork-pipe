import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/db/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/db/index.js')>();
  return { ...orig, getDb: () => testDb };
});
vi.mock('../../src/util/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { SCHEMA } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrations.js';

function columns(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

beforeEach(() => {
  testDb = new Database(':memory:');
});
afterEach(() => testDb.close());

describe('migration runner (H13 regression guard)', () => {
  it('brings a fresh DB to the latest version with the expected schema', () => {
    testDb.exec(SCHEMA);
    runMigrations(testDb);

    const version = (testDb.prepare('SELECT version FROM schema_version').get() as {
      version: number;
    }).version;
    expect(version).toBe(30);

    // Columns added by later migrations must exist (base SCHEMA alone lacks them).
    const pending = columns(testDb, 'pending_messages');
    expect(pending).toEqual(expect.arrayContaining(['status', 'ref_id', 'claimed_at']));

    // Tables created only via migrations must exist.
    const tables = (
      testDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['delegations', 'watchers', 'tasks']));
  });

  it('is idempotent — running twice does not error or change the version', () => {
    testDb.exec(SCHEMA);
    runMigrations(testDb);
    expect(() => runMigrations(testDb)).not.toThrow();
    const version = (testDb.prepare('SELECT version FROM schema_version').get() as {
      version: number;
    }).version;
    expect(version).toBe(30);
  });
});
