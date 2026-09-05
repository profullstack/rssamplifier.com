import assert from 'node:assert/strict';
import { test } from 'node:test';

import { figures, readableArticle } from '../src/extract.js';

const URL = 'https://example.com/posts/2026/a-post';

/** Enough prose that Readability treats the container as the article. */
const PROSE = `${'The band went into the studio with nothing written and came out with a record. '.repeat(20)}`;

/**
 * @param {string} body
 * @returns {string}
 */
function page(body) {
  return `<!doctype html><html><head><title>A Post</title></head><body>
    <nav><a href="/">Home</a></nav>
    <article><h1>A Post</h1>${body}</article>
  </body></html>`;
}

test('an article is pulled out of a page and comes back sanitized', () => {
  const found = readableArticle(page(`<p>${PROSE}</p>`), URL);

  assert.ok(found, 'expected an article');
  assert.ok(found.html.includes('The band went into the studio'));
  assert.ok(found.length > 600);
});

test('relative links and images are resolved against the page they came from', () => {
  const found = readableArticle(
    page(`<p>${PROSE}</p><p><a href="/next">next</a> <img src="hero.jpg" alt="hero"></p>`),
    URL,
  );

  assert.ok(found);
  // The sanitizer drops relative URLs on purpose — they would point at us — so
  // an unresolved href does not merely look wrong, it disappears.
  assert.ok(found.html.includes('https://example.com/next'), found.html);
  assert.ok(found.html.includes('https://example.com/posts/2026/hero.jpg'), found.html);
});

test("a page's own base tag wins, because that is what a browser would honour", () => {
  const html = page(`<p>${PROSE}</p><p><a href="/next">next</a></p>`).replace(
    '<head>',
    '<head><base href="https://cdn.example.org/">',
  );

  const found = readableArticle(html, URL);
  assert.ok(found);
  assert.ok(found.html.includes('https://cdn.example.org/next'), found.html);
});

test('scripts and handlers do not survive extraction', () => {
  const found = readableArticle(
    page(`<p onclick="steal()">${PROSE}</p><script>steal()</script><p><a href="javascript:steal()">x</a></p>`),
    URL,
  );

  assert.ok(found);
  assert.ok(!found.html.includes('<script'));
  assert.ok(!found.html.includes('onclick'));
  assert.ok(!found.html.includes('javascript:'));
});

test('a page with nothing worth reading is refused rather than half-shown', () => {
  assert.equal(readableArticle('', URL), null);
  assert.equal(readableArticle('   ', URL), null);
  assert.equal(readableArticle('<html><body><p>Subscribe to continue.</p></body></html>', URL), null);
});

test('entities in a headline are decoded, since JSX will escape what it is given', () => {
  const html = page(`<p>${PROSE}</p>`).replace(
    '<title>A Post</title>',
    '<title>&ldquo;Mutt said&rdquo; &amp; other stories</title>',
  );

  const found = readableArticle(html, URL);
  assert.ok(found);
  assert.equal(found.title, '“Mutt said” & other stories');
});

test('a page far past the size cap is still read, from the top', () => {
  const padding = `<!-- ${'x'.repeat(800 * 1024)} -->`;
  const found = readableArticle(page(`<p>${PROSE}</p>`) + padding, URL);

  assert.ok(found, 'the article is near the top; the tail is what gets cut');
});

/**
 * A webcomic page, in the shape the live ones have.
 *
 * Wilde Life and Elephant Town both extract like this: the strip, a line or two
 * of date and nav, and a few hundred characters of site furniture around it —
 * far short of the six hundred the prose floor wanted, which is why every comic
 * in the directory read as "this site does not allow itself to be embedded".
 */
const COMIC = `<!doctype html><html><head><title>Wilde Life - 1633</title></head><body>
  <div id="outerwrap"><div id="maincontent">
    <p><img title="good thing he's been having a safe and uneventful time"
            src="https://wildelifecomic.com/comics/1786691332-1633.png"></p>
    <p>1633</p><p>Posted August 14, 2026 at 04:08 am</p>
    <p>Comments</p><p><a href="/blog">See all news&gt;&gt;</a></p>
    <p>UPDATES M - W - F. Contact Pascalle: pascalle.lepas(at)gmail.com</p>
    <p>Wilde Life is a horror comic and contains imagery that may spook or unsettle
       some readers. Please read at your own discretion. Wilde Life updates three
       times a week and is free to read from the beginning.</p>
  </div></div>
</body></html>`;

const COMIC_URL = 'https://www.wildelifecomic.com/comic/1633';

test('a comic is a post, even though its words would not fill a paragraph', () => {
  const found = readableArticle(COMIC, COMIC_URL);

  assert.ok(found, 'the strip is the post; the prose around it is a caption');
  assert.ok(found.html.includes('1786691332-1633.png'));
  assert.ok(found.length < 600, 'and it got in on the picture, not on the prose');
});

test('a page offering nothing but furniture is still refused', () => {
  // The failure the prose floor was put there for, and it still has to hold:
  // a JavaScript app that renders nothing server-side, leaving a header, a
  // cookie line and a logo. Same length as the comic, and not a post.
  const shell = `<!doctype html><html><head><title>App</title></head><body>
    <div id="root"><header><img src="https://example.com/static/logo.png" alt="Acme"></header>
      <p>We use cookies and similar technologies to improve your experience on this
         site, to analyse traffic, and to personalise content and advertising. You
         can manage your preferences at any time from the footer of any page.</p>
      <p>Sign in to continue. Enable JavaScript to use this application. If you
         believe you are seeing this message in error, please contact support and
         include the reference code shown at the bottom of this page.</p>
    </div></body></html>`;

  assert.equal(readableArticle(shell, URL), null);
});

test('what counts as a figure is the publisher’s own picture, at a size they stand behind', () => {
  const html = `
    <img src="https://wildelifecomic.com/comics/1786691332-1633.png">
    <img src="http://topwebcomics.com/images/voteimages/linklogo4.png">
    <img src="https://wildelifecomic.com/uploads/centered.png" width="200" height="100">
    <img src="https://wildelifecomic.com/static/nav/next.svg">
    <img src="https://wildelifecomic.com/images/avatar.png">
  `;

  // Only the strip. A third party's badge, a logo the page declares at 200×100,
  // something filed under the site's chrome, and a file that says what it is.
  assert.deepEqual(figures(html, COMIC_URL), [
    'https://wildelifecomic.com/comics/1786691332-1633.png',
  ]);
});

test('a picture served from the site’s own CDN is still the site’s own picture', () => {
  const html = '<img src="https://images.wildelifecomic.com/comics/1633.png">';
  assert.equal(figures(html, COMIC_URL).length, 1);
});

/**
 * A comic page where the strip and the words are in different halves.
 *
 * Sister Claire's hiatus post, in the shape the live one has. Readability
 * scores subtrees and keeps the one that wins; here that is the note explaining
 * the hiatus, and the strip — the reason the page exists — is in the half that
 * lost. The note is 578 characters on the real page, just under the prose
 * floor, so the whole extraction was thrown away and the reader fell back to
 * the feed's own body, whose picture is a 133×200 thumbnail.
 */
const SPLIT = `<!doctype html><html><head><title>Sister Claire</title></head><body>
  <div id="comic"><img title="What a Pain..." src="https://www.sisterclaire.com/comics/1750651937-pain_s.png" id="cc-comic"></div>
  <div id="news"><div><p>Hey all,</p>
    <p>It really pains me to say this (literally) but my spine injury has flared
       up really badly and I am once again stuck waiting for insurance to allow
       me to get the treatment I need to be functional again.</p>
    <p>The pain medications I have been prescribed in the meantime can only do
       so much, and their side effects make me sleepy and confused.</p>
    <p>I am so frustrated and pained, but I am hoping I can get back to my usual
       art schedule ASAP. Thank you for your patience.</p>
    <p>-Yamino</p></div></div>
</body></html>`;

const SPLIT_URL = 'https://www.sisterclaire.com/comic/what-a-pain';

test('the strip is put back when the extraction kept only the words beside it', () => {
  const found = readableArticle(SPLIT, SPLIT_URL);

  assert.ok(found, 'a page whose post is a picture is a post');
  assert.ok(
    found.html.includes('https://www.sisterclaire.com/comics/1750651937-pain_s.png'),
    found.html,
  );
  // At the top, where the publisher had it, rather than trailing the note.
  assert.ok(found.html.indexOf('pain_s.png') < found.html.indexOf('Hey all'), found.html);
  // The artist's own words on the image survive; nothing else off the tag does.
  assert.ok(found.html.includes('title="What a Pain..."'));
  assert.ok(!found.html.includes('cc-comic'));
});

test('a page offering several pictures is not guessed at', () => {
  // An index, a gallery or a layout — not a page whose post is a picture. The
  // rescue is for the case where there is one answer, and picking one of four
  // is how a reader gets shown an advert instead of a post.
  const many = SPLIT.replace(
    '<div id="comic">',
    '<div id="comic"><img src="https://www.sisterclaire.com/comics/other.png">',
  );

  assert.equal(readableArticle(many, SPLIT_URL), null);
});

test('a rescued picture carries nothing off the page but its own three attributes', () => {
  // The rescue rebuilds the tag rather than passing it through, and this is
  // what that is for: a handler, a hostile title and a second source all sit on
  // the one image the page offers.
  const hostile = SPLIT.replace(
    '<img title="What a Pain..."',
    '<img onerror="fetch(\'//evil\')" srcset="//evil/x.png 2x" title=\'a" onload="x\'',
  );

  const found = readableArticle(hostile, SPLIT_URL);

  assert.ok(found);
  assert.ok(!/onerror/i.test(found.html), found.html);
  assert.ok(!/srcset/i.test(found.html), found.html);
  assert.ok(!found.html.includes('evil'), found.html);
  // The quote that would have closed the attribute early is gone, so what was
  // meant to become an `onload` handler stays inside the title as inert text.
  assert.ok(found.html.includes('title="a onload=x"'), found.html);
  assert.deepEqual(attrsOf(found.html), ['src', 'alt', 'title', 'loading']);
});

/**
 * The attribute names on the first `<img>` in some markup.
 *
 * Read off the quoted pairs rather than off anything that looks like `name=`,
 * so text sitting inside a value is not mistaken for an attribute — which is
 * the whole thing under test.
 *
 * @param {string} html
 * @returns {string[]}
 */
function attrsOf(html) {
  const tag = html.match(/<img\b[^>]*>/i)?.[0] ?? '';
  return [...tag.matchAll(/([a-z-]+)="[^"]*"/gi)].map((m) => m[1]);
}

test('a rescued picture keeps the artist’s own words, escaped exactly once', () => {
  const quoted = SPLIT.replace('title="What a Pain..."', 'title="Mutt &amp; Jeff said no"');

  const found = readableArticle(quoted, SPLIT_URL);

  assert.ok(found);
  // Not `&amp;amp;`, which is what pre-escaping a value the sanitizer escapes
  // again produces, and what the reader would see on the page.
  assert.ok(found.html.includes('title="Mutt &amp; Jeff said no"'), found.html);
});

test('an index of thumbnails is not a page whose post is a picture', () => {
  // The Bright Side's comic archive, which is the page that put the crowd test
  // there. Ten strip thumbnails, each declared 150×150 and so ruled out for
  // being small, leaving one survivor — a sidebar advert for the author's book
  // — which looked exactly like a lone picture that must be the post.
  const thumbs = Array.from(
    { length: 10 },
    (_, i) =>
      `<a href="/comic/p${i}"><img src="https://www.thebrightsidecomic.com/wp-content/uploads/p${i}-150x150.jpg" width="150" height="150"></a>`,
  ).join('');

  const archive = `<!doctype html><html><head><title>Archive</title></head><body>
    <div id="main">${thumbs}</div>
    <div id="sidebar"><img src="https://www.thebrightsidecomic.com/wp-content/uploads/cover-vol-2-sidebar-150-2-1.png"></div>
    <p>The Bright Side updates on Tuesdays and Fridays. Read from the beginning.</p>
  </body></html>`;

  assert.equal(readableArticle(archive, 'https://www.thebrightsidecomic.com/?post_type=comic'), null);
});

test('a file that says it is furniture is furniture, wherever it sits', () => {
  const html = `
    <img src="https://example.com/uploads/cover-vol-2-sidebar-150-2-1.png">
    <img src="https://example.com/uploads/top-banner-2026.png">
  `;

  assert.deepEqual(figures(html, 'https://example.com/posts/a'), []);
});

test('an article that stands on its own gains no picture it did not have', () => {
  // The gate only opens where the alternative is showing the reader nothing at
  // all. A post that clears the prose floor never reaches it, so a banner in
  // the masthead stays in the masthead.
  const withBanner = `<!doctype html><html><head><title>A Post</title></head><body>
    <header><img src="https://example.com/seasonal-banner.png"></header>
    <article><h1>A Post</h1><p>${PROSE}</p></article>
  </body></html>`;

  const found = readableArticle(withBanner, URL);

  assert.ok(found);
  assert.ok(!found.html.includes('seasonal-banner'), found.html);
});

/** A paid post's free preview: a few paragraphs, well under the prose floor. */
const PREVIEW = `<p>Chapter Twenty Two. "What now?" I asked. It was more of a rhetorical question, since none of us had a plan and the tide was coming in.</p>
  <p>Marcus looked at the water and then at the keys in his hand, and for a long moment said nothing at all.</p>`;

/** What Substack and the big publishers put in the head of a paywalled page. */
const LOCKED = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","isAccessibleForFree":false,"hasPart":{"@type":"WebPageElement","isAccessibleForFree":false,"cssSelector":".paywall"}}</script>`;

/**
 * @param {string} head
 * @param {string} body
 * @returns {string}
 */
function pageWithHead(head, body) {
  return `<!doctype html><html><head><title>A Post</title>${head}</head><body>
    <nav><a href="/">Home</a></nav>
    <article><h1>A Post</h1>${body}</article>
  </body></html>`;
}

test('a paywalled page keeps its free preview and says so', () => {
  const found = readableArticle(pageWithHead(LOCKED, PREVIEW), URL);

  assert.ok(found, 'expected the preview to survive the prose floor');
  assert.equal(found.preview, true);
  assert.ok(found.html.includes('Chapter Twenty Two'), found.html);
  assert.ok(found.length < 600, `preview should be short, got ${found.length}`);
});

test('the same short text on a page that declares no paywall is still nothing', () => {
  // The floor is there to keep a caption or a menu from being served as an
  // article; a declared paywall is the only thing that lowers it.
  assert.equal(readableArticle(pageWithHead('', PREVIEW), URL), null);
});

test('a paywalled page that is only a subscribe button is not a preview', () => {
  const found = readableArticle(
    pageWithHead(LOCKED, '<p>This post is for paid subscribers. Subscribe to continue.</p>'),
    URL,
  );
  assert.equal(found, null);
});

test('a long free preview on a paywalled page is still marked as one', () => {
  const found = readableArticle(pageWithHead(LOCKED, `<p>${PROSE}</p>`), URL);

  assert.ok(found);
  assert.ok(found.length > 600);
  assert.equal(found.preview, true);
});

test('an ordinary article is not a preview', () => {
  const found = readableArticle(page(`<p>${PROSE}</p>`), URL);

  assert.ok(found);
  assert.equal(found.preview, false);
});

test('the open graph and class-name spellings of a paywall count too', () => {
  const og = '<meta property="article:content_tier" content="locked">';
  assert.equal(readableArticle(pageWithHead(og, PREVIEW), URL)?.preview, true);

  const boxed = readableArticle(
    pageWithHead('', `${PREVIEW}<div class="paywall"><h2 class="paywall-title">This post is for paid subscribers</h2></div>`),
    URL,
  );
  assert.equal(boxed?.preview, true);
});
