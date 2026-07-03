import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { getDb } from '../db/index.js';
import { getCrontabPath } from '../util/paths.js';
import { logger } from '../util/logger.js';
import type { Task } from '../types.js';

// SQLite row uses snake_case
interface TaskRow {
  id: string;
  name: string;
  schedule_type: string;
  schedule: string;
  tab_name: string;
  message: string;
  enabled: number;
  payload_type?: string;
  created_at: string;
  last_run_at: string | null;
  next_run_at: string | null;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    name: row.name,
    scheduleType: row.schedule_type as Task['scheduleType'],
    schedule: row.schedule,
    tabName: row.tab_name,
    message: row.message,
    payloadType: (row.payload_type as Task['payloadType']) || 'agentTurn',
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
  };
}

// One-shot JSON migration only needs to run once per process lifetime, but the
// dashboard creates a fresh TaskStore per request and MCP creates one per task
// call. Without this flag, every instantiation re-fired existsSync + COUNT(*).
let migrationChecked = false;

export class TaskStore {
  private injectedDb?: Database.Database;

  // Pass a db (e.g. the MCP server's own connection) to avoid triggering the
  // daemon-side getDb() — which runs migrations + starts a WAL-checkpoint timer.
  // The MCP server runs as a child of `claude`, a separate process, and should
  // not re-run migrations or hold a second daemon-grade connection.
  constructor(db?: Database.Database) {
    this.injectedDb = db;
    // Only the daemon (no injected db) runs the one-shot crontab.json → SQLite
    // migration; the MCP child must not.
    if (!db && !migrationChecked) {
      migrationChecked = true;
      this.migrateFromJson();
    }
  }

  private db(): Database.Database {
    return this.injectedDb ?? getDb();
  }

  list(): Task[] {
    const db = this.db();
    return (db.prepare('SELECT * FROM tasks ORDER BY created_at').all() as TaskRow[]).map(
      rowToTask,
    );
  }

  get(id: string): Task | undefined {
    const db = this.db();
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  add(job: Task): void {
    const db = this.db();
    db.prepare(
      `INSERT INTO tasks (id, name, schedule_type, schedule, tab_name, message, payload_type, enabled, created_at, last_run_at, next_run_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      job.id,
      job.name,
      job.scheduleType,
      job.schedule,
      job.tabName,
      job.message,
      job.payloadType || 'agentTurn',
      job.enabled ? 1 : 0,
      job.createdAt,
      job.lastRunAt,
      job.nextRunAt,
    );
  }

  update(id: string, updates: Partial<Task>): boolean {
    const db = this.db();
    const existing = this.get(id);
    if (!existing) return false;

    // If the schedule changes, the stored next_run_at is no longer valid —
    // null it out so the scheduler recomputes from the new expression on
    // next load. Caller can override by explicitly passing nextRunAt.
    const scheduleChanged =
      (updates.schedule !== undefined && updates.schedule !== existing.schedule) ||
      (updates.scheduleType !== undefined && updates.scheduleType !== existing.scheduleType);
    const merged = { ...existing, ...updates };
    if (scheduleChanged && updates.nextRunAt === undefined) merged.nextRunAt = null;

    db.prepare(
      `UPDATE tasks SET name=?, schedule_type=?, schedule=?, tab_name=?, message=?, payload_type=?, enabled=?, last_run_at=?, next_run_at=? WHERE id=?`,
    ).run(
      merged.name,
      merged.scheduleType,
      merged.schedule,
      merged.tabName,
      merged.message,
      merged.payloadType,
      merged.enabled ? 1 : 0,
      merged.lastRunAt,
      merged.nextRunAt,
      id,
    );
    return true;
  }

  delete(id: string): boolean {
    const db = this.db();
    const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /** One-time migration from crontab.json to SQLite */
  private migrateFromJson(): void {
    const jsonPath = getCrontabPath();
    if (!fs.existsSync(jsonPath)) return;

    const db = this.db();
    const count = db.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number };
    if (count.count > 0) {
      // Already migrated, clean up JSON
      try {
        fs.renameSync(jsonPath, jsonPath + '.bak');
      } catch {
        /* ok */
      }
      return;
    }

    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      const jobs = data.jobs || [];
      if (jobs.length === 0) return;

      const insert =
        db.prepare(`INSERT OR IGNORE INTO tasks (id, name, schedule_type, schedule, tab_name, message, enabled, created_at, last_run_at, next_run_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

      const tx = db.transaction(() => {
        for (const j of jobs) {
          insert.run(
            j.id,
            j.name,
            j.scheduleType,
            j.schedule,
            j.tabName || 'default',
            j.message,
            j.enabled ? 1 : 0,
            j.createdAt,
            j.lastRunAt,
            j.nextRunAt,
          );
        }
      });
      tx();

      fs.renameSync(jsonPath, jsonPath + '.bak');
      logger.info(`Migrated ${jobs.length} tasks from JSON to SQLite`);
    } catch (err) {
      logger.error('Failed to migrate tasks from JSON:', err);
    }
  }
}
