import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ERRORS,
  LEGACY_VERSIONS,
  META_VERSION,
  MODERN_VERSIONS,
  checkHeaders,
  decodeHeaderValue,
  era,
  negotiate,
} from '../src/lib/mcp/protocol.js';
import { handle, CAPABILITIES, SERVER_INFO } from '../src/lib/mcp/server.js';
import { TOOLS, describe } from '../src/lib/mcp/tools.js';
import { clip, plainText } from '../src/lib/mcp/text.js';

const MODERN = MODERN_VERSIONS[0];

/**
 * A modern request, with the headers a conforming client would send.
 *
 * @param {string} method
 * @param {object} [params]
 * @returns {{ message: object, ctx: { header: (name: string) => string|null } }}
 */
function modern(method, params = {}) {
  const message = {
    jsonrpc: '2.0',
    id: 1,
    method,
    params: { ...params, _meta: { [META_VERSION]: MODERN } },
  };

  const headers = {
    'mcp-protocol-version': MODERN,
    'mcp-method': method,
    'mcp-name': params.name ?? params.uri ?? null,
  };

  return { message, ctx: { header: (name) => headers[name] ?? null } };
}

/** A legacy client sends none of the mirror headers. */
const noHeaders = { header: () => null };

test('the handshake methods are legacy however they are dressed', () => {
  assert.equal(era({ method: 'initialize' }), 'legacy');
  assert.equal(era({ method: 'notifications/initialized' }), 'legacy');
});

test('a request is modern only when it says so in _meta', () => {
  assert.equal(era({ method: 'tools/list' }), 'legacy');
  assert.equal(era({ method: 'tools/list', params: { _meta: { [META_VERSION]: MODERN } } }), 'modern');
});

test('headers that agree with the body pass', () => {
  const { message, ctx } = modern('tools/call', { name: 'search' });
  assert.equal(checkHeaders(message, ctx.header), null);
});

test('a missing protocol-version header is a mismatch, not a silent pass', () => {
  const { message } = modern('tools/list');
  const bad = checkHeaders(message, () => null);
  assert.equal(bad?.code, ERRORS.HEADER_MISMATCH);
});

test('a tool name in the header that is not the tool in the body is refused', () => {
  const { message } = modern('tools/call', { name: 'search' });
  const header = (name) =>
    ({ 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/call', 'mcp-name': 'submit_feed' })[
      name
    ] ?? null;

  const bad = checkHeaders(message, header);
  assert.equal(bad?.code, ERRORS.HEADER_MISMATCH);
  assert.match(bad.message, /Mcp-Name/);
});

test('a base64-encoded header value is compared decoded', () => {
  const encoded = `=?base64?${Buffer.from('home lab').toString('base64')}?=`;
  assert.equal(decodeHeaderValue(encoded), 'home lab');
  assert.equal(decodeHeaderValue('search'), 'search');
  assert.equal(decodeHeaderValue(null), null);
});

test('a resource read mirrors the uri, not a name', () => {
  const uri = 'https://rssamplifier.com/llms.txt';
  const { message, ctx } = modern('resources/read', { uri });
  assert.equal(checkHeaders(message, ctx.header), null);
});

test('initialize answers the version it was asked for when we speak it', () => {
  for (const version of LEGACY_VERSIONS) assert.equal(negotiate(version), version);
});

test('initialize answers something usable when asked for a version we do not have', () => {
  assert.ok(LEGACY_VERSIONS.includes(negotiate('1999-01-01')));
  assert.ok(LEGACY_VERSIONS.includes(negotiate(undefined)));
});

test('a legacy client gets a handshake without sending a single header', async () => {
  const { status, body } = await handle(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    noHeaders,
  );

  assert.equal(status, 200);
  assert.equal(body.result.protocolVersion, '2025-06-18');
  assert.deepEqual(body.result.capabilities, CAPABILITIES);
  assert.equal(body.result.serverInfo.name, SERVER_INFO.name);
  assert.ok(body.result.instructions.length > 0);
});

test('a modern client gets its capabilities without a handshake', async () => {
  const { message, ctx } = modern('server/discover');
  const { status, body } = await handle(message, ctx);

  assert.equal(status, 200);
  assert.ok(body.result.supportedVersions.includes(MODERN));
  assert.deepEqual(body.result.capabilities, CAPABILITIES);
  assert.equal(body.result._meta['io.modelcontextprotocol/serverInfo'].name, SERVER_INFO.name);
});

test('a version we do not speak is refused with the list we do', async () => {
  const message = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: { _meta: { [META_VERSION]: '2099-01-01' } },
  };
  const header = (name) =>
    ({ 'mcp-protocol-version': '2099-01-01', 'mcp-method': 'tools/list' })[name] ?? null;

  const { status, body } = await handle(message, { header });

  assert.equal(status, 400);
  assert.equal(body.error.code, ERRORS.UNSUPPORTED_VERSION);
  assert.ok(body.error.data.supported.includes(MODERN));
});

test('a notification is acknowledged and answered with nothing', async () => {
  const { status, body } = await handle(
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    noHeaders,
  );

  assert.equal(status, 202);
  assert.equal(body, null);
});

test('an id of null is a request, not a notification', async () => {
  // JSON-RPC distinguishes "no id" from "id: null", and answering the second
  // with 202 would leave a client waiting for a response that never comes.
  const { status, body } = await handle({ jsonrpc: '2.0', id: null, method: 'ping' }, noHeaders);
  assert.equal(status, 200);
  assert.deepEqual(body.result, {});
});

test('an unknown method is a 404 for a modern client and a plain error for a legacy one', async () => {
  const { message, ctx } = modern('tools/nonesuch');
  const modernAnswer = await handle(message, ctx);
  assert.equal(modernAnswer.status, 404);
  assert.equal(modernAnswer.body.error.code, ERRORS.METHOD_NOT_FOUND);

  const legacy = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/nonesuch' }, noHeaders);
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.error.code, ERRORS.METHOD_NOT_FOUND);
});

test('tools/list answers both eras with the same tools', async () => {
  const { message, ctx } = modern('tools/list');
  const fromModern = await handle(message, ctx);
  const fromLegacy = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, noHeaders);

  assert.deepEqual(fromModern.body.result, fromLegacy.body.result);
  assert.equal(fromModern.body.result.tools.length, TOOLS.length);
});

test('calling a tool that does not exist is a tool error, not a transport error', async () => {
  // The distinction matters: a JSON-RPC error is something the client handles
  // and the model never sees, so a model that guessed a tool name would never
  // learn that it guessed.
  const { message, ctx } = modern('tools/call', { name: 'nonesuch', arguments: {} });
  const { status, body } = await handle(message, ctx);

  assert.equal(status, 200);
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /No such tool/);
});

test('resources/read refuses a uri it does not serve', async () => {
  const { message, ctx } = modern('resources/read', { uri: 'https://example.com/nope' });
  const { body } = await handle(message, ctx);
  assert.equal(body.error.code, ERRORS.RESOURCE_NOT_FOUND);
});

test('a body that is not a JSON-RPC object is rejected before anything else', async () => {
  assert.equal((await handle(null, noHeaders)).status, 400);
  assert.equal((await handle([], noHeaders)).status, 400);
  assert.equal((await handle({ jsonrpc: '2.0', id: 1 }, noHeaders)).status, 400);
});

test('every tool is described well enough for a model to choose it', () => {
  const names = new Set();

  for (const tool of TOOLS) {
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `${tool.name} is not a plain snake_case name`);
    assert.ok(!names.has(tool.name), `${tool.name} is defined twice`);
    names.add(tool.name);

    assert.ok(tool.description.length > 60, `${tool.name} needs a real description`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(typeof tool.run, 'function');

    for (const required of tool.inputSchema.required ?? []) {
      assert.ok(
        tool.inputSchema.properties?.[required],
        `${tool.name} requires '${required}' but does not define it`,
      );
    }

    const listed = describe(tool);
    assert.equal(listed.name, tool.name);
    assert.ok(listed.annotations.title);
  }
});

test('exactly one tool writes, and it says so', () => {
  const writers = TOOLS.filter((t) => t.annotations.readOnlyHint === false);
  assert.deepEqual(
    writers.map((t) => t.name),
    ['submit_feed'],
  );
});

test('markup comes out as prose, with the paragraphs still in it', () => {
  const html = '<div><p>First para.</p><p>Second &amp; last.</p><script>ignore()</script></div>';
  assert.equal(plainText(html), 'First para.\n\nSecond & last.');
  assert.equal(plainText(null), '');
});

test('an entity that decodes to an ampersand is not decoded twice', () => {
  assert.equal(plainText('<p>&amp;lt;tag&amp;gt;</p>'), '&lt;tag&gt;');
});

test('a long article is cut on a boundary and says that it was', () => {
  const short = clip('under the limit', 100);
  assert.equal(short.truncated, false);
  assert.equal(short.text, 'under the limit');

  const long = clip(`${'word '.repeat(200)}end`, 100);
  assert.equal(long.truncated, true);
  assert.ok(long.text.length <= 101);
  assert.ok(long.text.endsWith('…'));
  assert.ok(!long.text.includes('wor…'), 'cut mid-word');
});
