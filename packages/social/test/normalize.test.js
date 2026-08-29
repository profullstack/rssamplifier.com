import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeXFeed, normalizeXPost } from '../src/x/normalize.js';

/*
 * The seam every format renders through. What is checked here is mostly what
 * must *not* happen: an item without a stable id, a repost that renders blank,
 * a quote whose quoted half is missing, and markup escaping — the four ways a
 * post turns into an unreadable or undeduplicatable row.
 */

/** @param {object} over */
function post(over = {}) {
  return {
    id: '1898765432109876543',
    url: 'https://x.com/OpenAI/status/1898765432109876543',
    text: 'Hello world',
    createdAt: '2026-08-29T10:00:00.000Z',
    author: { username: 'OpenAI', displayName: 'OpenAI' },
    ...over,
  };
}

const CONTEXT = {
  spec: { mode: 'user', username: 'OpenAI' },
  url: 'https://x.com/OpenAI',
};

test('the guid is the post id, never the URL', () => {
  const item = normalizeXPost(post());
  assert.equal(item.guid, 'x:1898765432109876543');

  // A handle change rewrites every URL an account has ever had. Keying on the
  // id is what stops that re-ingesting the whole timeline as new.
  const renamed = normalizeXPost(
    post({ url: 'https://x.com/OpenAI_new/status/1898765432109876543' }),
  );
  assert.equal(renamed.guid, item.guid);
});

test('a post gets a title, because every format we render needs one', () => {
  const item = normalizeXPost(post({ text: 'Hello world' }));
  assert.equal(item.title, 'OpenAI: Hello world');

  const long = normalizeXPost(post({ text: 'x'.repeat(400) }));
  assert.ok(long.title.length < 140);
  assert.ok(long.title.endsWith('…'));

  // A post with only an image still needs a title.
  const media = normalizeXPost(post({ text: '', media: [{ type: 'image', url: 'https://p/1.jpg' }] }));
  assert.equal(media.title, 'OpenAI: (media)');
});

test('a repost renders the original rather than a blank item', () => {
  const item = normalizeXPost(
    post({
      text: '',
      repostOfId: '111',
      repostOf: post({ id: '111', text: 'The original post', author: { username: 'example' } }),
    }),
  );

  assert.match(item.title, /^OpenAI reposted @example: The original post$/);
  assert.match(item.contentHtml, /reposted/);
  assert.match(item.contentHtml, /The original post/);
});

test('a quote keeps both halves', () => {
  const item = normalizeXPost(
    post({
      text: 'Worth reading',
      quotedPostId: '222',
      quotedPost: post({ id: '222', text: 'The quoted claim', author: { username: 'someone' } }),
    }),
  );

  assert.match(item.contentHtml, /Worth reading/);
  assert.match(item.contentHtml, /The quoted claim/);
  assert.match(item.contentHtml, /@someone/);
  assert.match(item.summary, /Quoting @someone/);
});

test('a quoted post that also arrives on its own is not stored twice', () => {
  const quoted = post({ id: '222', text: 'Original', author: { username: 'someone' } });
  const quoting = post({ id: '333', text: 'Commentary', quotedPostId: '222', quotedPost: quoted });

  const feed = normalizeXFeed([quoting, quoted], CONTEXT);
  assert.deepEqual(
    feed.items.map((item) => item.guid),
    ['x:333'],
  );
});

test('replies are off by default and on in the replies feed', () => {
  const reply = post({ id: '444', replyToId: '999', text: 'Agreed' });

  assert.equal(normalizeXFeed([reply], CONTEXT).items.length, 0);
  assert.equal(
    normalizeXFeed([reply], { ...CONTEXT, spec: { mode: 'replies', username: 'OpenAI' } }).items
      .length,
    1,
  );
  assert.equal(normalizeXFeed([reply], { ...CONTEXT, includeReplies: true }).items.length, 1);
});

test('reposts are on by default and can be switched off', () => {
  const repost = post({ id: '555', repostOfId: '111', repostOf: post({ id: '111' }) });

  assert.equal(normalizeXFeed([repost], CONTEXT).items.length, 1);
  assert.equal(normalizeXFeed([repost], { ...CONTEXT, includeReposts: false }).items.length, 0);
});

test('post text is escaped, and only our own tags survive', () => {
  const item = normalizeXPost(post({ text: '<script>alert(1)</script> & "quotes"' }));

  assert.doesNotMatch(item.contentHtml, /<script>/);
  assert.match(item.contentHtml, /&lt;script&gt;/);
  assert.match(item.contentHtml, /&amp;/);
});

test('links, handles and hashtags become links without double-escaping', () => {
  const item = normalizeXPost(post({ text: 'See https://example.com/a?b=1&c=2 via @someone #news' }));

  assert.match(item.contentHtml, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2"/);
  assert.match(item.contentHtml, /href="https:\/\/x\.com\/someone"/);
  assert.match(item.contentHtml, /href="https:\/\/x\.com\/hashtag\/news"/);
  assert.deepEqual(item.categories, ['news']);
});

test('media renders, and a failure to find any takes nothing with it', () => {
  const withImage = normalizeXPost(
    post({ media: [{ type: 'image', url: 'https://pbs.example/1.jpg' }] }),
  );
  assert.match(withImage.contentHtml, /<img src="https:\/\/pbs\.example\/1\.jpg"/);
  assert.equal(withImage.imageUrl, 'https://pbs.example/1.jpg');

  // Video links to the post rather than embedding a signed URL that expires.
  const withVideo = normalizeXPost(
    post({ media: [{ type: 'video', url: 'https://v/1.mp4', previewUrl: 'https://v/1.jpg' }] }),
  );
  assert.match(withVideo.contentHtml, /Video on X/);
  assert.doesNotMatch(withVideo.contentHtml, /<video/);

  // Nothing at all is still a perfectly good item — text is primary.
  const bare = normalizeXPost(post({ media: undefined }));
  assert.equal(bare.imageUrl, null);
  assert.match(bare.contentHtml, /Hello world/);
});

test('an item with no id is dropped rather than stored undeduplicatable', () => {
  assert.equal(normalizeXPost({ text: 'orphan' }), null);
  assert.equal(normalizeXFeed([{ text: 'orphan' }, post()], CONTEXT).items.length, 1);
});

test('the channel names the account rather than the provider', () => {
  const feed = normalizeXFeed([post()], { ...CONTEXT, displayName: 'OpenAI' });

  assert.equal(feed.title, 'OpenAI (@OpenAI)');
  assert.equal(feed.siteUrl, 'https://x.com/OpenAI');
  assert.doesNotMatch(JSON.stringify(feed), /rsshub|teapot|nitter/i);
});

test('X items carry no enclosure, so a podcast client is never handed a dead URL', () => {
  const item = normalizeXPost(
    post({ media: [{ type: 'video', url: 'https://v/1.mp4', previewUrl: 'https://v/1.jpg' }] }),
  );
  assert.equal(item.audio, null);
});
