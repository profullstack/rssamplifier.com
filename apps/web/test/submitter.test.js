import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EMAIL_REQUIRED,
  emailRequiredBody,
  isInternalToken,
  isPrivateIp,
  resolveSubmitter,
} from '../src/lib/submitter.js';

const anonymous = async () => ({ kind: null, email: null });
const PUBLIC_IP = '203.0.113.9';

test('an anonymous submission without an address is refused with email-required', async () => {
  const res = await resolveSubmitter({ email: '', ip: PUBLIC_IP, caller: anonymous });
  assert.deepEqual(res, { ok: false, error: EMAIL_REQUIRED });
  assert.equal(emailRequiredBody().error, 'email-required');
});

test('an address that is not one is refused the same way', async () => {
  for (const email of ['nope', 'a@b', 'two words@example.com', null, undefined, 42]) {
    const res = await resolveSubmitter({ email, ip: PUBLIC_IP, caller: anonymous });
    assert.equal(res.ok, false, String(email));
  }
});

test('a plausible address is accepted and kept', async () => {
  const res = await resolveSubmitter({ email: '  me@example.com ', ip: PUBLIC_IP, caller: anonymous });
  assert.deepEqual(res, { ok: true, email: 'me@example.com', via: 'form' });
});

test('a signed-in reader falls back to the account address', async () => {
  const caller = async () => ({ kind: 'session', email: 'acct@example.com' });
  assert.deepEqual(await resolveSubmitter({ email: '', ip: PUBLIC_IP, caller }), {
    ok: true,
    email: 'acct@example.com',
    via: 'session',
  });
  // A typed address wins over the account one.
  const typed = await resolveSubmitter({ email: 'other@example.com', ip: PUBLIC_IP, caller });
  assert.equal(typed.email, 'other@example.com');
});

test('an API key is exempt and is not mailed unless it asked', async () => {
  const caller = async () => ({ kind: 'apikey', email: 'owner@example.com' });
  assert.deepEqual(await resolveSubmitter({ ip: PUBLIC_IP, caller }), { ok: true, email: null, via: 'apikey' });
  const asked = await resolveSubmitter({ email: 'ops@example.com', ip: PUBLIC_IP, caller });
  assert.equal(asked.email, 'ops@example.com');
});

test('our own services on a private address are exempt', async () => {
  for (const ip of ['10.200.35.2', '172.18.0.4', '192.168.1.2', '127.0.0.1', '::1', '::ffff:10.0.0.1']) {
    const res = await resolveSubmitter({ ip, caller: anonymous });
    assert.deepEqual(res, { ok: true, email: null, via: 'internal' }, ip);
  }
});

test('the internal token exempts, and only a configured one does', async () => {
  const saved = process.env['SUBMIT_INTERNAL_TOKENS'];
  process.env['SUBMIT_INTERNAL_TOKENS'] = 'old-token-0123456789abcdef, new-token-0123456789abcdef';
  try {
    const ok = await resolveSubmitter({ ip: PUBLIC_IP, token: 'new-token-0123456789abcdef', caller: anonymous });
    assert.equal(ok.ok, true);
    const bad = await resolveSubmitter({ ip: PUBLIC_IP, token: 'guess-0123456789abcdef', caller: anonymous });
    assert.equal(bad.ok, false);
  } finally {
    if (saved === undefined) delete process.env['SUBMIT_INTERNAL_TOKENS'];
    else process.env['SUBMIT_INTERNAL_TOKENS'] = saved;
  }
  // Unset means no token is accepted, never that any is.
  assert.equal(isInternalToken('anything-at-all-long-enough', ''), false);
  assert.equal(isInternalToken('', ''), false);
  // Short tokens are never accepted, even when configured.
  assert.equal(isInternalToken('short', 'short'), false);
});

test('public addresses are not private', () => {
  for (const ip of ['203.0.113.9', '8.8.8.8', '172.32.0.1', '11.0.0.1', '2001:db8::1', '', null]) {
    assert.equal(isPrivateIp(ip), false, String(ip));
  }
});

test('a caller lookup that throws is treated as anonymous', async () => {
  const caller = async () => {
    throw new Error('db down');
  };
  assert.equal((await resolveSubmitter({ ip: PUBLIC_IP, caller })).ok, false);
  assert.equal((await resolveSubmitter({ email: 'me@example.com', ip: PUBLIC_IP, caller })).ok, true);
});
