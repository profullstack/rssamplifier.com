import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractKeywords, feedTopics, singularize, tokenize, topicSlug } from '../src/keywords.js';

test('tokenize drops stopwords, bare numbers and one-letter fragments', () => {
  assert.deepEqual(tokenize('The quick brown fox is 42 a'), ['quick', 'brown', 'fox']);
});

test('tokenize keeps the punctuation that is part of a word', () => {
  // c++ and c# are the reason topicSlug spells + and # out: without this they
  // would both tokenize to "c" and share a topic page with the letter C.
  assert.deepEqual(tokenize('C++ and C# and self-hosted e-ink'), [
    'c++',
    'c#',
    'self-hosted',
    'e-ink',
  ]);
});

test('tokenize normalises curly apostrophes, and & becomes a word it then drops', () => {
  assert.deepEqual(tokenize("Rust’s tooling & builds"), ['rusts', 'tooling', 'builds']);
});

test('page furniture is not a topic on its own but may sit inside one', () => {
  // The bookmarklet filters these words out of the text, which is right for a
  // page full of nav labels and wrong for prose: it would leave "home lab" as
  // "lab" and lose "open source" altogether.
  const blocks = [
    'Open source tooling for a home lab',
    'Home lab notes: open source firmware',
    'More open source in the home lab',
  ];

  const ranked = extractKeywords(blocks);
  const keywords = ranked.map((k) => k.keyword);

  assert.ok(keywords.includes('open source'), 'the phrase survived');
  assert.ok(keywords.includes('home lab'), 'the phrase survived');
  assert.ok(!keywords.includes('open'), 'the bare word did not');
  assert.ok(!keywords.includes('home'), 'the bare word did not');
});

test('a phrase made only of furniture is dropped whatever its length', () => {
  const ranked = extractKeywords(
    ['Read more on the home page', 'Read more on the home page today', 'Read more, home page'],
    { minPhrase: 1, minWord: 1 },
  );
  assert.ok(
    !ranked.some((k) => k.keyword === 'home page' || k.keyword === 'read more'),
    `furniture phrases survived: ${ranked.map((k) => k.keyword).join(', ')}`,
  );
});

test('a phrase repeated inside one block counts once', () => {
  // Otherwise a single long post that says "home lab" forty times outvotes
  // forty posts about forty different subjects.
  const once = extractKeywords(['home lab home lab home lab home lab'], { minPhrase: 1 });
  assert.equal(once.find((k) => k.keyword === 'home lab').count, 1);
});

test('phrases are ranked across blocks, longest phrase breaking a tie', () => {
  const blocks = [
    'Running a home lab on old hardware',
    'My home lab power draw, measured',
    'Home lab networking notes for beginners',
    'Unrelated post about sourdough starters',
  ];

  const ranked = extractKeywords(blocks);
  assert.equal(ranked[0].keyword, 'home lab', `ranked first, got ${ranked[0].keyword}`);
  assert.equal(ranked[0].count, 3);
  assert.equal(ranked[0].words, 2);
  assert.ok(
    !ranked.some((k) => k.keyword === 'sourdough'),
    'a word from a single post does not clear the threshold',
  );
});

test('thresholds fall back to the unfiltered ranking rather than nothing', () => {
  // A blog with three posts still has topics; they are just quieter than the
  // count>=3 / count>=2 bar the bookmarklet applies to a whole page.
  const ranked = extractKeywords(['A single short post about gardening']);
  assert.ok(ranked.length > 0, 'something came back');
  assert.ok(ranked.some((k) => k.keyword === 'gardening'));
});

test('blocks shorter than a phrase, and repeated blocks, are ignored', () => {
  const ranked = extractKeywords(['Menu', 'x', 'the same tagline here', 'the same tagline here'], {
    minPhrase: 2,
  });
  // The tagline appears twice but is one block, so nothing reaches a count of 2.
  assert.ok(!ranked.some((k) => k.count >= 2), 'a duplicated block was not counted twice');
});

test('topicSlug is URL-safe, keeps non-Latin script and spells out + and #', () => {
  assert.equal(topicSlug('Home Lab'), 'home-lab');
  assert.equal(topicSlug('c++'), 'c-plus-plus');
  assert.equal(topicSlug('C#'), 'c-sharp');
  assert.equal(topicSlug('  spaced  out  '), 'spaced-out');
  // A directory of the small web is not all Latin script; transliterating to
  // a-z would collapse this to the empty string and drop the topic.
  assert.equal(topicSlug('日本語'), '日本語');
  assert.equal(topicSlug('!!!'), '');
});

test('the same topic reaches one slug from three spellings', () => {
  assert.equal(topicSlug('Home Lab'), topicSlug('home-lab'));
  assert.equal(topicSlug('home lab'), topicSlug('HOME  LAB'));
});

test('feedTopics puts the publisher’s own tags first and does not duplicate them', () => {
  const topics = feedTopics({
    blocks: [
      'Running a home lab on old hardware',
      'My home lab power draw, measured',
      'Home lab networking notes for beginners',
    ],
    categories: ['Home Lab', 'Home Lab', 'Self Hosting'],
  });

  assert.equal(topics[0].source, 'category');
  assert.equal(
    topics.filter((t) => t.slug === 'home-lab').length,
    1,
    'the tag and the counted phrase collapsed into one topic',
  );
  assert.equal(topics.find((t) => t.slug === 'home-lab').count, 2, 'kept the tag count, not the phrase count');
  assert.ok(topics.some((t) => t.slug === 'self-hosting'));
});

test('feedTopics drops keywords that cannot be spelled in a URL', () => {
  const topics = feedTopics({ blocks: [], categories: ['!!!', '???'] });
  assert.deepEqual(topics, []);
});

test('feedTopics caps what it stores per feed', () => {
  // Enough recurring phrases to be sure the cap is what trimmed the list, not
  // the thresholds: ten distinct subjects, each in three blocks.
  const blocks = [];
  for (let i = 0; i < 10; i += 1) {
    for (let repeat = 0; repeat < 3; repeat += 1) {
      blocks.push(`subject${i} deep dive number ${repeat}, on kubernetes${i} clusters`);
    }
  }

  assert.ok(feedTopics({ blocks }, { max: 100 }).length > 5, 'the fixture has topics to spare');
  assert.equal(feedTopics({ blocks }, { max: 5 }).length, 5);
});

test('a plural and its singular are one topic, not two pages', () => {
  // The directory had "fountain pen" (16 feeds) and "fountain pens" (13) as
  // separate pages for one subject.
  assert.equal(topicSlug('fountain pens'), topicSlug('fountain pen'));
  assert.equal(topicSlug('fountain pens'), 'fountain-pen');

  assert.equal(topicSlug('ai agents'), 'ai-agent');
  assert.equal(topicSlug('book reviews'), 'book-review');
  assert.equal(topicSlug('home labs'), topicSlug('home lab'));
});

test('words that merely end in s keep their s', () => {
  // A suffix rule cannot tell these from plurals, so they are listed. Getting
  // one wrong means a topic page called "new" or "seri".
  for (const word of ['news', 'series', 'analysis', 'physics', 'css', 'ios', 'linux', 'kubernetes']) {
    assert.equal(singularize(word), word, `${word} was mangled`);
  }
});

test('the plural rules cover the shapes English actually uses', () => {
  assert.equal(singularize('stories'), 'story');
  assert.equal(singularize('boxes'), 'box');
  assert.equal(singularize('dishes'), 'dish');
  assert.equal(singularize('glasses'), 'glass');
  assert.equal(singularize('toys'), 'toy');

  // Not every -es is a plural marker: "notes" is "note", never "not".
  assert.equal(singularize('notes'), 'note');
  assert.equal(singularize('names'), 'name');

  // Too short to be worth guessing about.
  assert.equal(singularize('ies'), 'ies');
  assert.equal(singularize('js'), 'js');
});

test('an existing plural URL still resolves, because lookups normalise too', () => {
  // Nothing needs redirecting: /topics/fountain-pens is put through the same
  // function as the stored slug, so it lands on the merged page.
  assert.equal(topicSlug('fountain-pens'), 'fountain-pen');
  assert.equal(topicSlug('Fountain%20Pens'.replace('%20', ' ')), 'fountain-pen');
});
