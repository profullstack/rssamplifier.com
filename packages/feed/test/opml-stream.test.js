import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseOpml } from '../src/opml.js';
import { streamOpmlOutlines, OpmlTooLargeError } from '../src/opml-stream.js';

/** Collect a whole stream, for the cases where the point is the result. */
async function collect(source, opts) {
  const out = [];
  for await (const entry of streamOpmlOutlines(source, opts)) out.push(entry);
  return out;
}

/** Cut `text` into fixed-size pieces, to put a boundary everywhere in turn. */
function* sliced(text, size) {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

/** The same, as bytes, which is what an upload actually delivers. */
function* bytes(text, size) {
  const buf = Buffer.from(text, 'utf8');
  for (let i = 0; i < buf.length; i += size) yield new Uint8Array(buf.subarray(i, i + size));
}

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Subs</title></head>
  <body>
    <outline text="News">
      <outline text="Quartz" type="rss" xmlUrl="https://qz.com/feed" htmlUrl="https://qz.com" />
      <outline title="Citizen" text="Ottawa Citizen" xmlUrl="https://ottawacitizen.com/feed" />
    </outline>
    <outline text="Ben &amp; Jerry" xmlUrl="https://bj.example/rss" />
  </body>
</opml>`;

test('the stream finds every feed the tree parser finds', async () => {
  const streamed = await collect([SAMPLE]);
  const parsed = parseOpml(SAMPLE);

  assert.deepEqual(
    streamed.map((e) => e.url),
    parsed.map((e) => e.url),
  );
  assert.deepEqual(
    streamed.map((e) => e.title),
    parsed.map((e) => e.title),
  );
});

test('a folder is not a feed, and an entity in a title is decoded', async () => {
  const found = await collect([SAMPLE]);

  assert.equal(found.length, 3, 'the <outline text="News"> folder is not one of them');
  assert.equal(found[2].title, 'Ben & Jerry');
  assert.equal(found[0].siteUrl, 'https://qz.com');
  assert.equal(found[1].siteUrl, null, 'no htmlUrl is null, not empty string');
});

test('title wins over text, matching the tree parser', async () => {
  const [entry] = await collect([SAMPLE.slice(SAMPLE.indexOf('<outline title="Citizen"'))]);
  assert.equal(entry.title, 'Citizen');
});

test('a tag split across chunks is still found, at every possible boundary', async () => {
  // The bug this guards is silent: a split inside `<outline` or inside an
  // attribute drops the feed with nothing to show for it. So rather than pick a
  // chunk size, walk every one from a single character upwards.
  const expected = parseOpml(SAMPLE).map((e) => e.url);

  for (let size = 1; size <= 64; size++) {
    const found = await collect(sliced(SAMPLE, size));
    assert.deepEqual(
      found.map((e) => e.url),
      expected,
      `chunk size ${size}`,
    );
  }
});

test('bytes arriving in chunks read the same as the whole string', async () => {
  for (const size of [1, 3, 7, 16, 64, 4096]) {
    const found = await collect(bytes(SAMPLE, size));
    assert.deepEqual(
      found.map((e) => e.url),
      parseOpml(SAMPLE).map((e) => e.url),
      `byte chunk size ${size}`,
    );
  }
});

test('a multi-byte character split across two chunks survives', async () => {
  // 'é' is two bytes in UTF-8; a naive per-chunk decode turns a split one into
  // two replacement characters.
  const xml = '<opml><body><outline text="Café" xmlUrl="https://c.example/rss" /></body></opml>';
  const buf = Buffer.from(xml, 'utf8');
  const at = buf.indexOf(Buffer.from('é', 'utf8')) + 1;

  const found = await collect([
    new Uint8Array(buf.subarray(0, at)),
    new Uint8Array(buf.subarray(at)),
  ]);

  assert.equal(found[0].title, 'Café');
});

test('single-quoted attributes and odd spacing are read', async () => {
  const found = await collect([
    `<outline text = 'Odd'   xmlUrl = 'https://o.example/rss' ></outline>`,
  ]);

  assert.equal(found.length, 1);
  assert.equal(found[0].url, 'https://o.example/rss');
  assert.equal(found[0].title, 'Odd');
});

test('memory stays flat across a file far larger than the buffer', async () => {
  // The whole reason the scanner exists. 100k outlines is ~8 MiB of OPML; the
  // tree parser needs an order of magnitude more than the file, this needs one
  // partial tag.
  function* huge() {
    yield '<opml><body>';
    for (let i = 0; i < 100_000; i++) {
      yield `<outline text="F${i}" xmlUrl="https://f${i}.example/rss" />`;
    }
    yield '</body></opml>';
  }

  const before = process.memoryUsage().heapUsed;
  let count = 0;
  let peak = before;

  for await (const _entry of streamOpmlOutlines(huge())) {
    count += 1;
    if ((count & 0x3fff) === 0) peak = Math.max(peak, process.memoryUsage().heapUsed);
  }

  assert.equal(count, 100_000);
  const grew = (peak - before) / 1024 / 1024;
  assert.ok(grew < 64, `held onto ${grew.toFixed(0)} MiB, which is not flat`);
});

test('an unterminated tag is abandoned rather than buffered forever', async () => {
  function* stuck() {
    yield '<opml><body><outline xmlUrl="https://a.example/rss" /><outline ';
    // 1 MiB of attribute that never closes, then a real feed after it.
    for (let i = 0; i < 16; i++) yield 'x'.repeat(64 * 1024);
    yield '><outline xmlUrl="https://b.example/rss" />';
  }

  const found = await collect(stuck());

  assert.deepEqual(
    found.map((e) => e.url),
    ['https://a.example/rss', 'https://b.example/rss'],
    'the runaway tag is dropped and scanning resumes after it',
  );
});

test('a stream past its byte ceiling raises OpmlTooLargeError', async () => {
  function* big() {
    for (let i = 0; i < 100; i++) yield 'x'.repeat(1024);
  }

  await assert.rejects(() => collect(big(), { maxBytes: 4096 }), OpmlTooLargeError);

  // And one exactly at the ceiling does not.
  await assert.doesNotReject(() => collect(['x'.repeat(4096)], { maxBytes: 4096 }));
});

test('nothing that looks like OPML yields nothing, without buffering the file', async () => {
  function* prose() {
    for (let i = 0; i < 500; i++) yield 'this is not an opml document at all. ';
  }

  assert.deepEqual(await collect(prose()), []);
});
