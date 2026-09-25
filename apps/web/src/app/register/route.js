import { siteUrl } from '../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * /register — the sign-up page for people, and a plain refusal for OAuth.
 *
 * `/register` is two things at one address. For a person who typed it, it is
 * the sign-up page under another name, and next.config redirects it to /signup
 * before this file is ever reached.
 *
 * For an MCP client it is something else. A client told to authenticate finds
 * no protected-resource metadata and no authorization-server metadata — both
 * correct, because this server has no auth — and falls back to the default
 * OAuth endpoints, the last of which is POST /register for dynamic client
 * registration. Redirected to /signup, that POST used to end on 200 and a page
 * of HTML, which the client parsed as JSON and reported as "SDK auth failed:
 * Failed to parse JSON" — a puzzle, where "there is no registration here" is
 * the whole truth.
 *
 * So: 404, in the error shape RFC 7591 uses, saying what to do instead.
 */
export async function POST() {
  return json(
    {
      error: 'invalid_request',
      error_description:
        'This server does not register OAuth clients, because it does not authenticate them. Call the MCP endpoint without a token.',
      resource: `${siteUrl()}/mcp`,
    },
    404,
  );
}

/**
 * A GET only reaches this file when the redirect did not apply, which means the
 * request carried a JSON content-type. Answer it the way the redirect would.
 */
export async function GET() {
  return Response.redirect(`${siteUrl()}/signup`, 308);
}

/**
 * @param {object} body
 * @param {number} status
 * @returns {Response}
 */
function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}
