import { discovery } from '@rssamplifier/db';
import { discoverFromKeywords } from '@rssamplifier/ingest';

/**
 * Search for the things this directory is already about.
 *
 * Every other source here reads somebody else's list. This one reads our own:
 * the topics extracted from the feeds we hold become the keywords we search
 * for, so a directory with forty home-lab blogs goes looking for the
 * forty-first without anybody typing anything.
 *
 * It is the only automatic source that spends money — every keyword is a
 * search credit against an account shared with other projects — so the whole
 * module is written around that:
 *
 *   - it does nothing at all unless a search key is configured;
 *   - it takes a handful of topics per pass, not a page of them;
 *   - it never re-searches a keyword anybody has already queued, because the
 *     second search of a phrase costs the same as the first and returns what
 *     the first one already did;
 *   - it queues rather than searches inline, so a dry quota stops a pass
 *     instead of half-finishing one.
 */

/**
 * Topics searched per pass.
 *
 * Deliberately small. At three credits a keyword this is nine credits a day
 * against a shared monthly allowance, which is a rounding error — and the
 * supply of topics worth searching grows slowly, so a bigger number would
 * exhaust the interesting ones in a week and then re-search noise.
 */
export const DEFAULT_TOPICS = 3;

/**
 * A topic has to be shared before it is worth searching for.
 *
 * A phrase only one feed uses is that blog's vocabulary rather than a subject —
 * "my weekly roundup" is not something to go looking for more of.
 */
export const MIN_FEEDS = 3;

/**
 * Run one pass of topic-driven discovery.
 *
 * Returns what it did rather than throwing on the ordinary outcomes: no key
 * configured and no unsearched topics are both normal states for a daemon that
 * runs this every day, and neither is worth an error in a log.
 *
 * @param {import('@libsql/client').Client} db
 * @param {{
 *   limit?: number,
 *   minFeeds?: number,
 *   env?: NodeJS.ProcessEnv,
 *   searchOpts?: object,
 *   discoverImpl?: typeof discoverFromKeywords,
 * }} [opts]
 * @returns {Promise<{ ran: boolean, reason?: string, keywords: string[], runId: string|null }>}
 */
export async function discoverFromOwnTopics(db, opts = {}) {
  const env = opts.env ?? process.env;
  if (!env['VALUESERP_API_KEY']) {
    return { ran: false, reason: 'no-api-key', keywords: [], runId: null };
  }

  const keywords = await discovery.unsearchedTopics(db, {
    limit: opts.limit ?? DEFAULT_TOPICS,
    minFeeds: opts.minFeeds ?? MIN_FEEDS,
  });

  if (keywords.length === 0) {
    // Everything worth searching has been searched. Not a failure — it is the
    // steady state, and the topics table grows as the crawler works.
    return { ran: false, reason: 'nothing-new', keywords: [], runId: null };
  }

  let runId = null;
  const discover = opts.discoverImpl ?? discoverFromKeywords;

  await discover(db, keywords, {
    ...opts.searchOpts,
    // Queue and return. The poller drains both queues on its own schedule, and
    // holding this open would put a several-minute search inside the tick that
    // is also crawling the directory.
    onStarted: (id) => {
      runId = id;
    },
    searchBudgetMs: 0,
    inlineLimit: 0,
  });

  return { ran: true, keywords, runId };
}
