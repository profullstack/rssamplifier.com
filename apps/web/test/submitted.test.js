import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  describeSubmittedInput,
  RAW_INPUT_LIMIT,
  PREVIEW_LIMIT,
} from '../src/lib/submitted.js';

test('a single URL submission names the feed it was', () => {
  const input = describeSubmittedInput({ kind: 'url', raw_input: 'https://example.com/feed.xml' });

  assert.equal(input.kind, 'url');
  assert.equal(input.total, 1);
  assert.deepEqual(input.entries, [{ url: 'https://example.com/feed.xml', title: null }]);
  assert.equal(input.truncated, false);
});

test('a list keeps every URL, in the order they were pasted', () => {
  const input = describeSubmittedInput({
    kind: 'list',
    raw_input: 'https://a.example/feed\nhttps://b.example/feed\nhttps://c.example/feed',
  });

  assert.equal(input.total, 3);
  assert.deepEqual(
    input.entries.map((e) => e.url),
    ['https://a.example/feed', 'https://b.example/feed', 'https://c.example/feed'],
  );
});

test('an OPML file is named by its own title and owner', () => {
  const xml = `<?xml version="1.0"?>
<opml version="2.0">
  <head><title>Curated sources — brisk.news</title><ownerName>brisk.news</ownerName></head>
  <body>
    <outline text="Ottawa Citizen" type="rss" xmlUrl="https://ottawacitizen.com/feed" />
    <outline text="Quartz" type="rss" xmlUrl="https://qz.com/feed" />
  </body>
</opml>`;

  const input = describeSubmittedInput({ kind: 'opml', raw_input: xml });

  assert.equal(input.title, 'Curated sources — brisk.news');
  assert.equal(input.owner, 'brisk.news');
  assert.equal(input.total, 2);
  assert.equal(input.entries[0].title, 'Ottawa Citizen');
  assert.equal(input.entries[0].url, 'https://ottawacitizen.com/feed');
});

test('a truncated OPML still lists what survived the cut', () => {
  // The case that matters, and the one a strict parser cannot serve: what is
  // stored is the first RAW_INPUT_LIMIT characters of an upload, so any real
  // catalogue ends mid-tag. Measured against the live row for submission
  // 5bee574b: fast-xml-parser returned 0 entries where a lenient scan found 66.
  const head = `<?xml version="1.0"?>
<opml version="2.0">
  <head><title>Big catalogue</title></head>
  <body>
`;
  const rows = Array.from(
    { length: 40 },
    (_, i) => `    <outline text="Feed ${i}" type="rss" xmlUrl="https://f${i}.example/rss" />\n`,
  ).join('');

  // Cut mid-attribute, exactly the way the stored copy is.
  const cut = `${head}${rows}    <outline text="Half a feed" type="rss" xmlUrl="https://f40.exa`;

  const input = describeSubmittedInput({ kind: 'opml', raw_input: cut });

  assert.equal(input.title, 'Big catalogue');
  assert.equal(input.total, 40, 'every complete outline, and not the half one');
  assert.equal(input.entries[0].url, 'https://f0.example/rss');
});

test('the preview is capped, and says how much it is not showing', () => {
  const rows = Array.from(
    { length: PREVIEW_LIMIT + 12 },
    (_, i) => `<outline text="Feed ${i}" xmlUrl="https://f${i}.example/rss" />`,
  ).join('\n');

  const input = describeSubmittedInput({ kind: 'opml', raw_input: `<opml><body>${rows}</body></opml>` });

  assert.equal(input.entries.length, PREVIEW_LIMIT);
  assert.equal(input.total, PREVIEW_LIMIT + 12);
});

test('input at the storage cap is reported as truncated', () => {
  const input = describeSubmittedInput({ kind: 'opml', raw_input: 'x'.repeat(RAW_INPUT_LIMIT) });
  assert.equal(input.truncated, true);

  const short = describeSubmittedInput({ kind: 'url', raw_input: 'https://a.example/feed' });
  assert.equal(short.truncated, false);
});

test('duplicate feed URLs are listed once', () => {
  const xml = `<opml><body>
    <outline text="A" xmlUrl="https://a.example/feed" />
    <outline text="A again" xmlUrl="https://A.example/feed" />
  </body></opml>`;

  assert.equal(describeSubmittedInput({ kind: 'opml', raw_input: xml }).total, 1);
});

test('XML entities in a title are decoded, not shown raw', () => {
  const xml = `<opml><head><title>Ben &amp; Jerry</title></head><body>
    <outline text="Tom &amp; Jerry" xmlUrl="https://t.example/feed" /></body></opml>`;

  const input = describeSubmittedInput({ kind: 'opml', raw_input: xml });

  assert.equal(input.title, 'Ben & Jerry');
  assert.equal(input.entries[0].title, 'Tom & Jerry');
});

test('nothing stored means nothing claimed', () => {
  assert.equal(describeSubmittedInput({ kind: 'url', raw_input: '' }), null);
  assert.equal(describeSubmittedInput({ kind: 'url', raw_input: '   ' }), null);
  assert.equal(describeSubmittedInput({}), null);
  assert.equal(describeSubmittedInput(null), null);
});

test('an outline with no feed URL is not an entry', () => {
  // OPML uses bare outlines as folders. A folder is not something that was
  // submitted, and listing it as one would be a row that goes nowhere.
  const xml = `<opml><body>
    <outline text="News">
      <outline text="Quartz" xmlUrl="https://qz.com/feed" />
    </outline>
  </body></opml>`;

  const input = describeSubmittedInput({ kind: 'opml', raw_input: xml });

  assert.equal(input.total, 1);
  assert.equal(input.entries[0].url, 'https://qz.com/feed');
});
