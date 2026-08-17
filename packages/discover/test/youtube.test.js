import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  channelIdFromFeedUrl,
  channelPlaylists,
  channelPlaylistsUrl,
  parsePlaylistIds,
  playlistFeedUrl,
  rotate,
  youtubePlaylistCandidates,
} from '../src/youtube.js';

/**
 * A fetch that answers per URL, and records what it was asked for.
 *
 * @param {Record<string, { body?: string, status?: number, fail?: boolean }>} routes
 */
function stubFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const route = routes[String(url)] ?? {};
    if (route.fail) throw new Error('connection reset');
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      text: async () => route.body ?? '',
    };
  };
  impl.calls = calls;
  return impl;
}

/** The markup a channel's playlists tab actually carries, trimmed to the ids. */
function playlistsPage(ids) {
  return ids.map((id) => `{"playlistId":"${id}","thumbnail":{}}`).join(',');
}

// ------------------------------------------------------------------- URLs

test('a playlist id becomes the feed the directory will store', () => {
  assert.equal(
    playlistFeedUrl('PLNPUF5QyWU8PydLG2cIJrCvnn5I_exhYx'),
    'https://www.youtube.com/feeds/videos.xml?playlist_id=PLNPUF5QyWU8PydLG2cIJrCvnn5I_exhYx',
  );
});

test('the channel id is read back out of a channel feed URL', () => {
  assert.equal(
    channelIdFromFeedUrl(
      'https://www.youtube.com/feeds/videos.xml?channel_id=UCekZUWSJkX9kHuvfPbt_gvg',
    ),
    'UCekZUWSJkX9kHuvfPbt_gvg',
  );
  assert.equal(channelIdFromFeedUrl('https://example.com/feed.xml'), null);
  assert.equal(channelIdFromFeedUrl(undefined), null);
});

test('the playlists tab is addressed by channel id', () => {
  assert.equal(
    channelPlaylistsUrl('UC_A1234567890'),
    'https://www.youtube.com/channel/UC_A1234567890/playlists',
  );
});

// --------------------------------------------------------------- parsing

test('playlist ids are read out of the page in order, without duplicates', () => {
  const html = playlistsPage([
    'PLNPUF5QyWU8PydLG2cIJrCvnn5I_exhYx',
    'PLNPUF5QyWU8O0Wd8QDh9KaM1ggsxspJ31',
    'PLNPUF5QyWU8PydLG2cIJrCvnn5I_exhYx',
  ]);

  assert.deepEqual(parsePlaylistIds(html), [
    'PLNPUF5QyWU8PydLG2cIJrCvnn5I_exhYx',
    'PLNPUF5QyWU8O0Wd8QDh9KaM1ggsxspJ31',
  ]);
});

test("YouTube's own pseudo-playlists are not works and are dropped", () => {
  // Every one of these is a view of an account rather than something a person
  // assembled. WL is on the real page markup; UU is the uploads list, which is
  // the channel feed the directory already holds under a second address.
  const html = playlistsPage([
    'WL',
    'LL',
    'UUekZUWSJkX9kHuvfPbt_gvg',
    'FLekZUWSJkX9kHuvfPbt_gvg',
    'RDekZUWSJkX9kHuvfPbt_gvg',
    'PLNPUF5QyWU8PydLG2cIJrCvnn5I_exhYx',
  ]);

  assert.deepEqual(parsePlaylistIds(html), ['PLNPUF5QyWU8PydLG2cIJrCvnn5I_exhYx']);
});

test('a page with nothing in it is not an error', () => {
  assert.deepEqual(parsePlaylistIds(''), []);
  assert.deepEqual(parsePlaylistIds(undefined), []);
});

// ------------------------------------------------------- one channel at a time

test('a channel that answers gives up its playlists', async () => {
  const url = channelPlaylistsUrl('UC_A1234567890');
  const fetchImpl = stubFetch({
    [url]: { body: playlistsPage(['PLaaaaaaaaaaaaaa', 'PLbbbbbbbbbbbbbb']) },
  });

  assert.deepEqual(await channelPlaylists('UC_A1234567890', { fetchImpl }), [
    'PLaaaaaaaaaaaaaa',
    'PLbbbbbbbbbbbbbb',
  ]);
});

test('a deleted, private or unreachable channel returns nothing rather than throwing', async () => {
  const gone = stubFetch({ [channelPlaylistsUrl('UC_A1234567890')]: { status: 404 } });
  assert.deepEqual(await channelPlaylists('UC_A1234567890', { fetchImpl: gone }), []);

  const broken = stubFetch({ [channelPlaylistsUrl('UC_A1234567890')]: { fail: true } });
  assert.deepEqual(await channelPlaylists('UC_A1234567890', { fetchImpl: broken }), []);
});

// -------------------------------------------------------------- rotation

test('rotation walks the whole list across successive runs', () => {
  const channels = ['a', 'b', 'c', 'd', 'e'];

  assert.deepEqual(rotate(channels, 0, 2), ['a', 'b']);
  assert.deepEqual(rotate(channels, 1, 2), ['c', 'd']);
  // Wraps rather than returning a short final batch.
  assert.deepEqual(rotate(channels, 2, 2), ['e', 'a']);
});

test('a batch bigger than the list is the whole list, once', () => {
  assert.deepEqual(rotate(['a', 'b'], 3, 40), ['a', 'b']);
  assert.deepEqual(rotate([], 0, 40), []);
  assert.deepEqual(rotate(['a'], 0, 0), []);
});

// ----------------------------------------------------------- the whole pass

test('a pass reads its slice of channels and returns playlist feeds', async () => {
  const fetchImpl = stubFetch({
    [channelPlaylistsUrl('UC_A')]: { body: playlistsPage(['PLaaaaaaaaaaaaaa']) },
    [channelPlaylistsUrl('UC_B')]: { body: playlistsPage(['PLbbbbbbbbbbbbbb']) },
    [channelPlaylistsUrl('UC_C')]: { body: playlistsPage(['PLcccccccccccccc']) },
  });

  const urls = await youtubePlaylistCandidates({
    channels: ['UC_A', 'UC_B', 'UC_C'],
    runNumber: 0,
    batch: 2,
    fetchImpl,
  });

  assert.deepEqual(urls, [playlistFeedUrl('PLaaaaaaaaaaaaaa'), playlistFeedUrl('PLbbbbbbbbbbbbbb')]);
  // The third channel belongs to the next pass and must not have been touched.
  assert.equal(fetchImpl.calls.length, 2);
  assert.ok(!fetchImpl.calls.includes(channelPlaylistsUrl('UC_C')));
});

test('the same playlist on two channels is queued once', async () => {
  const shared = playlistsPage(['PLaaaaaaaaaaaaaa']);
  const fetchImpl = stubFetch({
    [channelPlaylistsUrl('UC_A')]: { body: shared },
    [channelPlaylistsUrl('UC_B')]: { body: shared },
  });

  const urls = await youtubePlaylistCandidates({
    channels: ['UC_A', 'UC_B'],
    batch: 2,
    fetchImpl,
  });

  assert.deepEqual(urls, [playlistFeedUrl('PLaaaaaaaaaaaaaa')]);
});

test('the limit bounds what one pass queues', async () => {
  const fetchImpl = stubFetch({
    [channelPlaylistsUrl('UC_A')]: {
      body: playlistsPage(['PLaaaaaaaaaaaaaa', 'PLbbbbbbbbbbbbbb', 'PLcccccccccccccc']),
    },
  });

  const urls = await youtubePlaylistCandidates({
    channels: ['UC_A'],
    batch: 1,
    limit: 2,
    fetchImpl,
  });

  assert.equal(urls.length, 2);
});

test('no channels means no requests', async () => {
  const fetchImpl = stubFetch({});
  assert.deepEqual(await youtubePlaylistCandidates({ channels: [], fetchImpl }), []);
  assert.equal(fetchImpl.calls.length, 0);
});
