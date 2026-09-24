import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createECDH, createDecipheriv, createHmac, createPrivateKey, createPublicKey, verify } from 'node:crypto';

import { encrypt } from '@profullstack/notifications/server';

import { generateVapidKeys, vapidConfig, sendPush } from '../src/webpush.js';

/**
 * The push sender, checked against the specification rather than against
 * itself.
 *
 * The encryption and signing now come from `@profullstack/notifications`, but
 * this is still the one part of the feature where a bug is invisible from the
 * outside: a wrongly derived key produces a body a push service accepts,
 * forwards, and a browser silently fails to decrypt. So the published worked
 * example from RFC 8291 §5 stays here, pinned against the package, and the
 * adapter is checked for the request it actually puts on the wire.
 */

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (value) => Buffer.from(String(value ?? ''), 'base64url');

// RFC 8291 §5, verbatim.
const VECTOR = {
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  plaintext: 'When I grow up, I want to be a watermelon',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const SUBSCRIPTION = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123?x=1',
  keys: { p256dh: VECTOR.uaPublic, auth: VECTOR.auth },
};

test('encryption reproduces the RFC 8291 worked example exactly', () => {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(fromB64url(VECTOR.asPrivate));
  const point = ecdh.getPublicKey();
  const privateKey = createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: VECTOR.asPrivate,
      x: b64url(point.subarray(1, 33)),
      y: b64url(point.subarray(33, 65)),
    },
  });

  const body = encrypt(SUBSCRIPTION, Buffer.from(VECTOR.plaintext), {
    privateKey,
    publicKey: point,
    salt: fromB64url(VECTOR.salt),
  });

  assert.equal(b64url(body), VECTOR.body);
});

/**
 * Send one push through a stub push service and return what it received.
 *
 * @param {{ status?: number, env?: object }} [opts]
 */
async function capture({ status = 201 } = {}) {
  const keys = generateVapidKeys();
  const vapid = { ...keys, subject: 'mailto:hello@example.com' };
  /** @type {{ url: string, init: any }[]} */
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status });
  };
  const payload = JSON.stringify({ title: 'A post', url: 'https://example.com/p' });
  const result = await sendPush(SUBSCRIPTION, payload, vapid, { fetch });
  return { result, calls, keys, payload };
}

test('a push is the encrypted, signed request a push service expects', async () => {
  const before = Math.floor(Date.now() / 1000);
  const { result, calls, keys, payload } = await capture();

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.equal(url, SUBSCRIPTION.endpoint);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-encoding'], 'aes128gcm');
  // Four hours, and not urgent: an alert about a blog post is worth reading,
  // not worth waking a phone for.
  assert.equal(init.headers.ttl, '14400');
  assert.equal(init.headers.urgency, 'normal');

  const header = init.headers.authorization;
  const token = /t=([^,]+)/.exec(header)?.[1] ?? '';
  const [head, claims, signature] = token.split('.');
  const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString());

  assert.deepEqual(decode(head), { typ: 'JWT', alg: 'ES256' });
  const decoded = decode(claims);
  // The origin only. A token whose audience carries the path is rejected with
  // a flat 401 and no explanation, which is a miserable thing to debug.
  assert.equal(decoded.aud, 'https://fcm.googleapis.com');
  assert.equal(decoded.sub, 'mailto:hello@example.com');
  assert.ok(decoded.exp - before <= 24 * 3600, 'within the 24 hours RFC 8292 allows');
  assert.equal(/k=(.+)$/.exec(header)?.[1], keys.publicKey, 'the public key travels with it');

  const point = fromB64url(keys.publicKey);
  const pub = createPublicKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33, 65)) },
  });
  assert.ok(
    verify('sha256', Buffer.from(`${head}.${claims}`), { key: pub, dsaEncoding: 'ieee-p1363' }, fromB64url(signature)),
  );

  const body = Buffer.from(init.body);
  assert.equal(body.readUInt32BE(16), 4096, 'the record size');
  assert.equal(decryptAsBrowser(body, VECTOR.uaPrivate, VECTOR.uaPublic, VECTOR.auth), payload);
});

test('404 and 410 mean the browser is gone', async () => {
  for (const status of [404, 410]) {
    const { result } = await capture({ status });
    assert.deepEqual(result, { ok: false, gone: true, error: `push-${status}` });
  }
});

test('any other failure is counted, not retired', async () => {
  const { result } = await capture({ status: 500 });
  assert.deepEqual(result, { ok: false, gone: false, error: 'push-500' });
});

test('a subscription that cannot be encrypted to is retired without a request', async () => {
  const vapid = { ...generateVapidKeys(), subject: 'mailto:x@y.z' };
  let called = false;
  const fetch = async () => {
    called = true;
    return new Response(null, { status: 201 });
  };
  const result = await sendPush({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'k', auth: 'a' } }, '{}', vapid, { fetch });
  assert.deepEqual(result, { ok: false, error: 'incomplete-subscription', gone: true });
  assert.equal(called, false);
});

test('generated keys are a 65-byte uncompressed point and a 32-byte scalar', () => {
  const keys = generateVapidKeys();

  const point = fromB64url(keys.publicKey);
  assert.equal(point.length, 65);
  assert.equal(point[0], 0x04);
  assert.equal(fromB64url(keys.privateKey).length, 32);
});

test('an unconfigured deployment reports no push rather than throwing', () => {
  assert.equal(vapidConfig({}), null);
  assert.equal(vapidConfig({ VAPID_PUBLIC_KEY: 'only-half' }), null);

  const config = vapidConfig({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' });
  assert.equal(config?.publicKey, 'pub');
  assert.equal(config?.privateKey, 'priv');
  assert.match(String(config?.subject), /^mailto:/, 'RFC 8292 requires a contact');
  assert.equal(
    vapidConfig({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:ops@example.com' })?.subject,
    'mailto:ops@example.com',
  );
});

/**
 * Decrypt the way a browser would, from the subscription's private key.
 *
 * Written out rather than shared with the sender so the test is not checking one
 * implementation against itself: this follows RFC 8188's framing back from the
 * bytes on the wire.
 *
 * @param {Buffer} body
 * @param {string} uaPrivate
 * @param {string} uaPublic
 * @param {string} auth
 * @returns {string}
 */
function decryptAsBrowser(body, uaPrivate, uaPublic, auth) {
  const salt = body.subarray(0, 16);
  const keyLength = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + keyLength);
  const sealed = body.subarray(21 + keyLength);

  const ua = createECDH('prime256v1');
  ua.setPrivateKey(fromB64url(uaPrivate));

  const expand = (s, ikm, info, length) => {
    const prk = createHmac('sha256', s).update(ikm).digest();
    return createHmac('sha256', prk).update(info).update(Buffer.of(1)).digest().subarray(0, length);
  };

  const ikm = expand(
    fromB64url(auth),
    ua.computeSecret(asPublic),
    Buffer.concat([Buffer.from('WebPush: info\0'), fromB64url(uaPublic), asPublic]),
    32,
  );

  const decipher = createDecipheriv(
    'aes-128-gcm',
    expand(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
    expand(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12),
  );
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));

  const plain = Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - 16)),
    decipher.final(),
  ]);

  // The last byte is the 0x02 record delimiter, not content.
  return plain.subarray(0, plain.length - 1).toString('utf8');
}
