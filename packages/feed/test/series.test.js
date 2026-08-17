import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assessFeed } from '../src/worthiness.js';
import {
  assessSeries,
  isSeriesFeed,
  seriesAuthors,
  DEFAULT_SERIES_RULES,
} from '../src/series.js';

const PLAYLIST = 'https://www.youtube.com/feeds/videos.xml?playlist_id=PLNPUF5QyWU8Pyd';
const CHANNEL = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCekZUWSJkX9kHuvfPbt_gvg';

/**
 * A lecture series, shaped like the real one: every entry by the same person,
 * every entry linked, and nothing published since the course ended.
 *
 * @param {{ count?: number, author?: string|string[], year?: number, linked?: boolean }} [opts]
 */
function course(opts = {}) {
  const count = opts.count ?? 19;
  const authors = Array.isArray(opts.author) ? opts.author : [opts.author ?? 'Lindsey Kuper'];

  return {
    title: 'CSE138 (Distributed Systems) lectures, Spring 2021',
    description: '',
    items: Array.from({ length: count }, (_, i) => ({
      title: `CSE138 L${i + 1}`,
      url: opts.linked === false ? '' : `https://www.youtube.com/watch?v=v${i}`,
      author: authors[i % authors.length],
      publishedAt: `${opts.year ?? 2021}-04-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
    })),
  };
}

// -------------------------------------------------------------- what it is

test('a playlist feed is a series and a channel feed is not', () => {
  assert.equal(isSeriesFeed(PLAYLIST), true);
  assert.equal(isSeriesFeed(CHANNEL), false);
  assert.equal(isSeriesFeed(''), false);
  assert.equal(isSeriesFeed(undefined), false);
});

// ------------------------------------------------------- the reason it exists

test('worthiness rejects a finished course and the series check accepts it', () => {
  const feed = course();

  // The behaviour this module was written for. Not a hypothetical: both real
  // playlists tested against scored zero for 'abandoned' before this existed.
  const asBlog = assessFeed({ feedUrl: PLAYLIST, feed });
  assert.equal(asBlog.worthy, false);
  assert.deepEqual(asBlog.reasons, ['abandoned']);

  const asSeries = assessSeries({ feedUrl: PLAYLIST, feed });
  assert.equal(asSeries.worthy, true);
  assert.deepEqual(asSeries.authors, ['Lindsey Kuper']);
});

test('age is not a signal at all — a course from 2009 is still a course', () => {
  const old = assessSeries({ feedUrl: PLAYLIST, feed: course({ year: 2009 }) });
  const recent = assessSeries({ feedUrl: PLAYLIST, feed: course({ year: 2026 }) });

  assert.equal(old.worthy, true);
  assert.equal(old.score, recent.score);
});

// ------------------------------------------------------------------ bylines

test('bylines are counted distinctly and case-insensitively, in first-seen order', () => {
  const authors = seriesAuthors([
    { author: 'YaleCourses' },
    { author: 'yalecourses' },
    { author: '  YaleCourses  ' },
    { author: 'ConceptHut' },
    { author: '' },
    {},
  ]);

  assert.deepEqual(authors, ['YaleCourses', 'ConceptHut']);
});

test('one foreign byline is a curated course, not a mixtape', () => {
  // The Yale case: somebody else's channel collected one university's lectures
  // into the only ordered form that course exists in.
  const verdict = assessSeries({
    feedUrl: PLAYLIST,
    feed: { ...course({ author: 'YaleCourses' }), title: 'Yale Philosophy' },
  });

  assert.equal(verdict.worthy, true);
  assert.deepEqual(verdict.authors, ['YaleCourses']);
});

test('a co-taught course passes; a bookmark folder does not', () => {
  const cotaught = assessSeries({
    feedUrl: PLAYLIST,
    feed: course({ author: ['Ana', 'Bo'] }),
  });
  assert.equal(cotaught.worthy, true);

  const mixtape = assessSeries({
    feedUrl: PLAYLIST,
    feed: course({ author: ['Ana', 'Bo', 'Cy', 'Di', 'Ed'] }),
  });
  assert.equal(mixtape.worthy, false);
  assert.deepEqual(mixtape.reasons, ['mixtape']);
  assert.equal(mixtape.authors.length, 5);
});

// ------------------------------------------------------------ disqualifiers

test('a handful of videos is not a series', () => {
  const verdict = assessSeries({ feedUrl: PLAYLIST, feed: course({ count: 3 }) });

  assert.equal(verdict.worthy, false);
  assert.deepEqual(verdict.reasons, ['too-short']);
  assert.equal(verdict.score, 0);
});

test('a series nobody can watch is refused', () => {
  const verdict = assessSeries({ feedUrl: PLAYLIST, feed: course({ linked: false }) });

  assert.equal(verdict.worthy, false);
  assert.deepEqual(verdict.reasons, ['unlinked-items']);
});

test('an untitled, unattributed series is noted rather than silently passed', () => {
  const verdict = assessSeries({
    feedUrl: PLAYLIST,
    feed: {
      title: '',
      items: Array.from({ length: 12 }, (_, i) => ({
        title: `part ${i}`,
        url: `https://example.com/${i}`,
      })),
    },
  });

  assert.ok(verdict.reasons.includes('untitled'));
  assert.ok(verdict.reasons.includes('unattributed'));
  assert.equal(verdict.worthy, false);
});

test('an empty feed is refused rather than thrown at', () => {
  const verdict = assessSeries({ feedUrl: PLAYLIST, feed: {} });

  assert.equal(verdict.worthy, false);
  assert.deepEqual(verdict.authors, []);
});

test('the rules can be overridden per call', () => {
  const feed = course({ count: 3 });

  assert.equal(assessSeries({ feedUrl: PLAYLIST, feed }).worthy, false);
  assert.equal(
    assessSeries({ feedUrl: PLAYLIST, feed, rules: { minItems: 2 } }).worthy,
    true,
  );
  assert.equal(DEFAULT_SERIES_RULES.minItems, 4);
});
