import { canonicalSite, ringLinks } from '@profullstack/footer';

/**
 * The webring row a member pastes into its own footer: `<< Ring >>`, the same
 * row every Profullstack site carries for its ring, for any ring here.
 *
 * The hrefs come from @profullstack/footer's `ringLinks`, so this snippet and
 * the footer package can never disagree about what a hop URL is. Each hop
 * carries the member's own homepage in `from`, which is what makes "next"
 * mean the site after *this* one. Hops are 302s on this host, so the order of
 * a ring never lives in anybody's HTML.
 *
 * Two variants, both plain HTML that works with no script and survives any
 * CMS that strips <style>:
 *
 *   - `plain`: bare links in a <nav class="webring">, for a site that styles
 *     its own footer. The same markup as the footer package's ring row.
 *   - `styled`: the same links with inline styles: centred, muted, small.
 *
 * Several rings stack, one row each, in the order given: a site can belong to
 * as many rings as it likes.
 */

export const STYLES = /** @type {const} */ (['plain', 'styled']);

/** Shown in a snippet nobody has put their address into yet. */
export const PLACEHOLDER_SITE = 'https://your.site/';

const NAV_STYLE =
  'display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:.6rem;margin:.5rem 0;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
const LINK_STYLE = 'color:inherit;opacity:.72;text-decoration:none';

/**
 * The member site a snippet is for, as the canonical homepage, or null when
 * the input is not a usable address.
 *
 * @param {unknown} input
 * @returns {string|null}
 */
export function embedSite(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  try {
    const site = canonicalSite(raw);
    const host = new URL(site).hostname;
    // A hostname with a dot, and nothing that only works on the author's own machine.
    if (!host.includes('.') || host === 'localhost' || /^[\d.]+$/.test(host)) return null;
    return site;
  } catch {
    return null;
  }
}

/**
 * @param {string} s
 * @returns {string}
 */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One ring's row.
 *
 * @param {{ base: string, ring: { slug: string, title: string }, site?: string|null, style?: string, random?: boolean }} input
 * @returns {string}
 */
export function ringRow({ base, ring, site, style = 'plain', random = false }) {
  const links = ringLinks(site || PLACEHOLDER_SITE, { slug: ring.slug, host: base });
  const name = esc(ring.title);
  const a = style === 'styled' ? ` style="${LINK_STYLE}"` : '';
  const nav = style === 'styled' ? ` style="${NAV_STYLE}"` : '';
  const parts = [
    `  <a href="${links.previous}" rel="prev" title="Previous site"${a}>&lt;&lt;</a>`,
    `  <a href="${links.ring}"${a}>${name}</a>`,
    `  <a href="${links.next}" rel="next" title="Next site"${a}>&gt;&gt;</a>`,
  ];
  if (random) parts.push(`  <a href="${links.random}" title="Random site" aria-label="Random site"${a}>&#x2684;</a>`);
  return [`<nav class="webring" aria-label="${name} webring"${nav}>`, ...parts, '</nav>'].join('\n');
}

/**
 * The whole snippet for one or more rings.
 *
 * @param {{ base: string, rings: Array<{ slug: string, title: string }>, site?: string|null, style?: string, random?: boolean }} input
 * @returns {string}
 */
export function ringEmbed({ base, rings, site, style = 'plain', random = false }) {
  const which = STYLES.includes(/** @type {any} */ (style)) ? style : 'plain';
  const rows = rings.map((ring) => ringRow({ base, ring, site, style: which, random }));
  const comment = `<!-- webring${rings.length > 1 ? 's' : ''} by ${base.replace(/^https?:\/\//, '')} -->`;
  return [comment, ...rows].join('\n');
}

/**
 * Everything the API, CLI and MCP hand back for a snippet: both variants and
 * the links themselves, for a caller that writes its own markup.
 *
 * @param {{ base: string, rings: Array<{ slug: string, title: string }>, site?: string|null, random?: boolean }} input
 */
export function embedDocument({ base, rings, site, random = false }) {
  return {
    site: site || null,
    placeholder: site ? null : PLACEHOLDER_SITE,
    rings: rings.map((ring) => ({
      slug: ring.slug,
      title: ring.title,
      links: ringLinks(site || PLACEHOLDER_SITE, { slug: ring.slug, host: base }),
    })),
    plain: ringEmbed({ base, rings, site, style: 'plain', random }),
    styled: ringEmbed({ base, rings, site, style: 'styled', random }),
  };
}
