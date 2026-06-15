import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
  },
}));

vi.mock('../../src/util/paths.js', () => ({
  getMcpConfigPath: () => '/tmp/.beecork/mcp.json',
}));

vi.mock('../../src/util/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('uuid', () => ({
  v4: vi.fn().mockReturnValue('test-uuid-1234'),
}));

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { ClaudeSubprocess, _resetMcpConfigExistsCacheForTests } from '../../src/session/subprocess.js';
import type { BeecorkConfig } from '../../src/types.js';

const mockConfig: BeecorkConfig = {
  telegram: { token: '', allowedUserIds: [] },
  claudeCode: { bin: 'claude', defaultFlags: ['--dangerously-skip-permissions'] },
  tabs: { default: { workingDir: '/tmp' } },
  memory: { dbPath: '/tmp/test.db', maxLongTermEntries: 1000 },
  pipe: {
    enabled: false,
    anthropicApiKey: '',
    routingModel: 'claude-haiku-4-5-20251001',
    confidenceThreshold: 0.75,
    projectScanPaths: [],
  },
  deployment: 'local',
};

function makeMockProc() {
  const proc = {
    pid: 12345,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  };
  vi.mocked(spawn).mockReturnValue(proc as any);
  return proc;
}

describe('ClaudeSubprocess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Subprocess caches the mcp-config existsSync result for production
    // hot-path use; tests need to reset it between cases that flip the mock.
    _resetMcpConfigExistsCacheForTests();
  });

  it('should generate a session ID when none provided', () => {
    const sub = new ClaudeSubprocess('test', '/tmp', mockConfig);
    expect(sub.sessionId).toBe('test-uuid-1234');
  });

  it('should use provided session ID', () => {
    const sub = new ClaudeSubprocess('test', '/tmp', mockConfig, 'custom-id');
    expect(sub.sessionId).toBe('custom-id');
  });

  it('should include standard flags in spawn args', async () => {
    const proc = makeMockProc();
    const sub = new ClaudeSubprocess('test', '/tmp', mockConfig);

    await sub.send('hello', { onEvent: vi.fn(), onExit: vi.fn(), onError: vi.fn() });

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('hello'); // prompt at the end
  });

  it('should include --session-id on fresh session', async () => {
    makeMockProc();
    const sub = new ClaudeSubprocess('test', '/tmp', mockConfig);
    await sub.send('hello', { onEvent: vi.fn(), onExit: vi.fn(), onError: vi.fn() });

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toContain('--session-id');
    expect(args).toContain('test-uuid-1234');
    expect(args).not.toContain('--resume');
  });

  it('should include --resume on resume', async () => {
    makeMockProc();
    const sub = new ClaudeSubprocess('test', '/tmp', mockConfig, 'session-abc');
    await sub.send('continue', { onEvent: vi.fn(), onExit: vi.fn(), onError: vi.fn() }, true);

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toContain('--resume');
    expect(args).toContain('session-abc');
    expect(args).not.toContain('--session-id');
  });

  it('should include --system-prompt on fresh session', async () => {
    makeMockProc();
    const sub = new ClaudeSubprocess('test', '/tmp', mockConfig);
    await sub.send('hello', { onEvent: vi.fn(), onExit: vi.fn(), onError: vi.fn() });

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toContain('--system-prompt');
    // System prompt should contain Beecork context
    const promptIdx = args.indexOf('--system-prompt') + 1;
    expect(args[promptIdx]).toContain('Beecork');
  });

  it('should NOT include --system-prompt on resume', async () => {
    makeMockProc();
    const sub = new ClaudeSubprocess('test', '/tmp', mockConfig);
    await sub.send('hello', { onEvent: vi.fn(), onExit: vi.fn(), onError: vi.fn() }, true);

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).not.toContain('--system-prompt');
  });

  it('should include tab-specific system prompt', async () => {
    makeMockProc();
    const sub = new ClaudeSubprocess('test', '/tmp', mockConfig, undefined, 'You are a code reviewer');
    await sub.send('hello', { onEvent: vi.fn(), onExit: vi.fn(), onError: vi.fn() });

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    const promptIdx = args.indexOf('--system-prompt') + 1;
    expect(args[promptIdx]).toContain('You are a code reviewer');
    expect(args[promptIdx]).toContain('test'); // tab name
  });

  it('should include --mcp-config when file exists', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    makeMockProc();
    const sub = new ClaudeSubprocess('test', '/tmp', mockConfig);
    await sub.send('hello', { onEvent: vi.fn(), onExit: vi.fn(), onError: vi.fn() });

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toContain('--mcp-config');
    expect(args).toContain('/tmp/.beecork/mcp.json');
  });

  it('should NOT include --mcp-config when file does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    makeMockProc();
    const sub = new ClaudeSubprocess('test', '/tmp', mockConfig);
    await sub.send('hello', { onEvent: vi.fn(), onExit: vi.fn(), onError: vi.fn() });

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).not.toContain('--mcp-config');
  });

  it('should include --computer-use when configured', async () => {
    makeMockProc();
    const config = { ...mockConfig, claudeCode: { ...mockConfig.claudeCode, computerUse: true } };
    const sub = new ClaudeSubprocess('test', '/tmp', config);
    await sub.send('hello', { onEvent: vi.fn(), onExit: vi.fn(), onError: vi.fn() });

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toContain('--computer-use');
  });

  it('should include --max-budget-usd when configured', async () => {
    makeMockProc();
    const config = { ...mockConfig, claudeCode: { ...mockConfig.claudeCode, maxBudgetUsd: 5 } };
    const sub = new ClaudeSubprocess('test', '/tmp', config);
    await sub.send('hello', { onEvent: vi.fn(), onExit: vi.fn(), onError: vi.fn() });

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toContain('--max-budget-usd');
    expect(args).toContain('5');
  });

  it('should throw on double-send', async () => {
    makeMockProc();
    const sub = new ClaudeSubprocess('test', '/tmp', mockConfig);
    await sub.send('first', { onEvent: vi.fn(), onExit: vi.fn(), onError: vi.fn() });

    await expect(
      sub.send('second', { onEvent: vi.fn(), onExit: vi.fn(), onError: vi.fn() })
    ).rejects.toThrow('already running');
  });

  it('should report isRunning correctly', async () => {
    makeMockProc();
    const sub = new ClaudeSubprocess('test', '/tmp', mockConfig);
    expect(sub.isRunning).toBe(false);

    await sub.send('hello', { onEvent: vi.fn(), onExit: vi.fn(), onError: vi.fn() });
    expect(sub.isRunning).toBe(true);
  });

  it('should kill process with SIGTERM', async () => {
    const proc = makeMockProc();
    const sub = new ClaudeSubprocess('test', '/tmp', mockConfig);
    await sub.send('hello', { onEvent: vi.fn(), onExit: vi.fn(), onError: vi.fn() });

    sub.kill();
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  describe('startup watchdog', () => {
    // Pull a handler registered via proc.<emitter>.on(event, fn) back out of the
    // mock so tests can drive stdout/exit like the real child process would.
    function handlerFor(emitter: { on: ReturnType<typeof vi.fn> }, event: string) {
      const call = emitter.on.mock.calls.find((c) => c[0] === event);
      return call?.[1] as ((arg?: unknown) => void) | undefined;
    }

    it('kills the subprocess and sets killReason after silentTimeoutMs of zero output', async () => {
      vi.useFakeTimers();
      try {
        const proc = makeMockProc();
        const config = {
          ...mockConfig,
          claudeCode: { ...mockConfig.claudeCode, silentTimeoutMs: 2000 },
        };
        const sub = new ClaudeSubprocess('test', '/tmp', config);
        await sub.send('hello', { onEvent: vi.fn(), onExit: vi.fn(), onError: vi.fn() });

        expect(proc.kill).not.toHaveBeenCalled();
        vi.advanceTimersByTime(2000);

        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
        expect(sub.killReason).toBe('silent');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does NOT kill once the first event arrives — disarmed for good', async () => {
      vi.useFakeTimers();
      try {
        const proc = makeMockProc();
        const config = {
          ...mockConfig,
          claudeCode: { ...mockConfig.claudeCode, silentTimeoutMs: 2000 },
        };
        const onEvent = vi.fn();
        const sub = new ClaudeSubprocess('test', '/tmp', config);
        await sub.send('hello', { onEvent, onExit: vi.fn(), onError: vi.fn() });

        // First event arrives just before the deadline (claude initialized).
        vi.advanceTimersByTime(1999);
        const onData = handlerFor(proc.stdout, 'data')!;
        onData(Buffer.from(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n'));
        expect(onEvent).toHaveBeenCalledTimes(1);

        // Long-running tool: no further output for well past the threshold.
        vi.advanceTimersByTime(60_000);

        expect(proc.kill).not.toHaveBeenCalled();
        expect(sub.killReason).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears the startup timer on exit so it cannot fire afterwards', async () => {
      vi.useFakeTimers();
      try {
        const proc = makeMockProc();
        const config = {
          ...mockConfig,
          claudeCode: { ...mockConfig.claudeCode, silentTimeoutMs: 2000 },
        };
        const sub = new ClaudeSubprocess('test', '/tmp', config);
        await sub.send('hello', { onEvent: vi.fn(), onExit: vi.fn(), onError: vi.fn() });

        // Process exits quickly (e.g. auth error) before the watchdog deadline.
        handlerFor(proc, 'exit')!(1);
        vi.advanceTimersByTime(10_000);

        expect(proc.kill).not.toHaveBeenCalled();
        expect(sub.killReason).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not arm the watchdog when silentTimeoutMs is 0', async () => {
      vi.useFakeTimers();
      try {
        const proc = makeMockProc();
        const config = {
          ...mockConfig,
          claudeCode: { ...mockConfig.claudeCode, silentTimeoutMs: 0 },
        };
        const sub = new ClaudeSubprocess('test', '/tmp', config);
        await sub.send('hello', { onEvent: vi.fn(), onExit: vi.fn(), onError: vi.fn() });

        vi.advanceTimersByTime(10 * 60 * 1000);

        expect(proc.kill).not.toHaveBeenCalled();
        expect(sub.killReason).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
