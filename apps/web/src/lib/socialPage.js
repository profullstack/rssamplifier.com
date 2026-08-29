import { social } from '@rssamplifier/db';

import { db, siteUrl } from './db.js';
import { feedAlternates } from './subscribe.js';

/**
 * The plumbing shared by every `/r/…` and `/x/…` page.
 *
 * Each of those pages is the *same page* as `/{slug}` — same component, same
 * items, same controls — reached by a different name. So the only work here is
 * turning a canonical ref into the slug that page wants, and writing the
 * metadata that says `/r/programming` rather than `/r-programming` is where
 * this lives.
 *
 * That canonical tag is the substantive half. Both addresses render, because
 * `/{slug}` is the permanent identity of a row and every link already pointing
 * at one has to keep working. Telling crawlers which of the two is the real one
 * is what stops that from being a duplicate-content problem, and what gets
 * `/r/programming` into a search index instead of `/r-programming`.
 */

/**
 * @param {string} ref
 * @returns {Promise<object|null>}
 */
export async function socialFeed(ref) {
  return social.feedBySocialRef(db(), ref);
}

/**
 * Metadata for a social source's page.
 *
 * @param {{ feed: object|null, canonical: string, label: string, network: string }} args
 * @returns {object}
 */
export function socialMetadata({ feed, canonical, label, network }) {
  const url = `${siteUrl()}${canonical}`;

  if (!feed) {
    return {
      title: label,
      description: `${label} is not in the RSS Amplifier directory yet.`,
      alternates: { canonical: url },
      // Nothing to index until somebody adds it. Without this, every mistyped
      // handle on the internet is a thin page inviting a crawler to keep it.
      robots: { index: false, follow: true },
    };
  }

  return {
    title: String(feed.title ?? label),
    description: String(
      feed.description ?? `${label}, mirrored by the RSS Amplifier directory.`,
    ),
    alternates: {
      canonical: url,
      // The same four formats the rewrites serve. No playlists: a timeline and
      // a subreddit carry no enclosures, so announcing an `.m3u` would be
      // advertising an empty file.
      types: feedAlternates(url, String(feed.title ?? label)),
    },
    other: { 'x-social-network': network },
  };
}
