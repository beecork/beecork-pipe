import { CronExpressionParser } from 'cron-parser';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { TaskStore } from './store.js';
import { getCronReloadSignalPath, getLogsDir } from '../util/paths.js';
import { logger } from '../util/logger.js';
import type { TabManager, NotifyCallback } from '../session/manager.js';
import type { Task } from '../types.js';

export const execAsync = promisify(exec);

export class TaskScheduler {
  // taskId -> due time in ms epoch
  private nextRunAt: Map<string, number> = new Map();
  // taskIds with an in-flight fireJob
  private running: Set<string> = new Set();
  private stopping = false;
  private store = new TaskStore();

  constructor(
    private tabManager: TabManager,
    private onNotify: NotifyCallback | null,
  ) {}

  /** Load all tasks from store and schedule them */
  loadAndSchedule(): void {
    this.nextRunAt.clear();
    this.stopping = false;

    const jobs = this.store.list();
    let scheduled = 0;
    let missedFires = 0;

    for (const job of jobs) {
      if (!job.enabled) continue;

      // Fast path: one-time 'at' tasks whose target time has passed without ever firing.
      // (The general tick() loop would catch these too, but this keeps the original
      // single-pass startup behavior — fire now and disable atomically.)
      if (job.scheduleType === 'at' && !job.lastRunAt) {
        const targetTime = new Date(job.schedule).getTime();
        if (Number.isFinite(targetTime) && targetTime <= Date.now()) {
          logger.warn(`Task: missed fire detected for "${job.name}" (was scheduled for ${job.schedule}), firing now`);
          missedFires++;
          this.store.update(job.id, { enabled: false, nextRunAt: null });
          void this.fireJob(job);
          continue;
        }
      }

      // Seed nextRunAt: prefer stored value (catch-up after sleep/restart);
      // otherwise compute fresh from now.
      let due: number | null = null;
      if (job.nextRunAt) {
        const stored = new Date(job.nextRunAt).getTime();
        if (Number.isFinite(stored)) due = stored;
      }
      if (due === null) {
        due = this.computeNextRun(job, Date.now());
        if (due === null) continue; // computeNextRun already logged
        this.store.update(job.id, { nextRunAt: new Date(due).toISOString() });
      }

      this.nextRunAt.set(job.id, due);
      scheduled++;
    }

    logger.info(`Tasks: loaded ${scheduled} active tasks (${jobs.length} total)${missedFires > 0 ? `, fired ${missedFires} missed` : ''}`);
  }

  /** Check for the reload signal file and reload if present */
  checkForReload(): void {
    const signalPath = getCronReloadSignalPath();
    if (fs.existsSync(signalPath)) {
      try { fs.unlinkSync(signalPath); } catch { /* race condition, ok */ }
      logger.info('Tasks: reload signal detected, reloading schedules');
      this.loadAndSchedule();
    }
  }

  /**
   * Fire any tasks whose nextRunAt has elapsed. Called every ~5s by the daemon
   * poll loop. This is the macOS-sleep-resilient replacement for setTimeout-driven
   * cron heartbeats — after a wake, the next tick catches all overdue tasks.
   */
  tick(): void {
    if (this.stopping) return;
    const now = Date.now();

    for (const [id, due] of [...this.nextRunAt]) {
      if (this.stopping) return;
      if (due > now) continue;
      if (this.running.has(id)) continue;

      const job = this.store.get(id);
      if (!job || !job.enabled) {
        this.nextRunAt.delete(id);
        continue;
      }

      // Advance BEFORE firing — eliminates double-fire race if tick is re-entered
      // before the async fireJob completes.
      if (job.scheduleType === 'at') {
        this.nextRunAt.delete(id);
        this.store.update(id, { enabled: false, nextRunAt: null });
      } else {
        const next = this.computeNextRun(job, now);
        if (next === null) {
          this.nextRunAt.delete(id);
          continue;
        }
        this.nextRunAt.set(id, next);
        this.store.update(id, { nextRunAt: new Date(next).toISOString() });
      }

      this.running.add(id);
      void this.fireJob(job).finally(() => this.running.delete(id));
    }
  }

  /** Stop the scheduler. In-flight fireJob promises are detached and resolve naturally. */
  stopAll(): void {
    this.stopping = true;
    this.nextRunAt.clear();
  }

  /** Compute next run time in ms epoch, given a "from" anchor. Returns null if invalid. */
  private computeNextRun(job: Task, fromMs: number): number | null {
    try {
      switch (job.scheduleType) {
        case 'cron':
          return CronExpressionParser.parse(job.schedule, { currentDate: new Date(fromMs) }).next().getTime();
        case 'every': {
          const expr = intervalToCron(job.schedule);
          if (expr) {
            return CronExpressionParser.parse(expr, { currentDate: new Date(fromMs) }).next().getTime();
          }
          const ms = intervalToMs(job.schedule);
          return ms ? fromMs + ms : null;
        }
        case 'at': {
          const t = new Date(job.schedule).getTime();
          return Number.isFinite(t) ? t : null;
        }
      }
    } catch (err) {
      logger.error(`Task: invalid expression for "${job.name}": ${job.schedule}`, err);
      return null;
    }
  }

  private async fireJob(job: Task): Promise<void> {
    logger.info(`Task firing: "${job.name}" (${job.payloadType || 'agentTurn'}) -> tab:${job.tabName}`);
    const logFile = path.join(getLogsDir(), `task-${job.name}.log`);

    // Handle systemEvent -- internal Beecork actions, not Claude Code
    if (job.payloadType === 'systemEvent') {
      try {
        await this.handleSystemEvent(job);
        this.store.update(job.id, { lastRunAt: new Date().toISOString() });
        await fs.promises.appendFile(logFile, `[${new Date().toISOString()}] SYSTEM: ${job.message}\n`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`System event "${job.name}" failed:`, err);
        await fs.promises.appendFile(logFile, `[${new Date().toISOString()}] ERROR: ${errMsg}\n`);
      }
      return;
    }

    try {
      this.tabManager.ensureTab(job.tabName);
      const result = await this.tabManager.sendMessage(job.tabName, job.message);

      this.store.update(job.id, { lastRunAt: new Date().toISOString() });

      const firstLine = result.text.split('\n')[0]?.slice(0, 200) || '(no output)';
      const status = result.error ? 'ERROR' : 'SUCCESS';

      // Log result (status reflects subprocess exit / is_error, not just completion)
      await fs.promises.appendFile(logFile, `[${new Date().toISOString()}] ${status}: ${firstLine}\n`);

      // Notify (separate try/catch -- notification failure shouldn't be reported as job failure)
      try {
        if (this.onNotify) {
          if (result.error) {
            await this.onNotify(`[${job.name}] Failed -- ${firstLine}`);
          } else {
            await this.onNotify(`[${job.name}] Done -- ${firstLine}`);
          }
        }
      } catch (notifyErr) {
        logger.warn(`Task "${job.name}" notification failed:`, notifyErr);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Task "${job.name}" failed:`, err);
      await fs.promises.appendFile(logFile, `[${new Date().toISOString()}] ERROR: ${errMsg}\n`);

      try {
        await this.onNotify?.(`[${job.name}] Failed -- ${errMsg}`);
      } catch { /* notification best-effort */ }
    }
  }

  private async handleSystemEvent(job: Task): Promise<void> {
    switch (job.message) {
      case 'health_check':
        logger.info('System event: health check -- daemon alive');
        if (this.onNotify) {
          await this.onNotify('Beecork health check: all systems operational');
        }
        break;
      default:
        logger.warn(`Unknown system event: ${job.message}`);
    }
  }
}

/** Convert human interval (30m, 2h, 1d, 1h30m, 2w) to milliseconds */
export function intervalToMs(interval: string): number | null {
  const match = interval.match(/^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/);
  if (!match || match.slice(1).every(g => g === undefined)) return null;

  const weeks = parseInt(match[1] || '0', 10);
  const days = parseInt(match[2] || '0', 10);
  const hours = parseInt(match[3] || '0', 10);
  const mins = parseInt(match[4] || '0', 10);

  const totalMs = ((weeks * 7 * 24 * 60) + (days * 24 * 60) + (hours * 60) + mins) * 60 * 1000;
  return totalMs > 0 ? totalMs : null;
}

/** Convert human interval (30m, 2h, 1d, 1h30m, 2w) to cron expression */
export function intervalToCron(interval: string): string | null {
  // Try combined format: 1h30m, 2h, 30m, 1d, 2w
  const match = interval.match(/^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/);
  if (!match || match.slice(1).every(g => g === undefined)) return null;

  const weeks = parseInt(match[1] || '0', 10);
  const days = parseInt(match[2] || '0', 10);
  const hours = parseInt(match[3] || '0', 10);
  const mins = parseInt(match[4] || '0', 10);

  // Convert to total minutes for simple intervals
  const totalMins = weeks * 7 * 24 * 60 + days * 24 * 60 + hours * 60 + mins;
  if (totalMins <= 0) return null;

  // Simple minute interval
  if (totalMins <= 59) return `*/${totalMins} * * * *`;
  // Hourly intervals
  if (mins === 0 && days === 0 && weeks === 0 && hours > 0 && hours <= 23) return `0 */${hours} * * *`;
  // Daily intervals
  if (mins === 0 && hours === 0 && weeks === 0 && days > 0) return `0 0 */${days} * *`;
  // Weekly intervals
  if (mins === 0 && hours === 0 && days === 0 && weeks > 0) return `0 0 * * 0`;

  // Combined or large intervals -- return null, handled by intervalToMs fallback
  return null;
}
