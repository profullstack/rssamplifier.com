import { OpenAccessApp } from '@logicsrc/openaccess/client';

/**
 * OpenAccess (openaccess.logicsrc.com): OAuth 2.1 with a grant you can carry.
 *
 * The descriptor at /.well-known/openaccess.json names the scopes this site
 * honours; an access token the hub minted for `rssamplifier.com` is verified
 * here offline against the hub's published keys, and its `scope` decides what
 * the caller may do. That is how a person's own agent edits their profile
 * from anywhere without holding a session cookie for this site.
 */
export const HUB = 'https://openaccess.logicsrc.com';
export const CLIENT_ID = 'rssamplifier.com';

/** Edit the OpenProfile.md of an author the principal has claimed. */
export const SCOPE_PROFILE_EDIT = 'openprofile:edit';

/** @type {OpenAccessApp|null} */
let app = null;

/** @returns {OpenAccessApp} */
function hub() {
  if (!app) {
    app = new OpenAccessApp({
      hub: HUB,
      clientId: CLIENT_ID,
      redirectUri: `https://${CLIENT_ID}/api/v1/openaccess/callback`,
    });
  }
  return app;
}

/**
 * @typedef {{ sub: string, scopes: string[], email: string|null }} Principal
 */

/**
 * The OpenAccess principal behind a bearer token, or null for none or a bad one.
 *
 * `email` rides along when the hub put one in the claims, because a claim on
 * a profile is verified by matching it against the address the author
 * published; a token without one can still edit a profile already claimed
 * under its `sub`.
 *
 * @param {string|null|undefined} token
 * @param {{ verify?: (token: string) => Promise<any> }} [deps]
 * @returns {Promise<Principal|null>}
 */
export async function principalFromToken(token, deps = {}) {
  if (!token) return null;
  try {
    const claims = await (deps.verify ?? ((t) => hub().verify(t)))(token);
    const sub = typeof claims?.sub === 'string' ? claims.sub : '';
    if (!sub) return null;
    const scope = typeof claims.scope === 'string' ? claims.scope : '';
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : null;
    return { sub, scopes: scope.split(/\s+/).filter(Boolean), email: email || null };
  } catch {
    return null;
  }
}

/**
 * The bearer token on a request, if any.
 *
 * @param {Request} req
 * @returns {string|null}
 */
export function bearerToken(req) {
  const header = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : null;
}
