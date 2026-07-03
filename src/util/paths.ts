import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Renamed from '.beecork' to '.beecork-pipe' when the pipe became `beecork-pipe`:
// the `beecork` name (and `~/.beecork`) now belongs to the beecork coding agent.
// Existing installs migrate their data dir as part of the rename; the BEECORK_HOME
// env override still wins for anyone pinning a custom location.
const BEECORK_DIR = '.beecork-pipe';

export function getBeecorkHome(): string {
  return process.env.BEECORK_HOME || path.join(os.homedir(), BEECORK_DIR);
}

export function getConfigPath(): string {
  return path.join(getBeecorkHome(), 'config.json');
}

export function getDbPath(): string {
  return path.join(getBeecorkHome(), 'memory.db');
}

export function getCrontabPath(): string {
  return path.join(getBeecorkHome(), 'crontab.json');
}

export function getMcpConfigPath(): string {
  return path.join(getBeecorkHome(), 'mcp-config.json');
}

export function getLogsDir(): string {
  return path.join(getBeecorkHome(), 'logs');
}

export function getPidPath(): string {
  return path.join(getBeecorkHome(), 'beecork.pid');
}

export function getRuntimeInfoPath(): string {
  return path.join(getBeecorkHome(), 'runtime.json');
}

export function getCronReloadSignalPath(): string {
  return path.join(getBeecorkHome(), '.cron-reload');
}

export function getWatcherReloadSignalPath(): string {
  return path.join(getBeecorkHome(), '.watcher-reload');
}

export function getWhatsappSessionPath(): string {
  return path.join(getBeecorkHome(), 'whatsapp-session');
}

export function ensureBeecorkDirs(): void {
  const home = getBeecorkHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // Upgrade an existing dir that was created with a looser umask before this fix landed.
  try {
    fs.chmodSync(home, 0o700);
  } catch {
    /* not fatal if mode change fails */
  }
  fs.mkdirSync(getLogsDir(), { recursive: true, mode: 0o700 });
}

export function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * True if `dir` resolves to (or under) one of `roots`. Single source of truth
 * for the "must be under an allowed root" check shared by the dashboard tab
 * allowlist and the project-creation allowlist — the `+ path.sep` guard prevents
 * a sibling like `/home/user-evil` from matching root `/home/user`.
 */
export function isPathWithinRoots(dir: string, roots: Array<string | undefined | null>): boolean {
  const resolved = path.resolve(expandHome(dir));
  return roots
    .filter((r): r is string => typeof r === 'string' && r.length > 0)
    .map((r) => path.resolve(expandHome(r)))
    .some((root) => resolved === root || resolved.startsWith(root + path.sep));
}
