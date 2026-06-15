import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../util/logger.js';
import { getMcpConfigPath } from '../util/paths.js';
import type { BeecorkConfig, StreamEvent } from '../types.js';

// Cache the MCP-config existence check. The file is created at setup time and
// stable for the daemon's lifetime; we don't need to stat() it per spawn.
let mcpConfigExistsCache: boolean | null = null;
function mcpConfigExists(): boolean {
  if (mcpConfigExistsCache !== null) return mcpConfigExistsCache;
  mcpConfigExistsCache = fs.existsSync(getMcpConfigPath());
  return mcpConfigExistsCache;
}

/** Test-only — reset the existsSync cache between test runs that toggle the mock. */
export function _resetMcpConfigExistsCacheForTests(): void {
  mcpConfigExistsCache = null;
}

const BEECORK_SYSTEM_PROMPT = `You are running inside Beecork, an always-on infrastructure for Claude Code.

You have these special MCP tools available:
- beecork_remember: Store important facts for future sessions (preferences, server addresses, decisions, outcomes)
- beecork_recall: Search stored memories — ALWAYS call this at the start of complex tasks
- beecork_task_create: Schedule recurring tasks (types: "at" for one-time, "every" for interval like "30m", "cron" for expressions like "0 9 * * 1")
- beecork_task_list: List scheduled tasks
- beecork_task_delete: Remove a scheduled task
- beecork_tab_create: Create a new virtual tab for parallel work
- beecork_tab_list: List all tabs
- beecork_send_message: Send a message to another tab
- beecork_notify: Send the user a notification mid-task without stopping
- beecork_status: Check system status

Guidelines:
- You are running unattended. Be thorough and complete tasks fully.
- Always call beecork_recall at the start of any task to check relevant memories.
- Always call beecork_remember when you learn something important.
- When asked for recurring tasks, use beecork_task_create.
- Use beecork_notify for progress updates during long tasks.`;

export interface SubprocessCallbacks {
  onEvent: (event: StreamEvent) => void;
  onExit: (code: number | null) => void;
  onError: (err: Error) => void;
}

export class ClaudeSubprocess {
  private proc: ChildProcess | null = null;
  private buffer: string = '';
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeTimer: ReturnType<typeof setTimeout> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Set when the startup watchdog kills a subprocess that never emitted a
   * single event — distinguishes a transient network/connection stall from a
   * normal exit or a real wall-clock overrun, so the manager can retry once.
   */
  killReason: 'silent' | null = null;
  readonly sessionId: string;

  constructor(
    private tabName: string,
    private workingDir: string,
    private config: BeecorkConfig,
    sessionId?: string,
    private tabSystemPrompt?: string | null,
  ) {
    this.sessionId = sessionId ?? uuidv4();
  }

  async send(
    prompt: string,
    callbacks: SubprocessCallbacks,
    resume: boolean = false,
  ): Promise<void> {
    if (this.proc) {
      throw new Error(`Subprocess for tab "${this.tabName}" is already running`);
    }

    const args = this.buildArgs(prompt, resume);

    logger.debug(`[${this.tabName}] Spawning: ${this.config.claudeCode.bin} ${args.join(' ')}`);

    this.proc = spawn(this.config.claudeCode.bin, args, {
      cwd: this.workingDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const pid = this.proc.pid;
    logger.info(`[${this.tabName}] Claude subprocess started (PID: ${pid})`);

    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event: StreamEvent = JSON.parse(line);
          // First real event proves claude initialized and the socket is alive
          // — the startup-stall window is over, so disarm the watchdog for good.
          // It never re-arms, so legitimate multi-minute tool runs (which emit
          // nothing on stdout until the tool returns) are never killed.
          if (this.startupTimer) {
            clearTimeout(this.startupTimer);
            this.startupTimer = null;
          }
          callbacks.onEvent(event);
        } catch {
          // Non-JSON line (verbose debug output), skip
          logger.debug(`[${this.tabName}] non-json: ${line.slice(0, 200)}`);
        }
      }
    });

    this.proc.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        // claude prints auth failures, rate limits, license issues, and other
        // operational errors to stderr. Surface at warn so they reach daemon.log
        // at the default level — debugging "why did claude exit?" otherwise
        // requires recompiling with a different log level.
        logger.warn(`[${this.tabName}] claude stderr: ${text.slice(0, 500)}`);
      }
    });

    this.proc.on('error', (err) => {
      this.proc = null;
      if (this.runtimeTimer) {
        clearTimeout(this.runtimeTimer);
        this.runtimeTimer = null;
      }
      if (this.startupTimer) {
        clearTimeout(this.startupTimer);
        this.startupTimer = null;
      }
      callbacks.onError(err);
    });

    this.proc.on('exit', (code) => {
      this.proc = null;
      if (this.killTimer) {
        clearTimeout(this.killTimer);
        this.killTimer = null;
      }
      if (this.runtimeTimer) {
        clearTimeout(this.runtimeTimer);
        this.runtimeTimer = null;
      }
      if (this.startupTimer) {
        clearTimeout(this.startupTimer);
        this.startupTimer = null;
      }
      logger.info(`[${this.tabName}] Claude subprocess exited (code: ${code})`);
      callbacks.onExit(code);
    });

    // Hard runtime cap so a wedged claude can't pin a tab forever.
    // Default 30 minutes. Disable by setting maxRuntimeMs to 0.
    const maxRuntimeMs = this.config.claudeCode.maxRuntimeMs ?? 30 * 60 * 1000;
    if (maxRuntimeMs > 0) {
      this.runtimeTimer = setTimeout(() => {
        if (!this.proc) return;
        logger.warn(
          `[${this.tabName}] Subprocess exceeded maxRuntimeMs (${maxRuntimeMs}ms) — killing`,
        );
        callbacks.onError(
          new Error(`Subprocess timed out after ${Math.round(maxRuntimeMs / 1000)}s`),
        );
        this.kill();
      }, maxRuntimeMs);
    }

    // Startup watchdog. A healthy claude emits its init event within seconds of
    // spawn. Total silence this long means it wedged on a stalled network socket
    // (DNS/connection blip with no client-side timeout) and would otherwise sit
    // idle until the 30-min maxRuntime kill. Unlike maxRuntime, this routes
    // through onExit (kill only, no onError) so the manager retries once. It is
    // disarmed on the first event, so it can only fire before claude initializes
    // — long-running tools, which emit nothing on stdout until they return, are
    // never affected.
    const silentTimeoutMs = this.config.claudeCode.silentTimeoutMs ?? 120_000;
    if (silentTimeoutMs > 0) {
      this.startupTimer = setTimeout(() => {
        if (!this.proc) return;
        logger.warn(
          `[${this.tabName}] No output ${silentTimeoutMs}ms after spawn — killing as silent network stall`,
        );
        this.killReason = 'silent';
        this.kill();
      }, silentTimeoutMs);
    }
  }

  kill(): void {
    if (!this.proc) return;
    logger.info(`[${this.tabName}] Killing subprocess (PID: ${this.proc.pid})`);
    this.proc.kill('SIGTERM');
    const proc = this.proc;
    this.killTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }, 5000);
  }

  get isRunning(): boolean {
    return this.proc !== null;
  }

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  private buildArgs(prompt: string, resume: boolean): string[] {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      ...this.config.claudeCode.defaultFlags,
    ];

    // Only add MCP config if the file exists. existsSync result is cached at
    // module scope — the path is stable for the daemon's lifetime, so doing
    // this once-per-process saves a syscall per claude spawn (every message,
    // every task firing, every watcher trigger).
    if (mcpConfigExists()) {
      args.push('--mcp-config', getMcpConfigPath());
    }

    // Inject Beecork system context so Claude knows about available tools
    if (!resume) {
      let systemPrompt = BEECORK_SYSTEM_PROMPT;
      if (this.tabSystemPrompt) {
        systemPrompt += `\n\n[Tab-specific instructions for "${this.tabName}"]\n${this.tabSystemPrompt}`;
      }
      args.push('--system-prompt', systemPrompt);
    }

    if (resume) {
      args.push('--resume', this.sessionId);
    } else {
      args.push('--session-id', this.sessionId);
    }

    if (this.config.claudeCode.computerUse) {
      args.push('--computer-use');
    }

    if (this.config.claudeCode.maxBudgetUsd) {
      args.push('--max-budget-usd', String(this.config.claudeCode.maxBudgetUsd));
    }

    args.push(prompt);

    return args;
  }
}
