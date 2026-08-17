import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePlaylist, looksLikePlaylist, findPlaylistLinks } from '../src/playlist.js';
import { parseFeed } from '../src/parse.js';
import { looksLikeFeed } from '../src/discover.js';

const ALBUM = `#EXTM3U
#PLAYLIST:Selected Ambient Works
#EXTGENRE:Ambient
#EXTIMG:cover.jpg
#EXTINF:311,Aphex Twin - Xtal
https://netlabel.example/tracks/xtal.mp3
#EXTINF:401,Aphex Twin - Tha
tha.flac
#EXTINF:-1,Untitled Sketch
sketch.ogg
`;

test('an extended m3u parses into tracks', () => {
  const feed = parsePlaylist(ALBUM, 'https://netlabel.example/albums/swa.m3u');

  assert.equal(feed.title, 'Selected Ambient Works');
  assert.equal(feed.kind, 'music');
  assert.equal(feed.siteUrl, 'https://netlabel.example');
  assert.equal(feed.imageUrl, 'https://netlabel.example/albums/cover.jpg');
  assert.deepEqual(feed.categories, ['Ambient']);
  assert.equal(feed.items.length, 3);
});

test('an entry is media with no page, so the file is its own permalink', () => {
  const [first] = parsePlaylist(ALBUM, 'https://netlabel.example/albums/swa.m3u').items;

  assert.equal(first.url, 'https://netlabel.example/tracks/xtal.mp3');
  assert.equal(first.guid, first.url);
  assert.equal(first.publishedAt, null);
  assert.deepEqual(first.audio, {
    url: 'https://netlabel.example/tracks/xtal.mp3',
    type: 'audio/mpeg',
    bytes: null,
    seconds: 311,
  });
});

test('"Artist - Title" is split, because a music directory needs the artist', () => {
  const [xtal] = parsePlaylist(ALBUM, 'https://netlabel.example/albums/swa.m3u').items;

  assert.equal(xtal.author, 'Aphex Twin');
  assert.equal(xtal.title, 'Xtal');
});

test('numbering is not an artist', () => {
  const m3u = `#EXTM3U
#EXTINF:120,01 - Intro
https://x.example/1.mp3
#EXTINF:120,S01E02 - The Reveal
https://x.example/2.mp3
#EXTINF:120,Ep 3 - Aftermath
https://x.example/3.mp3
`;
  const items = parsePlaylist(m3u, 'https://x.example/s.m3u').items;

  assert.deepEqual(
    items.map((i) => [i.author, i.title]),
    [
      ['', '01 - Intro'],
      ['', 'S01E02 - The Reveal'],
      ['', 'Ep 3 - Aftermath'],
    ],
  );
});

test('a declared artist beats the guess, and leaves the title alone', () => {
  const m3u = `#EXTM3U
#EXTART:Boards of Canada
#EXTINF:200,Roygbiv - live at Warp
https://x.example/1.mp3
`;
  const [item] = parsePlaylist(m3u, 'https://x.example/s.m3u').items;

  assert.equal(item.author, 'Boards of Canada');
  assert.equal(item.title, 'Roygbiv - live at Warp');
});

test('relative entries resolve against the playlist', () => {
  const items = parsePlaylist(ALBUM, 'https://netlabel.example/albums/swa.m3u').items;

  assert.equal(items[1].url, 'https://netlabel.example/albums/tha.flac');
  assert.equal(items[1].audio.type, 'audio/flac');
  // -1 is "no duration", not a duration.
  assert.equal(items[2].audio.seconds, null);
});

test('what cannot be fetched or played is dropped', () => {
  const m3u = `#EXTM3U
#EXTINF:1,Local file
C:\\Music\\track.mp3
#EXTINF:2,Old stream
mms://stream.example/live
#EXTINF:3,Real one
https://x.example/ok.mp3
`;
  const feed = parsePlaylist(m3u, 'https://x.example/s.m3u');

  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].url, 'https://x.example/ok.mp3');
});

test('a playlist of video is a series, not an album', () => {
  const m3u = `#EXTM3U
#EXTINF:600,Episode one
https://x.example/1.mp4
#EXTINF:600,Episode two
https://x.example/2.webm
#EXTINF:600,Theme tune
https://x.example/theme.mp3
`;
  const feed = parsePlaylist(m3u, 'https://x.example/s.m3u');

  assert.equal(feed.kind, 'video');
  assert.equal(feed.items[0].audio.type, 'video/mp4');
});

test('the plain form of the format still parses', () => {
  const m3u = `song-one.mp3
song-two.mp3
`;
  const feed = parsePlaylist(m3u, 'https://x.example/mixes/summer_mix.m3u');

  assert.equal(feed.title, 'summer mix');
  assert.equal(feed.items.length, 2);
  // No #EXTINF, so the title is whatever the entry gave, which is nothing.
  assert.equal(feed.items[0].title, '');
});

test('a repeated file is one item', () => {
  const m3u = `#EXTM3U
#EXTINF:1,A
https://x.example/a.mp3
#EXTINF:1,A again
https://x.example/a.mp3
`;
  assert.equal(parsePlaylist(m3u, 'https://x.example/s.m3u').items.length, 1);
});

test('a playlist is capped rather than trusted', () => {
  const lines = ['#EXTM3U'];
  for (let i = 0; i < 900; i += 1) lines.push(`#EXTINF:1,Track ${i}`, `https://x.example/${i}.mp3`);

  assert.equal(parsePlaylist(lines.join('\n'), 'https://x.example/s.m3u').items.length, 500);
});

test('an empty playlist is not a feed', () => {
  assert.equal(parsePlaylist('#EXTM3U\n', 'https://x.example/s.m3u'), null);
  assert.equal(parsePlaylist('', 'https://x.example/s.m3u'), null);
});

// ---- PLS ------------------------------------------------------------------

const PLS = `[playlist]
NumberOfEntries=2
File2=https://ice6.radio.example/groovesalad-128-aac
Title2=Radio Example (mirror)
Length2=-1
File1=https://ice2.radio.example/groovesalad-128-mp3
Title1=Radio Example
Length1=-1
Version=2
`;

test('a pls parses, in its own numbering rather than line order', () => {
  const feed = parsePlaylist(PLS, 'https://radio.example/listen.pls');

  assert.deepEqual(
    feed.items.map((i) => i.url),
    [
      'https://ice2.radio.example/groovesalad-128-mp3',
      'https://ice6.radio.example/groovesalad-128-aac',
    ],
  );
  assert.equal(feed.items[0].title, 'Radio Example');
  assert.equal(feed.items[0].audio.seconds, null);
});

test('mounts with no file to name and no end to state are a radio station', () => {
  const feed = parsePlaylist(PLS, 'https://radio.example/listen.pls');

  assert.equal(feed.kind, 'live');
  // "listen" is the name of the button, not of the station.
  assert.equal(feed.title, 'radio.example');
});

test('a pls of actual files is an album, not a station', () => {
  const pls = `[playlist]
NumberOfEntries=2
File1=https://x.example/a.mp3
Title1=A
Length1=210
File2=https://x.example/b.flac
Title2=B
Length2=180
`;
  const feed = parsePlaylist(pls, 'https://x.example/album.pls');

  assert.equal(feed.kind, 'music');
  assert.equal(feed.items[1].audio.type, 'audio/flac');
  assert.equal(feed.items[0].audio.seconds, 210);
});

// ---- HLS ------------------------------------------------------------------

const HLS_MASTER = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=640000,RESOLUTION=640x360,CODECS="avc1.42e01e,mp4a.40.2"
360p/index.m3u8
`;

test('a live television manifest is one stream, not a list of variants', () => {
  const feed = parsePlaylist(HLS_MASTER, 'https://cdn.example/channel4/master.m3u8');

  assert.equal(feed.items.length, 1);
  // Still going out, so it browses under /lives; what it carries is on the item.
  assert.equal(feed.kind, 'live');

  const [item] = feed.items;
  assert.equal(item.url, 'https://cdn.example/channel4/master.m3u8');
  assert.equal(item.audio.url, item.url);
  assert.equal(item.audio.type, 'video/vnd.apple.mpegurl');
  // Live: there is no runtime to state.
  assert.equal(item.audio.seconds, null);
});

test('a manifest with no pictures in it is a radio station', () => {
  const hls = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:99120
#EXTINF:10.0,
seg-99120.aac
#EXTINF:10.0,
seg-99121.aac
`;
  const feed = parsePlaylist(hls, 'https://ice.example/groovesalad/chunklist.m3u8');

  assert.equal(feed.items.length, 1);
  assert.equal(feed.kind, 'live');
  // Audio, because nothing in the manifest says otherwise: no resolution, no
  // video codec, no video rendition.
  assert.equal(feed.items[0].audio.type, 'application/vnd.apple.mpegurl');
});

test('a finished recording is a recording, with a runtime', () => {
  const vod = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:9.9,
a.ts
#EXTINF:10.1,
b.ts
#EXT-X-ENDLIST
`;
  const feed = parsePlaylist(vod, 'https://x.example/talk.m3u8');

  assert.equal(feed.kind, 'music');
  assert.equal(feed.items[0].audio.seconds, 20);
});

test('a stream named by its packager is named after its host instead', () => {
  const feed = parsePlaylist(HLS_MASTER, 'https://stream.radioparadise.com/index.m3u8');
  assert.equal(feed.title, 'stream.radioparadise.com');

  const named = parsePlaylist(HLS_MASTER, 'https://cdn.example/hls/night_owls.m3u8');
  assert.equal(named.title, 'night owls');
});

test('an IPTV list is a list of streams, each of them television', () => {
  const iptv = `#EXTM3U
#EXTINF:-1 tvg-id="bbc1" tvg-logo="https://l.example/bbc.png" group-title="News, Sport",BBC One
https://cdn.example/bbc1/master.m3u8
#EXTINF:-1 tvg-id="itv" group-title="News, Sport",ITV
https://cdn.example/itv/master.m3u8
`;
  const feed = parsePlaylist(iptv, 'https://lists.example/uk.m3u');

  // A list of channels to tune into, so it browses under /lives — and each
  // entry is still marked as something to watch rather than to listen to.
  assert.equal(feed.kind, 'live');
  assert.equal(feed.items.length, 2);
  // The comma inside group-title is not the separator.
  assert.equal(feed.items[0].title, 'BBC One');
  assert.equal(feed.items[0].audio.type, 'video/vnd.apple.mpegurl');
  assert.equal(feed.items[0].audio.seconds, null);
});

// ---- recognition ----------------------------------------------------------

test('a playlist is recognised by its type, its header, or its extension', () => {
  assert.equal(looksLikePlaylist('audio/x-mpegurl', 'anything'), true);
  assert.equal(looksLikePlaylist('application/vnd.apple.mpegurl', '#EXTM3U'), true);
  assert.equal(looksLikePlaylist('text/plain', '#EXTM3U\na.mp3'), true);
  assert.equal(looksLikePlaylist('text/plain', '[playlist]\nFile1=x'), true);
  assert.equal(looksLikePlaylist('text/plain', 'a.mp3\nb.mp3', 'https://x.example/s.m3u'), true);
});

test('a page is not a playlist, whatever it is called', () => {
  assert.equal(looksLikePlaylist('text/html', '<html><body>hi</body></html>'), false);
  assert.equal(
    looksLikePlaylist('text/html', '<html><body>404</body></html>', 'https://x.example/s.m3u'),
    false,
  );
  assert.equal(looksLikePlaylist('text/plain', 'a.mp3\nb.mp3'), false);
});

test('resolveFeed admits playlists on the same footing as feeds', () => {
  assert.equal(looksLikeFeed('audio/x-scpls', '[playlist]\nFile1=https://x.example/a.mp3'), true);
  assert.equal(looksLikeFeed('text/html', '<html><body>a blog</body></html>'), false);
});

test('parseFeed routes a playlist to the playlist parser', () => {
  const feed = parseFeed(ALBUM, 'https://netlabel.example/albums/swa.m3u');
  assert.equal(feed.kind, 'music');
  assert.equal(feed.items.length, 3);

  // …and a headerless one, which only its URL identifies.
  assert.equal(parseFeed('a.mp3\nb.mp3', 'https://x.example/s.m3u').items.length, 2);
  assert.equal(parseFeed('a.mp3\nb.mp3'), null);
});

test('playlists linked from a page are found, and capped', () => {
  const html = `
    <a href="/albums/one.m3u">One</a>
    <a href="https://x.example/two.pls">Two</a>
    <a href="/notes.html">Notes</a>
    <a href="three.m3u8">Three</a>
    <a href="four.playlist">Four</a>
    <a href="five.m3u">Five</a>
    <a href="six.m3u">Six</a>
  `;
  const found = findPlaylistLinks(html, 'https://x.example/music/');

  assert.equal(found.length, 5);
  assert.deepEqual(found.slice(0, 3), [
    'https://x.example/albums/one.m3u',
    'https://x.example/two.pls',
    'https://x.example/music/three.m3u8',
  ]);
});
