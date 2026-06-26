import fs from 'node:fs';
import path from 'node:path';
import { getLogsDir } from './paths.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Patterns that should never reach disk or stdout. Each channel uses a per-call
// sanitizer too (defense-in-depth), but the Logger is the last line of defense
// for any third-party error object that happens to embed a secret in its message.
const REDACTION_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  { re: /bot\d+:[A-Za-z0-9_-]+/g, replacement: 'bot<REDACTED>' }, // Telegram bot token
];

function redact(s: string): string {
  let out = s;
  for (const { re, replacement } of REDACTION_PATTERNS) out = out.replace(re, replacement);
  return out;
}

const ROTATE_BYTES = 10 * 1024 * 1024;

class Logger {
  private minLevel: LogLevel = 'info';
  private logFile: string | null = null;
  private stream: fs.WriteStream | null = null;
  private bytesWritten = 0;

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  setLogFile(name: string): void {
    const dir = getLogsDir();
    fs.mkdirSync(dir, { recursive: true });
    this.logFile = path.join(dir, name);
    this.stream = fs.createWriteStream(this.logFile, { flags: 'a' });
    // Seed bytesWritten from the existing file size so we don't reset the
    // rotation counter on every daemon restart.
    try {
      this.bytesWritten = fs.statSync(this.logFile).size;
    } catch {
      this.bytesWritten = 0;
    }
  }

  private write(level: LogLevel, msg: string, ...args: unknown[]): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.minLevel]) return;

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
    const raw =
      args.length > 0
        ? `${prefix} ${msg} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`
        : `${prefix} ${msg}`;
    const line = redact(raw);

    if (this.stream) {
      const out = line + '\n';
      this.stream.write(out);
      this.bytesWritten += out.length;
      if (this.bytesWritten > ROTATE_BYTES) this.checkRotation();
    }

    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else if (level !== 'debug') {
      console.log(line);
    }
  }

  debug(msg: string, ...args: unknown[]): void {
    this.write('debug', msg, ...args);
  }
  info(msg: string, ...args: unknown[]): void {
    this.write('info', msg, ...args);
  }
  warn(msg: string, ...args: unknown[]): void {
    this.write('warn', msg, ...args);
  }
  error(msg: string, ...args: unknown[]): void {
    this.write('error', msg, ...args);
  }

  private checkRotation(): void {
    if (!this.logFile || !this.stream) return;
    // bytesWritten-based gate already triggered us; rotate without statSync.
    try {
      this.stream.end();
      const rotated = this.logFile + '.1';
      try {
        fs.unlinkSync(rotated);
      } catch {
        /* not fatal */
      }
      fs.renameSync(this.logFile, rotated);
      this.stream = fs.createWriteStream(this.logFile, { flags: 'a' });
      this.bytesWritten = 0;
    } catch {
      /* rotation failure shouldn't kill the daemon */
    }
  }

  close(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }
}

export const logger = new Logger();

// Allow operators to bump verbosity at runtime without recompiling.
// e.g. `BEECORK_LOG_LEVEL=debug beecork-pipe start` surfaces every claude subprocess
// stdout/stderr line via the logger.debug calls.
const envLevel = process.env.BEECORK_LOG_LEVEL?.toLowerCase();
if (envLevel === 'debug' || envLevel === 'info' || envLevel === 'warn' || envLevel === 'error') {
  logger.setLevel(envLevel);
}
