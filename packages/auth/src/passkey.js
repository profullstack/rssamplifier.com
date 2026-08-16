import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { accounts, newId, nowIso } from '@rssamplifier/db';

/**
 * Passkeys.
 *
 * Deliberately unopinionated about where the key lives. `authenticatorAttachment`
 * is left unset and `preferredAuthenticatorType` is never passed, because naming
 * either one makes the browser quietly stop offering the others — a page that
 * asks for a platform authenticator will not show Bitwarden or 1Password in the
 * picker at all. `residentKey: required` is the other half of that: a
 * discoverable credential is what a password manager can store, sync and offer
 * by name, and it is what lets someone sign in without first typing an address.
 */

/** How long the browser has to complete a ceremony. */
const CHALLENGE_MS = 5 * 60 * 1000;

/**
 * The relying-party id: a bare domain, never a URL.
 *
 * A credential is bound to this value, so it decides where the passkey works.
 * Taking it from SITE_URL means the apex and its subdomains share credentials
 * and a preview deployment on another domain simply cannot see them, which is
 * the correct outcome rather than a limitation.
 *
 * @param {string} siteUrl
 * @returns {string}
 */
export function relyingPartyId(siteUrl) {
  try {
    return new URL(siteUrl).hostname;
  } catch {
    return 'localhost';
  }
}

/**
 * Origins a ceremony may legitimately come from.
 *
 * `www` is included because the site answers on both and a reader who
 * registered on one must not be locked out on the other.
 *
 * @param {string} siteUrl
 * @returns {string[]}
 */
export function expectedOrigins(siteUrl) {
  const base = String(siteUrl).replace(/\/+$/, '');
  try {
    const url = new URL(base);
    const host = url.hostname;
    const alternate = host.startsWith('www.')
      ? `${url.protocol}//${host.slice(4)}`
      : `${url.protocol}//www.${host}`;
    return [base, alternate];
  } catch {
    return [base];
  }
}

/**
 * Store a challenge and hand back the handle that identifies it.
 *
 * @param {import('@libsql/client').Client} db
 * @param {string} challenge
 * @param {string|null} userId
 * @param {string} purpose
 * @returns {Promise<string>}
 */
async function stashChallenge(db, challenge, userId, purpose) {
  const id = newId();
  await accounts.insertChallenge(db, {
    id,
    challenge,
    userId,
    purpose,
    expiresAt: nowIso(CHALLENGE_MS),
  });
  return id;
}

/**
 * Begin registering a passkey for a signed-in account.
 *
 * @param {import('@libsql/client').Client} db
 * @param {{ id: string, email: string }} user
 * @param {string} siteUrl
 * @returns {Promise<{ options: object, challengeId: string }>}
 */
export async function beginRegistration(db, user, siteUrl) {
  const existing = await accounts.credentialsForUser(db, user.id);

  const options = await generateRegistrationOptions({
    rpName: 'RSS Amplifier',
    rpID: relyingPartyId(siteUrl),
    userName: user.email,
    userDisplayName: user.email,
    userID: new TextEncoder().encode(String(user.id)),
    attestationType: 'none',
    // Offering a key the account already holds just produces a confusing error
    // in the authenticator, so exclude them up front.
    excludeCredentials: existing.map((c) => ({
      id: String(c.id),
      transports: parseTransports(c.transports),
    })),
    authenticatorSelection: {
      residentKey: 'required',
      requireResidentKey: true,
      // Preferred rather than required: a hardware key without a PIN is still
      // a large improvement on an emailed link, and requiring verification
      // turns those away.
      userVerification: 'preferred',
    },
  });

  const challengeId = await stashChallenge(db, options.challenge, user.id, 'register');
  return { options, challengeId };
}

/**
 * Finish registering a passkey.
 *
 * @param {import('@libsql/client').Client} db
 * @param {{ userId: string, challengeId: string, response: object, name?: string|null, siteUrl: string }} params
 * @returns {Promise<{ ok: true, credentialId: string } | { ok: false, error: string }>}
 */
export async function finishRegistration(db, params) {
  const stored = await accounts.takeChallenge(db, params.challengeId, 'register');
  if (!stored) return { ok: false, error: 'challenge-expired' };
  if (String(stored.user_id) !== String(params.userId)) {
    return { ok: false, error: 'challenge-mismatch' };
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: params.response,
      expectedChallenge: String(stored.challenge),
      expectedOrigin: expectedOrigins(params.siteUrl),
      expectedRPID: relyingPartyId(params.siteUrl),
      requireUserVerification: false,
    });
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }

  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, error: 'not-verified' };
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

  await accounts.insertCredential(db, {
    id: credential.id,
    user_id: params.userId,
    public_key: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: credential.transports ?? [],
    device_type: credentialDeviceType,
    backed_up: credentialBackedUp,
    name: params.name?.trim() || defaultName(credentialDeviceType, credentialBackedUp),
  });

  return { ok: true, credentialId: credential.id };
}

/**
 * Begin a passkey sign-in.
 *
 * `allowCredentials` is left empty on purpose: with discoverable credentials
 * the authenticator knows which keys it holds for this site, so the reader
 * picks one instead of first telling us who they are. It also means this
 * endpoint reveals nothing about which accounts exist.
 *
 * @param {import('@libsql/client').Client} db
 * @param {string} siteUrl
 * @returns {Promise<{ options: object, challengeId: string }>}
 */
export async function beginLogin(db, siteUrl) {
  const options = await generateAuthenticationOptions({
    rpID: relyingPartyId(siteUrl),
    allowCredentials: [],
    userVerification: 'preferred',
  });

  const challengeId = await stashChallenge(db, options.challenge, null, 'login');
  return { options, challengeId };
}

/**
 * Finish a passkey sign-in.
 *
 * @param {import('@libsql/client').Client} db
 * @param {{ challengeId: string, response: object, siteUrl: string }} params
 * @returns {Promise<{ ok: true, userId: string } | { ok: false, error: string }>}
 */
export async function finishLogin(db, params) {
  const stored = await accounts.takeChallenge(db, params.challengeId, 'login');
  if (!stored) return { ok: false, error: 'challenge-expired' };

  const credentialId = String(params.response?.id ?? '');
  if (!credentialId) return { ok: false, error: 'missing-credential-id' };

  const credential = await accounts.credentialById(db, credentialId);
  if (!credential) return { ok: false, error: 'unknown-credential' };

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: params.response,
      expectedChallenge: String(stored.challenge),
      expectedOrigin: expectedOrigins(params.siteUrl),
      expectedRPID: relyingPartyId(params.siteUrl),
      credential: {
        id: String(credential.id),
        publicKey: new Uint8Array(Buffer.from(String(credential.public_key), 'base64url')),
        counter: Number(credential.counter ?? 0),
        transports: parseTransports(credential.transports),
      },
      requireUserVerification: false,
    });
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }

  if (!verification.verified) return { ok: false, error: 'not-verified' };

  // Writing the counter back is what makes a cloned authenticator detectable
  // later; a verification that is never recorded is a replay waiting to happen.
  await accounts.touchCredential(db, credentialId, verification.authenticationInfo.newCounter);

  return { ok: true, userId: String(credential.user_id) };
}

/**
 * @param {unknown} raw JSON array as stored
 * @returns {string[]|undefined}
 */
function parseTransports(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A name for a passkey the reader did not name themselves.
 *
 * @param {string} deviceType
 * @param {boolean} backedUp
 * @returns {string}
 */
function defaultName(deviceType, backedUp) {
  if (deviceType === 'multiDevice' || backedUp) return 'Synced passkey';
  return 'Device passkey';
}
