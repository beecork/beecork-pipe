import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { SubprocessCallbacks } from '../../src/session/subprocess.js';

let testDb: Database.Database;

vi.mock('../../src/db/index.js', () => ({
  getDb: () => testDb,
}));

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
let sendScript: Array<(c: SubprocessCallbacks, sessionId: string) => void> = [];

vi.mock('../../src/session/subprocess.js', () => {
  class FakeSubprocess {
    sessionId: string;
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
      setTimeout(() => { this._running = false; script(callbacks, this.sessionId); }, 0);
    }
    kill() { this._running = false; }
    get isRunning() { return this._running; }
    get pid() { return 12345; }
  }
  return { ClaudeSubprocess: FakeSubprocess };
});

import { TabManager } from '../../src/session/manager.js';
import type { BeecorkConfig } from '../../src/types.js';

const TABS_SCHEMA = `
  CREATE TABLE tabs (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle',
    working_dir TEXT NOT NULL,
    pid INTEGER,
    system_prompt TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_activity_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tab_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    cost_usd REAL,
    tokens_in INTEGER,
    tokens_out INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE pending_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tab_name TEXT NOT NULL,
    message TEXT NOT NULL,
    type TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed INTEGER NOT NULL DEFAULT 0
  );
`;

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

describe('TabManager — stale-session retry', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(TABS_SCHEMA);
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
