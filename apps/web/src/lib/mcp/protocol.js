/**
 * The MCP wire protocol: versions, framing, and the header/body agreement.
 *
 * Everything here is pure — no database, no network — which is what makes the
 * awkward part testable. The awkward part is that MCP has two eras living at
 * once, and a public endpoint has to answer both:
 *
 * - **Legacy** (`2025-11-25` and earlier): the client opens with an
 *   `initialize` request, the server answers with its capabilities, and the
 *   agreed version holds for the rest of the session.
 * - **Modern** (`2026-07-28`): there is no handshake at all. Every request
 *   carries its own protocol version, client identity and capabilities in
 *   `params._meta`, mirrored into HTTP headers so a proxy can route on them
 *   without parsing the body.
 *
 * A stateless server has an easy time of this: with no session to keep, the
 * only real difference is which shape the first message takes and whether the
 * headers have to agree with the body. Both are decided per request, here.
 */

/** Revisions that carry their metadata per request and have no handshake. */
export const MODERN_VERSIONS = ['2026-07-28'];

/**
 * Revisions that open with `initialize`.
 *
 * `2024-11-05` is on the list even though its own transport (HTTP+SSE) is
 * deprecated: a client that reaches this endpoint at all is already speaking
 * Streamable HTTP, and its JSON-RPC methods are the ones below. Refusing it
 * would turn a working client into a broken one to make a point about
 * transports.
 */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** Every revision this server will answer, newest first. */
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

/** What `initialize` falls back to when the client asks for something unknown. */
export const DEFAULT_LEGACY_VERSION = '2025-11-25';

/** The `_meta` key a modern request states its protocol version in. */
export const META_VERSION = 'io.modelcontextprotocol/protocolVersion';

/** The `_meta` key carrying the server's identity in a modern result. */
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

/** JSON-RPC and MCP error codes, by the names the spec gives them. */
export const ERRORS = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  HEADER_MISMATCH: -32020,
  UNSUPPORTED_VERSION: -32022,
  RESOURCE_NOT_FOUND: -32002,
};

/**
 * An error the caller should see with a code of our choosing.
 *
 * @param {number} code
 * @param {string} message
 * @returns {Error & { rpcCode: number }}
 */
export function rpcError(code, message) {
  return Object.assign(new Error(message), { rpcCode: code });
}

/**
 * Methods whose `Mcp-Name` header mirrors a body field, and which field.
 *
 * The header exists so an intermediary can rate-limit or route on "which tool"
 * without reading the body; the server's job is to check the two agree, so that
 * a proxy allowing `search` cannot be made to forward a call to `submit_feed`.
 */
const NAME_SOURCE = {
  'tools/call': (params) => params?.name,
  'prompts/get': (params) => params?.name,
  'resources/read': (params) => params?.uri,
};

/**
 * A JSON-RPC success response.
 *
 * @param {string|number|null} id
 * @param {unknown} result
 * @returns {object}
 */
export function ok(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/**
 * A JSON-RPC error response.
 *
 * @param {string|number|null} id
 * @param {number} code
 * @param {string} message
 * @param {unknown} [data]
 * @returns {object}
 */
export function fail(id, code, message, data) {
  const error = data === undefined ? { code, message } : { code, message, data };
  return { jsonrpc: '2.0', id: id ?? null, error };
}

/**
 * Which era a message belongs to.
 *
 * The handshake methods are legacy by definition. Anything else is modern only
 * if it says so in `_meta` — the absence of that field is how a legacy client's
 * second and subsequent requests identify themselves, since after `initialize`
 * they look exactly like modern ones apart from the missing metadata.
 *
 * @param {any} message
 * @returns {'modern'|'legacy'}
 */
export function era(message) {
  const method = message?.method;
  if (method === 'initialize' || method === 'notifications/initialized') return 'legacy';
  return message?.params?._meta?.[META_VERSION] ? 'modern' : 'legacy';
}

/**
 * Decode a header value that may carry the spec's Base64 sentinel.
 *
 * Tool names and resource URIs are only *encouraged* to be header-safe, so a
 * client that has a name with a space or a non-ASCII character in it sends
 * `=?base64?…?=` instead. Comparing that to the body without decoding would
 * reject every conforming client that has such a name.
 *
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
export function decodeHeaderValue(raw) {
  if (raw === null || raw === undefined) return null;
  const value = String(raw);
  if (!value.startsWith('=?base64?') || !value.endsWith('?=')) return value;
  try {
    return Buffer.from(value.slice(9, -2), 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Check that a modern request's headers say what its body says.
 *
 * Only modern requests are checked. A legacy client sends none of these
 * headers and is not required to, so holding it to them would break every
 * client written before the revision that invented them.
 *
 * @param {any} message the parsed JSON-RPC message
 * @param {(name: string) => string|null} header reads one request header
 * @returns {{ code: number, message: string }|null} the failure, or null
 */
export function checkHeaders(message, header) {
  const stated = message?.params?._meta?.[META_VERSION];

  const version = header('mcp-protocol-version');
  if (!version) {
    return {
      code: ERRORS.HEADER_MISMATCH,
      message: 'Missing MCP-Protocol-Version header',
    };
  }
  if (version !== stated) {
    return {
      code: ERRORS.HEADER_MISMATCH,
      message: `Header mismatch: MCP-Protocol-Version '${version}' does not match body value '${stated}'`,
    };
  }

  const method = header('mcp-method');
  if (!method) {
    return { code: ERRORS.HEADER_MISMATCH, message: 'Missing Mcp-Method header' };
  }
  if (method !== message?.method) {
    return {
      code: ERRORS.HEADER_MISMATCH,
      message: `Header mismatch: Mcp-Method '${method}' does not match body value '${message?.method}'`,
    };
  }

  const source = NAME_SOURCE[String(message?.method)];
  if (source) {
    const expected = source(message?.params);
    const name = decodeHeaderValue(header('mcp-name'));
    if (name === null) {
      return { code: ERRORS.HEADER_MISMATCH, message: 'Missing Mcp-Name header' };
    }
    if (name !== expected) {
      return {
        code: ERRORS.HEADER_MISMATCH,
        message: `Header mismatch: Mcp-Name '${name}' does not match body value '${expected}'`,
      };
    }
  }

  return null;
}

/**
 * The version a modern request asked for, if this server speaks it.
 *
 * @param {any} message
 * @returns {{ version: string }|{ unsupported: string }}
 */
export function modernVersion(message) {
  const requested = String(message?.params?._meta?.[META_VERSION] ?? '');
  if (MODERN_VERSIONS.includes(requested)) return { version: requested };
  return { unsupported: requested };
}

/**
 * The version to answer a legacy `initialize` with.
 *
 * The rule is "the same one back if we speak it, otherwise the newest we do" —
 * an unknown version is answered rather than rejected, because a legacy client
 * has no way to ask again.
 *
 * @param {unknown} requested
 * @returns {string}
 */
export function negotiate(requested) {
  const asked = String(requested ?? '');
  return LEGACY_VERSIONS.includes(asked) ? asked : DEFAULT_LEGACY_VERSION;
}

/**
 * The error a modern client gets when it asks for a version we do not speak.
 *
 * It lists what we do support, which is the whole point: the client picks one
 * off the list and retries rather than giving up.
 *
 * @param {string|number|null} id
 * @param {string} requested
 * @returns {object}
 */
export function unsupportedVersion(id, requested) {
  return fail(id, ERRORS.UNSUPPORTED_VERSION, 'Unsupported protocol version', {
    supported: SUPPORTED_VERSIONS,
    requested,
  });
}
