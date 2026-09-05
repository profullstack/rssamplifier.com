import { gateway } from '../../lib/crawl-gateway.js';

/**
 * robots.txt.
 *
 * This file used to do the opposite of what most of the web does: it welcomed
 * GPTBot, ClaudeBot and every other AI crawler by name, on purpose, because
 * being the open, machine-readable copy of the independent web is what this
 * directory is for. That is still what it is for. What changed is who pays for
 * it: a Railway log sample put ClaudeBot at 54% of upstream compute and
 * meta-externalagent at another 11%, and neither sends a reader back.
 *
 * So the welcome is now split the way the crawlers' own operators split
 * themselves. Retrieval crawlers — the search half of each pair, OAI-SearchBot,
 * Claude-SearchBot, PerplexityBot, and Googlebot and Bingbot under the wildcard
 * — are named and allowed everywhere a reader may go. Training crawlers — the
 * corpus half, GPTBot, ClaudeBot, CCBot, meta-externalagent, Bytespider,
 * Applebot-Extended — are told `Disallow: /` and pointed at /crawl, where a
 * dollar buys a day of access. The gateway in lib/crawl-gateway.js enforces
 * the same lists at request time, so this file and the 402 never disagree.
 *
 * The structured entry points stay open to everyone, training crawlers
 * included: /llms.txt, /skill.md, /api/feeds, /opml and /mcp are the cheap
 * alternative to crawling every page, which is the whole point of offering
 * them. robots.txt has no way to say that for the training groups — their
 * grammar here is `Disallow: /` plus `Allow: /crawl`, and a longer Allow list
 * would read as an invitation to the crawl it is meant to replace — so those
 * paths are held open by `openPaths` in the gateway instead, and advertised in
 * the comment block below, which every crawler reads before deciding anything.
 *
 * Both lists live in @profullstack/x402-gateway; nothing is typed here twice.
 */
export function GET() {
  const site = gateway.options.siteUrl;

  const body = gateway.robotsTxt({
    disallow: ['/login', '/api/'],
    // Exceptions under /api/, listed so they beat the prefix by being longer.
    allow: ['/api/feeds', '/api/mcp'],
    comments: [
      'People, search engines and the retrieval crawlers behind AI answers',
      'read this directory free. Crawlers that copy it into a training corpus',
      `pay a dollar a day: ${site}/crawl explains how.`,
      '',
      'Structured entry points, open to every crawler and cheaper for you than',
      'crawling every page:',
      `  ${site}/llms.txt`,
      `  ${site}/skill.md  (the short version: what you can do here)`,
      `  ${site}/api/feeds`,
      `  ${site}/opml`,
      `  ${site}/mcp  (Model Context Protocol, if you would rather call than crawl)`,
    ],
  });

  return new Response(body, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
