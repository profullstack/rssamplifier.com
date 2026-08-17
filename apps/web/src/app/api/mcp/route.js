import { ERRORS, fail } from '../../../lib/mcp/protocol.js';
import { handle } from '../../../lib/mcp/server.js';

export const dynamic = 'force-dynamic';

// read_post fetches and extracts a publisher's page on a cache miss, which is
// the one tool here that can take real time. The rest answer from the database.
export const maxDuration = 60;

/**
 * The MCP endpoint.
 *
 * Reachable at /mcp as well as here: next.config.mjs rewrites the pretty URL to
 * this one when the request looks like MCP traffic, which leaves /mcp free to
 * be a documentation page in a browser. Both addresses work in a client.
 *
 * Deliberately no authentication. Every tool wraps a query the site already
 * answers publicly and anonymously over HTTP, so a key here would protect
 * nothing while turning an open directory into one with a sign-up form.
 */
export async function POST(req) {
  /** @param {string} name */
  const header = (name) => req.headers.get(name);

  let payload;
  try {
    payload = await req.json();
  } catch {
    return respond(400, fail(null, ERRORS.PARSE, 'Invalid JSON'));
  }

  // A batch is not part of the current revision and was removed from the
  // protocol in 2025-06-18, but older clients and hand-written scripts still
  // send one. Answering it costs a loop; refusing it costs somebody an
  // afternoon working out why their first request went nowhere.
  if (Array.isArray(payload)) {
    const answers = await Promise.all(payload.map((message) => handle(message, { header })));
    const bodies = answers.map((a) => a.body).filter(Boolean);
    if (bodies.length === 0) return new Response(null, { status: 202, headers: cors() });
    return respond(200, bodies);
  }

  const { status, body } = await handle(payload, { header });
  if (!body) return new Response(null, { status, headers: cors() });

  return respond(status, body);
}

/**
 * The standalone SSE stream older revisions could open here.
 *
 * Gone from the protocol as of 2026-07-28, and this server never had anything
 * to push down it: with no session there are no server-initiated messages to
 * deliver. 405 is what the spec asks a server without one to say, and clients
 * that ask are expected to carry on over POST.
 */
export async function GET() {
  return respond(405, fail(null, ERRORS.METHOD_NOT_FOUND, 'This MCP endpoint accepts POST only'), {
    allow: 'POST, OPTIONS',
  });
}

/**
 * Session termination, for a server that has no sessions.
 */
export async function DELETE() {
  return respond(405, fail(null, ERRORS.METHOD_NOT_FOUND, 'This MCP server is stateless'), {
    allow: 'POST, OPTIONS',
  });
}

/**
 * CORS preflight, so a browser-based client can reach this at all.
 *
 * The header list is explicit rather than `*` because the protocol's own
 * headers are non-standard: a client that mirrors its method and tool name into
 * Mcp-Method and Mcp-Name gets a preflight, and a preflight that does not name
 * them fails before the real request is ever sent.
 */
export async function OPTIONS() {
  return new Response(null, { status: 204, headers: cors() });
}

/**
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [extra]
 * @returns {Response}
 */
function respond(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...cors(),
      ...extra,
    },
  });
}

/**
 * @returns {Record<string, string>}
 */
function cors() {
  return {
    // Open, like every other endpoint here. The Origin check the transport spec
    // asks for defends a *local* server against DNS rebinding — a page on the
    // web reaching a server on your laptop. Nothing on this one is privileged
    // or private, so the check would cost browser-based agents their access and
    // buy no security at all.
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers':
      'content-type, accept, authorization, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, last-event-id',
    'access-control-expose-headers': 'mcp-protocol-version',
    'access-control-max-age': '86400',
    'cache-control': 'no-store',
  };
}
