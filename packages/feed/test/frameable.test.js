import assert from 'node:assert/strict';
import { test } from 'node:test';

import { framingVerdict } from '../src/frameable.js';

const US = 'https://rssamplifier.com';

test('a page with no framing policy is frameable', () => {
  assert.equal(framingVerdict({}, US).frameable, true);
  assert.equal(framingVerdict({ xFrameOptions: null, contentSecurityPolicy: null }, US).frameable, true);
});

test('X-Frame-Options DENY and SAMEORIGIN both block us', () => {
  assert.equal(framingVerdict({ xFrameOptions: 'DENY' }, US).frameable, false);
  // SAMEORIGIN is a refusal here by definition — we are never their origin.
  assert.equal(framingVerdict({ xFrameOptions: 'SAMEORIGIN' }, US).frameable, false);
  assert.equal(framingVerdict({ xFrameOptions: 'sameorigin' }, US).frameable, false);
});

test('obsolete ALLOW-FROM is treated as a refusal rather than a guess', () => {
  const verdict = framingVerdict({ xFrameOptions: 'ALLOW-FROM https://example.com' }, US);
  assert.equal(verdict.frameable, false);
  assert.equal(verdict.reason, 'x-frame-options-allow-from');
});

test("frame-ancestors 'none' and 'self' block, * allows", () => {
  assert.equal(
    framingVerdict({ contentSecurityPolicy: "frame-ancestors 'none'" }, US).frameable,
    false,
  );
  assert.equal(
    framingVerdict({ contentSecurityPolicy: "frame-ancestors 'self'" }, US).frameable,
    false,
  );
  assert.equal(
    framingVerdict({ contentSecurityPolicy: 'frame-ancestors *' }, US).frameable,
    true,
  );
});

test('frame-ancestors naming us allows, naming someone else does not', () => {
  assert.equal(
    framingVerdict({ contentSecurityPolicy: 'frame-ancestors https://rssamplifier.com' }, US)
      .frameable,
    true,
  );
  assert.equal(
    framingVerdict({ contentSecurityPolicy: 'frame-ancestors https://kagi.com' }, US).frameable,
    false,
  );
});

test('a wildcard host covers subdomains but not the bare domain', () => {
  // Per CSP: *.example.com matches www.example.com and not example.com. So a
  // policy naming *.rssamplifier.com does not admit the apex we serve from.
  assert.equal(
    framingVerdict({ contentSecurityPolicy: 'frame-ancestors *.rssamplifier.com' }, US).frameable,
    false,
  );
  assert.equal(
    framingVerdict(
      { contentSecurityPolicy: 'frame-ancestors *.rssamplifier.com' },
      'https://www.rssamplifier.com',
    ).frameable,
    true,
  );
});

test('frame-ancestors wins over a permissive X-Frame-Options', () => {
  // CSP supersedes XFO wherever both are sent, so a page that says "anyone" in
  // the old header and "nobody" in the new one must be read as nobody.
  const verdict = framingVerdict(
    { xFrameOptions: 'ALLOWALL', contentSecurityPolicy: "frame-ancestors 'none'" },
    US,
  );
  assert.equal(verdict.frameable, false);
  assert.equal(verdict.reason, 'csp-frame-ancestors');
});

test('frame-ancestors is found among other directives', () => {
  const csp = "default-src 'self'; frame-ancestors 'none'; img-src *";
  assert.equal(framingVerdict({ contentSecurityPolicy: csp }, US).frameable, false);
});

test('an unrelated CSP does not imply a framing policy', () => {
  // No frame-ancestors directive at all: fall through to XFO, which is absent,
  // so the page is frameable. This is the common case for the small web.
  const csp = "default-src https:; object-src 'none'";
  assert.equal(framingVerdict({ contentSecurityPolicy: csp }, US).frameable, true);
});
