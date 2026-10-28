import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ringLinks } from '@profullstack/footer';

import { PLACEHOLDER_SITE, embedDocument, embedSite, ringEmbed, ringRow } from '../src/lib/ringEmbed.js';

const base = 'https://rssamplifier.com';
const pfs = { slug: 'profullstack', title: 'Profullstack' };

test('hops are measured from the member homepage, the same URLs the footer package makes', () => {
  const site = embedSite('example.org/blog/post?x=1');
  assert.equal(site, 'https://example.org/');
  const html = ringRow({ base, ring: pfs, site });
  const links = ringLinks(site, { slug: 'profullstack', host: base });
  assert.ok(html.includes(`href="${links.previous}"`));
  assert.ok(html.includes(`href="${links.next}"`));
  assert.ok(html.includes(`href="${links.ring}"`));
  assert.match(html, /from=https%3A%2F%2Fexample\.org%2F/);
  assert.match(html, /&lt;&lt;<\/a>/);
  assert.match(html, />Profullstack<\/a>/);
  assert.match(html, /&gt;&gt;<\/a>/);
  assert.doesNotMatch(html, /<script|<img|style=/);
});

test('the styled variant inlines its styles and nothing else changes', () => {
  const plain = ringRow({ base, ring: pfs, site: 'https://a.example/' });
  const styled = ringRow({ base, ring: pfs, site: 'https://a.example/', style: 'styled' });
  assert.match(styled, /<nav class="webring" aria-label="Profullstack webring" style="/);
  assert.equal(styled.replace(/ style="[^"]*"/g, ''), plain);
});

test('several rings stack one row each, in order; random is opt-in', () => {
  const html = ringEmbed({ base, rings: [pfs, { slug: 'small-web', title: 'Small & Web' }], site: 'https://a.example/', random: true });
  const navs = html.match(/<nav /g) ?? [];
  assert.equal(navs.length, 2);
  assert.ok(html.indexOf('profullstack') < html.indexOf('small-web'));
  assert.match(html, /Small &amp; Web/);
  assert.match(html, /\/random\?from=/);
  assert.doesNotMatch(ringEmbed({ base, rings: [pfs], site: 'https://a.example/' }), /random/);
});

test('without a site the snippet says the placeholder, and bad sites are refused', () => {
  const doc = embedDocument({ base, rings: [pfs], site: null });
  assert.equal(doc.placeholder, PLACEHOLDER_SITE);
  assert.match(doc.plain, /your\.site/);
  assert.equal(doc.rings[0].links.ring, 'https://rssamplifier.com/ring/profullstack');
  assert.equal(embedSite(''), null);
  assert.equal(embedSite('localhost:3000'), null);
  assert.equal(embedSite('http://10.0.0.1/'), null);
  assert.equal(embedSite('not a url at all'), null);
});
