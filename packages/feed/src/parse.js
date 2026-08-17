import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  trimValues: true,
  // Feed elements are frequently namespaced (dc:creator, content:encoded).
  // Keeping the prefix and reading both forms is more reliable than stripping.
  removeNSPrefix: false,
});

/**
 * Coerce fast-xml-parser output to a plain string.
 *
 * The parser returns a string for `<title>x</title>`, but an object shaped
 * `{ '#text': 'x' }` when the element also carries attributes, and a number for
 * purely numeric text. All three appear in the wild.
 *
 * @param {unknown} v
 * @returns {string}
 */
function text(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object') return text(v['#text'] ?? v['@href'] ?? '');
  return '';
}

/**
 * Always return an array, whether the parser gave us none, one, or many.
 *
 * @param {unknown} v
 * @returns {unknown[]}
 */
function arr(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * What a feed is, judged by what it carries.
 *
 * Four categories rather than two, because "has audio attached" and "is a
 * podcast" are not the same claim: a netlabel publishing tracks and a show
 * publishing episodes both attach mp3s, and filing the first under podcasts
 * makes the category mean nothing. Video is its own thing again, and on this
 * web it is mostly YouTube channel feeds.
 */
export const KIND_BLOG = 'blog';
export const KIND_PODCAST = 'podcast';
export const KIND_MUSIC = 'music';
export const KIND_VIDEO = 'video';

/** An enclosure or attachment that carries audio, whatever else it says. */
const AUDIO_TYPE = /^audio\//i;

/** …and one that carries video. */
const VIDEO_TYPE = /^video\//i;

/**
 * What `<podcast:medium>` says a feed is, for the values that answer outright.
 *
 * Podcasting 2.0 added the tag so a publisher can state the one thing no amount
 * of parsing can infer: an album and a talk show attach the same mp3s, and only
 * the publisher knows which one they made. `music` is an album; the `L` suffix
 * is that medium as a playlist rather than a single work. Both are what this
 * directory means by music, and a declaration beats any evidence read off the
 * items, so this is consulted before anything else.
 *
 * Values outside this map are left to the evidence. `podcast` and `audiobook`
 * are already caught as podcasts by the tag's mere presence, and a medium this
 * code has never heard of should widen no category on its own.
 */
const MEDIUM_KINDS = new Map([
  ['music', KIND_MUSIC],
  ['musicl', KIND_MUSIC],
  ['video', KIND_VIDEO],
  ['videol', KIND_VIDEO],
  ['film', KIND_VIDEO],
  ['filml', KIND_VIDEO],
  ['blog', KIND_BLOG],
  ['blogl', KIND_BLOG],
]);

/**
 * The category a channel declares outright, or '' if it declares none.
 *
 * @param {any} channel
 * @returns {string}
 */
function declaredMedium(channel) {
  const value = text(channel?.['podcast:medium']).toLowerCase();
  return (value && MEDIUM_KINDS.get(value)) || '';
}

/**
 * Channel-level tags that only a podcast publishes.
 *
 * Deliberately not `itunes:author` or `itunes:image` — plenty of ordinary blogs
 * emit those from a general-purpose SEO plugin without ever shipping audio, and
 * a directory that files them under podcasts is worse than one that files
 * everything under blogs. Owner, category, explicit, type and podcast:guid are
 * set by podcast hosting because directories require them.
 */
const PODCAST_CHANNEL_TAGS = [
  'itunes:owner',
  'itunes:category',
  'itunes:explicit',
  'itunes:type',
  'podcast:guid',
  'podcast:medium',
];

/**
 * Does this element carry video?
 *
 * @param {any} item
 * @returns {boolean}
 */
function hasVideoEnclosure(item) {
  if (arr(item?.enclosure).some((e) => VIDEO_TYPE.test(String(e?.['@type'] ?? '')))) return true;
  return arr(item?.link).some(
    (l) => l?.['@rel'] === 'enclosure' && VIDEO_TYPE.test(String(l?.['@type'] ?? '')),
  );
}

/**
 * How much prose an item carries of its own, in characters of text.
 *
 * The one measurement that separates an attachment from an episode. A show
 * publishes the media and a paragraph about it; an article publishes the
 * article, and whatever it attached is illustration.
 *
 * @param {any} item
 * @returns {number}
 */
function bodyLength(item) {
  // Every format's name for the same thing, RSS and Atom first and JSON Feed's
  // two last, so one measurement serves all four parsers.
  const html =
    text(item?.['content:encoded']) ||
    text(item?.description) ||
    text(item?.content) ||
    text(item?.content_html) ||
    text(item?.content_text) ||
    text(item?.summary) ||
    '';

  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

/**
 * Longer than this and an item is an article, whatever it has attached.
 *
 * Chosen against the case that prompted this: kulturbanause.de publishes design
 * tutorials with screen recordings embedded, and the post that was being served
 * as a video carries 14,679 characters of German prose around two clips. Video
 * shows that write real notes clear this too — which is why the podcast
 * namespace is an alternative signal below rather than an additional one.
 */
const ARTICLE_TEXT = 1200;

/**
 * Is the media the feed, or is it attached to a feed of articles?
 *
 * Two independent tests, because either one alone has a false positive. A blog
 * that posts nothing but short video notes would pass the length test; a video
 * show with one text announcement in it would fail the density one. Requiring
 * both is what kulturbanause fails twice over: one item in ten carries an
 * enclosure, and that item is a 14,000-character tutorial.
 *
 * Both are majorities rather than absolutes, and the second one has to be.
 * Written as "no media item carries an article" this called framatube.org a
 * blog: five of five entries are videos, and one of the five has a 1,497
 * character description. A feed is what most of it is.
 *
 * @param {any[]} sample
 * @param {any[]} withMedia the sampled items that carry the enclosure
 * @returns {boolean}
 */
function isShowShaped(sample, withMedia) {
  if (withMedia.length === 0) return false;

  // Most of the feed is the media...
  if (withMedia.length * 2 <= sample.length) return false;

  // ...and most of the media is not an article with a file on it.
  const brief = withMedia.filter((item) => bodyLength(item) < ARTICLE_TEXT).length;
  return brief * 2 > withMedia.length;
}

/**
 * Is this a YouTube channel or playlist feed?
 *
 * YouTube's Atom feeds are identifiable without looking at the URL they were
 * fetched from: every entry carries a `yt:videoId` and the channel carries a
 * `yt:channelId`. Worth detecting by content rather than by hostname because
 * the same document is served from several YouTube hosts and through mirrors.
 *
 * @param {any} node channel or entry
 * @returns {boolean}
 */
function isYouTube(node) {
  return (
    node?.['yt:channelId'] !== undefined ||
    node?.['yt:playlistId'] !== undefined ||
    node?.['yt:videoId'] !== undefined
  );
}

/**
 * Classify a feed by what it publishes.
 *
 * Order matters, and it is the order of how specific the evidence is. A
 * declared medium first, because it is the publisher saying so rather than us
 * guessing. Then YouTube, because a channel feed says so in its own namespace
 * and nothing else needs weighing. Then video, which is an enclosure *and*
 * corroboration that the enclosure is the point. Then podcast, which is a
 * publisher who filled in the podcast namespaces. Everything else is a blog,
 * which is what the overwhelming majority of the directory is.
 *
 * One correction, arrived at twice from opposite ends of the directory: an
 * attachment is not a genre. A post with a file on it is still a post, and
 * every rule here that read "carries media" as "is media" was wrong in
 * production.
 *
 * Video used to be any video enclosure on any of the first five items. WordPress
 * attaches `<enclosure type="video/mp4">` to any post with a clip embedded in
 * it, so a design blog that screen-recorded a Figma session published exactly
 * the shape a video show does; of 400 feeds sampled from the ones this had put
 * under /videos, 399 were ordinary blogs. The enclosure now has to be
 * corroborated.
 *
 * Music used to be audio without podcast tags — a track rather than an episode,
 * went the reasoning — and it produced 198 feeds of which none were music. What
 * attaches an mp3 to a post is a blog: an AI read-through of the article, a
 * conference talk, a cross-posted episode, a field recording in a travelogue.
 * Narrated blogs are common enough now that "has audio" says nothing about the
 * publisher's intent, and no corroboration rescues it — Health Rising and
 * Reflective altruism narrate *every* post, so even a ratio test reads them as
 * albums. So music is not inferred at all: it comes from `podcast:medium` and
 * the curated list, and nothing else.
 *
 * Only the first few items are inspected: a feed's entries are homogeneous, and
 * scanning all of a 500-episode archive to learn what the first three already
 * said is work done on every crawl of every feed in the directory.
 *
 * @param {any} channel
 * @param {any[]} items raw parsed items
 * @returns {string} one of the KIND_* values
 */
function kindOfChannel(channel, items) {
  const declared = declaredMedium(channel);
  if (declared) return declared;

  const sample = items.slice(0, 5);

  if (isYouTube(channel) || sample.some(isYouTube)) return KIND_VIDEO;

  const podcastTags = PODCAST_CHANNEL_TAGS.some((tag) => channel?.[tag] !== undefined);

  // The enclosure has to be corroborated: either by a publisher who filled in
  // the podcast namespace, or by the feed being shaped like a show rather than
  // like a blog that occasionally attaches something. See above.
  const withVideo = sample.filter(hasVideoEnclosure);
  if (withVideo.length > 0 && (podcastTags || isShowShaped(sample, withVideo))) return KIND_VIDEO;

  if (podcastTags) return KIND_PODCAST;

  // No audio branch, deliberately. Audio without a declared medium is a blog
  // that narrated itself, and `declaredMedium` above is the only way to music.

  return KIND_BLOG;
}

/**
 * The category tags on an element, from wherever the format keeps them.
 *
 * RSS puts the text in the element (`<category>Linux</category>`), Atom puts it
 * in an attribute (`<category term="Linux"/>`), and iTunes uses `text`. All
 * three appear on the same document often enough to be worth reading together.
 *
 * @param {any} node
 * @returns {string[]}
 */
function categories(node) {
  const found = [
    ...arr(node?.category),
    ...arr(node?.['itunes:category']),
    ...arr(node?.['media:category']),
  ].map((c) => text(c?.['@term'] ?? c?.['@text'] ?? c?.['@label'] ?? c));

  // Deduplicated case-insensitively: a feed that tags a post both "Linux" and
  // "linux" has said one thing, not two.
  const seen = new Set();
  const out = [];
  for (const value of found) {
    const key = value.toLowerCase();
    if (!value || value.length > 60 || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * The audio attached to an item, if any.
 *
 * This is the episode itself — the thing a podcast feed exists to deliver —
 * and it was being detected and then thrown away: `kind` was derived from the
 * presence of an audio enclosure and the URL was never stored, so a podcast's
 * page could say it was a podcast and not play.
 *
 * `itunes:duration` is read where it exists because a player that knows the
 * length can show it before the file has loaded. It arrives as seconds, or as
 * MM:SS, or as HH:MM:SS, depending on who generated the feed.
 *
 * @param {any} item
 * @returns {{ url: string, type: string, bytes: number|null, seconds: number|null }|null}
 */
function audioEnclosure(item) {
  // A YouTube entry has no enclosure at all: the video lives behind a watch
  // page that refuses to be framed. Its embed URL does not, so that is what is
  // stored — the one form of this media that can actually play on our page.
  const videoId = text(item?.['yt:videoId']);
  if (videoId && /^[\w-]{6,20}$/.test(videoId)) {
    return {
      url: `https://www.youtube-nocookie.com/embed/${videoId}`,
      type: 'video/youtube',
      bytes: null,
      seconds: null,
    };
  }

  const media = (type) => {
    const enclosure = arr(item?.enclosure).find((e) => type.test(String(e?.['@type'] ?? '')));
    // Atom has no <enclosure>; the same file arrives as a link relation.
    const link = arr(item?.link).find(
      (l) => l?.['@rel'] === 'enclosure' && type.test(String(l?.['@type'] ?? '')),
    );
    return { enclosure, link };
  };

  // Video first: a feed carrying both is a video feed with an audio track
  // alongside, and the video is the thing the publisher meant.
  const found = (() => {
    const asVideo = media(VIDEO_TYPE);
    if (asVideo.enclosure || asVideo.link) return asVideo;
    return media(AUDIO_TYPE);
  })();

  const { enclosure, link } = found;
  const url = text(enclosure?.['@url'] ?? link?.['@href'] ?? '');
  if (!url) return null;

  const bytes = Number(enclosure?.['@length'] ?? link?.['@length'] ?? 0);

  return {
    url,
    type: text(enclosure?.['@type'] ?? link?.['@type'] ?? '') || 'audio/mpeg',
    bytes: Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : null,
    seconds: duration(item?.['itunes:duration']),
  };
}

/**
 * The audio attachment on a JSON Feed item.
 *
 * JSON Feed states the duration in its own field rather than borrowing
 * itunes:duration, and it is always a number of seconds.
 *
 * @param {any} item
 * @returns {{ url: string, type: string, bytes: number|null, seconds: number|null }|null}
 */
function jsonAudio(item) {
  const attachments = Array.isArray(item?.attachments) ? item.attachments : [];
  const audio =
    attachments.find((a) => VIDEO_TYPE.test(String(a?.mime_type ?? ''))) ??
    attachments.find((a) => AUDIO_TYPE.test(String(a?.mime_type ?? '')));
  if (!audio?.url) return null;

  const bytes = Number(audio.size_in_bytes ?? 0);
  const seconds = Number(audio.duration_in_seconds ?? 0);

  return {
    url: String(audio.url),
    type: String(audio.mime_type ?? 'audio/mpeg'),
    bytes: Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : null,
    seconds: Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : null,
  };
}

/**
 * Read a duration in any of the three spellings podcast feeds use.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function duration(value) {
  const raw = text(value);
  if (!raw) return null;

  const parts = raw.split(':').map((p) => Number(p.trim()));
  if (parts.some((p) => !Number.isFinite(p) || p < 0)) return null;

  // Seconds, MM:SS, or HH:MM:SS — anything else is not a duration.
  const seconds =
    parts.length === 1
      ? parts[0]
      : parts.length === 2
        ? parts[0] * 60 + parts[1]
        : parts.length === 3
          ? parts[0] * 3600 + parts[1] * 60 + parts[2]
          : null;

  return seconds !== null && seconds > 0 ? Math.floor(seconds) : null;
}

/**
 * The URL of an enclosure that is actually an image.
 *
 * `<enclosure>` is how a podcast attaches its audio file, so taking its URL as
 * the item's image — which this used to do unconditionally — put an mp3 in the
 * image slot of every episode of every podcast in the directory.
 *
 * @param {any} item
 * @returns {string}
 */
function enclosureImage(item) {
  const image = arr(item?.enclosure).find((e) => /^image\//i.test(String(e?.['@type'] ?? '')));
  return text(image?.['@url'] ?? '');
}

/**
 * One numeric HTML entity, as a character.
 *
 * Control characters and anything out of range become a space rather than
 * throwing or producing an unprintable summary — a malformed entity in one
 * blog's feed must not be able to break the text of its page.
 *
 * @param {number} code
 * @returns {string}
 */
function entity(code) {
  if (!Number.isInteger(code) || code < 32 || code > 0x10ffff) return ' ';
  try {
    return String.fromCodePoint(code);
  } catch {
    return ' ';
  }
}

/**
 * Strip HTML to a plain-text summary.
 *
 * Feed summaries arrive as escaped HTML more often than not. Agents and search
 * indexes want prose, so tags go, entities are decoded, and whitespace collapses.
 *
 * @param {string} html
 * @param {number} [max] truncation length; 0 disables truncation
 * @returns {string}
 */
export function summarize(html, max = 400) {
  if (!html) return '';
  const plain = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    // The named entities WordPress and friends emit constantly. Undecoded,
    // their names survive tokenizing as words: "rsquo" was the seventh most
    // common topic in the whole directory, ahead of "code" and "software",
    // because every "I&rsquo;ve" contributed one.
    .replace(/&(?:rsquo|lsquo|apos|#39);/gi, "'")
    .replace(/&(?:rdquo|ldquo|bdquo);/gi, '"')
    .replace(/&(?:mdash|ndash|minus);/gi, '-')
    .replace(/&(?:hellip);/gi, '…')
    // Numeric entities, decimal and hex. The hex form is what most CMSs emit
    // for a curly apostrophe, and leaving it undecoded does not merely look
    // wrong — the leftover "#x27" survives tokenizing as a word and turns up in
    // the feed's topics.
    .replace(/&#x([\da-f]+);/gi, (_, hex) => entity(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => entity(Number(dec)))
    // Anything still shaped like an entity is one this list does not know.
    // Dropped rather than left as text, because its name is not a word and the
    // list above will always be missing something.
    .replace(/&[a-z][a-z0-9]{1,10};/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!max || plain.length <= max) return plain;
  // Cut on a word boundary so summaries don't end mid-word.
  return `${plain.slice(0, plain.lastIndexOf(' ', max) > 0 ? plain.lastIndexOf(' ', max) : max).trim()}…`;
}

/**
 * Parse a date from any of the formats feeds use, returning null when unusable.
 *
 * @param {unknown} v
 * @returns {string|null} ISO 8601 string
 */
function date(v) {
  const raw = text(v);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Find the first usable link in an Atom `<link>` set.
 *
 * Atom entries carry several links (alternate, self, enclosure, replies); the
 * one a reader wants is rel="alternate", which is also the default when rel is
 * omitted entirely.
 *
 * @param {unknown} link
 * @returns {string}
 */
function atomLink(link) {
  const links = arr(link);
  const alt = links.find((l) => {
    const rel = l?.['@rel'];
    return !rel || rel === 'alternate';
  });
  return text(alt?.['@href'] ?? alt) || text(links[0]?.['@href'] ?? links[0]);
}

/**
 * Parse an RSS 2.0, Atom or JSON Feed document into one normalized shape.
 *
 * Returns null when the payload is not a feed at all, so callers can reject a
 * submission cleanly rather than storing an empty record.
 *
 * @param {string} body raw feed document
 * @param {string} [feedUrl] used to resolve the site link when the feed omits one
 * @returns {{
 *   title: string, description: string, siteUrl: string, language: string,
 *   imageUrl: string, kind: string, items: Array<{
 *     guid: string, url: string, title: string, summary: string,
 *     contentHtml: string, author: string, publishedAt: string|null, imageUrl: string
 *   }>
 * } | null}
 */
export function parseFeed(body, feedUrl = '') {
  if (typeof body !== 'string' || !body.trim()) return null;

  const trimmed = body.trim();
  if (trimmed.startsWith('{')) return parseJsonFeed(trimmed);

  let doc;
  try {
    doc = parser.parse(trimmed);
  } catch {
    return null;
  }

  if (doc?.rss?.channel) return parseRss(doc.rss.channel);
  if (doc?.feed) return parseAtom(doc.feed);
  // RSS 1.0 / RDF keeps channel and items as siblings under rdf:RDF.
  if (doc?.['rdf:RDF']) return parseRdf(doc['rdf:RDF']);

  return null;
}

/**
 * @param {any} ch
 */
function parseRss(ch) {
  const raw = arr(ch.item);
  const items = raw.map((it) => {
    const contentHtml = text(it['content:encoded']) || text(it.description);
    return {
      guid: text(it.guid) || text(it.link) || text(it.title),
      url: text(it.link),
      title: text(it.title) || '(untitled)',
      summary: summarize(text(it.description) || contentHtml),
      contentHtml,
      author: text(it['dc:creator']) || text(it.author),
      publishedAt: date(it.pubDate) || date(it['dc:date']),
      imageUrl: text(it['media:thumbnail']?.['@url']) || enclosureImage(it),
      categories: categories(it),
      audio: audioEnclosure(it),
    };
  });

  return {
    title: text(ch.title) || '(untitled)',
    description: summarize(text(ch.description), 500),
    siteUrl: text(ch.link),
    language: text(ch.language),
    // A podcast's cover art is in itunes:image; the plain <image> element is
    // optional and podcast hosts do not always emit it.
    imageUrl: text(ch.image?.url) || text(ch['itunes:image']?.['@href']),
    categories: categories(ch),
    kind: kindOfChannel(ch, raw),
    items,
  };
}

/**
 * @param {any} feed
 */
function parseAtom(feed) {
  const entries = arr(feed.entry);
  const items = entries.map((e) => {
    const contentHtml = text(e.content) || text(e.summary);
    return {
      guid: text(e.id) || atomLink(e.link),
      url: atomLink(e.link),
      title: text(e.title) || '(untitled)',
      summary: summarize(text(e.summary) || contentHtml),
      contentHtml,
      author: text(e.author?.name),
      publishedAt: date(e.published) || date(e.updated),
      imageUrl: '',
      categories: categories(e),
      audio: audioEnclosure(e),
    };
  });

  // YouTube publishes Atom, so this is the format its channel feeds arrive in.
  const kind = kindOfChannel(feed, entries);

  return {
    title: text(feed.title) || '(untitled)',
    description: summarize(text(feed.subtitle), 500),
    siteUrl: atomLink(feed.link),
    language: text(feed['@xml:lang']),
    imageUrl: text(feed.logo) || text(feed.icon),
    categories: categories(feed),
    kind,
    items,
  };
}

/**
 * @param {any} rdf
 */
function parseRdf(rdf) {
  const ch = rdf.channel ?? {};
  const raw = arr(rdf.item);
  const items = raw.map((it) => ({
    guid: text(it['@rdf:about']) || text(it.link),
    url: text(it.link),
    title: text(it.title) || '(untitled)',
    summary: summarize(text(it.description)),
    contentHtml: text(it['content:encoded']) || text(it.description),
    author: text(it['dc:creator']),
    publishedAt: date(it['dc:date']),
    imageUrl: '',
    categories: categories(it),
    audio: audioEnclosure(it),
  }));

  return {
    title: text(ch.title) || '(untitled)',
    description: summarize(text(ch.description), 500),
    siteUrl: text(ch.link),
    language: '',
    imageUrl: '',
    categories: categories(ch),
    // RSS 1.0 keeps the channel and the items as siblings, so the channel tags
    // and the items are read from different objects.
    kind: kindOfChannel(ch, raw),
    items,
  };
}

/**
 * @param {string} raw
 */
function parseJsonFeed(raw) {
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!j || !Array.isArray(j.items)) return null;

  const items = j.items.map((it) => {
    const contentHtml = it.content_html || it.content_text || '';
    return {
      guid: String(it.id ?? it.url ?? ''),
      url: it.url ?? '',
      title: it.title ?? '(untitled)',
      summary: summarize(it.summary || contentHtml),
      contentHtml,
      author: it.author?.name ?? j.author?.name ?? '',
      publishedAt: date(it.date_published),
      imageUrl: it.image ?? '',
      // JSON Feed calls them tags; they are the same thing RSS calls
      // categories, so they are read into the same field.
      categories: Array.isArray(it.tags) ? it.tags.map((t) => String(t)) : [],
      audio: jsonAudio(it),
    };
  });

  // JSON Feed carries media as attachments, and podcast publishers that emit
  // it also tend to carry the RSS one through the `_itunes` extension.
  const sample = j.items.slice(0, 5);
  const typesOf = (it) =>
    (Array.isArray(it?.attachments) ? it.attachments : []).map((a) => String(a?.mime_type ?? ''));

  // Corroborated the same way as the RSS path: a JSON Feed article with a clip
  // attached to it is an article. See kindOfChannel.
  const withVideo = sample.filter((it) => typesOf(it).some((type) => VIDEO_TYPE.test(type)));
  const video = isShowShaped(sample, withVideo);

  return {
    title: j.title ?? '(untitled)',
    description: summarize(j.description ?? '', 500),
    siteUrl: j.home_page_url ?? '',
    language: j.language ?? '',
    imageUrl: j.icon ?? '',
    categories: [],
    // JSON Feed states the podcast claim in an extension rather than a
    // namespace. It has no equivalent of `podcast:medium`, so a JSON Feed can
    // only reach the music category by curation.
    kind: j._itunes ? KIND_PODCAST : video ? KIND_VIDEO : KIND_BLOG,
    items,
  };
}
