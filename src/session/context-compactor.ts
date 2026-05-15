/**
 * Context-window compaction: when Claude's context fills, summarize the
 * conversation, rotate to a fresh session, and continue with the summary as
 * the new system seed.
 *
 * Extracted from TabManager.executeMessage. Owns the recursion-depth limit
 * (MAX_DEPTH = 2) and the "fall back to original result" failure mode so
 * compaction errors degrade gracefully instead of orphaning the message.
 */

import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import { logger } from '../util/logger.js';
import type { SendResult } from './manager.js';
import type { Tab } from '../types.js';

export type NotifyFn = ((text: string) => Promise<void>) | null;

export interface SendMessageFn {
  (
    tabName: string,
    prompt: string,
    options?: {
      onTextChunk?: (text: string) => void;
      _compactionDepth?: number;
    },
  ): Promise<SendResult>;
}

export const ContextCompactor = {
  MAX_DEPTH: 2,

  /**
   * Compact and continue the session. Returns the continuation result if
   * compaction succeeds, or the original result if anything goes wrong so the
   * user always gets *something* back.
   *
   * Important: callers should always run `processNextInQueue` (or equivalent)
   * after this resolves regardless of which path it took — the queue drain
   * obligation does not depend on compaction success.
   */
  async compact(
    tab: Tab,
    enrichedPrompt: string,
    originalResult: SendResult,
    onTextChunk: ((text: string) => void) | undefined,
    currentDepth: number,
    sendMessage: SendMessageFn,
    notify: NotifyFn,
    db: Database.Database,
  ): Promise<SendResult> {
    logger.info(
      `[${tab.name}] Compacting context (depth ${currentDepth + 1}/${ContextCompactor.MAX_DEPTH}) — requesting summary then restarting session`,
    );
    notify?.(`🔄 [${tab.name}] Context window full — compacting and continuing...`).catch((err) =>
      logger.warn('Notify failed:', err),
    );
    try {
      const summaryPrompt =
        'Summarize your progress in this session concisely: completed steps, current state, remaining steps, and all important identifiers (file paths, URLs, variable names). Output ONLY the summary.';
      const summaryResult = await sendMessage(tab.name, summaryPrompt, {
        _compactionDepth: currentDepth + 1,
      });
      const newSessionId = uuidv4();
      db.prepare('UPDATE tabs SET session_id = ? WHERE id = ?').run(newSessionId, tab.id);
      logger.info(`[${tab.name}] Context compacted — new session ${newSessionId.slice(0, 8)}...`);
      const continuationPrompt = `[CONTEXT RESTORED FROM PREVIOUS SESSION]\n${summaryResult.text}\n\n[Continue the original task: "${enrichedPrompt.slice(0, 500)}"]`;
      return await sendMessage(tab.name, continuationPrompt, {
        onTextChunk,
        _compactionDepth: currentDepth + 1,
      });
    } catch (err) {
      logger.error(`[${tab.name}] Compaction failed:`, err);
      return originalResult;
    }
  },
};
