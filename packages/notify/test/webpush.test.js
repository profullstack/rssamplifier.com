import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createECDH, createDecipheriv, createHmac, createPublicKey, verify } from 'node:crypto';

import {
  b64url,
  fromB64url,
  encryptPayload,
  vapidHeader,
  generateVapidKeys,
  vapidConfig,
} from '../src/webpush.js';

/**
 * The push encryption, checked against the specification rather than against
 * itself.
 *
 * This is the one part of the feature where a bug is invisible from the outside:
 * a wrongly derived key produces a body a push service accepts, forwards, and a
 * browser silently fails to decrypt. Nothing anywhere reports an error. So the
 * test is the published worked example from RFC 8291 §5, with its salt and its
 * ephemeral key pinned — a round trip through our own code would agree with
 * itself no matter which way round the key info went.
 */

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

test('encryption reproduces the RFC 8291 worked example exactly', () => {
  const server = createECDH('prime256v1');
  server.setPrivateKey(fromB64url(VECTOR.asPrivate));

  const body = encryptPayload({ p256dh: VECTOR.uaPublic, auth: VECTOR.auth }, VECTOR.plaintext, {
    salt: fromB64url(VECTOR.salt),
    serverKeys: server,
  });

  assert.equal(b64url(body), VECTOR.body);
});

test('the header block is the aes128gcm framing a browser expects', () => {
  const body = encryptPayload({ p256dh: VECTOR.uaPublic, auth: VECTOR.auth }, 'hi');

  assert.equal(body.subarray(0, 16).length, 16, 'a 16-byte salt');
  assert.equal(body.readUInt32BE(16), 4096, 'the record size');
  assert.equal(body.readUInt8(20), 65, 'the key length');
  assert.equal(body.readUInt8(21), 0x04, 'an uncompressed point follows');
});

test('a fresh key pair and salt are used for every message', () => {
  const keys = { p256dh: VECTOR.uaPublic, auth: VECTOR.auth };
  const first = encryptPayload(keys, 'same text');
  const second = encryptPayload(keys, 'same text');

  // Reuse would mean reusing the AES nonce for a key, which is the failure that
  // makes two ciphertexts readable against each other.
  assert.notEqual(b64url(first), b64url(second));
  assert.notEqual(b64url(first.subarray(0, 16)), b64url(second.subarray(0, 16)));
});

test('a browser holding the subscription can read what we send', () => {
  const payload = JSON.stringify({ title: 'A post', url: 'https://example.com/p' });
  const body = encryptPayload({ p256dh: VECTOR.uaPublic, auth: VECTOR.auth }, payload);

  assert.equal(decryptAsBrowser(body, VECTOR.uaPrivate, VECTOR.uaPublic, VECTOR.auth), payload);
});

test('a VAPID header is a signature over the right claims', () => {
  const keys = generateVapidKeys();
  const now = 1_700_000_000_000;

  const header = vapidHeader(
    'https://fcm.googleapis.com/fcm/send/abc123?x=1',
    { ...keys, subject: 'mailto:hello@example.com' },
    { now },
  );

  const token = /t=([^,]+)/.exec(header)?.[1] ?? '';
  const [head, claims, signature] = token.split('.');
  const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString());

  assert.deepEqual(decode(head), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(decode(claims), {
    // The origin only. A token whose audience carries the path is rejected with
    // a flat 401 and no explanation, which is a miserable thing to debug.
    aud: 'https://fcm.googleapis.com',
    exp: now / 1000 + 43_200,
    sub: 'mailto:hello@example.com',
  });

  assert.equal(/k=(.+)$/.exec(header)?.[1], keys.publicKey, 'the public key travels with it');

  const point = fromB64url(keys.publicKey);
  const pub = createPublicKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33, 65)) },
  });

  assert.ok(
    verify(
      'sha256',
      Buffer.from(`${head}.${claims}`),
      // The raw r||s pair. Node's default DER wrapping is what every push
      // service rejects as a malformed signature.
      { key: pub, dsaEncoding: 'ieee-p1363' },
      fromB64url(signature),
    ),
  );
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
  assert.match(String(config?.subject), /^mailto:/, 'RFC 8292 requires a contact');
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
