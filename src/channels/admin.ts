/**
 * Shared admin check for channel commands. Single source of truth so the
 * "who can run admin commands?" rule doesn't drift between channels.
 *
 * Policy:
 *   - If an explicit admin peer ID is configured, only they are admin.
 *   - Else the first allowed peer in the allowlist is admin.
 *   - If the allowlist is empty, no one is admin (fail closed).
 */
export function isChannelAdmin(
  allowList: Iterable<string | number>,
  peerId: string | number | undefined,
  explicitAdmin?: string | number,
): boolean {
  if (peerId === undefined || peerId === null) return false;
  if (explicitAdmin !== undefined && explicitAdmin !== null) {
    return String(peerId) === String(explicitAdmin);
  }
  const first = [...allowList][0];
  if (first === undefined) return false;
  return String(peerId) === String(first);
}
