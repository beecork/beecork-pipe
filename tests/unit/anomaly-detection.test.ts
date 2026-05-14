import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { checkAnomaliesWithDb } from '../../src/observability/analytics.js';

const SCHEMA = `
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tab_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  cost_usd REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
`;

function insertSpend(db: Database.Database, daysAgo: number, cost: number) {
  const when = daysAgo === 0
    ? "datetime('now')"
    : `datetime('now', '-${daysAgo} days', '+1 hour')`;
  db.prepare(`INSERT INTO messages (tab_id, role, content, cost_usd, created_at) VALUES ('t', 'assistant', '', ?, ${when})`).run(cost);
}

describe('checkAnomaliesWithDb', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
  });

  afterEach(() => {
    db.close();
  });

  it('returns null when there is no spend history', () => {
    expect(checkAnomaliesWithDb(db)).toBeNull();
  });

  it('returns null when today is within 2x the 7-day average', () => {
    for (let d = 1; d <= 7; d++) insertSpend(db, d, 0.5);
    insertSpend(db, 0, 0.5);
    expect(checkAnomaliesWithDb(db)).toBeNull();
  });

  it('warns on ok→breach transition', () => {
    for (let d = 1; d <= 7; d++) insertSpend(db, d, 0.1);
    insertSpend(db, 0, 1.0); // 10x average
    const msg = checkAnomaliesWithDb(db);
    expect(msg).toMatch(/Anomaly/);
  });

  it('stays silent on breach→breach (the bug we fixed)', () => {
    for (let d = 1; d <= 7; d++) insertSpend(db, d, 0.1);
    insertSpend(db, 0, 1.0);

    const first = checkAnomaliesWithDb(db);
    expect(first).toMatch(/Anomaly/);

    // Same condition still holds, second poll must be silent
    const second = checkAnomaliesWithDb(db);
    expect(second).toBeNull();

    const third = checkAnomaliesWithDb(db);
    expect(third).toBeNull();
  });

  it('emits a recovery message on breach→ok transition', () => {
    for (let d = 1; d <= 7; d++) insertSpend(db, d, 0.1);
    insertSpend(db, 0, 1.0);
    expect(checkAnomaliesWithDb(db)).toMatch(/Anomaly/);

    // Simulate today's spend resetting (new day)
    db.exec("DELETE FROM messages WHERE created_at > date('now')");

    expect(checkAnomaliesWithDb(db)).toMatch(/Recovered/);
    // And then silence on ok→ok
    expect(checkAnomaliesWithDb(db)).toBeNull();
  });

  it('persists state across calls via the preferences table', () => {
    for (let d = 1; d <= 7; d++) insertSpend(db, d, 0.1);
    insertSpend(db, 0, 1.0);
    checkAnomaliesWithDb(db);

    const row = db.prepare('SELECT value FROM preferences WHERE key = ?').get('anomaly_spend_state') as { value: string };
    expect(row.value).toBe('breach');
  });
});
