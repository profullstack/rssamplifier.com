import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  attrOf,
  createScanner,
  decodeXml,
  scanOutlines,
  scanUrls,
  sniffKind,
} from '../src/lib/opml-scan.js';

test('an outline yields its feed URL, title and site', () => {
  const xml = `<outline text="Alpha" title="Alpha" type="rss"
    xmlUrl="https://a.example/feed.xml" htmlUrl="https://a.example/" />`;

  assert.deepEqual(scanOutlines(xml), [
    { url: 'https://a.example/feed.xml', title: 'Alpha', siteUrl: 'https://a.example/' },
  ]);
});

test('a folder outline contributes nothing but its children still count', () => {
  const xml = `<outline text="News">
    <outline text="Quartz" xmlUrl="https://qz.com/feed" />
  </outline>`;

  const found = scanOutlines(xml);
  assert.equal(found.length, 1);
  assert.equal(found[0].url, 'https://qz.com/feed');
});

test('entities in an attribute are decoded', () => {
  // The one that matters: a query string in an OPML attribute is written with
  // &amp;, and a feed queued with the literal text is a different URL.
  const xml = `<outline text="Tom &amp; Jerry" xmlUrl="https://x.example/feed?a=1&amp;b=2" />`;
  const [feed] = scanOutlines(xml);

  assert.equal(feed.url, 'https://x.example/feed?a=1&b=2');
  assert.equal(feed.title, 'Tom & Jerry');
});

test('numeric character references are decoded too', () => {
  assert.equal(decodeXml('caf&#233;'), 'café');
  assert.equal(decodeXml('caf&#xe9;'), 'café');
});

test('single-quoted attributes are read as well as double', () => {
  const xml = `<outline text='Hand written' xmlUrl='https://h.example/rss' />`;
  const [feed] = scanOutlines(xml);

  assert.equal(feed.url, 'https://h.example/rss');
  assert.equal(feed.title, 'Hand written');
});

test('an attribute that is not there is null, not empty string', () => {
  assert.equal(attrOf('<outline xmlUrl="x" />', 'htmlUrl'), null);
});

test('a document fed in arbitrary chunks yields every feed exactly once', () => {
  const feeds = Array.from(
    { length: 250 },
    (_, i) => `    <outline text="Feed ${i}" type="rss" xmlUrl="https://f${i}.example/rss" />\n`,
  ).join('');
  const xml = `<?xml version="1.0"?>\n<opml version="2.0">\n<head><title>Big</title></head>\n<body>\n${feeds}</body>\n</opml>\n`;

  // 37 is deliberately awkward: it lands mid-tag, mid-attribute and mid-URL
  // over the course of the document, which is exactly the case a scanner that
  // forgot to carry its tail gets wrong.
  const scanner = createScanner('opml');
  const found = [];
  for (let at = 0; at < xml.length; at += 37) {
    found.push(...scanner.push(xml.slice(at, at + 37)));
  }
  found.push(...scanner.end());

  assert.equal(found.length, 250);
  assert.equal(found[0].url, 'https://f0.example/rss');
  assert.equal(found[249].url, 'https://f249.example/rss');
  assert.equal(new Set(found.map((f) => f.url)).size, 250);
});

test('a list fed in chunks does not tear a URL across the boundary', () => {
  const text = Array.from({ length: 100 }, (_, i) => `https://l${i}.example/feed.xml`).join('\n');

  const scanner = createScanner('list');
  const found = [];
  for (let at = 0; at < text.length; at += 11) {
    found.push(...scanner.push(text.slice(at, at + 11)));
  }
  found.push(...scanner.end());

  assert.equal(found.length, 100);
  assert.equal(found[99].url, 'https://l99.example/feed.xml');
});

test('a list separated by commas or spaces splits the same way the endpoint does', () => {
  assert.deepEqual(
    scanUrls('a.example, b.example\nc.example  d.example').map((e) => e.url),
    ['a.example', 'b.example', 'c.example', 'd.example'],
  );
});

test('the kind of a file is read from its contents, then from its name', () => {
  assert.equal(sniffKind({ name: 'subs.opml' }, ''), 'opml');
  // The case the old order got wrong: a reader that writes OPML into a file
  // called .txt is still writing OPML, and scanning it for bare URLs finds
  // nothing usable in it at all.
  assert.equal(sniffKind({ name: 'feeds.txt' }, '<opml>'), 'opml');
  assert.equal(sniffKind({ name: 'feeds.txt' }, 'https://a.example/feed'), 'list');
  // No usable extension, so the file itself decides — a reader that exports
  // OPML as "export" should still import as OPML.
  assert.equal(sniffKind({ name: 'export' }, '<?xml version="1.0"?><opml>'), 'opml');
  assert.equal(sniffKind({ name: 'export' }, 'https://a.example/feed'), 'list');
  // An outline is signature enough on its own: a fragment pasted out of a
  // subscription list has no <opml> root to find.
  assert.equal(sniffKind({ name: 'export' }, '<outline xmlUrl="https://a.example/f" />'), 'opml');
});

test('a real subscription list scans one feed per line, however it is chunked', () => {
  // The size the cap is written for, fed through the scanner the way the
  // uploader feeds it: a hundred and eight thousand lines, read a megabyte at
  // a time. The count is the whole point — a boundary landing mid-URL used to
  // cost one feed per chunk, silently.
  const total = 108_000;
  const text = Array.from({ length: total }, (_, i) => `https://f${i}.example/feed.xml`).join('\n');

  const scanner = createScanner('list');
  const found = [];
  const slice = 1 << 20;

  for (let at = 0; at < text.length; at += slice) {
    found.push(...scanner.push(text.slice(at, at + slice)));
  }
  found.push(...scanner.end());

  assert.equal(found.length, total);
  assert.equal(found[0].url, 'https://f0.example/feed.xml');
  assert.equal(found.at(-1).url, `https://f${total - 1}.example/feed.xml`);
  assert.equal(new Set(found.map((f) => f.url)).size, total);
});
