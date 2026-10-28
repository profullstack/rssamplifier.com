import { createDaemon as defaultCreateDaemon } from '@profullstack/scraper-daemon';

/**
 * The poller's schedule, as one @profullstack/scraper-daemon.
 *
 * This file only decides *what runs and how often*. Every job's body is a
 * function that already existed in index.js and is handed in here unchanged, so
 * the crawler itself (crawlDue's due-row selection, per-host spreading, 429
 * hold-back, error ladder and dead-after-10) is untouched: the daemon wraps it,
 * it does not replace it. What the daemon adds is the shared run log, stall
 * detection, a status document and one shutdown path instead of ten timers.
 *
 * Pure on purpose: no database, no env, no timers until the caller starts it,
 * so test/daemon.test.js can build it with stub functions and read the job list
 * back.
 *
 * Cadence follows the old `setInterval` grid rather than the daemon's default
 * "every N after the last run finished": a 60-second crawl that takes 50
 * seconds still starts once a minute, as it did, instead of every 110 seconds.
 * A failure retries at the job's own cadence too (`backoff: [every]`), because
 * that is what a timer that swallowed its error did.
 */

/** The jobs that ran at boot in the timer version (`void tick()` and friends). */
export const BOOT_JOBS = [
  'crawl',
  'import',
  'purge',
  'cluster-backfill',
  'cards',
  'alerts',
  'authors',
  'rings',
  'queue-sample',
  'stats-warm',
];

/** The crawl is the one job whose silence is an incident. */
export const CRAWL_STALE_AFTER = '30m';

/**
 * Build the daemon. Nothing runs until `daemon.start()`.
 *
 * @param {{
 *   createDaemon?: typeof defaultCreateDaemon,
 *   store?: import('@profullstack/scraper-daemon').Store,
 *   log?: (...args: unknown[]) => void,
 *   onRun?: (entry: import('@profullstack/scraper-daemon').RunEntry) => unknown,
 *   onStall?: (s: { job: string, lastOk: number | null, lastError: string | null }) => unknown,
 *   config: {
 *     intervalMs: number,
 *     catchupOnly: boolean,
 *     clusterBackfill: boolean, clusterIntervalMs: number,
 *     cardEnabled: boolean, cardIntervalMs: number,
 *     alertIntervalMs: number,
 *     newsletterIntervalMs?: number,
 *     authorEnabled: boolean, authorIntervalMs: number,
 *     ringEnabled: boolean, ringIntervalMs: number,
 *     queueSampleMs: number,
 *     statsWarmMs: number,
 *     searchEnabled: boolean, searchIntervalMs: number,
 *     tally: boolean,
 *     sourceIntervalMs: number,
 *     topicSearchIntervalMs: number,
 *     topicsIntervalMs: number,
 *     statusMs?: number,
 *   },
 *   run: Record<string, () => Promise<unknown>>,
 * }} deps
 */
export function buildPollerDaemon({ createDaemon = defaultCreateDaemon, store, redis = null, log, onRun, onStall, config: c, run }) {
  /** @type {Array<{ name: string, every: number, staleAfter?: string, fn: () => Promise<unknown> }>} */
  const jobs = [];
  const add = (name, every, fn, extra = {}) => {
    if (typeof fn !== 'function') throw new TypeError(`no function for poller job ${name}`);
    jobs.push({ name, every, fn, ...extra });
  };

  // Always on: the crawl, and the queue a person is waiting on (an upload and
  // the email saying it finished). Catch-up mode exists to stop unrelated writes
  // competing with a deep first-crawl backlog; it never skipped these, and
  // retention sweeps cannot be "caught up" later, so purge stays on as well.
  add('crawl', c.intervalMs, run.crawl, { staleAfter: CRAWL_STALE_AFTER });
  add('import', c.intervalMs, run.import);
  add('purge', 3_600_000, run.purge);

  // Everything the old tick() skipped below `if (catchupOnly) return`.
  if (!c.catchupOnly) {
    add('discovery-keywords', c.intervalMs, run.discoveryKeywords);
    add('discovery-queue', c.intervalMs, run.discoveryQueue);
    add('discovery-sources', c.sourceIntervalMs, run.discoverySources);
    add('discovery-topics', c.topicSearchIntervalMs, run.discoveryTopics);
    add('discovery-notify', c.intervalMs, run.discoveryNotify);
    add('topics', c.topicsIntervalMs, run.topics);
  }

  // The timers that ran beside the tick, in either mode. A switched-off pass is
  // not registered at all, rather than registered and returning at once, so the
  // status document lists only work that is really happening.
  if (c.clusterBackfill) add('cluster-backfill', c.clusterIntervalMs, run.clusterBackfill);
  if (c.cardEnabled) add('cards', c.cardIntervalMs, run.cards);
  add('alerts', c.alertIntervalMs, run.alerts);
  // The weekly digest: a no-op outside its slot. Optional so callers that build
  // a daemon without it (tests, older configs) keep working.
  if (run.newsletter) add('newsletter', c.newsletterIntervalMs ?? 600_000, run.newsletter);
  if (c.authorEnabled) add('authors', c.authorIntervalMs, run.authors);
  if (c.ringEnabled) add('rings', c.ringIntervalMs, run.rings);
  add('queue-sample', c.queueSampleMs, run.queueSample);
  add('stats-warm', c.statsWarmMs, run.statsWarm);
  if (c.searchEnabled) add('author-search', c.searchIntervalMs, run.authorSearch);
  if (c.tally) add('write-tally', c.queueSampleMs, run.writeTally);

  const daemon = createDaemon({
    name: 'rssamplifier.com',
    // BullMQ on the compose `redis` service (scraper-daemon queue `rssamplifier.com`, beside the
    // write queue). Run records and status stay in Postgres (`store`), where /api/v1/daemon reads them.
    redis,
    store,
    // Every job may be in flight at once, as every timer could be. Each job is
    // still one run at a time.
    concurrency: jobs.length + 1,
    log,
    onRun,
    onStall,
  });

  for (const j of jobs) {
    daemon.job({
      name: j.name,
      every: j.every,
      backoff: [j.every],
      // The daemon aborts a signal at this point; nothing here listens to it, so
      // it is a ceiling on paperwork, not on the work. Set well past any pass.
      timeout: '6h',
      ...(j.staleAfter ? { staleAfter: j.staleAfter } : {}),
      run: async () => {
        const started = Date.now();
        await j.fn();
        return { nextIn: onGrid(j.every, Date.now() - started) };
      },
    });
  }

  // The poller has no port, so its status is written where the web service can
  // read it: scraper_daemon_state, key 'status' (served at /api/v1/daemon).
  daemon.job({
    name: 'daemon-status',
    every: c.statusMs ?? 60_000,
    backoff: [c.statusMs ?? 60_000],
    run: async () => {
      const status = await daemon.status();
      await daemon.store.set('status', { ...status, writtenAt: Date.now() });
    },
  });

  return daemon;
}

/**
 * Time until the next slot on a fixed grid of `every`, given how long the run
 * took: what `setInterval` plus an overlap guard did.
 *
 * @param {number} every
 * @param {number} elapsed
 */
export function onGrid(every, elapsed) {
  if (!(every > 0)) return 0;
  return every - (Math.max(0, elapsed) % every);
}

/**
 * Make the boot jobs due now, keeping their history.
 *
 * The daemon persists each job's next run, which is right for the daily and
 * half-hourly passes (a deploy no longer re-spends a day's search credits) but
 * wrong for the ones the timer version deliberately ran at boot: a deploy would
 * otherwise leave the stats cache cold or the crawl idle for a full interval.
 * Must run before `daemon.start()`, which loads the records once.
 *
 * @param {import('@profullstack/scraper-daemon').Store} store
 * @param {string[]} names
 */
export async function primeBootJobs(store, names = BOOT_JOBS) {
  for (const name of names) {
    const rec = (await store.load(name)).get('*');
    if (rec && (rec.nextAt ?? 0) > Date.now()) await store.save(name, { ...rec, nextAt: 0 });
  }
}
