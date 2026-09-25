/**
 * What the categories are called, in one place.
 *
 * /blogs and /podcasts are the same page over a different filter, so they share
 * an implementation and differ only in this table — two copies of a directory
 * listing would drift the moment one of them grew a feature.
 *
 * Lives in lib rather than beside the component that started with it because
 * the same vocabulary now names a topic's sub-groups (/topics/physics/blogs),
 * and those are read by route handlers that have no business importing React to
 * find out what a category is called.
 *
 * Three nouns rather than one, because a category names two different things
 * and both get written on a page: `one`/`noun` are the feed (a podcast, four
 * podcasts), `item`/`entry` are what it publishes (episodes, one episode). A
 * search result is an entry, so labelling one "music feed" instead of "track"
 * is the mistake this exists to prevent.
 */
export const CATEGORIES = {
  blog: {
    path: '/blogs',
    heading: 'Blogs',
    noun: 'blogs',
    one: 'blog',
    title: 'Blogs',
    lede: 'Independent writing, newest first. Every blog here has its own page, and the whole category is exportable as OPML.',
    schemaType: 'Blog',
    item: 'posts',
    entry: 'post',
  },
  news: {
    path: '/news',
    heading: 'News',
    noun: 'news sources',
    one: 'news source',
    title: 'News',
    lede: 'Newsrooms rather than people: feeds that publish several articles a day, carry a staff of bylines, or say outright that they are news — two of those three, because any one of them on its own is also a description of somebody’s blog. A blog with a page called News stays under Blogs.',
    schemaType: 'NewsMediaOrganization',
    item: 'articles',
    entry: 'article',
  },
  podcast: {
    path: '/podcasts',
    heading: 'Podcasts',
    noun: 'podcasts',
    one: 'podcast',
    title: 'Podcasts',
    lede: 'Every show with audio in its feed and a publisher who filled in the podcast namespaces. The newest episodes across all of them first — press play on any of them here.',
    schemaType: 'PodcastSeries',
    entrySchemaType: 'PodcastEpisode',
    item: 'episodes',
    entry: 'episode',
    // The category leads with what has just been published rather than with
    // the feeds that published it. Only podcasts for now: it is the category
    // where "what is new" is unarguably the question being asked, and the one
    // whose entries the site can play where they stand. See CategoryIndex.
    river: true,
  },
  music: {
    path: '/music',
    heading: 'Music',
    noun: 'music feeds',
    one: 'music feed',
    title: 'Music',
    lede: 'Albums, playlists, mixes and netlabel releases, newest first — feeds whose entries are the music itself rather than writing about it. A blog that attaches an mp3 is still a blog, so a feed lands here by declaring what it is or by being added to the list.',
    schemaType: 'MusicGroup',
    item: 'tracks',
    entry: 'track',
  },
  video: {
    path: '/videos',
    heading: 'Videos',
    noun: 'video feeds',
    one: 'video feed',
    title: 'Videos',
    lede: 'Channels that publish video, YouTube included. Every YouTube channel has an RSS feed whether or not it advertises one — the box on /submit will build the URL from a channel link.',
    schemaType: 'VideoObject',
    item: 'videos',
    entry: 'video',
  },
  comic: {
    path: '/comics',
    heading: 'Comics',
    noun: 'comics',
    one: 'comic',
    title: 'Comics',
    lede: 'Webcomics that publish a feed. This category is curated rather than detected — a webcomic’s feed is a blog with pictures in it as far as any parser is concerned.',
    schemaType: 'ComicSeries',
    item: 'strips',
    entry: 'strip',
    curated: true,
  },
  live: {
    path: '/lives',
    heading: 'Live',
    noun: 'live channels',
    one: 'live channel',
    title: 'Live',
    lede: 'Channels that stream live — radio stations, television, and everything else going out now rather than published. RSS has no way to say “this is a livestream”, but a playlist does: submit an m3u8 or a station’s pls and it lands here.',
    schemaType: 'BroadcastService',
    item: 'streams',
    entry: 'stream',
  },
  reel: {
    path: '/reels',
    heading: 'Reels',
    noun: 'short-video feeds',
    one: 'short-video feed',
    title: 'Reels',
    lede: 'Short-form video. Nothing on this side of the web publishes RSS for it — TikTok and Instagram publish none at all, and YouTube’s feed does not mark a Short — so this category is curated by hand.',
    schemaType: 'VideoObject',
    item: 'clips',
    entry: 'clip',
    curated: true,
  },
};

/**
 * The path segment each category lives at, mapped back to the kind stored in
 * the database: `podcasts` → `podcast`.
 *
 * Derived rather than written out again, so a category added above gets its
 * feed without anybody remembering to come back here. The rewrite in
 * next.config.mjs lists the same segments and cannot import this — the config
 * is evaluated before the workspace resolves — which is the one duplication
 * left; apps/web/test/subscribe.test.js asserts the two agree.
 */
export const CATEGORY_SEGMENTS = new Map(
  Object.entries(CATEGORIES).map(([kind, meta]) => [meta.path.replace(/^\//, ''), kind]),
);

/**
 * Read `?view=` as one of the two ways to look at a category.
 *
 * 'latest' is what has just been published across the whole category; 'shows'
 * is the directory of who is in it. Only categories that say `river` in the
 * table above offer the first, and for those it is the default — somebody
 * opening /podcasts came for episodes, not for a list of feeds in the order we
 * happened to index them.
 *
 * Anything unrecognised falls back the way a bad `?page=` does, and for the
 * same reason: this is a parameter in a URL people edit, share and guess at,
 * and a directory listing has no business refusing to render over one.
 *
 * @param {unknown} raw
 * @param {{ river?: boolean }} [category]
 * @returns {'latest'|'shows'}
 */
export function viewName(raw, category = {}) {
  if (!category.river) return 'shows';

  // A repeated parameter arrives as an array. Taking the first spelling rather
  // than letting `String(['a','b'])` coerce to "a,b" — which matches nothing
  // and would silently fall back — so `?view=shows&view=shows` means what it
  // plainly says.
  const value = String((Array.isArray(raw) ? raw[0] : raw) ?? '').toLowerCase();
  return value === 'shows' ? 'shows' : 'latest';
}

/**
 * A link to one page of one view of a category.
 *
 * Page 1 of the default view is the bare path, never `?page=1` and never
 * `?view=latest`: the same listing under two URLs is a duplicate-content signal
 * to the crawlers this directory exists for.
 *
 * @param {string} path
 * @param {'latest'|'shows'} view
 * @param {number} page
 * @returns {string}
 */
export function listHref(path, view, page) {
  const params = new URLSearchParams();
  if (view === 'shows') params.set('view', 'shows');
  if (page > 1) params.set('page', String(page));

  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
