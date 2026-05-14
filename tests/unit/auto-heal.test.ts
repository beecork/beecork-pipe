import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractDaemonScript, rewriteUnitDaemonScript } from '../../src/util/auto-heal.js';

const SAMPLE_PLIST = (daemonPath: string) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.beecork.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>${daemonPath}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>`;

const SAMPLE_SYSTEMD = (daemonPath: string) => `[Unit]
Description=Beecork
After=network.target

[Service]
ExecStart=/usr/bin/node ${daemonPath}
Restart=always

[Install]
WantedBy=default.target`;

describe('extractDaemonScript', () => {
  it('pulls the daemon path out of a launchd plist', () => {
    const got = extractDaemonScript(SAMPLE_PLIST('/usr/local/lib/node_modules/beecork/dist/daemon.js'));
    expect(got).toBe('/usr/local/lib/node_modules/beecork/dist/daemon.js');
  });

  it('pulls the daemon path out of a systemd unit', () => {
    const got = extractDaemonScript(SAMPLE_SYSTEMD('/home/u/.npm-global/lib/node_modules/beecork/dist/daemon.js'));
    expect(got).toBe('/home/u/.npm-global/lib/node_modules/beecork/dist/daemon.js');
  });

  it('returns null on unrecognized content', () => {
    expect(extractDaemonScript('totally not a unit file')).toBeNull();
  });
});

describe('rewriteUnitDaemonScript', () => {
  let tmpDir: string;
  let plistPath: string;
  let systemdPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beecork-heal-'));
    plistPath = path.join(tmpDir, 'com.beecork.daemon.plist');
    systemdPath = path.join(tmpDir, 'beecork.service');
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('rewrites a launchd plist when the daemon path differs', () => {
    const oldPath = '/usr/local/lib/node_modules/beecork/dist/daemon.js';
    const newPath = '/Users/me/.npm-global/lib/node_modules/beecork/dist/daemon.js';
    fs.writeFileSync(plistPath, SAMPLE_PLIST(oldPath));

    const { rewrote, oldDaemonScript } = rewriteUnitDaemonScript(plistPath, newPath);

    expect(rewrote).toBe(true);
    expect(oldDaemonScript).toBe(oldPath);
    const after = fs.readFileSync(plistPath, 'utf-8');
    expect(after).toContain(newPath);
    expect(after).not.toContain(oldPath);
  });

  it('no-ops when the daemon path already matches', () => {
    const samePath = '/x/lib/node_modules/beecork/dist/daemon.js';
    fs.writeFileSync(plistPath, SAMPLE_PLIST(samePath));

    const { rewrote, oldDaemonScript } = rewriteUnitDaemonScript(plistPath, samePath);

    expect(rewrote).toBe(false);
    expect(oldDaemonScript).toBe(samePath);
    // File untouched
    expect(fs.readFileSync(plistPath, 'utf-8')).toBe(SAMPLE_PLIST(samePath));
  });

  it('handles systemd unit files', () => {
    const oldPath = '/usr/lib/node_modules/beecork/dist/daemon.js';
    const newPath = '/home/u/.npm-global/lib/node_modules/beecork/dist/daemon.js';
    fs.writeFileSync(systemdPath, SAMPLE_SYSTEMD(oldPath));

    const { rewrote } = rewriteUnitDaemonScript(systemdPath, newPath);
    expect(rewrote).toBe(true);
    expect(fs.readFileSync(systemdPath, 'utf-8')).toContain(newPath);
  });

  it('returns rewrote=false when the unit file does not exist', () => {
    const { rewrote, oldDaemonScript } = rewriteUnitDaemonScript('/no/such/file', '/x/daemon.js');
    expect(rewrote).toBe(false);
    expect(oldDaemonScript).toBeNull();
  });

  it('returns rewrote=false when the unit file is unrecognized', () => {
    fs.writeFileSync(plistPath, 'garbage');
    const { rewrote, oldDaemonScript } = rewriteUnitDaemonScript(plistPath, '/x/daemon.js');
    expect(rewrote).toBe(false);
    expect(oldDaemonScript).toBeNull();
  });
});
