import Anthropic from '@anthropic-ai/sdk';
import { AllProvidersFailedError, ProviderError, getAi } from '@profullstack/ai-providers';

/**
 * Machine translation of one post's title and summary.
 *
 * Deliberately the cheapest model that does this well. Translation is the one
 * task where a small model loses almost nothing — there is no reasoning to do,
 * the source text says exactly what the output should say — and the directory
 * holds 47k feeds, so the per-post cost is the whole design constraint.
 *
 * c0mpute (the peer network, through @profullstack/ai-providers) answers
 * first. The Anthropic call below, with its schema-constrained output, is the
 * paid fallback and runs only when c0mpute fails and a key is set. Any other
 * paid provider the router has (OpenAI, when OPENAI_API_KEY is set) gets the
 * same tagged-text prompt c0mpute does.
 *
 * Everything translated here is a public feed post, which is why it may go to
 * peer nodes at all.
 */

/** The paid fallback's model. @see https://platform.claude.com/docs/en/about-claude/models/overview */
export const MODEL = 'claude-haiku-4-5';

/**
 * Longest article body sent to c0mpute, in characters of HTML.
 *
 * A peer node writes a few tokens a second under load, so 60k characters would
 * be hours. Past this the article is translated down to here and marked
 * truncated, exactly as the paid path does at MAX_ARTICLE_CHARS.
 */
export const MAX_PEER_ARTICLE_CHARS = 8_000;

/** Whole-call ceiling for a c0mpute translation; they run off the request path. */
const PEER_TIMEOUT_MS = 30 * 60_000;

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
 *   ai?: import('@profullstack/ai-providers').AiRouter,
 * }} input
 * @returns {Promise<{ title: string, summary: string|null, sourceLang: string|null, model: string }|null>}
 */
export async function translatePost(input) {
  const title = String(input.title ?? '').trim();
  if (!title) return null;

  const summary = String(input.summary ?? '')
    .trim()
    .slice(0, MAX_SOURCE_CHARS);

  const known = input.sourceLang
    ? `The source is believed to be in "${input.sourceLang}", but trust the text over that label.`
    : 'The source language is not recorded; work it out from the text.';

  const user = [
    `Target language: ${input.targetLang}`,
    known,
    '',
    `<title>\n${title}\n</title>`,
    `<summary>\n${summary}\n</summary>`,
  ].join('\n');

  return route(input, {
    feature: 'translate-post',
    paid: (client) => postViaAnthropic(client, user),
    request: {
      system: `${SYSTEM}\n\n${TAGGED_ANSWER}`,
      user,
      maxTokens: 2000,
      temperature: 0.2,
      timeoutMs: PEER_TIMEOUT_MS,
    },
    read: (text) => {
      const parsed = readTagged(text, ['title', 'summary', 'source_language']);
      return parsed && finishPost(fixSourceLanguage(parsed, input));
    },
  });
}

/**
 * The paid tier: Anthropic with structured outputs.
 *
 * @param {Anthropic} client
 * @param {string} user
 */
async function postViaAnthropic(client, user) {
  const response = await client.messages.create({
    model: MODEL,
    // Title plus a capped summary — a few thousand characters of output at
    // most. Deliberately small rather than the usual default.
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    messages: [{ role: 'user', content: user }],
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

  const result = finishPost(parsed);
  return result && { ...result, model: MODEL };
}

/**
 * @param {{ title?: unknown, summary?: unknown, source_language?: unknown }} parsed
 */
function finishPost(parsed) {
  const translatedTitle = String(parsed.title ?? '').trim();
  if (!translatedTitle) return null;

  const translatedSummary = String(parsed.summary ?? '').trim();

  return {
    title: translatedTitle,
    summary: translatedSummary || null,
    sourceLang: parsed.source_language ? String(parsed.source_language).trim() : null,
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
 *   ai?: import('@profullstack/ai-providers').AiRouter,
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

  const truncated = body.length > MAX_ARTICLE_CHARS;
  const source = truncated ? body.slice(0, MAX_ARTICLE_CHARS) : body;

  const summary = String(input.summary ?? '')
    .trim()
    .slice(0, MAX_SOURCE_CHARS);

  const known = input.sourceLang
    ? `The source is believed to be in "${input.sourceLang}", but trust the text over that label.`
    : 'The source language is not recorded; work it out from the text.';

  const prompt = (/** @type {string} */ body, /** @type {boolean} */ cut) =>
    [
      `Target language: ${input.targetLang}`,
      known,
      cut ? 'This is the beginning of a longer post; translate what is here and stop.' : '',
      '',
      `<title>\n${title}\n</title>`,
      `<summary>\n${summary}\n</summary>`,
      `<body>\n${body}\n</body>`,
    ].join('\n');

  // The peer network gets less of a long post than the paid model would: it is
  // a few tokens a second, and a translation nobody waits for is no use.
  const peerCut = body.length > MAX_PEER_ARTICLE_CHARS;
  const peerSource = peerCut ? cutHtml(body, MAX_PEER_ARTICLE_CHARS) : body;

  return route(input, {
    feature: 'translate-article',
    paid: (client) => articleViaAnthropic(client, prompt(source, truncated), truncated),
    request: {
      system: `${ARTICLE_SYSTEM}\n\n${TAGGED_ARTICLE_ANSWER}`,
      user: prompt(peerSource, peerCut),
      maxTokens: 8000,
      temperature: 0.2,
      timeoutMs: PEER_TIMEOUT_MS,
    },
    read: (text) => {
      const parsed = readTagged(text, ['title', 'summary', 'source_language', 'body']);
      if (!parsed) return null;
      const result = finishArticle({ ...fixSourceLanguage(parsed, input), content_html: parsed.body });
      return result && { ...result, truncated: peerCut };
    },
  });
}

/**
 * The paid tier: Anthropic, streamed, with structured outputs.
 *
 * Streamed rather than awaited as one response. A full article at this token
 * ceiling is minutes of generation, and a non-streaming request that long hits
 * the SDK's HTTP timeout and throws away work that was nearly finished.
 *
 * @param {Anthropic} client
 * @param {string} user
 * @param {boolean} truncated
 */
async function articleViaAnthropic(client, user, truncated) {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: ARTICLE_MAX_TOKENS,
    system: ARTICLE_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: ARTICLE_SCHEMA } },
    messages: [{ role: 'user', content: user }],
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

  const result = finishArticle(parsed);
  return result && { ...result, model: MODEL, truncated };
}

/**
 * @param {{ title?: unknown, summary?: unknown, content_html?: unknown, source_language?: unknown }} parsed
 */
function finishArticle(parsed) {
  const translatedTitle = String(parsed.title ?? '').trim();
  const translatedBody = String(parsed.content_html ?? '').trim();
  if (!translatedTitle || !translatedBody) return null;

  const translatedSummary = String(parsed.summary ?? '').trim();

  return {
    title: translatedTitle,
    summary: translatedSummary || null,
    contentHtml: translatedBody,
    sourceLang: parsed.source_language ? String(parsed.source_language).trim() : null,
  };
}

/**
 * The answer format for c0mpute and any non-Anthropic fallback. Tags rather
 * than JSON: a 9B model escapes a page of HTML into a JSON string badly, and
 * it copies the tags the input already arrives in very reliably.
 */
const TAGGED_ANSWER = [
  'Answer in exactly this format and nothing else:',
  '<title>the translated title</title>',
  '<summary>the translated summary</summary>',
  '<source_language>ISO-639-1 code of the source text</source_language>',
].join('\n');

const TAGGED_ARTICLE_ANSWER = [
  TAGGED_ANSWER,
  '<body>the translated body HTML</body>',
].join('\n');

/**
 * Reads `<tag>...</tag>` fields out of a model answer. `body` is read last and
 * greedily, so markup inside it cannot end it early; the short fields are read
 * from the text before it. Null if any field is missing.
 *
 * @param {string} text
 * @param {string[]} fields
 * @returns {Record<string, string>|null}
 */
export function readTagged(text, fields) {
  let rest = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  /** @type {Record<string, string>} */
  const out = {};
  if (fields.includes('body')) {
    const open = rest.indexOf('<body>');
    const close = rest.lastIndexOf('</body>');
    if (open < 0 || close < open) return null;
    out.body = rest.slice(open + 6, close).trim();
    rest = rest.slice(0, open);
  }
  for (const field of fields) {
    if (field === 'body') continue;
    const m = new RegExp(`<${field}>([\\s\\S]*?)</${field}>`, 'i').exec(rest);
    if (!m) return null;
    out[field] = m[1].trim();
  }
  return out;
}

/**
 * A small model often reports the language it wrote in (the target) as the
 * source. When it names the target, trust the feed's declared language
 * instead, or record none: "translated from English into English" is wrong
 * either way.
 *
 * @param {Record<string, string>} parsed
 * @param {{ targetLang: string, sourceLang?: string|null }} input
 */
export function fixSourceLanguage(parsed, input) {
  const base = (/** @type {unknown} */ v) => String(v ?? '').trim().toLowerCase().split(/[-_]/)[0];
  if (parsed.source_language && base(parsed.source_language) === base(input.targetLang)) {
    return { ...parsed, source_language: input.sourceLang ? String(input.sourceLang) : '' };
  }
  return parsed;
}

/**
 * Cuts HTML at a paragraph-ish boundary at or before `max` characters, so the
 * model is not handed half a tag.
 *
 * @param {string} html
 * @param {number} max
 */
function cutHtml(html, max) {
  const head = html.slice(0, max);
  const at = Math.max(head.lastIndexOf('</p>'), head.lastIndexOf('</li>'), head.lastIndexOf('</pre>'));
  if (at > max / 2) return head.slice(0, head.indexOf('>', at) + 1);
  const tag = head.lastIndexOf('<');
  return tag > head.lastIndexOf('>') ? head.slice(0, tag) : head;
}

/**
 * Runs one translation through the provider chain: c0mpute first (streamed,
 * over the package's provider.stream), then the paid fallbacks. The Anthropic
 * slot runs this module's own SDK call.
 *
 * A test (or a caller) that passes `client` without `ai` gets that client and
 * nothing else, which is how the request shape is unit-tested.
 *
 * Null when every provider failed or answered unusably: a translation is an
 * enhancement and its absence is never an error page.
 *
 * @template T
 * @param {{ client?: any, ai?: any }} input
 * @param {{
 *   feature: string,
 *   paid: (client: Anthropic) => Promise<T|null>,
 *   request: object,
 *   read: (text: string) => T|null,
 * }} job
 * @returns {Promise<(T & { model: string })|null>}
 */
async function route(input, job) {
  if (input.client && !input.ai) return /** @type {any} */ (job.paid(input.client));

  const router = input.ai ?? getAi();
  try {
    const { value } = await router.run(
      async (/** @type {any} */ provider) => {
        if (provider.name === 'anthropic') {
          const client = input.client ?? anthropic();
          if (!client) throw new ProviderError('anthropic', 'no API key', { kind: 'billing' });
          const answer = await job.paid(client);
          if (!answer) throw new ProviderError('anthropic', 'refused or unusable answer', { kind: 'output' });
          return answer;
        }
        const out =
          typeof provider.stream === 'function'
            ? await provider.stream(job.request, () => {})
            : await provider.generate(job.request);
        const answer = job.read(out.text);
        if (!answer) throw new ProviderError(provider.name, 'answer was not in the tagged format', { kind: 'output' });
        return { ...answer, model: `${provider.name}:${out.model}` };
      },
      { feature: job.feature },
    );
    return value;
  } catch (err) {
    if (err instanceof AllProvidersFailedError) {
      console.warn(`[translate] ${job.feature}: ${err.message}`);
      return null;
    }
    throw err;
  }
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
