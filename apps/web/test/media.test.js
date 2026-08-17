import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mediaKind, isWatchable } from '../src/lib/media.js';

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
