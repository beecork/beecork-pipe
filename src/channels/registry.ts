import { logger } from '../util/logger.js';
import type { Channel } from './types.js';
import type { MediaAttachment } from '../types.js';

/**
 * ChannelRegistry manages the lifecycle of all channels.
 * Channels register themselves, and the registry handles start/stop/broadcast.
 */
export class ChannelRegistry {
  private channels = new Map<string, Channel>();

  /** Register a channel */
  register(channel: Channel): void {
    if (this.channels.has(channel.id)) {
      throw new Error(`Channel "${channel.id}" is already registered`);
    }
    this.channels.set(channel.id, channel);
    logger.info(`Channel registered: ${channel.name} (${channel.id})`);
  }

  /**
   * Start all registered channels in parallel. Each channel's start() is an
   * independent network handshake (Telegram getMe, Discord login, WhatsApp
   * Baileys boot) — running them sequentially adds 2-5s to cold start with no
   * coordination benefit.
   */
  async start(): Promise<void> {
    await Promise.all(
      Array.from(this.channels.entries()).map(async ([id, channel]) => {
        try {
          await channel.start();
          logger.info(`Channel started: ${channel.name}`);
        } catch (err) {
          logger.error(`Failed to start channel ${id}:`, err);
        }
      }),
    );
  }

  /** Stop all channels */
  stop(): void {
    for (const [id, channel] of this.channels) {
      try {
        channel.stop();
      } catch (err) {
        logger.error(`Failed to stop channel ${id}:`, err);
      }
    }
  }

  /** Get a channel by ID */
  get(id: string): Channel | undefined {
    return this.channels.get(id);
  }

  /** Get all registered channels */
  getAll(): Channel[] {
    return Array.from(this.channels.values());
  }

  /** Broadcast a notification to all channels */
  async broadcastNotify(text: string, urgent?: boolean): Promise<void> {
    await Promise.all(
      Array.from(this.channels.values()).map((channel) =>
        channel
          .sendNotification(text, urgent)
          .catch((err) => logger.warn(`${channel.name} notify failed:`, err)),
      ),
    );
  }

  /**
   * Broadcast a media attachment to every channel that supports it. Used by
   * the pending-message dispatcher to deliver media queued by
   * `beecork_send_media` and the `beecork_generate_*` tools — without this,
   * those tools queue a row whose JSON envelope is never rendered.
   *
   * Channels that don't implement broadcastMedia get a sendNotification
   * fallback so the user at least learns a file was generated.
   */
  async broadcastMedia(media: MediaAttachment): Promise<void> {
    await Promise.all(
      Array.from(this.channels.values()).map((channel) => {
        if (channel.broadcastMedia) {
          return channel
            .broadcastMedia(media)
            .catch((err: unknown) => logger.warn(`${channel.name} broadcastMedia failed:`, err));
        }
        const fallback = `📎 Media generated: ${media.filePath}${media.caption ? `\n${media.caption}` : ''}`;
        return channel
          .sendNotification(fallback)
          .catch((err: unknown) =>
            logger.warn(`${channel.name} media-fallback notify failed:`, err),
          );
      }),
    );
  }
}
