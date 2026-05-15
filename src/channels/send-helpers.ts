import { chunkText, formatTabbedResponse } from '../util/text.js';
import { retryWithBackoff } from '../util/retry.js';

/**
 * Send a tab-prefixed, chunked, retried response through any channel.
 *
 * Each channel just provides:
 *   - sendChunk(text): the platform-specific send call for one chunk
 *   - maxLength:       the platform's per-message limit
 *   - retryLabel:      label for logger (e.g. "telegram-send")
 *
 * Replaces near-identical per-channel implementations that had already
 * drifted in subtle ways (different prefix gates, different retry envelopes).
 */
export async function sendChunkedResponse(opts: {
  text: string;
  tabName?: string;
  maxLength: number;
  retryLabel: string;
  retryDelays?: number[];
  sendChunk: (chunk: string) => Promise<unknown>;
}): Promise<void> {
  const full = formatTabbedResponse(opts.text, opts.tabName);
  const chunks = chunkText(full, opts.maxLength);
  const delays = opts.retryDelays ?? [1000, 5000, 15000];
  for (const chunk of chunks) {
    await retryWithBackoff(() => opts.sendChunk(chunk), delays, opts.retryLabel);
  }
}
