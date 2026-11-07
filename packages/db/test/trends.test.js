import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isEnglishTitle, rankTerms, tallyTerms, titleTerms } from '../src/trends.js';

test('a title gives its subjects and leaves out the filler', () => {
  const terms = titleTerms("Joshua Wong's sentence is the longest yet");
  assert.ok(terms.has('joshua wong'));
  assert.ok(terms.has('sentence'));
  assert.ok(!terms.has('the'));
  assert.ok(!terms.has('longest yet'));
});

test('feeds that declare English and publish something else are left out', () => {
  assert.equal(isEnglishTitle('Kasus penyadapan dan dukungan Prabowo'), false);
  assert.equal(isEnglishTitle('Listyo Sigit tunjukkan'), false, 'nothing shows it is English');
  assert.equal(isEnglishTitle('Democrats sweep the House in a blue wave'), true);
});

test('a firehose is one voice', () => {
  const rows = [
    ...Array.from({ length: 500 }, () => ({ feed_id: 'npm', title: 'Release of the widget' })),
    { feed_id: 'blog', title: 'Thoughts on the widget' },
  ];
  const { feeds, terms, items } = tallyTerms(rows);
  assert.equal(items, 501);
  assert.equal(feeds, 2);
  assert.equal(terms.get('widget'), 2);
});

const rank = (current, prior, feeds = [1000, 1000]) =>
  rankTerms({ current: new Map(current), prior: new Map(prior), currentFeeds: feeds[0], priorFeeds: feeds[1] });

test('a rising subject ranks and a steady one does not', () => {
  const out = rank(
    [['midterm results', 60], ['music', 400]],
    [['midterm results', 2], ['music', 390]],
  );
  assert.deepEqual(out.map((t) => t.topic), ['midterm results']);
  assert.equal(out[0].count, 60);
  assert.equal(out[0].prior_count, 2);
});

test('one subject appears once, under its name', () => {
  const out = rank(
    [['joshua wong', 60], ['wong', 70], ['activist joshua', 40], ['wong sentenced', 30]],
    [],
  );
  assert.deepEqual(out.map((t) => t.topic), ['joshua wong']);
});

test('the rate is compared, so a bigger crawl does not make everything trend', () => {
  assert.deepEqual(rank([['cats', 200]], [['cats', 100]], [2000, 1000]), []);
});

test('too few feeds is noise, and an empty window ranks nothing', () => {
  assert.deepEqual(rank([['rare thing', 5]], []), []);
  assert.deepEqual(rank([['subject', 50]], [], [0, 1000]), []);
});
