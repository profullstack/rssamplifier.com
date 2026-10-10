import { hashIp } from '@rssamplifier/ingest';
import { clientIp } from '@profullstack/x402-gateway/edge';

/**
 * Who is voting, as far as a vote needs to know: the caller's address hashed
 * with the UTC day, so one address is one voter per day and nothing stored
 * can follow it past midnight.
 *
 * The address is clientIp's: `x-real-ip`, else the last `x-forwarded-for`
 * hop. Never the first entry, which dev2's nginx lets the client write.
 *
 * Null when there is no address or no IP_HASH_SALT; a vote is then refused
 * rather than counted unthrottled.
 *
 * @param {Request} req
 * @param {Date} [now]
 * @returns {string|null}
 */
export function voterKey(req, now = new Date()) {
  const ip = clientIp(req);
  if (!ip) return null;
  return hashIp(`${ip}|${now.toISOString().slice(0, 10)}`, process.env['IP_HASH_SALT']);
}
