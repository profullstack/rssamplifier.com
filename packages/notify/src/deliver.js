import { alerts, nowIso } from '@rssamplifier/db';
import { sendEmail, emailEnabled } from '@rssamplifier/mail';

import { sendPush, vapidConfig } from './webpush.js';
import { postWebhook } from './webhook.js';
import { alertItem, renderEmail, renderPush, renderWebhook, siteOrigin } from './render.js';

/**
 * The sender: what turns a follow with a bell on it into a message.
 *
 * Runs in the poller, on its own timer, for the same reason the crawl does — it
 * is slow, outbound, and nobody is waiting on it. It is written to be safe to
 * kill at any moment, which is the constraint that shapes most of what follows:
 * a deploy lands mid-batch several times a day.
 *
 * The invariants, in the order they matter:
 *
 *   1. **Never alert about the backlog.** An account that has just switched
 *      alerts on has no watermark, and the answer to that is "start from now",
 *      not "mail them two years of a topic they discovered this afternoon".
 *   2. **Never advance past what was looked at.** Each source is read with a
 *      limit, so a source that filled its limit has more behind it; the
 *      watermark stops at the earliest such boundary rather than at the newest
 *      row seen.
 *   3. **Record before sending.** A crash between the two costs one missed post,
 *      which the river still has. The other order costs a duplicate in
 *      somebody's inbox, which nothing can take back.
 */

/**
 * How each kind of channel is actually delivered to.
 *
 * A seam rather than a plugin system: the three real implementations are right
 * here, and the only caller that ever replaces them is the test, which needs to
 * read what was sent without a mail provider, a push service or a public URL to
 * send it to. Keeping them in one object also makes the shape they share
 * explicit — every one of them reports an outcome rather than throwing.
 */
const TRANSPORT = {
  /** @param {{ to: string, subject: string, text: string }} message */
  email: (message) => sendEmail(message),
  /**
   * @param {{ endpoint: string, keys: object }} subscription
   * @param {string} payload
   * @param {object} vapid
   */
  push: (subscription, payload, vapid) => sendPush(subscription, payload, vapid),
  /**
   * @param {string} url
   * @param {object} payload
   * @param {{ secret?: string }} opts
   */
  webhook: (url, payload, opts) => postWebhook(url, payload, opts),
  /** Whether email can be sent at all. */
  emailEnabled: () => emailEnabled(),
};

/** Accounts examined per pass. */
const USERS_PER_PASS = 25;

/** Posts read from each of an account's sources per pass. */
const PER_SOURCE = 50;

/**
 * Posts one message may carry.
 *
 * A ceiling on the message, not on the account: anything past it stays behind
 * the watermark and arrives on the next pass, in order. A reader following a
 * firehose gets several digests rather than one enormous one, and — the part
 * that matters — never silently loses the middle of it.
 */
const ITEMS_PER_MESSAGE = 25;

/**
 * Alerting topics read per account.
 *
 * One query each, so this is the per-account cost of a pass. Lower than the
 * river's twelve because this runs unattended on every tick rather than once
 * when somebody opens a page.
 */
const TOPICS_PER_PASS = 8;

/**
 * Deliver everything owed, to everyone owed it.
 *
 * @param {import('@libsql/client').Client} db
 * @param {{
 *   users?: number,
 *   perSource?: number,
 *   itemsPerMessage?: number,
 *   topics?: number,
 *   origin?: string,
 *   vapid?: object|null,
 *   now?: () => string,
 *   transport?: typeof TRANSPORT,
 * }} [opts]
 * @returns {Promise<{ users: number, alerted: number, items: number, sent: number, failed: number }>}
 */
export async function deliverAlerts(db, opts = {}) {
  const {
    users = USERS_PER_PASS,
    perSource = PER_SOURCE,
    itemsPerMessage = ITEMS_PER_MESSAGE,
    topics = TOPICS_PER_PASS,
    origin = siteOrigin(),
    vapid = vapidConfig(),
    now = nowIso,
    transport = TRANSPORT,
  } = opts;

  const candidates = await alerts.usersWithAlerts(db, users);
  const totals = { users: candidates.length, alerted: 0, items: 0, sent: 0, failed: 0 };

  for (const user of candidates) {
    const result = await deliverForUser(db, user, {
      perSource,
      itemsPerMessage,
      topics,
      origin,
      vapid,
      now,
      transport,
    });

    if (result.items > 0) totals.alerted += 1;
    totals.items += result.items;
    totals.sent += result.sent;
    totals.failed += result.failed;
  }

  return totals;
}

/**
 * One account's turn.
 *
 * @param {import('@libsql/client').Client} db
 * @param {{ id: string, email: string }} user
 * @param {object} opts
 * @returns {Promise<{ items: number, sent: number, failed: number }>}
 */
async function deliverForUser(db, user, opts) {
  const userId = user.id;
  const cursor = await alerts.alertCursor(db, userId);

  // Never seen before: start the clock now. Everything published up to this
  // moment is backlog, and backlog belongs in the river, not in an inbox.
  if (!cursor) {
    await alerts.setAlertCursor(db, userId, opts.now());
    return { items: 0, sent: 0, failed: 0 };
  }

  const sources = await readSources(db, userId, cursor, opts);
  const { batch, nextCursor } = await selectBatch(db, userId, sources, cursor, opts.itemsPerMessage);

  // Moved whether or not anything is being sent — a pass that found only posts
  // this account had already been told about must still not look at them again.
  if (nextCursor !== cursor) await alerts.setAlertCursor(db, userId, nextCursor);
  else await alerts.touchAlertState(db, userId);

  if (batch.length === 0) return { items: 0, sent: 0, failed: 0 };

  // Before the sending, deliberately. See the third invariant above.
  await alerts.markSent(db, userId, batch.map((entry) => entry.key));

  const items = batch.map((entry) => alertItem(entry.row, entry.via, opts.origin));
  const { sent, failed } = await fanOut(db, user, items, opts);

  return { items: items.length, sent, failed };
}

/**
 * Read everything new from everything this account has alerting.
 *
 * @param {import('@libsql/client').Client} db
 * @param {string} userId
 * @param {string} cursor
 * @param {object} opts
 * @returns {Promise<Array<{ via: object, rows: object[], capped: boolean }>>}
 */
async function readSources(db, userId, cursor, opts) {
  const alerting = await alerts.alertedTopics(db, userId, opts.topics);

  const [feedRows, topicSources] = await Promise.all([
    alerts.newItemsFromAlertedFeeds(db, userId, cursor, opts.perSource),
    Promise.all(
      alerting.map(async (follow) => {
        const slug = String(follow.slug);
        const segment = String(follow.segment ?? '');
        const rows = await alerts.newItemsForTopic(db, slug, cursor, {
          segment,
          limit: opts.perSource,
        });

        return { via: topicVia(follow), rows, capped: rows.length >= opts.perSource };
      }),
    ),
  ]);

  return [
    // The blogs are one source: they are one query, and a post from a followed
    // blog is attributed to the blog, which every row already carries.
    { via: { kind: 'feed', title: '', href: '' }, rows: feedRows, capped: feedRows.length >= opts.perSource },
    ...topicSources,
  ];
}

/**
 * What one topic follow is called in an alert, and where it points.
 *
 * A trimmed-down `topicLabel` — the web app's version reaches for the sub-group
 * table to build a heading, and an alert needs the name and the address only.
 *
 * @param {{ slug: unknown, segment?: unknown, keyword?: unknown }} follow
 * @returns {{ kind: string, title: string, href: string }}
 */
export function topicVia(follow) {
  const slug = String(follow.slug ?? '');
  const segment = String(follow.segment ?? '').toLowerCase();
  const keyword = String(follow.keyword || slug);
  const path = `/topics/${encodeURIComponent(slug)}`;

  // An unrecognised segment is shown as the whole topic rather than as a broken
  // label, matching what the topic pages do with the same input.
  if (!segment || !Object.hasOwn(alerts.SEGMENT_KINDS, segment)) {
    return { kind: 'topic', title: keyword, href: path };
  }

  return { kind: 'topic', title: `${keyword}: ${segment}`, href: `${path}/${segment}` };
}

/**
 * Choose what to send, and where the watermark lands.
 *
 * The awkward part of the whole feature, and the awkwardness is real rather than
 * incidental: several sources are each read with their own limit, and the
 * watermark is a single point in time that must not pass anything unread.
 *
 * So the horizon is the *earliest* boundary among the sources that filled their
 * limit. A source that returned fewer rows than it was allowed has been read to
 * the end and constrains nothing; a source that filled up has more behind it,
 * and the watermark stopping at its last row is what guarantees the rest is
 * picked up next pass instead of being stepped over.
 *
 * @param {import('@libsql/client').Client} db
 * @param {string} userId
 * @param {Array<{ via: object, rows: object[], capped: boolean }>} sources
 * @param {string} cursor
 * @param {number} itemsPerMessage
 * @returns {Promise<{ batch: Array<{ row: object, via: object, key: string }>, nextCursor: string }>}
 */
export async function selectBatch(db, userId, sources, cursor, itemsPerMessage) {
  const horizons = sources
    .filter((source) => source.capped && source.rows.length > 0)
    .map((source) => String(source.rows[source.rows.length - 1].created_at));

  // ISO-8601 in a fixed shape sorts lexicographically, which is the whole reason
  // the timestamps are stored as text rather than as epoch numbers.
  const horizon = horizons.length ? horizons.slice().sort()[0] : null;

  const pool = sources
    .flatMap(({ via, rows }) => rows.map((row) => ({ row, via })))
    .filter((entry) => !horizon || String(entry.row.created_at) <= horizon)
    .sort((a, b) => String(a.row.created_at).localeCompare(String(b.row.created_at)));

  const furthest = pool.length ? String(pool[pool.length - 1].row.created_at) : null;
  // With nothing capped, the pass read every source to the end, so the watermark
  // may go as far as the newest thing seen.
  const exhaustedCursor = horizon ?? furthest ?? cursor;

  // One entry per story. The pool is oldest-first and the first occurrence wins,
  // so a story that reached this account through both a blog and a topic is
  // attributed to whichever telling arrived first.
  const seen = new Set();
  const unique = [];
  for (const entry of pool) {
    const key = alerts.itemKey(entry.row);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...entry, key });
  }

  const sent = await alerts.alreadySent(db, userId, unique.map((entry) => entry.key));
  const fresh = unique.filter((entry) => !sent.has(entry.key));

  if (fresh.length <= itemsPerMessage) {
    // Newest first for the reader: the pool was built oldest-first because the
    // watermark cares about order, and a digest does not.
    return { batch: fresh.reverse(), nextCursor: exhaustedCursor };
  }

  // Truncated. The watermark stops at this batch's last row so the remainder is
  // sent — in order — on the next pass rather than being skipped.
  let end = itemsPerMessage;
  const boundary = String(fresh[end - 1].row.created_at);
  // Everything sharing that instant comes too. The watermark comparison is
  // strictly greater-than, so a sibling left behind at exactly the boundary
  // would never be looked at again.
  while (end < fresh.length && String(fresh[end].row.created_at) === boundary) end += 1;

  return { batch: fresh.slice(0, end).reverse(), nextCursor: boundary };
}

/**
 * Send one batch to every channel the account has switched on.
 *
 * Channels are independent: a webhook that 500s must not stop the email, and one
 * dead phone must not stop the other one. Every outcome is recorded against its
 * own channel, which is what lets a channel retire itself after enough failures
 * without taking the account's alerts down with it.
 *
 * @param {import('@libsql/client').Client} db
 * @param {{ id: string, email: string }} user
 * @param {object[]} items
 * @param {object} opts
 * @returns {Promise<{ sent: number, failed: number }>}
 */
async function fanOut(db, user, items, opts) {
  const channels = await alerts.deliverableChannels(db, user.id);
  let sent = 0;
  let failed = 0;

  // Rendered once and reused across every channel of a kind: two phones get the
  // same notification, and building it twice would be building it twice.
  const email = renderEmail(items, { origin: opts.origin });
  const push = JSON.stringify(renderPush(items, { origin: opts.origin }));
  const hook = renderWebhook(items, { origin: opts.origin, at: opts.now() });

  for (const channel of channels) {
    const result = await deliverToChannel(channel, {
      email,
      push,
      hook,
      vapid: opts.vapid,
      transport: opts.transport,
    });

    // `null` is "this channel cannot be delivered to right now, through no fault
    // of its own" — no mail provider, no push keys. Not a failure to record: the
    // channel is fine and counting against it would eventually retire it for the
    // deployment's missing configuration.
    if (result === null) continue;

    await alerts.recordChannelResult(db, channel.id, result);
    if (result.ok) sent += 1;
    else failed += 1;
  }

  return { sent, failed };
}

/**
 * @param {{ id: string, kind: string, target: string, secret: object|null }} channel
 * @param {{ email: object, push: string, hook: object, vapid: object|null, transport: typeof TRANSPORT }} message
 * @returns {Promise<{ ok: boolean, error?: string, gone?: boolean }|null>}
 */
async function deliverToChannel(channel, message) {
  const transport = message.transport;

  if (channel.kind === 'email') {
    if (!transport.emailEnabled()) return null;
    return transport.email({
      to: channel.target,
      subject: message.email.subject,
      text: message.email.text,
    });
  }

  if (channel.kind === 'web') {
    if (!message.vapid) return null;
    return transport.push(
      { endpoint: channel.target, keys: /** @type {any} */ (channel.secret ?? {}) },
      message.push,
      message.vapid,
    );
  }

  if (channel.kind === 'webhook') {
    return transport.webhook(channel.target, message.hook, {
      secret: channel.secret?.['secret'] ? String(channel.secret['secret']) : undefined,
    });
  }

  // A kind this build does not know how to deliver. Retired rather than retried:
  // it will not become deliverable by being tried again.
  return { ok: false, error: `unknown-channel-kind: ${channel.kind}`, gone: true };
}
