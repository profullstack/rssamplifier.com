import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  OPML_MAX_BYTES,
  isRawOpmlUpload,
  multipartFile,
  rawBodyChunks,
  teeHead,
} from '../src/lib/upload.js';
import { rawInputCollector, RAW_INPUT_LINE_LIMIT } from '../src/lib/submitted.js';

/** Read a whole async iterable of chunks back into one string. */
async function text(chunks) {
  const parts = [];
  for await (const chunk of chunks) {
    parts.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
  }
  return parts.join('');
}

/** A multipart body, built by hand so the test does not depend on FormData. */
function multipart(parts, boundary = 'xxBOUNDARYxx') {
  const body = parts
    .map((p) =>
      p.filename
        ? `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: text/xml\r\n\r\n${p.value}\r\n`
        : `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`,
    )
    .join('');

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: `${body}--${boundary}--\r\n`,
  };
}

test('the ceiling is ten gibibytes, stated in bytes', () => {
  assert.equal(OPML_MAX_BYTES, 10 * 1024 ** 3);
});

test('a raw body is recognised by its content type, and a URL list is not', () => {
  assert.equal(isRawOpmlUpload('application/xml'), true);
  assert.equal(isRawOpmlUpload('text/xml; charset=utf-8'), true);
  assert.equal(isRawOpmlUpload('application/opml+xml'), true);
  assert.equal(isRawOpmlUpload('TEXT/XML'), true);

  // The ones that must keep their existing paths.
  assert.equal(isRawOpmlUpload('application/json'), false);
  assert.equal(isRawOpmlUpload('multipart/form-data; boundary=x'), false);
  assert.equal(isRawOpmlUpload('application/x-www-form-urlencoded'), false);
  assert.equal(isRawOpmlUpload(''), false);
  assert.equal(
    isRawOpmlUpload('text/plain'),
    false,
    'a plain-text URL list must not be read as a catalogue',
  );
});

test('the multipart file is streamed, and its fields arrive after it', async () => {
  const { contentType, body } = multipart([
    { name: 'opml', filename: 'subs.opml', value: '<opml><body><outline xmlUrl="u" /></body></opml>' },
    { name: 'email', value: 'me@example.com' },
  ]);

  const req = new Request('http://x/api/submit', { method: 'POST', body, headers: { 'content-type': contentType } });
  const part = await multipartFile(req, contentType);

  assert.equal(part.name, 'opml');
  assert.equal(part.filename, 'subs.opml');

  // The file has to be drained before the fields resolve — that is the whole
  // shape of the thing, and the browser's field order makes it unavoidable.
  assert.equal(await text(part.chunks), '<opml><body><outline xmlUrl="u" /></body></opml>');
  assert.deepEqual(await part.fields, { email: 'me@example.com' });
});

test('a form submitted with no file chosen still settles instead of hanging', async () => {
  const { contentType, body } = multipart([{ name: 'email', value: 'me@example.com' }]);
  const req = new Request('http://x/api/submit', { method: 'POST', body, headers: { 'content-type': contentType } });

  const part = await multipartFile(req, contentType);

  assert.equal(part.name, null);
  assert.equal(await text(part.chunks), '');
  assert.deepEqual(await part.fields, { email: 'me@example.com' });
});

test('a raw body is handed over as chunks, and a bodiless request as none', async () => {
  const req = new Request('http://x/api/submit', {
    method: 'POST',
    body: '<opml/>',
    headers: { 'content-type': 'application/xml' },
  });
  assert.equal(await text(rawBodyChunks(req)), '<opml/>');

  const empty = new Request('http://x/api/submit', { method: 'POST' });
  assert.equal(await text(rawBodyChunks(empty)), '');
});

test('teeHead passes every chunk through untouched while sampling the head', async () => {
  const seen = [];
  const source = ['one ', 'two ', 'three ', 'four'];

  // Stop after two chunks, the way the collector does once it is full.
  const out = await text(
    teeHead(source, (chunk) => {
      seen.push(chunk);
      return seen.length < 2;
    }),
  );

  assert.equal(out, 'one two three four', 'the stream is not altered by being watched');
  assert.deepEqual(seen, ['one ', 'two '], 'and sampling stops when told to');
});

test('the head collector stops once it has a whole stored copy', () => {
  const head = rawInputCollector();

  let added = 0;
  // Each chunk is 1,000 lines, so the cap is reached partway through.
  while (head.add(`${Array.from({ length: 1_000 }, (_, i) => `line-${i}`).join('\n')}\n`)) {
    added += 1;
    assert.ok(added < 200, 'the collector never said it had enough');
  }

  const value = head.value();
  assert.equal(value.split('\n').length, RAW_INPUT_LINE_LIMIT);
  assert.ok(head.add('ignored') === false, 'a full collector takes nothing more');
  assert.equal(head.value(), value, 'and does not change once full');
});

test('a short upload is kept whole by the collector', () => {
  const head = rawInputCollector();

  assert.equal(head.add('a\nb\n'), true);
  assert.equal(head.add('c'), true);
  assert.equal(head.value(), 'a\nb\nc');
});
