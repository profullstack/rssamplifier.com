import { hashIp } from '@rssamplifier/ingest';

/**
 * Who is voting, as far as a vote needs to know: the caller's address hashed
 * with the UTC day, so one address is one voter per day and nothing stored
 * can follow it past midnight.
 *
 * The address is `x-real-ip`, not the first `x-forwarded-for` entry the
 * crawl throttle reads. On dev2 nginx sets X-Real-IP to $remote_addr and
 * builds X-Forwarded-For with $proxy_add_x_forwarded_for, which appends to
 * whatever the client sent, so its first entry is the client's to choose. A
 * vote limit keyed on that would be a vote limit nobody has to respect.
 *
 * Null when there is no address or no IP_HASH_SALT; a vote is then refused
 * rather than counted unthrottled.
 *
 * @param {Request} req
 * @param {Date} [now]
 * @returns {string|null}
 */
export function voterKey(req, now = new Date()) {
  const ip =
    req.headers.get('x-real-ip')?.trim() || req.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || '';
  if (!ip) return null;
  return hashIp(`${ip}|${now.toISOString().slice(0, 10)}`, process.env['IP_HASH_SALT']);
}
