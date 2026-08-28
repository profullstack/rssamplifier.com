import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { hintToRestore } from '../src/lib/session-hint.js';

/**
 * The signed-in hint, and putting it back.
 *
 * The masthead hides "Sign up" from a readable cookie rather than from the
 * session, so that the directory's pages can stay static. The failure this
 * covers is the gap between the two: a session that outlived its hint showed a
 * signed-in reader a link inviting them to sign up, for as long as the session
 * lasts — thirty days — with nothing on the site ever looking again.
 */

/**
 * A stand-in for the request the proxy is handed, carrying only what is read.
 *
 * @param {Record<string, string>} cookies
 * @param {Record<string, string>} [headers]
 */
function request(cookies, headers = {}) {
  return {
    cookies: {
      get: (name) => (name in cookies ? { value: cookies[name] } : undefined),
    },
    headers: { get: (name) => headers[name] ?? null },
    nextUrl: { protocol: 'https:' },
  };
}

test('a session with no hint gets one back', () => {
  const options = hintToRestore(request({ rsa_session: 'a-token' }));

  assert.ok(options, 'restored on the next request, rather than on the next sign-in');
  assert.equal(options.httpOnly, false, 'the masthead reads it from a script');
  assert.equal(options.maxAge, 2592000, 'it expires with the session it describes');
  assert.equal(options.path, '/');
  assert.equal(options.sameSite, 'lax');
});

test('a signed-out visitor is never given one', () => {
  // The hint is what hides "Sign up". Handing it to somebody with no session
  // would hide the one link they came for.
  assert.equal(hintToRestore(request({})), null);
  assert.equal(hintToRestore(request({ some_other: 'cookie' })), null);
});

test('a hint that is already there is left alone', () => {
  assert.equal(hintToRestore(request({ rsa_session: 'a-token', signed_in: '1' })), null);
});

test('an emptied cookie counts as gone, not as told', () => {
  // Cleared cookies arrive as empty strings rather than not at all, which is
  // the state sign-out leaves behind — and an empty session must not be read as
  // somebody being signed in.
  assert.ok(hintToRestore(request({ rsa_session: 'a-token', signed_in: '' })));
  assert.ok(hintToRestore(request({ rsa_session: 'a-token', signed_in: '0' })));
  assert.equal(hintToRestore(request({ rsa_session: '', signed_in: '' })), null);
});

test('Secure follows the scheme the reader is actually on', () => {
  // Marked Secure over http and the browser drops it: the repair would appear
  // to do nothing, forever, and only on a developer's machine.
  assert.equal(hintToRestore(request({ rsa_session: 't' })).secure, true, 'https by default');

  assert.equal(
    hintToRestore(request({ rsa_session: 't' }, { 'x-forwarded-proto': 'http' })).secure,
    false,
  );

  // Railway's proxy sends a list when a request has been through more than one
  // hop; the first entry is the scheme the reader used.
  assert.equal(
    hintToRestore(request({ rsa_session: 't' }, { 'x-forwarded-proto': 'https, http' })).secure,
    true,
  );
});

/**
 * The matcher, read out of proxy.js itself.
 *
 * Next parses that `config` at build time and rejects a matcher it cannot read
 * off the page, so the pattern has to be a literal there and cannot be imported
 * from lib. Reading the file is what keeps this test honest: a second copy here
 * would go on passing after the real one was edited.
 */
function proxySource() {
  return readFileSync(fileURLToPath(new URL('../src/proxy.js', import.meta.url)), 'utf8');
}

function matcherFromSource() {
  const [, literal] = proxySource().match(/matcher: \[\s*'((?:[^'\\]|\\.)*)'/) ?? [];
  assert.ok(literal, 'proxy.js still exports a config.matcher as a single-quoted literal');

  // The file holds the *source* of the string, so the escapes are still text.
  return JSON.parse(`"${literal.replace(/"/g, '\\"')}"`);
}

/** The masthead predicate, likewise read back rather than copied. */
function mastheadFromSource() {
  const [, literal] = proxySource().match(/const WANTS_MASTHEAD\s*=\s*\/([\s\S]*?)\/;/) ?? [];
  assert.ok(literal, 'proxy.js still declares WANTS_MASTHEAD as a regex literal');
  return new RegExp(literal);
}

test('the matcher covers everything the throttle has to see', () => {
  // Widened when the crawl throttle moved in: the load is on the API, the feed
  // files and the framing proxy, and a limiter that cannot see them is a
  // limiter over the cheap half of the site.
  const pattern = matcherFromSource();
  const matches = (path) => new RegExp(`^${pattern}$`).test(path);

  assert.ok(matches('/'), 'a page is looked at');
  assert.ok(matches('/some-blog/read'), 'the most expensive route in the app');
  assert.ok(matches('/api/frame'), 'and the second most expensive');
  assert.ok(matches('/api/search'));
  assert.ok(matches('/topics/physics.rss'), 'a feed costs the same to serve as a page');
  assert.ok(matches('/topics/jazz/audio.m3u'));

  assert.ok(!matches('/_next/static/chunks/main.js'), 'a chunk never reaches the app');
  assert.ok(!matches('/icons/favicon-32.png'), 'and an icon is not worth a strike');
  assert.ok(!matches('/sw.js'));
  assert.ok(!matches('/manifest.webmanifest'));
  assert.ok(!matches('/robots.txt'), 'the file that invites them is never rationed');
});

test('the masthead repair still skips what has no masthead to fix', () => {
  // Unchanged from when this was the matcher: widening the surface above must
  // not start writing cookies onto feeds and API answers.
  const wants = mastheadFromSource();

  assert.ok(wants.test('/'), 'a page is looked at');
  assert.ok(wants.test('/account'));
  assert.ok(wants.test('/some-blog/read'));
  assert.ok(wants.test('/search'));

  assert.ok(!wants.test('/api/search'), 'an API answers machines, which have no nav');
  assert.ok(!wants.test('/_next/static/chunks/main.js'), 'and a chunk is not a page');
  assert.ok(!wants.test('/auth/magic'), 'sign-in sets both cookies itself a moment later');
  assert.ok(!wants.test('/logo.png'));
  assert.ok(!wants.test('/robots.txt'));
  assert.ok(!wants.test('/topics/physics.rss'), 'a feed is subscribed to, not read in a browser');
});
