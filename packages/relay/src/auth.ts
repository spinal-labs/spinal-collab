/**
 * Credential checks. Two credentials guard a session (see plan §Security):
 *   - hostToken: high-entropy secret minted by the host process. Only the
 *     process that created the session can connect as host. Never logged.
 *   - joinCode: short, human-shareable code a guest must present.
 *
 * Neither is a strong authn of *identity* — this is "anyone with the link+code".
 * The real safety boundary is host-only tool approval, enforced elsewhere.
 */
import { timingSafeEqual } from 'node:crypto';

/** Constant-time string compare to avoid leaking length/prefix via timing. */
export function secureEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still do a compare to keep timing roughly uniform, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
