import { apikeys, profiles } from '@rssamplifier/db';
import { hashToken, looksLikeApiKey } from '@rssamplifier/auth';

import { db } from './db.js';
import { SCOPE_PROFILE_EDIT, bearerToken, principalFromToken } from './openaccess.js';

/**
 * The session reader, loaded on first use: it lives on next/headers, which
 * only works inside a request, and this module is also imported by tests and
 * by the MCP tools, which hand in their own.
 *
 * @returns {Promise<any>}
 */
async function sessionUser() {
  const { currentUser } = await import('./auth.js');
  return currentUser();
}

/**
 * Who is asking to edit or claim a profile, and whether they may.
 *
 * Three credentials reach the same answer: the site's own session cookie, one
 * of the site's API keys (`rsa_...`, which stands for the account that minted
 * it), or an OpenAccess token with the `openprofile:edit` scope. The first
 * two identify an account; the third identifies a principal at the hub, and
 * optionally the email the hub knows for them.
 *
 * "May edit" is one rule: the profile has been claimed, and the caller is the
 * account or the principal that claimed it. An unclaimed profile is edited by
 * nobody; it is claimed first (see `claimVerdict`), which is where the
 * verification lives.
 */

/**
 * @typedef {{
 *   kind: 'session'|'apikey'|'openaccess'|null,
 *   userId: string|null,
 *   email: string|null,
 *   principal: string|null,
 *   scopes: string[],
 * }} Caller
 */

/**
 * Identify the caller from a request. Never throws; an unknown or bad
 * credential is an anonymous caller.
 *
 * @param {Request} req
 * @param {{ verify?: (token: string) => Promise<any>, user?: () => Promise<any> }} [deps]
 * @returns {Promise<Caller>}
 */
export async function callerOf(req, deps = {}) {
  const none = { kind: null, userId: null, email: null, principal: null, scopes: [] };

  const token = bearerToken(req);
  if (token) {
    if (looksLikeApiKey(token)) {
      const key = await apikeys.keyByHash(db(), hashToken(token));
      if (!key || key.revoked_at) return none;
      const user = await userById(String(key.user_id));
      return {
        kind: 'apikey',
        userId: String(key.user_id),
        email: user?.email ? String(user.email).toLowerCase() : null,
        principal: null,
        scopes: [],
      };
    }
    const principal = await principalFromToken(token, deps);
    if (!principal) return none;
    return {
      kind: 'openaccess',
      userId: null,
      email: principal.email,
      principal: principal.sub,
      scopes: principal.scopes,
    };
  }

  const user = await (deps.user ?? sessionUser)();
  if (!user) return none;
  return {
    kind: 'session',
    userId: String(user.id),
    email: user.email ? String(user.email).toLowerCase() : null,
    principal: null,
    scopes: [],
  };
}

/**
 * @param {string} id
 * @returns {Promise<{ id: string, email: string }|null>}
 */
async function userById(id) {
  const { rows } = await db().execute({
    sql: 'select id, email from users where id = ? limit 1',
    args: [id],
  });
  return rows[0] ? /** @type {any} */ (rows[0]) : null;
}

/**
 * Is this caller the owner of this profile?
 *
 * @param {Caller} caller
 * @param {import('@rssamplifier/db').profiles.AuthorProfile|null} profile
 * @returns {boolean}
 */
export function isOwner(caller, profile) {
  if (!profile || !profile.claimed_at) return false;
  if (caller.kind === 'openaccess') {
    if (!caller.scopes.includes(SCOPE_PROFILE_EDIT)) return false;
    return Boolean(caller.principal && caller.principal === profile.owner_principal);
  }
  if (!caller.userId) return false;
  return caller.userId === profile.owner_user_id;
}

/**
 * Whether this caller may claim this author, and how the claim is verified.
 *
 * Two proofs, either sufficient, both automatic:
 *
 * - `email`: the caller's verified address is the one the author published
 *   about themselves (a rel="me" mailto, an h-card email, the feed's own
 *   author element). The directory dropped role mailboxes at extraction, so a
 *   match here is a person matching a person.
 * - `linkback`: the author's own site points at this profile, with
 *   `rel="openprofile"` or `rel="me"` to the profile URL or the author page.
 *   That is the verification rule OpenProfile.md itself names, and it works
 *   for an author who never published an address.
 *
 * An admin may claim on anybody's behalf, which is the fallback for the
 * case neither proof covers.
 *
 * @param {{
 *   caller: Caller,
 *   person: { id: string, slug: string, email?: string|null, site_url?: string|null },
 *   profile: import('@rssamplifier/db').profiles.AuthorProfile|null,
 *   profileUrl: string,
 *   pageUrl: string,
 *   admins?: string[],
 *   fetchText?: (url: string) => Promise<string|null>,
 * }} input
 * @returns {Promise<{ ok: true, method: string } | { ok: false, status: number, error: string }>}
 */
export async function claimVerdict({ caller, person, profile, profileUrl, pageUrl, admins = [], fetchText }) {
  if (!caller.kind) return { ok: false, status: 401, error: 'sign-in-required' };
  if (caller.kind === 'openaccess' && !caller.scopes.includes(SCOPE_PROFILE_EDIT)) {
    return { ok: false, status: 403, error: `the grant lacks ${SCOPE_PROFILE_EDIT}` };
  }

  if (profile?.claimed_at) {
    if (isOwner(caller, profile)) return { ok: true, method: String(profile.claim_method ?? 'email') };
    // A second person may still attach a second credential to a profile they
    // already own another way, which the email match below settles; anybody
    // else is refused.
  }

  if (caller.email && admins.map((a) => a.toLowerCase()).includes(caller.email)) {
    return { ok: true, method: 'admin' };
  }

  const published = person.email ? String(person.email).trim().toLowerCase() : null;
  if (published && caller.email && published === caller.email) {
    if (profile?.claimed_at && !ownedByEmail(profile, caller)) {
      return { ok: false, status: 409, error: 'already-claimed' };
    }
    return { ok: true, method: 'email' };
  }

  if (profile?.claimed_at) return { ok: false, status: 409, error: 'already-claimed' };

  if (person.site_url && fetchText) {
    const html = await fetchText(String(person.site_url)).catch(() => null);
    if (html && linksBack(html, [profileUrl, pageUrl])) return { ok: true, method: 'linkback' };
  }

  return {
    ok: false,
    status: 403,
    error: published
      ? `sign in as ${maskEmail(published)}, or add a rel="openprofile" link to ${profileUrl} on ${person.site_url ?? 'your site'}`
      : `add <link rel="openprofile" href="${profileUrl}"> to ${person.site_url ?? 'your site'} and claim again`,
  };
}

/**
 * @param {import('@rssamplifier/db').profiles.AuthorProfile} profile
 * @param {Caller} caller
 */
function ownedByEmail(profile, caller) {
  return Boolean(caller.userId && caller.userId === profile.owner_user_id) ||
    Boolean(caller.principal && caller.principal === profile.owner_principal);
}

/**
 * Does this HTML point at one of these URLs with rel="openprofile" or rel="me"?
 *
 * A plain regex over the markup, because the question is "is this exact URL
 * in a link with this rel", which needs no parser and must not need a
 * browser. Attribute order is not assumed.
 *
 * @param {string} html
 * @param {string[]} urls
 * @returns {boolean}
 */
export function linksBack(html, urls) {
  const wanted = new Set(urls.map((u) => u.replace(/\/+$/, '').toLowerCase()));
  const tags = html.match(/<(?:a|link)\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const rel = /\brel\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    if (!/\b(openprofile|me)\b/.test(rel)) continue;
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
    if (wanted.has(href.trim().replace(/\/+$/, '').toLowerCase())) return true;
  }
  return false;
}

/**
 * `a***@example.com`, enough to recognise and not enough to harvest.
 *
 * @param {string} email
 */
function maskEmail(email) {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

/**
 * The addresses that may claim any profile: the site's admins.
 *
 * @returns {string[]}
 */
export function adminEmails() {
  const env = process.env;
  return String(env['ADMIN_EMAILS'] ?? 'anthony@profullstack.com')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * A small fetch for the linkback check: one page, a short timeout, a bounded
 * body. The site being checked is the author's own, which is exactly the
 * page the crawler already reads for rel="me".
 *
 * @param {string} url
 * @returns {Promise<string|null>}
 */
export async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'rssamplifier-openprofile/1 (+https://rssamplifier.com/about)', accept: 'text/html' },
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.slice(0, 512 * 1024);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export { profiles };
