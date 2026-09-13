import { authors, profiles } from '@rssamplifier/db';

import { db, siteUrl } from './db.js';
import { authorProfile, profileUrl } from './openprofile.js';

/**
 * One author's OpenProfile.md, loaded and built, for every surface that serves
 * it: the .md route, the JSON route, the MCP tools and the edit page.
 *
 * @param {string} slug
 * @returns {Promise<null | {
 *   person: any,
 *   profile: import('@rssamplifier/db').profiles.AuthorProfile|null,
 *   generated: import('@profullstack/openprofile').OpenProfileDoc,
 *   doc: import('@profullstack/openprofile').OpenProfileDoc,
 *   markdown: string,
 *   url: string,
 *   page: string,
 * }>}
 */
export async function loadAuthorProfile(slug) {
  const client = db();
  const person = await authors.authorBySlug(client, slug);
  if (!person) return null;

  const feeds = person.feeds ?? [];
  const feedIds = feeds.map((f) => String(f.id));
  const [profile, topicsByFeed, firstByFeed] = await Promise.all([
    profiles.profileForAuthor(client, String(person.id)),
    profiles.keywordsForFeeds(client, feedIds),
    profiles.firstPublishedAt(client, feedIds),
  ]);

  const base = siteUrl();
  const built = authorProfile({
    person,
    feeds,
    topicsByFeed,
    firstByFeed,
    base,
    overrides: profile?.overrides ?? null,
  });

  return {
    person,
    profile,
    ...built,
    url: profileUrl(base, String(person.slug)),
    page: `${base}/authors/${encodeURIComponent(String(person.slug))}`,
  };
}

/** The headers a served profile carries. */
export const PROFILE_HEADERS = {
  'content-type': 'text/markdown; charset=utf-8',
  'access-control-allow-origin': '*',
  'cache-control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
};
