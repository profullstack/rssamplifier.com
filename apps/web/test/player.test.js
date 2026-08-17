import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  playerPath,
  playlistEntry,
  queueRuntime,
  rawPlaylistPath,
  runtime,
  trackFrom,
  wantsPlayer,
} from '../src/lib/player.js';

/**
 * A request for a playlist, as one kind of client or another would make it.
 *
 * @param {Record<string, string>} [headers]
 * @param {string} [url]
 * @returns {Request}
 */
function ask(headers = {}, url = 'https://rssamplifier.com/topics/ai/podcasts.m3u') {
  return new Request(url, { headers });
}

test('a browser navigating to a playlist is sent to the player', () => {
  // What Chrome, Firefox and Safari all send on a top-level navigation, and
  // the only case this feature exists for.
  assert.equal(wantsPlayer(ask({ 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' })), true);
});

test('everything that can actually play an m3u still gets the file', () => {
  // curl, VLC, mpv, every podcast app and every feed reader: no Sec-Fetch-*
  // headers at all. Breaking one of these would break a working subscription
  // to fix a click that was merely useless, so this is the important case.
  assert.equal(wantsPlayer(ask()), false);
  assert.equal(wantsPlayer(ask({ 'user-agent': 'VLC/3.0.20 LibVLC/3.0.20' })), false);

  // A browser-shaped Accept from a client with a web view in it. This is why
  // the test is not on Accept.
  assert.equal(
    wantsPlayer(ask({ accept: 'text/html,application/xhtml+xml,*/*' })),
    false,
  );

  // A fetch() from a page, rather than a navigation to one.
  assert.equal(wantsPlayer(ask({ 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' })), false);
});

test('a reader who wants the file can still say so', () => {
  const url = 'https://rssamplifier.com/topics/ai/podcasts.m3u?dl=1';
  assert.equal(wantsPlayer(ask({ 'sec-fetch-dest': 'document' }, url)), false);
  assert.equal(rawPlaylistPath('/topics/ai/podcasts.m3u'), '/topics/ai/podcasts.m3u?dl=1');
});

test('the player address is the listing address, plus play', () => {
  assert.equal(playerPath('ai'), '/topics/ai/play');
  assert.equal(playerPath('ai', 'podcasts'), '/topics/ai/podcasts/play');

  // A slug with a space in it is one segment, not two.
  assert.equal(playerPath('home lab', 'music'), '/topics/home%20lab/music/play');
});

test('a track carries what the playlist entry carries', () => {
  const track = trackFrom({
    guid: 'tag:example.com,2026:1',
    url: 'https://example.com/ep1',
    title: 'Episode One',
    audio_url: 'https://cdn.example.com/1.mp3',
    audio_type: 'audio/mpeg',
    audio_seconds: 1426,
    feed_slug: 'coder-radio',
    feed_title: 'Coder Radio',
  });

  assert.equal(track.id, 'tag:example.com,2026:1');
  assert.equal(track.src, 'https://cdn.example.com/1.mp3');
  assert.equal(track.type, 'audio/mpeg');
  assert.equal(track.show, 'Coder Radio');
  assert.equal(track.showHref, '/coder-radio');
  assert.equal(track.postHref, 'https://example.com/ep1');
  assert.equal(track.seconds, 1426);
});

test('a row with nothing to play is not a track', () => {
  assert.equal(trackFrom({ title: 'A blog post', audio_url: null }), null);
  assert.equal(trackFrom({ title: 'Whitespace', audio_url: '   ' }), null);
  assert.equal(trackFrom(null), null);
});

test('a track with no duration says nothing rather than zero', () => {
  const track = trackFrom({ audio_url: 'https://cdn.example.com/x.mp3', audio_seconds: -1 });
  assert.equal(track.seconds, null);
  assert.equal(track.title, 'Untitled');
});

test('a playlist row is both a line of the list and something the dock can carry', () => {
  const entry = playlistEntry({
    guid: 'tag:example.com,2026:1',
    url: 'https://example.com/ep1',
    title: 'Episode One',
    image_url: 'https://cdn.example.com/cover.jpg',
    audio_url: 'https://cdn.example.com/1.mp3',
    audio_type: 'audio/mpeg',
    audio_seconds: 1426,
    feed_slug: 'coder-radio',
    feed_title: 'Coder Radio',
  });

  // Everything the list itself draws is untouched.
  assert.equal(entry.title, 'Episode One');
  assert.equal(entry.seconds, 1426);
  assert.equal(entry.postHref, 'https://example.com/ep1');

  // ...and alongside it, what the dock needs to play it and to say what it is.
  assert.equal(entry.lane, 'listen');
  assert.equal(entry.dock.src, 'https://cdn.example.com/1.mp3');
  assert.equal(entry.dock.kind, 'audio');
  assert.equal(entry.dock.show, 'Coder Radio');
  assert.equal(entry.dock.image, 'https://cdn.example.com/cover.jpg');
  // Back to the post on this site, not off to the publisher: the dock's title
  // is a way back to what you are hearing.
  assert.equal(entry.dock.href, '/coder-radio/read?p=tag%3Aexample.com%2C2026%3A1');
});

test('a video row is watched rather than listened to, and keeps its poster', () => {
  const entry = playlistEntry({
    guid: 'g2',
    url: 'https://example.com/v1',
    title: 'A talk',
    image_url: 'https://cdn.example.com/thumb.jpg',
    audio_url: 'https://cdn.example.com/1.mp4',
    audio_type: 'video/mp4',
    feed_slug: 'confs',
    feed_title: 'Conferences',
  });

  assert.equal(entry.lane, 'watch');
  assert.equal(entry.dock.kind, 'video');
  assert.equal(entry.dock.image, 'https://cdn.example.com/thumb.jpg');
});

test('what the dock cannot carry stays in the list as a plain link', () => {
  // A YouTube enclosure plays in somebody else's iframe: it cannot be started
  // from the dock, so the row keeps its place and loses only the payload.
  const youtube = playlistEntry({
    guid: 'g3',
    url: 'https://www.youtube.com/watch?v=abc',
    title: 'A video',
    audio_url: 'https://www.youtube.com/watch?v=abc',
    audio_type: 'video/youtube',
    feed_slug: 'a-channel',
    feed_title: 'A Channel',
  });

  assert.equal(youtube.title, 'A video');
  assert.equal(youtube.dock, null);

  // And a row whose feed we cannot name has nowhere to send the dock's title
  // link, so it gets the same treatment rather than a link to nowhere.
  const orphan = playlistEntry({
    guid: 'g4',
    title: 'Homeless episode',
    audio_url: 'https://cdn.example.com/4.mp3',
    audio_type: 'audio/mpeg',
  });

  assert.equal(orphan.dock, null);
  assert.equal(orphan.src, 'https://cdn.example.com/4.mp3');
});

test('a playlist row carries the handles its queue button needs', () => {
  const entry = playlistEntry({
    item_id: 'it_9',
    guid: 'tag:example.com,2026:1',
    url: 'https://example.com/ep1',
    title: 'Episode One',
    audio_url: 'https://cdn.example.com/1.mp3',
    audio_type: 'audio/mpeg',
    feed_slug: 'coder-radio',
    feed_title: 'Coder Radio',
  });

  // Slug and guid are how /api/queue addresses a post; the item id is only so
  // the page can ask which of fifty rows are already lined up.
  assert.equal(entry.slug, 'coder-radio');
  assert.equal(entry.guid, 'tag:example.com,2026:1');
  assert.equal(entry.itemId, 'it_9');
  assert.deepEqual(entry.lanes, ['listen', 'read']);
});

test('a row the dock cannot play is still a row you can keep', () => {
  // The point of the distinction: queueing and playing are different questions
  // about a post, and reading dockability as "queueable" would leave every
  // YouTube entry on a playlist with no way to save it.
  const entry = playlistEntry({
    item_id: 'it_10',
    guid: 'g3',
    url: 'https://www.youtube.com/watch?v=abc',
    title: 'A video',
    audio_url: 'https://www.youtube.com/watch?v=abc',
    audio_type: 'video/youtube',
    feed_slug: 'a-channel',
    feed_title: 'A Channel',
  });

  assert.equal(entry.dock, null);
  assert.equal(entry.lane, 'watch');
  assert.equal(entry.itemId, 'it_10');
  assert.deepEqual(entry.lanes, ['watch', 'read']);
});

test('a row with nothing to play is not a playlist entry either', () => {
  assert.equal(playlistEntry({ title: 'A blog post', audio_url: null }), null);
  assert.equal(playlistEntry(null), null);
});

test('a runtime reads as a person would say it', () => {
  assert.equal(runtime(1426), '23:46');
  assert.equal(runtime(10272), '2:51:12');
  assert.equal(runtime(0), '0:00');
});

test('a queue only claims a total when most of it is timed', () => {
  const timed = [{ seconds: 3600 }, { seconds: 3600 }, { seconds: 3600 }];
  assert.equal(queueRuntime(timed), '3.0 hours');

  // Half the entries undated is not a total worth printing.
  assert.equal(queueRuntime([{ seconds: 3600 }, { seconds: null }, { seconds: null }]), null);

  assert.equal(queueRuntime([{ seconds: 900 }, { seconds: 900 }]), '30 minutes');
});
