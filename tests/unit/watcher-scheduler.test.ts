import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/db/index.js', () => ({
  getDb: () => testDb,
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    unlinkSync: vi.fn(),
    promises: { appendFile: vi.fn().mockResolvedValue(undefined) },
  },
}));

vi.mock('../../src/util/paths.js', () => ({
  getBeecorkHome: () => '/tmp/.beecork',
  getLogsDir: () => '/tmp/.beecork/logs',
}));

vi.mock('../../src/util/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const evaluateWatcher = vi.fn();
vi.mock('../../src/watchers/evaluator.js', () => ({
  evaluateWatcher: (...args: unknown[]) => evaluateWatcher(...args),
}));

import { WatcherScheduler } from '../../src/watchers/scheduler.js';

const WATCHERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS watchers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  check_command TEXT NOT NULL,
  condition TEXT NOT NULL,
  action TEXT NOT NULL,
  action_details TEXT,
  schedule TEXT NOT NULL,
  last_check_at TEXT,
  last_triggered_at TEXT,
  trigger_count INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function insertWatcher(id: string, schedule: string, lastCheckAt: string | null) {
  testDb.prepare(
    `INSERT INTO watchers (id, name, check_command, condition, action, schedule, last_check_at)
     VALUES (?, ?, 'echo ok', 'output contains foo', 'notify', ?, ?)`,
  ).run(id, `watcher-${id}`, schedule, lastCheckAt);
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('WatcherScheduler.tick', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(WATCHERS_SCHEMA);
    evaluateWatcher.mockReset();
    evaluateWatcher.mockResolvedValue({ triggered: false, output: 'ok' });
  });

  afterEach(() => {
    testDb.close();
  });

  it('fires a ready watcher whose nextCheckAt has elapsed', async () => {
    // 5m schedule, lastCheckAt 10m ago → due was 5m ago
    const pastIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    insertWatcher('w1', '5m', pastIso);

    const scheduler = new WatcherScheduler();
    scheduler.loadAndSchedule();
    scheduler.tick();
    await flush();

    expect(evaluateWatcher).toHaveBeenCalledTimes(1);

    const row = testDb.prepare('SELECT last_check_at FROM watchers WHERE id = ?').get('w1') as { last_check_at: string };
    expect(row.last_check_at).toBeTruthy();
    expect(new Date(row.last_check_at).getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it('advances nextCheckAt by the interval after firing', async () => {
    const pastIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    insertWatcher('w2', '5m', pastIso);

    const scheduler = new WatcherScheduler();
    scheduler.loadAndSchedule();

    const beforeTick = Date.now();
    scheduler.tick();
    await flush();

    // Second tick should not re-fire — nextCheckAt is now ~5m in the future
    scheduler.tick();
    await flush();
    expect(evaluateWatcher).toHaveBeenCalledTimes(1);

    // Sanity: at least 5m - 1s ahead of when we first ticked
    const fiveMinMs = 5 * 60 * 1000;
    expect(Date.now() - beforeTick).toBeLessThan(fiveMinMs);
  });

  it('fires exactly once after a long sleep window (8h overdue)', async () => {
    const overdueIso = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
    insertWatcher('w3', '5m', overdueIso); // 5m schedule, 8h overdue → ~96 missed checks

    const scheduler = new WatcherScheduler();
    scheduler.loadAndSchedule();

    scheduler.tick();
    await flush();
    expect(evaluateWatcher).toHaveBeenCalledTimes(1);

    // Catch-up policy: fire once, not 96 times
    scheduler.tick();
    await flush();
    expect(evaluateWatcher).toHaveBeenCalledTimes(1);
  });
});
