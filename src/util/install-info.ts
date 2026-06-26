import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { getRuntimeInfoPath } from './paths.js';

/**
 * Metadata the daemon writes to ~/.beecork-pipe/runtime.json at startup so the CLI
 * (and postinstall hook) can detect when daemon and CLI are running from
 * different physical installs of beecork — the most common silent-staleness
 * mode after `npm install -g beecork-pipe@<new>` lands in a prefix the daemon's
 * launchd plist doesn't point at.
 */
export interface RuntimeInfo {
  pid: number;
  version: string;
  /** The package root: <prefix>/lib/node_modules/beecork-pipe. Single canonical key. */
  installRoot: string;
  /** Absolute path to dist/daemon.js — derived from installRoot. */
  daemonScript: string;
  /** ISO timestamp. */
  startedAt: string;
  /** process.version (e.g. "v20.11.0") */
  nodeVersion: string;
}

/**
 * Walk up from a given file (typically import.meta.url) to find the directory
 * containing package.json — i.e. the beecork install root. Works for both:
 *  - source dev runs (.../src/util/install-info.ts → .../ )
 *  - built/installed runs (.../dist/util/install-info.js → .../ )
 */
export function findInstallRoot(fromFileUrl: string): string {
  const fromPath = fileURLToPath(fromFileUrl);
  let dir = path.dirname(fromPath);
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate beecork install root walking up from ${fromPath}`);
}

export function getDaemonScript(installRoot: string): string {
  return path.join(installRoot, 'dist', 'daemon.js');
}

export function writeRuntimeInfo(info: RuntimeInfo): void {
  const filePath = getRuntimeInfoPath();
  // Atomic-ish write: temp + rename so a partial write never confuses a reader.
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2));
  fs.renameSync(tmp, filePath);
}

export function readRuntimeInfo(): RuntimeInfo | null {
  const filePath = getRuntimeInfoPath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (typeof data?.pid === 'number' && typeof data?.installRoot === 'string') {
      return data as RuntimeInfo;
    }
    return null;
  } catch {
    return null;
  }
}

export function removeRuntimeInfo(): void {
  const filePath = getRuntimeInfoPath();
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* not present, fine */
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cross-platform path to the service-manager unit file that launches the daemon.
 * Returns null if beecork doesn't manage one on this OS (currently Windows uses
 * Task Scheduler and is out of scope for the auto-heal flow).
 */
export function getServiceUnitPath(): string | null {
  const home = os.homedir();
  if (process.platform === 'darwin')
    return path.join(home, 'Library', 'LaunchAgents', 'com.beecork.daemon.plist');
  if (process.platform === 'linux')
    return path.join(home, '.config', 'systemd', 'user', 'beecork.service');
  return null;
}
