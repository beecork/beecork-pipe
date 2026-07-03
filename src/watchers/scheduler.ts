import fs from 'node:fs';
import path from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { WatcherStore } from './store.js';
import { evaluateWatcher } from './evaluator.js';
import { execAsync, intervalToMs } from '../tasks/scheduler.js';
import { getLogsDir, getWatcherReloadSignalPath } from '../util/paths.js';
import { logger } from '../util/logger.js';
import { PendingMessageStore } from '../session/pending-store.js';
import { logActivity } from '../timeline/index.js';
import type { Watcher } from './types.js';

export class WatcherScheduler {
  private store = new WatcherStore();
  // watcherId -> due time in ms epoch for next check
  private nextCheckAt: Map<string, number> = new Map();
  // watcherIds with an in-flight runCheck
  private running: Set<string> = new Set();
  private stopping = false;
  public onNotify: ((text: string) => Promise<void>) | null = null;

  /** Load all watchers from store and schedule them */
  loadAndSchedule(): void {
    this.stopAll();
    this.stopping = false;

    const watchers = this.store.list();
    let scheduled = 0;

    for (const watcher of watchers) {
      if (!watcher.enabled) continue;

      const ms = parseScheduleToMs(watcher.schedule);
      let due: number | null;
      if (ms !== null) {
        // Interval schedule: if we have a lastCheckAt, fire `intervalMs` after it
        // (catches up overdue checks after sleep/restart on the next tick).
        // Otherwise wait `intervalMs` before the first fire.
        if (watcher.lastCheckAt) {
          const last = new Date(watcher.lastCheckAt).getTime();
          due = Number.isFinite(last) ? last + ms : Date.now() + ms;
        } else {
          due = Date.now() + ms;
        }
      } else {
        // Cron schedule: next fire from now. watch_create accepts cron
        // expressions, so the scheduler must honor them — previously cron
        // watchers failed parseScheduleToMs and were silently never scheduled.
        due = nextCronFire(watcher.schedule, Date.now());
      }

      if (due === null) {
        logger.error(`Watcher: invalid schedule for "${watcher.name}": ${watcher.schedule}`);
        continue;
      }

      this.nextCheckAt.set(watcher.id, due);
      scheduled++;
    }

    if (scheduled > 0 || watchers.length > 0) {
      logger.info(`Watchers: loaded ${scheduled} active watchers (${watchers.length} total)`);
    }
  }

  /** Check for the reload signal file and reload if present */
  checkForReload(): void {
    const signalPath = getWatcherReloadSignalPath();
    if (fs.existsSync(signalPath)) {
      try {
        fs.unlinkSync(signalPath);
      } catch {
        /* race condition, ok */
      }
      logger.info('Watchers: reload signal detected, reloading');
      this.loadAndSchedule();
    }
  }

  /**
   * Fire any watchers whose nextCheckAt has elapsed. Called every ~5s by the daemon
   * poll loop. Sleep-resilient: after wake, the next tick catches all overdue checks.
   */
  tick(): void {
    if (this.stopping) return;
    const now = Date.now();

    for (const [id, due] of [...this.nextCheckAt]) {
      if (this.stopping) return;
      if (due > now) continue;
      if (this.running.has(id)) continue;

      const watcher = this.store.get(id);
      if (!watcher || !watcher.enabled) {
        this.nextCheckAt.delete(id);
        continue;
      }

      const intervalMs = parseScheduleToMs(watcher.schedule);
      const nextDue = intervalMs !== null ? now + intervalMs : nextCronFire(watcher.schedule, now);
      if (nextDue === null) {
        this.nextCheckAt.delete(id);
        continue;
      }

      // Advance BEFORE running — eliminates double-fire race
      this.nextCheckAt.set(id, nextDue);

      this.running.add(id);
      void this.runCheck(watcher).finally(() => this.running.delete(id));
    }
  }

  /** Stop the scheduler. In-flight runCheck promises detach and resolve naturally. */
  stopAll(): void {
    this.stopping = true;
    this.nextCheckAt.clear();
  }

  private async runCheck(watcher: Watcher): Promise<void> {
    const logFile = path.join(getLogsDir(), `watcher-${watcher.name}.log`);

    try {
      const result = await evaluateWatcher(watcher);
      this.store.markChecked(watcher.id);

      if (result.triggered) {
        this.store.markTriggered(watcher.id);
        await fs.promises.appendFile(
          logFile,
          `[${new Date().toISOString()}] TRIGGERED: ${result.output.slice(0, 500)}\n`,
        );
        logActivity('watcher_triggered', `Watcher "${watcher.name}" triggered`, {
          details: result.output.slice(0, 500),
        });
        await this.executeAction(watcher, result.output);
      } else {
        await fs.promises.appendFile(
          logFile,
          `[${new Date().toISOString()}] OK: ${result.output.slice(0, 200)}\n`,
        );
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Watcher "${watcher.name}" check failed:`, err);
      await fs.promises.appendFile(logFile, `[${new Date().toISOString()}] ERROR: ${errMsg}\n`);
    }
  }

  private async executeAction(watcher: Watcher, output: string): Promise<void> {
    switch (watcher.action) {
      case 'notify':
        if (this.onNotify) {
          await this.onNotify(`Watcher "${watcher.name}" triggered:\n${output.slice(0, 500)}`);
        }
        break;

      case 'fix':
        if (watcher.actionDetails) {
          try {
            await execAsync(watcher.actionDetails, { timeout: 60000 });
            if (this.onNotify) {
              await this.onNotify(
                `Watcher "${watcher.name}" triggered and auto-fixed:\n${output.slice(0, 300)}`,
              );
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.error(`Watcher "${watcher.name}" fix command failed:`, err);
            if (this.onNotify) {
              await this.onNotify(`Watcher "${watcher.name}" triggered but fix failed: ${errMsg}`);
            }
          }
        } else {
          logger.warn(`Watcher "${watcher.name}" has action=fix but no actionDetails`);
        }
        break;

      case 'delegate':
        // Write to pending_messages for the daemon to pick up
        if (watcher.actionDetails) {
          try {
            const { getDb } = await import('../db/index.js');
            const db = getDb();
            // actionDetails format: "tabName: message" or just a message for default tab
            const colonIdx = watcher.actionDetails.indexOf(':');
            let tabName = 'default';
            let message = watcher.actionDetails;
            if (colonIdx > 0 && colonIdx < 30) {
              tabName = watcher.actionDetails.slice(0, colonIdx).trim();
              message = watcher.actionDetails.slice(colonIdx + 1).trim();
            }
            const fullMessage = `[Watcher "${watcher.name}" triggered] ${message}\n\nWatcher output:\n${output.slice(0, 500)}`;
            // This just injects a prompt into a tab — there's no delegations-table
            // row or return-result, so it's a plain user message (a real
            // delegation carries a delegation id for completion correlation).
            PendingMessageStore.enqueueUser(tabName, fullMessage, db);
            if (this.onNotify) {
              await this.onNotify(
                `Watcher "${watcher.name}" triggered -- delegated to tab:${tabName}`,
              );
            }
          } catch (err) {
            logger.error(`Watcher "${watcher.name}" delegation failed:`, err);
          }
        }
        break;
    }
  }
}

/** Parse schedule string like "every 5m", "every 1h", or raw interval "30m" to milliseconds */
function parseScheduleToMs(schedule: string): number | null {
  // Strip "every " prefix if present
  const raw = schedule.replace(/^every\s+/i, '');
  return intervalToMs(raw);
}

/** Next fire time (epoch ms) for a cron-expression watcher schedule, or null if not valid cron. */
function nextCronFire(schedule: string, fromMs: number): number | null {
  try {
    return CronExpressionParser.parse(schedule, { currentDate: new Date(fromMs) })
      .next()
      .getTime();
  } catch {
    return null;
  }
}
