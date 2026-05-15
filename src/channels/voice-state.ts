import { initVoiceProviders } from '../voice/index.js';
import type { STTProvider } from '../voice/stt.js';
import type { TTSProvider } from '../voice/tts.js';
import type { VoiceConfig, BeecorkConfig } from '../types.js';
import type { MediaAttachment } from '../types.js';

/**
 * Per-channel STT/TTS state. Used to be duplicated across Telegram, WhatsApp,
 * and Discord; consolidated here so init + warmup + transcription happen the
 * same way across all 3.
 *
 * Discord historically only called warmup() and did NOT transcribe — preserve
 * that behavior unless the caller explicitly asks for transcription.
 */
export class VoiceState {
  stt: STTProvider | null = null;
  tts: TTSProvider | null = null;
  private warmedUp = false;

  constructor(private readonly channelId: string) {}

  init(config: BeecorkConfig | { voice?: VoiceConfig }): void {
    const { stt, tts } = initVoiceProviders(config.voice);
    this.stt = stt;
    this.tts = tts;
  }

  /** One-shot warmup (no media). Used by Discord today. */
  async warmup(): Promise<void> {
    if (this.warmedUp || !this.stt) return;
    try {
      this.stt.warmup?.();
    } catch {
      /* warmup is best-effort */
    }
    this.warmedUp = true;
  }

  /**
   * Transcribe voice attachments in-place (mutates the caption fields).
   * Returns the updated warmed-up flag. No-op if STT isn't configured.
   */
  async transcribe(media: MediaAttachment[]): Promise<void> {
    if (!this.stt) return;
    const { transcribeVoiceMessages } = await import('../voice/index.js');
    this.warmedUp = await transcribeVoiceMessages(media, this.stt, this.channelId, this.warmedUp);
  }
}
