import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfigPath, expandHome } from './util/paths.js';
import { logger } from './util/logger.js';
import type { BeecorkConfig, TabConfig } from './types.js';

const DEFAULT_TAB_CONFIG: TabConfig = {
  workingDir: os.homedir(),
};

const DEFAULT_PROJECT_SCAN_PATHS = ['~/Coding', '~/Projects', '~/code', '~/dev'];

/**
 * INTENTIONAL: --dangerously-skip-permissions is required for unattended operation.
 * Without it, Claude Code would block on every tool call waiting for user input.
 * Users can override defaultFlags in ~/.beecork-pipe/config.json.
 */
const DEFAULT_CONFIG: BeecorkConfig = {
  telegram: {
    token: '',
    allowedUserIds: [],
  },
  claudeCode: {
    bin: 'claude',
    defaultFlags: ['--dangerously-skip-permissions'],
  },
  tabs: {
    default: { ...DEFAULT_TAB_CONFIG },
  },
  memory: {
    dbPath: '~/.beecork-pipe/memory.db',
  },
  projectScanPaths: [...DEFAULT_PROJECT_SCAN_PATHS],
  deployment: 'local',
};

let cachedConfig: BeecorkConfig | null = null;

export function getConfig(): BeecorkConfig {
  if (cachedConfig) return cachedConfig;

  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    cachedConfig = mergeWithDefaults(raw);
    return cachedConfig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A corrupt config silently degrading to defaults means the daemon starts
    // with every channel dead. Surface it in daemon.log (logger also writes to
    // stderr, so this still shows during early startup).
    logger.error(
      `Failed to parse config file ${configPath}: ${msg} — starting with DEFAULT config (all channels disabled until fixed)`,
    );
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: BeecorkConfig): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  // Owner-only mode set atomically with the write so there's no world-readable window.
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  cachedConfig = config;
}

export function getTabConfig(tabName: string): TabConfig {
  const config = getConfig();
  return config.tabs[tabName] ?? { ...DEFAULT_TAB_CONFIG };
}

export function resolveWorkingDir(tabName: string): string {
  const tabConfig = getTabConfig(tabName);
  return expandHome(tabConfig.workingDir);
}

const TAB_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,31}$/;

export function validateTabName(name: string): string | null {
  if (name === 'default') return 'Tab name "default" is reserved';
  if (name.startsWith('cron:')) return 'Tab names starting with "cron:" are reserved';
  if (!TAB_NAME_REGEX.test(name)) return 'Tab name must be alphanumeric + hyphens, max 32 chars';
  return null; // valid
}

/**
 * Like validateTabName but allows the literal name "default" (used by send/update
 * endpoints that reference an existing tab rather than creating one).
 */
export function validateTabNameOrDefault(name: string): string | null {
  if (name === 'default') return null;
  return validateTabName(name);
}

function mergeWithDefaults(raw: Partial<BeecorkConfig>): BeecorkConfig {
  // Spread raw first so any future optional fields round-trip through saveConfig
  // without needing to be enumerated here. Specific sections that need defaults
  // get merged below.
  return {
    ...raw,
    telegram: {
      ...DEFAULT_CONFIG.telegram,
      ...raw.telegram,
    },
    claudeCode: {
      ...DEFAULT_CONFIG.claudeCode,
      ...raw.claudeCode,
    },
    tabs: {
      default: { ...DEFAULT_TAB_CONFIG },
      ...Object.fromEntries(
        Object.entries(raw.tabs ?? {}).map(([k, v]) => [k, { ...DEFAULT_TAB_CONFIG, ...v }]),
      ),
    },
    memory: {
      ...DEFAULT_CONFIG.memory,
      ...raw.memory,
    },
    // Fall back to legacy pipe.projectScanPaths so old configs keep working
    projectScanPaths: raw.projectScanPaths ??
      (raw as { pipe?: { projectScanPaths?: string[] } }).pipe?.projectScanPaths ?? [
        ...DEFAULT_PROJECT_SCAN_PATHS,
      ],
    deployment: raw.deployment ?? DEFAULT_CONFIG.deployment,
  };
}
