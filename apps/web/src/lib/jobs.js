/**
 * The poller's work, split into the jobs it is actually made of.
 *
 * One daemon runs all of this, and until now /crawlstats showed it as one thing:
 * a backlog, a throughput, and a health word derived from both. That reads as a
 * single queue permanently 49,000 deep and permanently behind, which is both
 * alarming and wrong — the number is the sum of six unrelated pieces of work with
 * completely different shapes, and the only one that should ever be near empty is
 * hidden inside it.
 *
 * The distinction that matters most:
 *
 * - **Updates** re-read feeds the directory already has, looking for new posts.
 *   This queue is *supposed* to be full. 52,000 feeds on an hourly interval want
 *   52,000 checks an hour; a polite crawler makes about 1,500. Being behind is
 *   the steady state, not an incident, and the honest measure of it is how long a
 *   full pass takes rather than how many are waiting.
 * - **First crawls** are feeds accepted into the directory that have never been
 *   read: bulk imports and discovery results, which `insertFeedsBulk` stores as
 *   `pending` with no items. This queue *should* be near empty. It has no
 *   throughput of its own — it shares the update queue and sorts by the same
 *   `next_fetch_at`, so an unread feed waits behind everything already overdue,
 *   which is why it can sit at four figures for days.
 *
 * Worth knowing before reading that row as a person waiting: a feed added through
 * the submit form is *not* in it. `submitFeed` resolves the feed, stores its items
 * and marks it active inline, so the submitter sees their blog with posts on the
 * page they are redirected to. This queue is machinery waiting, not people.
 *
 * Splitting them on the page is the cheap half of fixing that. Nothing here
 * changes what the poller does.
 */

/** How the page describes a job that has nothing waiting. */
const CLEAR = 'clear';

/**
 * The jobs, in the order they are worth reading.
 *
 * `events` are the poller's own log event names, which is how each row finds its
 * activity: the log already tags every line by job, so no new bookkeeping had to
 * be invented to say when something last ran. A job whose events never appear is
 * shown as idle rather than hidden — a row that vanishes when a worker dies is
 * the opposite of what a status board is for.
 *
 * @param {{
 *   backlogs: Record<string, number>,
 *   activity: Record<string, { lines: number, errors: number, amount: number, lastAt: string|null, ms: number|null }>,
 *   fetchedLastHour: number,
 *   keywordQueue: number,
 *   candidateQueue: number,
 *   alertAccounts?: number,
 * }} input
 * @returns {Array<object>}
 */
export function jobRows({
  backlogs,
  activity,
  fetchedLastHour,
  keywordQueue,
  candidateQueue,
  alertAccounts = 0,
}) {
  const seen = (events) => {
    const times = events.map((e) => activity[e]?.lastAt).filter(Boolean).sort();
    return times.length ? String(times[times.length - 1]) : null;
  };
  const errors = (events) => events.reduce((n, e) => n + (activity[e]?.errors ?? 0), 0);
  const runs = (events) => events.reduce((n, e) => n + (activity[e]?.lines ?? 0), 0);

  /** @type {Array<object>} */
  const rows = [
    {
      key: 'update',
      label: 'Feed updates',
      what: 'Re-reads feeds we already have, looking for new posts',
      backlog: backlogs.due ?? 0,
      // The queue is meant to be deep, so its own row says so rather than
      // leaving the reader to read a five-figure backlog as a fire.
      expectFull: true,
      rate: fetchedLastHour,
      rateNote: 'feeds read',
      events: ['feed', 'crawl', 'crawl-error'],
    },
    {
      key: 'first-crawl',
      label: 'First crawls',
      what: 'Imported and discovered feeds not yet read — shares the update queue',
      backlog: backlogs.pendingFirstCrawl ?? 0,
      // No rate of its own, honestly: nothing records a feed's first success, and
      // the work is done by the update job anyway.
      rate: null,
      rateNote: `${backlogs.submittedLastHour ?? 0} submitted in the last hour, ${
        backlogs.neverCrawled ?? 0
      } never read successfully`,
      events: ['feed'],
      // Whose throughput actually moves this queue. Used for the verdict only:
      // a job with no rate of its own is not stalled for lacking one, but it *is*
      // stalled when the queue it shares has stopped — a dead crawler means
      // nobody's submission is being read either.
      liveness: fetchedLastHour,
      // The one row where a backlog is a problem rather than a workload.
      alarmAbove: 500,
    },
    {
      key: 'authors',
      label: 'Author enrichment',
      what: 'Finds who writes each feed, and how to reach them',
      backlog: backlogs.authorsPending ?? 0,
      // Genuinely a queue rather than a fire: it walks the directory once and
      // then rechecks on a 90-day cycle, so a large number here is the work
      // remaining and not a stall.
      expectFull: true,
      rate: backlogs.authorsLastHour ?? 0,
      rateNote: 'publishers looked at',
      done: `${backlogs.authorsDone ?? 0} looked at so far`,
      events: ['author', 'authors-error', 'author-search', 'author-search-error'],
    },
    {
      key: 'cards',
      label: 'Feed pictures',
      what: "Fetches each site's og:image and measures it, for listings and cards",
      backlog: backlogs.cardsPending ?? 0,
      rate: backlogs.cardsLastHour ?? 0,
      rateNote: 'feeds looked at',
      done: `${backlogs.cardsOk ?? 0} found, ${backlogs.cardsNone ?? 0} have none`,
      events: ['cards', 'card-error', 'card-tick-error'],
    },
    {
      key: 'keywords',
      label: 'Keyword searches',
      what: 'Searches the web for feeds on subjects we already cover',
      backlog: keywordQueue,
      rate: activity['discovery-search']?.amount ?? 0,
      rateNote: 'searches run',
      events: ['discovery-search', 'discovery-topics', 'discovery-topics-error'],
    },
    {
      key: 'candidates',
      label: 'Candidate sites',
      what: 'Resolves a found site into a feed, or rejects it',
      backlog: candidateQueue,
      rate: activity.discovery?.amount ?? 0,
      rateNote: 'sites checked',
      events: ['discovery', 'discovery-source', 'discovery-source-error'],
    },
    {
      key: 'clusters',
      label: 'Duplicate keys',
      what: 'Keys older posts so the rivers can collapse the same story',
      // Counting the un-keyed rows means scanning 1.4M of them, which is not a
      // price this page can pay every fifteen seconds. The walk reports its own
      // progress to the log instead, so the row shows movement and not a total.
      backlog: null,
      rate: activity['cluster-backfill']?.amount ?? 0,
      rateNote: 'posts keyed',
      finished: Boolean(activity['cluster-backfill-done']?.lines),
      events: ['cluster-backfill', 'cluster-backfill-done', 'cluster-backfill-error'],
    },
    {
      key: 'alerts',
      label: 'Alerts',
      what: 'Tells readers about new posts on the blogs and topics they asked about',
      // Nothing to count while anybody is subscribed: a real backlog here would
      // be "posts published since each account's watermark", which is a query
      // per account against the largest table in the database. So this row
      // shows movement rather than a total, the way the cluster walk above does.
      //
      // Zero when nobody has switched alerts on, and that distinction is the
      // whole point. The pass logs only when it had somebody to consider, so on
      // a deployment with no subscribers it writes no lines at all — and a null
      // backlog with no lines is how this board says *stalled*, its one
      // unambiguous alarm. Reporting a healthy sender as stalled because nobody
      // has subscribed yet is exactly the crying wolf the board exists to stop.
      backlog: alertAccounts > 0 ? null : 0,
      rate: activity.alerts?.amount ?? 0,
      // The note says why the row is quiet rather than leaving the reader to
      // wonder whether something is broken.
      rateNote: alertAccounts > 0 ? 'posts alerted' : 'nobody has alerts switched on yet',
      events: ['alerts', 'alert-error', 'purged-alerts'],
    },
    {
      key: 'housekeeping',
      label: 'Housekeeping',
      what: 'Rebuilds the topics index, clears expired sessions, prunes the logs',
      backlog: 0,
      rate: null,
      events: ['topics', 'purged', 'purged-rollup', 'purged-log', 'notified', 'notified-discovery'],
    },
  ];

  return rows.map((row) => {
    // Assembled before it is judged, and this is not a style preference: state()
    // reads `runs`, and judging the literal instead of the finished row compared
    // an error count against undefined — so a job whose every line failed was
    // reported as working.
    const finished = {
      ...row,
      lastAt: seen(row.events),
      errors: errors(row.events),
      runs: runs(row.events),
      eta: eta(row.backlog, row.rate),
    };

    return { ...finished, state: state(finished) };
  });
}

/**
 * What to call the state this job is in.
 *
 * The verdicts are deliberately different per job, because the same backlog
 * means different things: 49,000 updates waiting is the design, and 49,000 first
 * crawls waiting would mean the directory had stopped answering submissions.
 *
 * @param {any} row an assembled row, carrying its own lastAt, errors and runs
 * @returns {'clear'|'working'|'behind'|'idle'|'stalled'|'failing'|'done'}
 */
function state(row) {
  const { backlog, lastAt, errors: failures, runs: attempts } = row;

  // A job whose every line this hour was an error is failing, whatever its
  // backlog says — it is "moving" only in the sense that it keeps trying.
  if (failures > 0 && failures === attempts) return 'failing';
  if (row.finished) return 'done';

  // The rate that decides whether this job is alive: its own where it has one,
  // otherwise the queue it shares.
  const rate = row.rate ?? row.liveness ?? null;

  if (backlog === 0) return lastAt ? CLEAR : 'idle';

  // Nothing waiting that we can count, but the job is running: the cluster walk.
  if (backlog === null) return rate ? 'working' : lastAt ? 'idle' : 'stalled';

  // Work waiting and nothing happening. The one unambiguous alarm on the page,
  // and the reason the board exists: this is invisible in a single combined
  // health word, which reads "healthy" as long as *some* job is busy.
  if (!rate) return lastAt ? 'stalled' : 'idle';

  if (row.expectFull) return 'working';
  return row.alarmAbove != null && backlog > row.alarmAbove ? 'behind' : 'working';
}

/**
 * How long this job needs to clear, at the rate it is actually going.
 *
 * Hours rather than a date, and only where both numbers are real. A backlog with
 * no measured rate has no honest estimate, and inventing one is how a status page
 * starts lying.
 *
 * @param {number|null|undefined} backlog
 * @param {number|null|undefined} rate per hour
 * @returns {number|null} hours
 */
export function eta(backlog, rate) {
  if (!backlog || !rate || backlog < 0 || rate <= 0) return null;
  return backlog / rate;
}

/**
 * An ETA as words.
 *
 * @param {number|null} hours
 * @returns {string}
 */
export function etaLabel(hours) {
  if (hours == null) return '—';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}
