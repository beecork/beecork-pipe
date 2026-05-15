import fs from 'node:fs';
import { logger } from '../util/logger.js';
import { saveMedia, isOversized } from '../media/store.js';
import { sendChunkedResponse } from './send-helpers.js';
import { inboundLimiter } from '../util/rate-limiter.js';
import { processInboundMessage } from './pipeline.js';
import { isChannelAdmin } from './admin.js';
import type { Channel, ChannelContext, InboundMessageHandler, MediaAttachment, SendOptions } from './types.js';
import { VoiceState } from './voice-state.js';

const WHATSAPP_MAX_LENGTH = 8192;

export class WhatsAppChannel implements Channel {
  readonly id = 'whatsapp';
  readonly name = 'WhatsApp';
  readonly maxMessageLength = WHATSAPP_MAX_LENGTH;
  readonly supportsStreaming = false;
  readonly supportsMedia = true;

  private sock: unknown = null;
  private ctx: ChannelContext;
  private allowedNumbers: Set<string>;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private readonly backoffDelays = [1000, 5000, 15000, 30000, 60000];
  private voice = new VoiceState('whatsapp');

  constructor(ctx: ChannelContext) {
    this.ctx = ctx;
    this.allowedNumbers = new Set(ctx.config.whatsapp?.allowedNumbers ?? []);
  }

  async start(): Promise<void> {
    // Initialize voice providers (STT + TTS)
    this.voice.init(this.ctx.config);

    try {
      const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion } = await import('@whiskeysockets/baileys');
      const sessionPath = this.ctx.config.whatsapp?.sessionPath ?? `${process.env.HOME}/.beecork/whatsapp-session`;
      fs.mkdirSync(sessionPath, { recursive: true, mode: 0o700 });

      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
      const pino = (await import('pino')).default;
      this.sock = makeWASocket({
        auth: state,
        version,
        logger: pino({ level: 'silent' }),
      });

      const sock = this.sock as any;

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          try {
            const qrcodeTerminal = await import('qrcode-terminal');
            (qrcodeTerminal.default || qrcodeTerminal).generate(qr, { small: true });
            logger.info('WhatsApp QR code displayed — scan with your phone');
          } catch {
            logger.warn('WhatsApp QR code available but could not render. Install qrcode-terminal.');
          }
        }
        if (connection === 'close') {
          const reason = (lastDisconnect?.error as any)?.output?.statusCode;
          if (reason !== DisconnectReason.loggedOut) {
            this.reconnectAttempts++;
            if (this.reconnectAttempts > this.maxReconnectAttempts) {
              logger.error(`WhatsApp reconnect failed after ${this.maxReconnectAttempts} attempts, giving up`);
              this.ctx.notifyCallback?.('⚠️ WhatsApp disconnected after 10 reconnection attempts. Restart daemon to reconnect.')
                .catch(err => logger.error('Failed to send WhatsApp disconnect notification:', err));
              return;
            }
            const delayIdx = Math.min(this.reconnectAttempts - 1, this.backoffDelays.length - 1);
            const delay = this.backoffDelays[delayIdx];
            logger.warn(`WhatsApp connection closed, reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            setTimeout(() => {
              this.start().catch(err => {
                logger.error('WhatsApp reconnect failed:', err);
              });
            }, delay);
          } else {
            logger.error('WhatsApp logged out. Please re-scan QR code.');
          }
        } else if (connection === 'open') {
          this.reconnectAttempts = 0;
          logger.info('WhatsApp connected');
        }
      });

      sock.ev.on('messages.upsert', async (m: any) => {
        const msg = m.messages[0];
        if (!msg?.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        if (!sender || !this.isAllowed(sender)) return;

        // Rate limit check
        if (!inboundLimiter.check(this.id)) {
          await sock.sendMessage(sender, { text: "I'm receiving too many messages right now. Please wait a moment." }).catch(() => {});
          return;
        }

        const text = msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption || '';

        // Download media (in parallel). Descriptor map collapses what used to be
        // 5 near-identical blocks into one loop. Each descriptor describes how to
        // extract a MediaAttachment from a specific Baileys variant.
        type WAMessage = Record<string, any>;
        interface WADescriptor {
          key: string;
          build: (m: WAMessage, buf: Buffer) => MediaAttachment | null;
        }
        const descriptors: WADescriptor[] = [
          {
            key: 'imageMessage',
            build: (m, buf) => ({
              type: 'image',
              mimeType: m.imageMessage.mimetype || 'image/jpeg',
              filePath: saveMedia(buf, 'jpg'),
            }),
          },
          {
            key: 'audioMessage',
            build: (m, buf) => {
              const ext = m.audioMessage.ptt ? 'ogg' : 'mp3';
              return {
                type: m.audioMessage.ptt ? 'voice' : 'audio',
                mimeType: m.audioMessage.mimetype || 'audio/ogg',
                filePath: saveMedia(buf, ext),
                duration: m.audioMessage.seconds ?? undefined,
              };
            },
          },
          {
            key: 'documentMessage',
            build: (m, buf) => {
              const ext = m.documentMessage.fileName?.split('.').pop() || 'bin';
              return {
                type: 'document',
                mimeType: m.documentMessage.mimetype || 'application/octet-stream',
                filePath: saveMedia(buf, ext, m.documentMessage.fileName ?? undefined),
                fileName: m.documentMessage.fileName ?? undefined,
              };
            },
          },
          {
            key: 'videoMessage',
            build: (m, buf) => ({
              type: 'video',
              mimeType: m.videoMessage.mimetype || 'video/mp4',
              filePath: saveMedia(buf, 'mp4'),
              duration: m.videoMessage.seconds ?? undefined,
            }),
          },
        ];
        const waDownloadTasks: Array<Promise<MediaAttachment | null>> = [];
        for (const d of descriptors) {
          if (!msg.message[d.key]) continue;
          waDownloadTasks.push(
            downloadMediaMessage(msg, 'buffer', {})
              .then((buffer: any) => {
                if (!buffer || isOversized(buffer.length)) return null;
                try { return d.build(msg.message, buffer as Buffer); } catch { return null; }
              })
              .catch(() => null)
          );
        }
        const waResults = await Promise.allSettled(waDownloadTasks);
        const media: MediaAttachment[] = waResults
          .filter((r): r is PromiseFulfilledResult<MediaAttachment | null> => r.status === 'fulfilled' && r.value !== null)
          .map(r => r.value!);

        // Transcribe voice messages if STT is configured
        await this.voice.transcribe(media);

        if (!text && media.length === 0) return;

        try {
          const waUserId = sender.replace('@s.whatsapp.net', '');

          // Shared command handler (covers /tabs, /stop, /projects, /project, /newproject, /close, /fresh, etc.)
          if (text.startsWith('/')) {
            const { handleSharedCommand } = await import('./command-handler.js');
            const cmdResult = await handleSharedCommand({
              userId: waUserId,
              text,
              isAdmin: isChannelAdmin(this.allowedNumbers, waUserId, this.ctx.config.whatsapp?.adminNumber),
              channelId: 'whatsapp',
            }, this.ctx.tabManager);
            if (cmdResult.handled) {
              if (cmdResult.response) await sock.sendMessage(sender, { text: cmdResult.response });
              return;
            }
          }

          await sock.sendPresenceUpdate('composing', sender).catch(() => {});

          // Shared message pipeline
          const pipelineResult = await processInboundMessage({
            text,
            media,
            channelId: 'whatsapp',
            tabManager: this.ctx.tabManager,
            voiceReplyMode: this.ctx.config.voice?.replyMode,
            ttsProvider: this.voice.tts,
            userId: waUserId,
            sendProgress: (msg) => {
              sock.sendMessage(sender, { text: msg }).catch(() => {});
            },
          });

          await sock.sendPresenceUpdate('paused', sender).catch(() => {});

          // Empty result means no prompt and no media
          if (!pipelineResult.responseText) return;

          // Send voice reply if TTS generated audio
          if (pipelineResult.audioPath) {
            await sock.sendMessage(sender, { audio: { url: pipelineResult.audioPath }, mimetype: 'audio/ogg; codecs=opus', ptt: true });
            if (pipelineResult.voiceOnly) return;
          }

          await this.sendResponse(sender, pipelineResult.responseText, pipelineResult.tabName);
        } catch (err) {
          logger.error('WhatsApp message handler error:', err);
          await sock.sendMessage(sender, { text: 'Something went wrong processing your message. Check daemon logs for details.' })
            .catch((sendErr: unknown) => logger.error('WhatsApp: failed to send fallback error message:', sendErr));
        }
      });
    } catch (err) {
      logger.error('Failed to start WhatsApp client:', err);
      throw err;
    }
  }

  stop(): void {
    const sock = this.sock as any;
    if (sock) {
      sock.end(undefined);
      this.sock = null;
    }
    logger.info('WhatsApp client stopped');
  }

  async sendMessage(peerId: string, text: string, _options?: SendOptions): Promise<void> {
    const sock = this.sock as any;
    if (!sock) return;
    await sendChunkedResponse({
      text,
      maxLength: WHATSAPP_MAX_LENGTH,
      retryLabel: 'whatsapp-send',
      sendChunk: chunk => sock.sendMessage(peerId, { text: chunk }),
    });
  }

  async sendNotification(message: string, _urgent?: boolean): Promise<void> {
    const sock = this.sock as any;
    if (!sock) return;
    for (const number of this.allowedNumbers) {
      try {
        await sock.sendMessage(`${number}@s.whatsapp.net`, { text: message });
      } catch (err) {
        logger.error(`Failed to send WhatsApp notification to ${number}:`, err);
      }
    }
  }

  async setTyping(peerId: string, active: boolean): Promise<void> {
    const sock = this.sock as any;
    if (!sock) return;
    const status = active ? 'composing' : 'paused';
    await sock.sendPresenceUpdate(status, peerId).catch(() => {});
  }

  onMessage(_handler: InboundMessageHandler): void {
    // Messages are handled directly in start()
  }

  // ─── Private ───

  private async sendResponse(jid: string, text: string, tabName?: string): Promise<void> {
    const sock = this.sock as any;
    try {
      await sendChunkedResponse({
        text,
        tabName,
        maxLength: WHATSAPP_MAX_LENGTH,
        retryLabel: 'whatsapp-send',
        sendChunk: chunk => sock.sendMessage(jid, { text: chunk }),
      });
    } catch (err) {
      logger.error(`WhatsApp delivery failed for ${jid}:`, err);
    }
  }

  private isAllowed(jid: string): boolean {
    if (this.allowedNumbers.size === 0) return false;
    const number = jid.replace('@s.whatsapp.net', '');
    return this.allowedNumbers.has(number);
  }
}
