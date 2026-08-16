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
 * Does this parsed element carry audio in an enclosure?
 *
 * A feed with audio attached to its entries is a podcast even when it declares
 * no namespace at all, which is the case for hand-rolled and static-site feeds
 * — the example that prompted this, linuxmatters.sh, happens to declare both.
 *
 * @param {any} item
 * @returns {boolean}
 */
function hasAudioEnclosure(item) {
  return arr(item?.enclosure).some((e) => AUDIO_TYPE.test(String(e?.['@type'] ?? '')));
}

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
 * Order matters, and it is the order of how specific the evidence is. Video
 * first, because a video feed frequently also carries audio metadata. Then
 * podcast, which is audio *plus* a publisher who filled in the podcast
 * namespaces — the strongest signal any of these have. Then music, which is
 * what audio without those tags is: a track, not an episode. Everything else
 * is a blog, which is what the overwhelming majority of the directory is.
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
  const sample = items.slice(0, 5);

  if (isYouTube(channel) || sample.some(isYouTube)) return KIND_VIDEO;
  if (sample.some(hasVideoEnclosure)) return KIND_VIDEO;

  const audio = sample.some(hasAudioEnclosure);
  const podcastTags = PODCAST_CHANNEL_TAGS.some((tag) => channel?.[tag] !== undefined);

  if (podcastTags) return KIND_PODCAST;
  if (audio) return KIND_MUSIC;

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
    // Numeric entities, decimal and hex. The hex form is what most CMSs emit
    // for a curly apostrophe, and leaving it undecoded does not merely look
    // wrong — the leftover "#x27" survives tokenizing as a word and turns up in
    // the feed's topics.
    .replace(/&#x([\da-f]+);/gi, (_, hex) => entity(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => entity(Number(dec)))
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

  // Atom has no <enclosure>: an attachment is a <link rel="enclosure">, so the
  // audio test has to read the link set rather than kindOfChannel's shape.
  const audio = entries
    .slice(0, 5)
    .some((e) =>
      arr(e.link).some(
        (l) => l?.['@rel'] === 'enclosure' && AUDIO_TYPE.test(String(l?.['@type'] ?? '')),
      ),
    );

  // YouTube publishes Atom, so this is the format its channel feeds arrive in.
  const kind = kindOfChannel(feed, entries);

  return {
    title: text(feed.title) || '(untitled)',
    description: summarize(text(feed.subtitle), 500),
    siteUrl: atomLink(feed.link),
    language: text(feed['@xml:lang']),
    imageUrl: text(feed.logo) || text(feed.icon),
    categories: categories(feed),
    // kindOfChannel already handles YouTube and the podcast namespaces; this
    // only adds what it cannot see, which is Atom's link-shaped enclosures.
    kind: kind === KIND_BLOG && audio ? KIND_MUSIC : kind,
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
  const attachmentTypes = j.items
    .slice(0, 5)
    .flatMap((it) => (Array.isArray(it?.attachments) ? it.attachments : []))
    .map((a) => String(a?.mime_type ?? ''));

  const audio = attachmentTypes.some((type) => AUDIO_TYPE.test(type));
  const video = attachmentTypes.some((type) => VIDEO_TYPE.test(type));

  return {
    title: j.title ?? '(untitled)',
    description: summarize(j.description ?? '', 500),
    siteUrl: j.home_page_url ?? '',
    language: j.language ?? '',
    imageUrl: j.icon ?? '',
    categories: [],
    // JSON Feed states the podcast claim in an extension rather than a
    // namespace, so an attachment on its own is a track, not an episode.
    kind: j._itunes ? KIND_PODCAST : video ? KIND_VIDEO : audio ? KIND_MUSIC : KIND_BLOG,
    items,
  };
}
