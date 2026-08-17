import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mediaKind, isWatchable, peertubeEmbed, playableMedia } from '../src/lib/media.js';

/** A PeerTube item, exactly as the feed stores one. */
const PEERTUBE = {
  url: 'https://video.tedomum.net/w/fB4PoAXrN5PsHo3vD1pxjX',
  audio_url:
    'https://video.tedomum.net/download/videos/generate/76455356-8626-477a-b225-34f1d7279f9f?videoFileIds=10520121',
  audio_type: 'video/mp4',
};

test('a PeerTube post plays through its embed, not its enclosure', () => {
  // The enclosure is a download endpoint keyed on a particular encoded file:
  // measured live, video.tedomum.net answers 404 for the id in its own feed,
  // and peertube.hackerfoo.com answers 200 with content-disposition attachment
  // and no accept-ranges — a download, not something a player can seek.
  assert.equal(mediaKind(PEERTUBE), 'peertube');
  assert.equal(isWatchable(PEERTUBE), true);
  assert.deepEqual(playableMedia(PEERTUBE), {
    kind: 'peertube',
    src: 'https://video.tedomum.net/videos/embed/fB4PoAXrN5PsHo3vD1pxjX',
  });
});

test('PeerTube’s older watch path is recognised too', () => {
  const embed = peertubeEmbed({
    url: 'https://peertube.hackerfoo.com/videos/watch/bpuSvJLxNAGvGRbz8Bsvue',
    audio_url: 'https://peertube.hackerfoo.com/download/videos/generate/x?videoFileIds=1',
    audio_type: 'video/mp4',
  });

  assert.equal(embed, 'https://peertube.hackerfoo.com/videos/embed/bpuSvJLxNAGvGRbz8Bsvue');
});

test('a plain blog that happens to use /w/ is not a PeerTube video', () => {
  // The guard that keeps this branch narrow: the enclosure has to be a video on
  // the same host as the permalink, which is the shape only PeerTube produces.
  assert.equal(
    peertubeEmbed({
      url: 'https://blog.example/w/some-post',
      audio_url: 'https://cdn.other.example/ep.mp3',
      audio_type: 'audio/mpeg',
    }),
    null,
  );

  assert.equal(
    peertubeEmbed({
      url: 'https://blog.example/w/some-post',
      audio_url: 'https://cdn.other.example/clip.mp4',
      audio_type: 'video/mp4',
    }),
    null,
    'a video hosted somewhere else is not an instance serving its own video',
  );
});

test('a post with no permalink falls back to the enclosure', () => {
  const post = { url: null, audio_url: 'https://e.example/clip.mp4', audio_type: 'video/mp4' };

  assert.equal(mediaKind(post), 'video');
  assert.deepEqual(playableMedia(post), { kind: 'video', src: 'https://e.example/clip.mp4' });
});

test('YouTube is still YouTube, not swept into the PeerTube branch', () => {
  const post = {
    url: 'https://www.youtube.com/watch?v=rRRFvQezcSM',
    audio_url: 'https://www.youtube-nocookie.com/embed/rRRFvQezcSM',
    audio_type: 'video/youtube',
  };

  assert.equal(mediaKind(post), 'youtube');
  assert.equal(playableMedia(post).src, 'https://www.youtube-nocookie.com/embed/rRRFvQezcSM');
});

test('a YouTube enclosure is a video to embed, not a page to frame', () => {
  const post = { audio_url: 'https://www.youtube-nocookie.com/embed/rRRFvQezcSM', audio_type: 'video/youtube' };

  assert.equal(mediaKind(post), 'youtube');
  assert.equal(isWatchable(post), true);
});

test('a podcast is not watchable, so its player still docks', () => {
  // The regression that would be easy to cause: video posts moving into the
  // page must not take audio episodes with them. A docked transport is the
  // whole point of a podcast page — the show notes are what you read while it
  // plays.
  const post = { audio_url: 'https://cdn.example/ep12.mp3', audio_type: 'audio/mpeg' };

  assert.equal(mediaKind(post), 'audio');
  assert.equal(isWatchable(post), false);
});

test('an ordinary post has no media at all', () => {
  assert.equal(mediaKind({ audio_url: null, audio_type: null }), null);
  assert.equal(mediaKind({}), null);
  assert.equal(isWatchable({}), false);
});

test('a video file is watched in place, like a YouTube video', () => {
  const post = { audio_url: 'https://example.com/talk.mp4', audio_type: 'video/mp4' };

  assert.equal(mediaKind(post), 'video');
  assert.equal(isWatchable(post), true);
});

test('the type is read case-insensitively, because feeds spell it both ways', () => {
  assert.equal(mediaKind({ audio_url: 'https://e/x', audio_type: 'Video/MP4' }), 'video');
  assert.equal(mediaKind({ audio_url: 'https://e/x', audio_type: 'VIDEO/YOUTUBE' }), 'youtube');
});

test('an enclosure with no type is treated as audio, not as a black rectangle', () => {
  // Guessing video would put an empty player in the middle of the page; guessing
  // audio is a transport that either plays or says it cannot.
  assert.equal(mediaKind({ audio_url: 'https://cdn.example/thing' }), 'audio');
  assert.equal(isWatchable({ audio_url: 'https://cdn.example/thing' }), false);
});

test('a type that is not media at all still does not become a video', () => {
  assert.equal(mediaKind({ audio_url: 'https://e/x', audio_type: 'application/pdf' }), 'audio');
  assert.equal(isWatchable({ audio_url: 'https://e/x', audio_type: 'application/pdf' }), false);
});
