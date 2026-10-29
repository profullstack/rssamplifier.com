import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFormGuard } from '@profullstack/contact-form';

import { MAX_PER_WINDOW, TOO_MANY, makeSalesContact } from '../src/lib/salesContact.js';

const guard = createFormGuard({ secret: 'test-secret-not-used-anywhere-else', binding: 'rssamplifier:sales' });

/** A sales form over an in-memory store and transport. */
function harness({ recent = 0 } = {}) {
  const rows = [];
  const mails = [];
  const form = makeSalesContact({
    guard,
    client: () => null,
    store: {
      enquiryCountFrom: async () => recent,
      insertEnquiry: async (_client, row) => void rows.push(row),
    },
    send: async (mail) => {
      mails.push(mail);
      return { ok: true };
    },
  });
  return { form, rows, mails };
}

let ip = 0;
const json = (body) =>
  new Request('http://localhost/api/sales/contact', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${++ip}` },
    body: JSON.stringify(body),
  });

const answers = {
  name: 'Test Person',
  email: 'Test@Example.invalid',
  org: 'Example Lab',
  use_case: 'Pretraining a small model on independent writing, weekly pulls.',
};
const token = () => guard.issue(Date.now() - 10_000);

test('the page gets a token, the honeypot and the corpus questions', async () => {
  const { form } = harness();
  const props = await form.props();
  assert.equal(props.tokenField, 'fg_token');
  assert.ok(props.token);
  assert.equal(props.honeypotField, 'website');
  assert.equal(props.action, '/api/sales/contact');
  assert.deepEqual(
    props.questions.map((q) => q.name),
    ['intro', 'name', 'email', 'org', 'use_case'],
  );
});

test('a POST without a token is answered like success and neither stored nor sent', async () => {
  const { form, rows, mails } = harness();
  const warn = console.warn;
  console.warn = () => {};
  try {
    const res = await form.POST(json(answers));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    console.warn = warn;
  }
  assert.equal(rows.length, 0);
  assert.equal(mails.length, 0);
});

test('a valid enquiry is stored first, then announced', async () => {
  const { form, rows, mails } = harness();
  const res = await form.POST(json({ ...answers, fg_token: await token() }));
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'test@example.invalid');
  assert.equal(rows[0].org, 'Example Lab');
  assert.equal(rows[0].useCase, answers.use_case);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].subject, 'Corpus enquiry: Example Lab');
  assert.equal(mails[0].replyTo, 'test@example.invalid');
  assert.match(mails[0].text, /Stored in dataset_enquiries/);
});

test('a JSON caller may send useCase', async () => {
  const { form, rows } = harness();
  const { use_case, ...rest } = answers;
  const res = await form.POST(json({ ...rest, useCase: use_case, fg_token: await token() }));
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(rows[0].useCase, use_case);
});

test('a use case under ten characters is refused', async () => {
  const { form, rows } = harness();
  const res = await form.POST(json({ ...answers, use_case: 'data', fg_token: await token() }));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    ok: false,
    error: 'What do you want the corpus for? is too short (10 characters at least)',
  });
  assert.equal(rows.length, 0);
});

test('the per-address limit kept in the database still applies', async () => {
  const { form, rows } = harness({ recent: MAX_PER_WINDOW });
  const res = await form.POST(json({ ...answers, fg_token: await token() }));
  assert.equal((await res.json()).error, TOO_MANY);
  assert.equal(rows.length, 0);
});

test('a plain form post is sent back to the form, with a message the page will show', async () => {
  const { form } = harness();
  const body = new URLSearchParams({ ...answers, use_case: 'x', fg_token: await token() });
  const res = await form.POST(
    new Request('http://localhost/api/sales/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '203.0.113.9' },
      body,
    }),
  );
  assert.equal(res.status, 303);
  const location = new URL(res.headers.get('location'), 'http://localhost');
  assert.equal(location.pathname, '/sales');
  assert.equal(location.hash, '#enquire');
  // Codes, never text: the page rebuilds the message from them.
  assert.equal(location.searchParams.get('error'), 'invalid');
  assert.equal(location.searchParams.get('field'), 'use_case');
  assert.equal(
    form.errorMessage(location.searchParams),
    'What do you want the corpus for? is too short (10 characters at least)',
  );
});

test('a crafted ?error= shows the form\'s own wording, never the link\'s text', () => {
  const { form } = harness();
  assert.equal(form.errorMessage({ error: 'Send your password to evil.example' }), form.errorMessage({ error: 'error' }));
  assert.equal(form.errorMessage({ error: 'limited' }), TOO_MANY);
  assert.equal(form.errorMessage({}), null);
});
