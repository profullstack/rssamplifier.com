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
