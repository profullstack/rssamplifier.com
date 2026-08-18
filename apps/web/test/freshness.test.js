import assert from 'node:assert/strict';
import { test } from 'node:test';

import { freshness, humanGap, FRESHNESS_LABEL } from '../src/lib/freshness.js';

const NOW = Date.parse('2026-08-18T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const iso = (ms) => new Date(NOW - ms).toISOString();

/** A healthy hourly feed, read eleven minutes ago. */
const live = {
  status: 'active',
  last_success_at: iso(11 * MINUTE),
  next_fetch_at: new Date(NOW + 49 * MINUTE).toISOString(),
  fetch_interval_minutes: 60,
  error_count: 0,
  last_error: null,
};

test('a healthy feed reports both facts, not one', () => {
  const f = freshness(live, iso(2 * DAY), NOW);

  assert.equal(f.state, 'live');
  assert.equal(f.checkedGap, '11 minutes');
  assert.equal(f.publishedGap, '2 days');
  assert.ok(f.checkedAt && f.publishedAt && f.nextCheckAt, 'all three instants are exposed');
});

test('the case that erodes trust: current data, retired blog', () => {
  // Read eleven minutes ago and completely up to date -- and the publisher
  // stopped in 2023. A single "last updated" line would show eleven minutes and
  // say nothing at all about the thing the reader actually needs to know.
  const f = freshness(live, iso(900 * DAY), NOW);

  assert.equal(f.state, 'dormant');
  assert.match(f.note, /current, but nothing has been published for/);
  assert.equal(f.checkedGap, '11 minutes', 'our copy really is fresh');
  assert.match(f.publishedGap, /years/, 'and the feed really is retired');
});

test('the opposite failure: live blog, stale copy', () => {
  // The feed posted this morning; we have not looked since Tuesday. This is
  // our fault, not the publisher's, and it must not read as "dormant".
  const behind = { ...live, last_success_at: iso(6 * DAY), fetch_interval_minutes: 60 };
  const f = freshness(behind, iso(4 * HOUR), NOW);

  assert.equal(f.state, 'overdue');
  assert.match(f.note, /longer than this feed's 1 hour schedule/);
});

test('overdue is judged against the feed\'s own schedule, not one global clock', () => {
  // A monthly blog read a week ago is exactly as current as a news site read an
  // hour ago -- both are inside their own cadence. Judging them by one clock
  // would paint most of the directory amber for working as intended.
  const monthly = {
    ...live,
    last_success_at: iso(7 * DAY),
    fetch_interval_minutes: 30 * 24 * 60,
  };
  assert.equal(freshness(monthly, iso(20 * DAY), NOW).state, 'live', 'a week is nothing to a monthly feed');

  const hourly = { ...live, last_success_at: iso(7 * DAY), fetch_interval_minutes: 60 };
  assert.equal(freshness(hourly, iso(20 * DAY), NOW).state, 'overdue', 'but it is a lot to an hourly one');
});

test('failing takes precedence over looking recently read', () => {
  // The reading that misleads: failures that started *after* a success leave
  // last_success_at looking healthy.
  const broken = {
    ...live,
    status: 'error',
    last_success_at: iso(30 * MINUTE),
    last_error: 'HTTP 500',
    error_count: 9,
  };
  const f = freshness(broken, iso(DAY), NOW);

  assert.equal(f.state, 'failing');
  assert.match(f.note, /attempts since then have failed/);
});

test('a feed never successfully read says so rather than saying nothing', () => {
  const pending = { status: 'pending', last_success_at: null, next_fetch_at: null, error_count: 0 };
  const f = freshness(pending, null, NOW);

  assert.equal(f.state, 'unread');
  assert.equal(f.checkedAt, null);
  assert.equal(f.checkedGap, null);
  assert.match(f.note, /Not yet read/);
});

test('a feed with no post dates still reports how fresh our copy is', () => {
  // Undated feeds are common on the small web. We can still say when we last
  // read it, and we must not invent a publication date we do not have.
  const f = freshness(live, null, NOW);

  assert.equal(f.state, 'live');
  assert.equal(f.publishedAt, null);
  assert.equal(f.publishedGap, null);
  assert.equal(f.note, 'Read 11 minutes ago.');
});

test('unparseable and absent timestamps are treated as absent, never as 1970', () => {
  const junk = { ...live, last_success_at: 'not a date', next_fetch_at: '' };
  const f = freshness(junk, 'also not a date', NOW);

  assert.equal(f.state, 'unread', 'a date we cannot read is a read we cannot vouch for');
  assert.equal(f.nextCheckAt, null);
  assert.equal(f.publishedAt, null);
});

test('humanGap reads as words at every scale', () => {
  assert.equal(humanGap(0), 'moments');
  assert.equal(humanGap(30_000), 'moments');
  assert.equal(humanGap(MINUTE), '1 minute');
  assert.equal(humanGap(11 * MINUTE), '11 minutes');
  assert.equal(humanGap(HOUR), '1 hour');
  assert.equal(humanGap(5 * HOUR), '5 hours');
  assert.equal(humanGap(DAY), '1 day');
  assert.equal(humanGap(45 * DAY), '45 days');
  assert.equal(humanGap(90 * DAY), '3 months');
  assert.equal(humanGap(900 * DAY), '2 years');
  assert.equal(humanGap(-5), 'moments', 'a future timestamp does not read as negative');
  assert.equal(humanGap(Number.NaN), 'moments');
});

test('every state has a label, so the badge can never render undefined', () => {
  const states = ['live', 'dormant', 'overdue', 'failing', 'unread'];
  for (const s of states) {
    assert.equal(typeof FRESHNESS_LABEL[s], 'string', `${s} has a label`);
    assert.ok(FRESHNESS_LABEL[s].length > 0);
  }

  // And the reachable set is exactly that -- if a new branch is added above
  // without a label, this fails rather than shipping an empty badge.
  const reached = new Set([
    freshness(live, iso(2 * DAY), NOW).state,
    freshness(live, iso(900 * DAY), NOW).state,
    freshness({ ...live, last_success_at: iso(6 * DAY) }, iso(HOUR), NOW).state,
    freshness({ ...live, status: 'error', last_error: 'x', error_count: 1 }, null, NOW).state,
    freshness({}, null, NOW).state,
  ]);
  for (const s of reached) assert.ok(states.includes(s), `${s} is a known state`);
  assert.equal(reached.size, states.length, 'all five states are reachable');
});
