import { createHmac } from 'node:crypto';

/**
 * Hash a submitter IP for the audit log.
 *
 * HMAC with a server-side salt, not a bare digest: the IPv4 space is small
 * enough to brute-force a plain SHA-256 back to the original address in
 * seconds, which would make the audit log a store of personal data.
 *
 * Returns null when no salt is configured, so a missing salt degrades to "no
 * IP recorded" rather than to a predictable, reversible hash.
 *
 * @param {string|null|undefined} ip
 * @param {string|null|undefined} salt
 * @returns {string|null}
 */
export function hashIp(ip, salt) {
  if (!ip || !salt) return null;
  return createHmac('sha256', salt).update(ip).digest('hex').slice(0, 32);
}
