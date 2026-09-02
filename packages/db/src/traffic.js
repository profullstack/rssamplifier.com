import { nowIso } from './client.js';

/**
 * The traffic rollup: what asked for what, by the hour.
 *
 * Read by the tiering work rather than by a dashboard. A rate limit is a number
 * somebody has to choose, and choosing it blind has one of two failure modes --
 * set it below what an ordinary reader does in an hour and the directory breaks
 * for people, set it above what a scraper does and it costs exactly as much as
 * having no limit at all. This table is how that number stops being a guess.
 *
 * @typedef {import('@libsql/client').Client} Client
 */

/**
 * Fold a batch of counted hits into the rollup.
 *
 * Takes the whole buffer at once because the alternative is one statement per
 * (agent, bucket) pair per flush, and this database's write path is the scarce
 * thing -- see the note on `writeOne` in queries.js. A minute of traffic is a
 * few dozen rows at most, which is one batch.
 *
 * Failure is swallowed by the caller on purpose: losing a minute of counters is
 * a hole in a chart, and there is no version of "we could not write the
 * bookkeeping" that should reach somebody trying to read a blog post.
 *
 * @param {Client} db
 * @param {Array<{ hour: string, agent: string, bucket: string, tier: string, hits: number, refused?: number }>} rows
 * @returns {Promise<number>} how many rows were folded in
 */
export async function recordTraffic(db, rows) {
  const wanted = rows.filter((r) => Number(r.hits) > 0);
  if (wanted.length === 0) return 0;

  await db.batch(
    wanted.map((r) => ({
      sql: `insert into traffic_hourly (hour, agent, bucket, tier, hits, refused)
            values (?, ?, ?, ?, ?, ?)
            on conflict (hour, agent, bucket, tier) do update set
              hits    = traffic_hourly.hits + excluded.hits,
              refused = traffic_hourly.refused + excluded.refused`,
      args: [
        String(r.hour),
        String(r.agent),
        String(r.bucket),
        String(r.tier),
        Number(r.hits),
        Number(r.refused ?? 0),
      ],
    })),
    'write'
  );

  return wanted.length;
}

/**
 * What the last `hours` hours looked like, by agent and by route kind.
 *
 * Returns both marginals rather than the full cross-product. The cross-product
 * is what the table stores and it is the wrong shape to reason about: the
 * question "should GPTBot pay" is answered by one total, and the question "is
 * the reader the expensive route" by the other.
 *
 * @param {Client} db
 * @param {number} [hours]
 * @returns {Promise<{
 *   since: string,
 *   total: number,
 *   byAgent: Array<{ agent: string, hits: number }>,
 *   byBucket: Array<{ bucket: string, hits: number }>,
 *   byTier: Array<{ tier: string, hits: number }>,
 *   byHour: Array<{ hour: string, hits: number }>,
 *   readerByAgent: Array<{ agent: string, hits: number }>,
 * }>}
 */
export async function trafficSummary(db, hours = 24) {
  const span = Math.max(1, Math.min(Number(hours) || 24, 24 * 30));
  const since = new Date(Date.now() - span * 3_600_000).toISOString().slice(0, 13);

  const [agents, buckets, tiers, byHour, reader] = await Promise.all([
    db.execute({
      sql: `select agent, sum(hits) as hits, sum(refused) as refused from traffic_hourly
            where hour >= ? group by agent order by hits desc`,
      args: [since],
    }),
    db.execute({
      sql: `select bucket, sum(hits) as hits, sum(refused) as refused from traffic_hourly
            where hour >= ? group by bucket order by hits desc`,
      args: [since],
    }),
    db.execute({
      sql: `select tier, sum(hits) as hits, sum(refused) as refused from traffic_hourly
            where hour >= ? group by tier order by hits desc`,
      args: [since],
    }),
    db.execute({
      sql: `select hour, sum(hits) as hits from traffic_hourly
            where hour >= ? group by hour order by hour desc`,
      args: [since],
    }),
    // Broken out on its own because it is the expensive route and the one a
    // sponsorship would be sold against: a caller doing thousands of reader
    // hits is costing real money, where the same count of directory pages is
    // costing a database it already has open.
    db.execute({
      sql: `select agent, sum(hits) as hits from traffic_hourly
            where hour >= ? and bucket = 'reader' group by agent order by hits desc`,
      args: [since],
    }),
  ]);

  const byAgent = agents.rows.map((r) => ({
    agent: String(r.agent),
    hits: Number(r.hits ?? 0),
    refused: Number(r.refused ?? 0),
  }));

  return {
    since,
    total: byAgent.reduce((sum, r) => sum + r.hits, 0),
    // The headline number for tuning a limit: how much of what we were asked
    // for, we said no to.
    refused: byAgent.reduce((sum, r) => sum + r.refused, 0),
    byAgent,
    byBucket: buckets.rows.map((r) => ({
      bucket: String(r.bucket),
      hits: Number(r.hits ?? 0),
      refused: Number(r.refused ?? 0),
    })),
    byTier: tiers.rows.map((r) => ({
      tier: String(r.tier),
      hits: Number(r.hits ?? 0),
      refused: Number(r.refused ?? 0),
    })),
    byHour: byHour.rows.map((r) => ({
      hour: String(r.hour),
      hits: Number(r.hits ?? 0),
    })),
    readerByAgent: reader.rows.map((r) => ({
      agent: String(r.agent),
      hits: Number(r.hits ?? 0),
    })),
  };
}

/**
 * Drop rollup rows older than `days`.
 *
 * Bounded on purpose. The table grows with (hours x agents x buckets) and
 * nothing here is worth keeping for a quarter -- the tiering decision reads
 * days, and a chart reads weeks.
 *
 * @param {Client} db
 * @param {number} [days]
 * @returns {Promise<number>}
 */
export async function pruneTraffic(db, days = 45) {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 13);
  const [result] = await db.batch(
    [{ sql: `delete from traffic_hourly where hour < ?`, args: [cutoff] }],
    'write'
  );
  return Number(/** @type {any} */ (result)?.rowsAffected ?? 0);
}

/** Exposed for the flusher, which stamps its own buckets. @returns {string} */
export function currentHour() {
  return nowIso().slice(0, 13);
}
