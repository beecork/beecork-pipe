import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';

let testDb: Database.Database;

vi.mock('../../src/db/index.js', () => ({
  getDb: () => testDb,
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    unlinkSync: vi.fn(),
    readFileSync: vi.fn(),
    renameSync: vi.fn(),
    promises: { appendFile: vi.fn().mockResolvedValue(undefined) },
  },
}));

vi.mock('../../src/util/paths.js', () => ({
  getCronReloadSignalPath: () => '/tmp/.cron-reload',
  getLogsDir: () => '/tmp/.beecork/logs',
  getCrontabPath: () => '/tmp/crontab.json',
  getBeecorkHome: () => '/tmp/.beecork',
}));

vi.mock('../../src/util/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { TaskScheduler, intervalToCron, intervalToMs } from '../../src/tasks/scheduler.js';
import type { TabManager } from '../../src/session/manager.js';

const TASKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  schedule_type TEXT NOT NULL,
  schedule TEXT NOT NULL,
  tab_name TEXT NOT NULL DEFAULT 'default',
  message TEXT NOT NULL,
  payload_type TEXT DEFAULT 'agentTurn',
  enabled INTEGER NOT NULL DEFAULT 1,
  user_id TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_run_at TEXT,
  next_run_at TEXT
);
`;

function insertCronTask(id: string, schedule: string, nextRunAt: string | null) {
  testDb.prepare(
    `INSERT INTO tasks (id, name, schedule_type, schedule, tab_name, message, user_id, next_run_at)
     VALUES (?, ?, 'cron', ?, 'default', 'hello', 'local', ?)`,
  ).run(id, `task-${id}`, schedule, nextRunAt);
}

function makeTabManager() {
  return {
    ensureTab: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ text: 'ok', error: false }),
  } as unknown as TabManager;
}

// Yield to the microtask queue so the void-detached fireJob promise can run.
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('intervalToCron', () => {
  it('should convert minutes', () => {
    expect(intervalToCron('30m')).toBe('*/30 * * * *');
    expect(intervalToCron('5m')).toBe('*/5 * * * *');
    expect(intervalToCron('1m')).toBe('*/1 * * * *');
  });

  it('should convert hours', () => {
    expect(intervalToCron('2h')).toBe('0 */2 * * *');
    expect(intervalToCron('1h')).toBe('0 */1 * * *');
  });

  it('should convert single-day interval', () => {
    expect(intervalToCron('1d')).toBe('0 0 */1 * *');
    // Multi-day intervals do NOT map cleanly to `*/N` day-of-month (it resets
    // each month), so they fall back to exact intervalToMs scheduling.
    expect(intervalToCron('7d')).toBeNull();
    expect(intervalToCron('2d')).toBeNull();
  });

  it('should convert single-week interval', () => {
    expect(intervalToCron('1w')).toBe('0 0 * * 0');
    // Multi-week does not align to a weekly cron.
    expect(intervalToCron('2w')).toBeNull();
  });

  it('should return null for non-divisor minute/hour intervals (M14 — exact spacing via intervalToMs)', () => {
    // 45m as `*/45` would fire at :00 and :45 (45 then 15 min gap), not every 45m.
    expect(intervalToCron('45m')).toBeNull();
    expect(intervalToCron('7m')).toBeNull();
    // 5h as `0 */5` would fire at 0,5,10,15,20 then wrap (4h gap), not every 5h.
    expect(intervalToCron('5h')).toBeNull();
    // Divisor intervals still align cleanly.
    expect(intervalToCron('15m')).toBe('*/15 * * * *');
    expect(intervalToCron('6h')).toBe('0 */6 * * *');
  });

  it('should return null for combined intervals (handled by intervalToMs fallback)', () => {
    expect(intervalToCron('1h30m')).toBeNull();
    expect(intervalToCron('2h15m')).toBeNull();
  });

  it('should return null for invalid input', () => {
    expect(intervalToCron('')).toBeNull();
    expect(intervalToCron('invalid')).toBeNull();
    expect(intervalToCron('abc123')).toBeNull();
  });

  it('should return null for zero interval', () => {
    expect(intervalToCron('0m')).toBeNull();
  });
});

describe('intervalToMs', () => {
  it('should convert minutes to milliseconds', () => {
    expect(intervalToMs('30m')).toBe(30 * 60 * 1000);
    expect(intervalToMs('5m')).toBe(5 * 60 * 1000);
  });

  it('should convert hours to milliseconds', () => {
    expect(intervalToMs('2h')).toBe(2 * 60 * 60 * 1000);
  });

  it('should convert combined intervals', () => {
    expect(intervalToMs('1h30m')).toBe((60 + 30) * 60 * 1000);
    expect(intervalToMs('2h15m')).toBe((120 + 15) * 60 * 1000);
  });

  it('should convert weeks', () => {
    expect(intervalToMs('1w')).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('should convert days', () => {
    expect(intervalToMs('1d')).toBe(24 * 60 * 60 * 1000);
  });

  it('should return null for invalid input', () => {
    expect(intervalToMs('')).toBeNull();
    expect(intervalToMs('invalid')).toBeNull();
    expect(intervalToMs('abc')).toBeNull();
  });

  it('should return null for zero interval', () => {
    expect(intervalToMs('0m')).toBeNull();
  });
});

describe('TaskScheduler.tick', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(TASKS_SCHEMA);
  });

  afterEach(() => {
    testDb.close();
  });

  it('fires a ready task whose nextRunAt has elapsed', async () => {
    const pastIso = new Date(Date.now() - 1000).toISOString();
    insertCronTask('t1', '*/5 * * * *', pastIso);

    const tabManager = makeTabManager();
    const scheduler = new TaskScheduler(tabManager, null);
    scheduler.loadAndSchedule();
    scheduler.tick();
    await flush();

    expect(tabManager.sendMessage).toHaveBeenCalledTimes(1);
    expect(tabManager.sendMessage).toHaveBeenCalledWith('default', 'hello');

    const row = testDb.prepare('SELECT last_run_at FROM tasks WHERE id = ?').get('t1') as { last_run_at: string };
    expect(row.last_run_at).toBeTruthy();
  });

  it('advances nextRunAt to a future cron match after firing', async () => {
    const pastIso = new Date(Date.now() - 1000).toISOString();
    insertCronTask('t2', '*/5 * * * *', pastIso);

    const tabManager = makeTabManager();
    const scheduler = new TaskScheduler(tabManager, null);
    scheduler.loadAndSchedule();
    scheduler.tick();
    await flush();

    const row = testDb.prepare('SELECT next_run_at FROM tasks WHERE id = ?').get('t2') as { next_run_at: string };
    const newNext = new Date(row.next_run_at).getTime();
    expect(newNext).toBeGreaterThan(Date.now());

    // Should match what cron-parser produces for the same expression
    const expected = CronExpressionParser.parse('*/5 * * * *').next().getTime();
    expect(newNext).toBeCloseTo(expected, -2); // within ~100ms
  });

  it('fires exactly once after a long sleep window (24h overdue)', async () => {
    const overdueIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    insertCronTask('t3', '*/5 * * * *', overdueIso);

    const tabManager = makeTabManager();
    const scheduler = new TaskScheduler(tabManager, null);
    scheduler.loadAndSchedule();

    scheduler.tick();
    await flush();
    expect(tabManager.sendMessage).toHaveBeenCalledTimes(1);

    // Second tick should NOT re-fire — nextRunAt has been advanced to the future.
    scheduler.tick();
    await flush();
    expect(tabManager.sendMessage).toHaveBeenCalledTimes(1);

    const row = testDb.prepare('SELECT next_run_at FROM tasks WHERE id = ?').get('t3') as { next_run_at: string };
    expect(new Date(row.next_run_at).getTime()).toBeGreaterThan(Date.now());
  });
});
