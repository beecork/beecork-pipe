import { logger } from './logger.js';

interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private global: Window = { count: 0, resetAt: Date.now() + 60000 };
  private perKey = new Map<string, Window>();

  constructor(
    private globalLimit: number = 20,
    private perKeyLimit: number = 10,
    private windowMs: number = 60000,
  ) {}

  /**
   * Returns true if the request is allowed. `perKeyLimitOverride` lets a caller
   * apply a config-driven per-key limit (e.g. a group's maxResponsesPerMinute)
   * instead of the limiter's constructed default.
   */
  check(key: string, perKeyLimitOverride?: number): boolean {
    const now = Date.now();
    const perKeyLimit = perKeyLimitOverride ?? this.perKeyLimit;

    // Reset global window
    if (now > this.global.resetAt) {
      this.global = { count: 0, resetAt: now + this.windowMs };
    }
    if (this.global.count >= this.globalLimit) {
      logger.warn(`Rate limit: global limit reached (${this.globalLimit}/min)`);
      return false;
    }

    // Bound the per-key map so a daemon that has seen many one-off keys
    // (e.g. thousands of Telegram groups over months) doesn't leak memory.
    if (this.perKey.size > 1000) {
      for (const [k, w] of this.perKey) {
        if (now > w.resetAt) this.perKey.delete(k);
      }
    }

    // Reset per-key window
    let keyWindow = this.perKey.get(key);
    if (!keyWindow || now > keyWindow.resetAt) {
      keyWindow = { count: 0, resetAt: now + this.windowMs };
      this.perKey.set(key, keyWindow);
    }
    if (keyWindow.count >= perKeyLimit) {
      logger.warn(`Rate limit: channel ${key} limit reached (${perKeyLimit}/min)`);
      return false;
    }

    this.global.count++;
    keyWindow.count++;
    return true;
  }
}

/** Shared singleton rate limiter for inbound messages */
export const inboundLimiter = new RateLimiter(60, 30);

/** Rate limiter for group responses */
export const groupLimiter = new RateLimiter(10, 3, 60000); // 10 global, 3 per group per minute
