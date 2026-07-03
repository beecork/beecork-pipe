import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { isDiscordMessageAllowed } from '../../src/channels/discord.js';
import { isPathWithinRoots } from '../../src/util/paths.js';
import { assertInsideMediaDir, getMediaDir } from '../../src/media/store.js';

describe('Discord authorization (C1 — allowlist bypass regression guard)', () => {
  const allow = new Set(['111', '222']);

  it('rejects a guild message from a non-allowlisted author even if the bot is @mentioned', () => {
    // The exact C1 hole: a mention alone must NOT be sufficient in a server.
    expect(isDiscordMessageAllowed(allow, '999', false /*isDM*/, true /*isMentioned*/)).toBe(false);
  });

  it('allows a guild message only when the author is allowlisted AND mentioned', () => {
    expect(isDiscordMessageAllowed(allow, '111', false, true)).toBe(true);
    expect(isDiscordMessageAllowed(allow, '111', false, false)).toBe(false); // allowlisted but no mention
  });

  it('allows a DM only from an allowlisted author', () => {
    expect(isDiscordMessageAllowed(allow, '111', true, false)).toBe(true);
    expect(isDiscordMessageAllowed(allow, '999', true, false)).toBe(false);
  });

  it('fails closed when the allowlist is empty', () => {
    const empty = new Set<string>();
    expect(isDiscordMessageAllowed(empty, '111', true, true)).toBe(false);
    expect(isDiscordMessageAllowed(empty, '111', false, true)).toBe(false);
  });
});

describe('Media-directory jail (assertInsideMediaDir)', () => {
  it('accepts a path inside the media directory', () => {
    const ok = path.join(getMediaDir(), 'image.png');
    expect(assertInsideMediaDir(ok)).toBe(path.resolve(ok));
  });

  it('rejects an arbitrary absolute path (exfiltration attempt)', () => {
    expect(() => assertInsideMediaDir('/etc/passwd')).toThrow(/media directory/i);
  });

  it('rejects a traversal escaping the media directory', () => {
    expect(() => assertInsideMediaDir(path.join(getMediaDir(), '..', '..', 'secret'))).toThrow(
      /media directory/i,
    );
  });
});

describe('Allowed-roots path matcher (isPathWithinRoots — workingDir/project allowlists)', () => {
  it('accepts a directory at or under an allowed root', () => {
    expect(isPathWithinRoots('/home/user/proj', ['/home/user'])).toBe(true);
    expect(isPathWithinRoots('/home/user', ['/home/user'])).toBe(true);
  });

  it('does not let a sibling prefix match (the + path.sep guard)', () => {
    // /home/user-evil must NOT be treated as under /home/user.
    expect(isPathWithinRoots('/home/user-evil', ['/home/user'])).toBe(false);
  });

  it('rejects an unrelated directory', () => {
    expect(isPathWithinRoots('/etc', ['/home/user'])).toBe(false);
  });

  it('ignores empty/undefined roots', () => {
    expect(isPathWithinRoots('/etc', ['', undefined, null])).toBe(false);
  });
});
