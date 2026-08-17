import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkWebhookUrl, signBody, verifySignature, postWebhook } from '../src/webhook.js';
import { alertItem, renderEmail, renderPush, renderWebhook, trim } from '../src/render.js';

/**
 * The webhook channel, and what each channel's message actually says.
 */

test('a webhook URL has to be https and public', () => {
  assert.equal(checkWebhookUrl('https://hooks.example.com/x').ok, true);

  // The reason the check exists: this endpoint has a server make a request to a
  // URL a stranger typed, so the addresses that only mean something from inside
  // the network are the ones to refuse.
  for (const bad of [
    'http://hooks.example.com/x',
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://10.0.0.5/x',
    'https://192.168.1.1/x',
    'https://172.16.4.4/x',
    'https://169.254.169.254/latest/meta-data/',
    'https://redis.internal/x',
    'not a url',
  ]) {
    assert.equal(checkWebhookUrl(bad).ok, false, `${bad} should be refused`);
  }

  // 172.32 is outside the private range and must not be caught by a regex that
  // reads "172." and stops thinking.
  assert.equal(checkWebhookUrl('https://172.32.0.1/x').ok, true);
});

test('a signature covers the exact bytes the receiver gets', () => {
  const body = JSON.stringify({ count: 2 });
  const signature = signBody(body, 'sh');

  assert.match(signature, /^sha256=[0-9a-f]{64}$/);
  assert.ok(verifySignature(body, 'sh', signature));
  assert.equal(verifySignature(body, 'other-secret', signature), false);
  assert.equal(verifySignature(`${body} `, 'sh', signature), false);
  assert.equal(verifySignature(body, 'sh', 'sha256=nonsense'), false, 'and a short one does not throw');
});

test('a refused URL is retired rather than retried', async () => {
  const result = await postWebhook('http://localhost/x', { hello: true });

  assert.equal(result.ok, false);
  assert.equal(result.gone, true, 'it will never start passing the check');
});

/** One row as the alert queries return it. */
const ROW = {
  guid: 'g1',
  url: 'https://blog.example.com/post',
  title: 'A post about gardening',
  summary: '  Tomatoes,   mostly.  ',
  published_at: '2026-08-17T09:00:00.000Z',
  created_at: '2026-08-17T09:05:00.000Z',
  feed_slug: 'garden-blog',
  feed_title: 'The Garden Blog',
};

const VIA_FEED = { kind: 'feed', title: '', href: '' };
const VIA_TOPIC = { kind: 'topic', title: 'gardening', href: '/topics/gardening' };

test('an item carries the follow that pulled it in', () => {
  const byFeed = alertItem(ROW, VIA_FEED, 'https://x.test');
  assert.equal(byFeed.url, 'https://blog.example.com/post', 'the publisher’s URL, not ours');
  assert.equal(byFeed.feed.url, 'https://x.test/garden-blog');
  assert.equal(byFeed.summary, 'Tomatoes, mostly.');
  assert.equal(byFeed.via.title, 'The Garden Blog', 'a blog alert is attributed to the blog');

  const byTopic = alertItem(ROW, VIA_TOPIC, 'https://x.test');
  assert.equal(byTopic.via.title, 'gardening');
  assert.equal(byTopic.via.url, 'https://x.test/topics/gardening');
});

test('one post makes a named subject; several make a count', () => {
  const one = alertItem(ROW, VIA_FEED, 'https://x.test');
  const single = renderEmail([one], { origin: 'https://x.test' });

  assert.equal(single.subject, 'A post about gardening — The Garden Blog');
  assert.match(single.text, /https:\/\/x\.test\/account\/alerts/, 'and a way to stop');

  const many = renderEmail([one, one, one], { origin: 'https://x.test' });
  assert.equal(many.subject, '3 new posts from what you follow');
});

test('a push for one post opens that post; a push for several opens the river', () => {
  const item = alertItem(ROW, VIA_TOPIC, 'https://x.test');

  const one = renderPush([item], { origin: 'https://x.test' });
  assert.equal(one.title, 'A post about gardening');
  assert.equal(one.body, 'The Garden Blog · via gardening');
  assert.equal(one.url, 'https://blog.example.com/post');

  const several = renderPush([item, item], { origin: 'https://x.test' });
  assert.equal(several.title, '2 new posts');
  assert.equal(several.url, 'https://x.test/following');
  // One tag, so a second batch replaces the first rather than stacking on it.
  assert.equal(several.tag, one.tag);
});

test('the webhook body is versioned, because a program reads it', () => {
  const item = alertItem(ROW, VIA_FEED, 'https://x.test');
  const body = renderWebhook([item], { origin: 'https://x.test', at: '2026-08-17T10:00:00.000Z' });

  assert.equal(body.version, 1);
  assert.equal(body.type, 'alert');
  assert.equal(body.at, '2026-08-17T10:00:00.000Z');
  assert.equal(body.count, 1);
  assert.equal(body.items[0].title, 'A post about gardening');
});

test('trimming prefers a word boundary, but not at any price', () => {
  assert.equal(trim('short', 20), 'short');
  // Whitespace is collapsed first, so a summary full of feed indentation does
  // not spend its budget on it.
  assert.equal(trim('  lots   of\n   space  ', 40), 'lots of space');

  // A boundary late in the budget is used.
  assert.equal(trim('aaaa bbbb cccc dddd', 14), 'aaaa bbbb…');

  // One early in it is not: landing on it would throw away most of what there
  // was room for, so the cut lands mid-word instead.
  assert.equal(trim('one two three four five six', 12), 'one two thre…');

  // A single word longer than the budget has no boundary at all and is cut
  // anyway, rather than being returned over length.
  assert.ok(trim('a'.repeat(50), 10).length <= 11);
});
