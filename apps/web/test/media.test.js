import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  mediaKind,
  isEpisode,
  isPicture,
  isWatchable,
  peertubeEmbed,
  playableMedia,
} from '../src/lib/media.js';

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

test('the stored character count decides once the body stops being stored', () => {
  // Bodies are no longer kept at crawl time (0031), so `content_html` is null
  // for anything crawled since and the crawl records the length instead.
  const post = { audio_url: 'https://media.example/ep.mp3', audio_type: 'audio/mpeg' };

  assert.equal(isEpisode(post, null, 40), true, 'a short post with audio is an episode');
  assert.equal(isEpisode(post, null, 9000), false, 'a long one is an article with audio');

  // The trap: `Number(null)` is 0 and `Number.isFinite(0)` is true, so a null
  // count read as a zero-length body would call every post with media an
  // episode. Absent means "fall back to the body", not "empty".
  const article = '<p>Paragraph of the actual piece.</p>'.repeat(60);
  assert.equal(isEpisode(post, article, null), false, 'null count falls back to the body');
  assert.equal(isEpisode(post, article, undefined), false, 'and so does an absent one');
});

test('a video with an article around it is not an episode', () => {
  const post = { audio_url: 'https://media.example/demo.mp4', audio_type: 'video/mp4' };
  const article = '<p>Paragraph of the actual tutorial.</p>'.repeat(60);

  // Both answers are true at once, and conflating them is what dropped the
  // article: there is a video to play, and the video is not what the post is.
  assert.equal(isWatchable(post), true);
  assert.equal(isEpisode(post, article), false);
});

test('a video with a caption around it is an episode', () => {
  const post = { audio_url: 'https://media.example/demo.mp4', audio_type: 'video/mp4' };

  assert.equal(isEpisode(post, '<p>A sentence about the video.</p>'), true);
  assert.equal(isEpisode(post, null), true);
});

test('a post with no media is not an episode, however short it is', () => {
  assert.equal(isEpisode({}, ''), false);
  assert.equal(isEpisode({ url: 'https://example.com/1' }, 'hi'), false);
});

test('markup does not count towards the length of an article', () => {
  const post = { audio_url: 'https://media.example/demo.mp4', audio_type: 'video/mp4' };

  // A caption wrapped in enough tags to clear the threshold on bytes alone is
  // still a caption.
  const dressed = `<div class="wrapper"><span class="a">${'<b></b>'.repeat(400)}</span>Short.</div>`;
  assert.equal(isEpisode(post, dressed), true);
});

/**
 * A Funkwhale track, exactly as gojonnes@open.audio ships one.
 *
 * The post that sent the reader to a dead end: open.audio answers
 * `x-frame-options: SAMEORIGIN`, so the page will not frame, and the page is a
 * JavaScript app, so extraction finds no article to render in its place. Both
 * escapes closed, the reader fell through to "this site does not allow itself
 * to be embedded" — over an mp3 it could play, and was already loading into a
 * player docked in the corner.
 */
const TRACK = {
  url: 'https://open.audio/library/tracks/469538',
  audio_url: 'https://open.audio/api/v2/stream/c024c701-25c1-43bb-af63-986b39356c47.mp3',
  audio_type: 'audio/mpeg',
};

test('a Funkwhale track is audio the reader can play, not a page that failed', () => {
  assert.equal(mediaKind(TRACK), 'audio');

  // Not watchable, which is the whole reason it took the framing path: the
  // enclosure has named what a post is since the video branch landed, and that
  // sentence was only ever acted on for video.
  assert.equal(isWatchable(TRACK), false);

  // There is a file, and it is the post — so the reader has something to render
  // where the refusal notice was.
  assert.equal(isEpisode(TRACK, 'Acoustic guitar that I recorded at home'), true);
  assert.deepEqual(playableMedia(TRACK), { kind: 'audio', src: TRACK.audio_url });
});

test('audio attached to an article is still not the article', () => {
  const post = { ...TRACK, url: 'https://example.com/post' };
  const article = '<p>Paragraph of the actual write-up.</p>'.repeat(60);

  // Same split the video branch draws: there is audio to play either way, and
  // whether it is the post decides whether the link out reads "Listen on" or
  // "Read the original on".
  assert.equal(mediaKind(post), 'audio');
  assert.equal(isEpisode(post, article), false);
});

test('a strip with a line under it is a picture, and gets the room to be one', () => {
  const strip =
    '<p><img src="https://www.sisterclaire.com/comics/1750651937-pain_s.png"></p>' +
    '<p>Back on Monday. Thank you for your patience.</p>';

  assert.equal(isPicture(strip), true);
});

test('an illustration inside an essay is not the essay', () => {
  // The distinction the measure exists for: a photograph in two thousand words
  // is an illustration and belongs in the column, at the width every other
  // paragraph gets.
  const essay =
    '<p><img src="https://example.com/photos/harbour.jpg"></p>' +
    '<p>The harbour was rebuilt twice, and the second time nobody agreed why.</p>'.repeat(30);

  assert.equal(isPicture(essay), false);
});

test('a short post with no picture in it is prose, not a picture', () => {
  assert.equal(isPicture('<p>Back on Monday.</p>'), false);
  assert.equal(isPicture(''), false);
  assert.equal(isPicture(null), false);
});

test('an http enclosure is handed to the player over https, because http cannot play', () => {
  // What SomaFM's feeds print: an Icecast stream at http://, on a host that
  // has served https for years. The player is a subresource of a page served
  // over https, so the browser blocks the http one as mixed content — and
  // `media-src` lists https only, so it is refused before that. The reader saw
  // a transport with a dead play button and nothing explaining it.
  //
  // There is no version of this where http plays, so relaxing the policy would
  // not have helped. Upgrading is the only move that can.
  const stream = {
    url: 'https://somafm.com/beatblender/',
    audio_url: 'http://ice2.somafm.com/beatblender-128-mp3',
    audio_type: 'audio/mpeg',
  };

  assert.deepEqual(playableMedia(stream), {
    kind: 'audio',
    src: 'https://ice2.somafm.com/beatblender-128-mp3',
  });
});

test('an https enclosure is left exactly as the publisher wrote it', () => {
  const post = {
    url: 'https://example.com/ep/1',
    audio_url: 'https://example.com/ep/1.mp3?token=http://not-a-scheme',
    audio_type: 'audio/mpeg',
  };

  // Only a leading scheme is rewritten — an http:// sitting inside a query
  // string is somebody's parameter, not the address being fetched.
  assert.equal(playableMedia(post).src, post.audio_url);
});
