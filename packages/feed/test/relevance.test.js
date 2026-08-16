import test from 'node:test';
import assert from 'node:assert/strict';

import { assessRelevance, keywordStems, stem } from '../index.js';

test('stem folds plurals so huskies matches husky', () => {
  assert.equal(stem('huskies'), 'husk');
  assert.equal(stem('dogs'), 'dog');
  assert.equal(stem('boxes'), 'box');
  assert.equal(stem('cat'), 'cat');
});

test('keywordStems drops stopwords and short words', () => {
  assert.deepEqual(keywordStems('the best blogs for siberian huskies'), ['siberian', 'husk']);
});

test('a husky blog is relevant to "siberian huskies"', () => {
  const feed = {
    title: 'Life With Huskies',
    description: 'Adventures with our sled dogs',
    items: [{ title: 'Our husky turned six' }],
  };

  assert.equal(assessRelevance({ keyword: 'siberian huskies', feed }).relevant, true);
});

test('a vet clinic that never mentions the subject is not', () => {
  // The exact shape the live run turned up: a real, active, well-formed feed
  // that has nothing to do with what was searched for.
  const feed = {
    title: 'Independence Veterinary Clinic',
    description: 'Practice news and opening hours',
    items: [{ title: 'Holiday hours', summary: 'We are closed Monday.' }],
  };

  assert.equal(assessRelevance({ keyword: 'siberian huskies', feed }).relevant, false);
});

test('half the stems is enough — a husky blog need not say "siberian"', () => {
  const feed = { title: 'Husky Diaries', items: [{ title: 'Walkies' }] };
  const res = assessRelevance({ keyword: 'siberian huskies', feed });

  assert.equal(res.relevant, true);
  assert.deepEqual(res.matched, ['husk']);
  assert.equal(res.required, 1);
});

test('a one-word keyword must actually appear', () => {
  const feed = { title: 'Sourdough Weekly', items: [{ title: 'Starter tips' }] };

  assert.equal(assessRelevance({ keyword: 'sourdough', feed }).relevant, true);
  assert.equal(assessRelevance({ keyword: 'motorcycles', feed }).relevant, false);
});

test('a keyword of nothing but stopwords abstains rather than rejecting', () => {
  const feed = { title: 'Anything', items: [] };
  assert.equal(assessRelevance({ keyword: 'the best of', feed }).relevant, true);
});

test('item summaries count, not just titles', () => {
  const feed = {
    title: 'A Blog',
    items: [{ title: 'Weekend', summary: 'We took the huskies up the mountain.' }],
  };

  assert.equal(assessRelevance({ keyword: 'huskies', feed }).relevant, true);
});
