import { logger } from '../util/logger.js';
import { chunkText, formatTabbedResponse, parseTabMessage } from '../util/text.js';
import { retryWithBackoff } from '../util/retry.js';
import { inboundLimiter } from '../util/rate-limiter.js';
import { saveMedia, isOversized } from '../media/store.js';
import { VoiceState } from './voice-state.js';
import { processInboundMessage } from './pipeline.js';
import { isChannelAdmin } from './admin.js';
import type { Channel, ChannelContext, InboundMessageHandler, MediaAttachment, SendOptions } from './types.js';

export class DiscordChannel implements Channel {
  readonly id = 'discord';
  readonly name = 'Discord';
  readonly maxMessageLength = 2000;
  readonly supportsStreaming = false; // Discord message editing is rate-limited
  readonly supportsMedia = true;

  private client: any = null; // Discord.js Client
  private ctx: ChannelContext;
  private allowedUserIds: Set<string>;
  private voice = new VoiceState('discord');

  constructor(ctx: ChannelContext) {
    this.ctx = ctx;
    this.allowedUserIds = new Set(
      (ctx.config.discord?.allowedUserIds ?? []).map(String)
    );
  }

  async start(): Promise<void> {
    const discordConfig = this.ctx.config.discord;
    if (!discordConfig?.token) {
      logger.warn('No Discord token configured');
      return;
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

      // In DMs: only allow users in the allowlist
      // In servers: only respond if @mentioned
      if (isDM) {
        if (!this.allowedUserIds.has(message.author.id)) return;
      } else {
        if (!isMentioned) return;
      }

      // Rate limit
      if (!inboundLimiter.check(this.id)) {
        await message.reply("I'm receiving too many messages right now. Please wait a moment.").catch(() => {});
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
          const cmdResult = await handleSharedCommand({
            userId: message.author.id,
            text,
            isAdmin: isChannelAdmin(this.allowedUserIds, message.author.id, this.ctx.config.discord?.adminUserId),
            channelId: 'discord',
          }, this.ctx.tabManager);
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

  onMessage(_handler: InboundMessageHandler): void {
    // Messages are handled directly in start()
  }

  async sendMessage(peerId: string, text: string, options?: SendOptions): Promise<void> {
    if (!this.client) return;
    try {
      const channel = await this.client.channels.fetch(peerId);
      if (!channel?.isTextBased()) return;

      const chunks = chunkText(text, this.maxMessageLength);
      for (const chunk of chunks) {
        await retryWithBackoff(
          () => channel.send(chunk),
          [1000, 5000, 15000],
          'discord-send',
        );
      }
    } catch (err) {
      logger.error(`Discord send failed for ${peerId}:`, err);
    }
  }

  async sendNotification(message: string, urgent?: boolean): Promise<void> {
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
    // original user message; follow-ups use channel.send. The shared helper
    // takes a sendChunk callback so each channel keeps its platform-specific
    // dispatch while sharing chunk + prefix + retry logic.
    const full = formatTabbedResponse(text, tabName);
    const chunks = chunkText(full, this.maxMessageLength);
    for (let i = 0; i < chunks.length; i++) {
      const isFirst = i === 0;
      await retryWithBackoff(
        () => isFirst ? message.reply(chunks[i]) : message.channel.send(chunks[i]),
        [1000, 5000],
        isFirst ? 'discord-reply' : 'discord-send',
      );
    }
  }
}
