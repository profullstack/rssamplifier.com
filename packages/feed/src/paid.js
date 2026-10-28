/**
 * The fetch the crawler reaches other people's sites with — paying when asked.
 *
 * A site behind an x402 gateway answers a crawler with 402 and an offer. The
 * shared crawler wallet pays it, buys the pass, files it by origin and
 * presents it on every later request to that site, so a gated site costs a
 * dollar a day rather than being silently empty.
 *
 * The key is sealed (fleet operator rule, 2026-10-28): `X402_SEALED_KEY` is
 * ciphertext, and the process pays only while an operator has unlocked it
 * with `x402 vault unlock http://127.0.0.1:<X402_UNLOCK_PORT>` (7 days by
 * default). While locked, or after a restart, payments pause: this is the
 * plain fetch and one `[alert]` line is logged. The plaintext
 * `X402_PRIVATE_KEY` still works only while no sealed key is set and
 * `X402_LEGACY_PLAINTEXT_KEY` is not "off" (the migration window).
 *
 * The ceiling is five dollars a payment. Env is read through a non-literal
 * accessor because Next inlines `process.env.NAME` at build time, and this
 * module is shared by the poller and the web reader.
 */

import { payerFromEnv } from '@profullstack/x402-client/sealed';

const env = globalThis.process?.env ?? {};
const read = (...parts) => env[parts.join('_')];
const SITE = read('X402', 'SITE') || 'rssamplifier.com';

/** The payer (sealed or, during migration, plaintext), or null when none is configured. */
export const x402 = payerFromEnv({
  site: SITE,
  env: {
    X402_SEALED_KEY: read('X402', 'SEALED', 'KEY'),
    X402_UNLOCK_PORT: read('X402', 'UNLOCK', 'PORT'),
    X402_UNLOCK_HOST: read('X402', 'UNLOCK', 'HOST'),
    X402_PRIVATE_KEY: read('X402', 'PRIVATE', 'KEY'),
    X402_LEGACY_PLAINTEXT_KEY: read('X402', 'LEGACY', 'PLAINTEXT', 'KEY'),
  },
  clientOptions: { maxUsd: 5 },
});

/** @type {typeof fetch} */
export const paidFetch = x402 ? (input, init) => x402.fetch(input, init) : (input, init) => globalThis.fetch(input, init);
