#!/usr/bin/env node
/**
 * Build a list of music feeds from every index that will hand one over.
 *
 * The hand-kept list in `packages/discover/src/music.js` is what the directory
 * crawls, and it is small on purpose — every URL in it was fetched and checked.
 * This is the other thing: a sweep of the four places that will enumerate music
 * feeds in bulk, for when you want the whole population rather than a vetted
 * slice. It writes a plain list of URLs and does not touch the database.
 *
 * The four:
 *
 *   v4vmusic      An open JSON API over the value-for-value music scene, which
 *                 is where albums-as-RSS actually live. ~8.6k feeds, nearly all
 *                 declaring podcast:medium=music. Retired LNBeats redirects
 *                 here. This is the bulk of the result.
 *   podcastindex  Podcast Index can filter by medium=music but wants an API
 *                 key, and its public dump is behind Cloudflare. This reads a
 *                 key-free snapshot of that query instead, which is stale
 *                 enough to mostly duplicate v4vmusic but still adds a couple
 *                 hundred.
 *   archive.org   Every sub-collection of `netlabels` is a label, and each has
 *                 a collection feed with real audio enclosures. This is the
 *                 netlabel scene's surviving distribution — the directories
 *                 that used to index it are all dead. Deep paging caps out
 *                 around 1.7k of the 2k collections.
 *   funkwhale     A pod will list its music channels, and a channel is an
 *                 artist's uploads as RSS.
 *
 * Usage: node scripts/harvest-music-feeds.js out.txt [out-annotated.txt]
 *
 * Be gentle with what comes out. wavlake.com is about two thirds of the result
 * and answers 429 to anything parallel; archive.org 502s under load. Both are
 * fine at roughly one request every couple of seconds, and a crawl that ignores
 * that will conclude the feeds are dead when they are not.
 */

import { writeFileSync } from 'node:fs';

const UA = { 'user-agent': 'rssamplifier-harvest/1.0' };

/**
 * @param {string} url
 * @param {number} [attempts]
 * @returns {Promise<any>}
 */
async function getJson(url, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 45000);
      const res = await fetch(url, { headers: UA, signal: ac.signal });
      clearTimeout(timer);
      if (res.ok) return await res.json();
    } catch {
      // Retried below; a source being down is not worth aborting the sweep for.
    }
    await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
  }
  return null;
}

/** @returns {Promise<Array<{url: string, note: string}>>} */
async function v4vmusic() {
  const out = [];
  for (let page = 1; page <= 200; page++) {
    const data = await getJson(`https://v4vmusic.com/api/albums?limit=100&page=${page}`);
    if (!data) continue;
    for (const a of data.results ?? []) {
      if (!a.feedUrl || !/^music/i.test(String(a.medium ?? ''))) continue;
      out.push({
        url: String(a.feedUrl),
        note: [a.artistName, a.title].filter(Boolean).join(' — '),
      });
    }
    if (!data.hasMore) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return out;
}

/** @returns {Promise<Array<{url: string, note: string}>>} */
async function podcastIndexSnapshot() {
  const j = await getJson(
    'https://raw.githubusercontent.com/ChadFarrow/lnbeats/master/updateMusicFiles/dbAlbums.json',
  );
  const arr = Array.isArray(j) ? j : (j?.albums ?? j?.feeds ?? []);
  return arr
    .map((a) => a?.feedUrl ?? a?.url ?? a?.originalUrl)
    .filter(Boolean)
    .map((u) => ({ url: String(u), note: '' }));
}

/** @returns {Promise<Array<{url: string, note: string}>>} */
async function archiveNetlabels() {
  const ids = new Set();
  let found = 0;

  for (let page = 1; page <= 25; page++) {
    const url =
      'https://archive.org/advancedsearch.php?q=' +
      encodeURIComponent('collection:netlabels AND mediatype:collection') +
      `&fl[]=identifier&rows=100&page=${page}&output=json`;

    const j = await getJson(url, 5);
    const docs = j?.response?.docs ?? [];
    found = Number(j?.response?.numFound ?? found);
    for (const d of docs) if (d.identifier) ids.add(String(d.identifier));
    if (docs.length === 0 && page > 3) break;
    await new Promise((r) => setTimeout(r, 1500));
  }

  if (found && ids.size < found) {
    console.error(`archive.org: ${ids.size} of ${found} — deep paging is capped`);
  }
  return [...ids].map((id) => ({
    url: `https://archive.org/services/collection-rss.php?collection=${id}`,
    note: id,
  }));
}

/** @returns {Promise<Array<{url: string, note: string}>>} */
async function funkwhaleChannels() {
  const pods = new Set(['open.audio', 'funkwhale.it', 'audio.anartist.org', 'stereo.kenobit.it']);

  const network = await getJson('https://network.funkwhale.audio/api/domains?page_size=100', 2);
  for (const d of network?.results ?? network?.data ?? []) {
    const name = typeof d === 'string' ? d : (d?.name ?? d?.domain);
    if (name) pods.add(String(name));
  }

  const feeds = new Set();
  const list = [...pods];
  let i = 0;

  async function worker() {
    while (i < list.length) {
      const pod = list[i++];
      // A pod is on one API version or the other, and says so only by answering.
      for (const v of ['v2', 'v1']) {
        const j = await getJson(
          `https://${pod}/api/${v}/channels/?content_category=music&page_size=100`,
          1,
        );
        const results = j?.results ?? [];
        if (results.length === 0) continue;
        for (const c of results) {
          if (c?.rss_url) feeds.add(String(c.rss_url));
          else if (c?.uuid) feeds.add(`https://${pod}/api/${v}/channels/${c.uuid}/rss`);
        }
        break;
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));

  return [...feeds].map((u) => ({ url: u, note: '' }));
}

/**
 * One key per addressable feed, so http/https, www and a stray slash are one.
 *
 * @param {string} url
 * @returns {string}
 */
function key(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return '';
  }
}

const [outPlain, outNoted] = process.argv.slice(2);
if (!outPlain) {
  console.error('usage: node scripts/harvest-music-feeds.js out.txt [out-annotated.txt]');
  process.exit(1);
}

const { MUSIC_FEEDS } = await import('../packages/discover/src/music.js');

const groups = [
  ['hand-checked', MUSIC_FEEDS.map((u) => ({ url: u, note: '' }))],
  ['v4vmusic', await v4vmusic()],
  ['podcastindex-snapshot', await podcastIndexSnapshot()],
  ['archive.org-netlabel', await archiveNetlabels()],
  ['funkwhale', await funkwhaleChannels()],
];

const seen = new Map();
const counts = {};

for (const [source, rows] of groups) {
  counts[source] = 0;
  for (const row of rows) {
    // Literal spaces are common in these — the feeds are hand-uploaded files
    // named after the album — and most HTTP clients refuse them outright.
    const url = String(row.url ?? '').trim().replace(/ /g, '%20');
    if (!/^https?:\/\//i.test(url)) continue;

    const k = key(url);
    if (!k || seen.has(k)) continue;

    seen.set(k, { url, note: row.note ?? '' });
    counts[source]++;
  }
}

const rows = [...seen.values()];
writeFileSync(outPlain, `${rows.map((r) => r.url).join('\n')}\n`);
if (outNoted) {
  writeFileSync(outNoted, `${rows.map((r) => (r.note ? `${r.url}  # ${r.note}` : r.url)).join('\n')}\n`);
}

const hosts = new Set(rows.map((r) => new URL(r.url).hostname.replace(/^www\./, '').toLowerCase()));
console.error(`${rows.length} feeds across ${hosts.size} hosts`);
console.error(`new per source: ${JSON.stringify(counts)}`);
