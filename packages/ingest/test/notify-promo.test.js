import assert from 'node:assert/strict';
import { test } from 'node:test';

// Offline and deterministic: the bundled catalog, never the CDN.
process.env['CROSS_PROMO'] = 'bundled';
process.env['SITE_URL'] = 'https://rssamp.com';

const { submissionEmail, discoveryEmail } = await import('../src/notify.js');

test('the "feeds are indexed" email ends with the network block, never promoting RSSAmp', async () => {
  const msg = await submissionEmail({ to: 'a@example.com', submissionId: 's1', crawled: 3, failed: 1, queued: 4 });
  assert.match(msg.text, /Full status: https:\/\/rssamp\.com\/submissions\/s1\n\n/);
  assert.match(msg.text, /mynaposter\.com/);
  assert.match(msg.text, /utm_source=rssamp\.com/);
  const promo = msg.text.slice(msg.text.indexOf('Full status:'));
  assert.doesNotMatch(promo.split('\n').slice(1).join('\n'), /https:\/\/(www\.)?(rssamp|rssamplifier)\.com/);
});

test('the keyword-discovery email carries the same publisher block', async () => {
  const msg = await discoveryEmail({ to: 'b@example.com', runId: 'r1', keywords: ['rust'], accepted: 2, checked: 9 });
  assert.match(msg.text, /Full status: https:\/\/rssamp\.com\/discoveries\/r1\n\n/);
  assert.match(msg.text, /mynaposter\.com/);
  const promo = msg.text.slice(msg.text.indexOf('Full status:'));
  assert.doesNotMatch(promo.split('\n').slice(1).join('\n'), /https:\/\/(www\.)?(rssamp|rssamplifier)\.com/);
});
