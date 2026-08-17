import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readableArticle } from '../src/extract.js';

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
