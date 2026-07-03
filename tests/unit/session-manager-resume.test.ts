import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { SubprocessCallbacks } from '../../src/session/subprocess.js';

let testDb: Database.Database;

// Preserve the real module (so SCHEMA/runMigrations build the true schema) but
// point getDb at the in-memory test DB.
vi.mock('../../src/db/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/db/index.js')>();
  return { ...orig, getDb: () => testDb };
});

vi.mock('../../src/util/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/util/paths.js', () => ({
  getMcpConfigPath: () => '/tmp/mcp.json',
  getBeecorkHome: () => '/tmp/.beecork',
  getLogsDir: () => '/tmp/.beecork/logs',
}));

vi.mock('../../src/timeline/index.js', () => ({
  logActivity: vi.fn(),
}));

vi.mock('../../src/knowledge/index.js', () => ({
  getAllKnowledge: () => null,
  formatKnowledgeForContext: () => '',
}));

// Capture each ClaudeSubprocess construction + send so the test can drive callbacks
// and inspect the resume flag per invocation.
type SendCall = { resume: boolean; sessionId: string; prompt: string; callbacks: SubprocessCallbacks };
const sendCalls: SendCall[] = [];
interface FakeSelf { sessionId: string; killReason: 'silent' | null }
let sendScript: Array<(c: SubprocessCallbacks, sessionId: string, self: FakeSelf) => void> = [];

vi.mock('../../src/session/subprocess.js', () => {
  class FakeSubprocess {
    sessionId: string;
    killReason: 'silent' | null = null;
    private _running = false;
    constructor(_tab: string, _wd: string, _cfg: unknown, sessionId?: string) {
      this.sessionId = sessionId ?? 'fake-uuid';
    }
    async send(prompt: string, callbacks: SubprocessCallbacks, resume: boolean) {
      sendCalls.push({ resume, sessionId: this.sessionId, prompt, callbacks });
      this._running = true;
      const script = sendScript.shift();
      if (!script) throw new Error('No send script entry queued');
      // Drive asynchronously so the caller's Promise resolves first
      setTimeout(() => { this._running = false; script(callbacks, this.sessionId, this); }, 0);
    }
    kill() { this._running = false; }
    get isRunning() { return this._running; }
    get pid() { return 12345; }
  }
  return { ClaudeSubprocess: FakeSubprocess };
});

import { TabManager } from '../../src/session/manager.js';
import { SCHEMA } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrations.js';
import type { BeecorkConfig } from '../../src/types.js';

/** Build the real, fully-migrated schema (not a hand-copy that drifts). */
function initSchema(db: Database.Database): void {
  db.exec(SCHEMA);
  runMigrations(db);
}

const baseConfig: BeecorkConfig = {
  telegram: { token: '', allowedUserIds: [] },
  claudeCode: { bin: 'claude', defaultFlags: [] },
  tabs: { default: { workingDir: '/tmp' } },
  memory: { dbPath: ':memory:', maxLongTermEntries: 100 },
  projectScanPaths: [],
  deployment: 'local',
};

function emitSuccess(text: string) {
  return (cb: SubprocessCallbacks, sessionId: string) => {
    cb.onEvent({ type: 'system', subtype: 'init', session_id: sessionId, tools: [], mcp_servers: [], model: 'test' } as never);
    cb.onEvent({
      type: 'assistant',
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      session_id: sessionId,
    } as never);
    cb.onEvent({
      type: 'result', subtype: 'success', is_error: false, duration_ms: 1, result: text, session_id: sessionId, total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    } as never);
    cb.onExit(0);
  };
}

function emitStaleSessionError() {
  return (cb: SubprocessCallbacks, sessionId: string) => {
    cb.onEvent({
      type: 'result', subtype: 'error_during_execution', is_error: true,
      errors: [`No conversation found with session ID: ${sessionId}`],
      duration_ms: 1, session_id: sessionId,
    } as never);
    cb.onExit(1);
  };
}

// Models the startup watchdog firing: claude emitted ZERO events, the watchdog
// killed it with killReason='silent', and the process exits via SIGTERM (143).
function emitSilentStall() {
  return (cb: SubprocessCallbacks, _sessionId: string, self: FakeSelf) => {
    self.killReason = 'silent';
    cb.onExit(143);
  };
}

describe('TabManager — stale-session retry', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initSchema(testDb);
    sendCalls.length = 0;
    sendScript = [];
  });

  it('retries with a fresh session when --resume fails with "No conversation found"', async () => {
    // Seed a tab that already has an assistant message — so shouldResume=true on first call
    const tabId = 'tab-1';
    const staleSessionId = 'stale-uuid-001';
    testDb.prepare(
      'INSERT INTO tabs (id, name, session_id, status, working_dir, system_prompt) VALUES (?, ?, ?, ?, ?, NULL)'
    ).run(tabId, 'test', staleSessionId, 'idle', '/tmp');
    testDb.prepare('INSERT INTO messages (tab_id, role, content) VALUES (?, ?, ?)').run(tabId, 'assistant', 'prior real reply');

    sendScript = [emitStaleSessionError(), emitSuccess('recovered')];

    const mgr = new TabManager(baseConfig);
    const result = await mgr.sendMessage('test', 'hello');

    expect(sendCalls).toHaveLength(2);
    // First call: tried to resume the stale session
    expect(sendCalls[0].resume).toBe(true);
    expect(sendCalls[0].sessionId).toBe(staleSessionId);
    // Second call: forceFresh path — must use --session-id, not --resume
    expect(sendCalls[1].resume).toBe(false);
    expect(sendCalls[1].sessionId).not.toBe(staleSessionId);

    expect(result.text).toBe('recovered');
    expect(result.error).toBe(false);

    // The tab's session_id was rotated
    const tab = testDb.prepare('SELECT session_id FROM tabs WHERE id = ?').get(tabId) as { session_id: string };
    expect(tab.session_id).not.toBe(staleSessionId);
  });

  it('does not store empty assistant rows from failed runs', async () => {
    const tabId = 'tab-2';
    testDb.prepare(
      'INSERT INTO tabs (id, name, session_id, status, working_dir, system_prompt) VALUES (?, ?, ?, ?, ?, NULL)'
    ).run(tabId, 'test', 'sid-2', 'idle', '/tmp');

    // First call fails (no retry triggered because no prior assistant history -> shouldResume=false initially,
    // so we drive a non-stale error scenario): use a plain failure that wouldn't match stale-session detection.
    sendScript = [
      (cb, sessionId) => {
        cb.onEvent({
          type: 'result', subtype: 'error', is_error: true, duration_ms: 1, result: '', session_id: sessionId,
          total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        } as never);
        cb.onExit(1);
      },
    ];

    const mgr = new TabManager(baseConfig);
    const result = await mgr.sendMessage('test', 'hello');

    expect(result.error).toBe(true);
    const assistantRows = testDb.prepare(
      'SELECT COUNT(*) as count FROM messages WHERE tab_id = ? AND role = ?'
    ).get(tabId, 'assistant') as { count: number };
    expect(assistantRows.count).toBe(0);
  });

  it('ignores pre-existing empty assistant rows when deciding to resume', async () => {
    // Simulate a beecork installation already polluted by the old bug.
    const tabId = 'tab-3';
    const staleSessionId = 'stale-uuid-003';
    testDb.prepare(
      'INSERT INTO tabs (id, name, session_id, status, working_dir, system_prompt) VALUES (?, ?, ?, ?, ?, NULL)'
    ).run(tabId, 'test', staleSessionId, 'idle', '/tmp');
    // Pollution: empty assistant rows from prior failed runs
    for (let i = 0; i < 3; i++) {
      testDb.prepare('INSERT INTO messages (tab_id, role, content) VALUES (?, ?, ?)').run(tabId, 'assistant', '');
    }

    sendScript = [emitSuccess('clean fire')];

    const mgr = new TabManager(baseConfig);
    const result = await mgr.sendMessage('test', 'hello');

    // First call should be fresh (--session-id), not --resume, because pollution rows are filtered out
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].resume).toBe(false);
    expect(result.text).toBe('clean fire');
  });
});

describe('TabManager — silent-stall retry', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initSchema(testDb);
    sendCalls.length = 0;
    sendScript = [];
  });

  it('retries once when the first subprocess stalls silently, returning the retry result', async () => {
    const tabId = 'tab-silent-1';
    testDb.prepare(
      'INSERT INTO tabs (id, name, session_id, status, working_dir, system_prompt) VALUES (?, ?, ?, ?, ?, NULL)'
    ).run(tabId, 'test', 'sid-s1', 'idle', '/tmp');

    sendScript = [emitSilentStall(), emitSuccess('recovered after blip')];

    const mgr = new TabManager(baseConfig);
    const result = await mgr.sendMessage('test', 'hello');

    // Exactly one retry — two spawns total.
    expect(sendCalls).toHaveLength(2);
    expect(result.error).toBe(false);
    expect(result.text).toBe('recovered after blip');

    // The successful retry stores exactly one assistant row; the silent attempt stored none.
    const assistantRows = testDb.prepare(
      'SELECT COUNT(*) as count FROM messages WHERE tab_id = ? AND role = ?'
    ).get(tabId, 'assistant') as { count: number };
    expect(assistantRows.count).toBe(1);
  });

  it('does not retry past one silent stall — surfaces a network-stall failure', async () => {
    const tabId = 'tab-silent-2';
    testDb.prepare(
      'INSERT INTO tabs (id, name, session_id, status, working_dir, system_prompt) VALUES (?, ?, ?, ?, ?, NULL)'
    ).run(tabId, 'test', 'sid-s2', 'idle', '/tmp');

    sendScript = [emitSilentStall(), emitSilentStall()];

    const mgr = new TabManager(baseConfig);
    const result = await mgr.sendMessage('test', 'hello');

    // One retry only — no third spawn.
    expect(sendCalls).toHaveLength(2);
    expect(result.error).toBe(true);
    expect(result.text).toMatch(/network/i);

    // No assistant row is stored for a silent failure (keeps shouldResume false).
    const assistantRows = testDb.prepare(
      'SELECT COUNT(*) as count FROM messages WHERE tab_id = ? AND role = ?'
    ).get(tabId, 'assistant') as { count: number };
    expect(assistantRows.count).toBe(0);
  });
});
