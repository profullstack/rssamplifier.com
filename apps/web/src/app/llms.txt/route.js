import { llmsTxt } from '../../lib/llms.js';

export const dynamic = 'force-dynamic';

/**
 * llms.txt — the directory, described for language models.
 *
 * The document itself is built in lib/llms.js, because the MCP server offers
 * the same text as a resource and one of the two copies would eventually be
 * wrong about what the endpoints are.
 */
export async function GET() {
  return new Response(await llmsTxt(), {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=600',
    },
  });
}
