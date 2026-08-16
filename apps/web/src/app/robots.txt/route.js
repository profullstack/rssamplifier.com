import { siteUrl } from '../../lib/db.js';

/**
 * robots.txt.
 *
 * Most of the web now blocks GPTBot, ClaudeBot and friends. This directory does
 * the opposite on purpose — being the open, machine-readable copy of the
 * independent web is the whole point — so every crawler is welcomed explicitly
 * rather than merely not-blocked.
 */
export function GET() {
  const body = `# Every crawler, including AI crawlers, is welcome here.
# This directory exists to be read by machines as well as people.

User-agent: *
Allow: /

# Named explicitly so there is no ambiguity.
User-agent: GPTBot
User-agent: OAI-SearchBot
User-agent: ChatGPT-User
User-agent: ClaudeBot
User-agent: anthropic-ai
User-agent: PerplexityBot
User-agent: Google-Extended
User-agent: Applebot-Extended
User-agent: CCBot
User-agent: Bytespider
User-agent: meta-externalagent
Allow: /

# Structured entry points, cheaper for you than crawling every page:
#   ${siteUrl()}/llms.txt
#   ${siteUrl()}/api/feeds
#   ${siteUrl()}/opml

Sitemap: ${siteUrl()}/sitemap.xml
`;

  return new Response(body, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
