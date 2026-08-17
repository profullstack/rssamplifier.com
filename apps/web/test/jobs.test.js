import test from 'node:test';
import assert from 'node:assert/strict';

import { eta, etaLabel, jobRows } from '../src/lib/jobs.js';

/**
 * A poller that is busy on every job, as the shape of the input rather than as a
 * fixture file: every test below starts from this and breaks one thing.
 */
function busy(overrides = {}) {
  const at = '2026-08-17T10:00:00.000Z';

  return jobRows({
    backlogs: {
      due: 49_832,
      pendingFirstCrawl: 12,
      neverCrawled: 40,
      submittedLastHour: 3,
      cardsPending: 53_696,
      cardsOk: 195,
      cardsNone: 283,
      cardsError: 31,
      cardsLastHour: 1_320,
      ...overrides.backlogs,
    },
    activity: {
      feed: { lines: 1500, errors: 20, amount: 900, lastAt: at, ms: 400 },
      crawl: { lines: 60, errors: 0, amount: 0, lastAt: at, ms: 5000 },
      cards: { lines: 180, errors: 0, amount: 0, lastAt: at, ms: 900 },
      'discovery-search': { lines: 12, errors: 0, amount: 60, lastAt: at, ms: 800 },
      discovery: { lines: 6, errors: 0, amount: 60, lastAt: at, ms: 900 },
      'cluster-backfill': { lines: 360, errors: 0, amount: 12_000, lastAt: at, ms: 90 },
      topics: { lines: 4, errors: 0, amount: 0, lastAt: at, ms: 300 },
      alerts: { lines: 30, errors: 0, amount: 48, lastAt: at, ms: 600 },
      ...overrides.activity,
    },
    alertAccounts: overrides.alertAccounts ?? 4,
    fetchedLastHour: overrides.fetchedLastHour ?? 1_500,
    keywordQueue: overrides.keywordQueue ?? 40,
    candidateQueue: overrides.candidateQueue ?? 900,
  });
}

const find = (rows, key) => rows.find((row) => row.key === key);

test('a permanently deep update queue is working, not an incident', () => {
  // The whole point of the board. 49,832 feeds waiting is the design of an
  // hourly interval over 52,000 feeds, and a page that calls it a failure has
  // taught its reader to ignore the page.
  const update = find(busy(), 'update');
  assert.equal(update.backlog, 49_832);
  assert.equal(update.state, 'working');
  // And it says how long a full pass takes, which is the figure that means
  // something: 49,832 at 1,500 an hour.
  assert.equal(etaLabel(update.eta), '33h');
});

test('a first-crawl queue backing up is called out, because somebody is waiting', () => {
  assert.equal(find(busy(), 'first-crawl').state, 'working', '12 waiting is ordinary');

  // Submissions nobody has read. Same absolute size as a healthy update backlog
  // would be, opposite meaning.
  const backed = find(busy({ backlogs: { pendingFirstCrawl: 3_570 } }), 'first-crawl');
  assert.equal(backed.state, 'behind');
  assert.equal(backed.backlog, 3_570);
});

test('first crawls claim no throughput of their own', () => {
  // Nothing records a feed's first success, and the work is done by the update
  // job anyway — so the row shows inflow and refuses to invent a rate.
  const first = find(busy(), 'first-crawl');
  assert.equal(first.rate, null);
  assert.equal(first.eta, null);
  assert.match(first.rateNote, /3 submitted/);
});

test('work waiting with nothing working on it is stalled', () => {
  // The failure the combined health word cannot show: the crawl is busy, so the
  // page reads healthy, while the picture job has been dead for an hour.
  const rows = busy({ backlogs: { cardsLastHour: 0 } });
  assert.equal(find(rows, 'cards').state, 'stalled');
  assert.equal(find(rows, 'update').state, 'working', 'and the crawl is unaffected');
});

test('a job that has never run at all is idle rather than stalled', () => {
  // A fresh deploy, or a worker that was only just added. Worth telling apart
  // from one that ran and then stopped.
  const rows = jobRows({
    backlogs: { due: 10, pendingFirstCrawl: 0, cardsPending: 500, cardsLastHour: 0 },
    activity: {},
    fetchedLastHour: 0,
    keywordQueue: 0,
    candidateQueue: 0,
  });
  assert.equal(find(rows, 'cards').state, 'idle');
  assert.equal(find(rows, 'update').state, 'idle');
});

test('a job whose every line was an error is failing', () => {
  const rows = busy({
    activity: { cards: { lines: 8, errors: 8, amount: 0, lastAt: '2026-08-17T10:00:00.000Z', ms: 10 } },
  });
  const cards = find(rows, 'cards');
  assert.equal(cards.state, 'failing');
  assert.equal(cards.errors, 8);
});

test('some errors alongside progress is not a failure', () => {
  // 20 feeds of 1,500 failing to answer is a Tuesday on the open web.
  assert.equal(find(busy(), 'update').state, 'working');
  assert.equal(find(busy(), 'update').errors, 20);
});

test('an empty queue reads as clear once, and only if something has run', () => {
  const rows = busy({ backlogs: { pendingFirstCrawl: 0 } });
  assert.equal(find(rows, 'first-crawl').state, 'clear');
  assert.equal(find(rows, 'housekeeping').state, 'clear');
});

test('a finished one-off backfill says so instead of pretending to be busy', () => {
  const rows = busy({
    activity: {
      'cluster-backfill-done': { lines: 1, errors: 0, amount: 0, lastAt: '2026-08-17T09:00:00.000Z', ms: null },
    },
  });
  assert.equal(find(rows, 'clusters').state, 'done');
});

test('a long backfill says what it has settled, not only what is left', () => {
  // 53,696 waiting reads as achieving nothing; "195 found, 283 have none" says
  // the job is answering feeds, which is the thing being asked of it.
  const cards = find(busy(), 'cards');
  assert.match(cards.done, /195 found/);
  assert.match(cards.done, /283 have none/);
});

test('an uncountable backlog is null rather than zero', () => {
  // Counting the un-keyed posts means scanning 1.4M rows, which this page cannot
  // pay for every fifteen seconds. Zero would be a lie; null renders as "not
  // counted".
  const clusters = find(busy(), 'clusters');
  assert.equal(clusters.backlog, null);
  assert.equal(clusters.state, 'working', 'it is moving, and the log says so');
  assert.equal(clusters.eta, null, 'and no estimate is invented from it');
});

test('a quiet alert pass is idle, not stalled', () => {
  // The one job whose steady state is doing nothing: most hours nobody an
  // account follows publishes anything. A board that called that "stalled"
  // would cry wolf every night, so an alert pass with no throughput and a log
  // line behind it is idle — and the alarm is kept for a pass that has stopped
  // running at all.
  const alerts = find(busy(), 'alerts');
  assert.equal(alerts.backlog, null, 'a backlog here is a query per account');
  assert.equal(alerts.state, 'working', 'it sent something this hour');
  assert.equal(alerts.eta, null, 'and nothing to estimate against');

  // A pass that ran and found nothing to send. This is why the poller logs the
  // pass whenever it had anybody to consider rather than only when it sent
  // something: without that line there is no `lastAt`, and a quiet night would
  // read as a sender that had stopped.
  const quiet = find(
    busy({ activity: { alerts: { lines: 30, errors: 0, amount: 0, lastAt: '2026-08-17T10:00:00.000Z', ms: 40 } } }),
    'alerts',
  );
  assert.equal(quiet.state, 'idle');

  // Subscribers, and no line at all: the sender really has stopped, and this is
  // the one case that should raise the alarm.
  const dead = find(busy({ activity: { alerts: undefined } }), 'alerts');
  assert.equal(dead.state, 'stalled');
});

test('nobody subscribed is idle, not a dead sender', () => {
  // The state every deployment is in the day alerts ship, and the one that was
  // wrong in production for a few minutes: the pass only writes a log line when
  // it had somebody to consider, so with no subscribers it writes nothing — and
  // "no lines, uncountable backlog" is how this board says stalled. Reporting a
  // healthy sender as the page's one unambiguous alarm, on every deployment,
  // from the moment the feature lands, would have taught its reader to ignore
  // the word.
  const fresh = find(busy({ alertAccounts: 0, activity: { alerts: undefined } }), 'alerts');
  assert.equal(fresh.backlog, 0, 'nothing to do is a real, countable zero');
  assert.equal(fresh.state, 'idle');
  assert.match(fresh.rateNote, /nobody has alerts/, 'and the row says why it is quiet');

  // One subscriber is enough to make silence worth alarming about again.
  const watched = find(busy({ alertAccounts: 1, activity: { alerts: undefined } }), 'alerts');
  assert.equal(watched.backlog, null);
  assert.equal(watched.state, 'stalled');
});

test('every job reports when it last ran, from the log it already writes', () => {
  for (const row of busy()) {
    assert.ok(row.label && row.what, `${row.key} describes itself`);
    if (row.key !== 'clusters') assert.ok(row.lastAt, `${row.key} has a last-ran time`);
  }
});

test('an estimate needs both a backlog and a rate', () => {
  assert.equal(eta(1_000, 100), 10);
  assert.equal(eta(0, 100), null, 'nothing waiting');
  assert.equal(eta(1_000, 0), null, 'no measured rate');
  assert.equal(eta(null, 100), null);
  assert.equal(eta(1_000, null), null);

  assert.equal(etaLabel(null), '—');
  assert.equal(etaLabel(0.25), '15m');
  assert.equal(etaLabel(0.001), '1m', 'never rounds down to zero');
  assert.equal(etaLabel(33.2), '33h');
  assert.equal(etaLabel(96), '4d');
});
