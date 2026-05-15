import type { CircuitBreakerConfig, StreamContentToolUse } from '../types.js';
import { logger } from '../util/logger.js';

export type CircuitBreakerAction = 'ok' | 'warn' | 'notify' | 'break';

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  maxRepeats: 20,
  windowSize: 30,
};

/**
 * Detects loops in claude tool-use streams using consecutive-identical-call
 * counting. The signature is a hash of the tool name + input — JSON.stringify
 * would be O(input-size) per call and a 50KB Write tool input would allocate
 * 50KB just to compare equality, so we use a quick-hash strategy that's
 * length-independent.
 */
function hashSignature(toolUse: StreamContentToolUse): string {
  // FNV-1a 32-bit hash of the JSON repr — fast, collision-rare for short inputs.
  // For correctness we only need equality (was this the same call as before),
  // not reversibility, so a hash is sufficient.
  const s = `${toolUse.name}:${JSON.stringify(toolUse.input)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${toolUse.name}#${(h >>> 0).toString(36)}`;
}

export class CircuitBreaker {
  // Ring buffer to avoid per-call array reslice
  private ring: (string | undefined)[];
  private ringHead = 0;
  private ringSize = 0;
  private config: CircuitBreakerConfig;
  private tripped = false;
  private warned = false;
  private notified = false;

  private readonly WARN_THRESHOLD = 5;
  private readonly NOTIFY_THRESHOLD = 10;

  constructor(
    private tabName: string,
    config?: Partial<CircuitBreakerConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ring = new Array<string | undefined>(this.config.windowSize);
  }

  /** Record a tool call. Returns the action to take. */
  recordToolCall(toolUse: StreamContentToolUse): CircuitBreakerAction {
    if (this.tripped) return 'break';

    const signature = hashSignature(toolUse);
    this.ring[this.ringHead] = signature;
    this.ringHead = (this.ringHead + 1) % this.config.windowSize;
    if (this.ringSize < this.config.windowSize) this.ringSize++;

    // Count consecutive identical signatures walking backwards from the last
    // write. (ringHead points at the NEXT slot, so the most-recent is head-1.)
    let repeatCount = 0;
    for (let i = 0; i < this.ringSize; i++) {
      const idx = (this.ringHead - 1 - i + this.config.windowSize) % this.config.windowSize;
      if (this.ring[idx] === signature) {
        repeatCount++;
      } else {
        break;
      }
    }

    if (repeatCount >= this.config.maxRepeats) {
      logger.warn(
        `[${this.tabName}] Circuit breaker tripped: ${toolUse.name} repeated ${repeatCount} times`,
      );
      this.tripped = true;
      return 'break';
    }

    if (repeatCount >= this.NOTIFY_THRESHOLD && !this.notified) {
      logger.warn(
        `[${this.tabName}] Loop detected: ${toolUse.name} repeated ${repeatCount} times — notifying user`,
      );
      this.notified = true;
      return 'notify';
    }

    if (repeatCount >= this.WARN_THRESHOLD && !this.warned) {
      logger.info(
        `[${this.tabName}] Loop detected: ${toolUse.name} repeated ${repeatCount} times — warning`,
      );
      this.warned = true;
      return 'warn';
    }

    return 'ok';
  }

  reset(): void {
    this.ring.fill(undefined);
    this.ringHead = 0;
    this.ringSize = 0;
    this.tripped = false;
    this.warned = false;
    this.notified = false;
  }

  get isTripped(): boolean {
    return this.tripped;
  }
}
