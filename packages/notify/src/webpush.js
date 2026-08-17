import { createECDH, createHmac, createCipheriv, randomBytes, createPrivateKey, sign, generateKeyPairSync } from 'node:crypto';

/**
 * Web Push, from the specifications rather than from a library.
 *
 * Three RFCs meet here and it is worth naming which does what, because the
 * pieces look interchangeable and are not:
 *
 *   * **RFC 8188** is the content encoding — the `aes128gcm` framing, the header
 *     block with the salt in it, and the 0x02 delimiter that marks the last
 *     record.
 *   * **RFC 8291** is the key agreement — how a shared secret with a browser
 *     that is not online becomes an AES key, using the two public keys and the
 *     subscription's `auth` secret.
 *   * **RFC 8292** is VAPID — the signed assertion that says which application
 *     server this is, so a push service can rate-limit us by identity rather
 *     than by address.
 *
 * Hand-rolled for the same reason `@rssamplifier/mail` is a `fetch` call rather
 * than an SDK: this is about two hundred lines of well-specified primitives that
 * node:crypto already implements, and the alternative is a dependency in the
 * critical path of the daemon. The test cross-checks it against the reference
 * implementation's own vectors, which is what makes that trade safe.
 *
 * Nothing here throws for an ordinary failure. A push service returning 410 for
 * a browser that no longer exists is the normal end of a subscription's life,
 * not an exception, and the caller records it as such.
 */

/** The record size in the aes128gcm header. One record, big enough for any alert. */
const RECORD_SIZE = 4096;

/** How long a push service should hold an undelivered alert. Four hours. */
const DEFAULT_TTL = 14_400;

/**
 * How long a VAPID assertion is good for.
 *
 * Twelve hours rather than the 24 the spec allows, because clock skew is
 * measured against the push service's clock and not ours: a token minted at the
 * ceiling by a machine running a few minutes fast is rejected outright, and the
 * failure looks exactly like a bad key.
 */
const VAPID_TTL_SECONDS = 43_200;

/**
 * Base64url, no padding — the encoding every one of these specifications uses.
 *
 * @param {Buffer|Uint8Array} buf
 * @returns {string}
 */
export function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/**
 * @param {string} value
 * @returns {Buffer}
 */
export function fromB64url(value) {
  return Buffer.from(String(value ?? ''), 'base64url');
}

/**
 * HKDF, in the two-step form these specifications spell out.
 *
 * Written out rather than calling `crypto.hkdf` because RFC 8291 uses the
 * extract and expand halves at different points with different salts, and
 * following the text is worth more here than saving six lines.
 *
 * @param {Buffer} salt
 * @param {Buffer} ikm
 * @param {Buffer} info
 * @param {number} length
 * @returns {Buffer}
 */
function hkdf(salt, ikm, info, length) {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  // One block is always enough: the longest thing derived here is 32 bytes and
  // SHA-256's output is 32 bytes, so the counter never passes 0x01.
  const okm = createHmac('sha256', prk).update(info).update(Buffer.of(0x01)).digest();
  return okm.subarray(0, length);
}

/**
 * The `key_info` of RFC 8291 §3.4: whose keys these are, in a fixed order.
 *
 * The order is not arbitrary and getting it backwards produces a body that
 * encrypts cleanly and decrypts to nothing on the device — a failure with no
 * error anywhere, which is why it is spelled out here.
 *
 * @param {Buffer} uaPublic the browser's key, from the subscription
 * @param {Buffer} asPublic our ephemeral key for this message
 * @returns {Buffer}
 */
function keyInfo(uaPublic, asPublic) {
  return Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
}

/**
 * Encrypt one alert for one subscription.
 *
 * `salt` and `serverKeys` are parameters only so the tests can pin them to a
 * published vector. In production both are fresh per message, which RFC 8291
 * requires: the key agreement's only source of uniqueness is the ephemeral pair,
 * and reusing one across two messages to the same browser reuses the AES nonce.
 *
 * @param {{ p256dh: string, auth: string }} keys the subscription's own keys
 * @param {Buffer|string} payload
 * @param {{ salt?: Buffer, serverKeys?: import('node:crypto').ECDH }} [opts]
 * @returns {Buffer} the request body, header block included
 */
export function encryptPayload(keys, payload, opts = {}) {
  const uaPublic = fromB64url(keys.p256dh);
  const authSecret = fromB64url(keys.auth);
  const plaintext = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');

  const server = opts.serverKeys ?? createECDH('prime256v1');
  if (!opts.serverKeys) server.generateKeys();
  const asPublic = server.getPublicKey();

  const sharedSecret = server.computeSecret(uaPublic);
  const salt = opts.salt ?? randomBytes(16);

  // The subscription's auth secret is the salt of the first extraction, which is
  // what binds the derived key to *this* subscription rather than merely to the
  // two key pairs.
  const ikm = hkdf(authSecret, sharedSecret, keyInfo(uaPublic, asPublic), 32);

  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 rather than 0x01: this is the last record, and a browser handed 0x01
  // waits for a continuation that never comes.
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.of(0x02)])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);

  return Buffer.concat([header, asPublic, body]);
}

/**
 * The `Authorization` header of RFC 8292: a signed claim about who is sending.
 *
 * The audience is the push service's *origin* and nothing more — including the
 * endpoint path makes the token unusable, and the rejection is a flat 401 with
 * no explanation.
 *
 * @param {string} endpoint
 * @param {{ publicKey: string, privateKey: string, subject: string }} vapid
 * @param {{ now?: number }} [opts]
 * @returns {string}
 */
export function vapidHeader(endpoint, vapid, opts = {}) {
  const audience = new URL(endpoint).origin;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);

  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(
    Buffer.from(
      JSON.stringify({ aud: audience, exp: now + VAPID_TTL_SECONDS, sub: vapid.subject }),
    ),
  );
  const signingInput = Buffer.from(`${header}.${claims}`);

  // ieee-p1363 is the raw r||s pair JWS wants. Node's default is the DER
  // wrapping, which every push service rejects as a malformed signature.
  const signature = sign('sha256', signingInput, {
    key: vapidPrivateKey(vapid),
    dsaEncoding: 'ieee-p1363',
  });

  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${vapid.publicKey}`;
}

/**
 * The VAPID signing key, as node:crypto wants it.
 *
 * VAPID keys are stored the way every tool that mints them emits them: the raw
 * 32-byte scalar and the uncompressed 65-byte point, both base64url. Node will
 * not take those directly, but it will take a JWK — and a JWK is exactly those
 * numbers with the point split in half.
 *
 * @param {{ publicKey: string, privateKey: string }} vapid
 * @returns {import('node:crypto').KeyObject}
 */
function vapidPrivateKey(vapid) {
  const point = fromB64url(vapid.publicKey);
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error('VAPID public key must be a 65-byte uncompressed P-256 point');
  }

  return createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: vapid.privateKey,
      x: b64url(point.subarray(1, 33)),
      y: b64url(point.subarray(33, 65)),
    },
  });
}

/**
 * Mint a VAPID key pair.
 *
 * Called by `pnpm vapid` rather than at runtime: the pair is an identity, and
 * regenerating it on boot would invalidate every subscription in the database
 * the first time the service restarted.
 *
 * @returns {{ publicKey: string, privateKey: string }}
 */
export function generateVapidKeys() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });

  // The public half is the two coordinates with an 0x04 in front of them, which
  // is the uncompressed point encoding every push API expects to be handed.
  const point = Buffer.concat([
    Buffer.of(0x04),
    fromB64url(String(jwk.x)),
    fromB64url(String(jwk.y)),
  ]);

  return { publicKey: b64url(point), privateKey: String(jwk.d) };
}

/**
 * Read the VAPID configuration out of the environment, or null if absent.
 *
 * Absent is an ordinary state — a deployment with no push keys serves the site
 * perfectly well and simply never offers browser alerts — so this reports it
 * rather than throwing, the way `emailEnabled()` does for mail.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ publicKey: string, privateKey: string, subject: string }|null}
 */
export function vapidConfig(env = process.env) {
  const publicKey = env['VAPID_PUBLIC_KEY'];
  const privateKey = env['VAPID_PRIVATE_KEY'];
  if (!publicKey || !privateKey) return null;

  return {
    publicKey,
    privateKey,
    // A contact address, so a push service with a problem has somewhere to
    // complain to. Required by RFC 8292; the default is the site's own.
    subject: env['VAPID_SUBJECT'] || 'mailto:hello@rssamplifier.com',
  };
}

/**
 * Deliver one alert to one browser.
 *
 * @param {{ endpoint: string, keys: { p256dh: string, auth: string } }} subscription
 * @param {string} payload JSON the service worker will read
 * @param {{ publicKey: string, privateKey: string, subject: string }} vapid
 * @param {{ ttl?: number, urgency?: string }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string, gone?: boolean }>}
 */
export async function sendPush(subscription, payload, vapid, opts = {}) {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return { ok: false, error: 'incomplete-subscription', gone: true };
  }

  let body;
  try {
    body = encryptPayload(subscription.keys, payload);
  } catch (err) {
    // A subscription whose keys will not parse can never be encrypted to, so it
    // is retired rather than retried.
    return { ok: false, error: `encrypt: ${String(err?.message ?? err)}`, gone: true };
  }

  try {
    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        authorization: vapidHeader(subscription.endpoint, vapid),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(opts.ttl ?? DEFAULT_TTL),
        // The default urgency wakes a phone. An alert about a blog post is worth
        // reading, not worth waking up for.
        urgency: opts.urgency ?? 'normal',
      },
      body,
    });

    if (res.ok) return { ok: true };

    // 404 and 410 are the push services' way of saying the browser is gone —
    // uninstalled, site data cleared, permission revoked. There is nothing to
    // retry and the row should stop being tried.
    const gone = res.status === 404 || res.status === 410;
    const detail = await res.text().catch(() => '');
    return { ok: false, gone, error: `push-${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}` };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}
