import assert from 'node:assert/strict';
import { test } from 'node:test';

import { probePage } from '../src/frameable.js';

/**
 * A public IP rather than a hostname, so the SSRF guard answers from
 * `net.isIP` and no test in here depends on DNS.
 */
const HOST = '93.184.216.34';

/**
 * Stand in for the network, recording what was asked for.
 *
 * @param {(url: string) => { status?: number, type?: string, body?: string }|Error} answer
 * @returns {{ asked: string[], restore: () => void }}
 */
function network(answer) {
  const saved = globalThis.fetch;
  const asked = [];

  globalThis.fetch = async (url) => {
    const href = String(url);
    asked.push(href);

    const reply = answer(href);
    if (reply instanceof Error) throw reply;

    const status = reply.status ?? 200;
    return new Response(reply.body ?? '', {
      status,
      headers: { 'content-type': reply.type ?? 'text/html' },
    });
  };

  return { asked, restore: () => (globalThis.fetch = saved) };
}

test('an http page is probed over https first, and https is what comes back', async () => {
  // The reader is served over https, so an http URL is unshowable however well
  // the fetch goes: the browser blocks the frame as mixed content before our
  // own CSP is even consulted. Upgrading here is what makes the rest work.
  const net = network(() => ({ status: 200, type: 'text/html', body: '<html></html>' }));

  try {
    const probe = await probePage(`http://${HOST}/post`, { wantHtml: false });

    assert.deepEqual(net.asked, [`https://${HOST}/post`]);
    assert.equal(probe.url, `https://${HOST}/post`);
    assert.equal(probe.frameable, true);
  } finally {
    net.restore();
  }
});

test('a host with no https is asked again over http rather than failing', async () => {
  // The upgrade is a guess, and a wrong guess must cost nothing but the
  // attempt: a genuinely http-only publisher ends up exactly where it was.
  const net = network((url) => {
    if (url.startsWith('https://')) throw new Error('ECONNREFUSED');
    return { status: 200, type: 'text/html' };
  });

  try {
    const probe = await probePage(`http://${HOST}/post`, { wantHtml: false });

    assert.deepEqual(net.asked, [`https://${HOST}/post`, `http://${HOST}/post`]);
    assert.equal(probe.url, `http://${HOST}/post`);
    assert.equal(probe.frameable, true);
  } finally {
    net.restore();
  }
});

test('an https answer that is an error is not preferred to the original', async () => {
  // A 404 over https is not the page: a host can serve TLS on a vhost that
  // knows nothing about this path while the http one serves it fine.
  const net = network((url) => (url.startsWith('https://') ? { status: 404 } : { status: 200 }));

  try {
    const probe = await probePage(`http://${HOST}/post`, { wantHtml: false });

    assert.deepEqual(net.asked, [`https://${HOST}/post`, `http://${HOST}/post`]);
    assert.equal(probe.url, `http://${HOST}/post`);
  } finally {
    net.restore();
  }
});

test('an https page is asked for once, exactly as before', async () => {
  const net = network(() => ({ status: 200 }));

  try {
    await probePage(`https://${HOST}/post`, { wantHtml: false });
    assert.deepEqual(net.asked, [`https://${HOST}/post`]);
  } finally {
    net.restore();
  }
});

test('the content type of a stream survives the probe, so the reader can decline it', async () => {
  // Icecast sends no framing policy at all, so the verdict is "yes" — the
  // caller needs the type to know that yes is the wrong answer here.
  const net = network(() => ({ status: 200, type: 'audio/mpeg' }));

  try {
    const probe = await probePage(`http://${HOST}/stream-128-mp3`, { wantHtml: false });

    assert.equal(probe.frameable, true);
    assert.match(probe.contentType, /^audio\/mpeg/);
    assert.equal(probe.html, null);
  } finally {
    net.restore();
  }
});
