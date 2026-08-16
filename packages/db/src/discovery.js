/**
 * Queries for keyword discovery runs and their candidate sites.
 *
 * Kept apart from queries.js because discovery is a staging area, not part of
 * the directory: nothing here is ever rendered as a public page, and the only
 * writer of `feeds` remains the ingest layer.
 */

import { newId, nowIso } from './client.js';

/** @typedef {import('@libsql/client').Client} Client */

/** Statements per libSQL batch, matching the bulk import. */
const CHUNK = 500;

/**
 * Open a run. The id is minted by the caller so candidates can be stamped with
 * it before the counts are known.
 *
 * @param {Client} db
 * @param {object} row
 * @returns {Promise<string>}
 */
export async function insertRun(db, row) {
  const id = row.id ?? newId();
  const now = nowIso();

  await db.execute({
    sql: `insert into discovery_runs
      (id, keywords, keyword_count, status, provider, error, searched_count,
       candidate_count, accepted_count, rejected_count, queued_count,
       notify_email, ip_hash, user_agent, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      JSON.stringify(row.keywords ?? []),
      (row.keywords ?? []).length,
      row.status ?? 'running',
      row.provider ?? 'valueserp',
      row.error ?? null,
      row.searched_count ?? 0,
      row.candidate_count ?? 0,
      row.accepted_count ?? 0,
      row.rejected_count ?? 0,
      row.queued_count ?? 0,
      row.notify_email ?? null,
      row.ip_hash ?? null,
      row.user_agent ?? null,
      now,
      now,
    ],
  });

  return id;
}

/**
 * Update whichever counters the caller knows about.
 *
 * Built dynamically so a caller that learnt one number does not have to restate
 * the other five and risk clobbering a concurrent update with a stale copy.
 *
 * @param {Client} db
 * @param {string} id
 * @param {object} patch
 */
export async function updateRun(db, id, patch = {}) {
  const allowed = [
    'status',
    'error',
    'searched_count',
    'candidate_count',
    'accepted_count',
    'rejected_count',
    'queued_count',
    'completed_at',
  ];

  const sets = [];
  const args = [];

  for (const column of allowed) {
    if (patch[column] === undefined) continue;
    sets.push(`${column} = ?`);
    args.push(patch[column]);
  }

  if (sets.length === 0) return;

  sets.push('updated_at = ?');
  args.push(nowIso(), id);

  await db.execute({
    sql: `update discovery_runs set ${sets.join(', ')} where id = ?`,
    args,
  });
}

/**
 * @param {Client} db
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function runById(db, id) {
  const { rows } = await db.execute({
    sql: `select id, keywords, keyword_count, status, provider, error, searched_count,
                 candidate_count, accepted_count, rejected_count, queued_count,
                 notify_email, notified_at, created_at, updated_at, completed_at
          from discovery_runs where id = ? limit 1`,
    args: [id],
  });
  return rows[0] ?? null;
}

/**
 * @param {Client} db
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function recentRuns(db, limit = 20) {
  const { rows } = await db.execute({
    sql: `select id, keywords, keyword_count, status, searched_count, candidate_count,
                 accepted_count, rejected_count, queued_count, created_at, completed_at
          from discovery_runs order by created_at desc limit ?`,
    args: [limit],
  });
  return rows;
}

/**
 * Queue a run's keywords.
 *
 * @param {Client} db
 * @param {string} runId
 * @param {string[]} keywords
 * @returns {Promise<number>}
 */
export async function insertKeywords(db, runId, keywords) {
  if (keywords.length === 0) return 0;

  const now = nowIso();
  const statements = keywords.map((keyword) => ({
    sql: `insert into discovery_keywords (id, run_id, keyword, status, created_at)
          values (?, ?, ?, 'queued', ?)
          on conflict (run_id, keyword) do nothing`,
    args: [newId(), runId, keyword, now],
  }));

  const results = await db.batch(statements, 'write');
  return results.reduce((n, res) => n + Number(res?.rowsAffected ?? 0), 0);
}

/**
 * Keywords still waiting to be searched, oldest first.
 *
 * @param {Client} db
 * @param {number} [limit]
 * @param {string|null} [runId] restrict to one run
 * @returns {Promise<object[]>}
 */
export async function queuedKeywords(db, limit = 10, runId = null) {
  const { rows } = await db.execute(
    runId
      ? {
          sql: `select id, run_id, keyword from discovery_keywords
                where status = 'queued' and run_id = ?
                order by created_at asc limit ?`,
          args: [runId, limit],
        }
      : {
          sql: `select id, run_id, keyword from discovery_keywords
                where status = 'queued'
                order by created_at asc limit ?`,
          args: [limit],
        },
  );
  return rows;
}

/**
 * @param {Client} db
 * @returns {Promise<number>}
 */
export async function countQueuedKeywords(db) {
  const { rows } = await db.execute(
    `select count(*) as n from discovery_keywords where status = 'queued'`,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Record the outcome of one keyword search.
 *
 * @param {Client} db
 * @param {string} id
 * @param {{ status: 'searched'|'failed', resultCount?: number|null, error?: string|null }} outcome
 */
export async function markKeyword(db, id, outcome) {
  await db.execute({
    sql: `update discovery_keywords
          set status = ?, result_count = ?, error = ?, searched_at = ?
          where id = ?`,
    args: [
      outcome.status,
      outcome.resultCount ?? null,
      outcome.error ?? null,
      nowIso(),
      id,
    ],
  });
}

/**
 * How many of a run's keywords are done.
 *
 * @param {Client} db
 * @param {string} runId
 * @returns {Promise<{ total: number, waiting: number, searched: number, failed: number }>}
 */
export async function keywordProgress(db, runId) {
  const { rows } = await db.execute({
    sql: `select status, count(*) as n from discovery_keywords where run_id = ? group by status`,
    args: [runId],
  });

  const by = Object.fromEntries(rows.map((r) => [String(r.status), Number(r.n)]));
  const waiting = by.queued ?? 0;
  const searched = by.searched ?? 0;
  const failed = by.failed ?? 0;

  return { total: waiting + searched + failed, waiting, searched, failed };
}

/**
 * Queue candidate sites for later checking.
 *
 * `on conflict do nothing` carries the dedupe: the unique index on
 * (run_id, host) means a site surfacing under five keywords is queued once,
 * without a read-back to find out which ones were new.
 *
 * @param {Client} db
 * @param {string} runId
 * @param {Array<{ url: string, host: string, keyword?: string }>} sites
 * @returns {Promise<number>} rows actually inserted
 */
export async function insertCandidates(db, runId, sites) {
  if (sites.length === 0) return 0;

  const now = nowIso();
  let inserted = 0;

  for (let i = 0; i < sites.length; i += CHUNK) {
    const batch = sites.slice(i, i + CHUNK).map((site) => ({
      sql: `insert into discovery_candidates
              (id, run_id, keyword, site_url, host, status, created_at)
            values (?, ?, ?, ?, ?, 'queued', ?)
            on conflict (run_id, host) do nothing`,
      args: [newId(), runId, site.keyword ?? null, site.url, site.host, now],
    }));

    const results = await db.batch(batch, 'write');
    for (const res of results) inserted += Number(res?.rowsAffected ?? 0);
  }

  return inserted;
}

/**
 * The oldest queued candidates, for the poller to check.
 *
 * There is no claim/lease column because there is exactly one poller service.
 * If that ever becomes two, this needs a lease — two pollers would otherwise
 * both fetch the same site.
 *
 * @param {Client} db
 * @param {number} [limit]
 * @param {string|null} [runId] restrict to one run — what a waiting request wants,
 *   so its own budget is not spent draining an older run's backlog
 * @returns {Promise<object[]>}
 */
export async function queuedCandidates(db, limit = 20, runId = null) {
  const { rows } = await db.execute(
    runId
      ? {
          sql: `select id, run_id, keyword, site_url, host
                from discovery_candidates
                where status = 'queued' and run_id = ?
                order by created_at asc
                limit ?`,
          args: [runId, limit],
        }
      : {
          sql: `select id, run_id, keyword, site_url, host
                from discovery_candidates
                where status = 'queued'
                order by created_at asc
                limit ?`,
          args: [limit],
        },
  );
  return rows;
}

/**
 * @param {Client} db
 * @returns {Promise<number>}
 */
export async function countQueuedCandidates(db) {
  const { rows } = await db.execute(
    `select count(*) as n from discovery_candidates where status = 'queued'`,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Record the verdict on one candidate.
 *
 * @param {Client} db
 * @param {string} id
 * @param {{ status: string, feedUrl?: string|null, slug?: string|null, score?: number|null, reason?: unknown }} verdict
 */
export async function markCandidate(db, id, verdict) {
  await db.execute({
    sql: `update discovery_candidates
          set status = ?, feed_url = ?, slug = ?, score = ?, reason = ?, checked_at = ?
          where id = ?`,
    args: [
      verdict.status,
      verdict.feedUrl ?? null,
      verdict.slug ?? null,
      verdict.score ?? null,
      verdict.reason == null
        ? null
        : typeof verdict.reason === 'string'
          ? verdict.reason
          : JSON.stringify(verdict.reason),
      nowIso(),
      id,
    ],
  });
}

/**
 * How far through its queue one run is.
 *
 * Counted from the candidates rather than from the run's own counters, for the
 * same reason submissionProgress counts feeds: the poller updates each row as
 * it checks it, and a parallel tally would be one more thing to drift.
 *
 * @param {Client} db
 * @param {string} runId
 * @returns {Promise<{ total: number, waiting: number, accepted: number, rejected: number, errored: number }>}
 */
export async function runProgress(db, runId) {
  const { rows } = await db.execute({
    sql: `select status, count(*) as n from discovery_candidates where run_id = ? group by status`,
    args: [runId],
  });

  const by = Object.fromEntries(rows.map((r) => [String(r.status), Number(r.n)]));
  const waiting = by.queued ?? 0;
  const accepted = by.accepted ?? 0;
  const rejected = by.rejected ?? 0;
  const errored = by.error ?? 0;

  return { total: waiting + accepted + rejected + errored, waiting, accepted, rejected, errored };
}

/**
 * The blogs a run actually added.
 *
 * @param {Client} db
 * @param {string} runId
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function acceptedForRun(db, runId, limit = 200) {
  const { rows } = await db.execute({
    sql: `select c.host, c.keyword, c.slug, c.score, f.title
          from discovery_candidates c
          left join feeds f on f.slug = c.slug
          where c.run_id = ? and c.status = 'accepted'
          order by c.checked_at desc
          limit ?`,
    args: [runId, limit],
  });
  return rows;
}

/**
 * Why a run turned sites down — the part people actually read.
 *
 * @param {Client} db
 * @param {string} runId
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function rejectedForRun(db, runId, limit = 100) {
  const { rows } = await db.execute({
    sql: `select host, keyword, status, reason, score
          from discovery_candidates
          where run_id = ? and status in ('rejected', 'error')
          order by checked_at desc
          limit ?`,
    args: [runId, limit],
  });
  return rows;
}

/**
 * Runs that asked for an email and have no candidates left to check.
 *
 * @param {Client} db
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function runsAwaitingNotice(db, limit = 5) {
  const { rows } = await db.execute({
    sql: `select id, keywords, notify_email, accepted_count, queued_count, created_at
          from discovery_runs r
          where r.notify_email is not null
            and r.notified_at is null
            and not exists (
              select 1 from discovery_candidates c
              where c.run_id = r.id and c.status = 'queued'
            )
            -- Keywords too: a run whose sites are all checked but whose last
            -- twenty keywords have not been searched is not finished, and an
            -- email saying it is would be a lie.
            and not exists (
              select 1 from discovery_keywords k
              where k.run_id = r.id and k.status = 'queued'
            )
          order by r.created_at asc
          limit ?`,
    args: [limit],
  });
  return rows;
}

/**
 * @param {Client} db
 * @param {string} id
 */
export async function markRunNotified(db, id) {
  await db.execute({
    sql: 'update discovery_runs set notified_at = ? where id = ?',
    args: [nowIso(), id],
  });
}

/**
 * Runs started from one hashed IP within a window — the rate limiter.
 *
 * Discovery is metered in a way submission is not: every keyword spends a
 * credit against a monthly plan, so this limit is about the bill as much as
 * about abuse.
 *
 * @param {Client} db
 * @param {string} ipHash
 * @param {number} [windowMs]
 * @returns {Promise<{ runs: number, keywords: number }>}
 */
export async function runCount(db, ipHash, windowMs = 3_600_000) {
  const { rows } = await db.execute({
    sql: `select count(*) as runs, coalesce(sum(keyword_count), 0) as keywords
          from discovery_runs where ip_hash = ? and created_at >= ?`,
    args: [ipHash, nowIso(-windowMs)],
  });
  return { runs: Number(rows[0]?.runs ?? 0), keywords: Number(rows[0]?.keywords ?? 0) };
}

/**
 * Hosts already in the directory, so discovery does not re-check them.
 *
 * One read of the site/feed hostnames beats a lookup per candidate: a hundred
 * keywords can surface a few thousand sites and most of a mature directory's
 * hits are things it already has.
 *
 * @param {Client} db
 * @returns {Promise<Set<string>>}
 */
export async function knownHosts(db) {
  const { rows } = await db.execute('select site_url, feed_url from feeds');
  const hosts = new Set();

  for (const row of rows) {
    for (const value of [row.site_url, row.feed_url]) {
      if (!value) continue;
      try {
        hosts.add(new URL(String(value)).hostname.toLowerCase().replace(/^www\./, ''));
      } catch {
        // A malformed stored URL is not worth failing a discovery run over.
      }
    }
  }

  return hosts;
}
