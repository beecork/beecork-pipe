import { v4 as uuidv4 } from 'uuid';
import { ClaudeSubprocess, type SubprocessCallbacks } from './subprocess.js';
import { CircuitBreaker, type CircuitBreakerAction } from './circuit-breaker.js';
import { ContextMonitor, type ContextAction } from './context-monitor.js';
import { TabStore } from './tab-store.js';
import { MessageQueue } from './message-queue.js';
import { BudgetGuard } from './budget-guard.js';
import { StaleSessionDetector } from './stale-session.js';
import { ContextCompactor } from './context-compactor.js';
import { PendingMessageStore } from './pending-store.js';
import { completeDelegation } from '../delegation/manager.js';
import { getDb } from '../db/index.js';
import { resolveWorkingDir, validateTabName } from '../config.js';
import { logger } from '../util/logger.js';
import { logActivity } from '../timeline/index.js';
import { getAllKnowledge, formatKnowledgeForContext } from '../knowledge/index.js';
import type {
  BeecorkConfig,
  Tab,
  TabStatus,
  StreamEvent,
  StreamInit,
  StreamAssistant,
  StreamResult,
  StreamContentToolUse,
} from '../types.js';

export type { StreamResult } from '../types.js';

export interface SendResult {
  text: string;
  costUsd: number;
  durationMs: number;
  sessionId: string;
  error: boolean;
}

export type NotifyCallback = (text: string) => Promise<void>;

/**
 * TabManager orchestrates per-tab Claude subprocess lifecycles. Heavy lifting
 * (queueing, budget enforcement, stale-session recovery, context compaction,
 * pending-message dispatch) is delegated to collaborators in this directory
 * so this class stays focused on:
 *
 *   - tab CRUD (ensureTab, listTabs, stopTab, closeTab, stopAll)
 *   - subprocess orchestration (executeMessage)
 *   - wiring the collaborators together
 *
 * The split happened in the 2026-05-15 audit fix; see the audit file for the
 * rationale. Before the split this file was 467 lines and 10 responsibilities.
 */
export class TabManager {
  private subprocesses: Map<string, ClaudeSubprocess> = new Map();
  private queue = new MessageQueue();
  private budget: BudgetGuard;
  // In-memory cache of per-tab cumulative cost. Lazily seeded with a single
  // SUM query when a tab is first checked; thereafter updated incrementally
  // from the assistant-message insert. Saves an O(N messages) SUM scan on
  // every inbound message — the previous code re-aggregated the entire tab
  // history just to gate budget.
  private tabCostCache: Map<string, number> = new Map();
  private onNotify: NotifyCallback | null = null;

  constructor(private config: BeecorkConfig) {
    this.budget = new BudgetGuard(config.claudeCode.maxBudgetUsd);
  }

  /** Set a callback for sending notifications (e.g., via Telegram) */
  setNotifyCallback(cb: NotifyCallback): void {
    this.onNotify = cb;
  }

  /** Ensure a tab exists in the database. Creates it if missing. */
  ensureTab(tabName: string, workingDirOverride?: string): Tab {
    const db = getDb();
    const existing = TabStore.findByName(tabName);
    if (existing) return existing;

    // Validate tab name before creating (centralized for all channels + MCP)
    if (tabName !== 'default') {
      const validationError = validateTabName(tabName);
      if (validationError) throw new Error(validationError);
    }

    // Check for a matching tab template
    const template = this.config.tabTemplates?.[tabName];

    const tab: Tab = {
      id: uuidv4(),
      name: tabName,
      sessionId: uuidv4(),
      status: 'idle',
      workingDir: workingDirOverride || template?.workingDir || resolveWorkingDir(tabName),
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      pid: null,
      systemPrompt: template?.systemPrompt || null,
    };

    db.prepare(
      `
      INSERT INTO tabs (id, name, session_id, status, working_dir, created_at, last_activity_at, system_prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      tab.id,
      tab.name,
      tab.sessionId,
      tab.status,
      tab.workingDir,
      tab.createdAt,
      tab.lastActivityAt,
      tab.systemPrompt,
    );

    logger.info(`Created tab: ${tabName}`);
    return tab;
  }

  /** Send a message to a tab. Creates the tab if it doesn't exist. Queues if busy. */
  async sendMessage(
    tabName: string,
    prompt: string,
    options?: {
      resume?: boolean;
      onTextChunk?: (text: string) => void;
      onToolUse?: (toolName: string, toolInput: Record<string, unknown>) => void;
      projectPath?: string;
      _compactionDepth?: number;
    },
  ): Promise<SendResult> {
    const tab = this.ensureTab(tabName, options?.projectPath);

    // If a subprocess is already running on this tab, queue the message
    if (this.subprocesses.get(tabName)?.isRunning) {
      return new Promise((resolve, reject) => {
        const accepted = this.queue.enqueue(tabName, { prompt, resolve, reject });
        if (!accepted) {
          reject(new Error(`Queue full for tab "${tabName}". Try again later.`));
          return;
        }
        logger.info(`[${tabName}] Message queued (queue size: ${this.queue.size(tabName)})`);
      });
    }

    return this.executeMessage(
      tab,
      prompt,
      options?.resume ?? false,
      options?.onTextChunk,
      options?.onToolUse,
      options?._compactionDepth,
    );
  }

  /** Get all tabs from the database */
  listTabs(): Tab[] {
    return TabStore.listAll();
  }

  /** Get a specific tab */
  getTab(tabName: string): Tab | undefined {
    return TabStore.findByName(tabName);
  }

  /** Stop a tab's running subprocess */
  stopTab(tabName: string): void {
    const sub = this.subprocesses.get(tabName);
    if (sub?.isRunning) sub.kill();
    this.updateTabStatus(tabName, 'stopped');
    this.clearQueue(tabName);
  }

  /** Update a tab's system_prompt. Returns true if the tab existed. */
  setSystemPrompt(tabName: string, systemPrompt: string): boolean {
    return TabStore.setSystemPrompt(tabName, systemPrompt);
  }

  /** Close a tab — stop subprocess and delete its rows. Returns true if the tab existed. */
  closeTab(tabName: string): boolean {
    const tab = TabStore.findByName(tabName);
    this.stopTab(tabName);
    if (tab) this.tabCostCache.delete(tab.id);
    return TabStore.deleteWithMessages(tabName);
  }

  /** Stop all running subprocesses (clean shutdown) */
  stopAll(): void {
    for (const [tabName, sub] of this.subprocesses) {
      if (sub.isRunning) sub.kill();
      this.updateTabStatus(tabName, 'stopped');
    }
    this.subprocesses.clear();
    for (const dropped of this.queue.clearAll()) {
      for (const item of dropped) {
        item.reject(new Error('Daemon shutting down'));
      }
    }
  }

  private async executeMessage(
    tab: Tab,
    prompt: string,
    resume: boolean,
    onTextChunk?: (text: string) => void,
    onToolUse?: (toolName: string, toolInput: Record<string, unknown>) => void,
    compactionDepth?: number,
    forceFresh: boolean = false,
    retryDepth: number = 0,
  ): Promise<SendResult> {
    const db = getDb();

    logActivity('task_started', 'Processing message', {
      tabName: tab.name,
      details: prompt.slice(0, 500),
    });

    // Budget check before spawning
    if (this.config.claudeCode.maxBudgetUsd) {
      let tabSpend = this.tabCostCache.get(tab.id);
      if (tabSpend === undefined) {
        tabSpend = (
          db
            .prepare('SELECT COALESCE(SUM(cost_usd), 0) as total FROM messages WHERE tab_id = ?')
            .get(tab.id) as {
            total: number;
          }
        ).total;
        this.tabCostCache.set(tab.id, tabSpend);
      }
      const decision = this.budget.check(tabSpend, tab.name);
      if (!decision.allowed) {
        this.onNotify?.(decision.reason!).catch(() => {});
        return {
          text: decision.reason!,
          costUsd: 0,
          durationMs: 0,
          sessionId: tab.sessionId,
          error: true,
        };
      }
      if (decision.warning) {
        this.onNotify?.(decision.warning).catch(() => {});
      }
    }

    // Inject knowledge (global markdown + project markdown + tab facts)
    const knowledge = getAllKnowledge(tab.workingDir, tab.name);
    const knowledgeContext = formatKnowledgeForContext(knowledge);
    const enrichedPrompt = knowledgeContext ? `${knowledgeContext}\n\n${prompt}` : prompt;

    // Store user message
    db.prepare('INSERT INTO messages (tab_id, role, content) VALUES (?, ?, ?)').run(
      tab.id,
      'user',
      prompt,
    );

    this.updateTabStatus(tab.name, 'running');

    // Get fresh tab to pick up system_prompt
    const freshTab = TabStore.findByName(tab.name) || tab;

    const subprocess = new ClaudeSubprocess(
      tab.name,
      tab.workingDir,
      this.config,
      tab.sessionId,
      freshTab.systemPrompt,
    );
    this.subprocesses.set(tab.name, subprocess);

    // Circuit breaker is per-call state — its lifetime is exactly the
    // subprocess's lifetime. Keep it as a local const; the previous
    // circuitBreakers Map suggested cross-call state but nothing read it
    // outside this scope.
    const breaker = new CircuitBreaker(tab.name);
    const contextMonitor = new ContextMonitor(tab.name);

    // Resume if: explicitly requested or DB has prior successful responses for this tab.
    // forceFresh overrides both — used after a stale-session retry to guarantee --session-id, not --resume.
    // LIMIT 1 short-circuits on the first matching row — a long-running tab with
    // 10k messages used to walk the whole index for a boolean answer.
    const hasDbHistory =
      db
        .prepare(
          "SELECT 1 FROM messages WHERE tab_id = ? AND role = 'assistant' AND content != '' LIMIT 1",
        )
        .get(tab.id) !== undefined;
    const shouldResume = !forceFresh && (resume || hasDbHistory);

    return new Promise<SendResult>((resolve, reject) => {
      let resultText = '';
      let resultEvent: StreamResult | null = null;
      let loopWarningPending = false;
      let checkpointTriggered = false;
      // Prevent the SIGTERM-then-exit double dispatch: when onError already
      // routed the failure through reject() + processNextInQueue, suppress
      // the inevitable subsequent onExit so the queue doesn't shift twice.
      let errored = false;

      const callbacks: SubprocessCallbacks = {
        onEvent: (event: StreamEvent) => {
          // Capture session_id from StreamInit and update tab record
          if (event.type === 'system' && 'subtype' in event && event.subtype === 'init') {
            const initEvent = event as StreamInit;
            if (initEvent.session_id) {
              db.prepare('UPDATE tabs SET session_id = ? WHERE id = ?').run(
                initEvent.session_id,
                tab.id,
              );
            }
          }

          if (event.type === 'assistant') {
            const assistant = event as StreamAssistant;
            // Track context usage
            if (assistant.message.usage) {
              const contextAction: ContextAction = contextMonitor.recordUsage(
                assistant.message.usage,
              );
              if (contextAction === 'warn') {
                logger.info(`[${tab.name}] Context window warning — will summarize on next turn`);
              } else if (contextAction === 'checkpoint') {
                checkpointTriggered = true;
                logger.warn(`[${tab.name}] Context window checkpoint triggered`);
              }
            }

            for (const block of assistant.message.content) {
              if (block.type === 'text') {
                resultText += block.text;
                onTextChunk?.(block.text);
              } else if (block.type === 'tool_use') {
                const toolUse = block as StreamContentToolUse;
                onToolUse?.(toolUse.name, toolUse.input);
                const action: CircuitBreakerAction = breaker.recordToolCall(toolUse);
                if (action === 'break') {
                  logger.warn(`[${tab.name}] Circuit breaker tripped, killing subprocess`);
                  subprocess.kill();
                } else if (action === 'notify') {
                  this.onNotify?.(
                    `Loop detected in tab "${tab.name}": ${toolUse.name} repeated 10+ times. Send /stop ${tab.name} to kill it.`,
                  ).catch((err) => logger.warn('Notify failed:', err));
                } else if (action === 'warn') {
                  loopWarningPending = true;
                }
              }
            }
          } else if (event.type === 'result') {
            resultEvent = event as StreamResult;
          }
        },
        onExit: (code) => {
          if (errored) {
            // onError already rejected and drained the queue; don't double-dispatch.
            return;
          }
          this.subprocesses.delete(tab.name);

          const result: SendResult = {
            text: resultEvent?.result ?? resultText,
            costUsd: resultEvent?.total_cost_usd ?? 0,
            durationMs: resultEvent?.duration_ms ?? 0,
            sessionId: subprocess.sessionId,
            error: resultEvent?.is_error ?? code !== 0,
          };

          // Handle resume failure (Claude Code session cache rotated / never existed / expired).
          if (StaleSessionDetector.isStale(result, resultEvent, shouldResume, retryDepth)) {
            const detail = resultEvent?.errors?.[0] ?? result.text.split('\n')[0];
            logger.warn(
              `[${tab.name}] Resume session ${tab.sessionId} unavailable in Claude Code cache (${detail}). Retrying with fresh session.`,
            );
            const recovery = StaleSessionDetector.buildRecovery(tab.id, enrichedPrompt, db);
            db.prepare('UPDATE tabs SET session_id = ?, status = ? WHERE id = ?').run(
              recovery.newSessionId,
              'idle',
              tab.id,
            );

            this.executeMessage(
              { ...tab, sessionId: recovery.newSessionId },
              recovery.contextPrompt,
              false,
              onTextChunk,
              onToolUse,
              compactionDepth,
              true,
              retryDepth + 1,
            )
              .then(resolve)
              .catch(reject);
            return;
          }

          // Silent network-stall recovery. The startup watchdog killed a
          // subprocess that never emitted a single event — almost always a
          // transient overnight DNS/connection blip that recovers within
          // seconds. Mirror the stale-session retry above (capped by retryDepth)
          // so a blip recovers inside a single fire instead of burning the full
          // maxRuntime and counting toward the 5-failure auto-disable.
          if (subprocess.killReason === 'silent') {
            if (retryDepth === 0) {
              logger.warn(
                `[${tab.name}] Subprocess produced no output (suspected transient network stall) — retrying once.`,
              );
              // Don't touch the session — the subprocess may never have
              // initialized one. Retry with identical args.
              this.executeMessage(
                tab,
                prompt,
                resume,
                onTextChunk,
                onToolUse,
                compactionDepth,
                forceFresh,
                retryDepth + 1,
              )
                .then(resolve)
                .catch(reject);
              return;
            }
            // Retry already attempted and it stalled again — surface a
            // network-specific failure instead of an empty "(no output)" so the
            // user checks connectivity, not their auth/subscription. Resolve
            // (not reject) with error:true; the scheduler counts this toward
            // auto-disable exactly like the maxRuntime path, and reports it via
            // the existing task-failure notification.
            logger.warn(
              `[${tab.name}] Still no output after retry — surfacing suspected network stall.`,
            );
            db.prepare(
              'UPDATE tabs SET status = ?, last_activity_at = ?, pid = NULL WHERE name = ?',
            ).run('idle', new Date().toISOString(), tab.name);
            logActivity('task_failed', 'Subprocess silent stall (retry exhausted)', {
              tabName: tab.name,
            });
            resolve({
              text: 'Subprocess produced no output, even after a retry — suspected network/DNS stall. Check connectivity.',
              costUsd: 0,
              durationMs: 0,
              sessionId: subprocess.sessionId,
              error: true,
            });
            this.processNextInQueue(tab.name);
            return;
          }

          // Store assistant response. Skip empty content (typically failed/error runs) so
          // it doesn't trigger the hasDbHistory shouldResume override on future calls.
          if (result.text.trim() !== '') {
            db.prepare(
              'INSERT INTO messages (tab_id, role, content, cost_usd, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?, ?)',
            ).run(
              tab.id,
              'assistant',
              result.text,
              result.costUsd,
              resultEvent?.usage?.input_tokens ?? null,
              resultEvent?.usage?.output_tokens ?? null,
            );
            // Keep the budget cache in sync with the row we just inserted —
            // avoids the per-message SUM scan in the next budget check.
            if (this.tabCostCache.has(tab.id)) {
              this.tabCostCache.set(
                tab.id,
                (this.tabCostCache.get(tab.id) ?? 0) + (result.costUsd || 0),
              );
            }
          }

          // Update tab
          db.prepare(
            'UPDATE tabs SET status = ?, last_activity_at = ?, pid = NULL WHERE name = ?',
          ).run('idle', new Date().toISOString(), tab.name);

          logActivity('task_completed', 'Message processed', {
            tabName: tab.name,
            durationMs: result.durationMs,
            costUsd: result.costUsd,
            details: result.text.slice(0, 500),
          });

          // Context window compaction: if checkpoint was triggered, restart with summary.
          const currentDepth = compactionDepth ?? 0;
          if (
            checkpointTriggered &&
            !result.error &&
            result.text &&
            currentDepth < ContextCompactor.MAX_DEPTH
          ) {
            // Compactor handles its own try/catch and always returns a SendResult.
            // The queue drain MUST happen regardless of compaction outcome — the
            // previous pattern omitted it in this branch, so a queued message
            // could wait indefinitely while compaction recursion was in flight.
            ContextCompactor.compact(
              tab,
              enrichedPrompt,
              result,
              onTextChunk,
              currentDepth,
              (tabName, p, opts) => this.sendMessage(tabName, p, opts),
              this.onNotify,
              db,
            )
              .then(resolve)
              .finally(() => this.processNextInQueue(tab.name));
            return;
          }

          // Check for delegation completion
          try {
            const delegation = completeDelegation(tab.name, result.text);
            if (delegation && delegation.returnToTab) {
              PendingMessageStore.enqueueDelegationResult(
                delegation.returnToTab,
                `[Result from tab:${tab.name}]: ${result.text.slice(0, 10000)}`,
              );
              logActivity(
                'delegation_completed',
                `Delegation ${tab.name} → ${delegation.returnToTab}`,
                {
                  tabName: tab.name,
                  details: result.text.slice(0, 500),
                },
              );
              this.onNotify?.(
                `Delegation complete: ${tab.name} → result sent back to ${delegation.returnToTab}`,
              ).catch(() => {});
              logger.info(`Delegation result sent: ${tab.name} → ${delegation.returnToTab}`);
            }
          } catch (err) {
            logger.warn('Delegation completion check failed:', err);
          }

          resolve(result);

          // Process next queued message (prepend loop warning if needed)
          if (loopWarningPending) {
            const next = this.queue.peek(tab.name);
            if (next) {
              next.prompt = `[WARNING: You appear to be repeating the same action. Reassess your approach.]\n\n${next.prompt}`;
              loopWarningPending = false;
            }
          }
          this.processNextInQueue(tab.name);
        },
        onError: (err) => {
          errored = true;
          this.subprocesses.delete(tab.name);
          this.updateTabStatus(tab.name, 'error');
          logActivity('task_failed', 'Message failed', {
            tabName: tab.name,
            details: err instanceof Error ? err.message : String(err),
          });
          reject(err);
          this.processNextInQueue(tab.name);
        },
      };

      subprocess.send(enrichedPrompt, callbacks, shouldResume).catch((err) => {
        if (!errored) {
          errored = true;
          this.subprocesses.delete(tab.name);
          this.updateTabStatus(tab.name, 'error');
          reject(err);
          this.processNextInQueue(tab.name);
        }
      });
    });
  }

  private processNextInQueue(tabName: string): void {
    const next = this.queue.dequeue(tabName);
    if (!next) return;
    const tab = this.getTab(tabName);
    if (!tab) {
      next.reject(new Error(`Tab "${tabName}" not found`));
      return;
    }
    this.executeMessage(tab, next.prompt, false).then(next.resolve).catch(next.reject);
  }

  private updateTabStatus(tabName: string, status: TabStatus): void {
    TabStore.setStatus(tabName, status);
  }

  private clearQueue(tabName: string): void {
    const dropped = this.queue.clear(tabName);
    for (const item of dropped) {
      item.reject(new Error(`Tab "${tabName}" was stopped`));
    }
  }
}
