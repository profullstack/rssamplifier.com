import { USER_AGENT } from './list.js';

/**
 * Candidate feeds from the PeerTube federation.
 *
 * PeerTube is the one live-video source on the open web that needs no
 * credentials from anybody: it publishes a directory of instances, each
 * instance says whether it has live streaming turned on, and every instance
 * serves its videos as RSS — including, with one query parameter, only the
 * live ones.
 *
 * That parameter is why /lives can exist at all. Nothing else in this space
 * offers it: Twitch has no RSS, and a YouTube channel feed does not say which
 * of its entries were streams.
 */

/** The community-run instance directory. */
const DIRECTORY = 'https://instances.joinpeertube.org/api/v1/instances';

/**
 * Instances asked for per pass.
 *
 * There are ~1,800 of them and most are tiny. Sorted by size, so a pass covers
 * the instances most likely to have anything, and bounded so discovery never
 * turns into a sweep of the whole federation in one go.
 */
const DEFAULT_INSTANCES = 40;

/**
 * The feed URL for one instance.
 *
 * `isLive=true` is the whole trick. Without it this is an ordinary video feed;
 * with it, the instance serves only what is streaming — which is a category
 * nothing else on the open web can express.
 *
 * @param {string} host
 * @param {boolean} live
 * @returns {string}
 */
export function instanceFeedUrl(host, live) {
  return `https://${host}/feeds/videos.xml${live ? '?isLive=true' : ''}`;
}

/**
 * Ask the directory for instances worth reading.
 *
 * @param {{ fetchImpl?: typeof fetch, count?: number, live?: boolean, signal?: AbortSignal }} [opts]
 * @returns {Promise<string[]>} hostnames
 */
export async function peertubeInstances(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const count = opts.count ?? DEFAULT_INSTANCES;

  const url = new URL(DIRECTORY);
  url.searchParams.set('count', String(count));
  url.searchParams.set('sort', '-totalVideos');
  // Asking the directory to filter is cheaper than fetching every instance and
  // discarding the ones that cannot stream.
  if (opts.live) url.searchParams.set('liveEnabled', 'true');

  const response = await fetchImpl(url.toString(), {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    signal: opts.signal,
  });

  if (!response.ok) throw new Error(`instance directory failed: ${response.status}`);

  const body = await response.json();
  const rows = Array.isArray(body?.data) ? body.data : [];

  return rows
    .filter((row) => {
      if (!row?.host) return false;
      // The filter is applied here as well as in the query: the directory has
      // been known to ignore unfamiliar parameters rather than reject them,
      // and a silently unfiltered response would fill /lives with instances
      // that cannot stream.
      if (opts.live && row.liveEnabled === false) return false;
      return true;
    })
    .map((row) => String(row.host))
    // A hostname is going straight into a URL, so anything that is not one is
    // dropped rather than trusted.
    .filter((host) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host));
}

/**
 * @param {{ fetchImpl?: typeof fetch, count?: number, live?: boolean, limit?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<string[]>}
 */
export async function peertubeCandidates(opts = {}) {
  const hosts = await peertubeInstances(opts);
  const urls = hosts.map((host) => instanceFeedUrl(host, Boolean(opts.live)));
  return opts.limit ? urls.slice(0, opts.limit) : urls;
}
