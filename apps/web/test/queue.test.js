import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  alreadyQueued,
  dockCarries,
  dockable,
  embedded,
  entryLanes,
  laneFor,
  lanesOffered,
  playableEntries,
  trackFor,
} from '../src/lib/queue.js';

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

test('queue-all acts on the posts that carry a file, and nothing else', () => {
  // A podcast's page is the case this exists for: every row is an episode, so
  // all of them queue. The article in the middle is the one that must not — the
  // control says "play all", and a blog post has nothing to play.
  const entries = playableEntries([
    { id: 'a', ...EPISODE },
    { id: 'b', ...POST },
    { id: 'c', ...YOUTUBE },
  ]);

  assert.deepEqual(entries, [
    { itemId: 'a', lane: 'listen' },
    { itemId: 'c', lane: 'watch' },
  ]);
});

test('a blog offers nothing to queue at all', () => {
  // Not an empty button but no button: QueueAll returns null on a total of
  // zero, so this is what keeps the control off every blog in the directory.
  assert.deepEqual(playableEntries([{ id: 'a', ...POST }]), []);
});

test('a feed that publishes both kinds names both lanes', () => {
  // A reader told "queued" who then found nothing in the lane they were looking
  // at would reasonably conclude the button was broken, so the note names every
  // lane the press will touch rather than assuming a feed is one kind of thing.
  const mixed = playableEntries([
    { id: 'a', ...EPISODE },
    { id: 'c', ...YOUTUBE },
  ]);
  assert.deepEqual(entryLanes(mixed), ['listen', 'watch']);
  assert.deepEqual(entryLanes(playableEntries([{ id: 'a', ...EPISODE }])), ['listen']);
  assert.deepEqual(entryLanes([]), []);
});

test('what is already queued is counted in the lane it would land in', () => {
  const entries = playableEntries([
    { id: 'a', ...EPISODE },
    { id: 'c', ...YOUTUBE },
  ]);

  assert.equal(alreadyQueued(entries, {}), 0);
  assert.equal(alreadyQueued(entries, { a: ['listen'] }), 1);
  assert.equal(alreadyQueued(entries, { a: ['listen'], c: ['watch'] }), 2);

  // Kept to read later is a different intention from kept to listen to, and
  // counting it would let the button claim to be done while pressing it would
  // still add the episode.
  assert.equal(alreadyQueued(entries, { a: ['read'] }), 0);
});
