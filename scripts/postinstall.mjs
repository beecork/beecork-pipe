#!/usr/bin/env node
// Beecork postinstall hook.
//
// Runs after `npm install -g beecork-pipe[@<version>]`. Goal: if a beecork-pipe daemon
// is already managed by the OS (launchd plist on mac, systemd unit on linux)
// from a DIFFERENT install path than this freshly-installed one, rewrite the
// unit file to point at this install and signal the daemon to restart so the
// running process picks up the new code without the user having to think about
// install prefixes.
//
// No-ops cleanly in every other case (first install, local install,
// dependency install, no daemon, dependency install in CI, etc.).

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

// Run only for global installs. npm sets npm_config_global="true" for `npm install -g`.
// `npm ci` / `npm install` (no -g) inside the repo leaves it unset/empty — skip those.
if (process.env.npm_config_global !== 'true') {
  process.exit(0);
}

// Resolve the auto-heal module from dist/. If the user installed from a
// tarball without dist/ (shouldn't happen — `files` whitelists dist/, and
// `prepublishOnly` builds it — but be defensive), skip silently.
const here = path.dirname(fileURLToPath(import.meta.url));
const installRoot = path.dirname(here);
const autoHealModule = path.join(installRoot, 'dist', 'util', 'auto-heal.js');

if (!fs.existsSync(autoHealModule)) {
  // Built artifacts missing — skip silently. This is the npm-publish-with-no-build
  // edge case which is already caught by `prepublishOnly`. Don't fail the install.
  process.exit(0);
}

try {
  const { autoHealInstall } = await import(autoHealModule);
  const result = autoHealInstall(import.meta.url);
  if (result.action === 'rewrote-unit' || result.action === 'rewrote-and-signaled') {
    process.stderr.write(`[beecork-pipe] launchd/systemd unit re-pointed at ${result.newDaemonScript}\n`);
  }
  if (result.action === 'signaled-daemon' || result.action === 'rewrote-and-signaled') {
    process.stderr.write(`[beecork-pipe] running daemon signaled to restart on new code\n`);
  }
  // 'noop' / 'skip' → silent
} catch (err) {
  // Never fail an install on auto-heal trouble — just leave a breadcrumb.
  process.stderr.write(`[beecork-pipe] postinstall auto-heal skipped: ${err?.message ?? err}\n`);
}
