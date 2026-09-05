import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { paidFetch, x402 } from '../src/paid.js';

test('without X402_PRIVATE_KEY the crawler fetch is the plain fetch', async () => {
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
