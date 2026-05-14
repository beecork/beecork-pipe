import fs from 'node:fs';
import {
  findInstallRoot,
  getDaemonScript,
  readRuntimeInfo,
  isPidAlive,
  getServiceUnitPath,
} from './install-info.js';

/**
 * Auto-heal install-path divergence between the CLI (this process) and the
 * running daemon. Triggered both from the npm postinstall hook and from the
 * CLI entry on every invocation — both paths converge here so the policy is
 * single-sourced and idempotent.
 *
 * What "divergence" means:
 *   The daemon's launchd plist (or systemd unit) hard-codes an absolute path
 *   to dist/daemon.js. If `npm install -g beecork@<new>` lands in a different
 *   npm prefix than the one the unit file points at, the daemon keeps running
 *   the old code while the CLI shows the new version. Bug reports get
 *   misdiagnosed because the user thinks both are on the new version.
 *
 * What this function does:
 *   1. Rewrite the unit file's daemon path if it doesn't point at us.
 *   2. SIGTERM the running daemon (KeepAlive / Restart=always brings it back
 *      on the new code) only when its runtime.json shows it was launched from
 *      a different install root than ours.
 *
 * Returns a Result describing what happened, for the caller to surface (or not)
 * to the user. The auto-heal NEVER throws — failures degrade to {action:'skip'}.
 */
export interface HealResult {
  action: 'noop' | 'rewrote-unit' | 'signaled-daemon' | 'rewrote-and-signaled' | 'skip';
  reason?: string;
  unitPath?: string;
  oldDaemonScript?: string;
  newDaemonScript?: string;
}

export function autoHealInstall(fromFileUrl: string): HealResult {
  try {
    const currentRoot = findInstallRoot(fromFileUrl);
    const currentDaemonScript = getDaemonScript(currentRoot);

    const unitPath = getServiceUnitPath();
    if (!unitPath || !fs.existsSync(unitPath)) {
      // No installed service — beecork has been npm-installed but `beecork setup` (or
      // equivalent) hasn't been run yet. Nothing to heal.
      return { action: 'skip', reason: 'no service unit file present' };
    }

    const unitContent = fs.readFileSync(unitPath, 'utf-8');
    const oldDaemonScript = extractDaemonScript(unitContent);

    let rewroteUnit = false;
    if (oldDaemonScript && oldDaemonScript !== currentDaemonScript) {
      // Validate the new path actually exists before rewriting — never break the daemon
      // by pointing it at a missing file.
      if (!fs.existsSync(currentDaemonScript)) {
        return { action: 'skip', reason: `current install missing daemon: ${currentDaemonScript}` };
      }
      const next = unitContent.split(oldDaemonScript).join(currentDaemonScript);
      const tmp = unitPath + '.tmp';
      fs.writeFileSync(tmp, next);
      fs.renameSync(tmp, unitPath);
      rewroteUnit = true;
    }

    // Restart the daemon if it's currently running from a stale install. This is
    // separate from the unit-file rewrite so we also catch the case where the unit
    // file is already current but the running process predates the latest install.
    const runtime = readRuntimeInfo();
    let signaledDaemon = false;
    if (runtime && runtime.installRoot !== currentRoot && isPidAlive(runtime.pid)) {
      try {
        process.kill(runtime.pid, 'SIGTERM');
        signaledDaemon = true;
      } catch {
        // Permission denied (different user, or already gone). Surface as skip;
        // we still rewrote the unit file so the next start picks up the new path.
      }
    }

    if (rewroteUnit && signaledDaemon) {
      return { action: 'rewrote-and-signaled', unitPath, oldDaemonScript: oldDaemonScript!, newDaemonScript: currentDaemonScript };
    }
    if (rewroteUnit) return { action: 'rewrote-unit', unitPath, oldDaemonScript: oldDaemonScript!, newDaemonScript: currentDaemonScript };
    if (signaledDaemon) return { action: 'signaled-daemon', unitPath };
    return { action: 'noop' };
  } catch (err) {
    return { action: 'skip', reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Extract the daemon-script absolute path from a launchd plist or systemd unit.
 * Returns null if the file shape isn't recognized — caller treats that as "skip".
 *
 * launchd: looks inside <key>ProgramArguments</key><array> for the .js entry.
 * systemd: looks for ExecStart=<node> <daemon.js> on a single line.
 */
export function extractDaemonScript(content: string): string | null {
  // launchd plist: pull the second <string> inside ProgramArguments
  const launchdMatch = content.match(/<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (launchdMatch) {
    const args = Array.from(launchdMatch[1].matchAll(/<string>([^<]+)<\/string>/g)).map(m => m[1]);
    const jsArg = args.find(a => a.endsWith('daemon.js'));
    if (jsArg) return jsArg;
  }
  // systemd unit: ExecStart=<node> <daemon.js> [args...]
  const systemdMatch = content.match(/^ExecStart\s*=\s*(.+)$/m);
  if (systemdMatch) {
    const parts = systemdMatch[1].split(/\s+/);
    const jsArg = parts.find(p => p.endsWith('daemon.js'));
    if (jsArg) return jsArg;
  }
  return null;
}

/** Rewrite-only variant used by tests and the postinstall hook in dry-run mode. */
export function rewriteUnitDaemonScript(unitPath: string, newDaemonScript: string): { rewrote: boolean; oldDaemonScript: string | null } {
  if (!fs.existsSync(unitPath)) return { rewrote: false, oldDaemonScript: null };
  const content = fs.readFileSync(unitPath, 'utf-8');
  const oldDaemonScript = extractDaemonScript(content);
  if (!oldDaemonScript) return { rewrote: false, oldDaemonScript: null };
  if (oldDaemonScript === newDaemonScript) return { rewrote: false, oldDaemonScript };
  const next = content.split(oldDaemonScript).join(newDaemonScript);
  const tmp = unitPath + '.tmp';
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, unitPath);
  return { rewrote: true, oldDaemonScript };
}
