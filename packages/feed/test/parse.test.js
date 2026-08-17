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

  // Hex numeric entities are what most publishing tools emit for a curly
  // apostrophe. Left undecoded the residue survives tokenizing, and "#x27"
  // shows up as one of the blog's topics.
  assert.equal(summarize('Rust&#x27;s tooling'), "Rust's tooling");
  assert.equal(summarize('a &#8212; b'), 'a — b');
  assert.equal(summarize('bad &#x0;entity'), 'bad  entity'.replace(/\s+/g, ' '));

  // Named entities, which WordPress emits constantly. Undecoded, their names
  // survive tokenizing as words — "rsquo" was the seventh most common topic in
  // the whole directory, ahead of "code" and "software".
  assert.equal(summarize('I&rsquo;ve seen it'), "I've seen it");
  assert.equal(summarize('&ldquo;quoted&rdquo;'), '"quoted"');
  assert.equal(summarize('a &mdash; b'), 'a - b');
  assert.equal(summarize('and so on&hellip;'), 'and so on…');

  // An entity this list does not know is dropped rather than left as a word.
  assert.equal(summarize('spaced&thinsp;out'), 'spaced out');
  assert.equal(summarize('a&nonsense;b'), 'a b');

  // Text that merely looks like an entity is left alone.
  assert.equal(summarize('Tom & Jerry'), 'Tom & Jerry');

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

// ---------------------------------------------------------------- kind

const PODCAST_RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <title>Linux Matters</title>
    <link>https://linuxmatters.sh/</link>
    <description>A show</description>
    <itunes:author>Linux Matters</itunes:author>
    <itunes:type>episodic</itunes:type>
    <itunes:category text="Technology"/>
    <itunes:explicit>false</itunes:explicit>
    <itunes:image href="https://linuxmatters.sh/cover.png"/>
    <podcast:guid>8367df70-b8a6-11f0-98a7-bdf3d3f7c22c</podcast:guid>
    <item>
      <title>Herding online exams</title>
      <link>https://linuxmatters.sh/87/</link>
      <guid>https://linuxmatters.sh/87/</guid>
      <description>Episode notes</description>
      <enclosure url="https://audio.linuxmatters.net/LMP87.mp3" length="25464080" type="audio/mpeg"/>
    </item>
  </channel>
</rss>`;

const AUDIO_ONLY_RSS = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Hand-rolled show</title>
    <link>https://s.example/</link>
    <description>No namespaces at all</description>
    <item>
      <title>Episode one</title>
      <guid>https://s.example/1</guid>
      <enclosure url="https://s.example/1.mp3" type="audio/mpeg" length="1"/>
    </item>
  </channel>
</rss>`;

const IMAGE_ENCLOSURE_RSS = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Photo blog</title>
    <link>https://p.example/</link>
    <description>Pictures</description>
    <item>
      <title>A picture</title>
      <guid>https://p.example/1</guid>
      <enclosure url="https://p.example/1.jpg" type="image/jpeg" length="1"/>
    </item>
  </channel>
</rss>`;

test('a feed carrying the podcast namespaces is a podcast', () => {
  const feed = parseFeed(PODCAST_RSS);
  assert.equal(feed.kind, 'podcast');
  assert.equal(feed.title, 'Linux Matters');
  // Cover art comes from itunes:image when the plain <image> element is absent,
  // which is the common shape from podcast hosting.
  assert.equal(feed.imageUrl, 'https://linuxmatters.sh/cover.png');
});

test('audio without the podcast namespaces is music, not a podcast', () => {
  // The distinction the four categories exist for: a netlabel posting tracks
  // and a show posting episodes both attach mp3s, and only one of them filled
  // in itunes:category.
  assert.equal(parseFeed(AUDIO_ONLY_RSS).kind, 'music');
});

test('a YouTube channel feed is a video feed, and its entries carry an embed', () => {
  const yt = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/"
      xmlns="http://www.w3.org/2005/Atom">
  <yt:channelId>UCsBjURrPoezykLs9EqgamOA</yt:channelId>
  <title>Fireship</title>
  <link rel="alternate" href="https://www.youtube.com/channel/UCsBjURrPoezykLs9EqgamOA"/>
  <entry>
    <id>yt:video:m0dXfytm-hY</id>
    <yt:videoId>m0dXfytm-hY</yt:videoId>
    <title>Something in 100 seconds</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=m0dXfytm-hY"/>
  </entry>
</feed>`;

  const feed = parseFeed(yt);
  assert.equal(feed.kind, 'video');
  // The watch page refuses to be framed; the embed is the only playable form.
  assert.equal(feed.items[0].audio.url, 'https://www.youtube-nocookie.com/embed/m0dXfytm-hY');
  assert.equal(feed.items[0].audio.type, 'video/youtube');
});

test('an audio enclosure is kept as media, with its length and duration', () => {
  const feed = parseFeed(PODCAST_RSS);
  assert.equal(feed.items[0].audio.url, 'https://audio.linuxmatters.net/LMP87.mp3');
  assert.equal(feed.items[0].audio.type, 'audio/mpeg');
  assert.equal(feed.items[0].audio.bytes, 25464080);
});

test('an ordinary blog stays a blog in every format', () => {
  assert.equal(parseFeed(RSS).kind, 'blog');
  assert.equal(parseFeed(ATOM).kind, 'blog');
  assert.equal(parseFeed(JSON_FEED).kind, 'blog');
});

test('an atom feed with an audio enclosure link is music', () => {
  const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom show</title>
  <link rel="alternate" href="https://a.example/"/>
  <entry>
    <id>1</id>
    <title>Episode</title>
    <link rel="alternate" href="https://a.example/1"/>
    <link rel="enclosure" type="audio/mpeg" href="https://a.example/1.mp3"/>
  </entry>
</feed>`;
  assert.equal(parseFeed(atom).kind, 'music');
});

test('a JSON feed with an audio attachment is music', () => {
  const json = JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: 'JSON show',
    items: [
      {
        id: '1',
        url: 'https://j.example/1',
        title: 'Episode',
        attachments: [{ url: 'https://j.example/1.mp3', mime_type: 'audio/mpeg' }],
      },
    ],
  });
  assert.equal(parseFeed(json).kind, 'music');
});

test('category tags are read from every format that has them', () => {
  const rss = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Tagged</title><link>https://t.example/</link><description>Tags</description>
  <category>Technology</category>
  <item>
    <title>A post about several things</title>
    <guid>https://t.example/1</guid>
    <category>Linux</category>
    <category>Home Lab</category>
    <category>linux</category>
  </item>
</channel></rss>`;

  const feed = parseFeed(rss);
  assert.deepEqual(feed.categories, ['Technology']);
  assert.deepEqual(
    feed.items[0].categories,
    ['Linux', 'Home Lab'],
    'the duplicate differing only in case collapsed',
  );

  // Atom keeps the value in an attribute rather than the element.
  const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom tagged</title>
  <entry><id>1</id><title>Post</title><category term="Rust"/><category term="Async"/></entry>
</feed>`;
  assert.deepEqual(parseFeed(atom).items[0].categories, ['Rust', 'Async']);

  // iTunes keeps it in `text`, which is how a podcast declares its genre.
  assert.deepEqual(parseFeed(PODCAST_RSS).categories, ['Technology']);

  // JSON Feed calls them tags.
  const json = JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: 'JSON tagged',
    items: [{ id: '1', title: 'Post', tags: ['Design', 'Type'] }],
  });
  assert.deepEqual(parseFeed(json).items[0].categories, ['Design', 'Type']);

  // A feed with no categories at all — the common case — yields empty lists
  // rather than undefined, so callers never have to check.
  assert.deepEqual(parseFeed(RSS).categories, []);
  assert.deepEqual(parseFeed(RSS).items[0].categories, []);
});

test('an audio enclosure is not mistaken for the item image', () => {
  // <enclosure> used to be read as an image unconditionally, which would put an
  // mp3 in the image slot of every episode of every podcast in the directory.
  assert.equal(parseFeed(PODCAST_RSS).items[0].imageUrl, '');
  assert.equal(parseFeed(IMAGE_ENCLOSURE_RSS).items[0].imageUrl, 'https://p.example/1.jpg');
});
