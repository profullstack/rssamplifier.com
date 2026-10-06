import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  commentTree,
  fetchRedditComments,
  fetchRedditPost,
  postToItem,
  redditMarkdown,
  redditPostId,
} from '../src/reddit/arctic.js';
import { fetchRedditSource } from '../src/reddit/fetch.js';
import { fetchSocialSource } from '../src/collect.js';

/** A recorded-shape Arctic Shift post, trimmed to the fields that matter. */
const POST = {
  id: '1wuoyvc',
  name: 't3_1wuoyvc',
  title: 'What are the best Otter.ai alternatives for files I already have?',
  author: 'RosyBodyNimbus',
  subreddit: 'AskTechnology',
  permalink: '/r/AskTechnology/comments/1wuoyvc/what_are_the_best_otterai_alternatives/',
  url: 'https://www.reddit.com/r/AskTechnology/comments/1wuoyvc/what_are_the_best_otterai_alternatives/',
  created_utc: 1790800000,
  is_self: true,
  selftext: 'I have about 40 voice memos &amp; no bot.\n\nWhat are you using?',
  num_comments: 5,
  link_flair_text: null,
  removed_by_category: null,
  thumbnail: 'self',
  domain: 'self.AskTechnology',
};

/** A fetch double that answers by path, and records what it was asked. */
function fakeFetch(routes) {
  const asked = [];
  const fn = async (url) => {
    asked.push(String(url));
    const path = new URL(String(url)).pathname;
    const body = routes[path];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  fn.asked = asked;
  return fn;
}

test('post ids: bare, fullname, and junk', () => {
  assert.equal(redditPostId('1wuoyvc'), '1wuoyvc');
  assert.equal(redditPostId('t3_1WUOYVC'), '1wuoyvc');
  assert.equal(redditPostId('../etc'), null);
  assert.equal(redditPostId(''), null);
});

test('a post keeps the guid Reddit\'s own Atom feed used, so nothing goes unread on the switch', () => {
  const item = postToItem(POST);
  assert.equal(item.guid, 't3_1wuoyvc');
  assert.equal(item.url, `https://www.reddit.com${POST.permalink}`);
  assert.equal(item.author, 'u/RosyBodyNimbus');
  assert.equal(item.publishedAt, new Date(1790800000 * 1000).toISOString());
  // Reddit stores & entity-escaped; it must come out escaped exactly once.
  assert.match(item.contentHtml, /40 voice memos &amp; no bot\./);
  assert.doesNotMatch(item.contentHtml, /&amp;amp;/);
  assert.match(item.contentHtml, /5 comments/);
  assert.deepEqual(item.categories, []);
  assert.equal(postToItem({ ...POST, selftext: '' }).summary, '', 'no byline masquerading as a summary');
});

test('removed and deleted posts are not republished', () => {
  assert.equal(postToItem({ ...POST, removed_by_category: 'moderator' }), null);
  assert.equal(postToItem({ ...POST, selftext: '[removed]' }), null);
  assert.equal(postToItem({ ...POST, selftext: '[deleted]' }), null);
});

test('markdown: paragraphs, links, lists, quotes and code, with nothing left as raw markup', () => {
  const html = redditMarkdown(
    'Hello **world** and *you*.\nSecond line\n\n' +
      '- one\n- [two](https://example.org/x)\n\n' +
      '&gt; quoted\n\n' +
      'see https://example.org/a.b, and r/AskTechnology\n\n' +
      '    code &lt;b&gt;\n\n' +
      '<script>alert(1)</script>',
  );
  assert.match(html, /<p>Hello <strong>world<\/strong> and <em>you<\/em>\.<br>Second line<\/p>/);
  assert.match(html, /<ul><li>one<\/li><li><a href="https:\/\/example.org\/x">two<\/a><\/li><\/ul>/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.match(html, /<a href="https:\/\/example.org\/a.b">https:\/\/example.org\/a.b<\/a>,/);
  assert.match(html, /<a href="https:\/\/www.reddit.com\/r\/AskTechnology">r\/AskTechnology<\/a>/);
  assert.match(html, /<pre><code>code &lt;b&gt;<\/code><\/pre>/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('markdown: a link label cannot smuggle markup', () => {
  const html = redditMarkdown('[<img src=x onerror=alert(1)>](https://example.org/")');
  assert.doesNotMatch(html, /<img/);
});

test('comment tree: nesting survives, removed comments keep their place but lose their words', () => {
  const tree = commentTree([
    {
      kind: 't1',
      data: {
        id: 'a1',
        author: 'alice',
        body: 'top',
        created_utc: 1790800100,
        score: 3,
        is_submitter: true,
        replies: {
          kind: 'Listing',
          data: {
            children: [
              { kind: 't1', data: { id: 'b1', author: 'bob', body: '[removed]', replies: '' } },
              { kind: 'more', data: { children: ['zz'] } },
            ],
          },
        },
      },
    },
    { kind: 't1', data: { id: 'c1', author: 'carol', body: 'gone', _meta: { removal_type: 'removed by reddit' }, replies: '' } },
  ]);

  assert.equal(tree.length, 2);
  assert.equal(tree[0].author, 'alice');
  assert.equal(tree[0].submitter, true);
  assert.equal(tree[0].html, '<p>top</p>');
  assert.equal(tree[0].replies.length, 1, 'a "more" stub is not a comment');
  assert.equal(tree[0].replies[0].removed, true);
  assert.equal(tree[0].replies[0].html, '');
  assert.equal(tree[0].replies[0].author, '[deleted]');
  assert.equal(tree[1].removed, true);
  assert.equal(tree[1].html, '');
});

test('the collector reads a subreddit from the mirror, by name, with no runtime at all', async () => {
  const fetch = fakeFetch({ '/api/posts/search': { data: [POST, { ...POST, id: 'gone', removed_by_category: 'moderator' }] } });
  const result = await fetchRedditSource(
    { social_ref: 'r:sub:asktechnology', feed_url: 'https://www.reddit.com/r/asktechnology/new.rss', item_count: 0 },
    { runtime: { fetch } },
  );

  assert.equal(result.ok, true);
  assert.equal(result.feedUrl, 'https://www.reddit.com/r/asktechnology/new.rss', 'the row keeps its host for per-host pacing');
  assert.equal(result.feed.title, 'r/AskTechnology', "Reddit's casing, from the archive");
  assert.equal(result.feed.items.length, 1);
  const asked = new URL(fetch.asked[0]);
  assert.equal(asked.hostname, 'arctic-shift.photon-reddit.com');
  assert.equal(asked.searchParams.get('subreddit'), 'asktechnology');
  assert.equal(asked.searchParams.get('sort'), 'desc');
});

test('a user source asks by author', async () => {
  const fetch = fakeFetch({ '/api/posts/search': { data: [POST] } });
  const result = await fetchRedditSource({ social_ref: 'r:user:rosybodynimbus', feed_url: 'x' }, { runtime: { fetch } });
  assert.equal(result.ok, true);
  assert.equal(new URL(fetch.asked[0]).searchParams.get('author'), 'rosybodynimbus');
  assert.equal(result.feed.title, 'u/RosyBodyNimbus on Reddit');
});

test('a mirror outage or an empty answer for a source that had posts never counts against the source', async () => {
  const down = async () => new Response('bad gateway', { status: 502 });
  const failed = await fetchRedditSource({ social_ref: 'r:sub:asktechnology', feed_url: 'x' }, { runtime: { fetch: down } });
  assert.equal(failed.ok, false);
  assert.equal(failed.throttled, true);

  const empty = fakeFetch({ '/api/posts/search': { data: [] } });
  const quiet = await fetchRedditSource(
    { social_ref: 'r:sub:asktechnology', feed_url: 'x', item_count: 40 },
    { runtime: { fetch: empty } },
  );
  assert.equal(quiet.throttled, true);

  const errored = fakeFetch({ '/api/posts/search': { error: 'Timeout. Maybe slow down a bit' } });
  const slow = await fetchRedditSource({ social_ref: 'r:sub:asktechnology', feed_url: 'x' }, { runtime: { fetch: errored } });
  assert.equal(slow.throttled, true);
});

test('fetchSocialSource routes reddit rows to the mirror even when the crawler has no runtime', async () => {
  const fetch = fakeFetch({ '/api/posts/search': { data: [POST] } });
  const viaRouter = await fetchSocialSource(
    { social_network: 'reddit', social_ref: 'r:sub:asktechnology', feed_url: 'x' },
    { runtime: { fetch } },
  );
  assert.equal(viaRouter.ok, true);
});

test('a thread: one post and its comments, by id', async () => {
  const fetch = fakeFetch({
    '/api/posts/ids': { data: [POST] },
    '/api/comments/tree': { data: [{ kind: 't1', data: { id: 'a1', author: 'alice', body: 'hi', replies: '' } }] },
  });
  const post = await fetchRedditPost('1wuoyvc', { fetch });
  assert.equal(post.id, '1wuoyvc');
  const comments = await fetchRedditComments('t3_1wuoyvc', { fetch });
  assert.equal(comments[0].author, 'alice');
  assert.equal(new URL(fetch.asked[1]).searchParams.get('link_id'), '1wuoyvc');

  assert.equal(await fetchRedditPost('not/an/id', { fetch }), null, 'never asks about junk');
  assert.equal(fetch.asked.length, 2);
});
