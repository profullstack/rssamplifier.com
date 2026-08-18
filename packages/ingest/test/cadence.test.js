import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nextInterval, publishedTimes, MIN_INTERVAL, MAX_INTERVAL } from '../src/cadence.js';

/** A fixed clock, so a test never depends on when it runs. */
const NOW = Date.parse('2026-08-18T12:00:00.000Z');

const DAY = 86_400_000;
const HOUR = 3_600_000;

/**
 * A document whose posts are `gapDays` apart, the newest `agoDays` old.
 *
 * @param {number} count
 * @param {number} gapDays
 * @param {number} agoDays
 */
const posts = (count, gapDays, agoDays) =>
  Array.from({ length: count }, (_, i) => ({
    publishedAt: new Date(NOW - agoDays * DAY - i * gapDays * DAY).toISOString(),
  }));

const hours = (minutes) => minutes / 60;
const days = (minutes) => minutes / 1440;

test('a feed keeping its own rhythm is read at that rhythm', () => {
  // A weekly blog, posting on time. Half its cycle, so a post is found in the
  // first half of the week rather than on average halfway through the next one.
  const weekly = nextInterval({ items: posts(10, 7, 1), now: NOW });
  assert.ok(days(weekly) > 3 && days(weekly) < 4, `weekly blog -> ${days(weekly).toFixed(1)}d`);

  // A daily paper.
  const daily = nextInterval({ items: posts(20, 1, 0.2), now: NOW });
  assert.ok(hours(daily) > 11 && hours(daily) < 13, `daily paper -> ${hours(daily).toFixed(1)}h`);

  // A news site publishing every couple of hours never goes below the floor.
  const busy = nextInterval({ items: posts(20, 1 / 12, 0.01), now: NOW });
  assert.equal(busy, MIN_INTERVAL, 'a firehose is still only read hourly');
});

test('the abandoned podcast that started all this', () => {
  // Weekly for a year, then silence since 2024. Under the old ladder this was
  // fetched every single day for ever; 15.8% of the sampled directory looks
  // like this.
  const dead = nextInterval({ items: posts(20, 7, 800), now: NOW });
  assert.equal(dead, MAX_INTERVAL, `2-year-dead feed sits at the ceiling, not on a daily poll`);
  assert.equal(days(dead), 90, `-> ${days(dead)}d instead of 1`);
});

test('backing off is self-scaling, so silence needs no table of thresholds', () => {
  const at = (agoDays) => nextInterval({ items: posts(10, 7, agoDays), now: NOW });

  // Each of these is a weekly blog; only the silence differs.
  // Inside three times its own rhythm the feed is not late, it is between
  // posts, so the interval does not move at all -- a weekly blog that misses a
  // week is still a weekly blog.
  assert.equal(at(3), at(21), 'a fortnight late is still on rhythm');

  const late = at(40);
  const sixMonths = at(180);
  const aYear = at(365);
  const twoYears = at(730);

  assert.ok(at(21) < late, 'past three cycles, the gap starts widening');
  assert.ok(late < sixMonths, 'and it keeps widening');
  assert.ok(sixMonths < aYear, 'monotonically, with no cliff');
  assert.equal(aYear, MAX_INTERVAL, 'reaching the ceiling after about a year of silence');
  assert.equal(twoYears, MAX_INTERVAL, 'and never exceeding it');
});

test('a feed that comes back is picked up again rather than written off', () => {
  // The reason the ceiling is 90 days and not "never". Same feed as the dead
  // one above, but it has just posted again.
  const returned = nextInterval({ items: posts(20, 7, 0.5), now: NOW });
  assert.ok(days(returned) < 5, `a returning feed is back on its rhythm -> ${days(returned).toFixed(1)}d`);
});

test('an undated feed keeps exactly the behaviour it had before', () => {
  // The small web is full of feeds with no dates at all, and they must not be
  // punished for it: this is the old doubling ladder, ceiling included.
  const undated = Array.from({ length: 5 }, () => ({ title: 'No date here' }));

  assert.equal(nextInterval({ items: undated, newItems: 3, now: NOW }), MIN_INTERVAL);
  assert.equal(nextInterval({ items: undated, newItems: 0, currentMinutes: 60, now: NOW }), 120);
  assert.equal(nextInterval({ items: undated, newItems: 0, currentMinutes: 120, now: NOW }), 240);
  assert.equal(
    nextInterval({ items: undated, newItems: 0, currentMinutes: 1440, now: NOW }),
    1440,
    'and stops at a day, because no dates is no evidence of abandonment',
  );
  assert.equal(nextInterval({ items: [], newItems: 0, currentMinutes: 60, now: NOW }), 120);
  assert.equal(nextInterval({ now: NOW }), 120, 'called with nothing at all');
});

test('one dated post is not a rhythm', () => {
  // A gap needs two dates. One is indistinguishable from none for scheduling.
  const single = [{ publishedAt: new Date(NOW - 5 * DAY).toISOString() }];
  assert.equal(nextInterval({ items: single, newItems: 0, currentMinutes: 60, now: NOW }), 120);
});

test('dates that cannot be believed are dropped rather than guessed at', () => {
  const t = (items) => publishedTimes(items, NOW);

  assert.equal(t([{ publishedAt: 'not a date' }]).length, 0, 'unparseable');
  assert.equal(t([{ publishedAt: null }, { publishedAt: '' }, {}]).length, 0, 'absent');

  // The one that matters: a feed stamping tomorrow on every entry would read as
  // permanently fresh and be polled at the floor for ever.
  const future = [{ publishedAt: new Date(NOW + 400 * DAY).toISOString() }];
  assert.equal(t(future).length, 0, 'far-future dates are not evidence of freshness');

  // A little skew is tolerated -- publishers and we do not share a clock.
  const skewed = [{ publishedAt: new Date(NOW + HOUR).toISOString() }];
  assert.equal(t(skewed).length, 1, 'an hour ahead is clock skew, not a broken feed');
});

test('a burst does not make a feed look like a firehose', () => {
  // Forty posts during one conference, monthly the rest of the year. The mean
  // gap describes neither; the median describes the ordinary month.
  const burst = Array.from({ length: 40 }, (_, i) => ({
    publishedAt: new Date(NOW - 30 * DAY - i * 60_000).toISOString(),
  }));
  const monthly = Array.from({ length: 6 }, (_, i) => ({
    publishedAt: new Date(NOW - (60 + i * 30) * DAY).toISOString(),
  }));

  const interval = nextInterval({ items: [...burst, ...monthly], now: NOW });
  assert.ok(interval > MIN_INTERVAL, `a burst alone does not pin it to the floor -> ${hours(interval).toFixed(1)}h`);
});

test('posts sharing a timestamp are one editorial act, not a rhythm of zero', () => {
  // A site that publishes its whole morning batch at 06:00 has real gaps of a
  // day, not of zero -- and a zero gap would divide the schedule to the floor.
  const batched = [];
  for (let d = 0; d < 8; d += 1) {
    for (let n = 0; n < 5; n += 1) {
      batched.push({ publishedAt: new Date(NOW - (d + 1) * DAY).toISOString() });
    }
  }
  const interval = nextInterval({ items: batched, now: NOW });
  assert.ok(interval >= MIN_INTERVAL, 'never below the floor');
  assert.ok(hours(interval) > 5, `same-instant posts do not read as continuous -> ${hours(interval).toFixed(1)}h`);
});

test('the result is always a whole number of minutes inside the bounds', () => {
  // Whatever it is handed. This is what actually goes into next_fetch_at, and
  // a NaN or a fraction there is a feed that is never due again.
  const cases = [
    { items: posts(10, 7, 1) },
    { items: posts(2, 0.001, 0) },
    { items: posts(30, 400, 900) },
    { items: [{ publishedAt: '1970-01-01T00:00:00.000Z' }, { publishedAt: '1970-01-02T00:00:00.000Z' }] },
    { items: undefined, newItems: undefined, currentMinutes: undefined },
    { items: [], currentMinutes: Number.NaN },
    { items: [], currentMinutes: -5 },
    { items: [], currentMinutes: Infinity },
  ];

  for (const input of cases) {
    const n = nextInterval({ ...input, now: NOW });
    assert.ok(Number.isInteger(n), `whole minutes, got ${n} for ${JSON.stringify(input).slice(0, 60)}`);
    assert.ok(n >= MIN_INTERVAL && n <= MAX_INTERVAL, `within bounds, got ${n}`);
  }
});

test('the ceiling still costs the directory almost nothing', () => {
  // 90 days on the long tail is the trade this ceiling makes, and it is worth
  // writing down: a quarter of 368k feeds checked four times a year is about
  // a thousand crawls a day, against a demand of 368k a day under the old cap.
  const dead = nextInterval({ items: posts(10, 30, 900), now: NOW });
  const perDay = 92_000 / days(dead);
  assert.ok(perDay < 2000, `the whole dead quarter costs ~${perDay.toFixed(0)} crawls a day`);
});
