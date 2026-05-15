/**
 * Detection + recovery for "Claude Code session not found / expired" errors.
 *
 * Extracted from TabManager.executeMessage so the two responsibilities
 * (recognize the symptom, build the recovery prompt) live in one focused
 * module instead of tangled inline with the subprocess callbacks.
 */

import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { StreamResult } from '../types.js';
import type { SendResult } from './manager.js';

export interface StaleSessionRecovery {
  newSessionId: string;
  /** A prompt that wraps the original enrichedPrompt with the last few messages
   * for context, since Claude Code lost the session and won't have any. */
  contextPrompt: string;
}

export const StaleSessionDetector = {
  /**
   * Was this result an "I can't resume that session" failure?
   *
   * Covers both the legacy text-based error and the modern
   * `error_during_execution` event shape.
   */
  isStale(
    result: SendResult,
    resultEvent: StreamResult | null,
    shouldResume: boolean,
    retryDepth: number,
  ): boolean {
    if (!result.error || !shouldResume || retryDepth !== 0) return false;
    if (/session (not found|expired|invalid)/i.test(result.text)) return true;
    if (
      resultEvent?.subtype === 'error_during_execution' &&
      resultEvent.errors?.some((e) =>
        /no conversation found|session.*not found|session.*expired|session.*invalid/i.test(e),
      )
    ) {
      return true;
    }
    return false;
  },

  /**
   * Build a recovery prompt seeded with the tab's last 5 messages as context,
   * and allocate a fresh session ID. Caller is responsible for updating the
   * tab's session_id in the DB before retrying.
   */
  buildRecovery(
    tabId: string,
    enrichedPrompt: string,
    db: Database.Database,
  ): StaleSessionRecovery {
    const recentMsgs = db
      .prepare(
        "SELECT role, content FROM messages WHERE tab_id = ? AND content != '' ORDER BY created_at DESC LIMIT 5",
      )
      .all(tabId) as Array<{ role: string; content: string }>;
    const context = recentMsgs
      .reverse()
      .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
      .join('\n');
    const contextPrompt = context
      ? `[Previous conversation context:\n${context}\n]\n\n${enrichedPrompt}`
      : enrichedPrompt;
    return { newSessionId: uuidv4(), contextPrompt };
  },
};
