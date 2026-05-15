import { spawn } from 'node:child_process';
import { getConfig } from '../config.js';
import { exportTab, formatHandoffInfo, type TabHandoffInfo } from '../session/handoff.js';

// Re-export the daemon-shared helpers so existing CLI callers keep working.
export { exportTab, formatHandoffInfo, type TabHandoffInfo };

/**
 * CLI-only flow: print the handoff info, spawn claude with `--resume`, and
 * inherit stdio so the user is dropped into an interactive session. Calls
 * `process.exit` on subprocess exit — only safe from the CLI entry point.
 */
export function attachTab(tabName: string): void {
  const info = exportTab(tabName);
  if (!info) {
    console.error(`Tab "${tabName}" not found.`);
    process.exit(1);
  }

  const config = getConfig();
  const bin = config.claudeCode?.bin || 'claude';

  console.log(`\nAttaching to tab "${info.name}"...`);
  console.log(`  Session: ${info.sessionId}`);
  console.log(`  Working dir: ${info.workingDir}`);
  console.log(`  Status: ${info.status}`);
  console.log('');

  // Spawn Claude Code in the terminal, resuming the session
  const child = spawn(bin, ['--session-id', info.sessionId, '--resume'], {
    cwd: info.workingDir,
    stdio: 'inherit', // Attach to terminal
    env: { ...process.env },
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}
