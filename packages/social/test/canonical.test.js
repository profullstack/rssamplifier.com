import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseXInput,
  xRef,
  xPath,
  xSlug,
  xSource,
  xSpecFromRef,
} from '../src/x/canonical.js';
import { parseRedditInput, redditRef, redditSource } from '../src/reddit/canonical.js';
import { socialSourceFrom, socialPathFor } from '../src/identify.js';

/*
 * Canonicalisation is the load-bearing half of §37/§38: two requests for the
 * same thing have to produce the same ref, or a thousand subscribers become a
 * thousand polling jobs. Everything here is a test of that one property.
 */

test('every spelling of a handle is one source', () => {
  const forms = [
    'OpenAI',
    '@OpenAI',
    'x.com/OpenAI',
    'https://x.com/OpenAI',
    'https://twitter.com/OpenAI',
    'https://mobile.twitter.com/OpenAI/',
    'https://www.x.com/OpenAI',
  ];

  const refs = new Set(forms.map((form) => xRef(parseXInput(form))));
  assert.deepEqual([...refs], ['x:user:openai']);
});

test('display casing survives, because it is the publisher spelling their own name', () => {
  assert.equal(parseXInput('https://x.com/OpenAI').username, 'OpenAI');
  assert.equal(xSource('@OpenAI').path, '/x/OpenAI');
});

test('the tabs that are feeds are recognised, and the ones that are not are declined', () => {
  assert.equal(xRef(parseXInput('https://x.com/OpenAI/with_replies')), 'x:replies:openai');
  assert.equal(xRef(parseXInput('https://x.com/OpenAI/media')), 'x:media:openai');
  assert.equal(parseXInput('https://x.com/OpenAI/likes'), null);
  assert.equal(parseXInput('https://x.com/OpenAI/following'), null);
});

test('a post is something to read, not a source to subscribe to', () => {
  assert.equal(parseXInput('https://x.com/OpenAI/status/1898765432109876543'), null);
});

test('searches and lists', () => {
  assert.equal(xRef(parseXInput('https://x.com/search?q=bitcoin')), 'x:search:bitcoin');
  assert.equal(xRef(parseXInput('https://x.com/i/lists/1234567890')), 'x:list:1234567890');
  // A list slug cannot be resolved to an id without asking X, so it is declined
  // rather than guessed.
  assert.equal(parseXInput('https://x.com/OpenAI/lists/news'), null);
});

test("X's own furniture is not somebody's handle", () => {
  for (const path of ['/home', '/explore', '/settings', '/i', '/notifications']) {
    assert.equal(parseXInput(`https://x.com${path}`), null, path);
  }
});

test('handles we could store but never address are refused up front', () => {
  // /x/list/… and /x/status are fixed segments on this site.
  assert.equal(parseXInput('https://x.com/list'), null);
  assert.equal(parseXInput('https://x.com/status'), null);
});

test('a search keeps its operators intact — we do not reimplement X search', () => {
  const source = xSource('https://x.com/search?q=from%3AOpenAI%20lang%3Aen');
  assert.equal(source.ref, 'x:search:from:openai lang:en');
  assert.equal(source.path, '/x/search?q=from%3AOpenAI%20lang%3Aen');
});

test('a ref survives the round trip the crawler makes it do', () => {
  for (const input of [
    '@OpenAI',
    'https://x.com/OpenAI/media',
    'https://x.com/i/lists/1234567890',
    'https://x.com/search?q=bitcoin etf',
  ]) {
    const spec = parseXInput(input);
    const back = xSpecFromRef(xRef(spec));
    assert.equal(xRef(back), xRef(spec), input);
  }
});

test('slugs are directory-safe and distinct per mode', () => {
  assert.equal(xSlug(parseXInput('@OpenAI')), 'x-user-openai');
  assert.equal(xSlug(parseXInput('https://x.com/OpenAI/media')), 'x-media-openai');
  assert.match(xSlug(parseXInput('https://x.com/search?q=bitcoin etf')), /^[a-z0-9-]+$/);
});

test('every spelling of a subreddit is one community', () => {
  const forms = [
    'r/programming',
    '/r/programming',
    'https://reddit.com/r/programming',
    'https://www.reddit.com/r/programming/',
    'https://old.reddit.com/r/Programming/.rss',
    'https://www.reddit.com/r/programming/new/.rss',
  ];

  const refs = new Set(forms.map((form) => redditRef(parseRedditInput(form))));
  assert.deepEqual([...refs], ['r:sub:programming']);
});

test('a sort is a view of a community, a permalink is not', () => {
  // A sort collapses onto the community: subscribing to /new and /top of one
  // subreddit would poll Reddit twice for one thing.
  for (const sort of ['new', 'top', 'hot', 'rising']) {
    assert.equal(
      redditRef(parseRedditInput(`https://www.reddit.com/r/programming/${sort}/`)),
      'r:sub:programming',
      sort,
    );
  }

  // A permalink is one post, which is a thing to read rather than to subscribe to.
  assert.equal(
    redditRef(parseRedditInput('https://www.reddit.com/r/programming/comments/abc/title/')),
    null,
  );
});

test('Reddit users live under /r/ so one prefix holds all of Reddit', () => {
  assert.equal(redditSource('u/spez').path, '/r/u/spez');
  assert.equal(redditSource('https://www.reddit.com/user/spez/.rss').ref, 'r:user:spez');
});

test('Reddit is recognised before the ordinary feed path — the whole point of /r/', () => {
  // This URL resolves perfectly well as plain RSS, which is how 50,099 of them
  // ended up filed among the blogs.
  const source = socialSourceFrom('https://www.reddit.com/r/programming/.rss');
  assert.equal(source.network, 'reddit');
  assert.equal(source.path, '/r/programming');
});

test('an ordinary blog is not mistaken for a social source', () => {
  assert.equal(socialSourceFrom('https://example.com/feed.xml'), null);
  assert.equal(socialSourceFrom('https://notreddit.com/r/programming'), null);
  assert.equal(socialSourceFrom(''), null);
});

test('a stored row knows its own address', () => {
  assert.equal(socialPathFor({ social_ref: 'r:sub:programming', slug: 'r-programming' }), '/r/programming');
  assert.equal(socialPathFor({ social_ref: 'x:user:openai', slug: 'x-user-openai' }), '/x/openai');
  assert.equal(socialPathFor({ social_ref: 'x:media:openai', slug: 'x' }), '/x/openai/media');
  assert.equal(socialPathFor({ social_ref: 'x:list:123456', slug: 'x' }), '/x/list/123456');
  // Anything else — including a social row written before this code — falls
  // back to its slug, so callers never have to check first.
  assert.equal(socialPathFor({ slug: 'some-blog' }), '/some-blog');
});

test('the public path never names a provider', () => {
  for (const input of ['@OpenAI', 'r/programming', 'https://x.com/i/lists/1234567890']) {
    const path = socialSourceFrom(input).path;
    assert.doesNotMatch(path, /rsshub|teapot|nitter|api\.x\.com/i, input);
  }
});

test('xPath and xSlug decline what parseXInput declined, rather than inventing', () => {
  assert.equal(xPath(null), null);
  assert.equal(xSlug(null), null);
  assert.equal(xSource('https://example.com/OpenAI'), null);
});
