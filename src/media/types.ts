export type MediaType = 'image' | 'video' | 'audio' | 'music';

export interface GenerateOptions {
  style?: string;
  model?: string;
  width?: number;
  height?: number;
  duration?: number;
  format?: string;
}

export interface GenerateResult {
  filePath: string;
  mimeType: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface MediaGenerator {
  readonly id: string;
  readonly name: string;
  readonly supportedTypes: MediaType[];
  generate(type: MediaType, prompt: string, options?: GenerateOptions): Promise<GenerateResult>;
}

// ─── Shared API response shapes for media generators ───
// Pulled here so multiple generators (lyria, nano-banana, recraft, etc.) can
// share the same response interface instead of each casting to `any`.

/** Gemini `:generateContent` response shape (used by lyria + nano-banana). */
export interface GeminiInlineDataPart {
  inlineData?: { mimeType?: string; data: string };
}
export interface GeminiCandidate {
  content?: { parts?: GeminiInlineDataPart[] };
}
export interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[];
}

/** Recraft `/v1/images/generations` response. */
export interface RecraftGenerateResponse {
  data?: Array<{ url?: string; b64_json?: string }>;
}
