/**
 * Polls `pending_messages` and dispatches each row by type.
 *
 * Replaces the inline `processPendingMessages` block that previously lived in
 * TabManager. Two functional changes from that code:
 *
 *  1. Claim-before-dispatch (status='processing' set atomically before send).
 *     The original poll-every-5s code re-picked the same row on every tick
 *     while its dispatch was in flight — long Claude runs could re-fire the
 *     same prompt many times.
 *
 *  2. Branch on type. The original consumer only recognized 'notification' and
 *     fell through to "send as plain user prompt" for everything else, which
 *     meant `type='media'` rows were handed to Claude as raw JSON and never
 *     actually delivered to channels.
 */

import type { TabManager } from './manager.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { MediaAttachment } from '../types.js';
import { getDb } from '../db/index.js';
import { logger } from '../util/logger.js';
import { PendingMessageStore, type PendingRow } from './pending-store.js';

export type NotifyFn = ((text: string) => Promise<void>) | null;

const POLL_LIMIT = 50;
const CLEANUP_EVERY_N_TICKS = 100;
// Cap concurrent in-flight dispatches so a claim burst or a wake-from-sleep
// catch-up (many overdue rows at once) can't spawn dozens of `claude`
// subprocesses simultaneously. Excess rows stay 'pending' and are claimed on
// later ticks as capacity frees up.
const MAX_CONCURRENT_DISPATCH = 8;

export class PendingMessageDispatcher {
  private pollCount = 0;
  private inFlight = 0;

  constructor(
    private tabManager: TabManager,
    private channels: ChannelRegistry,
    private onNotify: NotifyFn,
  ) {}

  /** Reset any rows stuck in 'processing' from a previous daemon run. */
  recoverOnStart(): void {
    PendingMessageStore.recoverProcessing();
  }

  /** Called on every daemon poll tick. */
  tick(): void {
    const db = getDb();
    this.pollCount++;
    if (this.pollCount % CLEANUP_EVERY_N_TICKS === 0) {
      db.prepare(
        "DELETE FROM pending_messages WHERE (status = 'done' OR status = 'failed') AND created_at < datetime('now', '-1 day')",
      ).run();
      // Periodically re-run stuck-row recovery (not only at startup) so a row
      // claimed just before a crash doesn't wait for the next daemon restart.
      PendingMessageStore.recoverProcessing(db);
    }

    // Only claim as many as we have spare capacity for — a claimed row is marked
    // 'processing', so we must not claim more than we can dispatch this tick.
    const capacity = MAX_CONCURRENT_DISPATCH - this.inFlight;
    if (capacity <= 0) return;

    const claimed = PendingMessageStore.claimBatch(Math.min(POLL_LIMIT, capacity), db);
    for (const row of claimed) {
      // Fire-and-forget per row — the row is already marked 'processing' so
      // the next tick won't double-dispatch. The .finally() handles the
      // terminal transition.
      this.inFlight++;
      void this.dispatch(row).finally(() => {
        this.inFlight--;
      });
    }
  }

  private async dispatch(row: PendingRow): Promise<void> {
    try {
      switch (row.type) {
        case 'notification':
          await this.onNotify?.(row.message);
          break;
        case 'media': {
          const payload = PendingMessageStore.parseMediaPayload(row.message);
          if (!payload) {
            logger.warn(`Pending media row ${row.id} has malformed payload, skipping`);
            break;
          }
          const attachment = inferAttachmentType(payload.filePath, payload.caption);
          await this.channels.broadcastMedia(attachment);
          break;
        }
        case 'user':
        case 'delegation':
        case 'delegation_result':
        case 'replay': {
          if (!row.tabName) {
            logger.warn(`Pending row ${row.id} (type=${row.type}) has no tab_name, skipping`);
            break;
          }
          // For a delegation dispatch, carry the delegation id so that when this
          // run completes it closes THAT delegation (not "newest pending to this
          // tab"). refId is null for every other type.
          await this.tabManager.sendMessage(
            row.tabName,
            row.message,
            row.type === 'delegation' && row.refId ? { delegationId: row.refId } : undefined,
          );
          break;
        }
        default: {
          // Unknown discriminant — log and bail rather than fall through to
          // "send as a plain prompt" (which is how H5 ended up shipping).
          logger.warn(`Pending row ${row.id} has unknown type "${row.type}", marking failed`);
          PendingMessageStore.markFailed(row.id);
          return;
        }
      }
      PendingMessageStore.markDone(row.id);
    } catch (err) {
      logger.error(`Failed to process pending message ${row.id} (type=${row.type}):`, err);
      await this.onNotify?.(
        `Pending message ${row.type === 'notification' ? '' : `for tab "${row.tabName}"`} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ).catch(() => {});
      PendingMessageStore.markFailed(row.id);
    }
  }
}

/**
 * Heuristic: derive a MediaAttachment from a file path so the channel's
 * broadcastMedia knows whether to send as voice / image / video / document.
 */
function inferAttachmentType(filePath: string, caption?: string): MediaAttachment {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  let type: MediaAttachment['type'] = 'document';
  let mimeType = 'application/octet-stream';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
    type = 'image';
    mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  } else if (['mp4', 'mov', 'webm', 'mkv'].includes(ext)) {
    type = 'video';
    mimeType = `video/${ext === 'mov' ? 'quicktime' : ext}`;
  } else if (['ogg', 'opus', 'oga'].includes(ext)) {
    type = 'voice';
    mimeType = 'audio/ogg';
  } else if (['mp3', 'm4a', 'wav', 'flac', 'aac'].includes(ext)) {
    type = 'audio';
    mimeType = `audio/${ext}`;
  }
  return { type, mimeType, filePath, caption };
}
