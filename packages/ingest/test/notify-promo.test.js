import assert from 'node:assert/strict';
import { test } from 'node:test';

// Offline and deterministic: the bundled catalog, never the CDN.
process.env['CROSS_PROMO'] = 'bundled';
process.env['SITE_URL'] = 'https://rssamp.com';

const { submissionEmail, discoveryEmail, reasonWords } = await import('../src/notify.js');

test('the "feed is listed" email ends with the network block, never promoting RSSAmp', async () => {
  const msg = await submissionEmail({
    to: 'a@example.com',
    submissionId: 's1',
    added: 3,
    failed: 1,
    feeds: [{ slug: 'my-blog', title: 'My Blog', outcome: 'added' }],
  });
  assert.match(msg.text, /Full status: https:\/\/rssamp\.com\/submissions\/s1\n\n/);
  assert.match(msg.text, /mynaposter\.com/);
  assert.match(msg.text, /utm_source=rssamp\.com/);
  const promo = msg.text.slice(msg.text.indexOf('Full status:'));
  assert.doesNotMatch(promo.split('\n').slice(1).join('\n'), /https:\/\/(www\.)?(rssamp|rssamplifier)\.com/);
  // The HTML part carries the same block.
  assert.match(msg.html, /mynaposter\.com/);
  assert.match(msg.html, /<a href="https:\/\/rssamp\.com\/my-blog">My Blog<\/a>: Added/);
});

test('one feed added reads as listed, with its page', async () => {
  const msg = await submissionEmail({
    to: 'a@example.com',
    submissionId: 's2',
    added: 1,
    failed: 0,
    feeds: [{ slug: 'my-blog', title: 'My Blog', outcome: 'added' }],
  });
  assert.equal(msg.subject, 'Your feed is listed on RSSAmp');
  assert.match(msg.text, /- My Blog: Added\n  https:\/\/rssamp\.com\/my-blog/);
});

test('a feed that was already listed says so', async () => {
  const msg = await submissionEmail({
    to: 'a@example.com',
    submissionId: 's3',
    added: 0,
    listed: 1,
    failed: 0,
    feeds: [{ slug: 'old', title: 'Old Blog', path: '/r/old', outcome: 'listed' }],
  });
  assert.equal(msg.subject, 'Your feed is listed on RSSAmp');
  assert.match(msg.text, /already in the directory/);
  assert.match(msg.text, /Old Blog: Already listed\n  https:\/\/rssamp\.com\/r\/old/);
});

test('a failure is said plainly, with the reason', async () => {
  const msg = await submissionEmail({
    to: 'a@example.com',
    submissionId: 's4',
    added: 0,
    failed: 1,
    feeds: [{ url: 'https://nope.example', outcome: 'failed', reason: 'no-feed-found' }],
  });
  assert.equal(msg.subject, 'We could not add your feed to RSSAmp');
  assert.match(msg.text, /https:\/\/nope\.example: Not added: no feed found on the site/);
});

test('a long list names twenty and counts the rest', async () => {
  const feeds = Array.from({ length: 30 }, (_, i) => ({ slug: `b${i}`, title: `Blog ${i}`, outcome: 'added' }));
  const msg = await submissionEmail({ to: 'a@example.com', submissionId: 's5', added: 500, failed: 3, feeds });
  assert.equal(msg.subject, '500 of your 503 feeds are listed on RSSAmp');
  assert.equal((msg.text.match(/^- Blog /gm) ?? []).length, 20);
  assert.match(msg.text, /And 483 more\./);
});

test('the copy carries no em dashes', async () => {
  const msg = await submissionEmail({
    to: 'a@example.com',
    submissionId: 's6',
    added: 1,
    listed: 1,
    failed: 1,
    feeds: [{ url: 'x', outcome: 'failed', reason: 'timeout' }],
  });
  const body = msg.text.slice(0, msg.text.indexOf('Full status:'));
  assert.doesNotMatch(`${msg.subject}\n${body}`, /—/);
});

test('reason codes become words, and raw errors stay short', () => {
  assert.equal(reasonWords('http-404'), 'the site answered HTTP 404');
  assert.equal(reasonWords('timeout'), 'the site did not respond');
  assert.equal(reasonWords('x'.repeat(200)), 'it could not be read');
  assert.equal(reasonWords(''), 'it could not be read');
});

test('the keyword-discovery email carries the same publisher block', async () => {
  const msg = await discoveryEmail({ to: 'b@example.com', runId: 'r1', keywords: ['rust'], accepted: 2, checked: 9 });
  assert.match(msg.text, /Full status: https:\/\/rssamp\.com\/discoveries\/r1\n\n/);
  assert.match(msg.text, /mynaposter\.com/);
  const promo = msg.text.slice(msg.text.indexOf('Full status:'));
  assert.doesNotMatch(promo.split('\n').slice(1).join('\n'), /https:\/\/(www\.)?(rssamp|rssamplifier)\.com/);
});
