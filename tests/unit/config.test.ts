import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateTabName, getTabConfig, resolveWorkingDir } from '../../src/config.js';
import { isChannelAdmin } from '../../src/channels/admin.js';

// Mock fs and paths so getConfig doesn't hit the real filesystem
vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false), // no config file → use defaults
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
  },
}));

vi.mock('../../src/util/paths.js', () => ({
  getConfigPath: () => '/tmp/test-config.json',
  expandHome: (p: string) => p.replace('~', '/home/test'),
  getBeecorkHome: () => '/tmp/.beecork',
}));

describe('Config', () => {
  describe('validateTabName', () => {
    it('should accept valid names', () => {
      expect(validateTabName('research')).toBeNull();
      expect(validateTabName('my-task')).toBeNull();
      expect(validateTabName('deploy-123')).toBeNull();
      expect(validateTabName('a')).toBeNull();
    });

    it('should reject "default" (reserved)', () => {
      expect(validateTabName('default')).toContain('reserved');
    });

    it('should reject "cron:" prefix (reserved)', () => {
      expect(validateTabName('cron:morning')).toContain('reserved');
    });

    it('should reject names with special characters', () => {
      expect(validateTabName('my tab')).not.toBeNull();
      expect(validateTabName('my.tab')).not.toBeNull();
      expect(validateTabName('my/tab')).not.toBeNull();
    });

    it('should reject names over 32 characters', () => {
      expect(validateTabName('a'.repeat(33))).not.toBeNull();
    });

    it('should accept names at exactly 32 characters', () => {
      expect(validateTabName('a'.repeat(32))).toBeNull();
    });

    it('should reject empty names', () => {
      expect(validateTabName('')).not.toBeNull();
    });
  });

  describe('getTabConfig', () => {
    it('should return default config for unknown tab', () => {
      const config = getTabConfig('nonexistent');
      expect(config.workingDir).toBeDefined();
    });

    it('should return default tab config for "default"', () => {
      const config = getTabConfig('default');
      expect(config.workingDir).toBeDefined();
    });
  });

  describe('resolveWorkingDir', () => {
    it('should expand ~ in working dir path', () => {
      const dir = resolveWorkingDir('default');
      // expandHome is mocked to replace ~ with /home/test
      expect(dir).not.toContain('~');
    });
  });

  describe('isChannelAdmin', () => {
    it('returns false when allowlist is empty', () => {
      expect(isChannelAdmin([], 'user-1')).toBe(false);
    });
    it('returns true for the first allowed peer when no explicit admin', () => {
      expect(isChannelAdmin(['alice', 'bob'], 'alice')).toBe(true);
      expect(isChannelAdmin(['alice', 'bob'], 'bob')).toBe(false);
    });
    it('respects an explicit admin override', () => {
      expect(isChannelAdmin(['alice', 'bob'], 'bob', 'bob')).toBe(true);
      expect(isChannelAdmin(['alice', 'bob'], 'alice', 'bob')).toBe(false);
    });
    it('compares as strings (handles number IDs)', () => {
      expect(isChannelAdmin([123, 456], 123)).toBe(true);
      expect(isChannelAdmin([123, 456], '123')).toBe(true);
    });
  });
});
