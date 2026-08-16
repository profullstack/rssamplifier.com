import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { magicReturnPath, explainSignInError } from '../src/lib/signInForm.js';

test('the form comes back to the page it was posted from', () => {
  assert.equal(magicReturnPath('/signup'), '/signup');
  assert.equal(magicReturnPath('/login'), '/login');
});

test('a missing declaration falls back to signing in', () => {
  assert.equal(magicReturnPath(undefined), '/login');
  assert.equal(magicReturnPath(null), '/login');
  assert.equal(magicReturnPath(''), '/login');
});

test('surrounding whitespace does not defeat the match', () => {
  assert.equal(magicReturnPath('  /signup  '), '/signup');
});

test('nothing outside the two form pages is ever reflected back', () => {
  // The return value lands in a Location header, so this is the case that
  // matters: an attacker-supplied value must not survive it.
  for (const hostile of [
    'https://evil.example/phish',
    '//evil.example',
    '/account',
    '/signup/../../etc',
    '/signup?next=/x',
    'javascript:alert(1)',
    '/SIGNUP',
    ['/signup'],
    { toString: () => '/signup' },
  ]) {
    assert.equal(magicReturnPath(hostile), '/login');
  }
});

test('each sign-in failure says what to do about it', () => {
  assert.match(explainSignInError('invalid-or-expired'), /expired|used/i);
  assert.match(explainSignInError('invalid-email'), /email address/i);
  assert.match(explainSignInError('email-not-configured'), /passkey/i);
  assert.match(explainSignInError('missing-token'), /incomplete/i);
});

test('an unknown code still produces something a reader can act on', () => {
  const message = explainSignInError('something-new');
  assert.match(message, /try again/i);
  assert.ok(!message.includes('something-new'), 'the raw code is not shown to the reader');
});
