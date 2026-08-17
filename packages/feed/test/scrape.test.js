import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFeedFromPage } from '../index.js';

const PAGE = 'https://blog.example/';

/**
 * @param {string} body
 * @param {string} [head]
 */
function page(body, head = '<title>A Blog</title>') {
  return `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
}

/**
 * @param {string} body
 * @param {string} [head]
 */
function build(body, head) {
  return buildFeedFromPage(page(body, head), PAGE);
}

test('reads posts a page states in JSON-LD', () => {
  const ld = {
    '@type': 'Blog',
    blogPost: [
      {
        '@type': 'BlogPosting',
        headline: 'On keeping a woodshed dry',
        url: 'https://blog.example/woodshed',
        datePublished: '2026-08-01T10:00:00Z',
        description: 'A season of getting this wrong.',
      },
      {
        '@type': 'BlogPosting',
        headline: 'The second winter of the stove',
        url: 'https://blog.example/stove',
        datePublished: '2026-07-02T10:00:00Z',
      },
      {
        '@type': 'BlogPosting',
        headline: 'Splitting elm, reluctantly',
        url: 'https://blog.example/elm',
        datePublished: '2026-06-03T10:00:00Z',
      },
    ],
  };

  const out = build(
    `<script type="application/ld+json">${JSON.stringify(ld)}</script><p>hello</p>`,
  );

  assert.equal(out.ok, true);
  assert.equal(out.feed.items.length, 3);
  assert.equal(out.feed.items[0].title, 'On keeping a woodshed dry');
  assert.equal(out.feed.items[0].url, 'https://blog.example/woodshed');
  assert.equal(out.feed.items[0].publishedAt, '2026-08-01T10:00:00.000Z');
  assert.equal(out.feed.items[0].summary, 'A season of getting this wrong.');
});

test('survives one malformed JSON-LD block among good ones', () => {
  const good = {
    '@type': 'ItemList',
    itemListElement: [
      { '@type': 'ListItem', item: { '@type': 'Article', headline: 'The long way around', url: '/a' } },
      { '@type': 'ListItem', item: { '@type': 'Article', headline: 'A shorter way back', url: '/b' } },
      { '@type': 'ListItem', item: { '@type': 'Article', headline: 'No way through at all', url: '/c' } },
    ],
  };

  const out = build(
    `<script type="application/ld+json">{ "broken": , }</script>` +
      `<script type="application/ld+json">${JSON.stringify(good)}</script>`,
  );

  assert.equal(out.ok, true);
  assert.equal(out.feed.items.length, 3);
  assert.equal(out.feed.items[1].url, 'https://blog.example/b');
});

test('reads posts marked up as <article>', () => {
  const out = build(`
    <main>
      <article><h2><a href="/one">A winter of bad firewood</a></h2>
        <time datetime="2026-08-01">Aug 1</time>
        <p>It turns out that elm does not want to be split at all.</p></article>
      <article><h2><a href="/two">The stove that would not draw</a></h2>
        <time datetime="2026-07-01">Jul 1</time></article>
      <article><h2><a href="/three">Notes on a damp season</a></h2>
        <time datetime="2026-06-01">Jun 1</time></article>
    </main>
  `);

  assert.equal(out.ok, true);
  assert.equal(out.feed.items.length, 3);
  assert.equal(out.feed.items[0].url, 'https://blog.example/one');
  assert.equal(out.feed.items[0].publishedAt, '2026-08-01T00:00:00.000Z');
  assert.match(out.feed.items[0].summary, /elm does not want/);
});

test('ignores <article> elements nested inside another, so comments are not posts', () => {
  const out = build(`
    <main>
      <article><h1><a href="/post">The only post on this page</a></h1>
        <article><p>A comment that is long enough to look like prose.</p>
          <h3><a href="/c1">A commenter said something here</a></h3></article>
        <article><p>Another comment, similarly wordy and unhelpful.</p>
          <h3><a href="/c2">And then somebody replied to them</a></h3></article>
        <article><p>A third comment to complete the pattern nicely.</p>
          <h3><a href="/c3">A third voice enters the discussion</a></h3></article>
      </article>
    </main>
  `);

  // One outermost article is below the floor, so this must not be read as a
  // three-post blog made of its comment thread.
  assert.equal(out.ok, false);
  assert.equal(out.error, 'no-posts-found');
});

test('infers a post list from repeated structure when nothing is marked up', () => {
  const out = build(`
    <div id="posts">
      <div class="post-1041"><a href="/alpha">The alphabet of small mistakes</a><span>2026-08-01</span></div>
      <div class="post-1042"><a href="/beta">Better living through worse tools</a><span>2026-07-01</span></div>
      <div class="post-1043"><a href="/gamma">Gamma rays and other excuses</a><span>2026-06-01</span></div>
      <div class="post-1044"><a href="/delta">Delta of a very small river</a><span>2026-05-01</span></div>
    </div>
  `);

  assert.equal(out.ok, true);
  assert.equal(out.feed.items.length, 4);
  assert.equal(out.feed.items[0].url, 'https://blog.example/alpha');
  assert.equal(out.feed.items[3].title, 'Delta of a very small river');
});

test('refuses a navigation menu that repeats just as neatly', () => {
  const out = build(`
    <nav>
      <ul>
        <li><a href="/about">About this website</a></li>
        <li><a href="/contact">Contact the author</a></li>
        <li><a href="/archive">Archive of everything</a></li>
        <li><a href="/colophon">Colophon and credits</a></li>
      </ul>
    </nav>
  `);

  assert.equal(out.ok, false);
  assert.equal(out.error, 'no-posts-found');
});

test('refuses short furniture links even outside nav', () => {
  const out = build(`
    <div>
      <div class="c"><a href="/a">Home</a></div>
      <div class="c"><a href="/b">Next</a></div>
      <div class="c"><a href="/c">Read more</a></div>
      <div class="c"><a href="/d">Subscribe</a></div>
    </div>
  `);

  assert.equal(out.ok, false);
});

test('a page with fewer than three posts is not a feed', () => {
  const out = build(`
    <main>
      <article><h2><a href="/one">The single post of a new blog</a></h2></article>
      <article><h2><a href="/two">The second post of a new blog</a></h2></article>
    </main>
  `);

  assert.equal(out.ok, false);
  assert.equal(out.error, 'no-posts-found');
});

test('prefers the dated cluster when a page has two repeating lists', () => {
  const out = build(`
    <div class="sidebar">
      <div class="link"><a href="/l1">A friend of this website here</a></div>
      <div class="link"><a href="/l2">Another friend of this website</a></div>
      <div class="link"><a href="/l3">A third friend of the website</a></div>
    </div>
    <div class="entries">
      <div class="entry"><a href="/p1">The actual first post here</a><time datetime="2026-08-01">x</time></div>
      <div class="entry"><a href="/p2">The actual second post here</a><time datetime="2026-07-01">x</time></div>
      <div class="entry"><a href="/p3">The actual third post here</a><time datetime="2026-06-01">x</time></div>
    </div>
  `);

  assert.equal(out.ok, true);
  assert.equal(out.feed.items[0].url, 'https://blog.example/p1');
});

test('deduplicates a post linked twice in the same list', () => {
  const out = build(`
    <main>
      <article><h2><a href="/same">The very same post twice over</a></h2></article>
      <article><h2><a href="/same">The very same post twice over</a></h2></article>
      <article><h2><a href="/other">A genuinely different post here</a></h2></article>
      <article><h2><a href="/third">A third genuinely different post</a></h2></article>
    </main>
  `);

  assert.equal(out.ok, true);
  assert.equal(out.feed.items.length, 3);
});

test('never stores a teaser as the article body', () => {
  const out = build(`
    <main>
      <article><h2><a href="/one">A post with a long teaser here</a></h2>
        <p>This excerpt is what the index page chose to show and it is truncated…</p></article>
      <article><h2><a href="/two">Another post with a teaser</a></h2></article>
      <article><h2><a href="/three">A third post with a teaser</a></h2></article>
    </main>
  `);

  assert.equal(out.ok, true);
  for (const item of out.feed.items) assert.equal(item.contentHtml, '');
});

test('carries the page metadata onto the feed', () => {
  const out = build(
    `<main>
      <article><h2><a href="/one">The first post of the blog</a></h2></article>
      <article><h2><a href="/two">The second post of the blog</a></h2></article>
      <article><h2><a href="/three">The third post of the blog</a></h2></article>
    </main>`,
    `<title>Woodshed Notes</title>
     <meta property="og:site_name" content="Woodshed Notes">
     <meta name="description" content="Notes on heating a house badly.">
     <meta property="og:image" content="/cover.png">`,
  );

  assert.equal(out.ok, true);
  assert.equal(out.feed.title, 'Woodshed Notes');
  assert.equal(out.feed.description, 'Notes on heating a house badly.');
  assert.equal(out.feed.language, 'en');
  assert.equal(out.feed.imageUrl, 'https://blog.example/cover.png');
  assert.equal(out.feed.siteUrl, PAGE);
  assert.equal(out.feed.kind, 'blog');
});

test('drops javascript: and mailto: hrefs rather than resolving them', () => {
  const out = build(`
    <main>
      <article><h2><a href="javascript:void(0)">A post that goes nowhere at all</a></h2></article>
      <article><h2><a href="mailto:me@example.com">Send me an electronic mail</a></h2></article>
      <article><h2><a href="/real">A post that actually goes somewhere</a></h2></article>
    </main>
  `);

  assert.equal(out.ok, false);
});

test('reads a table layout that alternates content rows with spacer rows', () => {
  // The shape paulgraham.com/articles.html is in: one row per essay, one empty
  // row between them for spacing. Counting the spacers as failed posts puts the
  // whole archive at 0.50 and throws it away.
  const rows = ['first', 'second', 'third', 'fourth', 'fifth']
    .map(
      (n) =>
        `<tr><td><a href="/${n}">An essay about the ${n} thing</a></td></tr><tr><td></td></tr>`,
    )
    .join('');

  const out = build(`<table>${rows}</table>`);

  assert.equal(out.ok, true);
  assert.equal(out.feed.items.length, 5);
  assert.equal(out.feed.items[0].url, 'https://blog.example/first');
});

test('reads a bare run of sibling anchors with no per-post container', () => {
  const out = build(`
    <div class="list">
      <a href="/one">The first essay in the run</a><br>
      <a href="/two">The second essay in the run</a><br>
      <a href="/three">The third essay in the run</a><br>
      <a href="/four">The fourth essay in the run</a><br>
    </div>
  `);

  assert.equal(out.ok, true);
  assert.equal(out.feed.items.length, 4);
  assert.equal(out.feed.items[2].title, 'The third essay in the run');
});

test('a long archive is capped but still judged on its full length', () => {
  // The cap must not be applied before the yield ratio is computed, or a
  // 198-entry archive scores 40/198 and is rejected for being too complete.
  const rows = Array.from(
    { length: 120 },
    (_, i) => `<li><a href="/p${i}">A post with a sufficiently long title ${i}</a></li>`,
  ).join('');

  const out = build(`<ul>${rows}</ul>`);

  assert.equal(out.ok, true);
  assert.equal(out.feed.items.length, 40);
});

test('an empty or unparseable page is refused, not guessed at', () => {
  assert.equal(buildFeedFromPage('', PAGE).ok, false);
  assert.equal(buildFeedFromPage('', PAGE).error, 'empty-page');
});
