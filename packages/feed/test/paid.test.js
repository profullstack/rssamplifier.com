import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { paidFetch, x402 } from '../src/paid.js';

test('without any x402 key the crawler fetch is the plain fetch', async () => {
  // The test process has no key; a process with one gets the paying client.
  assert.equal(x402, null);

  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`hello ${req.headers['user-agent'] ?? ''}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await paidFetch(`http://127.0.0.1:${server.address().port}/`, { headers: { 'user-agent': 'bot/1' } });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'hello bot/1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a sealed key starts locked: no payment, the 402 comes back, one [alert]', async () => {
  const { sealPayerKey } = await import('@profullstack/x402-client/sealed');
  const { sealed } = await sealPayerKey(`0x${'0'.repeat(63)}1`, 'a long test passphrase');
  const lines = [];
  const orig = console.error;
  console.error = (l) => lines.push(String(l));
  const keep = { ...process.env };
  process.env.X402_SEALED_KEY = sealed;
  process.env.X402_PRIVATE_KEY = `0x${'0'.repeat(63)}2`; // must be ignored while sealed
  process.env.X402_SITE = 'paid.test';
  const server = createServer((req, res) => {
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ x402Version: 2, accepts: [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const mod = await import(`../src/paid.js?sealed=${Date.now()}`);
    assert.equal(mod.x402.kind, 'sealed');
    assert.equal(mod.x402.payer.locked, true);
    const res = await mod.paidFetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(res.status, 402);
    await mod.paidFetch(`http://127.0.0.1:${server.address().port}/again`);
    assert.equal(lines.filter((l) => l.startsWith('[alert] paid.test: operator keys locked')).length, 1);
  } finally {
    console.error = orig;
    process.env = keep;
    await new Promise((resolve) => server.close(resolve));
  }
});
