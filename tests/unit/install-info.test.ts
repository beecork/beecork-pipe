import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpHome: string;

vi.mock('../../src/util/paths.js', async () => {
  const real = await vi.importActual<typeof import('../../src/util/paths.js')>('../../src/util/paths.js');
  return {
    ...real,
    getRuntimeInfoPath: () => path.join(tmpHome, 'runtime.json'),
  };
});

import {
  writeRuntimeInfo,
  readRuntimeInfo,
  removeRuntimeInfo,
  findInstallRoot,
  getDaemonScript,
  isPidAlive,
} from '../../src/util/install-info.js';

describe('runtime info file', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'beecork-runtime-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('round-trips a written record', () => {
    const info = {
      pid: 12345,
      version: '1.4.10',
      installRoot: '/foo/lib/node_modules/beecork',
      daemonScript: '/foo/lib/node_modules/beecork/dist/daemon.js',
      startedAt: '2026-05-14T07:55:43.684Z',
      nodeVersion: 'v20.11.0',
    };
    writeRuntimeInfo(info);
    expect(readRuntimeInfo()).toEqual(info);
  });

  it('readRuntimeInfo returns null when file is absent', () => {
    expect(readRuntimeInfo()).toBeNull();
  });

  it('readRuntimeInfo returns null on malformed JSON instead of throwing', () => {
    fs.writeFileSync(path.join(tmpHome, 'runtime.json'), '{not json');
    expect(readRuntimeInfo()).toBeNull();
  });

  it('readRuntimeInfo returns null on a structurally invalid record', () => {
    fs.writeFileSync(path.join(tmpHome, 'runtime.json'), JSON.stringify({ no: 'pid' }));
    expect(readRuntimeInfo()).toBeNull();
  });

  it('removeRuntimeInfo cleans up the file', () => {
    writeRuntimeInfo({
      pid: 1,
      version: 'x',
      installRoot: '/x',
      daemonScript: '/x/d.js',
      startedAt: 'now',
      nodeVersion: 'v20',
    });
    expect(fs.existsSync(path.join(tmpHome, 'runtime.json'))).toBe(true);
    removeRuntimeInfo();
    expect(fs.existsSync(path.join(tmpHome, 'runtime.json'))).toBe(false);
  });

  it('removeRuntimeInfo is a no-op when file is absent', () => {
    expect(() => removeRuntimeInfo()).not.toThrow();
  });
});

describe('findInstallRoot', () => {
  it('locates a package root by walking up from a nested file URL', () => {
    // The src tree itself: this test file lives at <root>/tests/unit/install-info.test.ts.
    // We pass our own file URL and expect findInstallRoot to find the repo root.
    const root = findInstallRoot(import.meta.url);
    expect(fs.existsSync(path.join(root, 'package.json'))).toBe(true);
  });
});

describe('getDaemonScript', () => {
  it('appends dist/daemon.js to the install root', () => {
    expect(getDaemonScript('/foo/lib/node_modules/beecork')).toBe(
      path.join('/foo/lib/node_modules/beecork', 'dist', 'daemon.js'),
    );
  });
});

describe('isPidAlive', () => {
  it('returns true for the current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
  it('returns false for an impossibly high pid', () => {
    expect(isPidAlive(2 ** 30)).toBe(false);
  });
});
