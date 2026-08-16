import assert from 'node:assert/strict';
import { test } from 'node:test';

import { streamSrc, frame } from '../src/lib/sse.js';

const decoder = new TextDecoder();

test('the stream resumes after the last line the page rendered', () => {
  const lines = [
    { at: '2026-08-16T18:00:01.000Z' },
    { at: '2026-08-16T18:00:02.000Z' },
    { at: '2026-08-16T18:00:03.000Z' },
  ];

  // The newest line, not the first — getting this backwards replays the whole
  // visible history underneath itself.
  assert.equal(
    streamSrc('/api/discoveries/abc/stream', lines),
    '/api/discoveries/abc/stream?since=2026-08-16T18%3A00%3A03.000Z',
  );
});

test('a page with no log yet asks for everything', () => {
  assert.equal(streamSrc('/api/submissions/abc/stream', []), '/api/submissions/abc/stream');
  assert.equal(streamSrc('/api/submissions/abc/stream', [{}]), '/api/submissions/abc/stream');
});

test('a frame is one SSE event terminated by a blank line', () => {
  const text = decoder.decode(frame('progress', { percent: 42 }));

  assert.equal(text, 'event: progress\ndata: {"percent":42}\n\n');
  assert.ok(text.endsWith('\n\n'), 'without the blank line the client never dispatches it');
});

test('a payload with newlines cannot break out of its frame', () => {
  // A rejection reason or feed title containing a newline would otherwise end
  // the data field early and corrupt every event after it. JSON escaping is
  // what prevents that, so it is worth an assertion.
  const text = decoder.decode(frame('log', { subject: 'two\nlines' }));

  assert.equal(text.split('\n\n').length, 2, 'exactly one frame');
  assert.ok(text.includes('two\\nlines'), 'the newline is escaped, not literal');
});
