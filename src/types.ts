// ─── Config ───

export interface TelegramConfig {
  token: string;
  allowedUserIds: number[];
  adminUserId?: number; // Defaults to allowedUserIds[0]
}

export interface ClaudeCodeConfig {
  bin: string;
  defaultFlags: string[];
  maxBudgetUsd?: number;
  computerUse?: boolean;
  /** Hard timeout per subprocess turn. Default 30 min. Set to 0 to disable. */
  maxRuntimeMs?: number;
  /**
   * Startup watchdog: kill (and retry once) a subprocess that produces ZERO
   * events this long after spawn. A healthy claude emits its init event within
   * seconds; prolonged total silence means it wedged on a stalled network
   * socket (DNS/connection blip with no client-side timeout). Default 2 min.
   * Set to 0 to disable. Disarms on the first event, so it never fires
   * mid-task — long-running tools are unaffected.
   */
  silentTimeoutMs?: number;
}

export interface MemoryConfig {
  dbPath: string;
}

export interface TabConfig {
  workingDir: string;
}

export interface TabTemplate {
  workingDir?: string;
  systemPrompt?: string;
}

export interface WhatsAppConfig {
  enabled: boolean;
  mode: 'baileys';
  sessionPath: string;
  allowedNumbers: string[];
  /** Optional admin phone number. Defaults to allowedNumbers[0]. */
  adminNumber?: string;
}

export interface VoiceConfig {
  sttProvider: 'whisper-api' | 'none';
  sttApiKey?: string;
  ttsProvider: 'openai' | 'elevenlabs' | 'none';
  ttsApiKey?: string;
  ttsVoice?: string;
  replyMode: 'text' | 'voice' | 'both';
}

export interface DiscordConfig {
  token: string;
  allowedUserIds?: string[];
  /** Optional admin user ID. Defaults to allowedUserIds[0]. */
  adminUserId?: string;
}

/**
 * Webhook channel auth semantics:
 *
 * - When both `authToken` and `hmacSecret` are configured, EITHER mode
 *   satisfies authentication (OR semantics). A valid Bearer token is enough
 *   even if the HMAC signature is missing. There is no AND mode today.
 * - Replay protection is NOT implemented. Callers must keep their payloads
 *   idempotent — see L10 in the audit. Acceptable while the server binds to
 *   127.0.0.1 only; revisit if remote exposure becomes a thing.
 * - `allowUnauthLocalhost` is the explicit opt-in to run with no auth at all.
 *   Useful for `curl localhost` from a trusted shell, but on a multi-user
 *   host any local process can inject prompts into your tabs.
 */
export interface WebhookConfig {
  enabled: boolean;
  port: number;
  authToken?: string;
  hmacSecret?: string;
  /** Set to true to skip the fail-secure auth check at start. NOT recommended on shared hosts. */
  allowUnauthLocalhost?: boolean;
}

export interface GroupConfig {
  activationMode: 'mention' | 'reply' | 'keyword' | 'always';
  maxResponsesPerMinute: number;
  tabPerGroup: boolean;
  keywords?: string[];
}

/**
 * Discriminated union of notification provider configs. The `type` field
 * narrows which fields are required so callers get full type safety instead
 * of treating every field as optional. createNotificationProvider switches
 * exhaustively on `type`.
 */
export type NotificationConfig =
  | { type: 'pushover'; userKey: string; appToken: string }
  | { type: 'ntfy'; topic: string; server?: string }
  | { type: 'webhook'; url: string; headers?: Record<string, string> };

export interface MediaGeneratorConfig {
  provider: string;
  apiKey?: string;
  model?: string;
  style?: string;
}

/** A media file attached to a message. Shared by channels + util/text + media. */
export interface MediaAttachment {
  type: 'image' | 'audio' | 'video' | 'document' | 'voice';
  mimeType: string;
  filePath: string;
  fileName?: string;
  caption?: string;
}

export interface BeecorkConfig {
  telegram: TelegramConfig;
  whatsapp?: WhatsAppConfig;
  webhook?: WebhookConfig;
  discord?: DiscordConfig;
  claudeCode: ClaudeCodeConfig;
  tabs: Record<string, TabConfig>;
  tabTemplates?: Record<string, TabTemplate>;
  memory: MemoryConfig;
  /** Directories to scan for projects on startup (defaults to ~/Coding, ~/Projects, etc.) */
  projectScanPaths: string[];
  voice?: VoiceConfig;
  groups?: GroupConfig;
  notifications?: NotificationConfig[];
  mediaGenerators?: MediaGeneratorConfig[];
  communityChannels?: string[];
  /** Capability packs enabled via `beecork-pipe capabilities enable`. Owned by src/capabilities. */
  capabilities?: import('./capabilities/types.js').EnabledCapability[];
  deployment: 'local' | 'vps';
}

// ─── Tab State ───

export type TabStatus = 'idle' | 'running' | 'error' | 'stopped';

export interface Tab {
  id: string;
  name: string;
  sessionId: string;
  status: TabStatus;
  workingDir: string;
  createdAt: string;
  lastActivityAt: string;
  pid: number | null;
  systemPrompt: string | null;
}

// ─── Stream JSON Types (from claude CLI --output-format=stream-json) ��──

export interface StreamInit {
  type: 'system';
  subtype: 'init';
  session_id: string;
  tools: string[];
  mcp_servers: string[];
  model: string;
}

export interface StreamContentText {
  type: 'text';
  text: string;
}

export interface StreamContentToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface StreamContentToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export type StreamContentBlock = StreamContentText | StreamContentToolUse | StreamContentToolResult;

export interface StreamAssistant {
  type: 'assistant';
  message: {
    id: string;
    role: 'assistant';
    content: StreamContentBlock[];
    stop_reason: string;
    usage: StreamUsage;
  };
  session_id: string;
}

export interface StreamResult {
  type: 'result';
  subtype: 'success' | 'error' | 'error_during_execution';
  is_error: boolean;
  duration_ms: number;
  // Present on success; absent on error_during_execution (CLI emits errors[] instead).
  result?: string;
  errors?: string[];
  session_id: string;
  total_cost_usd?: number;
  usage?: StreamUsage;
}

export interface StreamUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export type StreamEvent = StreamInit | StreamAssistant | StreamResult;

// ─── Tasks (formerly Cron) ───

export type TaskScheduleType = 'at' | 'every' | 'cron';

export type TaskPayloadType = 'agentTurn' | 'systemEvent';

export interface Task {
  id: string;
  name: string;
  scheduleType: TaskScheduleType;
  schedule: string;
  tabName: string;
  message: string;
  payloadType: TaskPayloadType;
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

// ─── Memory ───

export interface Memory {
  id: number;
  content: string;
  tabName: string | null;
  createdAt: string;
  source: 'tool' | 'auto';
}

// ─── Circuit Breaker ───

export interface CircuitBreakerConfig {
  maxRepeats: number;
  windowSize: number;
}

// Channel interface: see src/channels/types.ts
