import { siteUrl } from '../db.js';
import { llmsTxt } from '../llms.js';
import {
  ERRORS,
  META_SERVER_INFO,
  SUPPORTED_VERSIONS,
  checkHeaders,
  era,
  fail,
  modernVersion,
  negotiate,
  ok,
  rpcError,
  unsupportedVersion,
} from './protocol.js';
import { TOOLS, TOOLS_BY_NAME, describe } from './tools.js';

/**
 * The MCP server: one JSON-RPC message in, one answer out.
 *
 * Stateless by construction. Nothing is remembered between requests, which is
 * what lets the same endpoint serve both eras of the protocol without keeping a
 * session table, and what lets it run on the same web service as the site
 * rather than needing a process of its own.
 */

/** Who this server says it is. Self-reported, and for display only. */
export const SERVER_INFO = {
  name: 'rssamplifier',
  title: 'RSS Amplifier',
  version: '1.0.0',
};

/** What the server offers. Empty objects mean "supported, no options". */
export const CAPABILITIES = {
  tools: {},
  resources: {},
};

/**
 * How to use this server well, in the server's own words.
 *
 * Clients put this in front of the model alongside the tool list, so it is the
 * one place to say the things a tool description cannot: what the directory is,
 * and which tool to reach for first.
 */
export const INSTRUCTIONS = [
  'RSS Amplifier is an open directory of independent blogs, podcasts and other feeds —',
  'the small web rather than the platforms. Anyone may submit a feed and anyone may read',
  'it: no key, no account, no rate card.',
  '',
  'Start with `search` for a subject you can name, or `list_topics` when you want to know',
  'what the directory covers before choosing. `get_topic` lists who writes about something;',
  '`topic_posts` lists what they published. Once you have a post worth reading, `read_post`',
  'returns its full text — the feed slug and guid it needs travel on every post the other',
  'tools return.',
  '',
  'Three things worth knowing. Categories and topics are derived from each feed document on',
  'every crawl, so they describe the feed rather than what its submitter claimed. And the',
  'directory is a crawl of the open web: a feed may be indexed but not yet read, which',
  '`directory_stats` will tell you before you conclude something is missing.',
  '',
  'The third is about trusting what you get back. Every feed carries a `freshness` of',
  'live, dormant, overdue, failing or unread, alongside `lastSuccessAt` (when we last read',
  'the publisher) and `lastPublishedAt` (when the publisher last posted). Those are',
  'different facts and both can mislead alone: about a sixth of the directory is dormant —',
  'read minutes ago, current, and publishing nothing since 2023 — so a recent',
  '`lastSuccessAt` is not evidence that a feed is alive. Prefer `live` when recency',
  'matters, and say so rather than guessing when quoting something `dormant`.',
].join('\n');

/**
 * The one resource this server offers.
 *
 * A directory of tens of thousands of feeds cannot be a resource — an OPML of
 * the whole thing is megabytes, and a client that attaches it has spent its
 * context on a list rather than on any of the writing. llms.txt is the version
 * that fits: the shape of the directory plus its largest feeds, which is what a
 * model needs to decide what to ask for next.
 */
function resources() {
  return [
    {
      // The resource's URI is the document's real address, not a scheme of our
      // own: a client that cannot call the server, or a human reading the
      // transcript, can open it.
      uri: `${siteUrl()}/llms.txt`,
      name: 'llms.txt',
      title: 'The directory, described for language models',
      description:
        'What RSS Amplifier holds, how it is organised, every machine-readable endpoint it serves, and its largest feeds by name.',
      mimeType: 'text/plain',
    },
  ];
}

/**
 * Answer one JSON-RPC message.
 *
 * @param {any} message the parsed body
 * @param {{ header: (name: string) => string|null }} ctx
 * @returns {Promise<{ status: number, body: object|null }>}
 */
export async function handle(message, ctx) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { status: 400, body: fail(null, ERRORS.INVALID_REQUEST, 'Expected a JSON-RPC object') };
  }

  const id = message.id ?? null;
  const method = String(message.method ?? '');
  // A JSON-RPC notification is a message with no id at all, which is not the
  // same as one whose id is null — `'id' in message` is the only check that
  // tells those apart.
  const isNotification = !('id' in message);

  if (!method) {
    return { status: 400, body: fail(id, ERRORS.INVALID_REQUEST, 'Missing method') };
  }

  const modern = era(message) === 'modern';

  if (modern) {
    const bad = checkHeaders(message, ctx.header);
    if (bad) return { status: 400, body: fail(id, bad.code, bad.message) };

    const version = modernVersion(message);
    if ('unsupported' in version) {
      return { status: 400, body: unsupportedVersion(id, version.unsupported) };
    }
  }

  // Notifications are acknowledged and dropped. This server has no state for
  // one to change: `notifications/initialized` announces a handshake we did not
  // need, and `notifications/cancelled` names work that has already finished by
  // the time a separate request could arrive.
  if (isNotification) return { status: 202, body: null };

  try {
    const result = await dispatch(method, message.params ?? {}, ctx, modern);
    if (result === UNKNOWN_METHOD) {
      // 404 is what the current revision asks for, so that a client can tell an
      // unimplemented method from an endpoint that is not an MCP server at all.
      // Older clients read the JSON-RPC error and ignore the status.
      return {
        status: modern ? 404 : 200,
        body: fail(id, ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`),
      };
    }
    return { status: 200, body: ok(id, result) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);

    // A named code means the caller asked for something that is not there, and
    // the message is for them. Anything else is ours to fix — a tool that ran
    // and could not do what was asked answers with isError inside a normal
    // result and never reaches this.
    if (err && typeof err === 'object' && 'rpcCode' in err) {
      return { status: 200, body: fail(id, Number(err.rpcCode), detail) };
    }

    return { status: 200, body: fail(id, ERRORS.INTERNAL, `Internal error: ${detail}`) };
  }
}

/** Sentinel for "no such method", so that a legitimate result of `null` is not one. */
const UNKNOWN_METHOD = Symbol('unknown-method');

/**
 * @param {string} method
 * @param {any} params
 * @param {{ header: (name: string) => string|null }} ctx
 * @param {boolean} modern
 * @returns {Promise<any>}
 */
async function dispatch(method, params, ctx, modern) {
  switch (method) {
    // The modern handshake-less introduction: everything a client would
    // otherwise learn from initialize plus three separate list calls.
    case 'server/discover':
      return {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: CAPABILITIES,
        instructions: INSTRUCTIONS,
        ttlMs: 3_600_000,
        cacheScope: 'public',
        _meta: { [META_SERVER_INFO]: SERVER_INFO },
      };

    // The legacy handshake. Answered with the version the client asked for when
    // we speak it, and with our newest otherwise — a legacy client has no way
    // to ask a second time, so a refusal is a dead end rather than a retry.
    case 'initialize':
      return {
        protocolVersion: negotiate(params?.protocolVersion),
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };

    case 'ping':
      return {};

    case 'tools/list':
      return { tools: TOOLS.map(describe) };

    case 'tools/call':
      return callTool(params, ctx);

    case 'resources/list':
      return { resources: resources() };

    case 'resources/templates/list':
      return { resourceTemplates: [] };

    case 'resources/read':
      return readResource(params);

    // Not advertised in capabilities, because there are none. Answered anyway:
    // several clients call it unconditionally on connect, and an empty list is
    // a truer answer than "no such method".
    case 'prompts/list':
      return { prompts: [] };

    default:
      return UNKNOWN_METHOD;
  }
}

/**
 * Run one tool.
 *
 * A tool that ran and could not do what was asked comes back as a result with
 * `isError: true`, not as a JSON-RPC error. That distinction is the protocol's,
 * and it matters: the model is meant to see "no feed with that slug" and try
 * another slug, which it cannot do if the client treats the answer as a
 * transport failure and never shows it.
 *
 * @param {any} params
 * @param {{ header: (name: string) => string|null }} ctx
 * @returns {Promise<object>}
 */
async function callTool(params, ctx) {
  const name = String(params?.name ?? '');
  const tool = TOOLS_BY_NAME.get(name);

  if (!tool) {
    return text(`No such tool: ${name}. Call tools/list for what this server offers.`, true);
  }

  try {
    return text(JSON.stringify(await tool.run(params?.arguments ?? {}, ctx), null, 2));
  } catch (err) {
    if (err && typeof err === 'object' && 'toolError' in err) {
      return text(String(/** @type {Error} */ (err).message), true);
    }
    throw err;
  }
}

/**
 * @param {any} params
 * @returns {Promise<object>}
 */
async function readResource(params) {
  const uri = String(params?.uri ?? '');
  const resource = resources().find((r) => r.uri === uri);

  if (!resource) throw rpcError(ERRORS.RESOURCE_NOT_FOUND, `Resource not found: ${uri}`);

  return {
    contents: [
      {
        uri: resource.uri,
        mimeType: resource.mimeType,
        text: await llmsTxt(),
      },
    ],
  };
}

/**
 * A tool result carrying one block of text.
 *
 * Text and nothing else, deliberately. `structuredContent` would repeat the
 * same JSON a second time in the same response, doubling what the caller pays
 * to read it, and every client in use renders the text block.
 *
 * @param {string} body
 * @param {boolean} [isError]
 * @returns {object}
 */
function text(body, isError = false) {
  return { content: [{ type: 'text', text: body }], isError };
}

/**
 * Where this server lives, for the documentation page and the discovery file.
 *
 * @returns {string}
 */
export function endpointUrl() {
  return `${siteUrl()}/mcp`;
}
