import test from 'node:test';
import assert from 'node:assert/strict';

import {
  feedCard,
  feedImage,
  monogram,
  monogramHue,
  postThumb,
  thumbSrc,
} from '../src/lib/thumbs.js';

test('an https image passes through unchanged', () => {
  assert.equal(thumbSrc('https://cdn.example/a.jpg'), 'https://cdn.example/a.jpg');
  // A query string is part of the URL: signed CDN links break without it.
  assert.equal(
    thumbSrc('https://cdn.example/a.jpg?w=800&s=abc'),
    'https://cdn.example/a.jpg?w=800&s=abc',
  );
});

test('an http image is upgraded rather than dropped', () => {
  // Mixed content is blocked by the browser and by our own CSP, so rendering it
  // as-is would be a guaranteed blank square. 1,840 rows in production are
  // http, and almost every host behind them serves TLS.
  assert.equal(thumbSrc('http://cdn.example/a.jpg'), 'https://cdn.example/a.jpg');
});

test('anything that is not an absolute http(s) URL is not an image', () => {
  assert.equal(thumbSrc('/relative/a.jpg'), null, 'would resolve against our own origin');
  assert.equal(thumbSrc('data:image/gif;base64,R0lGODlhAQ'), null);
  assert.equal(thumbSrc('javascript:alert(1)'), null);
  assert.equal(thumbSrc('ftp://example/a.jpg'), null);
  assert.equal(thumbSrc(''), null);
  assert.equal(thumbSrc(null), null);
  assert.equal(thumbSrc(undefined), null);
  assert.equal(thumbSrc({}), null);
  assert.equal(thumbSrc(`https://cdn.example/${'a'.repeat(1200)}.jpg`), null, 'absurd length');
});

test('a post falls back to its feed picture, and then to nothing', () => {
  assert.equal(
    postThumb({ image_url: 'https://cdn.example/post.jpg', feed_image: 'https://cdn.example/f.png' }),
    'https://cdn.example/post.jpg',
    'the post’s own picture wins',
  );

  // What a river row looks like: the query selects the feed's cover art as
  // feed_image precisely so a picture-less post still has one.
  assert.equal(
    postThumb({ image_url: null, feed_image: 'https://cdn.example/f.png' }),
    'https://cdn.example/f.png',
  );

  // A feed's own page has one feed for every row, so it passes it in instead.
  assert.equal(
    postThumb({ image_url: null }, { image_url: 'https://cdn.example/cover.png' }),
    'https://cdn.example/cover.png',
  );

  assert.equal(postThumb({ image_url: null }, { image_url: null }), null);
  assert.equal(postThumb(), null);

  // A stored value that cannot be rendered must not shadow a usable fallback.
  assert.equal(
    postThumb({ image_url: '/broken.png', feed_image: 'https://cdn.example/f.png' }),
    'https://cdn.example/f.png',
  );
});

test('a monogram is one character of the title', () => {
  assert.equal(monogram('Quantum Notes'), 'Q');
  assert.equal(monogram('  spaced out'), 'S');
  assert.equal(monogram('42 things'), '4');
  // By code point, so an astral first character is not half a surrogate pair.
  assert.equal(monogram('🛰 Orbital'), '🛰');
  assert.equal(monogram('日記'), '日');
  assert.equal(monogram(''), '·');
  assert.equal(monogram(null), '·');
});

test('a feed falls back from its own cover art to what the crawler found', () => {
  assert.equal(
    feedImage({
      image_url: 'https://cdn.example/cover.png',
      card_url: 'https://cdn.example/og.png',
    }),
    'https://cdn.example/cover.png',
    'what the publisher declared wins',
  );

  // The common case: no cover art in the feed document, an og:image on the site.
  assert.equal(
    feedImage({ image_url: null, card_url: 'https://cdn.example/og.png' }),
    'https://cdn.example/og.png',
  );

  assert.equal(feedImage({ image_url: null, card_url: null }), null);
  assert.equal(feedImage(), null);
});

test('a post with nothing of its own can borrow the feed card', () => {
  // A row from the river, where the feed had no cover art either.
  assert.equal(
    postThumb({ image_url: null, feed_image: null, feed_card: 'https://cdn.example/og.png' }),
    'https://cdn.example/og.png',
  );

  // The same on a feed's own page, where the feed is passed in whole.
  assert.equal(
    postThumb({ image_url: null }, { image_url: null, card_url: 'https://cdn.example/og.png' }),
    'https://cdn.example/og.png',
  );
});

test('only a measured, big enough picture is promised as a social card', () => {
  assert.deepEqual(
    feedCard({ card_url: 'https://cdn.example/og.png', card_width: 1200, card_height: 630 }),
    { url: 'https://cdn.example/og.png', width: 1200, height: 630, large: true },
  );

  // Big enough for a card, not for the wide one.
  assert.equal(
    feedCard({ card_url: 'https://cdn.example/og.png', card_width: 400, card_height: 400 }).large,
    false,
  );

  // A favicon is why this gate exists: promising it produces a broken-looking
  // card, and the site's own generated one is better than that.
  assert.equal(
    feedCard({ card_url: 'https://cdn.example/icon.png', card_width: 32, card_height: 32 }),
    null,
  );

  // A picture whose size was never measured cannot be vouched for either.
  assert.equal(feedCard({ card_url: 'https://cdn.example/og.png' }), null);
  assert.equal(feedCard({ card_url: null, card_width: 1200, card_height: 630 }), null);
  assert.equal(feedCard(), null);
});

test('a feed keeps the same monogram tint everywhere it appears', () => {
  const hue = monogramHue('quantum-notes');
  assert.equal(hue, monogramHue('quantum-notes'));
  assert.ok(hue >= 0 && hue < 360);
  assert.notEqual(monogramHue('quantum-notes'), monogramHue('the-physics-hour'));
  assert.equal(monogramHue(null), monogramHue(''));
});
