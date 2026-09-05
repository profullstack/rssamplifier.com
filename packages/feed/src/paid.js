/**
 * The fetch the crawler reaches other people's sites with — paying when asked.
 *
 * A site behind an x402 gateway answers a crawler with 402 and an offer. With
 * `X402_PRIVATE_KEY` set, the client signs the offer with the shared crawler
 * wallet, buys the pass, files it by origin and presents it on every later
 * request to that site, so a gated site costs a dollar a day rather than
 * being silently empty. Without the key this is the global fetch, unchanged.
 *
 * The ceiling is five dollars a payment: a hostile or misconfigured offer
 * cannot drain the wallet by asking. Read through a non-literal accessor
 * because Next inlines `process.env.NAME` at build time, and this module is
 * shared by the poller and the web reader.
 */

import { createClient } from '@profullstack/x402-client';

const key = globalThis.process?.env?.[['X402', 'PRIVATE_KEY'].join('_')];

/** The paying client, or null when no key is configured. */
export const x402 = key ? createClient({ key, maxUsd: 5 }) : null;

/** @type {typeof fetch} */
export const paidFetch = x402 ? (input, init) => x402.fetch(input, init) : (input, init) => globalThis.fetch(input, init);
