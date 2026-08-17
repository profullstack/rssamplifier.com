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

test('audio without the podcast namespaces is a blog, not music', () => {
  // Attaching an mp3 to a post says nothing about what the feed is: a narrated
  // article, a conference talk and a cross-posted episode all look like this,
  // and reading them as tracks filled the music category with 198 blogs.
  assert.equal(parseFeed(AUDIO_ONLY_RSS).kind, 'blog');
});

test('a feed that declares itself music is music', () => {
  const rss = `<?xml version="1.0"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
  <title>An album</title>
  <link>https://album.example/</link>
  <podcast:medium>music</podcast:medium>
  <item><title>Track one</title><link>https://album.example/1</link>
    <enclosure url="https://album.example/1.mp3" type="audio/mpeg" length="1"/></item>
</channel></rss>`;
  assert.equal(parseFeed(rss).kind, 'music');
});

test('a declared playlist is music even with nothing attached to it', () => {
  // `musicL` is a playlist, and a playlist points at tracks published
  // elsewhere rather than carrying them, so there is no enclosure to read.
  const rss = `<?xml version="1.0"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
  <title>A playlist</title>
  <link>https://list.example/</link>
  <podcast:medium>musicL</podcast:medium>
  <item><title>Pointer</title><link>https://list.example/1</link></item>
</channel></rss>`;
  assert.equal(parseFeed(rss).kind, 'music');
});

test('a declared medium beats the podcast tags around it', () => {
  // podcast:medium is itself one of the tags that marks a podcast, so a music
  // feed carrying the rest of the namespace must not be read as a show.
  const rss = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
  <title>An album on podcast hosting</title>
  <link>https://album.example/</link>
  <podcast:medium>music</podcast:medium>
  <itunes:category text="Music"/>
  <itunes:explicit>false</itunes:explicit>
  <item><title>Track one</title><link>https://album.example/1</link>
    <enclosure url="https://album.example/1.mp3" type="audio/mpeg" length="1"/></item>
</channel></rss>`;
  assert.equal(parseFeed(rss).kind, 'music');
});

test('a medium this parser does not know leaves the evidence to speak', () => {
  const rss = `<?xml version="1.0"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
  <title>An audiobook</title>
  <link>https://book.example/</link>
  <podcast:medium>audiobook</podcast:medium>
  <item><title>Chapter one</title><link>https://book.example/1</link>
    <enclosure url="https://book.example/1.mp3" type="audio/mpeg" length="1"/></item>
</channel></rss>`;
  assert.equal(parseFeed(rss).kind, 'podcast');
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

/**
 * The shape kulturbanause.de publishes: a design blog whose tutorials embed
 * screen recordings, which WordPress turns into <enclosure type="video/mp4">.
 * One post in ten carries one, and that post is thousands of words long.
 */
const BLOG_WITH_A_CLIP_RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>A design blog</title>
    <link>https://design.example/</link>
    <description>Tutorials</description>
    <item>
      <title>Figma and AI agents</title>
      <guid>https://design.example/1</guid>
      <description>A short excerpt of the tutorial.</description>
      <content:encoded>${'<p>Paragraph of the actual tutorial.</p>'.repeat(60)}</content:encoded>
      <enclosure url="https://media.design.example/demo.mp4" type="video/mp4" length="9867221"/>
    </item>
    <item>
      <title>Another tutorial, no clip</title>
      <guid>https://design.example/2</guid>
      <content:encoded>${'<p>More words.</p>'.repeat(60)}</content:encoded>
    </item>
    <item>
      <title>A third</title>
      <guid>https://design.example/3</guid>
      <content:encoded>${'<p>More words.</p>'.repeat(60)}</content:encoded>
    </item>
  </channel>
</rss>`;

test('a blog post with a clip in it does not make the feed a video feed', () => {
  const feed = parseFeed(BLOG_WITH_A_CLIP_RSS);

  // The bug this is here for: reading "has a video enclosure" as "is a video
  // feed" filed 723 ordinary blogs under /videos, and served their posts as
  // episodes with the article dropped.
  assert.equal(feed.kind, 'blog');

  // The enclosure is still kept. The post has a video on it; it is just not a
  // video, and the player still has something to play.
  assert.equal(feed.items[0].audio.url, 'https://media.design.example/demo.mp4');
  assert.equal(feed.items[0].audio.type, 'video/mp4');
});

/** A PeerTube instance feed: every entry is a video, and the text is a caption. */
const VIDEO_SHOW_RSS = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>An instance</title>
    <link>https://tube.example/</link>
    <description>Videos</description>
    <item>
      <title>Episode one</title>
      <guid>https://tube.example/w/aaaaaa</guid>
      <link>https://tube.example/w/aaaaaa</link>
      <description>A sentence about the video.</description>
      <enclosure url="https://tube.example/download/1.mp4" type="video/mp4" length="1"/>
    </item>
    <item>
      <title>Episode two</title>
      <guid>https://tube.example/w/bbbbbb</guid>
      <link>https://tube.example/w/bbbbbb</link>
      <description>Another sentence.</description>
      <enclosure url="https://tube.example/download/2.mp4" type="video/mp4" length="1"/>
    </item>
    <item>
      <title>Episode three, with notes</title>
      <guid>https://tube.example/w/cccccc</guid>
      <link>https://tube.example/w/cccccc</link>
      <description>${'Chapter markers and credits. '.repeat(80)}</description>
      <enclosure url="https://tube.example/download/3.mp4" type="video/mp4" length="1"/>
    </item>
  </channel>
</rss>`;

test('a feed whose items are the videos is still a video feed', () => {
  // And it stays one when a single entry is talkative. Written as "no entry
  // carries an article" this rule called framatube.org a blog on the strength
  // of one 1,497-character description.
  assert.equal(parseFeed(VIDEO_SHOW_RSS).kind, 'video');
});

test('a JSON Feed article with a video attached is an article', () => {
  const json = JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: 'A JSON blog',
    home_page_url: 'https://json.example/',
    items: [
      {
        id: '1',
        url: 'https://json.example/1',
        title: 'A post with a demo in it',
        content_html: '<p>Paragraph of the actual post.</p>'.repeat(60),
        attachments: [{ url: 'https://json.example/demo.mp4', mime_type: 'video/mp4' }],
      },
      { id: '2', url: 'https://json.example/2', title: 'No demo', content_html: '<p>Words.</p>' },
      { id: '3', url: 'https://json.example/3', title: 'None here', content_html: '<p>Words.</p>' },
    ],
  });

  assert.equal(parseFeed(json).kind, 'blog');
});

// ---------------------------------------------------------------- news

/**
 * Items dated backwards from now, because the newsroom test asks whether a feed
 * is publishing at a rate *today* — a fixture dated 2019 would measure as an
 * archive however fast its items came, which is the point of the freshness
 * guard and not something a fixture should have to fight.
 *
 * @param {number} count
 * @param {number} apartMinutes
 * @param {(i: number) => string} body what goes inside each <item>
 * @param {number} [startMinutesAgo]
 */
function datedItems(count, apartMinutes, body, startMinutesAgo = 30) {
  return Array.from({ length: count }, (_, i) => {
    const at = new Date(Date.now() - (startMinutesAgo + i * apartMinutes) * 60_000);
    return `<item>${body(i)}<pubDate>${at.toUTCString()}</pubDate></item>`;
  }).join('\n');
}

const wrap = (title, description, items, extra = '') => `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
  <title>${title}</title>
  <link>https://n.example/</link>
  <description>${description}</description>
  ${extra}
  ${items}
</channel></rss>`;

test('a feed publishing all day under many bylines is news', () => {
  const staff = ['Ada Reyes', 'Bo Chen', 'Cass Ide', 'Dev Rao', 'Eve Toms'];
  const rss = wrap(
    'The Daily Chronicle',
    'Reporting from the city',
    datedItems(
      12,
      120,
      (i) =>
        `<title>Council votes ${i}</title><guid>https://n.example/${i}</guid>` +
        `<description>The council met on Tuesday.</description>` +
        `<dc:creator>${staff[i % staff.length]}</dc:creator>`,
    ),
  );
  assert.equal(parseFeed(rss).kind, 'news');
});

test('a wire is news even unsigned and named for its section', () => {
  // BBC Sport and Politics - CBSNews.com: twenty-odd headlines a day, not a
  // byline anywhere, and a title that names the desk rather than the paper. Its
  // pace is the only thing it has to say, so the pace has to be enough.
  const rss = wrap(
    'Sport Front Page',
    'The sport desk',
    datedItems(
      12,
      45,
      (i) =>
        `<title>Late winner in the derby ${i}</title><guid>https://n.example/${i}</guid>` +
        `<description>Two sentences of match report.</description>`,
    ),
  );
  assert.equal(parseFeed(rss).kind, 'news');
});

test('a linkblog at a wire’s pace is still a blog', () => {
  // mitchipedia.tumblr.com posts twenty-five times a day and would pass any
  // test made of pace alone. What it does not publish is articles: three posts
  // in twelve are a reblogged image with no title and nothing under it.
  const rss = wrap(
    'Mitchipedia',
    'Mostly memes and other curiosities',
    datedItems(12, 45, (i) =>
      i % 4 === 0
        ? `<guid>https://n.example/${i}</guid>`
        : `<title>a thing I saw ${i}</title><guid>https://n.example/${i}</guid>` +
          `<description>ha</description>`,
    ),
  );
  assert.equal(parseFeed(rss).kind, 'blog');
});

test('a blog with a page called News is not news', () => {
  // The shape that made "news" in a title worthless on its own: Natural Docs
  // News, News - Fred Kahl, cweiske.de news. Release notes, twice a year.
  const rss = wrap(
    'Natural Docs News',
    'News and updates about Natural Docs',
    datedItems(
      4,
      60 * 24 * 120,
      (i) =>
        `<title>Version 2.${i} released</title><guid>https://n.example/${i}</guid>` +
        `<description>Changelog.</description>`,
    ),
  );
  assert.equal(parseFeed(rss).kind, 'blog');
});

test('a forum with hundreds of posters is not news', () => {
  // Writing Stack Exchange and r/PayPie: as many names as a newsroom, one
  // question a day, and nothing that calls itself a publication.
  const rss = wrap(
    'Recent Questions - Writing Stack Exchange',
    'Most recent questions',
    datedItems(
      10,
      60 * 24,
      (i) =>
        `<title>How do I ${i}</title><guid>https://n.example/${i}</guid>` +
        `<description>A question.</description><dc:creator>user${i}</dc:creator>`,
    ),
  );
  assert.equal(parseFeed(rss).kind, 'blog');
});

test('an archive uploaded in one afternoon is not a publishing rate', () => {
  // astronotyet.com posted twelve entries five minutes apart and davidcancel.com
  // imported nine in an hour in 2024. Read as a rate those are hundreds of
  // articles a day; what gives them away is that the run does not reach today.
  const rss = wrap(
    'An imported archive',
    'Everything, all at once',
    datedItems(
      12,
      5,
      (i) =>
        `<title>Post ${i}</title><guid>https://n.example/${i}</guid>` +
        `<description>Words.</description><dc:creator>Author ${i}</dc:creator>`,
      60 * 24 * 400,
    ),
  );
  assert.equal(parseFeed(rss).kind, 'blog');
});

test('a news podcast is a podcast, not news', () => {
  // The categories above this one are claims about the payload and this one is
  // a claim about the publisher, so the payload wins: NPR News Now ships audio.
  const rss = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
  <title>NPR News Now</title>
  <link>https://npr.example/</link>
  <description>The latest news in five minutes</description>
  <itunes:owner><itunes:email>x@npr.example</itunes:email></itunes:owner>
  <itunes:type>episodic</itunes:type>
  ${datedItems(
    12,
    60,
    (i) =>
      `<title>News, hour ${i}</title><guid>https://npr.example/${i}</guid>` +
      `<description>Five minutes of news.</description><dc:creator>Desk ${i}</dc:creator>` +
      `<enclosure url="https://npr.example/${i}.mp3" type="audio/mpeg" length="1"/>`,
  )}
</channel></rss>`;
  assert.equal(parseFeed(rss).kind, 'podcast');
});

test('an atom feed with an audio enclosure link is a blog', () => {
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
  assert.equal(parseFeed(atom).kind, 'blog');
});

test('a JSON feed with an audio attachment is a blog', () => {
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
  assert.equal(parseFeed(json).kind, 'blog');
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
