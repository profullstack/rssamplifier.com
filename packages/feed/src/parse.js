import { XMLParser } from 'fast-xml-parser';

import { KIND_BLOG, KIND_NEWS, KIND_PODCAST, KIND_MUSIC, KIND_VIDEO } from './kinds.js';
import { hasPlaylistHeader, parsePlaylist, playlistExtension } from './playlist.js';

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

export { KIND_BLOG, KIND_NEWS, KIND_PODCAST, KIND_MUSIC, KIND_VIDEO };

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
 * How many items the newsroom test reads.
 *
 * More than the five the rest of the classifier samples, because two of its
 * three signals are counts over a window — a publishing rate and a spread of
 * bylines — and five items is not enough of either to tell a daily paper from a
 * blog having a busy week. Twelve is a date parse and a string read per item,
 * on items already in memory.
 */
const NEWS_SAMPLE = 12;

/**
 * Distinct people credited across the sample.
 *
 * A newsroom has a staff and a blog has an author, and that is the one
 * difference between them that survives into the markup. Counted with two
 * corrections learned from the directory:
 *
 * - A byline identical to the item's own title is not a byline. Blot writes the
 *   post's title into `dc:creator` on every entry, so melochroma.com published
 *   twelve posts under twelve "authors" and read as a newspaper.
 * - "By Adam Wren, Dasha Burns and Will Steakin" is three people, and Politico
 *   rotates the order between editions, so counting the string whole made every
 *   edition a new author. Splitting on the separators counts the staff instead.
 * - A handle is not a byline. Writing Stack Exchange credits `KeizerHarm` and
 *   `user86791`, r/PayPie credits `/u/numizmat`, and a forum with a hundred
 *   posters otherwise reads as the best-staffed newsroom in the directory. A
 *   masthead signs people: two words, given name and surname. Reuters and the
 *   desks that sign "Staff" lose their entry here, which costs them a signal
 *   they were not using anyway.
 *
 * @param {any[]} items
 * @returns {number}
 */
function bylineCount(items) {
  const people = new Set();

  for (const item of items) {
    const credited = text(item?.['dc:creator']) || text(item?.author?.name) || text(item?.author);
    const normalized = credited.toLowerCase().replace(/^by\s+/, '').trim();
    if (!normalized || normalized === text(item?.title).toLowerCase()) continue;

    for (const person of normalized.split(/\s*(?:,|;|&|\band\b)\s*/)) {
      // Two words at least, and not so many that this is a sentence in the
      // wrong element.
      const words = person.split(/\s+/).filter(Boolean);
      if (words.length >= 2 && words.length <= 5) people.add(person);
    }
  }

  return people.size;
}

/**
 * How many items a day the feed is publishing, as its own dates tell it.
 *
 * @param {any[]} items
 * @returns {number} 0 when the feed does not date its items usefully
 */
function itemsPerDay(items) {
  const stamps = items
    .map((item) =>
      Date.parse(
        text(item?.pubDate) ||
          text(item?.['dc:date']) ||
          text(item?.published) ||
          text(item?.updated),
      ),
    )
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a);

  // Two items are an interval, not a rate.
  if (stamps.length < 3) return 0;

  // A burst is not a rate either, and the tell is that the newest of it is old.
  // astronotyet.com published twelve posts five minutes apart and davidcancel.com
  // imported nine in an afternoon in 2024; measured as a rate those are 288 and
  // 128 articles a day, which is a wire service. Requiring the run to reach the
  // present is what separates a publishing schedule from an archive that was
  // uploaded all at once.
  if (Date.now() - stamps[0] > FRESH_MS) return 0;

  const days = (stamps[0] - stamps[stamps.length - 1]) / 86_400_000;
  if (!(days > 0)) return 0;

  return (stamps.length - 1) / days;
}

/** How recent the newest item must be before a cadence means anything. */
const FRESH_MS = 7 * 86_400_000;

/**
 * Is every one of these a headlined article?
 *
 * The one thing a newsroom does that a fast blog does not: publish nothing but
 * pieces with a headline on them and a summary under it. A microblog at the
 * same pace is ragged — mitchipedia.tumblr.com posts twenty-five times a day,
 * and three of any twelve are a reblogged image with no title and no text at
 * all, while the rest run from nineteen characters to sixteen hundred. BBC
 * Sport, at the same twenty-five a day, is twelve headlines with a sentence
 * each.
 *
 * Only the pace-alone rule asks for this. A feed that has already shown a staff
 * or a masthead has corroborated itself, and some wires do publish headlines
 * with no summary at all.
 *
 * @param {any[]} items
 * @returns {boolean}
 */
function headlined(items) {
  return items.length > 0 && items.every((item) => text(item?.title) !== '' && bodyLength(item) > 0);
}

/**
 * Does the publisher call itself news?
 *
 * Deliberately narrow. "Daily", "Times", "Post" and "Press" are in the name of
 * as many personal blogs as newspapers, and this phrase is one of only three
 * signals available — a vocabulary that admits "Times like these" would spend a
 * whole signal on nothing. What is left is the words that a blog does not put
 * in its title by accident.
 *
 * @param {any} channel
 * @returns {boolean}
 */
function saysItIsNews(channel) {
  const said = [text(channel?.title), text(channel?.description), text(channel?.subtitle)].join(
    ' · ',
  );
  return /\b(news|headlines|breaking news|newsroom|journalism|newspaper|current affairs)\b/i.test(
    said,
  );
}

/**
 * Is this a newsroom rather than somebody's blog?
 *
 * Nothing in RSS says "this is a news site", so this is inference, and it is
 * built the way the video rule had to be rebuilt: one signal is never enough,
 * because each of the three has a false positive that the other two do not.
 *
 * - **Pace.** A newsroom publishes several articles a day; the directory's
 *   median blog publishes one every fifty days. But a linkblog matches the pace
 *   exactly — mitchipedia.tumblr.com posts twenty-five times a day.
 * - **Bylines.** A staff shows up as many names; a blog has one or none. But a
 *   Stack Exchange feed and a subreddit have hundreds of names and are not news.
 * - **Self-description.** The word "news" in a feed's own title or description.
 *   But half the blogs on the web have a page called News, and the feed for it
 *   publishes twice a year.
 *
 * Requiring two of the three is what rejects each of those: the linkblog has no
 * staff and does not call itself news, the forum publishes slowly, the release
 * notes do both. Measured against 488 blogs sampled at random from the
 * directory it rejects all 488, and against 102 still-publishing feeds from
 * newsrooms whose domains are not in question (BBC, NYT, Guardian, Al Jazeera,
 * DW, Le Monde, NPR, CBS, Politico, Ars Technica) it accepts 88.
 *
 * The one exception to two-of-three is a feed publishing more than twelve
 * articles a day and still doing it today. Nothing in the sampled directory
 * sustains that but a wire, and the big desks — BBC Sport, CBS Politics — carry
 * no bylines and are named for their section rather than for the paper, so they
 * have no second signal to give.
 *
 * What this misses, it misses on purpose: a section feed that is slow, unsigned
 * and named "Books" is indistinguishable from a blog by anything in its
 * markup, and a directory that guesses on one signal is the directory that put
 * 399 blogs under /videos. Those arrive by curation, like comics.
 *
 * @param {any} channel
 * @param {any[]} items raw parsed items
 * @returns {boolean}
 */
function isNewsroom(channel, items) {
  const sample = items.slice(0, NEWS_SAMPLE);
  const perDay = itemsPerDay(sample);
  const bylines = bylineCount(sample);
  const declared = saysItIsNews(channel);

  // A wire, whatever it calls itself and whoever signed it — but it has to be
  // publishing articles, or it is only a busy tumblr.
  if (perDay >= 12 && headlined(sample)) return true;

  // Otherwise two signals, and which pair it is decides how much of each is
  // wanted. A feed already publishing several times a day needs only a hint of
  // corroboration; one publishing twice a week needs a masthead's worth of it.
  if (perDay >= 3 && (bylines >= 2 || declared)) return true;
  if (bylines >= 8 && perDay >= 0.5) return true;
  if (declared && perDay >= 2) return true;

  return false;
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

  // Last, because it is the only test here that reads the publisher rather than
  // the payload, and because everything above it is a stronger claim: a news
  // podcast is a podcast, and a broadcaster's video feed is video.
  if (isNewsroom(channel, items)) return KIND_NEWS;

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
 * The picture on a JSON Feed item.
 *
 * The format names its own fields rather than borrowing Media RSS, so this is
 * the JSON half of `itemImage` and shares only the beacon filter and the
 * absolute-URL rule with it.
 *
 * @param {any} item
 * @param {string} contentHtml
 * @param {string} base
 * @returns {string}
 */
function jsonImage(item, contentHtml, base) {
  const attachments = Array.isArray(item?.attachments) ? item.attachments : [];
  const attached = attachments.find((a) => IMAGE_TYPE.test(String(a?.mime_type ?? '')));

  const candidates = [
    item?.image,
    item?.banner_image,
    attached?.url,
    htmlImage(contentHtml),
  ].map((c) => String(c ?? ''));

  for (const candidate of candidates) {
    if (!candidate || NOT_A_PICTURE.test(candidate)) continue;
    const url = absoluteImage(candidate, base);
    if (url) return url;
  }

  return '';
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

/** An attachment that carries a picture. */
const IMAGE_TYPE = /^image\//i;

/**
 * The URL of an enclosure that is actually an image.
 *
 * `<enclosure>` is how a podcast attaches its audio file, so taking its URL as
 * the item's image — which this used to do unconditionally — put an mp3 in the
 * image slot of every episode of every podcast in the directory.
 *
 * Atom has no `<enclosure>`; the same attachment arrives as a link relation, so
 * both spellings are read here rather than only in the RSS branch.
 *
 * @param {any} item
 * @returns {string}
 */
function enclosureImage(item) {
  const image = arr(item?.enclosure).find((e) => IMAGE_TYPE.test(String(e?.['@type'] ?? '')));
  if (image) return text(image['@url'] ?? '');

  const link = arr(item?.link).find(
    (l) => l?.['@rel'] === 'enclosure' && IMAGE_TYPE.test(String(l?.['@type'] ?? '')),
  );
  return text(link?.['@href'] ?? '');
}

/**
 * The picture a publisher attached with Media RSS.
 *
 * Two elements, and the order between them matters. `media:thumbnail` is by
 * definition a still of the item, so it is what a thumbnail wants; YouTube puts
 * its poster frame there and nowhere else. `media:content` is the media itself,
 * which is only a picture when it says so — a feed of videos has a
 * `media:content` per video, and treating that as the image would put an mp4 in
 * the image slot.
 *
 * Both may sit directly on the item or inside a `media:group`, which is the
 * wrapper for "several renditions of one thing" and is how every YouTube feed is
 * shaped. Looking in only one of the two places is the reason 289 YouTube
 * channels were indexed here without a single thumbnail between them.
 *
 * @param {any} item
 * @returns {string}
 */
function mediaImage(item) {
  // The group first, because an item that has one keeps its media in it.
  const nodes = [item?.['media:group'], item].filter(Boolean);

  for (const node of nodes) {
    // A publisher may offer several sizes. Widest wins, because this is scaled
    // down to a thumbnail either way and the small one is often a 16px favicon.
    const thumbs = arr(node['media:thumbnail'])
      .map((t) => ({ url: text(t?.['@url'] ?? ''), width: Number(t?.['@width'] ?? 0) }))
      .filter((t) => t.url)
      .sort((a, b) => (b.width || 0) - (a.width || 0));
    if (thumbs[0]) return thumbs[0].url;
  }

  for (const node of nodes) {
    const content = arr(node['media:content']).find(
      (c) =>
        IMAGE_TYPE.test(String(c?.['@type'] ?? '')) ||
        String(c?.['@medium'] ?? '').toLowerCase() === 'image',
    );
    if (content) return text(content['@url'] ?? '');
  }

  return '';
}

/**
 * An `<img>` in the feed's own markup that is not a picture of anything.
 *
 * Three kinds, all of them common enough to see on the first page of results:
 *
 * - Beacons. Feed plugins append a 1×1 GIF whose only job is to be requested.
 *   Rendering one as a thumbnail is an invisible box in the listing *and* a hit
 *   on somebody's analytics from every reader who scrolls past it.
 * - Furniture. WordPress rewrites every 🙂 in a post into an `<img>` on
 *   s.w.org, so the "picture" of a post that happens to contain a smiley is a
 *   72px emoji. Badges and avatars are the same problem: a real image, and
 *   never one of what the post is about.
 * - Anything sized like the first two, whatever it is called.
 *
 * Matched loosely on purpose: a false negative here is one bad thumbnail, and a
 * false positive costs a post a picture it had an alternative for anyway.
 */
const NOT_A_PICTURE = new RegExp(
  [
    // The classic spacer filenames, with or without a size suffix.
    String.raw`/(?:pixel|1x1|blank|spacer|clear|dot|beacon|tracker)[-_.]?\d*\.(?:gif|png|jpg)`,
    // Named analytics endpoints that answer with an image.
    String.raw`feedburner\.com/~ff`,
    String.raw`feeds\.wordpress\.com/\d`,
    String.raw`(?:pixel|stats)\.wp\.com`,
    String.raw`stats\.wordpress\.com`,
    String.raw`doubleclick\.net`,
    String.raw`google-analytics\.com`,
    String.raw`/wp-content/plugins/[^"']*(?:pixel|spacer)`,
    // Emoji, rendered as images by WordPress and by Twitter's old widget.
    String.raw`s\.w\.org/images/core/emoji`,
    String.raw`/wp-includes/images/smilies/`,
    String.raw`twemoji`,
    String.raw`twimg\.com/emoji`,
    // A build badge is a fact about a repository, not a picture of a post.
    String.raw`shields\.io`,
    String.raw`badgen\.net`,
    // An author's avatar is the same on every post they have ever written.
    String.raw`gravatar\.com/avatar`,
  ].join('|'),
  'i',
);

/** An `<img>` tag, and separately the bits of one we care about. */
const IMG_TAG = /<img\b[^>]*>/gi;
const IMG_SRC = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const IMG_DIMENSION = /\b(width|height)\s*=\s*["']?(\d+)/gi;

/**
 * The first usable `<img>` in a post's own HTML.
 *
 * A quarter of the directory's posts carry a picture only here: the publisher
 * embedded it in the body and never declared it in a media element. Read at
 * crawl time rather than at render time so the listing pages stay one query,
 * and so the choice is made once per post instead of once per view.
 *
 * Regex rather than a DOM parse because this runs over every item of every feed
 * on every crawl, and the shape being looked for is one attribute of one tag.
 * The worst case for a mis-parse is no thumbnail.
 *
 * @param {string} html
 * @returns {string}
 */
function htmlImage(html) {
  if (!html || !html.includes('<img')) return '';

  for (const tag of html.match(IMG_TAG) ?? []) {
    const src = (IMG_SRC.exec(tag) ?? []).slice(1).find(Boolean);
    if (!src) continue;

    // A tag that declares itself tiny is a beacon whatever it is called.
    let tiny = false;
    for (const [, , value] of tag.matchAll(IMG_DIMENSION)) {
      if (Number(value) <= 2) tiny = true;
    }
    if (tiny) continue;

    const decoded = src.replace(/&amp;/gi, '&').trim();
    if (decoded && !NOT_A_PICTURE.test(decoded)) return decoded;
  }

  return '';
}

/**
 * Resolve an image reference against the page it was published on.
 *
 * Feeds carry relative `src` attributes far more often than they should, and a
 * relative URL stored here would resolve against *our* origin when the listing
 * renders it — a 404 on rssamplifier.com for an image that exists on the
 * publisher's site.
 *
 * Anything that is not http(s) after resolution is dropped rather than passed
 * on: a `data:` image would be a base64 blob in a database column and on every
 * listing page that shows it, and no other scheme can be rendered at all.
 *
 * @param {string} raw
 * @param {string} base
 * @returns {string}
 */
function absoluteImage(raw, base) {
  const candidate = String(raw ?? '').trim();
  if (!candidate) return '';

  try {
    const url = new URL(candidate, base || undefined);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.href;
  } catch {
    return '';
  }
}

/**
 * The picture that best represents one item, from wherever it is hiding.
 *
 * Order is most-deliberate-first: an element whose whole purpose is "this is the
 * image for this item" beats an attachment, which beats a frame grab we derived,
 * which beats the first thing in the body. Only the last of these can be wrong
 * about what the post is *about*, and it is also the only one that a fifth of
 * the directory has.
 *
 * @param {any} item
 * @param {string} contentHtml
 * @param {string} base URL to resolve a relative reference against.
 * @returns {string}
 */
function itemImage(item, contentHtml, base) {
  const candidates = [
    mediaImage(item),
    enclosureImage(item),
    // Episode art, where a podcast sets it per episode rather than per show.
    text(item?.['itunes:image']),
    youTubeStill(item),
    htmlImage(contentHtml),
  ];

  for (const candidate of candidates) {
    if (!candidate || NOT_A_PICTURE.test(candidate)) continue;
    const url = absoluteImage(candidate, base);
    if (url) return url;
  }

  return '';
}

/**
 * A YouTube video's poster frame, from its id.
 *
 * Only reached when `media:group` had no thumbnail, which happens when a feed
 * has been through a proxy or a reader service that dropped the media elements
 * and kept `yt:videoId`. The URL is a documented, stable one, and the id is
 * validated the same way the embed URL validates it.
 *
 * @param {any} item
 * @returns {string}
 */
function youTubeStill(item) {
  const videoId = text(item?.['yt:videoId']);
  if (!videoId || !/^[\w-]{6,20}$/.test(videoId)) return '';
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
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
  if (trimmed.startsWith('{')) return parseJsonFeed(trimmed, feedUrl);

  // A playlist is a feed in everything but format. Checked before the XML
  // parser rather than after it, because the plain form of the format is a
  // list of bare URLs that no parser rejects loudly enough to fall through.
  if (isPlaylist(trimmed, feedUrl)) return parsePlaylist(trimmed, feedUrl);

  let doc;
  try {
    doc = parser.parse(trimmed);
  } catch {
    return null;
  }

  if (doc?.rss?.channel) return parseRss(doc.rss.channel, feedUrl);
  if (doc?.feed) return parseAtom(doc.feed, feedUrl);
  // RSS 1.0 / RDF keeps channel and items as siblings under rdf:RDF.
  if (doc?.['rdf:RDF']) return parseRdf(doc['rdf:RDF'], feedUrl);

  return null;
}

/**
 * Is this document a playlist rather than a feed?
 *
 * The header answers on its own. Failing that, the extension answers for a
 * document that is plainly not markup, which is the plain form of m3u: no
 * header, no titles, one path per line.
 *
 * @param {string} trimmed
 * @param {string} feedUrl
 * @returns {boolean}
 */
function isPlaylist(trimmed, feedUrl) {
  if (hasPlaylistHeader(trimmed)) return true;
  return Boolean(playlistExtension(feedUrl)) && !trimmed.startsWith('<');
}

/**
 * @param {any} ch
 * @param {string} [feedUrl] Where the document was fetched from, so a relative
 *   image reference resolves against the publisher's site and not against ours.
 */
function parseRss(ch, feedUrl = '') {
  const raw = arr(ch.item);
  const siteUrl = text(ch.link);
  const items = raw.map((it) => {
    const contentHtml = text(it['content:encoded']) || text(it.description);
    const url = text(it.link);
    return {
      guid: text(it.guid) || url || text(it.title),
      url,
      title: text(it.title) || '(untitled)',
      summary: summarize(text(it.description) || contentHtml),
      contentHtml,
      author: text(it['dc:creator']) || text(it.author),
      publishedAt: date(it.pubDate) || date(it['dc:date']),
      imageUrl: itemImage(it, contentHtml, url || siteUrl || feedUrl),
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
    // optional and podcast hosts do not always emit it. Absolute-ised for the
    // same reason an item's image is: a feed's cover art now renders as the
    // avatar beside its name, and a relative path there would point at us.
    imageUrl: absoluteImage(
      text(ch.image?.url) || text(ch['itunes:image']?.['@href']) || text(ch['itunes:image']),
      siteUrl || feedUrl,
    ),
    categories: categories(ch),
    kind: kindOfChannel(ch, raw),
    items,
  };
}

/**
 * @param {any} feed
 * @param {string} [feedUrl]
 */
function parseAtom(feed, feedUrl = '') {
  const entries = arr(feed.entry);
  const siteUrl = atomLink(feed.link);
  const items = entries.map((e) => {
    const contentHtml = text(e.content) || text(e.summary);
    const url = atomLink(e.link);
    return {
      guid: text(e.id) || url,
      url,
      title: text(e.title) || '(untitled)',
      summary: summarize(text(e.summary) || contentHtml),
      contentHtml,
      author: text(e.author?.name),
      publishedAt: date(e.published) || date(e.updated),
      // Atom entries used to be stored with no image at all, which is why every
      // YouTube channel in the directory is text-only: its poster frame is in a
      // `media:group`, and nothing here looked inside one.
      imageUrl: itemImage(e, contentHtml, url || siteUrl || feedUrl),
      categories: categories(e),
      audio: audioEnclosure(e),
    };
  });

  // YouTube publishes Atom, so this is the format its channel feeds arrive in.
  const kind = kindOfChannel(feed, entries);

  return {
    title: text(feed.title) || '(untitled)',
    description: summarize(text(feed.subtitle), 500),
    siteUrl,
    language: text(feed['@xml:lang']),
    imageUrl: absoluteImage(text(feed.logo) || text(feed.icon), siteUrl || feedUrl),
    categories: categories(feed),
    kind,
    items,
  };
}

/**
 * @param {any} rdf
 * @param {string} [feedUrl]
 */
function parseRdf(rdf, feedUrl = '') {
  const ch = rdf.channel ?? {};
  const raw = arr(rdf.item);
  const siteUrl = text(ch.link);
  const items = raw.map((it) => {
    const contentHtml = text(it['content:encoded']) || text(it.description);
    const url = text(it.link);
    return {
      guid: text(it['@rdf:about']) || url,
      url,
      title: text(it.title) || '(untitled)',
      summary: summarize(text(it.description)),
      contentHtml,
      author: text(it['dc:creator']),
      publishedAt: date(it['dc:date']),
      imageUrl: itemImage(it, contentHtml, url || siteUrl || feedUrl),
      categories: categories(it),
      audio: audioEnclosure(it),
    };
  });

  return {
    title: text(ch.title) || '(untitled)',
    description: summarize(text(ch.description), 500),
    siteUrl,
    language: '',
    // RSS 1.0 has an <image> of its own, as a sibling of the channel.
    imageUrl: absoluteImage(text(rdf.image?.url) || text(ch.image?.['@rdf:resource']), siteUrl || feedUrl),
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
function parseJsonFeed(raw, feedUrl = '') {
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!j || !Array.isArray(j.items)) return null;

  const siteUrl = j.home_page_url ?? '';
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
      // JSON Feed has two image fields and an attachment list. `image` is the
      // one meant for the item; `banner_image` is explicitly the wide one for
      // the top of a page, which is still better than nothing.
      imageUrl: jsonImage(it, contentHtml, it.url || siteUrl || feedUrl),
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
    siteUrl,
    language: j.language ?? '',
    imageUrl: absoluteImage(j.icon ?? j.favicon ?? '', siteUrl || feedUrl),
    categories: [],
    // JSON Feed states the podcast claim in an extension rather than a
    // namespace. It has no equivalent of `podcast:medium`, so a JSON Feed can
    // only reach the music category by curation.
    kind: j._itunes ? KIND_PODCAST : video ? KIND_VIDEO : KIND_BLOG,
    items,
  };
}
