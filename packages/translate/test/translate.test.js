import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_SOURCE_CHARS, MODEL, translatePost } from '../src/translate.js';

/**
 * A stand-in for the Anthropic client.
 *
 * The point of these tests is the request this module builds and the answers it
 * is willing to trust — neither needs a network, and both are exactly what
 * breaks silently when the model or the SDK moves underneath it.
 *
 * @param {object} reply what messages.create resolves to
 * @returns {{ messages: { create: (params: any) => Promise<any> }, calls: any[] }}
 */
function stub(reply) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        return reply;
      },
    },
  };
}

/**
 * @param {object} body
 * @param {string} [stopReason]
 */
function answered(body, stopReason = 'end_turn') {
  return { stop_reason: stopReason, content: [{ type: 'text', text: JSON.stringify(body) }] };
}

test('a translation comes back parsed, with the language the model detected', async () => {
  const client = stub(
    answered({
      title: 'Configuring the Proxmox UEFI BIOS',
      summary: 'Hello forum! I cannot get into the UEFI settings…',
      source_language: 'de',
    }),
  );

  const result = await translatePost({
    title: 'Proxmox uefibios konfigurieren',
    summary: 'Hallo Forum! Ich verzweifele dabei…',
    targetLang: 'en',
    sourceLang: 'de',
    client: /** @type {any} */ (client),
  });

  assert.equal(result.title, 'Configuring the Proxmox UEFI BIOS');
  assert.match(result.summary, /^Hello forum!/);
  assert.equal(result.sourceLang, 'de');
  assert.equal(result.model, MODEL);
});

test('the request asks the cheap model for schema-constrained JSON', async () => {
  const client = stub(answered({ title: 'T', summary: 'S', source_language: 'de' }));

  await translatePost({
    title: 'Titel',
    summary: 'Zusammenfassung',
    targetLang: 'en',
    client: /** @type {any} */ (client),
  });

  const [params] = client.calls;
  assert.equal(params.model, MODEL);
  assert.equal(params.output_config.format.type, 'json_schema');
  assert.deepEqual(params.output_config.format.schema.required, [
    'title',
    'summary',
    'source_language',
  ]);

  // Haiku 4.5 predates both of these and rejects them; a future edit that adds
  // one for the sake of "quality" would turn every translation into a 400.
  assert.equal(params.output_config.effort, undefined);
  assert.equal(params.thinking, undefined);

  // Both the target and the text have to reach the model, or it is translating
  // in the dark.
  const prompt = params.messages[0].content;
  assert.match(prompt, /Target language: en/);
  assert.match(prompt, /Titel/);
  assert.match(prompt, /Zusammenfassung/);
});

test('an unlabelled source tells the model to work it out rather than assume', async () => {
  const client = stub(answered({ title: 'T', summary: 'S', source_language: 'nl' }));

  await translatePost({ title: 'Titel', targetLang: 'en', client: /** @type {any} */ (client) });

  assert.match(client.calls[0].messages[0].content, /not recorded/);
});

test('an over-long summary is cut rather than billed in full', async () => {
  const client = stub(answered({ title: 'T', summary: 'S', source_language: 'de' }));

  await translatePost({
    title: 'Titel',
    summary: 'x'.repeat(MAX_SOURCE_CHARS * 3),
    targetLang: 'en',
    client: /** @type {any} */ (client),
  });

  const sent = client.calls[0].messages[0].content.match(/<summary>\n([\s\S]*)\n<\/summary>/)[1];
  assert.equal(sent.length, MAX_SOURCE_CHARS);
});

test('a refusal is "show the original", not an exception', async () => {
  const client = stub({ stop_reason: 'refusal', content: [] });

  const result = await translatePost({
    title: 'Titel',
    targetLang: 'en',
    client: /** @type {any} */ (client),
  });

  assert.equal(result, null);
});

test('a truncated answer is discarded rather than half-shown', async () => {
  // The JSON here is well-formed; it is stop_reason that says the model ran out
  // of room, so trusting the parse alone would ship a partial translation.
  const client = stub(answered({ title: 'Half a ti', summary: '', source_language: 'de' }, 'max_tokens'));

  const result = await translatePost({
    title: 'Titel',
    targetLang: 'en',
    client: /** @type {any} */ (client),
  });

  assert.equal(result, null);
});

test('an unparseable answer is discarded', async () => {
  const client = stub({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'sorry, no' }] });

  const result = await translatePost({
    title: 'Titel',
    targetLang: 'en',
    client: /** @type {any} */ (client),
  });

  assert.equal(result, null);
});

test('an empty translated title is discarded — a post needs a heading', async () => {
  const client = stub(answered({ title: '   ', summary: 'S', source_language: 'de' }));

  const result = await translatePost({
    title: 'Titel',
    targetLang: 'en',
    client: /** @type {any} */ (client),
  });

  assert.equal(result, null);
});

test('an empty translated summary is null, not an empty paragraph', async () => {
  const client = stub(answered({ title: 'Title', summary: '', source_language: 'de' }));

  const result = await translatePost({
    title: 'Titel',
    targetLang: 'en',
    client: /** @type {any} */ (client),
  });

  assert.equal(result.summary, null);
});

test('a post with no title never reaches the API', async () => {
  const client = stub(answered({ title: 'T', summary: 'S', source_language: 'de' }));

  assert.equal(
    await translatePost({ title: '  ', targetLang: 'en', client: /** @type {any} */ (client) }),
    null,
  );
  assert.equal(client.calls.length, 0);
});
