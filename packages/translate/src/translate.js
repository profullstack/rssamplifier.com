import Anthropic from '@anthropic-ai/sdk';

/**
 * Machine translation of one post's title and summary.
 *
 * Deliberately the cheapest model that does this well. Translation is the one
 * task where a small model loses almost nothing — there is no reasoning to do,
 * the source text says exactly what the output should say — and the directory
 * holds 47k feeds, so the per-post cost is the whole design constraint.
 */

/** @see https://platform.claude.com/docs/en/about-claude/models/overview */
export const MODEL = 'claude-haiku-4-5';

/**
 * Longest source text sent for translation.
 *
 * A feed summary is a teaser, not an article, but a badly-behaved feed can put
 * a whole post in there. Cutting at a fixed length bounds what one click can
 * cost; the reader still has the original site a link away.
 */
export const MAX_SOURCE_CHARS = 4000;

/**
 * Shape the model must answer in. Structured outputs enforce this at the API,
 * so there is no "sometimes it wraps the JSON in prose" case to defend against.
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    source_language: {
      type: 'string',
      description: 'ISO-639-1 code of the language the source text was in.',
    },
  },
  required: ['title', 'summary', 'source_language'],
  additionalProperties: false,
};

const SYSTEM = [
  'You translate short blog and forum posts for a feed reader.',
  '',
  'Translate the title and summary into the target language. Keep the register and',
  'line breaks of the original. Leave code, command names, file paths, product names',
  'and URLs exactly as they are — a reader is here to follow the instructions, not a',
  'localised paraphrase of them. Do not add notes, do not explain the translation,',
  'and do not summarise: translate what is there and nothing else.',
  '',
  'If the text is already in the target language, return it unchanged.',
  'If the summary is empty, return an empty summary.',
].join('\n');

/**
 * Translate one post.
 *
 * Returns null rather than throwing when the model declines or answers
 * unusably: a translation is an enhancement to a page that already works, and
 * it should never be the reason the page does not render.
 *
 * @param {{
 *   title: string,
 *   summary?: string|null,
 *   targetLang: string,
 *   sourceLang?: string|null,
 *   client?: Anthropic,
 * }} input
 * @returns {Promise<{ title: string, summary: string|null, sourceLang: string|null, model: string }|null>}
 */
export async function translatePost(input) {
  const title = String(input.title ?? '').trim();
  if (!title) return null;

  const client = input.client ?? anthropic();
  if (!client) return null;

  const summary = String(input.summary ?? '')
    .trim()
    .slice(0, MAX_SOURCE_CHARS);

  const known = input.sourceLang
    ? `The source is believed to be in "${input.sourceLang}", but trust the text over that label.`
    : 'The source language is not recorded; work it out from the text.';

  const response = await client.messages.create({
    model: MODEL,
    // Title plus a capped summary — a few thousand characters of output at
    // most. Deliberately small rather than the usual default.
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [
          `Target language: ${input.targetLang}`,
          known,
          '',
          `<title>\n${title}\n</title>`,
          `<summary>\n${summary}\n</summary>`,
        ].join('\n'),
      },
    ],
  });

  // A refusal and a truncation both come back as an ordinary 200 with unusable
  // content, so neither can be left to the try/catch around the call.
  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') return null;

  const text = response.content.find((block) => block.type === 'text')?.text;
  if (!text) return null;

  /** @type {{ title?: unknown, summary?: unknown, source_language?: unknown }} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const translatedTitle = String(parsed.title ?? '').trim();
  if (!translatedTitle) return null;

  const translatedSummary = String(parsed.summary ?? '').trim();

  return {
    title: translatedTitle,
    summary: translatedSummary || null,
    sourceLang: parsed.source_language ? String(parsed.source_language) : null,
    model: MODEL,
  };
}

/**
 * A client, or null when the deployment has no key.
 *
 * The key is read through a non-literal property access: Next inlines
 * `process.env.FOO` at build time, which would bake the build machine's value
 * into the image and ignore whatever Railway injects at runtime — the same
 * reason packages/db reads its Turso credentials this way.
 *
 * @returns {Anthropic|null}
 */
function anthropic() {
  const key = process.env['ANTHROPIC_API_KEY'];
  if (!key) return null;
  return new Anthropic({ apiKey: key });
}
