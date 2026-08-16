import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isBlockedAddress } from '../src/fetch.js';
import { normalizeUrl, findFeedLinks, looksLikeFeed } from '../src/discover.js';
import { slugify, uniqueSlug, isReserved } from '../src/slug.js';

test('blocks private, loopback and metadata addresses', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '0.0.0.0',
    '100.64.0.1', // CGNAT
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:10.0.0.1', // IPv4-mapped private
  ]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} must be blocked`);
  }
});

test('allows ordinary public addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2606:4700::1111']) {
    assert.equal(isBlockedAddress(ip), false, `${ip} must be allowed`);
  }
});

test('refuses unparseable addresses rather than defaulting to allow', () => {
  assert.equal(isBlockedAddress('not-an-ip'), true);
  assert.equal(isBlockedAddress(''), true);
});

test('normalizeUrl adds a scheme but rejects dangerous ones', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeUrl('  https://x.example/feed  '), 'https://x.example/feed');
  assert.equal(normalizeUrl('//example.com'), 'https://example.com/');

  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('file:///etc/passwd'), null);
  assert.equal(normalizeUrl('mailto:a@b.com'), null);
  assert.equal(normalizeUrl('localhost'), null, 'no dot means not a public hostname');
  assert.equal(normalizeUrl(''), null);
});

test('findFeedLinks reads alternate links regardless of attribute order', () => {
  const html = `
    <link rel="alternate" type="application/rss+xml" href="/feed.xml">
    <link href="/atom.xml" type="application/atom+xml" rel="alternate">
    <link rel="stylesheet" type="text/css" href="/style.css">
    <link rel="alternate" type="text/html" href="/other">
  `;
  const found = findFeedLinks(html, 'https://example.com/blog/');
  assert.deepEqual(found, ['https://example.com/feed.xml', 'https://example.com/atom.xml']);
});

test('looksLikeFeed sniffs the body when the content type lies', () => {
  assert.equal(looksLikeFeed('text/html', '<?xml version="1.0"?><rss version="2.0">'), true);
  assert.equal(looksLikeFeed('text/plain', '<feed xmlns="http://www.w3.org/2005/Atom">'), true);
  assert.equal(looksLikeFeed('text/html', '<html><body>a blog</body></html>'), false);
  assert.equal(
    looksLikeFeed('application/json', '{"hello":1}'),
    false,
    'plain JSON is not a JSON Feed',
  );
});

test('slugify produces clean ascii slugs', () => {
  assert.equal(slugify('Chovy’s Blog!'), 'chovys-blog');
  assert.equal(slugify('Café Grande'), 'cafe-grande');
  assert.equal(slugify('  multiple   spaces  '), 'multiple-spaces');
  assert.equal(slugify('!!!'), '');
});

test('uniqueSlug avoids reserved routes and collisions', () => {
  assert.equal(isReserved('api'), true);
  assert.equal(uniqueSlug('API'), 'api-2', 'reserved route is stepped over');

  const taken = new Set(['my-blog', 'my-blog-2']);
  assert.equal(uniqueSlug('My Blog', '', (s) => taken.has(s)), 'my-blog-3');
});

test('uniqueSlug falls back to the hostname when the title is unusable', () => {
  assert.equal(uniqueSlug('!!!', 'https://www.example.com/feed'), 'example-com');
  assert.equal(uniqueSlug('', ''), 'feed');
});
