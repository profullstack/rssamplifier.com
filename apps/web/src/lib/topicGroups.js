import { q } from '@rssamplifier/db';
import { topicSlug } from '@rssamplifier/feed';

import { CATEGORIES } from './categories.js';

/**
 * A topic, cut by what kind of thing is covering it.
 *
 * /topics/physics is everything filed under physics, which on a well-covered
 * subject is a few hundred feeds of several different kinds in one list.
 * Someone who wants a physics podcast is reading past the blogs to find them,
 * and someone who wants the writing is reading past the YouTube channels — so
 * each category the topic actually has gets an address of its own, and each of
 * those is a feed you can subscribe to.
 *
 * The segments are the category pages' own names — /topics/physics/blogs sits
 * under /blogs, /topics/physics/videos under /videos — so a reader who has
 * learned one set of URLs has learned both.
 */

/**
 * Read the keyword out of a URL as a topic slug.
 *
 * Normalised rather than trusted: /topics/Home%20Lab and /topics/home-lab are
 * the same request, and normalising here means the second spelling finds the
 * page instead of 404ing on a slug nobody stored. Every route that takes a
 * keyword — the page, its sub-groups, the JSON endpoint, the feeds — uses this
 * one, which is what makes them all the same address.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function slugFromUrl(raw) {
  return topicSlug(decodeURIComponent(String(raw ?? '')));
}

/**
 * The one group that is not a single category.
 *
 * Podcasts and music are filed apart on purpose: a show and a netlabel are not
 * the same thing, and collapsing them would make the podcast category mean
 * "has an mp3 in it". But somebody looking for something to *listen to* on a
 * subject wants both, and asking them to check two pages is asking them to
 * care about a distinction that exists for the directory's sake rather than
 * theirs.
 */
const AUDIO = {
  segment: 'audio',
  kinds: ['podcast', 'music'],
  heading: 'Audio',
  noun: 'audio feeds',
  one: 'audio feed',
  item: 'episodes and tracks',
  schemaType: 'PodcastSeries',
  lede: 'Everything on this topic you can listen to — shows and music together.',
  playlists: true,
  player: true,
  watch: false,
};

/**
 * Categories whose entries are files a player can queue.
 *
 * The playlist formats are only offered on these. An `.m3u` of a topic's blogs
 * is an empty playlist: the query behind it selects rows with an audio
 * enclosure, and writing generally has none. Offering the link anyway would
 * mean advertising a download that turns out to be empty.
 */
export const PLAYABLE_KINDS = new Set(['podcast', 'music', 'live']);

/**
 * Categories the site's own player can play, here, in the browser.
 *
 * Wider than PLAYABLE_KINDS, and the gap is the point. A topic's videos are
 * mostly YouTube and PeerTube — nine in ten under /topics/ai — which the docked
 * player carries as embeds and which no `.m3u` can carry at all: the enclosure
 * behind one is an embed page, and behind the other a download endpoint that
 * 404s once the instance re-encodes. So videos get the ▶ Play link, which
 * works, and not the playlist files, which would be a download advertised as a
 * playlist and delivered as a list of broken URLs.
 */
export const IN_BROWSER_KINDS = new Set([...PLAYABLE_KINDS, 'video', 'reel']);

/** The categories whose playlist is something to watch rather than to hear. */
export const WATCH_KINDS = new Set(['video', 'reel']);

/**
 * Every sub-group a topic can be cut into, in the order they are offered.
 *
 * Audio sits directly after podcasts and music, the two it is made of, so the
 * relationship reads off the row rather than needing to be explained.
 *
 * @type {Array<{
 *   segment: string,
 *   kinds: string[],
 *   heading: string,
 *   noun: string,
 *   one: string,
 *   item: string,
 *   schemaType: string,
 *   lede: string,
 *   playlists: boolean,
 *   player: boolean,
 *   watch: boolean,
 * }>}
 */
export const TOPIC_GROUPS = q.KINDS.flatMap((kind) => {
  const category = CATEGORIES[kind];

  const group = {
    // The category page's path is the segment: /blogs → blogs. Derived rather
    // than written down again, so a category that is ever renamed renames its
    // topic sub-group with it.
    segment: category.path.replace(/^\//, ''),
    kinds: [kind],
    heading: category.heading,
    noun: category.noun,
    one: category.one,
    item: category.item,
    schemaType: category.schemaType,
    lede: category.lede,
    playlists: PLAYABLE_KINDS.has(kind),
    player: IN_BROWSER_KINDS.has(kind),
    watch: WATCH_KINDS.has(kind),
  };

  return kind === 'music' ? [group, AUDIO] : [group];
});

/** @type {Map<string, (typeof TOPIC_GROUPS)[number]>} */
const BY_SEGMENT = new Map(TOPIC_GROUPS.map((group) => [group.segment, group]));

/**
 * The sub-group a URL segment names, or null.
 *
 * Case-insensitive because the rest of the topic URL is: /topics/Home%20Lab
 * finds the same page as /topics/home-lab, and a reader who capitalised one
 * half of a URL they typed should not be told the other half is wrong.
 *
 * @param {unknown} segment
 * @returns {(typeof TOPIC_GROUPS)[number]|null}
 */
export function topicGroup(segment) {
  return BY_SEGMENT.get(String(segment ?? '').toLowerCase()) ?? null;
}

/**
 * How many feeds each sub-group holds, given a topic's per-category counts.
 *
 * Groups with nothing in them are left out rather than reported as zero. A
 * topic page that linked every group would link mostly to pages saying "no
 * comics cover this", which is eight rows of nothing on the majority of
 * topics — and, at forty-odd thousand topics, a great deal of nothing.
 *
 * @param {Record<string, number>} counts per-category counts, from q.topicKindCounts
 * @returns {Array<{ group: (typeof TOPIC_GROUPS)[number], count: number }>}
 */
export function groupsWithFeeds(counts) {
  return TOPIC_GROUPS.map((group) => ({
    group,
    count: group.kinds.reduce((total, kind) => total + (counts[kind] ?? 0), 0),
  })).filter((entry) => entry.count > 0);
}
