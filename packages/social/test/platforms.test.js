import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseInstagramInput, instagramRef, instagramSource, instagramSpecFromRef } from '../src/instagram/canonical.js';
import { parseFacebookInput, facebookRef, facebookSource, facebookSpecFromRef } from '../src/facebook/canonical.js';
import { pageToken, connectedPages, fetchFacebookSource } from '../src/facebook/fetch.js';
import { fetchInstagramSource } from '../src/instagram/fetch.js';
import { socialSourceFrom, socialPathFor, SOCIAL_NETWORKS } from '../src/identify.js';
import { isCollected, fetchSocialSource } from '../src/collect.js';
import { failureResult, ANOMALY_SECONDS, UNCONFIGURED_SECONDS } from '../src/failure.js';
import { socialDisplayTitle } from '../src/display.js';
import { XNoSuchSource, XRateLimited, XUnavailable, XAuthFailed } from '../src/x/errors.js';

/* --------------------------------------------------------------- Instagram */

test('every spelling of an Instagram handle is one source', () => {
  const forms = [
    'ig/nasa',
    '/ig/nasa',
    'ig/@nasa',
    'https://www.instagram.com/nasa/',
    'https://instagram.com/NASA',
    'https://m.instagram.com/nasa',
  ];

  assert.deepEqual([...new Set(forms.map((f) => instagramRef(parseInstagramInput(f))))], ['ig:user:nasa']);
});

test('dots are legal in an Instagram handle and are not on X', () => {
  // A handle regex copied from x/canonical.js would silently reject these.
  assert.equal(instagramRef(parseInstagramInput('ig/some.body')), 'ig:user:some.body');
  assert.equal(instagramRef(parseInstagramInput('https://www.instagram.com/a.b_c/')), 'ig:user:a.b_c');
});

test('hashtags, in both spellings', () => {
  assert.equal(instagramRef(parseInstagramInput('#coffee')), 'ig:tag:coffee');
  assert.equal(
    instagramRef(parseInstagramInput('https://www.instagram.com/explore/tags/Coffee/')),
    'ig:tag:coffee',
  );
});

test('a post, a reel and a story are not sources', () => {
  for (const path of ['/p/Cxyz123/', '/reel/Cxyz123/', '/stories/nasa/', '/explore/']) {
    assert.equal(parseInstagramInput(`https://www.instagram.com${path}`), null, path);
  }
  // Nor is a view of an account.
  assert.equal(parseInstagramInput('https://www.instagram.com/nasa/tagged/'), null);
});

test('an Instagram ref survives the round trip the crawler makes it do', () => {
  for (const input of ['ig/nasa', '#coffee', 'https://www.instagram.com/some.body/']) {
    const spec = parseInstagramInput(input);
    assert.equal(instagramRef(instagramSpecFromRef(instagramRef(spec))), instagramRef(spec), input);
  }
});

test('Instagram paths and slugs', () => {
  assert.equal(instagramSource('ig/nasa').path, '/ig/nasa');
  assert.equal(instagramSource('#coffee').path, '/ig/tag/coffee');
  assert.equal(instagramSource('ig/nasa').slug, 'ig-user-nasa');
});

/* ---------------------------------------------------------------- Facebook */

test('a Facebook Page is recognised in the spellings people paste', () => {
  const forms = [
    'fb/SomePage',
    'https://www.facebook.com/SomePage',
    'https://m.facebook.com/SomePage/',
    'https://fb.com/SomePage',
    'https://www.facebook.com/SomePage/about',
  ];

  assert.deepEqual([...new Set(forms.map((f) => facebookRef(parseFacebookInput(f))))], ['fb:page:somepage']);
});

test('a personal profile is not a Page, and cannot be', () => {
  // There is no Graph API for somebody's own timeline at all.
  assert.equal(parseFacebookInput('https://www.facebook.com/profile.php?id=100001'), null);
  assert.equal(parseFacebookInput('https://www.facebook.com/groups/12345'), null);
  assert.equal(parseFacebookInput('https://www.facebook.com/events/12345'), null);
});

test('a post under a Page is a thing to read, not a source', () => {
  assert.equal(parseFacebookInput('https://www.facebook.com/SomePage/posts/12345'), null);
  assert.equal(parseFacebookInput('https://www.facebook.com/SomePage/photos/12345'), null);
});

test('the old /pages/Name/id form keeps the id, which is the usable half', () => {
  assert.equal(
    facebookRef(parseFacebookInput('https://www.facebook.com/pages/Some-Name/123456789')),
    'fb:page:123456789',
  );
});

test('a bare number is not guessed to be a Facebook Page', () => {
  // It is also a plausible X list id. Guessing would be wrong in front of
  // somebody eventually.
  assert.equal(parseFacebookInput('1234567890'), null);
});

test('a Facebook ref survives the round trip', () => {
  for (const input of ['fb/SomePage', 'https://www.facebook.com/pages/N/123456789']) {
    const ref = facebookRef(parseFacebookInput(input));
    assert.equal(facebookRef(facebookSpecFromRef(ref)), ref, input);
  }
});

test('Page tokens come from structured config, keyed case-insensitively', () => {
  const env = { FB_PAGE_TOKENS: '[{"page":"MyPage","token":"EAAsecret"},{"page":"123456789","token":"EAAother"}]' };

  assert.equal(pageToken(env, 'mypage'), 'EAAsecret');
  assert.equal(pageToken(env, 'MyPage'), 'EAAsecret');
  assert.equal(pageToken(env, '123456789'), 'EAAother');
  assert.equal(pageToken(env, 'somebodyelse'), null);
  assert.deepEqual(connectedPages(env), ['MyPage', '123456789']);

  // Malformed config reads as "no token", not as a crash and not as an error
  // about the Page.
  assert.equal(pageToken({ FB_PAGE_TOKENS: '{oops' }, 'mypage'), null);
  assert.deepEqual(connectedPages({}), []);
});

test('an unconnected Page reschedules for an hour rather than being retired', async () => {
  const result = await fetchFacebookSource(
    { social_ref: 'fb:page:somepage', feed_url: 'https://www.facebook.com/SomePage' },
    { runtime: { env: {}, onEvent: () => {} } },
  );

  assert.equal(result.ok, false);
  assert.equal(result.throttled, true, 'not collectable is not the same as broken');
  assert.equal(result.retryAfter, UNCONFIGURED_SECONDS);
});

test('Graph answering 200 with an error object is still a failure', async () => {
  const env = { FB_PAGE_TOKENS: '[{"page":"somepage","token":"t"}]' };
  const feed = { social_ref: 'fb:page:somepage', feed_url: 'https://www.facebook.com/SomePage' };

  const graph = (payload) => async () =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });

  // Code 100 means the Page is gone or renamed: the one failure genuinely about
  // the source, and the only one allowed to reach markCrawlFailure.
  const gone = await fetchFacebookSource(feed, {
    runtime: { env, onEvent: () => {}, fetch: graph({ error: { code: 100, message: 'Unknown path' } }) },
  });
  assert.equal(gone.ok, false);
  assert.equal(gone.throttled, undefined);

  // Anything else Graph complains about is ours or theirs, not the Page's.
  const rate = await fetchFacebookSource(feed, {
    runtime: { env, onEvent: () => {}, fetch: graph({ error: { code: 4, message: 'rate limited' } }) },
  });
  assert.equal(rate.throttled, true);
});

test('a Page that answers is turned into items keyed on the post id', async () => {
  const env = { FB_PAGE_TOKENS: '[{"page":"somepage","token":"t"}]' };
  const payload = {
    data: [
      {
        id: '123_456',
        message: 'Hello <b>world</b>\nsecond line',
        created_time: '2026-08-29T10:00:00+0000',
        permalink_url: 'https://www.facebook.com/SomePage/posts/456',
        full_picture: 'https://scontent.example/1.jpg',
      },
      { id: '123_789', story: 'SomePage shared a link.', created_time: '2026-08-29T09:00:00+0000' },
    ],
  };

  const result = await fetchFacebookSource(
    { social_ref: 'fb:page:somepage', feed_url: 'https://www.facebook.com/SomePage' },
    {
      runtime: {
        env,
        onEvent: () => {},
        fetch: async () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      },
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.feed.items.map((i) => i.guid),
    ['fb:123_456', 'fb:123_789'],
  );

  const [first, second] = result.feed.items;
  assert.equal(first.title, 'SomePage: Hello <b>world</b>');
  // Graph returns plain text, so the only tags in the body are ones we wrote.
  assert.match(first.contentHtml, /&lt;b&gt;world/);
  assert.doesNotMatch(first.contentHtml, /<b>/);
  assert.equal(first.imageUrl, 'https://scontent.example/1.jpg');

  // A post with no caption still gets a title, because every format needs one.
  assert.equal(second.title, 'SomePage: SomePage shared a link.');
});

test('Instagram items are re-keyed on the post shortcode, not the bridge guid', async () => {
  const rss = [
    '<?xml version="1.0"?>',
    '<rss version="2.0"><channel>',
    '<title>NASA</title><link>https://www.instagram.com/nasa/</link>',
    '<item>',
    '<title>A photo</title>',
    '<link>https://www.instagram.com/p/CxAbCdEfGhI/</link>',
    '<guid>rsshub-internal-12345</guid>',
    '<pubDate>Sat, 29 Aug 2026 10:00:00 GMT</pubDate>',
    '<description>a caption</description>',
    '</item>',
    '<item>',
    '<title>No shortcode</title>',
    '<link>https://www.instagram.com/nasa/</link>',
    '<description>nothing</description>',
    '</item>',
    '</channel></rss>',
  ].join('\n');

  const result = await fetchInstagramSource(
    { social_ref: 'ig:user:nasa', feed_url: 'https://www.instagram.com/nasa/' },
    {
      runtime: {
        env: { RSSHUB_BASE_URL: 'http://127.0.0.1:1200' },
        onEvent: () => {},
        fetch: async () => new Response(rss, { status: 200 }),
      },
    },
  );

  assert.equal(result.ok, true);
  // The bridge's own guid is discarded: swapping bridges must not change the
  // identity of every post in the feed (AC-2). An item with no shortcode is
  // dropped rather than stored undeduplicatable.
  assert.deepEqual(
    result.feed.items.map((i) => i.guid),
    ['ig:CxAbCdEfGhI'],
  );
});

/* -------------------------------------------------- the shared failure rule */

test('only a missing source may count against it, for every platform', () => {
  assert.equal(failureResult(new XNoSuchSource('gone')).throttled, undefined);

  for (const error of [
    new XUnavailable('rsshub: upstream-502'),
    new XAuthFailed('auth-failed-401'),
    new XRateLimited('429', { retryAfter: 90 }),
  ]) {
    assert.equal(failureResult(error).throttled, true, error.name);
  }

  assert.equal(failureResult(new XRateLimited('429', { retryAfter: 90 })).retryAfter, 90);
  assert.equal(failureResult(new XUnavailable('boom')).retryAfter, ANOMALY_SECONDS);
  assert.equal(
    failureResult(new XUnavailable('instagram: no RSSHUB_BASE_URL')).retryAfter,
    UNCONFIGURED_SECONDS,
  );
});

test('Instagram with no provider configured reschedules for an hour', async () => {
  const result = await fetchInstagramSource(
    { social_ref: 'ig:user:nasa', feed_url: 'https://www.instagram.com/nasa/' },
    { runtime: { env: {}, onEvent: () => {} } },
  );

  assert.equal(result.ok, false);
  assert.equal(result.throttled, true);
  assert.equal(result.retryAfter, UNCONFIGURED_SECONDS);
});

/* ------------------------------------------------------ recognition + routing */

test('the four namespaces, and which of them needs a collector', () => {
  assert.deepEqual([...SOCIAL_NETWORKS], ['reddit', 'x', 'instagram', 'facebook']);

  // Reddit is a social network and is NOT collected: it publishes real RSS and
  // is fetched like any blog. That asymmetry is the whole reason the two
  // questions are separate.
  assert.equal(isCollected({ social_network: 'reddit' }), false);
  assert.equal(isCollected({ social_network: 'x' }), true);
  assert.equal(isCollected({ social_network: 'instagram' }), true);
  assert.equal(isCollected({ social_network: 'facebook' }), true);
  assert.equal(isCollected({}), false);
});

test('each platform is recognised, and nothing else is', () => {
  assert.equal(socialSourceFrom('https://www.reddit.com/r/programming/').network, 'reddit');
  assert.equal(socialSourceFrom('https://x.com/OpenAI').network, 'x');
  assert.equal(socialSourceFrom('https://www.instagram.com/nasa/').network, 'instagram');
  assert.equal(socialSourceFrom('https://www.facebook.com/SomePage').network, 'facebook');
  assert.equal(socialSourceFrom('https://example.com/feed.xml'), null);
});

test('a bare handle stays X, which had the spelling first', () => {
  // Ambiguous between X and Instagram; the ordering in identify.js decides it,
  // and /submit has accepted @handle as X since #156.
  assert.equal(socialSourceFrom('@OpenAI').network, 'x');
  assert.equal(socialSourceFrom('OpenAI').network, 'x');

  // Instagram stays reachable explicitly.
  assert.equal(socialSourceFrom('ig/OpenAI').network, 'instagram');
});

test('a stored row of any platform knows its own address', () => {
  assert.equal(socialPathFor({ social_ref: 'r:sub:programming' }), '/r/programming');
  assert.equal(socialPathFor({ social_ref: 'x:user:openai' }), '/x/openai');
  assert.equal(socialPathFor({ social_ref: 'ig:user:nasa' }), '/ig/nasa');
  assert.equal(socialPathFor({ social_ref: 'ig:tag:coffee' }), '/ig/tag/coffee');
  assert.equal(socialPathFor({ social_ref: 'fb:page:somepage' }), '/fb/somepage');
  assert.equal(socialPathFor({ slug: 'a-blog' }), '/a-blog');
});

test('a search ref keeps colons in its query rather than being truncated', () => {
  // `x:search:from:OpenAI lang:en` — splitting on every colon would cut the
  // query in half and produce a path to a different search.
  assert.equal(
    socialPathFor({ social_ref: 'x:search:from:openai lang:en' }),
    '/x/search?q=from%3Aopenai%20lang%3Aen',
  );
});

test('no public path ever names a provider', () => {
  for (const input of ['r/programming', '@OpenAI', 'ig/nasa', 'fb/SomePage']) {
    assert.doesNotMatch(socialSourceFrom(input).path, /rsshub|teapot|nitter|graph\.facebook/i, input);
  }
});

test('the dispatcher refuses a network it has no collector for', async () => {
  const result = await fetchSocialSource({ social_network: 'reddit' }, { runtime: {} });
  assert.equal(result.ok, false);
  assert.match(result.error, /no collector/);
});

/* --------------------------------------------------------- what to call a row */

test('an uncrawled row gets its canonical name rather than the imported one', () => {
  // The measured case: 50,026 subreddits came from an OPML catalogue and the
  // crawler has read a few hundred, so most rows are titled with the bare host
  // and /r/programming rendered a heading reading "reddit.com".
  for (const title of ['reddit.com', 'Reddit', 'www.reddit.com', '(untitled)', '', '   ']) {
    assert.equal(socialDisplayTitle({ title }, 'r/programming'), 'r/programming', JSON.stringify(title));
  }

  // A title that is just the URL it was imported from is the same non-answer.
  assert.equal(
    socialDisplayTitle(
      { title: 'www.reddit.com/r/programming', feed_url: 'https://www.reddit.com/r/programming/.rss' },
      'r/programming',
    ),
    'r/programming',
  );
});

test('a real title always wins, including one that mentions the platform', () => {
  // "Reddit Blog" is somebody's actual feed title, not a placeholder.
  assert.equal(socialDisplayTitle({ title: 'Reddit Blog' }, 'r/blog'), 'Reddit Blog');
  assert.equal(
    socialDisplayTitle({ title: 'programming' }, 'r/programming'),
    'programming',
  );
  assert.equal(socialDisplayTitle({ title: 'NASA' }, '@nasa on Instagram'), 'NASA');
});
