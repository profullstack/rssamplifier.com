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
 * Longest article sent for translation, in characters of HTML.
 *
 * This is the request's cost ceiling. A post past it is translated down to
 * this point and marked as truncated rather than refused — most of a long
 * essay in your own language beats none of it, and the original is one click
 * away in the toolbar either way.
 */
export const MAX_ARTICLE_CHARS = 60_000;

/** Below this much text, the summary already is the article. */
export const MIN_ARTICLE_CHARS = 400;

/**
 * Output tokens allowed for a whole translated article.
 *
 * Translated text runs longer than its source in most language pairs, and the
 * markup is reproduced as well as the prose, so this is deliberately well
 * above what MAX_ARTICLE_CHARS would suggest.
 */
const ARTICLE_MAX_TOKENS = 32_000;

const ARTICLE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    content_html: {
      type: 'string',
      description: 'The article body, translated, with its HTML structure preserved.',
    },
    source_language: {
      type: 'string',
      description: 'ISO-639-1 code of the language the source text was in.',
    },
  },
  required: ['title', 'summary', 'content_html', 'source_language'],
  additionalProperties: false,
};

const ARTICLE_SYSTEM = [
  'You translate whole blog posts for a feed reader. The reader sees your',
  'translation in place of the original page, so it has to be the entire post,',
  'not a summary of it.',
  '',
  'The body arrives as HTML and must come back as HTML with the same structure:',
  'same elements, same nesting, same order, same links pointing at the same',
  'URLs. Translate the text between the tags and the human-readable attributes',
  '(alt, title). Do not translate URLs, class names, or code.',
  '',
  'Leave code blocks, command names, file paths, identifiers and product names',
  'exactly as they are — a reader is here to run the commands, not a localised',
  'paraphrase of them. Comments inside a code block are prose and may be',
  'translated; the code around them may not.',
  '',
  'Do not add notes, do not explain the translation, do not add a heading',
  'saying what you did, and do not drop paragraphs to save effort. If the text',
  'is already in the target language, return it unchanged.',
].join('\n');

/**
 * Translate a whole post: its title, its summary and its body.
 *
 * Streamed rather than awaited as one response. A full article at this token
 * ceiling is minutes of generation, and a non-streaming request that long hits
 * the SDK's HTTP timeout and throws away work that was nearly finished.
 *
 * Returns null on anything unusable — a refusal, a truncation, output that
 * does not parse — because a page that renders the original is a working page
 * and an exception here is not.
 *
 * @param {{
 *   title: string,
 *   summary?: string|null,
 *   contentHtml: string,
 *   targetLang: string,
 *   sourceLang?: string|null,
 *   client?: Anthropic,
 * }} input
 * @returns {Promise<{
 *   title: string, summary: string|null, contentHtml: string,
 *   sourceLang: string|null, model: string, truncated: boolean
 * }|null>}
 */
export async function translateArticle(input) {
  const title = String(input.title ?? '').trim();
  const body = String(input.contentHtml ?? '').trim();
  if (!title || !body) return null;

  const client = input.client ?? anthropic();
  if (!client) return null;

  const truncated = body.length > MAX_ARTICLE_CHARS;
  const source = truncated ? body.slice(0, MAX_ARTICLE_CHARS) : body;

  const summary = String(input.summary ?? '')
    .trim()
    .slice(0, MAX_SOURCE_CHARS);

  const known = input.sourceLang
    ? `The source is believed to be in "${input.sourceLang}", but trust the text over that label.`
    : 'The source language is not recorded; work it out from the text.';

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: ARTICLE_MAX_TOKENS,
    system: ARTICLE_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: ARTICLE_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [
          `Target language: ${input.targetLang}`,
          known,
          truncated
            ? 'This is the beginning of a longer post; translate what is here and stop.'
            : '',
          '',
          `<title>\n${title}\n</title>`,
          `<summary>\n${summary}\n</summary>`,
          `<body>\n${source}\n</body>`,
        ].join('\n'),
      },
    ],
  });

  const response = await stream.finalMessage();

  // A refusal and a truncation are both ordinary 200s carrying unusable
  // content, so neither is caught by a try/catch around the call. Truncation
  // matters more here than it does for a title: half a translated article is
  // half an article, and the reader is better served by the original.
  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') return null;

  const text = response.content.find((block) => block.type === 'text')?.text;
  if (!text) return null;

  /** @type {{ title?: unknown, summary?: unknown, content_html?: unknown, source_language?: unknown }} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const translatedTitle = String(parsed.title ?? '').trim();
  const translatedBody = String(parsed.content_html ?? '').trim();
  if (!translatedTitle || !translatedBody) return null;

  const translatedSummary = String(parsed.summary ?? '').trim();

  return {
    title: translatedTitle,
    summary: translatedSummary || null,
    contentHtml: translatedBody,
    sourceLang: parsed.source_language ? String(parsed.source_language) : null,
    model: MODEL,
    truncated,
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
