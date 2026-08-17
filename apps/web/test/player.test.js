import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  playerPath,
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
