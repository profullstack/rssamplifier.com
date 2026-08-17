import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sanitizeHtml, textLength } from '../src/sanitize.js';

test('prose survives intact', () => {
  const html = '<p>Hello <strong>world</strong> and <em>everyone</em>.</p>';
  assert.equal(sanitizeHtml(html), html);
});

test('scripts are removed with their contents, not unwrapped', () => {
  // The distinction that matters: for a <font> the text is content and must be
  // kept; for a <script> the text *is* the program.
  const out = sanitizeHtml('<p>before</p><script>alert(1)</script><p>after</p>');
  assert.ok(!out.includes('alert'), `script body survived: ${out}`);
  assert.ok(out.includes('before') && out.includes('after'));

  for (const tag of ['style', 'iframe', 'object', 'form', 'noscript', 'svg']) {
    const dirty = `<p>keep</p><${tag}>payload</${tag}>`;
    assert.ok(!sanitizeHtml(dirty).includes('payload'), `${tag} body survived`);
  }
});

test('void elements are dropped as tags, not as everything after them', () => {
  // These never close, so "strip with the contents" has no closing tag to find
  // and runs to the end of the document — which quietly deleted the rest of any
  // article containing a <picture>. What has to go is the element; the text
  // after it was never inside it, and a browser parses it the same way.
  for (const tag of ['embed', 'input', 'source', 'track', 'link', 'meta', 'base']) {
    const out = sanitizeHtml(`<p>before</p><${tag} src="x.mp4"><p>after</p>`);
    assert.ok(!out.includes(`<${tag}`), `${tag} tag survived: ${out}`);
    assert.ok(!out.includes('x.mp4'), `${tag} attributes survived: ${out}`);
    assert.ok(out.includes('before') && out.includes('after'), `${tag} ate the article: ${out}`);
  }
});

test('a picture element keeps the article that follows it', () => {
  const html = [
    '<p>The band went into the studio.</p>',
    '<figure><picture><source srcset="hero.avif" type="image/avif">',
    '<img src="https://example.com/hero.jpg" alt="hero"></picture></figure>',
    '<p>They came out with a record.</p>',
  ].join('');

  const out = sanitizeHtml(html);
  assert.ok(out.includes('came out with a record'), out);
  assert.ok(out.includes('https://example.com/hero.jpg'), out);
  assert.ok(!out.includes('<source'), out);
});

test('event handlers are dropped whatever their name', () => {
  const out = sanitizeHtml('<p onclick="steal()" ONMOUSEOVER="x()" onfoo="y()">text</p>');
  assert.equal(out, '<p>text</p>');
});

test('unsafe URL schemes are dropped, including obfuscated ones', () => {
  const cases = [
    '<a href="javascript:alert(1)">x</a>',
    '<a href="JaVaScRiPt:alert(1)">x</a>',
    // Entity- and control-character-encoded schemes are the same URL to a
    // browser, so a check on the literal text is not a check.
    '<a href="java&#115;cript:alert(1)">x</a>',
    '<a href="java\tscript:alert(1)">x</a>',
    '<a href=" javascript:alert(1)">x</a>',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    '<a href="vbscript:msgbox">x</a>',
  ];

  for (const dirty of cases) {
    const out = sanitizeHtml(dirty);
    assert.ok(!/href=/.test(out), `href survived on: ${dirty} -> ${out}`);
    assert.ok(out.includes('x'), 'the link text is still shown');
  }
});

test('safe URLs are kept, and links are marked as leaving the site', () => {
  const out = sanitizeHtml('<a href="https://example.com/post">read</a>');
  assert.ok(out.includes('href="https://example.com/post"'));
  assert.ok(out.includes('rel="noopener noreferrer ugc"'));
  assert.ok(out.includes('target="_blank"'));

  assert.ok(sanitizeHtml('<a href="mailto:a@b.co">mail</a>').includes('href="mailto:a@b.co"'));
  // Relative URLs would resolve against rssamplifier.com, which is not where
  // the article came from.
  assert.ok(!sanitizeHtml('<a href="/local">x</a>').includes('href='));
});

test('images keep their source and alt text but nothing executable', () => {
  const out = sanitizeHtml('<img src="https://x.example/a.png" alt="A cat" onerror="steal()">');
  assert.ok(out.includes('src="https://x.example/a.png"'));
  assert.ok(out.includes('alt="A cat"'));
  assert.ok(!out.includes('onerror'));
  assert.ok(out.includes('loading="lazy"'));
});

test('unknown tags are unwrapped so their text is not lost', () => {
  assert.equal(sanitizeHtml('<font size="7">important words</font>').trim(), 'important words');
});

test('unbalanced markup cannot escape into the surrounding page', () => {
  // An article ending mid-element would otherwise absorb everything the page
  // renders after it.
  const out = sanitizeHtml('<div><p>text');
  assert.ok(out.endsWith('</p></div>'), `expected closers, got: ${out}`);

  // A closing tag with no opener is dropped rather than closing our container.
  assert.equal(sanitizeHtml('</div></section>text').trim(), 'text');
});

test('attribute values are escaped so they cannot break out', () => {
  const out = sanitizeHtml('<p title=\'a" onload="x\'>t</p>');

  // The text "onload=" survives inside the value, and that is fine — what
  // matters is that the quote which would have ended the attribute and started
  // a new one is escaped, so the browser reads one title and no handler.
  assert.ok(out.includes('&quot;'), `quote was not escaped: ${out}`);
  assert.ok(!out.includes('" onload="'), `escaped out of the attribute: ${out}`);
  assert.equal(out, '<p title="a&quot; onload=&quot;x">t</p>');
});

test('comments are removed', () => {
  assert.equal(sanitizeHtml('<p>a</p><!-- <script>x</script> --><p>b</p>'), '<p>a</p><p>b</p>');
});

test('oversized input is truncated rather than rendered whole', () => {
  const huge = `<p>${'x'.repeat(500_000)}</p>`;
  assert.ok(sanitizeHtml(huge, { maxLength: 1000 }).length < 1200);
});

test('textLength counts prose, not markup', () => {
  assert.equal(textLength('<p>one two</p>'), 'one two'.length);
  assert.equal(textLength(''), 0);
});
