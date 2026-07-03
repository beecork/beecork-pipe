/*
 * Discord integration via discord.js (peer-optional, dynamic-imported).
 *
 * discord.js's strict union types (PartialGroupDMChannel, TextChannel, etc.)
 * require narrowing at every send/sendTyping callsite. The runtime channel
 * objects we receive in handlers all support these methods, but expressing
 * that to TypeScript via the published types is a significant refactor with
 * no runtime benefit. We accept `any` at this library boundary — same pattern
 * as the WhatsApp/baileys integration.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { logger } from '../util/logger.js';
import { parseTabMessage } from '../util/text.js';
import { sendChunkedResponse } from './send-helpers.js';
import { inboundLimiter } from '../util/rate-limiter.js';
import { saveMedia, isOversized } from '../media/store.js';
import { VoiceState } from './voice-state.js';
import { processInboundMessage } from './pipeline.js';
import { isChannelAdmin } from './admin.js';
import type { Channel, ChannelContext, MediaAttachment, SendOptions } from './types.js';

/**
 * Whether an inbound Discord message is authorized to reach the pipeline.
 * Authorization is by IDENTITY on every surface (the author must be in the
 * allowlist); servers additionally require an @mention. A mention alone is NOT
 * sufficient — otherwise any server member could drive a Claude Code subprocess.
 * Pure + exported so the C1 fix is pinned by a unit test.
 */
export function isDiscordMessageAllowed(
  allowedUserIds: Set<string>,
  authorId: string,
  isDM: boolean,
  isMentioned: boolean,
): boolean {
  if (!allowedUserIds.has(authorId)) return false;
  if (!isDM && !isMentioned) return false;
  return true;
}

export class DiscordChannel implements Channel {
  readonly id = 'discord';
  readonly name = 'Discord';
  readonly maxMessageLength = 2000;

  private client: any = null; // Discord.js Client
  private ctx: ChannelContext;
  private allowedUserIds: Set<string>;
  private voice = new VoiceState('discord');

  constructor(ctx: ChannelContext) {
    this.ctx = ctx;
    this.allowedUserIds = new Set((ctx.config.discord?.allowedUserIds ?? []).map(String));
  }

  async start(): Promise<void> {
    const discordConfig = this.ctx.config.discord;
    if (!discordConfig?.token) {
      logger.warn('No Discord token configured');
      return;
    }
    if (this.allowedUserIds.size === 0) {
      logger.warn(
        'Discord: allowedUserIds is empty — the bot will ignore every message (DMs and servers). Add user IDs to discord.allowedUserIds to enable it.',
      );
    }

    // Dynamic import since discord.js might not be installed
    const { Client, GatewayIntentBits, Events } = await import('discord.js');

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    // Voice providers (STT + TTS)
    this.voice.init(this.ctx.config);

    this.client.on(Events.MessageCreate, async (message: any) => {
      // Ignore bot messages
      if (message.author.bot) return;

      const isDM = !message.guild;
      const isMentioned = message.mentions.has(this.client.user);

      if (!isDiscordMessageAllowed(this.allowedUserIds, message.author.id, isDM, isMentioned)) {
        return;
      }

      // Rate limit
      if (!inboundLimiter.check(this.id)) {
        await message
          .reply("I'm receiving too many messages right now. Please wait a moment.")
          .catch(() => {});
        return;
      }

      const text = message.content
        .replace(/<@!?\d+>/g, '') // Remove mentions
        .trim();

      // Warm up STT connection on first message with attachments.
      // (Discord intentionally only warms up; it doesn't transcribe like Telegram/WhatsApp.)
      if (message.attachments.size > 0) await this.voice.warmup();

      // Download attachments
      const media: MediaAttachment[] = [];
      for (const attachment of message.attachments.values()) {
        try {
          if (isOversized(attachment.size)) {
            logger.warn(`Skipping oversized Discord attachment: ${attachment.size} bytes`);
            continue;
          }
          const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30000) });
          if (!response.ok) continue;
          const buffer = Buffer.from(await response.arrayBuffer());
          const ext = attachment.name?.split('.').pop() || 'bin';
          const filePath = saveMedia(buffer, ext, attachment.name);

          let type: MediaAttachment['type'] = 'document';
          if (attachment.contentType?.startsWith('image/')) type = 'image';
          else if (attachment.contentType?.startsWith('video/')) type = 'video';
          else if (attachment.contentType?.startsWith('audio/')) type = 'audio';

          media.push({
            type,
            mimeType: attachment.contentType || 'application/octet-stream',
            filePath,
            fileName: attachment.name,
          });
        } catch (err) {
          logger.warn('Failed to download Discord attachment:', err);
        }
      }

      if (!text && media.length === 0) return;

      try {
        // Show typing
        await message.channel.sendTyping().catch(() => {});

        // Parse tab name (needed for command handling check)
        const { tabName } = parseTabMessage(text || '');

        // Shared command handler
        if (text.startsWith('/')) {
          const { handleSharedCommand } = await import('./command-handler.js');
          const cmdResult = await handleSharedCommand(
            {
              userId: message.author.id,
              text,
              isAdmin: isChannelAdmin(
                this.allowedUserIds,
                message.author.id,
                this.ctx.config.discord?.adminUserId,
              ),
              channelId: 'discord',
            },
            this.ctx.tabManager,
          );
          if (cmdResult.handled) {
            if (cmdResult.response) await message.reply(cmdResult.response);
            return;
          }
        }

        // Discord-specific: use thread name as tab if in a thread
        let overrideTabName: string | undefined;
        if (message.channel.isThread?.()) {
          const sanitized = (message.channel.name || '')
            .replace(/[^a-zA-Z0-9-]/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 32);
          // Run the synthesized name through validateTabName so weird thread
          // names (empty, starts with hyphen, "default") don't blow up downstream.
          const { validateTabName } = await import('../config.js');
          if (sanitized && tabName === 'default' && !validateTabName(sanitized)) {
            overrideTabName = sanitized;
          }
        }

        // Typing indicator refresh
        const typingInterval = setInterval(() => {
          message.channel.sendTyping().catch(() => {});
        }, 8000); // Discord typing lasts 10s

        try {
          // Shared message pipeline
          const pipelineResult = await processInboundMessage({
            text: text || '',
            media,
            channelId: 'discord',
            tabManager: this.ctx.tabManager,
            voiceReplyMode: this.ctx.config.voice?.replyMode,
            ttsProvider: this.voice.tts,
            userId: message.author.id,
            sendProgress: (msg) => {
              message.channel.send(msg).catch(() => {});
            },
            overrideTabName,
          });
          clearInterval(typingInterval);

          // Empty result means no prompt and no media
          if (!pipelineResult.responseText) return;

          // Voice reply if TTS generated audio
          if (pipelineResult.audioPath) {
            await message.reply({ files: [pipelineResult.audioPath] });
            if (pipelineResult.voiceOnly) return;
          }

          // Send text response
          await this.sendResponse(message, pipelineResult.responseText, pipelineResult.tabName);
        } catch (err) {
          clearInterval(typingInterval);
          throw err;
        }
      } catch (err) {
        logger.error('Discord message handler error:', err);
        await message.reply('Something went wrong processing your message.').catch(() => {});
      }
    });

    this.client.on(Events.ClientReady, () => {
      logger.info(`Discord bot ready as ${this.client.user?.tag}`);
    });

    await this.client.login(discordConfig.token);
  }

  stop(): void {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    logger.info('Discord bot stopped');
  }

  async sendMessage(peerId: string, text: string, _options?: SendOptions): Promise<void> {
    if (!this.client) return;
    try {
      const channel = await this.client.channels.fetch(peerId);
      if (!channel?.isTextBased()) return;
      await sendChunkedResponse({
        text,
        maxLength: this.maxMessageLength,
        retryLabel: 'discord-send',
        sendChunk: (chunk) => channel.send(chunk),
      });
    } catch (err) {
      logger.error(`Discord send failed for ${peerId}:`, err);
    }
  }

  async sendNotification(message: string, _urgent?: boolean): Promise<void> {
    if (!this.client) return;
    // Send to all allowed users via DM
    for (const userId of this.allowedUserIds) {
      try {
        const user = await this.client.users.fetch(userId);
        if (user) {
          await user.send(message);
        }
      } catch (err) {
        logger.error(`Discord notification failed for ${userId}:`, err);
      }
    }
  }

  async setTyping(peerId: string, active: boolean): Promise<void> {
    if (!this.client || !active) return;
    try {
      const channel = await this.client.channels.fetch(peerId);
      if (channel?.isTextBased()) {
        await channel.sendTyping();
      }
    } catch {}
  }

  private async sendResponse(message: any, text: string, tabName?: string): Promise<void> {
    // Discord quirk: first chunk uses message.reply so it threads under the
    // original user message; follow-ups use channel.send. sendChunkedResponse
    // handles prefix + chunking + retry envelope; the closure-tracked chunkIdx
    // keeps the "first chunk replies, rest send" behavior.
    let chunkIdx = 0;
    await sendChunkedResponse({
      text,
      tabName,
      maxLength: this.maxMessageLength,
      retryDelays: [1000, 5000],
      retryLabel: 'discord-send',
      sendChunk: (chunk) => {
        const isFirst = chunkIdx === 0;
        chunkIdx++;
        return isFirst ? message.reply(chunk) : message.channel.send(chunk);
      },
    });
  }
}
