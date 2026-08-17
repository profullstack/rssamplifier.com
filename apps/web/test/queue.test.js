import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dockable, laneFor, lanesOffered, trackFor } from '../src/lib/queue.js';

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

test('the dock only claims media it holds an element for', () => {
  assert.equal(dockable('audio'), true);
  assert.equal(dockable('video'), true);
  // Somebody else's iframe: it cannot be started, seeked or resumed from out
  // here, and cannot report that it finished.
  assert.equal(dockable('youtube'), false);
  assert.equal(dockable('peertube'), false);
  assert.equal(dockable(null), false);
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

test('nothing the dock cannot play is offered to it as a track', () => {
  assert.equal(trackFor(YOUTUBE, { slug: 'tube', feedTitle: 'Tube' }), null);
  assert.equal(trackFor(POST, { slug: 'blog', feedTitle: 'Blog' }), null);
});
