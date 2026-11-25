import { normalizeEmail } from './upload.js';

/**
 * Who a submission is from, and where to tell them how it went.
 *
 * A hand submission needs a contact address (2026-11-25). The directory still
 * needs no account, so the address is the one thing we ask for: it is where the
 * "your feed is listed" note goes, and a submitter who never hears back has no
 * reason to submit again.
 *
 * Not everyone who posts here is a person at a form, and the ones who are not
 * must keep working without inventing an address:
 *
 *  - a signed-in reader already gave us one, so their account address is used
 *    when the form left the field empty;
 *  - an API key or an OpenAccess token is an account acting by machine (the
 *    pit.world ring sync is one). It may pass an `email` to be told, but is
 *    never refused for leaving it out, and is not mailed unless it asked;
 *  - our own services on the same box (p0dcasters and NicheDB forwarding the
 *    feeds they list) arrive from a private address, or carry the shared
 *    internal token, and are exempt for the same reason.
 *
 * Everyone else gets `email-required`.
 */

/** The error code a missing or unusable address is answered with. */
export const EMAIL_REQUIRED = 'email-required';

/** The header our own services may send instead of an address. */
export const INTERNAL_TOKEN_HEADER = 'x-submit-token';

/**
 * Is this a private, loopback or link-local address?
 *
 * The caller's address comes from `clientIp`, which believes X-Real-IP as set
 * by our nginx, so a client on the internet cannot choose to look private.
 *
 * @param {string|null|undefined} ip
 * @returns {boolean}
 */
export function isPrivateIp(ip) {
  const a = String(ip ?? '')
    .trim()
    .toLowerCase()
    .replace(/^::ffff:/, '');
  if (!a) return false;
  if (a === '::1' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80:')) return true;

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return false;
  const [o1, o2] = [Number(m[1]), Number(m[2])];
  return (
    o1 === 10 ||
    o1 === 127 ||
    (o1 === 172 && o2 >= 16 && o2 <= 31) ||
    (o1 === 192 && o2 === 168) ||
    (o1 === 169 && o2 === 254)
  );
}

/**
 * Does the request carry one of the configured internal tokens?
 *
 * `SUBMIT_INTERNAL_TOKENS` is a comma-separated list, so a token can be rotated
 * by adding the new one before removing the old. Unset means no token is
 * accepted, never that any is.
 *
 * @param {string|null|undefined} presented
 * @param {string|undefined} [configured]
 * @returns {boolean}
 */
export function isInternalToken(presented, configured = process.env['SUBMIT_INTERNAL_TOKENS']) {
  const token = String(presented ?? '').trim();
  if (token.length < 16) return false;
  return String(configured ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length >= 16)
    .includes(token);
}

/**
 * @typedef {{
 *   ok: true,
 *   email: string|null,
 *   via: 'form'|'session'|'apikey'|'openaccess'|'internal',
 * } | { ok: false, error: string }} Submitter
 */

/**
 * Decide who a submission is from.
 *
 * @param {{
 *   email?: unknown,
 *   ip?: string|null,
 *   token?: string|null,
 *   caller?: () => Promise<{ kind: string|null, email: string|null }>,
 * }} input
 * @returns {Promise<Submitter>}
 */
export async function resolveSubmitter(input) {
  const given = normalizeEmail(input.email);

  /** @type {{ kind: string|null, email: string|null }} */
  let caller = { kind: null, email: null };
  try {
    if (input.caller) caller = (await input.caller()) ?? caller;
  } catch {
    // A credential we cannot check is an anonymous caller, the same rule
    // callerOf follows; it is then asked for an address like anyone else.
  }

  if (caller.kind === 'session') {
    return { ok: true, email: given ?? caller.email ?? null, via: 'session' };
  }
  if (caller.kind === 'apikey' || caller.kind === 'openaccess') {
    return { ok: true, email: given, via: caller.kind };
  }
  if (isInternalToken(input.token) || isPrivateIp(input.ip)) {
    return { ok: true, email: given, via: 'internal' };
  }
  if (given) return { ok: true, email: given, via: 'form' };

  return { ok: false, error: EMAIL_REQUIRED };
}

/**
 * The JSON body an agent gets when it left the address out.
 *
 * @returns {{ ok: false, error: string, message: string }}
 */
export function emailRequiredBody() {
  return {
    ok: false,
    error: EMAIL_REQUIRED,
    message:
      'Add an "email" field: the address we write to when your feeds are listed (or if they cannot be). Signed-in accounts and API keys may leave it out.',
  };
}
