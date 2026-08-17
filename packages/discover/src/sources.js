import { q, discovery } from '@rssamplifier/db';

import { candidatesFromList } from './list.js';
import { musicCandidates } from './music.js';
import { peertubeCandidates } from './peertube.js';
import { youtubePlaylistCandidates } from './youtube.js';

/**
 * Where feeds come from when nobody submits them.
 *
 * Keyword discovery answers "what is out there about X". These answer a
 * different question — "what already exists that we have not got" — and they
 * are the only way three of the directory's categories can be filled at all:
 * no parser can tell a webcomic from a blog, and nothing but PeerTube says
 * "this video is live" in RSS.
 *
 * A source is a function returning candidate URLs. It does no fetching of
 * feeds and no writing to the directory; run.js queues what it returns into
 * the same pipeline keyword discovery uses, so a candidate found here is
 * resolved, vetted and promoted by exactly the code that already does that.
 *
 * `curated` is the important flag. It means somebody maintains this list by
 * hand, which buys two things: the worthiness heuristic is skipped (it was
 * tuned to reject what search engines return, and would reject half a comics
 * list), and the category is stamped so the crawler does not re-derive it.
 */

/** Kagi's Small Web lists — the same catalogues this directory grew from. */
const KAGI = 'https://raw.githubusercontent.com/kagisearch/smallweb/main';

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   category: string|null,
 *   curated: boolean,
 *   everyHours: number,
 *   limit: number,
 *   run: (opts?: object) => Promise<string[]>,
 *   context?: (db: import('@libsql/client').Client) => Promise<object>,
 * }} Source
 */

/**
 * `context` is for the one source that starts from the directory rather than
 * from somebody else's list. Everything else here reads a URL and needs to know
 * nothing; the playlist source needs the channels we already hold and how many
 * times it has run. Kept as a hook on the source rather than a special case in
 * run.js, so the runner stays a runner.
 */

/** @type {Source[]} */
export const SOURCES = [
  {
    id: 'kagi-yt',
    label: 'Kagi Small Web — YouTube channels',
    // The list is of channels, and a YouTube feed parses as video anyway; the
    // category is stamped because membership of the list is the claim, not the
    // parse.
    category: 'video',
    curated: true,
    everyHours: 24,
    limit: 400,
    run: (opts) => candidatesFromList(`${KAGI}/smallyt.txt`, opts),
  },
  {
    id: 'youtube-playlists',
    label: 'YouTube — playlists on channels we already index',
    // A playlist feed is YouTube Atom and parses as video on its own, exactly
    // as the channel feeds do, so there is nothing to stamp.
    category: null,
    // Not curated, and this is the one source where that word would be actively
    // misleading: nobody vouched for these playlists. A person vouched for the
    // *channel*, which is a weaker claim, and the series check downstream is
    // what turns it into a decision. Curated would skip that check.
    curated: false,
    // Twice a day, forty channels a pass — the whole set comes round in about
    // four days. Playlists appear when somebody finishes a course, which is not
    // a thing that happens hourly.
    everyHours: 12,
    limit: 200,
    context: async (db) => ({
      channels: await q.youtubeChannelIds(db),
      runNumber: await discovery.countRuns(db, 'youtube-playlists'),
    }),
    run: (opts) => youtubePlaylistCandidates(opts),
  },
  {
    id: 'kagi-comics',
    label: 'Kagi Small Web — webcomics',
    // The only way /comics is ever filled.
    category: 'comic',
    curated: true,
    everyHours: 24,
    limit: 400,
    run: (opts) => candidatesFromList(`${KAGI}/smallcomic.txt`, opts),
  },
  {
    id: 'music',
    label: 'Albums, netlabels and mixes — kept by hand',
    // The only way /music is ever filled. Half of these declare themselves with
    // podcast:medium and would be filed correctly on their own; the other half
    // — Funkwhale channels, netlabel collections, freeform radio — are
    // indistinguishable from a blog with an mp3 in it, which is what the
    // category used to be full of.
    category: 'music',
    curated: true,
    // The list is in this repo rather than on somebody's server, so re-reading
    // it costs nothing and finds nothing new until it is edited. Daily is here
    // to pick up the additions, not to poll.
    everyHours: 24,
    limit: 400,
    run: (opts) => musicCandidates(opts),
  },
  {
    id: 'peertube-live',
    label: 'PeerTube — instances that stream live',
    category: 'live',
    curated: true,
    // Live is the one thing here with a shelf life, but the *feed* is not: the
    // feed is permanent and its contents change. Twice a day is about how often
    // a new instance turns up.
    everyHours: 12,
    limit: 60,
    run: (opts) => peertubeCandidates({ ...opts, live: true }),
  },
  {
    id: 'peertube',
    label: 'PeerTube — federated video',
    // Not curated: an instance feed parses as video on its own, and the
    // instance directory is generated rather than maintained, so there is
    // nobody vouching for any particular instance being worth indexing.
    category: null,
    curated: false,
    everyHours: 24,
    limit: 40,
    run: (opts) => peertubeCandidates({ ...opts, live: false }),
  },
];

/**
 * Sources that cannot exist here, and why.
 *
 * In the code rather than a comment because "why is /reels empty" is a
 * question that will be asked more than once, and the answer is a fact about
 * those platforms rather than a gap in this directory.
 */
export const UNAVAILABLE = [
  {
    id: 'twitch',
    reason:
      'Twitch publishes no RSS at all, so a Twitch channel cannot be a row in a feed directory. Only a third-party bridge can produce one, which would make a whole category depend on somebody else’s uptime.',
  },
  {
    id: 'youtube-live',
    reason:
      'A YouTube channel feed does not mark which entries were livestreams, so live cannot be told from uploaded without the YouTube Data API — and the feed to store would still be the channel feed, which /videos already has.',
  },
  {
    id: 'reels',
    reason:
      'No short-form platform publishes RSS. TikTok and Instagram publish none, and YouTube’s feed does not distinguish a Short from an upload.',
  },
];

/**
 * @param {string} id
 * @returns {Source|null}
 */
export function sourceById(id) {
  return SOURCES.find((source) => source.id === id) ?? null;
}

/**
 * Which sources are due, given when each last ran.
 *
 * @param {Record<string, string|null>} lastRunAt provider id → ISO timestamp
 * @param {Date} [now]
 * @returns {Source[]}
 */
export function dueSources(lastRunAt = {}, now = new Date()) {
  return SOURCES.filter((source) => {
    const last = lastRunAt[source.id];
    if (!last) return true;

    const age = now.getTime() - new Date(last).getTime();
    return !Number.isFinite(age) || age >= source.everyHours * 3_600_000;
  });
}
