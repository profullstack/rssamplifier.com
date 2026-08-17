import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describe as say, textLine, toLine, tone } from '../src/lib/crawlLog.js';
import { frame, line } from '../src/lib/sse.js';

const decoder = new TextDecoder();

test('a row becomes a line without losing the difference between none and zero', () => {
  const entry = toLine({
    id: 7n,
    at: '2026-08-17T12:00:00.000Z',
    event: 'feed',
    status: 'ok',
    subject: 'Example Blog',
    slug: 'example-blog',
    amount: 0,
    detail: null,
    ms: null,
  });

  assert.equal(entry.id, 7, 'libSQL hands back bigints and the client cannot render one');
  assert.equal(entry.amount, 0, 'a crawl that stored nothing stored zero, not nothing');
  assert.equal(entry.ms, null);
  assert.equal(entry.detail, null);
});

test('a crawled feed says what it added', () => {
  assert.equal(
    say({ event: 'feed', status: 'ok', subject: 'Example Blog', amount: 3 }),
    'crawled Example Blog — 3 new posts',
  );
  assert.equal(
    say({ event: 'feed', status: 'ok', subject: 'Example Blog', amount: 1 }),
    'crawled Example Blog — 1 new post',
  );
  // The common case by far, and it must not read as an error.
  assert.equal(
    say({ event: 'feed', status: 'ok', subject: 'Example Blog', amount: 0 }),
    'crawled Example Blog — nothing new',
  );
});

test('a failed feed says why', () => {
  assert.equal(
    say({ event: 'feed', status: 'error', subject: 'Example Blog', detail: 'http-404' }),
    'Example Blog could not be crawled — http-404',
  );
});

test("a batch summary leads with the backlog, because that is what says whether it's keeping up", () => {
  const text = say({
    event: 'crawl',
    detail: JSON.stringify({ crawled: 25, failed: 2, items: 12, due: 4021 }),
  });

  assert.match(text, /25 crawled/);
  assert.match(text, /2 failed/);
  assert.match(text, /12 posts stored/);
  assert.match(text, /4,021 still due/);
});

test('the picture hunt says what it found, not just how many it looked at', () => {
  // Shipped without wording, so every one of these lines was printing raw JSON in
  // the live log. Three numbers because "looked at 8 feeds" does not say whether
  // it is finding anything.
  const text = say({
    event: 'cards',
    detail: JSON.stringify({ looked: 8, found: 3, cards: 2, pending: 53_696 }),
  });

  assert.match(text, /looked at 8 feeds/);
  assert.match(text, /3 found/);
  assert.match(text, /2 usable as a card/);
  assert.match(text, /53,696 still to check/);

  assert.equal(
    say({ event: 'card-error', status: 'error', subject: 'example.com', detail: 'timeout' }),
    'could not look up a picture for example.com — timeout',
  );
});

test('the cluster walk reports scanned and keyed separately', () => {
  // They differ on purpose: it reads a page of rows and writes only the un-keyed
  // ones, so scanned-without-keyed is the walk re-crossing old ground rather than
  // the walk doing nothing.
  const text = say({
    event: 'cluster-backfill',
    detail: JSON.stringify({ scanned: 500, keyed: 0 }),
  });

  assert.match(text, /500 scanned/);
  assert.match(text, /0 keyed/);
  assert.match(say({ event: 'cluster-backfill-done', detail: '{}' }), /finished/);
});

test('an event nobody taught the renderer about still shows up', () => {
  // The point of the fallback: adding an event to the poller must not make the
  // log quieter until somebody remembers to teach this file about it.
  const text = say({ event: 'something-new', subject: 'x', detail: '{"n":1}' });

  assert.match(text, /something-new/);
  assert.match(text, /\{"n":1\}/);
});

test('a payload that is a message rather than JSON is not swallowed', () => {
  assert.equal(
    say({ event: 'crawl-error', status: 'error', detail: 'connection reset' }),
    'crawl-error connection reset',
  );
});

test('the text form does not repeat the event it already has a column for', () => {
  // "crawl-error crawl-error database is locked" is what this prevents.
  const text = textLine({
    at: '2026-08-17T12:00:00.000Z',
    event: 'crawl-error',
    status: 'error',
    detail: 'SQLITE_BUSY: database is locked',
  });

  assert.equal(text.match(/crawl-error/g).length, 1);
  assert.match(text, /SQLITE_BUSY: database is locked$/);
});

test('one text line is one line, whatever the feed is called', () => {
  const text = textLine({
    at: '2026-08-17T12:00:00.000Z',
    event: 'feed',
    status: 'error',
    subject: 'A blog\nwith a newline in its title',
    detail: 'timeout',
    ms: 900,
  });

  assert.ok(text.startsWith('2026-08-17T12:00:00.000Z error'), 'timestamp first, then the level');
  assert.match(text, /timeout/);
  assert.match(text, /\(900ms\)/);

  // A title containing a newline would otherwise turn one log line into two, and
  // whatever is reading the stream would see a truncated line and a fragment.
  assert.equal(decoder.decode(line(text)).match(/\n/g).length, 1);
});

test('only failures are coloured', () => {
  assert.equal(tone({ status: 'error' }), 'bad');
  assert.equal(tone({ status: 'ok' }), 'good');
  assert.equal(tone({ status: null }), 'plain');
});

test('a frame carries its row id so a reconnect resumes from it', () => {
  const text = decoder.decode(frame('log', { id: 42 }, 42));

  assert.equal(text, 'id: 42\nevent: log\ndata: {"id":42}\n\n');
});

test('an id that is not a row number is left off rather than trusted', () => {
  // The id field is newline-delimited like every other, so anything that is not
  // digits could end the frame early. Nothing we issue is not digits.
  assert.ok(!decoder.decode(frame('log', {}, 'x\nevent: fake')).startsWith('id:'));
  assert.ok(!decoder.decode(frame('log', {}, null)).startsWith('id:'));
});

test('topic discovery names the keywords instead of printing NaN', () => {
  // The poller sends the keywords themselves, and the renderer used to hand
  // that array to Number(). Every one of these lines read "NaN keywords
  // queued" in the live log.
  assert.equal(
    say({
      event: 'discovery-topics',
      detail: JSON.stringify({ keywords: ['home lab', 'self hosting', 'rss'], runId: 'r1' }),
    }),
    'looked for more of what we already cover — 3 keywords queued: home lab, self hosting, rss',
  );

  assert.equal(
    say({ event: 'discovery-topics', detail: JSON.stringify({ keywords: ['home lab'] }) }),
    'looked for more of what we already cover — 1 keyword queued: home lab',
  );
});

test('topic discovery still reads correctly if it is ever given a count', () => {
  assert.equal(
    say({ event: 'discovery-topics', detail: JSON.stringify({ keywords: 3 }) }),
    'looked for more of what we already cover — 3 keywords queued',
  );
  assert.equal(
    say({ event: 'discovery-topics', detail: null }),
    'looked for more of what we already cover — 0 keywords queued',
  );
});
