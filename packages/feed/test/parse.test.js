import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseFeed, summarize } from '../src/parse.js';
import { parseOpml, buildOpml } from '../src/opml.js';

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Chovy's Blog</title>
    <link>https://example.com/</link>
    <description>Tech &amp; agentic coding</description>
    <language>en</language>
    <item>
      <title>First post</title>
      <link>https://example.com/1</link>
      <guid>https://example.com/1</guid>
      <description>&lt;p&gt;Hello &lt;b&gt;world&lt;/b&gt;&lt;/p&gt;</description>
      <content:encoded>&lt;p&gt;Full body&lt;/p&gt;</content:encoded>
      <dc:creator>Anthony</dc:creator>
      <pubDate>Tue, 12 Aug 2026 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Blog</title>
  <subtitle>Notes</subtitle>
  <link rel="self" href="https://a.example/feed"/>
  <link rel="alternate" href="https://a.example/"/>
  <entry>
    <id>tag:a.example,2026:1</id>
    <title>Atom post</title>
    <link rel="alternate" href="https://a.example/post-1"/>
    <updated>2026-08-01T00:00:00Z</updated>
    <author><name>Preshy</name></author>
    <summary>A summary</summary>
  </entry>
</feed>`;

const JSON_FEED = JSON.stringify({
  version: 'https://jsonfeed.org/version/1.1',
  title: 'JSON Blog',
  home_page_url: 'https://j.example/',
  items: [
    {
      id: '1',
      url: 'https://j.example/1',
      title: 'JSON post',
      content_html: '<p>Body text</p>',
      date_published: '2026-07-01T00:00:00Z',
    },
  ],
});

test('parses RSS 2.0 including namespaced fields', () => {
  const feed = parseFeed(RSS);
  assert.equal(feed.title, "Chovy's Blog");
  assert.equal(feed.siteUrl, 'https://example.com/');
  assert.equal(feed.description, 'Tech & agentic coding');
  assert.equal(feed.items.length, 1);

  const [item] = feed.items;
  assert.equal(item.title, 'First post');
  assert.equal(item.author, 'Anthony');
  assert.equal(item.summary, 'Hello world', 'HTML is stripped from the summary');
  assert.equal(item.contentHtml, '<p>Full body</p>', 'content:encoded wins over description');
  assert.equal(item.publishedAt, '2026-08-12T10:00:00.000Z');
});

test('parses Atom and picks the alternate link, not self', () => {
  const feed = parseFeed(ATOM);
  assert.equal(feed.title, 'Atom Blog');
  assert.equal(feed.siteUrl, 'https://a.example/', 'rel=alternate wins over rel=self');
  assert.equal(feed.items[0].url, 'https://a.example/post-1');
  assert.equal(feed.items[0].author, 'Preshy');
});

test('parses JSON Feed', () => {
  const feed = parseFeed(JSON_FEED);
  assert.equal(feed.title, 'JSON Blog');
  assert.equal(feed.items[0].summary, 'Body text');
});

test('returns null for things that are not feeds', () => {
  assert.equal(parseFeed('<html><body>hi</body></html>'), null);
  assert.equal(parseFeed('not xml at all'), null);
  assert.equal(parseFeed(''), null);
  assert.equal(parseFeed('{"nope":true}'), null);
});

test('summarize strips markup, decodes entities and cuts on a word boundary', () => {
  assert.equal(summarize('<p>Hello &amp; welcome</p>'), 'Hello & welcome');
  assert.equal(summarize('<script>evil()</script><p>safe</p>'), 'safe');

  const long = summarize('word '.repeat(200), 50);
  assert.ok(long.length <= 52, `expected a truncated string, got ${long.length}`);
  assert.ok(long.endsWith('…'));
  assert.ok(!long.includes('wor…'), 'must not cut mid-word');
});

test('parses nested OPML folders and dedupes', () => {
  const opml = `<?xml version="1.0"?>
  <opml version="2.0"><body>
    <outline text="Folder">
      <outline text="A" xmlUrl="https://a.example/feed"/>
      <outline text="B" xmlUrl="https://b.example/feed"/>
    </outline>
    <outline text="A again" xmlUrl="https://a.example/feed"/>
  </body></opml>`;

  const feeds = parseOpml(opml);
  assert.equal(feeds.length, 2, 'duplicate xmlUrl collapsed');
  assert.deepEqual(
    feeds.map((f) => f.url),
    ['https://a.example/feed', 'https://b.example/feed'],
  );
});

test('malformed OPML yields an empty list rather than throwing', () => {
  assert.deepEqual(parseOpml('<opml><body><outline'), []);
  assert.deepEqual(parseOpml(''), []);
});

test('buildOpml escapes attribute values', () => {
  const xml = buildOpml([
    { title: 'Tom & "Jerry"', feed_url: 'https://x.example/feed?a=1&b=2', site_url: null },
  ]);
  assert.ok(xml.includes('&amp;'), 'ampersand escaped');
  assert.ok(xml.includes('&quot;'), 'quote escaped');
  assert.ok(!xml.includes('"Jerry"'), 'raw quotes must not survive into the attribute');
});
