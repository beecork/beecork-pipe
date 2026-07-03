import fs from 'node:fs';
import { getPidPath } from './paths.js';

/**
 * Return the daemon's live PID, or null if not running. Clears a stale PID file.
 * Lives in util/ (not cli/) so non-CLI callers like the dashboard don't have to
 * reach up into the CLI layer.
 */
export function getDaemonPid(): number | null {
  const pidPath = getPidPath();
  if (!fs.existsSync(pidPath)) return null;
  const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
  if (isNaN(pid)) return null;

  // Check if process is actually running
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    // Stale PID file
    fs.unlinkSync(pidPath);
    return null;
  }
}
