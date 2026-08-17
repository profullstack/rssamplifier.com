/**
 * Keyword extraction — what /topics/:keyword is built out of.
 *
 * This is a port of the keyword bookmarklet, which ranks a page by counting
 * one-, two- and three-word phrases across its visible text blocks. The
 * algorithm is kept deliberately identical so that running the bookmarklet on a
 * blog and reading that blog's topics page produce recognisably the same list:
 * same tokenizer, same stopword list, same per-block phrase deduplication, same
 * thresholds, same sort.
 *
 * What differs is where the blocks come from. In a browser they are headings,
 * paragraphs and alt text pulled out of the DOM with the chrome (nav, header,
 * footer, forms) excluded. Here the feed has already done that work: an item's
 * title and summary are the article's own text with the markup stripped, so
 * there is no chrome to filter out and no DOM to walk.
 *
 * A feed's `<category>` tags are the other source. Publishers are supposed to
 * fill them in and mostly do not, so they cannot be the whole story — but when
 * they are there they are an author's own classification of their work, which
 * is better evidence than any amount of counting, and they are treated as
 * topics regardless of how often the words recur.
 */

/**
 * Grammar words, which are never a topic in any context.
 *
 * The first half of the bookmarklet's list, verbatim, plus the apostrophe-less
 * contractions. Those are an artefact of this input rather than an improvement
 * on the original: the tokenizer strips apostrophes, so a blog written in the
 * first person yields "ive" and "dont" as words, and on a page of headings and
 * nav labels there is far less of that than in a feed full of prose.
 *
 * Same for the prepositions in the last group, which the original list simply
 * does not have. They are grammar in any context — "after" was never going to
 * be a topic — and they only surface here because sentences use many more of
 * them than headings do.
 */
const STOPWORDS = new Set(
  `a an and are as at be been being but by can could did do does doing done for from had has
   have having he her here hers herself him himself his how i if in into is it its itself just
   may me might more most my myself no nor not of off on once only or other our ours ourselves
   out over own same she should so some such than that the their theirs them themselves then
   there these they this those through to too under until up us very was we were what when
   where which while who whom why will with would you your yours yourself yourselves all any
   each few many much another every either

   ive im id ill dont cant wont didnt doesnt isnt arent wasnt werent hasnt havent hadnt
   wouldnt couldnt shouldnt thats theres theyre theyve youre youve youll weve wed lets

   after before during since without within upon about above below between against again
   further both because per via`
    .trim()
    .split(/\s+/),
);

/**
 * The bookmarklet's second half: page furniture and filler.
 *
 * In a browser these are what a page says about itself — the nav labels, the
 * calls to action, the "read more" under every excerpt. They are junk there,
 * and as bare words they are junk here too.
 *
 * But they are *not* junk inside a phrase, and that difference matters more in
 * feed text than it does on a page. Half the subjects this directory exists to
 * index are two-word phrases whose first word is on this list: home lab, open
 * source, free software, show notes, search engines, best practices. Filtering
 * these words out of the token stream — which is what the bookmarklet does,
 * correctly, for a page full of chrome — turns "home lab" into "lab" and loses
 * "open source" entirely.
 *
 * So they are dropped from the ranking rather than from the text: a phrase may
 * contain them, a one-word topic may not be one, and a phrase made of nothing
 * but them ("home page", "read more") is furniture whatever its length.
 *
 * The second group is prose filler, which the bookmarklet has no need for and
 * this does. A page is mostly headings and labels; a feed is mostly sentences,
 * and sentences produce "like", "just" and "something" at rates that clear any
 * frequency threshold. They are handled under the same rule, so "machine
 * learning" is untouched while "learning something" and "like" are not topics.
 */
const FURNITURE = new Set(
  `page website site click open close menu search login log sign subscribe view read learn see
   show next previous back home share follow loading new now today free best top get use using
   used

   like just really thing things lot way ways going want need know think say says said make
   makes made still even also well around actually probably maybe something someone anything
   everything nothing`
    .trim()
    .split(/\s+/),
);

/** Phrase lengths counted, exactly as the bookmarklet counts them. */
const SIZES = [1, 2, 3];

/** A block shorter than this is a label, not a sentence. */
const MIN_BLOCK = 8;

/**
 * Split text into countable words.
 *
 * `+`, `#` and `-` survive the punctuation strip so that c++, c#, self-hosted
 * and e-ink stay single words rather than being torn into fragments that mean
 * nothing on their own.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}+#-]+/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^-+|-+$/g, ''))
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w) && !/^[\p{N}]+$/u.test(w));
}

/**
 * Words that end in s without being plural.
 *
 * A suffix rule cannot tell "news" from "keys", so the exceptions are listed.
 * Short and deliberately unambitious: the cost of missing one is two topic
 * pages where there should be one, and the cost of over-stripping is a page
 * called "new" that nobody searches for.
 */
const NEVER_PLURAL = new Set([
  'news', 'physics', 'mathematics', 'economics', 'politics', 'ethics', 'linguistics',
  'series', 'species', 'analysis', 'basis', 'crisis', 'thesis', 'chaos',
  'lens', 'bus', 'gas', 'plus', 'virus', 'status', 'focus', 'bonus', 'campus', 'census',
  'css', 'js', 'aws', 'ios', 'macos', 'linux', 'unix', 'sass', 'redis', 'kubernetes',
]);

/**
 * The singular of a word, for the purpose of naming a topic.
 *
 * "fountain pen" and "fountain pens" are one subject, and the directory had
 * them as two pages with sixteen and thirteen feeds. Folding the plural onto
 * the singular merges them.
 *
 * Deliberately not the stemmer in relevance.js, which is tuned for matching
 * rather than naming: it strips "es" from anything long enough, so "notes"
 * becomes "not" and "series" becomes "seri". That is fine when the output is
 * compared and discarded, and wrong when the output is a URL somebody reads.
 *
 * @param {string} word
 * @returns {string}
 */
export function singularize(word) {
  const w = String(word ?? '');
  if (NEVER_PLURAL.has(w) || w.length < 4) return w;

  // stories -> story, but not ties -> ty
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;

  // boxes -> box, dishes -> dish, glasses -> glass. Only after the sounds that
  // actually take -es; "notes" is not "not".
  if (w.length > 4 && /(?:ss|sh|ch|x|z|o)es$/.test(w)) return w.slice(0, -2);

  // The ordinary plural, minus the endings that are not one.
  if (w.endsWith('s') && !/(?:ss|us|is|os)$/.test(w)) return w.slice(0, -1);

  return w;
}

/**
 * The URL form of a keyword: /topics/agentic-coding.
 *
 * Unicode letters are kept rather than transliterated away — a directory of the
 * small web is not all Latin script, and stripping to a-z would collapse every
 * non-Latin topic to the empty string and silently drop it. `+` and `#` become
 * words because a slug cannot carry them: without that, c++ and c# would both
 * slug to "c" and share one topic page with the letter C.
 *
 * @param {string} keyword
 * @returns {string} slug, or '' when nothing addressable is left
 */
export function topicSlug(keyword) {
  const slug = String(keyword ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/#/g, ' sharp ')
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');

  // Singularised word by word, so "fountain pens" and "fountain pen" are one
  // page rather than two. Because every lookup runs through this same function,
  // the plural URL keeps working and resolves to the merged topic — there is
  // nothing to redirect.
  return slug
    .split('-')
    .map((word) => singularize(word))
    .join('-');
}

/**
 * Rank the phrases in a set of text blocks.
 *
 * A phrase is counted once per block however often it repeats inside it, which
 * is what stops a single long post about one subject from outvoting twenty
 * posts about twenty others.
 *
 * The thresholds are the bookmarklet's: a bare word has to appear in three
 * blocks to count, a phrase in two, because a two-word phrase recurring at all
 * is already a stronger signal than a word recurring twice. When nothing clears
 * the bar the unfiltered ranking is returned rather than an empty list — a
 * small blog still has topics, they are just quieter.
 *
 * @param {string[]} blocks
 * @param {{ max?: number, minWord?: number, minPhrase?: number }} [opts]
 * @returns {Array<{ keyword: string, words: number, count: number }>}
 */
export function extractKeywords(blocks, opts = {}) {
  const { max = 250, minWord = 3, minPhrase = 2 } = opts;

  const seen = new Set();
  const usable = [];
  for (const block of blocks) {
    const text = String(block ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    // Deduplicated the way the bookmarklet deduplicates its blocks: a blog that
    // repeats its own tagline under every post should not have the tagline
    // counted once per post.
    if (text.length < MIN_BLOCK || seen.has(text)) continue;
    seen.add(text);
    usable.push(text);
  }

  /** @type {Map<string, { keyword: string, words: number, count: number }>} */
  const counts = new Map();

  for (const block of usable) {
    const words = tokenize(block);

    for (const size of SIZES) {
      const phrases = new Set();
      for (let i = 0; i <= words.length - size; i += 1) {
        phrases.add(words.slice(i, i + size).join(' '));
      }
      for (const phrase of phrases) {
        const row = counts.get(phrase) ?? { keyword: phrase, words: size, count: 0 };
        row.count += 1;
        counts.set(phrase, row);
      }
    }
  }

  const all = [...counts.values()]
    // Furniture is dropped here rather than in the tokenizer, so that "home
    // lab" survives while "home" and "home page" do not. See FURNITURE.
    .filter((x) => x.keyword.split(' ').some((w) => !FURNITURE.has(w)))
    .sort((a, b) => b.count - a.count || b.words - a.words || a.keyword.localeCompare(b.keyword));

  const ranked = all.filter((x) => (x.words === 1 ? x.count >= minWord : x.count >= minPhrase));
  return (ranked.length ? ranked : all).slice(0, max);
}

/**
 * The topics of one feed: its categories first, then what its writing is about.
 *
 * Categories are not counted and not thresholded. A publisher who tagged a post
 * "homelab" has said something about it that no amount of word frequency can
 * establish, so those go in whole — deduplicated against the counted keywords,
 * which frequently rediscover the same word from the prose and would otherwise
 * list it twice.
 *
 * Keywords that slug to nothing are dropped rather than stored: a topic that
 * cannot be spelled in a URL has no page to link to.
 *
 * @param {{ blocks?: string[], categories?: string[] }} input
 * @param {{ max?: number }} [opts]
 * @returns {Array<{ slug: string, keyword: string, words: number, count: number, source: string }>}
 */
export function feedTopics({ blocks = [], categories = [] }, opts = {}) {
  const { max = 25 } = opts;

  /** @type {Map<string, { slug: string, keyword: string, words: number, count: number, source: string }>} */
  const bySlug = new Map();

  const tally = new Map();
  for (const raw of categories) {
    const keyword = String(raw ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (!keyword || keyword.length > 60) continue;
    tally.set(keyword, (tally.get(keyword) ?? 0) + 1);
  }

  for (const [keyword, count] of tally) {
    const slug = topicSlug(keyword);
    if (!slug) continue;
    bySlug.set(slug, {
      slug,
      keyword,
      words: keyword.split(' ').length,
      count,
      source: 'category',
    });
  }

  for (const row of extractKeywords(blocks)) {
    const slug = topicSlug(row.keyword);
    // A category already claimed this topic; its own count stays, because the
    // author's tag is the stronger claim on what the feed is about.
    if (!slug || bySlug.has(slug)) continue;
    bySlug.set(slug, { slug, keyword: row.keyword, words: row.words, count: row.count, source: 'content' });
  }

  // Categories first whatever their counts, then the counted keywords in rank
  // order. Sorting the two together by count would bury a category that appears
  // on three posts under a word that appears on thirty.
  const rows = [...bySlug.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'category' ? -1 : 1;
    return b.count - a.count || b.words - a.words || a.keyword.localeCompare(b.keyword);
  });

  return rows.slice(0, max);
}
