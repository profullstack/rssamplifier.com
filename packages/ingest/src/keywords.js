/**
 * Keyword discovery: type "siberian huskies", get husky blogs.
 *
 * The shape mirrors a bulk submission — do what fits in the request, queue the
 * rest, show a status page — because that is the only shape that survives a
 * hundred keywords. But discovery has two slow phases where submission has one:
 * searching, then checking what the search returned. Both are queued and both
 * are bounded by a clock rather than a count, since a single unresponsive site
 * can eat fifteen seconds on its own.
 *
 * The other difference from submission is what the queue holds. A submitted
 * catalogue goes straight into `feeds`, because a person vouched for it. Search
 * results are vouched for by nobody, so they wait in `discovery_candidates`
 * until a feed has been resolved and judged worthy. Only then is a row written
 * to `feeds`, where it becomes a public page at /<slug>.
 */

import { resolveFeed, assessFeed, assessRelevance } from '@rssamplifier/feed';
import { searchKeyword, candidateSites, FATAL_ERRORS } from '@rssamplifier/search';
import { q, discovery, newId } from '@rssamplifier/db';

import { claimSlug } from './submit.js';

/** Candidate sites checked while the requester waits, at most. */
export const INLINE_LIMIT = 100;

/**
 * Wall-clock budgets for the inline half of a run, in milliseconds.
 *
 * The route allows 300 seconds. These add up to well under that on purpose:
 * the numbers below are what a person will sit through, not what the platform
 * will tolerate. Everything unfinished is queued, not lost.
 */
export const SEARCH_BUDGET_MS = 25_000;
export const CHECK_BUDGET_MS = 60_000;

/**
 * Promote a candidate site into the directory, if it earns it.
 *
 * Every exit writes a verdict to the candidate row: a run that says "checked
 * 900, added 12" is only useful if the other 888 can be explained.
 *
 * @param {import('@libsql/client').Client} db
 * @param {{ id: string, run_id?: string, site_url: string }} candidate
 * @param {{ rules?: object, resolveImpl?: typeof resolveFeed }} [opts]
 * @returns {Promise<{ status: 'accepted'|'rejected'|'error', slug?: string, score?: number }>}
 */
export async function checkCandidate(db, candidate, opts = {}) {
  const siteUrl = String(candidate.site_url);
  const runId = candidate.run_id ? String(candidate.run_id) : null;

  // Injectable so a test can exercise the promotion path without a network
  // round trip, the same way the discovery sources take a fetchImpl.
  const resolved = await (opts.resolveImpl ?? resolveFeed)(siteUrl);
  if (!resolved.ok) {
    await discovery.markCandidate(db, String(candidate.id), {
      status: 'error',
      reason: resolved.error,
    });
    return { status: 'error' };
  }

  const { feedUrl, feed } = resolved;

  // Already in the directory under another name. Not a rejection of the site —
  // it is simply not new — but it must not mint a second slug for it.
  const existing = await q.feedByUrl(db, feedUrl);
  if (existing) {
    await discovery.markCandidate(db, String(candidate.id), {
      status: 'rejected',
      feedUrl,
      slug: String(existing.slug),
      reason: 'already-indexed',
    });
    return { status: 'rejected' };
  }

  // A curated candidate skips the worthiness check, because the check and the
  // list disagree by design. Worthiness exists to throw out what a search
  // engine hands back for "siberian huskies"; a maintained list of webcomics
  // or PeerTube instances is somebody vouching for exactly the feeds a
  // heuristic tuned for blogs would score badly — a comic with no prose, an
  // instance feed with a machine-generated title.
  const vouched = Number(candidate.curated ?? 0) === 1;

  const verdict = vouched
    ? { worthy: true, score: null, reasons: ['curated'] }
    : assessFeed({ feedUrl, feed, rules: opts.rules });

  if (!verdict.worthy) {
    await discovery.markCandidate(db, String(candidate.id), {
      status: 'rejected',
      feedUrl,
      score: verdict.score,
      reason: verdict.reasons,
    });
    return { status: 'rejected', score: verdict.score };
  }

  // A structurally perfect feed about the wrong subject is still the wrong
  // answer: searching "siberian huskies" and being handed a veterinary clinic's
  // news feed is what this catches.
  if (candidate.keyword) {
    const topical = assessRelevance({ keyword: String(candidate.keyword), feed });
    if (!topical.relevant) {
      await discovery.markCandidate(db, String(candidate.id), {
        status: 'rejected',
        feedUrl,
        score: verdict.score,
        reason: ['off-topic'],
      });
      return { status: 'rejected', score: verdict.score };
    }
  }

  const slug = await claimSlug(db, feed.title, feedUrl);

  let inserted;
  try {
    inserted = await q.insertFeed(db, {
      slug,
      feed_url: feedUrl,
      site_url: feed.siteUrl || siteUrl,
      title: feed.title,
      description: feed.description,
      language: feed.language,
      image_url: feed.imageUrl,
      // What the parser made of it. Without this every discovered feed was
      // stored as a blog whatever it plainly was — a PeerTube instance full of
      // video/mp4 enclosures included — because insertFeed defaults an absent
      // kind to 'blog'. Curated sources hid it, since they overwrite the
      // category immediately afterwards; only an uncurated source showed it.
      kind: feed.kind,
      status: 'active',
      item_count: feed.items.length,
      discovery_run_id: runId,
    });
  } catch (err) {
    // Another run inserting the same feed between the lookup and the insert is
    // a duplicate, not a failure.
    const raced = await q.feedByUrl(db, feedUrl);
    await discovery.markCandidate(db, String(candidate.id), {
      status: raced ? 'rejected' : 'error',
      feedUrl,
      slug: raced ? String(raced.slug) : null,
      reason: raced ? 'already-indexed' : String(err?.message ?? err),
    });
    return { status: raced ? 'rejected' : 'error' };
  }

  await q.upsertItems(db, inserted.id, feed.items);

  // A source that knows what its finds are says so, and says it in a way the
  // crawler will not undo. Only for categories a parser cannot reach on its
  // own — a comic, a livestream — so a curated run never overrides what the
  // feed itself plainly is.
  if (candidate.category) {
    await q.curateCategory(db, [feedUrl], String(candidate.category));
  }

  await discovery.markCandidate(db, String(candidate.id), {
    status: 'accepted',
    feedUrl,
    slug: inserted.slug,
    score: verdict.score,
    reason: verdict.reasons,
  });

  return { status: 'accepted', slug: inserted.slug, score: verdict.score };
}

/**
 * Search one queued keyword and queue whatever sites it turns up.
 *
 * Hosts already in the directory are dropped here rather than after checking:
 * re-fetching a blog the directory has had for a year is the single most
 * wasteful thing a discovery run can do.
 *
 * @param {import('@libsql/client').Client} db
 * @param {{ id: string, run_id: string, keyword: string }} row
 * @param {{ known?: Set<string>, searchOpts?: object }} [opts]
 * @returns {Promise<{ ok: boolean, error: string|null, queued: number }>}
 */
export async function searchOneKeyword(db, row, opts = {}) {
  const runId = String(row.run_id);
  const result = await searchKeyword(String(row.keyword), opts.searchOpts ?? {});

  if (!result.ok) {
    // A fatal provider error is not this keyword's fault, so the keyword stays
    // queued for a later tick — the credits reset on a fixed day and the run
    // should simply resume then. Only per-keyword failures are recorded.
    if (!FATAL_ERRORS.has(result.error)) {
      await discovery.markKeyword(db, String(row.id), {
        status: 'failed',
        error: result.error,
      });
    }
    return { ok: false, error: result.error, queued: 0 };
  }

  const known = opts.known ?? (await discovery.knownHosts(db));
  const sites = candidateSites([result]).filter((site) => !known.has(site.host));
  for (const site of sites) known.add(site.host);

  const queued = await discovery.insertCandidates(db, runId, sites);

  await discovery.markKeyword(db, String(row.id), {
    status: 'searched',
    resultCount: result.links.length,
  });

  return { ok: true, error: null, queued };
}

/**
 * Recompute a run's counters and status from its two queues.
 *
 * Derived rather than incremented: a tick that dies halfway through a batch
 * would otherwise leave the run claiming numbers that never become true.
 *
 * @param {import('@libsql/client').Client} db
 * @param {string} runId
 * @param {{ error?: string|null }} [extra]
 * @returns {Promise<{ keywords: object, candidates: object, done: boolean }>}
 */
export async function refreshRun(db, runId, extra = {}) {
  const [keywords, candidates] = await Promise.all([
    discovery.keywordProgress(db, runId),
    discovery.runProgress(db, runId),
  ]);

  const done = keywords.waiting === 0 && candidates.waiting === 0;

  await discovery.updateRun(db, runId, {
    status: done ? 'complete' : 'queued',
    searched_count: keywords.searched,
    candidate_count: candidates.total,
    accepted_count: candidates.accepted,
    rejected_count: candidates.rejected + candidates.errored,
    queued_count: candidates.waiting,
    completed_at: done ? new Date().toISOString() : undefined,
    ...(extra.error === undefined ? {} : { error: extra.error }),
  });

  return { keywords, candidates, done };
}

/**
 * Start a run: queue the keywords, then spend the inline budget on them.
 *
 * @param {import('@libsql/client').Client} db
 * @param {string[]} keywords
 * @param {{ runId?: string, inlineLimit?: number, searchBudgetMs?: number, checkBudgetMs?: number, notifyEmail?: string|null, ipHash?: string|null, userAgent?: string|null, searchOpts?: object, rules?: object, now?: () => number }} [opts]
 * @returns {Promise<{ runId: string, searched: number, candidates: number, accepted: number, rejected: number, queuedKeywords: number, queuedCandidates: number, error: string|null }>}
 */
export async function discoverFromKeywords(db, keywords, opts = {}) {
  const runId = opts.runId ?? newId();
  const inlineLimit = opts.inlineLimit ?? INLINE_LIMIT;
  const clock = opts.now ?? Date.now;
  const searchDeadline = clock() + (opts.searchBudgetMs ?? SEARCH_BUDGET_MS);

  await discovery.insertRun(db, {
    id: runId,
    keywords,
    status: 'running',
    notify_email: opts.notifyEmail ?? null,
    ip_hash: opts.ipHash ?? null,
    user_agent: opts.userAgent ?? null,
  });
  await discovery.insertKeywords(db, runId, keywords);

  // ---- search, until the budget runs out --------------------------------
  const known = await discovery.knownHosts(db);
  let searched = 0;
  let fatal = null;

  const queue = await discovery.queuedKeywords(db, keywords.length, runId);
  for (const row of queue) {
    if (clock() > searchDeadline) break;

    const res = await searchOneKeyword(db, row, { known, searchOpts: opts.searchOpts });
    if (res.ok) searched += 1;
    else if (FATAL_ERRORS.has(res.error)) {
      fatal = res.error;
      break;
    }
  }

  // Nothing searched and the provider is the reason: the run failed, and saying
  // so is the difference between "no husky blogs exist" and "the search account
  // is out of credits until the 13th".
  if (fatal && searched === 0) {
    await discovery.updateRun(db, runId, {
      status: 'failed',
      error: fatal,
      completed_at: new Date().toISOString(),
    });
    return {
      runId,
      searched: 0,
      candidates: 0,
      accepted: 0,
      rejected: 0,
      queuedKeywords: keywords.length,
      queuedCandidates: 0,
      error: fatal,
    };
  }

  // ---- check what turned up, until that budget runs out ------------------
  const checkDeadline = clock() + (opts.checkBudgetMs ?? CHECK_BUDGET_MS);
  //
  // Scoped to this run. The poller drains the queue globally, but a caller that
  // is holding a connection open should spend its budget on the keywords it
  // just asked about rather than on an older run's leftovers.
  const head = await discovery.queuedCandidates(db, inlineLimit, runId);

  for (const candidate of head) {
    if (clock() > checkDeadline) break;

    await checkCandidate(db, candidate, { rules: opts.rules });
  }

  const { keywords: kw, candidates } = await refreshRun(db, runId, { error: fatal });

  // Counted from the run's own rows, not from the loop above — the two disagree
  // whenever the poller finishes a candidate concurrently, and the run is the
  // half the status page shows.
  return {
    runId,
    searched,
    candidates: candidates.total,
    accepted: candidates.accepted,
    rejected: candidates.rejected + candidates.errored,
    queuedKeywords: kw.waiting,
    queuedCandidates: candidates.waiting,
    error: fatal,
  };
}

/**
 * Wall-clock a poller tick may spend searching, in milliseconds.
 *
 * A keyword is a hundred results now, which is a dozen requests and up to a
 * couple of minutes of somebody else's latency. Five of those in a row is a
 * tick that runs for ten minutes, and the crawl — which shares the tick and
 * matters more, because a blog already in the directory going stale is worse
 * than a new one being found late — would only get a turn that often.
 *
 * Checked before a keyword starts, never during: a keyword half-searched is a
 * keyword whose credits bought nothing. Whatever is not started stays queued
 * for the next tick.
 */
export const DRAIN_BUDGET_MS = 120_000;

/**
 * Search queued keywords — the poller's half of the search phase.
 *
 * @param {import('@libsql/client').Client} db
 * @param {number} [limit]
 * @param {{ searchOpts?: object, budgetMs?: number, now?: () => number }} [opts]
 * @returns {Promise<{ searched: number, failed: number, queued: number, fatal: string|null }>}
 */
export async function drainDiscoveryKeywords(db, limit = 5, opts = {}) {
  const rows = await discovery.queuedKeywords(db, limit);
  if (rows.length === 0) return { searched: 0, failed: 0, queued: 0, fatal: null };

  const known = await discovery.knownHosts(db);
  const runIds = new Set();
  const clock = opts.now ?? Date.now;
  const deadline = clock() + (opts.budgetMs ?? DRAIN_BUDGET_MS);

  let searched = 0;
  let failed = 0;
  let queued = 0;
  let fatal = null;

  for (const row of rows) {
    if (clock() > deadline) break;

    runIds.add(String(row.run_id));

    const res = await searchOneKeyword(db, row, { known, searchOpts: opts.searchOpts });
    if (res.ok) {
      searched += 1;
      queued += res.queued;
    } else if (FATAL_ERRORS.has(res.error)) {
      // Every following search would fail identically. Stop, leave the rest
      // queued, and try again next tick.
      fatal = res.error;
      break;
    } else {
      failed += 1;
    }
  }

  for (const runId of runIds) await refreshRun(db, runId, { error: fatal });

  return { searched, failed, queued, fatal };
}

/**
 * Check queued candidates — the poller's half of the checking phase.
 *
 * Sequential, like the crawler's work on a single host: these are fetches
 * against sites that never asked to be indexed, and there is no deadline to
 * race, because the queue is drained continuously.
 *
 * @param {import('@libsql/client').Client} db
 * @param {number} [limit]
 * @param {{ rules?: object }} [opts]
 * @returns {Promise<{ checked: number, accepted: number, rejected: number, errored: number }>}
 */
export async function drainDiscoveryQueue(db, limit = 10, opts = {}) {
  const candidates = await discovery.queuedCandidates(db, limit);
  if (candidates.length === 0) return { checked: 0, accepted: 0, rejected: 0, errored: 0 };

  let accepted = 0;
  let rejected = 0;
  let errored = 0;
  const runIds = new Set();

  for (const candidate of candidates) {
    runIds.add(String(candidate.run_id));

    const res = await checkCandidate(db, candidate, { rules: opts.rules });
    if (res.status === 'accepted') accepted += 1;
    else if (res.status === 'rejected') rejected += 1;
    else errored += 1;
  }

  for (const runId of runIds) await refreshRun(db, runId);

  return { checked: candidates.length, accepted, rejected, errored };
}
