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

/** The two things this directory lists. */
export const KIND_BLOG = 'blog';
export const KIND_PODCAST = 'podcast';

/** An enclosure or attachment that carries audio, whatever else it says. */
const AUDIO_TYPE = /^audio\//i;

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
 * Classify an RSS/RDF channel as a blog or a podcast.
 *
 * Only the first few items are inspected: a feed's entries are homogeneous, and
 * scanning all of a 500-episode archive to learn what the first three already
 * said is work done on every crawl of every feed in the directory.
 *
 * @param {any} channel
 * @param {any[]} items raw parsed items
 * @returns {string} KIND_BLOG or KIND_PODCAST
 */
function kindOfChannel(channel, items) {
  if (PODCAST_CHANNEL_TAGS.some((tag) => channel?.[tag] !== undefined)) return KIND_PODCAST;
  if (items.slice(0, 5).some(hasAudioEnclosure)) return KIND_PODCAST;
  return KIND_BLOG;
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
    .replace(/&#3[49];/g, "'")
    .replace(/&#\d+;/g, ' ')
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

  return {
    title: text(feed.title) || '(untitled)',
    description: summarize(text(feed.subtitle), 500),
    siteUrl: atomLink(feed.link),
    language: text(feed['@xml:lang']),
    imageUrl: text(feed.logo) || text(feed.icon),
    kind: audio || kindOfChannel(feed, []) === KIND_PODCAST ? KIND_PODCAST : KIND_BLOG,
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
  }));

  return {
    title: text(ch.title) || '(untitled)',
    description: summarize(text(ch.description), 500),
    siteUrl: text(ch.link),
    language: '',
    imageUrl: '',
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
    };
  });

  // JSON Feed carries audio as an attachment, and podcast publishers that emit
  // it also tend to carry the RSS one through the `_itunes` extension.
  const audio = j.items
    .slice(0, 5)
    .some((it) =>
      (Array.isArray(it?.attachments) ? it.attachments : []).some((a) =>
        AUDIO_TYPE.test(String(a?.mime_type ?? '')),
      ),
    );

  return {
    title: j.title ?? '(untitled)',
    description: summarize(j.description ?? '', 500),
    siteUrl: j.home_page_url ?? '',
    language: j.language ?? '',
    imageUrl: j.icon ?? '',
    kind: audio || j._itunes ? KIND_PODCAST : KIND_BLOG,
    items,
  };
}
