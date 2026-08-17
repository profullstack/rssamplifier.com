import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dockCarries, dockable, embedded, laneFor, lanesOffered, trackFor } from '../src/lib/queue.js';

/** An episode: an mp3 enclosure on a post. */
const EPISODE = {
  guid: 'ep-1',
  title: 'Episode One',
  url: 'https://show.example/1',
  audio_url: 'https://show.example/1.mp3',
  audio_type: 'audio/mpeg',
  audio_seconds: 2400,
};

/** A YouTube post, as feed parsing stores one. */
const YOUTUBE = {
  guid: 'yt-1',
  title: 'A video',
  url: 'https://www.youtube.com/watch?v=abc123',
  audio_url: 'https://www.youtube.com/embed/abc123',
  audio_type: 'video/youtube',
};

/** A plain article. */
const POST = { guid: 'p-1', title: 'Some writing', url: 'https://blog.example/hello' };

test('the lane follows what the publisher published', () => {
  assert.equal(laneFor(EPISODE), 'listen');
  assert.equal(laneFor(YOUTUBE), 'watch');
  assert.equal(laneFor(POST), 'read');
  assert.equal(laneFor({ ...EPISODE, audio_type: 'video/mp4' }), 'watch');
});

test('a media post offers its own lane and the read lane, an article only read', () => {
  // Show notes and the episode are two intentions about one post, so both are
  // on offer. There is no text to speech here, so "listen later" is never
  // offered on something with nothing to play — it would be a promise the site
  // cannot keep.
  assert.deepEqual(lanesOffered(EPISODE), ['listen', 'read']);
  assert.deepEqual(lanesOffered(YOUTUBE), ['watch', 'read']);
  assert.deepEqual(lanesOffered(POST), ['read']);
});

test('the dock only claims to drive media it holds an element for', () => {
  assert.equal(dockable('audio'), true);
  assert.equal(dockable('video'), true);
  // Somebody else's iframe: it cannot be started, seeked or resumed from out
  // here, and cannot report that it finished.
  assert.equal(dockable('youtube'), false);
  assert.equal(dockable('peertube'), false);
  assert.equal(dockable(null), false);
});

test('the dock carries embeds it cannot drive', () => {
  assert.equal(embedded('youtube'), true);
  assert.equal(embedded('peertube'), true);
  assert.equal(embedded('video'), false);
  assert.equal(embedded('audio'), false);

  // The wider question, and the one trackFor asks. Nine in ten videos on a
  // topic are one of these; a dock that refused them would be a watch queue
  // over a tenth of the videos.
  assert.equal(dockCarries('youtube'), true);
  assert.equal(dockCarries('peertube'), true);
  assert.equal(dockCarries('audio'), true);
  assert.equal(dockCarries('video'), true);
  assert.equal(dockCarries(null), false);
});

test('a track carries everything the player needs across a page load', () => {
  const track = trackFor(EPISODE, { slug: 'show', feedTitle: 'The Show', entryId: 'entry-1' });

  assert.equal(track.src, EPISODE.audio_url);
  assert.equal(track.kind, 'audio');
  assert.equal(track.title, 'Episode One');
  assert.equal(track.show, 'The Show');
  assert.equal(track.seconds, 2400);
  assert.equal(track.entryId, 'entry-1');
  // The way back to the post, which is the one thing a player docked over some
  // other page cannot work out for itself.
  assert.equal(track.href, '/show/read?p=ep-1');
});

test('a guid that needs escaping survives the round trip into a link', () => {
  const track = trackFor(
    { ...EPISODE, guid: 'https://show.example/1?a=b&c=d' },
    { slug: 'show', feedTitle: 'The Show' },
  );

  assert.equal(track.href, `/show/read?p=${encodeURIComponent('https://show.example/1?a=b&c=d')}`);
});

test('an embed becomes a track, and says which kind it is', () => {
  const track = trackFor(YOUTUBE, { slug: 'tube', feedTitle: 'Tube' });

  // The kind is what tells the dock to render a frame instead of a media
  // element, and what every "can we drive this" check keys off afterwards.
  assert.equal(track.kind, 'youtube');
  assert.equal(track.src, YOUTUBE.audio_url);
  assert.equal(track.href, '/tube/read?p=yt-1');
});

test('a post with nothing attached is not offered to the dock as a track', () => {
  assert.equal(trackFor(POST, { slug: 'blog', feedTitle: 'Blog' }), null);
});
