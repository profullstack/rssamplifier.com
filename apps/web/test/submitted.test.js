import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clampRawInput,
  describeSubmittedInput,
  RAW_INPUT_BYTE_LIMIT,
  RAW_INPUT_LINE_LIMIT,
  PREVIEW_LIMIT,
} from '../src/lib/submitted.js';

/** A paste of `n` lines, each one a distinct URL. */
function lines(n) {
  return Array.from({ length: n }, (_, i) => `https://f${i}.example/feed`).join('\n');
}

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
  // The case that matters, and the one a strict parser cannot serve: only the
  // head of an upload is stored, so a catalogue past the cap ends mid-tag as
  // often as not. Measured against the live row for submission
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
  const input = describeSubmittedInput({ kind: 'list', raw_input: lines(RAW_INPUT_LINE_LIMIT) });
  assert.equal(input.truncated, true);

  const under = describeSubmittedInput({ kind: 'list', raw_input: lines(RAW_INPUT_LINE_LIMIT - 1) });
  assert.equal(under.truncated, false);

  const short = describeSubmittedInput({ kind: 'url', raw_input: 'https://a.example/feed' });
  assert.equal(short.truncated, false);
});

test('the cap counts lines, not characters', () => {
  // The whole point of the unit: a paste is long in feeds, not in bytes. Ten
  // thousand *characters* stopped at a couple of hundred URLs, so a list well
  // inside the cap has to survive whole.
  const paste = lines(2_000);

  assert.ok(paste.length > 50_000, 'the fixture is past the old character cap');
  assert.equal(clampRawInput(paste), paste, 'nothing is cut from a list under the line cap');
  assert.equal(describeSubmittedInput({ kind: 'list', raw_input: paste }).total, 2_000);
});

test('a paste past the cap keeps exactly the first RAW_INPUT_LINE_LIMIT lines', () => {
  const clamped = clampRawInput(lines(RAW_INPUT_LINE_LIMIT + 250));

  assert.equal(clamped.split('\n').length, RAW_INPUT_LINE_LIMIT);
  assert.ok(clamped.startsWith('https://f0.example/feed\n'), 'kept from the top');
  assert.ok(!clamped.endsWith('\n'), 'cut at a line boundary, with no dangling separator');
  assert.equal(describeSubmittedInput({ kind: 'list', raw_input: clamped }).truncated, true);
});

test('a file shorter than the cap is stored whole, however it ends', () => {
  assert.equal(clampRawInput('a\nb\nc'), 'a\nb\nc');
  assert.equal(clampRawInput('a\nb\nc\n'), 'a\nb\nc\n');
  assert.equal(clampRawInput(''), '');
  assert.equal(clampRawInput(null), '');
});

test('a minified upload is caught by the byte cap the line cap cannot see', () => {
  // One enormous line: "the first fifty thousand lines" is the entire document,
  // so without a second cap a minified OPML would be stored in full.
  const minified = `<opml><body>${'<outline xmlUrl="https://f.example/rss" />'.repeat(600_000)}`;

  assert.ok(minified.length > RAW_INPUT_BYTE_LIMIT, 'the fixture is past the byte cap');
  assert.equal(clampRawInput(minified).length, RAW_INPUT_BYTE_LIMIT);
  assert.equal(describeSubmittedInput({ kind: 'opml', raw_input: clampRawInput(minified) }).truncated, true);
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
