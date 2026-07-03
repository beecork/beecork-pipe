import TelegramBot from 'node-telegram-bot-api';
import fs from 'node:fs';
import path from 'node:path';
import { chunkText, parseTabMessage, formatTabbedResponse, MESSAGE_LIMITS } from '../util/text.js';
import { logger } from '../util/logger.js';
import { retryWithBackoff } from '../util/retry.js';
import { sendChunkedResponse } from './send-helpers.js';
import { getLogsDir } from '../util/paths.js';
import { saveMedia, isOversized } from '../media/store.js';
import { inboundLimiter, groupLimiter } from '../util/rate-limiter.js';
import { processInboundMessage } from './pipeline.js';
import { isChannelAdmin } from './admin.js';
import type { Channel, ChannelContext, MediaAttachment, SendOptions } from './types.js';
import type { GroupConfig } from '../types.js';
import { VoiceState } from './voice-state.js';

const DEFAULT_GROUP_CONFIG: GroupConfig = {
  activationMode: 'mention',
  maxResponsesPerMinute: 3,
  tabPerGroup: true,
};

/**
 * Strip Telegram bot tokens out of strings before logging. Telegram embeds
 * the token in the URL path (e.g. https://api.telegram.org/bot1234:abc.../method),
 * so on fetch errors the message/cause can leak the token to disk.
 */
function sanitizeBotToken(text: string): string {
  return text.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<REDACTED>');
}

export class TelegramChannel implements Channel {
  readonly id = 'telegram';
  readonly name = 'Telegram';
  readonly maxMessageLength = MESSAGE_LIMITS.CHUNK;

  private bot: TelegramBot;
  private ctx: ChannelContext;
  private activeChatIds: Set<number> = new Set();
  // Set form of config.telegram.allowedUserIds for O(1) per-message membership
  // checks. Built lazily in start() so config edits via reload (if added later)
  // can call rebuildAllowedSet().
  private allowedUserIdSet: Set<number> = new Set();
  private voice = new VoiceState('telegram');
  private botUserId: number | null = null;
  private botUsername: string | null = null;
  private mutedGroups = new Set<number>();
  private welcomeSent = new Set<number>();
  // Polling-error tracking: warn the user once when the bot is silently broken
  // (network drop, telegram 5xx, token revoked, etc.). Without this, the daemon
  // looks fine but Telegram has stopped delivering inbound messages.
  private pollingErrorTimes: number[] = [];
  private pollingDegradedNotified = false;

  constructor(ctx: ChannelContext) {
    this.ctx = ctx;
    this.bot = new TelegramBot(ctx.config.telegram.token, {
      polling: {
        params: {
          timeout: 30,
          allowed_updates: ['message', 'callback_query'],
        },
        autoStart: false,
      },
    });
    this.bot.sendMessage = this.bot.sendMessage.bind(this.bot);
  }

  async start(): Promise<void> {
    // Clear pending updates from old sessions, then start polling.
    // node-telegram-bot-api's TS types don't include deleteWebHook, so we go
    // through a typed shim rather than `as any`.
    try {
      await (
        this.bot as unknown as {
          deleteWebHook: (opts: { drop_pending_updates: boolean }) => Promise<unknown>;
        }
      ).deleteWebHook({ drop_pending_updates: true });
    } catch (err) {
      logger.error('Failed to clear pending updates, starting anyway:', err);
    }
    // Initialize voice providers (STT + TTS)
    this.voice.init(this.ctx.config);

    // Subscribe to library-level error events BEFORE startPolling so transient
    // failures don't disappear into the void. node-telegram-bot-api emits
    // 'polling_error' on network/auth/5xx issues — without a listener these
    // were previously silently dropped, leaving the channel dead with no signal.
    this.bot.on('polling_error', (err: Error) => {
      logger.error('Telegram polling error:', sanitizeBotToken(err?.message || String(err)));
      this.recordPollingError();
    });
    this.bot.on('error', (err: Error) => {
      logger.error('Telegram client error:', sanitizeBotToken(err?.message || String(err)));
    });

    this.bot.startPolling();

    this.allowedUserIdSet = new Set(this.ctx.config.telegram.allowedUserIds);
    if (this.allowedUserIdSet.size === 0) {
      logger.warn(
        'Telegram allowedUserIds is empty — bot will reject all inbound messages until you add at least one user ID.',
      );
    }

    // Cache bot identity for group mention detection
    try {
      const me = await this.bot.getMe();
      this.botUserId = me.id;
      this.botUsername = me.username ?? null;
    } catch (err) {
      logger.warn('Failed to fetch bot identity (group mentions may not work):', err);
    }

    this.setupHandlers();
    logger.info('Telegram bot started (polling mode, cleared pending updates)');
  }

  /**
   * Track polling errors over a 60s rolling window. If we see 5+ errors in 60s
   * we surface "polling degraded" exactly once via the notify callback so the
   * user knows Telegram is broken instead of silently failing.
   */
  private recordPollingError(): void {
    const now = Date.now();
    this.pollingErrorTimes.push(now);
    this.pollingErrorTimes = this.pollingErrorTimes.filter((t) => now - t < 60_000);
    if (this.pollingErrorTimes.length >= 5 && !this.pollingDegradedNotified) {
      this.pollingDegradedNotified = true;
      this.ctx
        .notifyCallback?.('⚠️ Telegram polling degraded (5+ errors in 60s). Check daemon.log.')
        .catch((err) => logger.warn('Failed to send polling-degraded notice:', err));
      // Reset notification flag after 5 minutes so a sustained outage that
      // recovers and reoccurs can re-notify.
      setTimeout(() => {
        this.pollingDegradedNotified = false;
      }, 5 * 60_000).unref();
    }
  }

  stop(): void {
    this.bot.stopPolling();
    logger.info('Telegram bot stopped');
  }

  async sendMessage(peerId: string, text: string, _options?: SendOptions): Promise<void> {
    const chatId = Number(peerId);
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      await this.sendWithRetry(chatId, chunk);
    }
  }

  async sendNotification(message: string, _urgent?: boolean): Promise<void> {
    for (const chatId of this.activeChatIds) {
      try {
        await this.bot.sendMessage(chatId, message);
      } catch (err) {
        logger.error(`Failed to send notification to chat ${chatId}:`, err);
      }
    }

    for (const userId of this.ctx.config.telegram.allowedUserIds) {
      if (this.activeChatIds.has(userId)) continue;
      try {
        await this.bot.sendMessage(userId, message);
        this.activeChatIds.add(userId);
      } catch (err) {
        // Differentiate: 400 "chat not found" means the user has not started a
        // conversation with the bot yet — silently skip. Anything else (rate
        // limit, bot blocked, network) is a real delivery failure worth logging.
        const errAny = err as { response?: { statusCode?: number }; code?: string } & Error;
        const status = errAny?.response?.statusCode;
        const isChatNotFound = status === 400 || /chat not found/i.test(errAny?.message || '');
        if (!isChatNotFound) {
          logger.warn(
            `Telegram notify to ${userId} failed (status=${status ?? '?'}):`,
            sanitizeBotToken(errAny?.message || String(err)),
          );
        }
      }
    }
  }

  /**
   * Send a media file to every recipient the bot would notify. Used by the
   * pending-message dispatcher to deliver media queued by MCP tools.
   * Routes by attachment type to the right Telegram primitive (sendVoice for
   * voice messages, sendPhoto for images, sendVideo for video, sendDocument
   * for everything else).
   */
  async broadcastMedia(media: MediaAttachment): Promise<void> {
    const recipients = new Set<number>(this.activeChatIds);
    for (const userId of this.ctx.config.telegram.allowedUserIds) recipients.add(userId);
    if (recipients.size === 0) return;
    const caption = media.caption ? { caption: media.caption.slice(0, 1024) } : undefined;
    for (const chatId of recipients) {
      try {
        switch (media.type) {
          case 'voice':
            await this.bot.sendVoice(chatId, media.filePath, caption);
            break;
          case 'audio':
            await this.bot.sendAudio(chatId, media.filePath, caption);
            break;
          case 'image':
            await this.bot.sendPhoto(chatId, media.filePath, caption);
            break;
          case 'video':
            await this.bot.sendVideo(chatId, media.filePath, caption);
            break;
          case 'document':
          default:
            await this.bot.sendDocument(chatId, media.filePath, caption);
            break;
        }
      } catch (err) {
        logger.warn(
          `Telegram broadcastMedia to ${chatId} failed:`,
          sanitizeBotToken(err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }

  async setTyping(peerId: string, active: boolean): Promise<void> {
    if (active) {
      await this.bot.sendChatAction(Number(peerId), 'typing').catch((err) => {
        logger.error(`Typing indicator failed for chat ${peerId}:`, err);
      });
    }
  }

  // ─── Private ───

  private setupHandlers(): void {
    this.bot.on('message', async (msg) => {
      if (!this.isAllowed(msg.from?.id)) return;

      const chatId = msg.chat.id;

      // Rate limit check
      if (!inboundLimiter.check(this.id)) {
        await this.bot.sendMessage(
          chatId,
          "I'm receiving too many messages right now. Please wait a moment.",
        );
        return;
      }

      const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

      // First-run welcome message (once per user)
      if (msg.chat.type === 'private' && !this.welcomeSent.has(chatId)) {
        const db = (await import('../db/index.js')).getDb();
        const hasMessages = db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number };
        if (hasMessages.c === 0) {
          this.welcomeSent.add(chatId);
          const welcomeText = msg.text?.trim() || '';
          await this.bot.sendMessage(
            chatId,
            [
              '\uD83D\uDC4B Welcome to Beecork!\n',
              "Send any message and I'll pass it to Claude Code.",
              '',
              'Quick tips:',
              '\u2022 /tab name message \u2014 organize work into tabs',
              "\u2022 /tabs \u2014 see what's running",
              '\u2022 /stop name \u2014 stop a tab',
              '',
              "Let's get started! Send me something.",
            ].join('\n'),
          );
          // Don't return - let the actual message be processed too (unless it was just /start)
          if (welcomeText === '/start') return;
        } else {
          this.welcomeSent.add(chatId);
        }
      }

      // Only add to activeChatIds for private chats
      if (!isGroup) {
        this.activeChatIds.add(chatId);
      }

      // Extract text (from text, caption, etc.)
      let text = msg.text?.trim() || msg.caption?.trim() || '';

      // ─── Group activation logic ───
      if (isGroup) {
        // Check muted status
        if (this.mutedGroups.has(chatId)) return;

        const groupConfig = this.ctx.config.groups || DEFAULT_GROUP_CONFIG;

        const isMentioned = this.botUsername ? text.includes(`@${this.botUsername}`) : false;
        const isReplyToBot = msg.reply_to_message?.from?.id === this.botUserId;

        let shouldActivate = false;
        switch (groupConfig.activationMode) {
          case 'mention':
            shouldActivate = !!isMentioned;
            break;
          case 'reply':
            shouldActivate = !!isReplyToBot;
            break;
          case 'keyword':
            shouldActivate =
              groupConfig.keywords?.some((kw) => text.toLowerCase().includes(kw.toLowerCase())) ??
              false;
            break;
          case 'always':
            shouldActivate = true;
            break;
        }

        if (!shouldActivate) return;

        // Group rate limiting — honor the configured per-group cap.
        const groupKey = `group:${chatId}`;
        if (!groupLimiter.check(groupKey, groupConfig.maxResponsesPerMinute)) {
          // Silently ignore — don't spam the group with rate limit messages
          return;
        }

        // Clean mention from text
        if (isMentioned && this.botUsername) {
          text = text.replace(new RegExp(`@${this.botUsername}`, 'gi'), '').trim();
        }
      }

      // Track voice pipeline timing
      const voicePipelineStart = msg.voice ? Date.now() : null;

      // Download media if present (in parallel)
      const downloadTasks: Array<Promise<MediaAttachment | null>> = [];
      if (msg.photo) {
        const photo = msg.photo[msg.photo.length - 1];
        downloadTasks.push(
          this.downloadTelegramFile(photo.file_id, 'jpg')
            .then((fp) =>
              fp
                ? {
                    type: 'image' as const,
                    mimeType: 'image/jpeg',
                    filePath: fp,
                    fileName: `photo-${photo.file_id}.jpg`,
                  }
                : null,
            )
            .catch(() => null),
        );
      }
      if (msg.voice) {
        downloadTasks.push(
          this.downloadTelegramFile(msg.voice.file_id, 'ogg')
            .then((fp) =>
              fp ? { type: 'voice' as const, mimeType: 'audio/ogg', filePath: fp } : null,
            )
            .catch(() => null),
        );
      }
      if (msg.audio) {
        downloadTasks.push(
          this.downloadTelegramFile(msg.audio.file_id, 'mp3')
            .then((fp) =>
              fp
                ? {
                    type: 'audio' as const,
                    mimeType: msg.audio!.mime_type || 'audio/mpeg',
                    filePath: fp,
                    fileName: msg.audio!.title,
                  }
                : null,
            )
            .catch(() => null),
        );
      }
      if (msg.document) {
        const ext = msg.document.file_name?.split('.').pop() || 'bin';
        downloadTasks.push(
          this.downloadTelegramFile(msg.document.file_id, ext)
            .then((fp) =>
              fp
                ? {
                    type: 'document' as const,
                    mimeType: msg.document!.mime_type || 'application/octet-stream',
                    filePath: fp,
                    fileName: msg.document!.file_name,
                  }
                : null,
            )
            .catch(() => null),
        );
      }
      if (msg.video) {
        downloadTasks.push(
          this.downloadTelegramFile(msg.video.file_id, 'mp4')
            .then((fp) =>
              fp
                ? {
                    type: 'video' as const,
                    mimeType: msg.video!.mime_type || 'video/mp4',
                    filePath: fp,
                  }
                : null,
            )
            .catch(() => null),
        );
      }
      const downloadResults = await Promise.allSettled(downloadTasks);
      const media: MediaAttachment[] = downloadResults
        .filter(
          (r): r is PromiseFulfilledResult<MediaAttachment | null> =>
            r.status === 'fulfilled' && r.value !== null,
        )
        .map((r) => r.value!);

      // Transcribe voice messages if STT is configured
      await this.voice.transcribe(media);

      // Skip if no text AND no media
      if (!text && media.length === 0) return;

      try {
        // Commands bypass debouncing (only if pure text, no media)
        if (text.startsWith('/') && media.length === 0) {
          await this.handleCommand(chatId, text, msg.from?.id, msg.message_id, isGroup);
          return;
        }

        // Send typing indicator immediately
        this.bot.sendChatAction(chatId, 'typing').catch((err) => {
          logger.error(`Typing indicator failed for chat ${chatId}:`, err);
        });
        logger.info(`[telegram] Message received from ${msg.from?.id}, sending typing`);

        await this.handleMessage(chatId, text, msg.message_id, media, isGroup);
        if (voicePipelineStart) {
          logger.info(`[telegram] Voice-to-response total: ${Date.now() - voicePipelineStart}ms`);
        }
      } catch (err) {
        logger.error('Telegram: error handling message:', err);
        // Wrap the fallback send so a Telegram outage doesn't escalate to an
        // unhandledRejection on the message-event handler.
        this.bot
          .sendMessage(
            chatId,
            'Something went wrong processing your message. Check daemon logs for details.',
          )
          .catch((sendErr) =>
            logger.error('Telegram: failed to send fallback error message:', sendErr),
          );
      }
    });
  }

  private async handleCommand(
    chatId: number,
    text: string,
    userId: number | undefined,
    messageId: number,
    isGroup = false,
  ): Promise<void> {
    // Telegram-only group commands
    if (text === '/mute' && isGroup) {
      this.mutedGroups.add(chatId);
      await this.bot.sendMessage(chatId, 'Beecork muted in this group. Use /unmute to re-enable.');
      return;
    }
    if (text === '/unmute' && isGroup) {
      this.mutedGroups.delete(chatId);
      await this.bot.sendMessage(chatId, 'Beecork unmuted in this group.');
      return;
    }

    // /history and /knowledge now handled by the shared command handler.

    // Shared command handler (covers /tabs, /stop, /tab, /projects, /project, /newproject, /close, /fresh, /cost, /activity, /handoff, /history, /knowledge)
    const { handleSharedCommand } = await import('./command-handler.js');
    const result = await handleSharedCommand(
      {
        userId: String(userId || 'default'),
        text,
        isAdmin: this.isAdmin(userId),
        channelId: 'telegram',
      },
      this.ctx.tabManager,
    );

    if (result.handled) {
      if (result.response) await this.bot.sendMessage(chatId, result.response);
      return;
    }

    // /tab with valid name — falls through from shared handler, treat as message
    if (text.startsWith('/tab ')) {
      await this.handleMessage(chatId, text, messageId);
      return;
    }

    // Unknown command — treat as regular message
    await this.handleMessage(chatId, text, messageId);
  }

  private async handleMessage(
    chatId: number,
    text: string,
    messageId: number,
    media: MediaAttachment[] = [],
    isGroup = false,
  ): Promise<void> {
    const { tabName } = parseTabMessage(text);
    if (!tabName && !text && media.length === 0) return;

    // Telegram-specific: group tab routing
    let overrideTabName: string | undefined;
    if (isGroup) {
      const groupConfig = this.ctx.config.groups || DEFAULT_GROUP_CONFIG;
      if (groupConfig.tabPerGroup && !text.startsWith('/tab ')) {
        overrideTabName = `group-tg-${Math.abs(chatId)}`;
      }
    }

    // React with ⏳
    await this.setReaction(chatId, messageId, '⏳');

    // Typing indicator — keep refreshing every 4s
    const sendTyping = () =>
      this.bot.sendChatAction(chatId, 'typing').catch((err) => {
        logger.error(`Typing indicator failed:`, err);
      });
    await sendTyping();
    const typingInterval = setInterval(sendTyping, 4000);

    // "Still working" timeout
    const stillWorkingTimeout = setTimeout(() => {
      this.bot.sendMessage(chatId, `Still working on your request...`).catch(() => {});
    }, 120000);

    try {
      // Telegram-specific: streaming message edits
      let streamMsgId: number | null = null;
      let streamBuffer = '';
      let lastEditTime = 0;
      // We need the effective tab name for the stream prefix, but it's determined
      // inside the pipeline. Use a mutable ref that the pipeline result will fill.
      let effectiveTabForStream = overrideTabName || tabName;

      const onTextChunk = async (chunk: string) => {
        streamBuffer += chunk;
        const now = Date.now();
        if (streamBuffer.length < 100 || now - lastEditTime < 1000) return;
        lastEditTime = now;
        try {
          const truncated = streamBuffer.slice(0, 4000) + (streamBuffer.length > 4000 ? '...' : '');
          const preview = formatTabbedResponse(truncated, effectiveTabForStream);
          if (!streamMsgId) {
            const sent = await this.bot.sendMessage(chatId, preview);
            streamMsgId = sent.message_id;
          } else {
            await this.bot.editMessageText(preview, { chat_id: chatId, message_id: streamMsgId });
          }
        } catch {
          /* edit failures are non-critical */
        }
      };

      // Shared pipeline handles: routing, media prompt, progress, sendMessage, TTS
      const pipelineResult = await processInboundMessage({
        text,
        media,
        channelId: 'telegram',
        tabManager: this.ctx.tabManager,
        voiceReplyMode: this.ctx.config.voice?.replyMode,
        ttsProvider: this.voice.tts,
        userId: String(chatId),
        sendProgress: (msg) => {
          this.bot.sendMessage(chatId, msg).catch(() => {});
        },
        overrideTabName,
        onTextChunk,
      });

      // Empty result means no prompt and no media
      if (!pipelineResult.responseText) {
        clearInterval(typingInterval);
        clearTimeout(stillWorkingTimeout);
        return;
      }

      // Update the effective tab for stream prefix (now known)
      effectiveTabForStream = pipelineResult.tabName;
      const responseText = pipelineResult.responseText;
      const responseError = pipelineResult.isError;
      const responseTab = pipelineResult.tabName;

      // Telegram-specific: if streaming was active and no error, edit the final message
      if (streamMsgId && !responseError) {
        clearInterval(typingInterval);
        clearTimeout(stillWorkingTimeout);
        await this.setReaction(chatId, messageId, '✅');

        // Send voice if available (even with streaming)
        if (pipelineResult.audioPath) {
          await this.bot.sendVoice(chatId, pipelineResult.audioPath);
          if (pipelineResult.voiceOnly) return;
        }

        try {
          const finalText = formatTabbedResponse(responseText, responseTab);
          if (finalText.length <= this.maxMessageLength) {
            await this.bot.editMessageText(finalText, { chat_id: chatId, message_id: streamMsgId });
          } else {
            await this.sendResponse(chatId, responseText, responseTab);
          }
        } catch {
          await this.sendResponse(chatId, responseText, responseTab);
        }
        return;
      }

      // Send voice reply if TTS generated audio (non-streaming path)
      if (pipelineResult.audioPath) {
        clearInterval(typingInterval);
        clearTimeout(stillWorkingTimeout);
        await this.setReaction(chatId, messageId, responseError ? '❌' : '✅');
        await this.bot.sendVoice(chatId, pipelineResult.audioPath);
        if (pipelineResult.voiceOnly) return;
        if (!responseError) {
          await this.sendResponse(chatId, responseText, responseTab);
          return;
        }
      }

      clearInterval(typingInterval);
      clearTimeout(stillWorkingTimeout);

      if (responseError) {
        await this.setReaction(chatId, messageId, '❌');
        await this.sendResponse(chatId, responseText, responseTab);
        return;
      }

      await this.setReaction(chatId, messageId, '✅');
      await this.sendResponse(chatId, responseText, responseTab);
    } catch (err) {
      clearInterval(typingInterval);
      clearTimeout(stillWorkingTimeout);
      await this.setReaction(chatId, messageId, '❌');
      throw err;
    }
  }

  private async sendResponse(chatId: number, text: string, tabName?: string): Promise<void> {
    const fullText = formatTabbedResponse(text, tabName);
    const chunks = chunkText(fullText);

    // Telegram-specific quirk: if the response would be >10 chunks, send a
    // preview + the rest as a file. This runs BEFORE sendChunkedResponse so the
    // helper is only invoked for normal-sized responses.
    if (chunks.length > 10) {
      for (let i = 0; i < 3; i++) {
        await this.sendWithRetry(chatId, chunks[i]);
      }
      const tmpPath = path.join(getLogsDir(), `response-${Date.now()}.txt`);
      fs.writeFileSync(tmpPath, fullText);
      await this.bot.sendDocument(chatId, tmpPath, {
        caption: `Full response (${chunks.length} chunks)`,
      });
      fs.unlinkSync(tmpPath);
      return;
    }

    // Use the shared chunked-send helper so prefix/chunk/retry logic stays
    // identical across Telegram/Discord/WhatsApp. Quirky per-chunk error
    // logging (delivery-failures.log) stays in sendWithRetry.
    await sendChunkedResponse({
      text,
      tabName,
      maxLength: this.maxMessageLength,
      retryLabel: 'telegram-send',
      sendChunk: (chunk) => this.sendWithRetryRaw(chatId, chunk),
    });
  }

  private async sendWithRetry(chatId: number, text: string): Promise<void> {
    // Wrapped call used by the >10-chunk fallback path. retryWithBackoff +
    // delivery-failures.log on permanent failure.
    try {
      await this.sendWithRetryRaw(chatId, text);
    } catch (err) {
      const failLog = path.join(getLogsDir(), 'delivery-failures.log');
      const sanitizedErr = sanitizeBotToken(err instanceof Error ? err.message : String(err));
      const entry = `[${new Date().toISOString()}] chatId=${chatId} error=${sanitizedErr} text=${text.slice(0, 200)}\n`;
      fs.appendFileSync(failLog, entry);
      logger.error(`Delivery failed after retries for chat ${chatId}`);
    }
  }

  private async sendWithRetryRaw(chatId: number, text: string): Promise<void> {
    await retryWithBackoff(
      // Send as plain text — Telegram's legacy "Markdown" parser silently mangles
      // underscores/asterisks in Claude's responses (code identifiers, names),
      // and Beecork has no escaping pass for it.
      () => this.bot.sendMessage(chatId, text),
      [1000, 5000, 15000],
      'telegram-send',
    );
  }

  private async downloadTelegramFile(fileId: string, extension: string): Promise<string | null> {
    const fileInfo = await this.bot.getFile(fileId);
    if (!fileInfo.file_path) return null;

    // Check file size (Telegram provides file_size in bytes)
    if (fileInfo.file_size && isOversized(fileInfo.file_size)) {
      logger.warn(`Skipping oversized file: ${fileInfo.file_size} bytes`);
      return null;
    }

    const url = `https://api.telegram.org/file/bot${this.ctx.config.telegram.token}/${fileInfo.file_path}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    return saveMedia(buffer, extension, fileInfo.file_path.split('/').pop());
  }

  private isAllowed(userId: number | undefined): boolean {
    if (!userId) return false;
    // Set-based O(1) membership check; explicit empty-set check keeps the
    // fail-closed contract documented in code.
    if (this.allowedUserIdSet.size === 0) return false;
    return this.allowedUserIdSet.has(userId);
  }

  private isAdmin(userId: number | undefined): boolean {
    const cfg = this.ctx.config.telegram;
    return isChannelAdmin(cfg.allowedUserIds, userId, cfg.adminUserId);
  }

  private async setReaction(chatId: number, messageId: number, emoji: string): Promise<void> {
    try {
      const url = `https://api.telegram.org/bot${this.ctx.config.telegram.token}/setMessageReaction`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          reaction: [{ type: 'emoji', emoji }],
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Reactions not supported or failed — non-critical
    }
  }
}
