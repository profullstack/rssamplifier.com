/**
 * Give the feeds that state no dates a change history, so they stop being
 * fetched hourly for ever.
 *
 * Run with `node --env-file=.env scripts/seed-change-log.js` to see what it
 * would do, and `--apply` to do it.
 *
 * ## Why this exists
 *
 * `reschedule-feeds.js` moved the directory onto the rhythm-based schedule and
 * took steady-state demand from 62,700 crawls an hour to about 700. It could
 * only move feeds whose stored posts carry dates, and it says so: *"it does not
 * touch feeds with no stored items"*, and it skips anything with no usable
 * `published_at`.
 *
 * That residue turns out to be the entire remaining problem. Measured on
 * production 2026-08-19:
 *
 *     dated feeds      79,941   avg interval 54,567 min   1,511 crawls/hour
 *     undated feeds     1,653   avg interval    105 min   1,183 crawls/hour
 *
 * Two percent of the active directory asking for forty-four percent of the
 * work. Not because those feeds are busy -- 1,611 of the 1,653 sat at six hours
 * or less -- but because there was no evidence about them at all, so they fell
 * to the doubling ladder, and the ladder returns to its sixty-minute floor
 * whenever a crawl stores anything. A feed whose guids churn stores something
 * every time and so never left the floor. Sampling them, most had `item_count =
 * 0`: they parse, they are simply empty, and they had been read every hour for
 * months to be told so again.
 *
 * `cadence.js` now schedules these on `change_log` -- the times we watched a
 * feed's contents change -- but that column fills in only as feeds are
 * re-crawled, and these are precisely the feeds whose crawls we are trying to
 * stop paying for. Left alone, a feed would sit at the floor until its own decay
 * pulled it off, which is the same circular wait `reschedule-feeds.js` was
 * written to break.
 *
 * ## The evidence it uses
 *
 * `feed_items.created_at` is when the crawler first *stored* an item, which is
 * an observation on our clock and exactly what the change log holds. So the last
 * time a feed's contents demonstrably changed is `max(created_at)` over its
 * items -- an indexed lookup per chunk, not the feed_items-to-feeds aggregate
 * that 0017 established must never be run.
 *
 * For a feed with no items at all, that falls back to when the feed was
 * submitted. "We have known about this feed since March and have never seen
 * anything in it" is a weaker claim than a real observation and it is still a
 * true one, and it is the only evidence those feeds will ever offer.
 *
 * ## What it deliberately does not do
 *
 * **It never shortens an interval.** Every feed's new schedule is the longer of
 * what it already had and what the change history implies. A backfill that could
 * pull feeds forward would be able to create the herd it is meant to prevent.
 *
 * **It does not touch pending feeds.** Those have never been crawled once;
 * pushing their first read away is not this script's business.
 *
 * **It does not touch dated feeds.** They are already scheduled on their own
 * rhythm, which is better evidence than anything here.
 *
 * **It writes no `content_hash`.** There is no way to know one without the
 * document, so the first crawl after this establishes it -- and because a feed
 * with no stored fingerprint counts as changed, that first crawl also records a
 * change and nothing decays on a fingerprint that was never taken.
 *
 * ## The spread
 *
 * `next_fetch_at` is scattered across the chosen interval rather than set to
 * `now + interval`, for the reason `reschedule-feeds.js` gives: otherwise every
 * feed touched by one run comes due in the same minute and the herd is postponed
 * rather than removed.
 */

import { connect } from '@rssamplifier/db';

/** Feeds read per round trip. One grouped query answers the whole chunk. */
const CHUNK = 200;

/** Feeds written per transaction. Write transactions are the scarce thing. */
const WRITE_CHUNK = 25;

const MIN_INTERVAL = 60;
const MAX_INTERVAL = 129_600; // 90 days, matching packages/ingest/src/cadence.js

const apply = process.argv.includes('--apply');
const db = connect();

/**
 * The silence branch of `scheduleFrom`, which is all a single observation
 * supports -- one instant has no gaps in it and therefore no rhythm.
 *
 * @param {number} silenceMinutes
 * @returns {number}
 */
function intervalFor(silenceMinutes) {
  const n = silenceMinutes / 4;
  if (!Number.isFinite(n)) return MIN_INTERVAL;
  return Math.round(Math.min(Math.max(n, MIN_INTERVAL), MAX_INTERVAL));
}

/**
 * Scatter a feed across its interval so a run does not create one herd.
 *
 * Deterministic in the feed's own id rather than random, so a re-run moves a
 * feed to the same place and the operation is idempotent.
 *
 * @param {string} id
 * @returns {number} 0..1
 */
function scatter(id) {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 10_000) / 10_000;
}

const now = Date.now();
const buckets = new Map();
const bump = (k) => buckets.set(k, (buckets.get(k) ?? 0) + 1);

let cursor = '';
let seen = 0;
let planned = 0;
let written = 0;
let demandBefore = 0;
let demandAfter = 0;
/** @type {Array<{sql: string, args: unknown[]}>} */
let pending = [];

/**
 * @returns {Promise<void>}
 */
async function flush() {
  if (pending.length === 0) return;
  if (apply) {
    const started = Date.now();
    await db.batch(pending, 'write');
    written += pending.length;
    // Reported per transaction rather than per thousand rows, because on this
    // database the transaction is the unit that can fail and the one whose cost
    // is worth watching.
    if (written % 200 === 0 || Date.now() - started > 5000) {
      process.stdout.write(`  ${written} written (last txn ${Date.now() - started}ms)\n`);
    }
  }
  pending = [];
}

for (;;) {
  // `change_log is null` is the resume condition, and it is what makes this safe
  // to re-run: a feed this script has already settled carries the column, and
  // one it has not, does not. Every earlier backfill against this database died
  // partway through on a write timeout, so resuming is not a nicety.
  const { rows } = await db.execute({
    sql: `select id, slug, created_at, item_count, fetch_interval_minutes
          from feeds
          where status = 'active' and last_published_at is null and change_log is null and id > ?
          order by id limit ?`,
    args: [cursor, CHUNK],
  });
  if (rows.length === 0) break;

  cursor = String(rows[rows.length - 1].id);
  seen += rows.length;

  const ids = rows.map((r) => String(r.id));
  const marks = ids.map(() => '?').join(',');
  const { rows: stored } = await db.execute({
    sql: `select feed_id, max(created_at) as newest
          from feed_items where feed_id in (${marks}) group by feed_id`,
    args: ids,
  });

  const newestBy = new Map(stored.map((d) => [String(d.feed_id), d.newest]));

  for (const row of rows) {
    const id = String(row.id);
    const held = Number(row.fetch_interval_minutes) || MIN_INTERVAL;

    // When this feed's contents last demonstrably changed: the newest item we
    // ever stored, or -- for a feed that has never held anything -- when we
    // first heard of it.
    const raw = newestBy.get(id) ?? row.created_at;
    const t = raw ? Date.parse(String(raw)) : Number.NaN;

    if (!Number.isFinite(t) || t > now) {
      // No honest instant to record. Leaving the column null keeps the feed on
      // the doubling ladder, which is where it already was.
      bump('skipped: no usable observation');
      continue;
    }

    const silence = Math.max(0, (now - t) / 60_000);
    // Never sooner than the feed is already scheduled, matching `neverSooner`
    // in cadence.js: this is evidence of *no* change, and evidence of no change
    // may lengthen an interval and never shorten one.
    const interval = Math.max(intervalFor(silence), held);
    const next = new Date(now + scatter(id) * interval * 60_000).toISOString();

    planned += 1;
    demandBefore += 60 / held;
    demandAfter += 60 / interval;

    const d = interval / 1440;
    bump(
      d < 1
        ? 'a: under a day'
        : d < 7
          ? 'b: 1-7 days'
          : d < 30
            ? 'c: 1-4 weeks'
            : d < 90
              ? 'd: 1-3 months'
              : 'e: at the 90-day ceiling',
    );

    pending.push({
      sql: `update feeds set
              change_log = ?,
              fetch_interval_minutes = ?,
              next_fetch_at = ?
            where id = ?`,
      args: [JSON.stringify([new Date(t).toISOString()]), interval, next, id],
    });

    if (pending.length >= WRITE_CHUNK) await flush();
  }

  if (seen % 1000 < CHUNK) {
    console.log(`  …${seen} seen, ${planned} settled${apply ? `, ${written} written` : ''}`);
  }
}

await flush();

console.log(`\n${apply ? 'Settled' : 'Would settle'} ${planned} of ${seen} undated active feeds.\n`);
for (const k of [...buckets.keys()].sort()) {
  console.log(`  ${k.padEnd(30)} ${String(buckets.get(k)).padStart(6)}`);
}

// The number the whole exercise is about.
console.log(
  `\nDemand from these feeds: ${Math.round(demandBefore)} crawls/hour -> ${Math.round(demandAfter)}`,
);
if (!apply) console.log('\nDry run. Pass --apply to write.');
