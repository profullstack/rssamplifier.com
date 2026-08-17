import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reframePage } from '../src/reframe.js';

const SITE = 'https://rssamplifier.com';
const URL = 'https://blog.example.com/posts/a-post.html';
const SELF = `${SITE}/api/frame?u=${encodeURIComponent(URL)}`;

/** @param {string} url */
const through = (url) => `${SITE}/api/frame?u=${encodeURIComponent(url)}`;

/**
 * @param {string} body
 * @param {string} [head]
 * @returns {string}
 */
function page(body, head = '') {
  return `<!doctype html><html><head><title>A Post</title>${head}</head><body>${body}</body></html>`;
}

/**
 * @param {string} html
 * @returns {string}
 */
function reframe(html) {
  return reframePage(html, { url: URL, self: SELF, through, origin: SITE });
}

test('a link to a site that refuses framing is routed back through the reader', () => {
  const out = reframe(page('<a href="https://code.claude.com/docs/en/best-practices">docs</a>'));

  assert.match(
    out,
    /href="https:\/\/rssamplifier\.com\/api\/frame\?u=https%3A%2F%2Fcode\.claude\.com%2Fdocs%2Fen%2Fbest-practices"/,
  );
});

test('a relative link resolves against the page before it is routed', () => {
  const out = reframe(page('<a href="../other.html">other</a>'));

  assert.match(out, /u=https%3A%2F%2Fblog\.example\.com%2Fother\.html/);
});

test('the publisher keeps serving everything except the markup', () => {
  const out = reframe(page('<img src="/hero.jpg">', '<link rel="stylesheet" href="/site.css">'));

  // A <base> is what leaves the relative URLs pointing at the publisher, so
  // the page still renders as theirs rather than as 404s of ours.
  assert.match(out, /<base href="https:\/\/blog\.example\.com\/posts\/a-post\.html">/);
  assert.match(out, /src="\/hero\.jpg"/);
  assert.match(out, /href="\/site\.css"/);
});

test("a page's own base wins, and relative links resolve against it", () => {
  const out = reframePage(
    page('<a href="deep.html">deep</a>', '<base href="https://blog.example.com/wiki/">'),
    { url: URL, self: SELF, through, origin: SITE },
  );

  assert.match(out, /<base href="https:\/\/blog\.example\.com\/wiki\/">/);
  assert.match(out, /u=https%3A%2F%2Fblog\.example\.com%2Fwiki%2Fdeep\.html/);
});

test('an in-page anchor still addresses this document rather than reloading it', () => {
  const out = reframe(page('<a href="#notes">notes</a>'));

  assert.ok(out.includes(`href="${SELF}#notes"`), out);
});

test('a link the author already sent to a new tab is left to open the real site', () => {
  const out = reframe(page('<a href="https://elsewhere.example/x" target="_blank">out</a>'));

  assert.match(out, /href="https:\/\/elsewhere\.example\/x"/);
  assert.doesNotMatch(out, /api\/frame\?u=https%3A%2F%2Felsewhere/);
  assert.match(out, /rel="[^"]*noopener/);
});

test('a framebusting _top link is aimed at the frame, where it works', () => {
  const out = reframe(page('<a href="/home" target="_top">home</a>'));

  assert.match(out, /target="_self"/);
  assert.match(out, /u=https%3A%2F%2Fblog\.example\.com%2Fhome/);
});

test('mailto and tel escape the sandbox instead of dying in it', () => {
  const out = reframe(page('<a href="mailto:hi@example.com">mail</a>'));

  assert.match(out, /href="mailto:hi@example\.com"/);
  assert.match(out, /target="_blank"/);
});

test('javascript: links are the page\'s own business', () => {
  const out = reframe(page('<a href="javascript:openMenu()">menu</a>'));

  assert.match(out, /href="javascript:openMenu\(\)"/);
  assert.doesNotMatch(out, /api\/frame\?u=javascript/);
});

test('a form submits to the publisher, in a tab, not to us', () => {
  const out = reframe(page('<form action="/search"><input name="q"></form>'));

  assert.match(out, /action="https:\/\/blog\.example\.com\/search"/);
  assert.match(out, /target="_blank"/);
});

test('a form with no action still goes somewhere real', () => {
  const out = reframe(page('<form><input name="q"></form>'));

  assert.match(out, /action="https:\/\/blog\.example\.com\/posts\/a-post\.html"/);
});

test('a meta refresh bounces through the reader rather than out of it', () => {
  const out = reframe(page('', '<meta http-equiv="refresh" content="3;url=/moved.html">'));

  assert.match(out, /content="3;url=https:\/\/rssamplifier\.com\/api\/frame\?u=/);
});

test("the publisher's meta CSP is dropped, because it describes a document that no longer exists", () => {
  const out = reframe(
    page('', '<meta http-equiv="content-security-policy" content="script-src \'none\'">'),
  );

  assert.doesNotMatch(out, /content-security-policy/i);
});

test('the frame says where it is, to the reader and to nobody else', () => {
  const out = reframe(page('<p>hi</p>'));

  assert.match(out, /parent\.postMessage/);
  assert.match(out, /"rssamplifier-reader"/);
  assert.ok(out.includes(`"${URL}"`), out);
  assert.ok(out.includes(`,"${SITE}")`), out);
});

test('a page with no head at all gets one', () => {
  const out = reframe('<p><a href="/x">x</a></p>');

  assert.match(out, /<base href="https:\/\/blog\.example\.com\/posts\/a-post\.html">/);
  assert.match(out, /u=https%3A%2F%2Fblog\.example\.com%2Fx/);
});

test('empty input comes back empty rather than as a document', () => {
  assert.equal(reframe(''), '');
});
