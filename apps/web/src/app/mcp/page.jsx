import { LEGACY_VERSIONS, MODERN_VERSIONS } from '../../lib/mcp/protocol.js';
import { TOOLS } from '../../lib/mcp/tools.js';
import { siteUrl } from '../../lib/db.js';
import Toolbar from '../Toolbar.jsx';

export const metadata = {
  title: 'MCP server',
  description:
    'Connect an AI agent to RSS Amplifier over the Model Context Protocol. Search the directory, read posts in full and submit feeds — no key, no account.',
};

// siteUrl() is read at request time on purpose: rendering this page at build
// time would bake whatever SITE_URL the Docker build saw into the one page
// whose entire job is telling people the address to connect to.
export const dynamic = 'force-dynamic';

/**
 * The MCP server, documented for the human wiring it up.
 *
 * The tool table is generated from the same array the server dispatches on, so
 * a tool added without a line here is impossible — and a line here describing a
 * tool that no longer exists is equally impossible.
 *
 * This page and the endpoint share one URL. A browser gets this; a client that
 * sends the protocol's own headers is rewritten to /api/mcp before the
 * filesystem is consulted. See the rewrite in next.config.mjs.
 */
export default function McpPage() {
  const endpoint = `${siteUrl()}/mcp`;

  return (
    <>
      <h1>MCP server</h1>
      <p className="lede">
        RSS Amplifier speaks the Model Context Protocol. Point an agent at{' '}
        <code>{endpoint}</code> and it can search tens of thousands of independent blogs, read any
        post in full, and add feeds of its own. No key, no account, no sign-up.
      </p>

      <h2>Connect</h2>
      <p>
        The transport is Streamable HTTP, so the URL is the whole configuration. In Claude Code:
      </p>
      <pre className="code-block">
        <code>claude mcp add --transport http rssamplifier {endpoint}</code>
      </pre>
      <p>
        In a client configured by file — Claude Desktop, Cursor, Zed and most others read some
        variant of this:
      </p>
      <pre className="code-block">
        <code>{`{
  "mcpServers": {
    "rssamplifier": {
      "type": "http",
      "url": "${endpoint}"
    }
  }
}`}</code>
      </pre>
      <p>
        A client that only speaks stdio can bridge to it with{' '}
        <code>npx mcp-remote {endpoint}</code>.
      </p>

      <h2>Tools</h2>
      <p>
        {TOOLS.length} of them, wrapping the same queries the <a href="/api/feeds">JSON API</a>{' '}
        answers. Everything except <code>submit_feed</code> is a read.
      </p>
      <div className="tool-list">
        {TOOLS.map((tool) => (
          <div className="tool" key={tool.name}>
            <h3>
              <code>{tool.name}</code>
              {tool.annotations.readOnlyHint === false ? <span className="pill">writes</span> : null}
            </h3>
            <p>{tool.description}</p>
            <p className="tool-args">
              {argumentList(tool.inputSchema).length > 0
                ? argumentList(tool.inputSchema).join(' · ')
                : 'No arguments.'}
            </p>
          </div>
        ))}
      </div>

      <h2>Resources</h2>
      <p>
        One: <a href="/llms.txt">llms.txt</a>, the directory described in a single document — what
        it holds, how it is organised, and every endpoint it serves. A client can attach it as
        context instead of spending a tool call working out what to ask for.
      </p>
      <p>
        There is deliberately no resource for the directory itself. It is tens of thousands of
        feeds; an agent that attaches all of them has spent its context on a list rather than on any
        of the writing.
      </p>

      <h2>Try it without a client</h2>
      <p>The endpoint is plain HTTP, so curl is enough to see it work:</p>
      <pre className="code-block">
        <code>{`curl -s ${endpoint} \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -H 'mcp-protocol-version: ${MODERN_VERSIONS[0]}' \\
  -H 'mcp-method: tools/call' \\
  -H 'mcp-name: search' \\
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "search",
      "arguments": { "query": "home lab" },
      "_meta": {
        "io.modelcontextprotocol/protocolVersion": "${MODERN_VERSIONS[0]}"
      }
    }
  }'`}</code>
      </pre>

      <h2>Protocol versions</h2>
      <p>
        The server answers <code>{MODERN_VERSIONS.join(', ')}</code>, which carries its metadata on
        every request and needs no handshake, and the older handshake-based revisions{' '}
        <code>{LEGACY_VERSIONS.join(', ')}</code>. Whichever your client speaks, the same URL works.
      </p>
      <p>
        It is stateless: no session is minted, nothing is remembered between calls, and there is no
        server-initiated stream to hold open. A <code>GET</code> or <code>DELETE</code> here answers{' '}
        <code>405</code> for that reason. The endpoint also answers at{' '}
        <a href="/api/mcp">/api/mcp</a>, alongside the rest of the JSON API.
      </p>

      <h2>Limits</h2>
      <p>
        Reads are unmetered and need no identification, though we would rather you sent a
        user-agent that says who you are. <code>submit_feed</code> shares the submission form&apos;s
        per-IP budget of twenty an hour, so an agent and a browser draw on one allowance rather than
        the agent having a private one.
      </p>
      <p>
        Keyword discovery — the thing behind <a href="/discover">/discover</a> — is not exposed as a
        tool. Every keyword is a credit against a metered search plan, and a tool that quietly
        spends money is the wrong shape for something anyone can connect to. It stays a form a
        person submits.
      </p>

      <Toolbar />
    </>
  );
}

/**
 * An input schema, summarised as the argument line under a tool.
 *
 * Enough to see the shape of a call without reading JSON Schema — the schema
 * itself is one `tools/list` away for anything that needs it.
 *
 * @param {any} schema
 * @returns {string[]}
 */
function argumentList(schema) {
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);

  return Object.entries(properties).map(([name, spec]) => {
    const type = Array.isArray(spec?.enum) ? spec.enum.join('|') : (spec?.type ?? 'any');
    return `${name}: ${type}${required.has(name) ? '' : '?'}`;
  });
}
