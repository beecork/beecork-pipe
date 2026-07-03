/**
 * Per-tab FIFO queue for messages waiting on a busy subprocess.
 *
 * Extracted from TabManager so the queue's "max size, enqueue, dequeue,
 * peek-and-mutate-next, clear-on-stop" semantics are self-contained and
 * unit-testable without spinning up a real subprocess.
 */

import type { SendResult } from './manager.js';

export const MAX_QUEUE_SIZE = 10;

export interface QueuedMessage {
  prompt: string;
  // Render/behavior options carried so a message queued behind a busy tab runs
  // with the same streaming callbacks, resume flag, and delegation correlation
  // as it would have unqueued — previously these were dropped on dequeue.
  resume?: boolean;
  onTextChunk?: (text: string) => void;
  onToolUse?: (toolName: string, toolInput: Record<string, unknown>) => void;
  compactionDepth?: number;
  delegationId?: string;
  resolve: (r: SendResult) => void;
  reject: (e: Error) => void;
}

export class MessageQueue {
  private queues: Map<string, QueuedMessage[]> = new Map();

  /** Attempt to enqueue. Returns false if the per-tab queue is full. */
  enqueue(tabName: string, msg: QueuedMessage): boolean {
    let queue = this.queues.get(tabName);
    if (!queue) {
      queue = [];
      this.queues.set(tabName, queue);
    }
    if (queue.length >= MAX_QUEUE_SIZE) return false;
    queue.push(msg);
    return true;
  }

  /** Remove and return the next message. Drops the per-tab entry when empty. */
  dequeue(tabName: string): QueuedMessage | undefined {
    const queue = this.queues.get(tabName);
    if (!queue || queue.length === 0) return undefined;
    const next = queue.shift();
    if (queue.length === 0) this.queues.delete(tabName);
    return next;
  }

  /** Peek at the next queued message without removing it (used to inject loop warning prefix). */
  peek(tabName: string): QueuedMessage | undefined {
    return this.queues.get(tabName)?.[0];
  }

  size(tabName: string): number {
    return this.queues.get(tabName)?.length ?? 0;
  }

  /** Drain the queue for a tab, returning the dropped messages so callers can reject them. */
  clear(tabName: string): QueuedMessage[] {
    const queue = this.queues.get(tabName) ?? [];
    this.queues.delete(tabName);
    return queue;
  }

  /** Drain every queue. Returns the dropped messages grouped by tab. */
  clearAll(): QueuedMessage[][] {
    const all = Array.from(this.queues.values());
    this.queues.clear();
    return all;
  }
}
