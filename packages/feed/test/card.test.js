import test from 'node:test';
import assert from 'node:assert/strict';

import { imageSize } from '../src/imagesize.js';
import {
  cardCandidatesFromPage,
  cardFit,
  findFeedCard,
  probeImage,
} from '../src/card.js';

/**
 * Build a header for each format by hand, so the test states the byte layout it
 * is asserting rather than hiding it in a fixture file.
 */
function png(width, height) {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

function gif(width, height) {
  const b = new Uint8Array(13);
  b.set([...'GIF89a'].map((c) => c.charCodeAt(0)), 0);
  const view = new DataView(b.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return b;
}

/**
 * A JPEG with a decoy segment in front of the frame header, which is the shape
 * that matters: every real JPEG has one, and reading a fixed offset gets it
 * wrong.
 */
function jpeg(width, height, { pad = 4000, marker = 0xc0 } = {}) {
  const b = new Uint8Array(2 + (4 + pad) + 12);
  const view = new DataView(b.buffer);
  b.set([0xff, 0xd8], 0);

  // APP1 (EXIF), length covering its own two bytes plus the padding.
  b.set([0xff, 0xe1], 2);
  view.setUint16(4, pad + 2);

  const at = 2 + 2 + 2 + pad;
  b.set([0xff, marker], at);
  view.setUint16(at + 2, 17); // segment length
  b[at + 4] = 8; // sample precision
  view.setUint16(at + 5, height);
  view.setUint16(at + 7, width);
  return b;
}

test('a PNG states its size in the IHDR chunk', () => {
  assert.deepEqual(imageSize(png(1200, 630)), { type: 'png', width: 1200, height: 630 });
});

test('a GIF states its size little-endian', () => {
  assert.deepEqual(imageSize(gif(48, 48)), { type: 'gif', width: 48, height: 48 });
});

test('a JPEG frame header is found behind a large EXIF segment', () => {
  // The whole reason this walks the segment chain: a fixed offset reads the EXIF
  // block and reports nonsense.
  assert.deepEqual(imageSize(jpeg(1600, 900)), { type: 'jpeg', width: 1600, height: 900 });
  // Progressive JPEGs are SOF2 and just as common as baseline on the web.
  assert.deepEqual(imageSize(jpeg(800, 800, { marker: 0xc2 })), {
    type: 'jpeg',
    width: 800,
    height: 800,
  });
});

test('a Huffman table is not mistaken for a frame header', () => {
  // 0xFFC4 sits in the same 0xFFCn range as the frame markers and carries no
  // dimensions. Read as one it produces a plausible, wrong answer.
  const b = jpeg(1024, 768, { marker: 0xc4 });
  const size = imageSize(b);
  assert.equal(size.type, 'jpeg');
  assert.equal(size.width, 0, 'no frame header found, rather than a wrong one');
});

test('a JPEG whose header is past the probe is a known format of unknown size', () => {
  // What a 200KB EXIF thumbnail does to a 32KB probe. It must not read as "not
  // an image", because that is the answer that would throw the URL away.
  const truncated = jpeg(1600, 900, { pad: 4000 }).subarray(0, 100);
  assert.deepEqual(imageSize(truncated), { type: 'jpeg', width: 0, height: 0 });
  assert.equal(cardFit(imageSize(truncated)), 'none');
});

test('lossy, lossless and extended WebP each state their size differently', () => {
  const build = (chunk, fill) => {
    const b = new Uint8Array(32);
    b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
    b.set([...'WEBP'].map((c) => c.charCodeAt(0)), 8);
    b.set([...chunk].map((c) => c.charCodeAt(0)), 12);
    fill(b, new DataView(b.buffer));
    return b;
  };

  const lossy = build('VP8 ', (b, v) => {
    v.setUint16(26, 640, true);
    v.setUint16(28, 480, true);
  });
  assert.deepEqual(imageSize(lossy), { type: 'webp', width: 640, height: 480 });

  // 14 bits each, width first, both stored one less than the real value.
  const lossless = build('VP8L', (b, v) => v.setUint32(21, (299 << 14) | 199, true));
  assert.deepEqual(imageSize(lossless), { type: 'webp', width: 200, height: 300 });

  const extended = build('VP8X', (b) => {
    b.set([0xcf, 0x04, 0x00], 24); // 1231 + 1
    b.set([0x75, 0x02, 0x00], 27); // 629 + 1
  });
  assert.deepEqual(imageSize(extended), { type: 'webp', width: 1232, height: 630 });
});

test('an ICO reads 0 as 256, and an SVG reads its viewBox', () => {
  const icoBytes = new Uint8Array([0, 0, 1, 0, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(icoBytes), { type: 'ico', width: 256, height: 256 });

  const svgBytes = new TextEncoder().encode(
    '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path/></svg>',
  );
  assert.deepEqual(imageSize(svgBytes), { type: 'svg', width: 512, height: 512 });
});

test('HTML served where an image was promised is not an image', () => {
  // The common failure: a 404 page returned with a 200 and an image content
  // type. Trusting the header would store it as the feed's picture.
  const html = new TextEncoder().encode('<!doctype html><html><head><title>404');
  assert.equal(imageSize(html), null);
  assert.equal(imageSize(new Uint8Array(0)), null);
  assert.equal(imageSize(/** @type {any} */ ('not bytes')), null);
});

test('a card has to be big enough to be worth promising', () => {
  assert.equal(cardFit({ type: 'png', width: 1200, height: 630 }), 'large');
  assert.equal(cardFit({ type: 'png', width: 400, height: 400 }), 'small');
  // A favicon is the case that kept the feed pages without a card at all.
  assert.equal(cardFit({ type: 'png', width: 32, height: 32 }), 'none');
  // Wide enough, not tall enough: a banner cropped to 1.91:1 would be a sliver.
  assert.equal(cardFit({ type: 'png', width: 1200, height: 200 }), 'small');
  assert.equal(cardFit({ type: 'svg', width: 512, height: 512 }), 'none');
  assert.equal(cardFit(null), 'none');
});

test('a page nominates its own picture, in any of the spellings', () => {
  const page = (head) => cardCandidatesFromPage(`<html><head>${head}</head></html>`, 'https://x.example/');

  assert.equal(
    page('<meta property="og:image" content="/card.png">').og,
    'https://x.example/card.png',
    'relative, and resolved against the page',
  );
  assert.equal(
    page('<meta content="https://cdn.x/card.png" name="og:image">').og,
    'https://cdn.x/card.png',
    'reversed attribute order, and name= rather than property=',
  );
  assert.equal(
    page('<meta property="og:image:secure_url" content="https://cdn.x/s.png">' +
      '<meta property="og:image" content="http://cdn.x/i.png">').og,
    'https://cdn.x/s.png',
    'the https-specific tag wins where a site sets both',
  );
  assert.equal(page("<meta name='twitter:image' content='/t.png'>").twitter, 'https://x.example/t.png');
  assert.equal(page('<meta property="og:image" content="javascript:alert(1)">').og, '');
  assert.equal(page('<title>No card here</title>').og, '');
});

test('the probe believes the bytes, not the content type', async () => {
  const fetchBytes = async () => ({
    ok: true,
    status: 200,
    contentType: 'application/octet-stream',
    bytes: png(1200, 630),
    url: 'https://cdn.example/final.png',
  });

  assert.deepEqual(await probeImage('https://cdn.example/card.png', { fetchBytes }), {
    url: 'https://cdn.example/final.png',
    type: 'png',
    width: 1200,
    height: 630,
    fit: 'large',
  });

  const lying = async () => ({
    ok: true,
    status: 200,
    contentType: 'image/png',
    bytes: new TextEncoder().encode('<!doctype html>'),
    url: 'https://cdn.example/oops',
  });
  assert.equal(await probeImage('https://cdn.example/card.png', { fetchBytes: lying }), null);

  const dead = async () => ({ ok: false, status: 404, contentType: '', bytes: new Uint8Array(0), url: '' });
  assert.equal(await probeImage('https://cdn.example/gone.png', { fetchBytes: dead }), null);
  assert.equal(await probeImage('', { fetchBytes }), null);
});

/**
 * @param {Record<string, Uint8Array>} images
 * @param {string} html
 */
function fakeWorld(images, html = '') {
  return {
    fetchPage: async (url) => ({ ok: Boolean(html), status: html ? 200 : 500, body: html, url }),
    fetchBytes: async (url) =>
      images[url]
        ? { ok: true, status: 200, contentType: '', bytes: images[url], url }
        : { ok: false, status: 404, contentType: '', bytes: new Uint8Array(0), url },
  };
}

test("cover art that is only a favicon does not stop the site's card being found", async () => {
  // The common shape in this directory: a feed declares a 32px icon, and the
  // site has a real 1200x630 card sitting in its <head>.
  const world = fakeWorld(
    {
      'https://x.example/icon.png': png(32, 32),
      'https://x.example/card.jpg': jpeg(1200, 630),
    },
    '<meta property="og:image" content="/card.jpg">',
  );

  const found = await findFeedCard(
    { imageUrl: 'https://x.example/icon.png', siteUrl: 'https://x.example/' },
    world,
  );

  assert.equal(found.state, 'ok');
  assert.equal(found.url, 'https://x.example/card.jpg');
  assert.equal(found.source, 'og');
  assert.equal(found.fit, 'large');
  assert.equal(found.width, 1200);
});

test('cover art big enough to be a card is taken without fetching the page', async () => {
  let pageFetches = 0;
  const world = fakeWorld({ 'https://x.example/cover.png': png(1400, 1400) });
  const found = await findFeedCard(
    { imageUrl: 'https://x.example/cover.png', siteUrl: 'https://x.example/' },
    {
      fetchBytes: world.fetchBytes,
      fetchPage: async (url) => {
        pageFetches += 1;
        return { ok: false, status: 500, body: '', url };
      },
    },
  );

  assert.equal(found.fit, 'large');
  assert.equal(found.source, 'cover');
  assert.equal(pageFetches, 1, 'the page is still read once, and its failure does not matter');
});

test('a small picture is still kept, because a listing has no minimum size', async () => {
  const world = fakeWorld({ 'https://x.example/icon.png': png(48, 48) }, '<title>nothing</title>');
  const found = await findFeedCard(
    { imageUrl: 'https://x.example/icon.png', siteUrl: 'https://x.example/' },
    world,
  );

  assert.equal(found.state, 'ok');
  assert.equal(found.fit, 'none', 'not a card…');
  assert.equal(found.url, 'https://x.example/icon.png', '…but still an avatar');
});

test('a publisher with no picture at all is a finding, not an error', async () => {
  const found = await findFeedCard(
    { imageUrl: '', siteUrl: 'https://x.example/' },
    fakeWorld({}, '<title>no card</title>'),
  );
  assert.equal(found.state, 'none', 'so the backfill stops asking');
  assert.equal(found.url, '');

  // Whereas a site that could not be reached, with nothing else to go on, is
  // worth asking again later.
  const failed = await findFeedCard({ imageUrl: '', siteUrl: 'https://x.example/' }, fakeWorld({}));
  assert.equal(failed.state, 'error');
});

test('a feed with neither cover art nor a site is answered without any fetching', async () => {
  let calls = 0;
  const count = async () => {
    calls += 1;
    throw new Error('should not be called');
  };

  const found = await findFeedCard({}, { fetchPage: count, fetchBytes: count });
  assert.equal(found.state, 'none');
  assert.equal(calls, 0);
});
