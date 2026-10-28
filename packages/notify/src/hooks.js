import { Webhooks, postgresStore, sha256Header } from '@profullstack/webhooks';
import { alerts } from '@rssamplifier/db';

import { siteOrigin } from './render.js';
import { SIGNATURE_HEADER } from './webhook.js';

/**
 * Webhooks, through the fleet's shared hub (@profullstack/webhooks).
 *
 * Until 2026-10-28 a webhook was one more `alert_channels` row, sent with one
 * POST and one `x-rssamplifier-signature` header by ./webhook.js. It is now an
 * endpoint in the hub's `webhook_endpoints` table, which buys what the bespoke
 * sender never had: Standard Webhooks signatures, a delivery log, test pings,
 * secret rotation, a /api/v1/webhooks API, and a short retry.
 *
 * What a receiver that predates the move sees: the same header, signed the same
 * way (HMAC-SHA256 of the exact body, keyed with the secret they chose; see
 * `legacySecret` for how their secret was carried over), alongside the
 * Standard Webhooks headers. The body is now a CloudEvents envelope, and the
 * old body is its `data`.
 */

/** The one thing that happens here worth telling a webhook about. */
export const ALERT_EVENT = 'posts.published';

/** Every event type this app emits; endpoint filters must match one. */
export const EVENT_TYPES = [ALERT_EVENT];

/**
 * Wait before attempt 2 and 3: thirty seconds, then two minutes.
 *
 * Short on purpose. The old sender made one attempt and said why: a receiver
 * that is down for an hour is better served by the river at /following than by
 * an hour of queued digests landing at once. That still holds, so this is not
 * the hub's three-day schedule; it only rides out a deploy or a blip on the
 * receiving end, which the single attempt used to lose for good (the watermark
 * moves past a batch whether or not its webhook answered).
 */
export const BACKOFF_MS = [30_000, 120_000];

/**
 * Failed attempts in a row that switch an endpoint off.
 *
 * The old rule was five failed alerts in a row (MAX_CHANNEL_FAILURES). The hub
 * counts attempts, and each alert now gets up to three, so the same five alerts
 * are fifteen attempts.
 */
export const DISABLE_AFTER = alerts.MAX_CHANNEL_FAILURES * (BACKOFF_MS.length + 1);

/** What the requests say they are, as before. */
export const USER_AGENT = 'rssamplifier-alerts/1.0 (+https://rssamplifier.com/alerts)';

/**
 * A pre-hub secret in the hub's form, with the same HMAC key bytes.
 *
 * The old sender keyed its HMAC with the UTF-8 bytes of whatever string the
 * reader typed. The hub reads a `whsec_<base64>` secret as the base64-decoded
 * bytes, so storing the old string as-is would change every signature (and a
 * typed secret that happened to start with `whsec_` would be decoded). Storing
 * `whsec_` + base64(utf8(old)) gives the hub exactly the old key bytes, so
 * `x-rssamplifier-signature` comes out identical and the receiver keeps
 * verifying with the string it already has.
 *
 * The SQL migration (20261028120000_webhooks.sql) does the same conversion in
 * Postgres; the test pins the two together.
 *
 * @param {string} old
 * @returns {string}
 */
export function legacySecret(old) {
  return `whsec_${Buffer.from(String(old), 'utf8').toString('base64')}`;
}

const legacySignature = sha256Header(SIGNATURE_HEADER);

/**
 * The headers a pre-hub receiver checks: the old signature and user agent.
 *
 * @param {{ body: string, secret: string }} input
 * @returns {Record<string, string>}
 */
export function legacyHeaders(input) {
  return { ...legacySignature(input), 'user-agent': USER_AGENT };
}

/**
 * The pg pool behind the app's libSQL-shaped client.
 *
 * @param {any} db
 * @returns {{ query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }}
 */
export function poolOf(db) {
  const pool = db?.pool;
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('webhooks: the database client exposes no pg pool');
  }
  return pool;
}

/**
 * The hub, on the app's own Postgres.
 *
 * The tables come from the app's migrations (schemaSql('pg') is pasted into
 * migrations-pg/20261028120000_webhooks.sql), so the store does not create them.
 * The poller calls `.start()` and is the only process that drains; the web app
 * builds one too, for the API and the settings page, and never starts it.
 *
 * @param {any} db the client from `connect()`
 * @param {Partial<import('@profullstack/webhooks').WebhooksOptions>} [opts]
 * @returns {import('@profullstack/webhooks').Webhooks}
 */
export function createHooks(db, opts = {}) {
  return new Webhooks({
    store: opts.store ?? postgresStore(poolOf(db)),
    source: siteOrigin(),
    eventTypes: EVENT_TYPES,
    maxEndpoints: alerts.MAX_CHANNELS_PER_USER,
    backoffMs: BACKOFF_MS,
    disableAfter: DISABLE_AFTER,
    extraHeaders: legacyHeaders,
    ...opts,
  });
}

export { webhooksApi, WebhookError } from '@profullstack/webhooks';
