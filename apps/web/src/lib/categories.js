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
  },
  podcast: {
    path: '/podcasts',
    heading: 'Podcasts',
    noun: 'podcasts',
    one: 'podcast',
    title: 'Podcasts',
    lede: 'Shows with audio in their feed and a publisher who filled in the podcast namespaces, newest first. Episodes play in the reader while you read the show notes.',
    schemaType: 'PodcastSeries',
    item: 'episodes',
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
    curated: true,
  },
};
