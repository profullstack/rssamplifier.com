import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scrapeFacebookPage } from '../src/facebook/scrape.js';
import { fetchFacebookSource } from '../src/facebook/fetch.js';
import { floorMinutesFor, FLOOR_MINUTES } from '../src/collect.js';

/*
 * The scraper, against a fixture shaped like mbasic's own output.
 *
 * What matters here is not that the selectors are right — only a live cookie
 * proves that, and they will change anyway — but that everything *around* them
 * is: a login wall must retire the session and not the Page, a post with no id
 * must be dropped rather than stored undeduplicatable, and a relative mbasic
 * link must come out pointing at facebook.com.
 */

const PAGE = [
  '<!DOCTYPE html><html><head><title>NASA - Home | Facebook</title></head><body>',
  '<div id="m_story_permalink_view">',
  '  <div data-ft=\'{"top_level_post_id":"123456789","mf_story_key":"123456789"}\'>',
  '    <div><span>We are going to the Moon.</span></div>',
  '    <abbr data-utime="1756461600">29 August at 10:00</abbr>',
  '    <a href="/story.php?story_fbid=123456789&amp;id=999&amp;refid=17">Full story</a>',
  '    <img src="https://scontent.example/photo1.jpg" alt="">',
  '  </div>',
  '  <div data-ft=\'{"top_level_post_id":"987654321"}\'>',
  '    <div><span>A second post.</span></div>',
  '    <abbr data-utime="1756458000">29 August at 09:00</abbr>',
  '    <a href="/nasa/posts/987654321">Full story</a>',
  '  </div>',
  '  <div><span>Furniture with no data-ft and no link at all.</span></div>',
  '</div></body></html>',
].join('\n');

/**
 * A Response that reports where it landed.
 *
 * `Response.url` is getter-only, so it has to be defined rather than assigned —
 * and it has to be set at all, because that is the only thing distinguishing
 * "mbasic served the page" from "mbasic redirected to the login wall and served
 * that instead". Both are a 200.
 */
const respond = (body, url = 'https://mbasic.facebook.com/nasa') => async () => {
  const res = new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  Object.defineProperty(res, 'url', { value: url });
  return res;
};

test('a page of stories becomes posts keyed on the post id', async () => {
  const { posts, displayName } = await scrapeFacebookPage(
    { page: 'nasa' },
    { cookie: 'c_user=1; xs=secret', fetch: respond(PAGE) },
  );

  assert.deepEqual(
    posts.map((p) => p.id),
    ['123456789', '987654321'],
    'the element with no data-ft and no permalink is furniture, not a post',
  );

  assert.equal(displayName, 'NASA');
  assert.equal(posts[0].text, 'We are going to the Moon.');
  assert.equal(posts[0].createdAt, new Date(1756461600 * 1000).toISOString());
  assert.equal(posts[0].image, 'https://scontent.example/photo1.jpg');
});

test('links come out pointing at facebook.com, not at mbasic', async () => {
  const { posts } = await scrapeFacebookPage(
    { page: 'nasa' },
    { cookie: 'c_user=1; xs=secret', fetch: respond(PAGE) },
  );

  for (const post of posts) {
    assert.match(post.url, /^https:\/\/www\.facebook\.com\//, post.url);
    assert.doesNotMatch(post.url, /mbasic/);
    // The tracking parameter mbasic appends is not part of the address.
    assert.doesNotMatch(post.url, /refid/);
  }
});

test('no session is a configuration problem, not a broken Page', async () => {
  await assert.rejects(
    () => scrapeFacebookPage({ page: 'nasa' }, { cookie: '', fetch: respond(PAGE) }),
    /FB_COOKIE/,
  );
});

test('the login wall retires the session, never the Page', async () => {
  // Both shapes of being told the same thing: the redirect, and the body.
  const byUrl = scrapeFacebookPage(
    { page: 'nasa' },
    {
      cookie: 'c_user=1; xs=stale',
      fetch: respond('<html><body>anything</body></html>', 'https://mbasic.facebook.com/login.php?next=x'),
    },
  );
  await assert.rejects(byUrl, (error) => error.name === 'XAuthFailed');

  const byBody = scrapeFacebookPage(
    { page: 'nasa' },
    {
      cookie: 'c_user=1; xs=stale',
      fetch: respond('<html><body><form name="login">…</form></body></html>'),
    },
  );
  await assert.rejects(byBody, (error) => error.name === 'XAuthFailed');
});

test('a Page that does not exist is the one failure about the source', async () => {
  const missing = scrapeFacebookPage(
    { page: 'nosuchpagehere' },
    {
      cookie: 'c_user=1; xs=secret',
      fetch: respond("<html><body>This content isn't available right now</body></html>"),
    },
  );

  await assert.rejects(missing, (error) => error.name === 'XNoSuchSource');
});

test('an undated post is stored undated rather than stamped now', async () => {
  // mbasic writes relative dates ("Yesterday at 14:03") that do not parse. A
  // null date is correct; inventing `now` would make the feed look permanently
  // fresh, which is exactly what publishedTimes exists to prevent.
  const relative = PAGE.replace('<abbr data-utime="1756461600">29 August at 10:00</abbr>', '<abbr>Yesterday at 14:03</abbr>');

  const { posts } = await scrapeFacebookPage(
    { page: 'nasa' },
    { cookie: 'c_user=1; xs=secret', fetch: respond(relative) },
  );

  assert.equal(posts[0].createdAt, null);
});

test('the collector turns a scrape into items, and a stale session into a throttle', async () => {
  const feed = { social_ref: 'fb:page:nasa', feed_url: 'https://www.facebook.com/NASA' };

  const ok = await fetchFacebookSource(feed, {
    runtime: { env: { FB_COOKIE: 'c_user=1; xs=secret' }, onEvent: () => {}, fetch: respond(PAGE) },
  });

  assert.equal(ok.ok, true);
  assert.deepEqual(
    ok.feed.items.map((i) => i.guid),
    ['fb:123456789', 'fb:987654321'],
  );
  // Display casing comes off feed_url, not off the lowercased ref.
  assert.match(ok.feed.items[0].title, /^NASA: /);

  const stale = await fetchFacebookSource(feed, {
    runtime: {
      env: { FB_COOKIE: 'c_user=1; xs=stale' },
      onEvent: () => {},
      fetch: respond('<html><body>x</body></html>', 'https://mbasic.facebook.com/login.php'),
    },
  });

  // A dead cookie must reschedule. Ten of these in a row would otherwise retire
  // every Facebook Page in the directory.
  assert.equal(stale.ok, false);
  assert.equal(stale.throttled, true);
});

test('a Page token is preferred over scraping where one exists', async () => {
  let scraped = 0;
  const feed = { social_ref: 'fb:page:nasa', feed_url: 'https://www.facebook.com/NASA' };

  const result = await fetchFacebookSource(feed, {
    runtime: {
      env: {
        FB_PAGE_TOKENS: '[{"page":"nasa","token":"EAAtoken"}]',
        FB_COOKIE: 'c_user=1; xs=secret',
      },
      onEvent: () => {},
      fetch: async (url) => {
        if (String(url).includes('mbasic')) scraped += 1;
        return new Response(
          JSON.stringify({ data: [{ id: '1_2', message: 'via graph', created_time: '2026-08-29T10:00:00+0000' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(scraped, 0, 'a supported API beats guessing at markup');
  assert.deepEqual(result.feed.items.map((i) => i.guid), ['fb:1_2']);
});

test('each platform is asked no faster than it tolerates', () => {
  // Not one number: X goes through a bridge built to be polled, while Instagram
  // and Facebook are read with a personal session against platforms that watch
  // for exactly that. The cost of asking too fast there is a locked account,
  // not a 429.
  assert.equal(floorMinutesFor({ social_network: 'x' }), 5);
  assert.equal(floorMinutesFor({ social_network: 'instagram' }), 30);
  assert.equal(floorMinutesFor({ social_network: 'facebook' }), 60);

  // Reddit is fetched rather than collected and takes the ordinary hour.
  assert.equal(floorMinutesFor({ social_network: 'reddit' }), 60);
  assert.equal(floorMinutesFor({}), 60);

  // Nothing collected may be asked faster than X.
  for (const minutes of Object.values(FLOOR_MINUTES)) assert.ok(minutes >= 5);
});
