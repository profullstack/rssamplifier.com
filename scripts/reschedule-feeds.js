/**
 * Move the feeds already in the directory onto the rhythm-based schedule.
 *
 * Run with `node --env-file=.env scripts/reschedule-feeds.js` to see what it
 * would do, and `--apply` to do it.
 *
 * ## Why this exists
 *
 * `intervalFromDates` schedules a feed from its own publishing rhythm, and it
 * cut projected demand from 62,700 crawls an hour to 2,241 — but only for feeds
 * the crawler has *touched since it shipped*. Every row already in the table
 * still carries a `next_fetch_at` computed by the old ladder, which means all
 * 368k of them are still due roughly hourly and the backlog does not move.
 *
 * That is not a wait anybody can sit out. The crawler manages a few thousand
 * feeds an hour against a backlog of 368k, so applying the new schedule by
 * crawling would take longer than the schedule is meant to save — and it is
 * circular, because it is the old schedule's demand that is making the crawler
 * slow in the first place.
 *
 * So the schedule is applied directly, from evidence already in the database.
 * A feed's stored items carry their publication dates; `max(published_at)` per
 * feed is all that is needed, and it comes off `feed_items_feed_pub_idx` as an
 * indexed lookup rather than the feed_items-to-feeds aggregate that 0017
 * established must never be run (215 seconds against this database).
 *
 * ## What it deliberately does not do
 *
 * **It does not compute the median gap.** The live scheduler uses a feed's
 * rhythm when it is keeping to it and its silence when it is not; this only
 * computes the silence half. That is the conservative direction — a feed that
 * posted this morning gets an hour rather than its true cadence — and the first
 * real crawl replaces the guess with the measured rhythm. Getting the exact
 * answer here would mean reading thirty dates per feed instead of one, for a
 * number that is about to be recomputed anyway.
 *
 * **It does not touch feeds with no stored items.** A pending feed has never
 * been read and there is nothing to reason from; it needs its first crawl and
 * this must not push that away.
 *
 * **It does not mark anything dead.** A feed silent for five years is still
 * asked four times a year, which is the whole argument for a 90-day ceiling
 * rather than a graveyard: publishers come back, and a feed we stopped reading
 * is one we would never notice had returned.
 *
 * ## The spread
 *
 * `next_fetch_at` is scattered across the chosen interval rather than set to
 * `now + interval`. Without that, every feed rescheduled in the same run comes
 * due in the same minute and the thundering herd is simply postponed rather
 * than removed — which is the failure this whole exercise is about, moved
 * forward by one interval.
 */

import { connect } from '@rssamplifier/db';

/** Feeds read per round trip. One grouped query answers the whole chunk. */
const CHUNK = 200;

/** Feeds written per transaction. Write transactions are the scarce thing. */
const WRITE_CHUNK = 1000;

const MIN_INTERVAL = 60;
const MAX_INTERVAL = 129_600; // 90 days, matching packages/ingest/src/cadence.js

const apply = process.argv.includes('--apply');
const db = connect();

/**
 * The silence half of `intervalFromDates`, which is all this can know.
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
/** @type {Array<{sql: string, args: unknown[]}>} */
let pending = [];

/**
 * @returns {Promise<void>}
 */
async function flush() {
  if (pending.length === 0) return;
  if (apply) {
    await db.batch(pending, 'write');
    written += pending.length;
  }
  pending = [];
}

for (;;) {
  const { rows } = await db.execute({
    sql: `select id, slug, item_count from feeds
          where status = 'active' and item_count > 0 and id > ?
          order by id limit ?`,
    args: [cursor, CHUNK],
  });
  if (rows.length === 0) break;

  cursor = String(rows[rows.length - 1].id);
  seen += rows.length;

  const ids = rows.map((r) => String(r.id));
  const marks = ids.map(() => '?').join(',');
  const { rows: dates } = await db.execute({
    sql: `select feed_id, max(published_at) as newest
          from feed_items where feed_id in (${marks}) group by feed_id`,
    args: ids,
  });

  const newestBy = new Map(dates.map((d) => [String(d.feed_id), d.newest]));

  for (const id of ids) {
    const raw = newestBy.get(id);
    const t = raw ? Date.parse(String(raw)) : Number.NaN;

    // No believable date: leave it exactly as it is. The live scheduler falls
    // back to the old doubling ladder for these and so should this.
    if (!Number.isFinite(t) || t > now + 86_400_000) {
      bump('skipped: no usable date');
      continue;
    }

    const silence = Math.max(0, (now - t) / 60_000);
    const interval = intervalFor(silence);
    const next = new Date(now + scatter(id) * interval * 60_000).toISOString();

    planned += 1;
    const d = interval / 1440;
    bump(
      d < 1 ? 'a: under a day' : d < 7 ? 'b: 1-7 days' : d < 30 ? 'c: 1-4 weeks' : d < 90 ? 'd: 1-3 months' : 'e: at the 90-day ceiling',
    );

    pending.push({
      sql: `update feeds set
              last_published_at = ?,
              fetch_interval_minutes = ?,
              next_fetch_at = ?
            where id = ?`,
      args: [new Date(t).toISOString(), interval, next, id],
    });

    if (pending.length >= WRITE_CHUNK) await flush();
  }

  if (seen % 2000 < CHUNK) {
    console.log(`  …${seen} seen, ${planned} rescheduled${apply ? `, ${written} written` : ''}`);
  }
}

await flush();

console.log(`\n${apply ? 'Rescheduled' : 'Would reschedule'} ${planned} of ${seen} active feeds with items.\n`);
for (const k of [...buckets.keys()].sort()) {
  console.log(`  ${k.padEnd(30)} ${String(buckets.get(k)).padStart(6)}`);
}

// What the directory will now ask for, which is the number the whole exercise
// is about.
let perDay = 0;
for (const [k, n] of buckets) {
  if (k.startsWith('skipped')) continue;
  const mid = k.startsWith('a') ? 0.5 : k.startsWith('b') ? 4 : k.startsWith('c') ? 21 : k.startsWith('d') ? 60 : 90;
  perDay += n / mid;
}
console.log(`\nProjected demand from these feeds: ${Math.round(perDay)} crawls/day = ${Math.round(perDay / 24)}/hour`);
if (!apply) console.log('\nDry run. Pass --apply to write.');
