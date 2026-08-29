/**
 * Where an author can be found, as a row of labelled links.
 *
 * The label is the network's name and the title is the handle, rather than the
 * other way round: a reader scanning a page recognises "Mastodon" faster than
 * "@jane@hachyderm.io", and the handle is still there for anybody who wants to
 * copy it.
 *
 * Every link is `rel="me nofollow"`. `me` because that is what these are — the
 * IndieWeb relation this directory read them out of, carried through so the
 * page is machine-readable in the same vocabulary it consumed. `nofollow`
 * because a directory of 52,000 blogs must not become a way to pass ranking to
 * whatever an author linked.
 */

/** What each network is called, where a bare slug would not say. */
const LABELS = {
  bandcamp: 'Bandcamp',
  bluesky: 'Bluesky',
  buymeacoffee: 'Buy Me a Coffee',
  codeberg: 'Codeberg',
  devto: 'DEV',
  email: 'Email',
  facebook: 'Facebook',
  fediverse: 'Mastodon',
  flickr: 'Flickr',
  github: 'GitHub',
  gitlab: 'GitLab',
  goodreads: 'Goodreads',
  hashnode: 'Hashnode',
  instagram: 'Instagram',
  keybase: 'Keybase',
  kofi: 'Ko-fi',
  linkedin: 'LinkedIn',
  linktree: 'Links page',
  matrix: 'Matrix',
  medium: 'Medium',
  microblog: 'Micro.blog',
  nostr: 'Nostr',
  orcid: 'ORCID',
  patreon: 'Patreon',
  reddit: 'Reddit',
  soundcloud: 'SoundCloud',
  sourcehut: 'SourceHut',
  stackoverflow: 'Stack Overflow',
  substack: 'Substack',
  telegram: 'Telegram',
  threads: 'Threads',
  tiktok: 'TikTok',
  twitch: 'Twitch',
  tumblr: 'Tumblr',
  twitter: 'X',
  website: 'Website',
  xmpp: 'XMPP',
  youtube: 'YouTube',
};

/**
 * The order links are shown in: the ones a person actually answers first.
 *
 * A website and an email are how you reach somebody; a Ko-fi is how you tip
 * them. Anything unlisted sorts after everything listed, alphabetically, so a
 * network added to the extractor tomorrow renders sensibly without a change
 * here.
 */
const ORDER = [
  'website',
  'email',
  'fediverse',
  'bluesky',
  'linktree',
  'github',
  'gitlab',
  'codeberg',
  'sourcehut',
  'linkedin',
  'twitter',
  'nostr',
  'xmpp',
  'youtube',
  'twitch',
  'substack',
  'medium',
  'microblog',
  'devto',
  'hashnode',
  'instagram',
  'threads',
  'tiktok',
  'reddit',
  'telegram',
  'matrix',
  'keybase',
  'soundcloud',
  'bandcamp',
  'flickr',
  'goodreads',
  'stackoverflow',
  'tumblr',
  'orcid',
  'facebook',
  'patreon',
  'kofi',
  'buymeacoffee',
];

/**
 * @param {{
 *   links: Array<{ network: string, url: string, handle: string|null, source: string, verified: boolean }>,
 *   prominent?: boolean,
 * }} props
 *   `prominent` renders full-width tappable rows rather than an inline strip.
 *   The inline strip is right on a feed page, where the author is one fact
 *   among many; on the author's own page the links *are* the page, and a row of
 *   small text is a worse answer than a stack of things to press -- which is
 *   what everybody already understands a links page to look like.
 */
export default function AuthorLinks({ links, prominent = false }) {
  if (!links?.length) return null;

  const sorted = [...links].sort((a, b) => {
    const ai = ORDER.indexOf(a.network);
    const bi = ORDER.indexOf(b.network);
    if (ai !== bi) return (ai < 0 ? ORDER.length : ai) - (bi < 0 ? ORDER.length : bi);
    return a.network.localeCompare(b.network);
  });

  return (
    <nav
      className={prominent ? 'author-links author-links-stack' : 'author-links'}
      aria-label="Where to find them"
    >
      {sorted.map((link) => (
        <a
          key={link.url}
          href={link.url}
          rel="me nofollow noopener"
          // The handle for a reader who wants it, and the provenance for one
          // who wonders why we think this is theirs. A page that says where it
          // got a link is a page you can argue with, which matters when the
          // subject is a real person.
          title={[link.handle, provenance(link)].filter(Boolean).join(' — ')}
          className={link.verified ? 'verified' : undefined}
        >
          <span className="author-link-name">
            {LABELS[link.network] ?? link.network}
            {link.verified && <span aria-label="verified"> ✓</span>}
          </span>
          {/* The handle, shown rather than only in the title attribute, because
              a title is invisible on a touch screen and this is the half of the
              row somebody actually wants to copy. */}
          {prominent && link.handle && <span className="author-link-handle">{link.handle}</span>}
        </a>
      ))}
    </nav>
  );
}

/**
 * How we came to believe a link, in words rather than in the stored slug.
 *
 * @param {{ source: string, verified: boolean }} link
 * @returns {string}
 */
function provenance(link) {
  if (link.verified) return 'links back to their site';

  switch (link.source) {
    case 'rel-me':
      return 'marked rel="me" on their site';
    case 'h-card':
      return 'from their h-card';
    case 'json-ld':
      return 'from their site’s structured data';
    case 'linktree':
      return 'from their links page';
    case 'page-link':
      return 'linked from their site';
    default:
      return 'from their feed';
  }
}
