import crypto from 'node:crypto';

/**
 * Constant-time string comparison. Returns false (not throw) for null/undefined
 * or length-mismatched inputs. Single source of truth for the auth-token/HMAC
 * comparisons in the dashboard and webhook channel.
 */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (a === undefined || a === null || b === undefined || b === null) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}
