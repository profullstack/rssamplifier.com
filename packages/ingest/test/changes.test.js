import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  contentSignature,
  changeTimes,
  recordChange,
  intervalFromChanges,
  neverSooner,
  CHANGE_LOG_LIMIT,
  MIN_INTERVAL,
  MAX_INTERVAL,
} from '../src/cadence.js';

/** A fixed clock, so a test never depends on when it runs. */
const NOW = Date.parse('2026-08-19T12:00:00.000Z');

const DAY = 86_400_000;
const HOUR = 3_600_000;

const days = (minutes) => minutes / 1440;

/** A log of changes `gapDays` apart, the newest `agoDays` old. */
const log = (count, gapDays, agoDays) =>
  JSON.stringify(
    Array.from({ length: count }, (_, i) =>
      new Date(NOW - agoDays * DAY - i * gapDays * DAY).toISOString(),
    ),
  );

/* ------------------------------------------------------------- fingerprint */

test('the fingerprint tracks what a feed published, not how it served it', () => {
  const items = [
    { guid: 'a', link: 'https://x/a', title: 'One' },
    { guid: 'b', link: 'https://x/b', title: 'Two' },
  ];

  // Reordered. Plenty of generators emit entries in whatever order the
  // filesystem walked, and reading that as "everything was republished" would
  // pin those feeds at the floor for ever -- which is the bug being fixed.
  assert.equal(contentSignature(items), contentSignature([items[1], items[0]]));

  // Edited in place. A corrected typo in a post from March is not a publication,
  // so the body is deliberately not part of this.
  const edited = items.map((i) => ({ ...i, summary: 'rewritten', content: 'rewritten' }));
  assert.equal(contentSignature(edited), contentSignature(items));

  // Actually published, retitled, and withdrawn: all three are changes.
  assert.notEqual(contentSignature([...items, { guid: 'c' }]), contentSignature(items));
  assert.notEqual(
    contentSignature([{ ...items[0], title: 'One, revised' }, items[1]]),
    contentSignature(items),
  );
  assert.notEqual(contentSignature([items[0]]), contentSignature(items));
});

test('an empty feed has a stable fingerprint, and that is the point', () => {
  // Sampling production's undated feeds on 2026-08-19, most of the ones pinned
  // to the hourly floor had `item_count = 0`: they parse, they are simply empty,
  // and they had been read every hour for months to be told so again. If an
  // empty document had no fingerprint, every crawl would compare unequal to the
  // last and those feeds would stay on the floor for ever under the new code
  // too -- the same bug wearing a different hat.
  const empty = contentSignature([]);
  assert.ok(empty, 'listing nothing is a fact, not an absence of one');
  assert.equal(contentSignature([]), empty, 'and it is stable across crawls');
  assert.equal(contentSignature(undefined), empty);

  // Items with nothing to identify them hash the same as none at all. A real
  // limitation, and an acceptable one: such an item cannot be stored, shown or
  // de-duplicated either, so a feed made of them has published nothing anybody
  // can act on.
  assert.equal(contentSignature([{}, {}]), empty);

  // And an empty feed is emphatically not the same as one with posts in it.
  assert.notEqual(contentSignature([{ guid: 'a' }]), empty);
});

/* --------------------------------------------------------------- the log */

test('the log records changes, not crawls', () => {
  // The distinction the whole thing rests on. If an unchanged crawl appended an
  // entry, the "rhythm" measured from the log would be the crawl interval, and
  // the feed would confirm whatever schedule it happened to be on.
  const started = recordChange(null, true, NOW);
  assert.equal(JSON.parse(started).length, 1);

  const looked = recordChange(started, false, NOW + HOUR);
  assert.deepEqual(JSON.parse(looked), JSON.parse(started), 'looking is not changing');

  const changed = recordChange(looked, true, NOW + 2 * HOUR);
  assert.equal(JSON.parse(changed).length, 2);
});

test('the log is bounded, newest first', () => {
  let entries = null;
  for (let i = 0; i < CHANGE_LOG_LIMIT + 8; i += 1) entries = recordChange(entries, true, NOW + i * HOUR);

  const parsed = JSON.parse(entries);
  assert.equal(parsed.length, CHANGE_LOG_LIMIT);
  assert.equal(parsed[0], new Date(NOW + (CHANGE_LOG_LIMIT + 7) * HOUR).toISOString());
});

test('a log written by another version of the crawler degrades, never throws', () => {
  // This column is read by whatever is deployed, not by whatever wrote it. Every
  // one of these has to cost a feed one crawl on the fallback ladder rather than
  // an exception on the hot path.
  for (const bad of ['', null, undefined, 'not json', '{"a":1}', '[]', '[null]', '["nonsense"]', '[123]']) {
    assert.deepEqual(changeTimes(bad, NOW), [], `changeTimes(${JSON.stringify(bad)})`);
    assert.equal(intervalFromChanges(bad, NOW), null);
    assert.doesNotThrow(() => recordChange(bad, true, NOW));
  }

  // Our own clock wrote these, so a future entry is a bad row rather than a fast
  // publisher, and there is no skew to allow for the way there is with a
  // publisher's own dates.
  assert.deepEqual(changeTimes(JSON.stringify([new Date(NOW + DAY).toISOString()]), NOW), []);
});

/* ----------------------------------------------------------- the schedule */

test('an undated feed is scheduled on the rhythm we observed', () => {
  // The same arithmetic the dated path uses, over instants we watched rather
  // than instants the publisher claimed: half the typical gap while the feed is
  // keeping to it.
  const weekly = intervalFromChanges(log(8, 7, 1), NOW);
  assert.ok(days(weekly) > 3 && days(weekly) < 4, `weekly -> ${days(weekly).toFixed(1)}d`);

  const daily = intervalFromChanges(log(8, 1, 0.2), NOW);
  assert.ok(days(daily) > 0.4 && days(daily) < 0.6, `daily -> ${days(daily).toFixed(2)}d`);
});

test('one observation is enough, which a single date never is', () => {
  // The real difference from `intervalFromDates`. A single date in a document
  // says when one post went out and nothing about whether another will follow. A
  // single entry here means "it changed then, and we have looked every time
  // since and seen nothing" -- because the looking is ours. So silence measured
  // from it is evidence, and a feed decays on it with no dead-feed classifier.
  assert.equal(intervalFromChanges(log(1, 0, 0), NOW), MIN_INTERVAL, 'just seen, so the floor');
  assert.ok(days(intervalFromChanges(log(1, 0, 40), NOW)) > 9, 'quiet 40 days -> read every 10');
  assert.equal(intervalFromChanges(log(1, 0, 2000), NOW), MAX_INTERVAL, 'and it stops at the ceiling');
});

test('a feed that goes quiet backs off on its silence, not on its old rhythm', () => {
  // It posted weekly and has now said nothing for a year. Scheduling it at half
  // a week for ever is the failure the ceiling exists to prevent.
  const abandoned = intervalFromChanges(log(8, 7, 365), NOW);
  assert.ok(days(abandoned) > 30, `a year silent -> ${days(abandoned).toFixed(0)}d`);
});

test('evidence of no change may lengthen the interval and never shorten it', () => {
  // A crawl that saw nothing is evidence in one direction only. Without this, a
  // feed resting at the ceiling is dragged back to a fortnight every time we
  // check it and confirm it is still silent -- so it oscillates instead of
  // settling, and never stops costing crawls.
  assert.equal(neverSooner(60, MAX_INTERVAL), MAX_INTERVAL, 'the ceiling holds');
  assert.equal(neverSooner(5000, 60), 5000, 'but it may still grow');
  assert.equal(neverSooner(null, 5000), null, 'nothing computed is nothing to say');
  assert.equal(neverSooner(60, null), MIN_INTERVAL, 'and a feed with no interval yet is not a bug');
});

test('every answer is whole minutes inside the bounds', () => {
  const cases = [log(1, 0, 0), log(2, 0, 0), log(12, 30, 900), log(3, 0.0001, 0), log(5, 1, 0.5)];
  for (const entries of cases) {
    const n = intervalFromChanges(entries, NOW);
    assert.ok(Number.isInteger(n), `whole minutes, got ${n}`);
    assert.ok(n >= MIN_INTERVAL && n <= MAX_INTERVAL, `within bounds, got ${n}`);
  }
});

test('a feed that never changes reaches the ceiling in tens of crawls, not hundreds', () => {
  // The whole point, stated as the number that matters. Under the old ladder an
  // undated feed doubled to a one-day cap and was then fetched 365 times a year
  // for ever. Following its own schedule instead, it decays to ninety days.
  let now = NOW;
  let entries = recordChange(null, true, now);
  let interval = MIN_INTERVAL;
  let crawls = 1;

  while (interval < MAX_INTERVAL && crawls < 500) {
    now += interval * 60_000;
    interval = neverSooner(intervalFromChanges(entries, now), interval);
    entries = recordChange(entries, false, now);
    crawls += 1;
  }

  const span = (now - NOW) / DAY;
  assert.equal(interval, MAX_INTERVAL, 'it does reach the ceiling');
  assert.ok(crawls < 60, `${crawls} crawls over ${span.toFixed(0)} days, against ${span.toFixed(0)} before`);
});
