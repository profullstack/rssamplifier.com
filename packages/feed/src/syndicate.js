/**
 * Feeds, written rather than read.
 *
 * Everything else in this package turns somebody else's document into our rows.
 * This turns our rows back into a document, so that a topic in the directory is
 * something a reader can subscribe to instead of a page a person has to visit.
 *
 * Five formats, because "give me this topic as a feed" means five different
 * things depending on who is asking:
 *
 * - **RSS 2.0** (`.rss`, `.xml`) — what every reader on earth accepts, and the
 *   only one podcast clients will take. Enclosures ride along, so a topic full
 *   of podcasts subscribes as a podcast.
 * - **Atom 1.0** (`.atom`) — the stricter one, and what a few readers and most
 *   aggregation libraries prefer.
 * - **JSON Feed 1.1** (`.json`) — the one an agent can read without an XML
 *   parser. This is deliberately *not* the same document as `/api/topics/:slug`:
 *   that lists the feeds filed under a topic, this lists what they published.
 *   A directory listing and a river are different questions.
 * - **M3U** (`.m3u`) and **PLS** (`.pls`) — playlists. Not feeds at all: they
 *   carry no dates, no links and no prose, only an ordered list of media to
 *   play. They exist here because a topic like `jazz` or `radio` is mostly
 *   enclosures, and handing VLC an `.m3u` is a shorter path than asking it to
 *   subscribe to an RSS feed and then find the audio inside it.
 *
 * The item shape is the one `q.itemsForTopic` returns — database rows, snake
 * cased — rather than the camel-cased shape `parseFeed` produces. These render
 * what we stored, and adding a translation layer in between would only be a
 * second place for a column rename to break.
 */

/**
 * The output formats, keyed by the extension that selects them.
 *
 * The map is the contract: the route reads its list of supported extensions
 * from here, the rewrite rule in next.config.mjs matches the same set, and the
 * topic page links every entry. Adding a format is one entry, not four edits.
 *
 * `media: true` marks the formats that can only carry playable files, which is
 * what makes them a different query rather than a different renderer.
 */
export const SYNDICATION_FORMATS = new Map([
  ['rss', { type: 'application/rss+xml; charset=utf-8', label: 'RSS', media: false }],
  ['xml', { type: 'application/rss+xml; charset=utf-8', label: 'RSS', media: false }],
  ['atom', { type: 'application/atom+xml; charset=utf-8', label: 'Atom', media: false }],
  ['json', { type: 'application/feed+json; charset=utf-8', label: 'JSON Feed', media: false }],
  ['m3u', { type: 'audio/x-mpegurl; charset=utf-8', label: 'M3U', media: true }],
  ['pls', { type: 'audio/x-scpls; charset=utf-8', label: 'PLS', media: true }],
]);

/**
 * Render a channel and its items in one of the supported formats.
 *
 * @param {string} format one of SYNDICATION_FORMATS' keys
 * @param {Channel} channel
 * @param {Item[]} items
 * @returns {string}
 */
export function buildSyndication(format, channel, items) {
  switch (format) {
    case 'rss':
    case 'xml':
      return buildRss(channel, items);
    case 'atom':
      return buildAtom(channel, items);
    case 'json':
      return buildJsonFeed(channel, items);
    case 'm3u':
      return buildM3u(channel, items);
    case 'pls':
      return buildPls(channel, items);
    default:
      throw new Error(`unknown syndication format: ${format}`);
  }
}

/**
 * @typedef {object} Channel
 * @property {string} title
 * @property {string} description
 * @property {string} link the human page this feed mirrors
 * @property {string} selfUrl this document's own address
 * @property {string} [language]
 * @property {string} [updated] ISO 8601
 */

/**
 * @typedef {object} Item
 * @property {string} id stable across rebuilds — the guid
 * @property {string} url
 * @property {string} title
 * @property {string|null} [summary]
 * @property {string|null} [author]
 * @property {string|null} [image_url]
 * @property {string|null} [published_at] ISO 8601
 * @property {string|null} [audio_url]
 * @property {string|null} [audio_type]
 * @property {number|null} [audio_seconds]
 * @property {number|null} [audio_bytes]
 * @property {string} [feed_title] the publication it came from
 * @property {string} [feed_slug]
 * @property {string} [feed_url] that publication's own feed
 * @property {boolean} [sponsored] a paid item rather than something a feed published
 * @property {string|null} [content_html] a ready-made HTML body, used in place
 *   of `summary`. Only sponsored items carry one — a crawled post's body is
 *   somebody else's HTML and is deliberately reduced to a plain-text summary.
 */

/**
 * How often a sponsored item is placed, and how many a document may carry.
 *
 * One in ten is the ratio: frequent enough to be worth selling, rare enough
 * that a reader scrolling a river meets nine real posts first. The cap matters
 * more than it looks — feeds here go up to 200 items, and at one in ten with no
 * ceiling a long topic feed would carry twenty ads, which is not a river with
 * advertising in it, it is an advertising feed.
 */
export const AD_EVERY = 10;
export const AD_MAX = 3;

/**
 * How many sponsored items a list of this length will actually take.
 *
 * Exported because the caller has to decide how many ads to *fetch* before it
 * can interleave them, and every fetched ad costs an impression the moment the
 * ad network records it. If the two disagreed, the difference would be metered
 * against an advertiser and then never published — the caller would pay for
 * reach nobody got. So the count lives here, next to the placement rule it has
 * to match, rather than being re-derived at each call site.
 *
 * @param {number} total how many real items the document will carry
 * @param {{ every?: number, max?: number }} [opts]
 * @returns {number}
 */
export function adSlotsFor(total, { every = AD_EVERY, max = AD_MAX } = {}) {
  const n = Number(total) || 0;
  if (n < every) return 0;
  // Boundaries strictly inside the list: the last one is dropped when it would
  // land at the end, for the same reason interleaveAds refuses to trail.
  const boundaries = Math.ceil(n / every) - 1;
  return Math.max(0, Math.min(max, boundaries));
}

/**
 * Place sponsored items among real ones.
 *
 * Position in the document is only half the job, and the half that does not
 * matter. **Readers sort by date**, so where an ad *sits* in the XML is
 * irrelevant next to what date it carries — and an ad dated "now" floats to the
 * top of the river no matter which index it was written at.
 *
 * That is not hypothetical. The first version of this shipped ads dated to the
 * start of the current UTC day, which is *newer than most of the feed*: the
 * directory is a river of other people's blogs and the newest post is routinely
 * a day or more old. All three ads therefore sorted above every real post, and
 * because they shared one timestamp they arrived as a block of three
 * advertisements at the top of the feed. Precisely the thing nobody opens.
 *
 * So each ad is re-dated to sit just behind the post it follows — one second
 * older, which is enough to order it and small enough that it reads as
 * contemporary with its neighbours. Document order and reader order then agree,
 * and the ads are spread through the river instead of stacked on top of it.
 *
 * Re-dating is safe because identity is the guid, not the date: a reader that
 * has already stored the item keeps whatever date it first saw, and one that
 * has not gets an item that sorts where we intended.
 *
 * A list shorter than one full interval gets nothing. A six-post feed cannot
 * carry an ad without the ad becoming the feed, and the same rule already
 * governs the web units (see apps/web/src/lib/ads.js).
 *
 * @param {Item[]} items the real posts, in the order they should appear
 * @param {Item[]} ads sponsored items, already in Item shape
 * @param {{ every?: number, max?: number }} [opts]
 * @returns {Item[]} one list, ads interleaved
 */
export function interleaveAds(items, ads, { every = AD_EVERY, max = AD_MAX } = {}) {
  if (!Array.isArray(ads) || ads.length === 0) return items;
  if (items.length < every) return items;

  const out = [];
  let placed = 0;

  for (let i = 0; i < items.length; i += 1) {
    out.push(items[i]);
    // Never trailing: an ad as the last entry of a feed reads as the feed
    // having ended in an advertisement, and costs the slot nothing to skip.
    const boundary = (i + 1) % every === 0 && i + 1 < items.length;
    if (boundary && placed < max && placed < ads.length) {
      out.push(datedAfter(ads[placed], items[i]));
      placed += 1;
    }
  }

  return out;
}

/**
 * An ad re-dated to sort immediately after the post it follows.
 *
 * Falls back to the ad's own date when the preceding post has none — a great
 * many rows genuinely do not (an item parsed out of a playlist has no date), and
 * inventing one for the neighbour would be worse than leaving the ad where it
 * was.
 *
 * @param {Item} ad
 * @param {Item} previous
 * @returns {Item}
 */
function datedAfter(ad, previous) {
  const at = new Date(String(previous?.published_at ?? ''));
  if (Number.isNaN(at.getTime())) return ad;
  return { ...ad, published_at: new Date(at.getTime() - 1000).toISOString() };
}

/**
 * Wrap a body in CDATA.
 *
 * The one sequence a CDATA section cannot contain is its own terminator, and
 * there is no escape for it — the section has to be closed and reopened around
 * the `>`. Only sponsored bodies take this path and ours never produce `]]>`,
 * but the copy inside them is written by an advertiser, so this is a
 * correctness guard rather than a theoretical one.
 *
 * @param {unknown} html
 * @returns {string}
 */
function cdata(html) {
  const safe = String(html ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return `<![CDATA[${safe.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

/**
 * The disclosure label carried on a sponsored item.
 *
 * A constant rather than a per-item field: a reader filtering on `<category>`
 * needs one term to filter on, and letting an advertiser choose the wording
 * their own disclosure appears under defeats the point of having one.
 */
const SPONSORED = 'Sponsored';

// --------------------------------------------------------------------- RSS

/**
 * RSS 2.0.
 *
 * Two details are load-bearing rather than decorative. `<atom:link rel="self">`
 * is how a reader learns the feed's own address, which matters here because the
 * document is reachable at more than one URL — the pretty `/topics/x.rss` and
 * the API form both answer, and without a self link a reader that found one has
 * no way to know they are the same feed. And `<source>` names the blog each
 * post came from: a river mixes a hundred publications, and a reader showing
 * only the post title leaves the reader unable to tell who wrote it.
 *
 * @param {Channel} channel
 * @param {Item[]} items
 * @returns {string}
 */
export function buildRss(channel, items) {
  const updated = channel.updated || latest(items) || new Date(0).toISOString();

  const entries = items
    .map((item) => {
      const parts = [
        `      <title>${esc(item.title || '(untitled)')}</title>`,
        // isPermaLink="false" because the guid is the publisher's, which is
        // frequently not a URL at all — a tag: URI, a bare integer, a hash.
        `      <guid isPermaLink="false">${esc(item.id)}</guid>`,
      ];

      if (item.url) parts.push(`      <link>${esc(item.url)}</link>`);
      if (item.published_at) parts.push(`      <pubDate>${esc(rfc822(item.published_at))}</pubDate>`);
      // A sponsored item brings its own HTML body and has to be labelled where
      // a reader will actually see it: <category> is the machine-readable half,
      // and the title it arrived with already carries the human half.
      if (item.sponsored) parts.push(`      <category>${esc(SPONSORED)}</category>`);
      if (item.content_html) {
        parts.push(`      <description>${cdata(item.content_html)}</description>`);
      } else if (item.summary) {
        parts.push(`      <description>${esc(item.summary)}</description>`);
      }
      // dc:creator rather than <author>, which RSS defines as an email address.
      // Almost nothing publishes one, and readers show dc:creator anyway.
      if (item.author) parts.push(`      <dc:creator>${esc(item.author)}</dc:creator>`);
      if (item.feed_title) {
        parts.push(`      <source url="${esc(item.feed_url ?? channel.link)}">${esc(item.feed_title)}</source>`);
      }
      // The post's picture, in the element every reader app already looks for.
      // RSS 2.0 has no image element of its own, so Media RSS is the only
      // honest place to put one — and it is where the crawler reads it back
      // from, which means a feed built here round-trips through our own parser.
      if (item.image_url) {
        parts.push(`      <media:thumbnail url="${esc(item.image_url)}" />`);
      }
      if (playable(item)) {
        const length = Number.isFinite(Number(item.audio_bytes)) ? Number(item.audio_bytes) : 0;
        parts.push(
          `      <enclosure url="${esc(item.audio_url)}" type="${esc(item.audio_type || 'audio/mpeg')}" length="${length}" />`,
        );
        if (item.audio_seconds) {
          parts.push(`      <itunes:duration>${esc(hms(item.audio_seconds))}</itunes:duration>`);
        }
      }

      return `    <item>\n${parts.join('\n')}\n    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:atom="http://www.w3.org/2005/Atom"
     xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:media="http://search.yahoo.com/mrss/"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>${esc(channel.title)}</title>
    <link>${esc(channel.link)}</link>
    <description>${esc(channel.description)}</description>
    <language>${esc(channel.language || 'en')}</language>
    <generator>RSS Amplifier</generator>
    <lastBuildDate>${esc(rfc822(updated))}</lastBuildDate>
    <atom:link href="${esc(channel.selfUrl)}" rel="self" type="application/rss+xml" />
${entries}
  </channel>
</rss>
`;
}

// -------------------------------------------------------------------- Atom

/**
 * Atom 1.0.
 *
 * Stricter than RSS in the two ways that bite: every entry needs an `<id>` and
 * an `<updated>`, and neither may be omitted. Our guids are already stable ids,
 * but `published_at` is genuinely null for a great many rows — an item parsed
 * out of a playlist has no date to carry — so undated entries fall back to the
 * feed's own build time rather than being dropped. A wrong-but-present date
 * costs a reader nothing; a missing one makes the document invalid.
 *
 * @param {Channel} channel
 * @param {Item[]} items
 * @returns {string}
 */
export function buildAtom(channel, items) {
  const updated = channel.updated || latest(items) || new Date(0).toISOString();

  const entries = items
    .map((item) => {
      const parts = [
        `    <title>${esc(item.title || '(untitled)')}</title>`,
        `    <id>${esc(atomId(item, channel))}</id>`,
        `    <updated>${esc(item.published_at || updated)}</updated>`,
      ];

      if (item.published_at) parts.push(`    <published>${esc(item.published_at)}</published>`);
      if (item.url) parts.push(`    <link rel="alternate" type="text/html" href="${esc(item.url)}" />`);
      if (item.sponsored) {
        parts.push(`    <category term="sponsored" label="${esc(SPONSORED)}" />`);
        parts.push(`    <rights>${esc(SPONSORED)}</rights>`);
      }
      if (item.content_html) {
        parts.push(`    <content type="html">${cdata(item.content_html)}</content>`);
      } else if (item.summary) {
        parts.push(`    <summary type="text">${esc(item.summary)}</summary>`);
      }
      if (item.author) parts.push(`    <author><name>${esc(item.author)}</name></author>`);
      if (item.feed_title) parts.push(`    <source><title>${esc(item.feed_title)}</title></source>`);
      // Atom has no image element either, and the same Media RSS namespace is
      // what YouTube's own Atom feeds use for exactly this.
      if (item.image_url) parts.push(`    <media:thumbnail url="${esc(item.image_url)}" />`);
      if (playable(item)) {
        const length = Number.isFinite(Number(item.audio_bytes)) ? Number(item.audio_bytes) : 0;
        parts.push(
          `    <link rel="enclosure" type="${esc(item.audio_type || 'audio/mpeg')}" length="${length}" href="${esc(item.audio_url)}" />`,
        );
      }

      return `  <entry>\n${parts.join('\n')}\n  </entry>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <title>${esc(channel.title)}</title>
  <subtitle>${esc(channel.description)}</subtitle>
  <id>${esc(channel.link)}</id>
  <updated>${esc(updated)}</updated>
  <generator>RSS Amplifier</generator>
  <link rel="alternate" type="text/html" href="${esc(channel.link)}" />
  <link rel="self" type="application/atom+xml" href="${esc(channel.selfUrl)}" />
${entries}
</feed>
`;
}

// --------------------------------------------------------------- JSON Feed

/**
 * JSON Feed 1.1.
 *
 * The version matters: 1.1 renamed `author` to `authors` and added
 * `language`, and readers that support only 1.0 read the 1.1 document fine
 * because every 1.0 field is still where it was.
 *
 * @param {Channel} channel
 * @param {Item[]} items
 * @returns {string}
 */
export function buildJsonFeed(channel, items) {
  const doc = {
    version: 'https://jsonfeed.org/version/1.1',
    title: channel.title,
    description: channel.description,
    home_page_url: channel.link,
    feed_url: channel.selfUrl,
    language: channel.language || 'en',
    items: items.map((item) => {
      const out = {
        id: item.id,
        title: item.title || '(untitled)',
      };

      if (item.url) out.url = item.url;
      if (item.summary) out.summary = item.summary;
      if (item.content_html) out.content_html = item.content_html;
      // JSON Feed has no notion of an ad, so the disclosure goes in both the
      // human field readers display and an extension field an agent can branch
      // on. The `_` prefix is the spec's own marker for "this is ours".
      if (item.sponsored) {
        out.tags = [SPONSORED];
        out._crawlproof = { sponsored: true, label: SPONSORED };
      }
      if (item.image_url) out.image = item.image_url;
      if (item.published_at) out.date_published = item.published_at;
      if (item.author) out.authors = [{ name: item.author }];
      // Where it came from. JSON Feed has no <source>, so the publication is an
      // extension field — the `_` prefix is the spec's own way of saying "this
      // is ours", and a reader that does not know it ignores it.
      if (item.feed_title) {
        out._rssamplifier = {
          feed_title: item.feed_title,
          ...(item.feed_slug ? { feed_page: `${channel.link.split('/topics/')[0]}/${item.feed_slug}` } : {}),
        };
      }
      if (playable(item)) {
        out.attachments = [
          {
            url: item.audio_url,
            mime_type: item.audio_type || 'audio/mpeg',
            ...(item.audio_seconds ? { duration_in_seconds: Number(item.audio_seconds) } : {}),
            ...(item.audio_bytes ? { size_in_bytes: Number(item.audio_bytes) } : {}),
          },
        ];
      }

      return out;
    }),
  };

  return `${JSON.stringify(doc, null, 2)}\n`;
}

// --------------------------------------------------------------- playlists

/**
 * Extended M3U.
 *
 * `#EXTINF` wants a duration and most of our rows do not have one; `-1` is the
 * format's own way of saying so, and is what every player expects for a stream
 * of unknown length. The title carries the publication as well as the episode
 * — "Artist - Title" is how the format has always been read, and in a river the
 * publication is the part that tells you what you are about to hear.
 *
 * @param {Channel} channel
 * @param {Item[]} items
 * @returns {string}
 */
export function buildM3u(channel, items) {
  const lines = ['#EXTM3U', `#PLAYLIST:${oneLine(channel.title)}`];

  for (const item of items) {
    if (!playable(item)) continue;
    const seconds = Number(item.audio_seconds);
    const duration = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : -1;
    lines.push(`#EXTINF:${duration},${oneLine(entryTitle(item))}`);
    lines.push(item.audio_url);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * PLS, the INI-shaped one every internet radio station hands out.
 *
 * Entries are numbered from 1 and the numbering must be contiguous, so this
 * counts the entries it actually writes rather than reusing the item index —
 * an unplayable item in the middle of the list would otherwise leave a hole,
 * and `NumberOfEntries` would disagree with the file.
 *
 * @param {Channel} channel
 * @param {Item[]} items
 * @returns {string}
 */
export function buildPls(channel, items) {
  const lines = ['[playlist]'];
  let n = 0;

  for (const item of items) {
    if (!playable(item)) continue;
    n += 1;
    const seconds = Number(item.audio_seconds);
    lines.push(`File${n}=${item.audio_url}`);
    lines.push(`Title${n}=${oneLine(entryTitle(item))}`);
    lines.push(`Length${n}=${Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : -1}`);
  }

  lines.push(`NumberOfEntries=${n}`);
  lines.push('Version=2');

  return `${lines.join('\n')}\n`;
}

/**
 * Media types a player can actually open.
 *
 * `video/youtube` is the exception this exists for. It is not a real MIME type
 * and the URL behind it is an *embed page* — an iframe document, not a stream —
 * so a playlist carrying one hands VLC an HTML page and shows the reader an
 * error. It stays in the RSS and JSON output, where an enclosure of an unknown
 * type is merely ignored, and is excluded from the playlists, where it breaks.
 */
const UNPLAYABLE_TYPES = new Set(['video/youtube']);

/**
 * Does this item carry something a media player can be handed?
 *
 * @param {Item} item
 * @returns {boolean}
 */
export function playable(item) {
  const url = String(item?.audio_url ?? '');
  if (!url || !/^https?:\/\//i.test(url)) return false;
  return !UNPLAYABLE_TYPES.has(String(item?.audio_type ?? '').toLowerCase());
}

/**
 * "Publication - Episode", or just the episode when there is no publication.
 *
 * @param {Item} item
 * @returns {string}
 */
function entryTitle(item) {
  const title = String(item.title || '(untitled)').trim();
  const from = String(item.feed_title ?? '').trim();
  return from && from !== title ? `${from} - ${title}` : title;
}

/**
 * Collapse a value onto one line.
 *
 * Both playlist formats are line-based with no escape sequence of any kind, so
 * a newline inside a title does not produce a badly formatted entry — it
 * produces an extra entry, pointing at whatever the rest of the title looks
 * like. Titles come from other people's feeds, so this is a correctness fix
 * rather than a tidiness one.
 *
 * @param {unknown} value
 * @returns {string}
 */
function oneLine(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/**
 * The newest published_at across a set of items, or ''.
 *
 * @param {Item[]} items
 * @returns {string}
 */
function latest(items) {
  let best = '';
  for (const item of items) {
    const at = String(item?.published_at ?? '');
    if (at && at > best) best = at;
  }
  return best;
}

/**
 * An Atom `<id>`, which must be an IRI.
 *
 * A publisher's guid usually is a URL and sometimes is `12345`, which is not a
 * valid id. Anything that is not already absolute gets namespaced under the
 * feed's own address, which keeps it unique and stable without inventing a
 * scheme.
 *
 * @param {Item} item
 * @param {Channel} channel
 * @returns {string}
 */
function atomId(item, channel) {
  const id = String(item?.id ?? '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(id)) return id;
  return `${channel.link}#${encodeURIComponent(id)}`;
}

/** Day and month names, because RFC 822 dates are English regardless of locale. */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * An ISO timestamp as RFC 822, which is what RSS dates are.
 *
 * Built by hand rather than with toUTCString(): that method is specified to
 * produce this format, but it is also the one place a runtime is free to differ
 * on the day-name abbreviations, and a reader that cannot parse pubDate sorts
 * the whole feed wrongly rather than failing loudly.
 *
 * @param {string} iso
 * @returns {string}
 */
export function rfc822(iso) {
  const d = new Date(String(iso ?? ''));
  if (Number.isNaN(d.getTime())) return '';

  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT`
  );
}

/**
 * Seconds as HH:MM:SS, which is what itunes:duration takes.
 *
 * @param {unknown} value
 * @returns {string}
 */
function hms(value) {
  const total = Math.floor(Number(value) || 0);
  if (total <= 0) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/**
 * Escape a value for XML text and attributes alike.
 *
 * Also strips the control characters XML 1.0 forbids outright. They turn up in
 * scraped titles often enough to matter, and there is no escape for them — a
 * document containing one is not ill-formed in a way a parser recovers from,
 * it simply fails.
 *
 * @param {unknown} v
 * @returns {string}
 */
export function esc(v) {
  return String(v ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
