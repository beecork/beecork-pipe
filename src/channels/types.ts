import type { TabManager } from '../session/manager.js';
import type { BeecorkConfig, MediaAttachment } from '../types.js';

export type { MediaAttachment };

/**
 * Options for sending a message. Currently empty — channels do not honor
 * markdown/reply-threading hints. Kept as a placeholder so future per-channel
 * options can be added without touching every call site.
 */
export type SendOptions = Record<string, never>;

/** The Channel interface — all channels must implement this */
export interface Channel {
  /** Unique channel identifier (e.g., 'telegram', 'whatsapp', 'discord') */
  readonly id: string;
  /** Human-readable name */
  readonly name: string;
  /** Maximum message length in characters */
  readonly maxMessageLength: number;

  /** Start the channel (connect, start polling, etc.) */
  start(): Promise<void>;
  /** Stop the channel gracefully */
  stop(): void;
  /** Send a text message to a specific peer */
  sendMessage(peerId: string, text: string, options?: SendOptions): Promise<void>;
  /** Send a media attachment to a peer (optional — channels implement when supported) */
  sendMedia?(peerId: string, media: MediaAttachment): Promise<void>;
  /** Send a notification to all configured recipients */
  sendNotification(message: string, urgent?: boolean): Promise<void>;
  /** Set typing indicator for a peer */
  setTyping(peerId: string, active: boolean): Promise<void>;
  /** Broadcast a media file to every configured recipient — used by the
   * pending-message dispatcher to deliver MCP-queued media. Optional; channels
   * that don't implement it fall back to sendNotification with a text summary. */
  broadcastMedia?(media: MediaAttachment): Promise<void>;
}

/** Context passed to channels during construction */
export interface ChannelContext {
  config: BeecorkConfig;
  tabManager: TabManager;
  /** Broadcast notification to all channels + notification providers */
  notifyCallback?: (message: string) => Promise<void>;
}
