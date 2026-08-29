import assert from 'node:assert/strict';
import { test } from 'node:test';

import { jsonLdScript } from '../src/lib/jsonld.js';

test('a title cannot close the script element it is embedded in', () => {
  // The exact payload that was live on the home page, from a feed submitted
  // through the public form. `JSON.stringify` alone leaves the `</script>`
  // intact, an HTML parser ends the block there, and the rest runs on our
  // origin.
  const title = 'RSS003</script><script>alert(document.domain)</script>X';
  const out = jsonLdScript({ '@type': 'Blog', name: title });

  assert.ok(!out.includes('</script>'), 'nothing that ends the element survives');
  assert.ok(!out.includes('<'), 'and no bare < at all, so no variant of it does either');
  assert.match(out, /\\u003c\/script\\u003e/, 'it is escaped rather than dropped');
});

test('the escaped output is still the same JSON', () => {
  // The escaping has to be invisible to a consumer or it is not a fix, it is a
  // regression in structured data. `<` inside a JSON string *is* `<`.
  const data = { name: 'a < b & c > d', url: 'https://example.com/?x=1&y=2' };
  assert.deepEqual(JSON.parse(jsonLdScript(data)), data);
});

test('ampersands and angle brackets are escaped even when harmless', () => {
  // Escaping only what is exploitable today is how the next variant gets in.
  const out = jsonLdScript({ name: 'Bell & Bohr <thing>' });
  assert.ok(!out.includes('&'), 'no bare ampersand');
  assert.ok(!out.includes('<') && !out.includes('>'), 'no bare angle brackets');
  assert.equal(JSON.parse(out).name, 'Bell & Bohr <thing>', 'and it still decodes');
});

test('line terminators legal in JSON but not in JavaScript are escaped', () => {
  // U+2028 is a valid character in a JSON string and a statement terminator in
  // JavaScript source, so an unescaped one is a syntax error in the block.
  const data = { name: 'before\u2028after\u2029end' };
  const out = jsonLdScript(data);

  assert.ok(!out.includes('\u2028') && !out.includes('\u2029'), 'raw terminators are gone');
  assert.deepEqual(JSON.parse(out), data, 'and the value is unchanged');
});

test('nested and array values are escaped too, not just the top level', () => {
  // The real payloads are ItemList/Blog trees, so a title three levels down is
  // the normal case rather than the exotic one.
  const out = jsonLdScript({
    '@type': 'ItemList',
    itemListElement: [{ item: { name: '</script><img src=x onerror=alert(1)>' } }],
  });

  assert.ok(!out.includes('</script>'));
  assert.ok(!out.includes('<'));
});

test('no data at all is still valid JSON', () => {
  assert.equal(jsonLdScript(undefined), 'null');
});
