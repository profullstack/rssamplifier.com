/**
 * What the directory is writing about more than it was last week.
 *
 * Grouping two weeks of feed_items on a request does not finish (a plain count
 * over the range timed out at 90 seconds on 2026-11-07), so each finished UTC
 * day is rolled up once into trend_days and trend_terms and the API reads those.
 *
 * Three choices the shape of the data forces:
 *
 *   - Feeds, not items. One npm firehose posts more than a thousand blogs, so a
 *     term counts once per feed per day.
 *   - A sample. One item in four is plenty to see a subject moving, and it keeps
 *     a day to about 70k rows.
 *   - Rates, not counts. The crawler's reach changes from week to week, so both
 *     sides are compared per feed sampled.
 */
import { nowIso } from './client.js';

const PAGE = 5000;
const SAMPLE_MOD = 4;
/** Below this many sampled feeds a term is one newsroom's vocabulary. */
const MIN_DAY_FEEDS = 3;
const MIN_WINDOW_FEEDS = 10;
/** A term must be at least this much more common than the week before. */
const MIN_LIFT = 1.5;
/** Smooths a term that was absent last week, so 12 from nothing is not infinite. */
const PRIOR_FLOOR = 3;
const KEEP_DAYS = 30;
const DAY_MS = 86_400_000;

const STOP = new Set(
  `a about after again against all also am an and any are around as at away back be because been before being
  best between big both but by can could day days did do does done down during each even every first for from
  get gets getting go goes going good got great had has have having he her here hers him his how i if in inside
  into is it its just know last latest less like live look looks made make makes many may me might more most much
  must my near need needs never new news next no not now of off old on once one only onto or other our out over
  own part people per place read really report reports right said same say says see she should show shows since
  so some still such take takes than that the their them then there these they thing things think this those
  three through time times to today together tomorrow too top two under until up update updates us use used using
  very via video vs want wants was watch way ways we week weeks well were what when where which while who whose
  why will win with within without work works world would year years yesterday yet you your
  january february march april may june july august september october november december
  monday tuesday wednesday thursday friday saturday sunday
  episode podcast review blog post article page free online home guide tips`.split(/\s+/),
);

// Feeds declare English and publish something else: on the sample day most of
// the false trends were Indonesian. A headline with one of these is not English
// enough to count, and a headline with none of ENGLISH cannot be shown to be.
const FOREIGN = new Set(
  'dan yang di dengan untuk ke dari pada ini itu de la el los las del para por una con und der die das ein eine le les des du et que em do da os um nao il di per sono het een van'.split(
    ' ',
  ),
);
const ENGLISH = new Set(
  'the of to in for and on with is at from by an as after how why what who are was will has have be that this it its over his her their'.split(
    ' ',
  ),
);

const words = (title) =>
  (String(title ?? '')
    .toLowerCase()
    .replace(/&#?[a-z0-9]+;|https?:\S+/g, ' ')
    .replace(/[‘’]/g, "'")
    .match(/[a-z0-9][a-z0-9+#.'-]*[a-z0-9+#]|[a-z]/g) ?? []
  ).map((w) => w.replace(/'s$/, ''));

export function isEnglishTitle(title) {
  const list = words(title);
  return list.some((w) => ENGLISH.has(w)) && !list.some((w) => FOREIGN.has(w));
}

const usable = (word) =>
  !!word && word.length >= 3 && word.length <= 24 && !STOP.has(word) && !/^[0-9.+#'-]+$/.test(word);

/** Single words and adjacent pairs, the pairs being what names a subject. */
export function titleTerms(title) {
  const list = words(title);
  const out = new Set();
  for (let i = 0; i < list.length; i++) {
    if (!usable(list[i])) continue;
    out.add(list[i]);
    if (usable(list[i + 1])) out.add(`${list[i]} ${list[i + 1]}`);
  }
  return out;
}

/** @param {Iterable<{ feed_id: string, title: string }>} rows */
export function tallyTerms(rows) {
  const byFeed = new Map();
  let items = 0;
  for (const row of rows) {
    if (!isEnglishTitle(row.title)) continue;
    items++;
    let terms = byFeed.get(row.feed_id);
    if (!terms) byFeed.set(row.feed_id, (terms = new Set()));
    for (const term of titleTerms(row.title)) terms.add(term);
  }
  const terms = new Map();
  for (const seen of byFeed.values()) {
    for (const term of seen) terms.set(term, (terms.get(term) ?? 0) + 1);
  }
  return { feeds: byFeed.size, items, terms };
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Rolls one UTC day up, replacing any earlier result for it. */
export async function rollupTrendDay(db, day) {
  const from = `${day}T00`;
  const to = `${isoDay(Date.parse(`${day}T00:00:00Z`) + DAY_MS)}T00`;
  // Skips a backfill: a feed crawled for the first time brings years of posts
  // with today's created_at, and those are not what anyone is writing today.
  const oldest = isoDay(Date.parse(`${day}T00:00:00Z`) - 3 * DAY_MS);

  const rows = [];
  let after = 0;
  for (;;) {
    const page = await db.execute({
      sql: `select i.rowid as rowid, i.feed_id, i.title
              from feed_items i join feeds f on f.id = i.feed_id
             where i.created_at >= ? and i.created_at < ? and i.rowid > ?
               and i.rowid % ? = 0
               and i.published_at >= ?
               and f.category in ('blog', 'news')
               and (f.language is null or lower(f.language) like 'en%')
             order by i.rowid
             limit ?`,
      args: [from, to, after, SAMPLE_MOD, oldest, PAGE],
    });
    for (const row of page.rows) rows.push({ feed_id: row.feed_id, title: row.title });
    if (page.rows.length < PAGE) break;
    after = Number(page.rows.at(-1).rowid);
  }

  const { feeds, items, terms } = tallyTerms(rows);
  const kept = [...terms].filter(([, n]) => n >= MIN_DAY_FEEDS);
  await db.execute({ sql: 'delete from trend_days where day = ?', args: [day] });
  await db.execute({
    sql: 'insert into trend_days (day, feeds, items, rolled_at) values (?, ?, ?, ?)',
    args: [day, feeds, items, nowIso()],
  });
  for (let i = 0; i < kept.length; i += 500) {
    const chunk = kept.slice(i, i + 500);
    await db.execute({
      sql: `insert into trend_terms (day, term, feeds) values ${chunk.map(() => '(?, ?, ?)').join(', ')}`,
      args: chunk.flatMap(([term, n]) => [day, term, n]),
    });
  }
  return { day, feeds, items, terms: kept.length };
}

/**
 * Rolls up the finished days still missing, oldest first. The first run does a
 * fortnight, a sample of about 70k rows a day; after that it is one day a day.
 *
 * @param {{ now?: number, days?: number }} [options]
 */
export async function rollupTrendDays(db, { now = Date.now(), days = 15 } = {}) {
  const wanted = Array.from({ length: days }, (_, i) => isoDay(now - (days - i) * DAY_MS));
  const { rows } = await db.execute({ sql: 'select day from trend_days where day >= ?', args: [wanted[0]] });
  const have = new Set(rows.map((row) => row.day));
  const done = [];
  for (const day of wanted.filter((d) => !have.has(d))) {
    done.push(await rollupTrendDay(db, day));
  }
  await db.execute({ sql: 'delete from trend_days where day < ?', args: [isoDay(now - KEEP_DAYS * DAY_MS)] });
  return done;
}

/**
 * Ranks terms from two windows.
 *
 * A subject shows up as a handful of overlapping terms (joshua wong, wong,
 * activist joshua, wong sentenced), so walking down the ranking keeps the first
 * and drops anything sharing a word with what is already kept. Pairs rank ahead
 * of their own single words because they say what the subject is.
 */
export function rankTerms({ current, prior, currentFeeds, priorFeeds, limit = 50 }) {
  if (!(currentFeeds > 0) || !(priorFeeds > 0)) return [];
  const scored = [];
  for (const [term, count] of current) {
    if (count < MIN_WINDOW_FEEDS) continue;
    const before = prior.get(term) ?? 0;
    const scaledBefore = (before * currentFeeds) / priorFeeds;
    const lift = count / (scaledBefore + PRIOR_FLOOR);
    if (lift < MIN_LIFT) continue;
    const pair = term.includes(' ') ? 1.5 : 1;
    scored.push({ topic: term, count, prior_count: before, score: Math.round(lift * Math.log2(count) * pair * 100) / 100 });
  }
  scored.sort((a, b) => b.score - a.score || b.count - a.count);

  const taken = new Set();
  const out = [];
  for (const row of scored) {
    const parts = row.topic.split(' ');
    if (parts.some((w) => taken.has(w))) continue;
    parts.forEach((w) => taken.add(w));
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The current ranking: the latest `window` rolled days against the `window`
 * before them.
 *
 * @param {{ window?: number, limit?: number }} [options]
 */
export async function trendingTerms(db, { window = 7, limit = 50 } = {}) {
  const { rows: days } = await db.execute({
    sql: 'select day, feeds, items, rolled_at from trend_days order by day desc limit ?',
    args: [window * 2],
  });
  const empty = { topics: [], days: days.length, feeds: 0, generatedAt: days[0]?.rolled_at ?? null };
  if (days.length < 2) return empty;
  // Fewer than two full windows splits what there is, rather than showing nothing.
  const size = Math.min(window, Math.floor(days.length / 2));
  const recent = days.slice(0, size);
  const earlier = days.slice(size, size * 2);
  const sum = async (span) => {
    const { rows } = await db.execute({
      sql: `select term, sum(feeds)::bigint as feeds from trend_terms
             where day >= ? and day <= ? group by term`,
      args: [span.at(-1).day, span[0].day],
    });
    return new Map(rows.map((row) => [row.term, Number(row.feeds)]));
  };
  const feedsIn = (span) => span.reduce((n, d) => n + Number(d.feeds), 0);
  const topics = rankTerms({
    current: await sum(recent),
    prior: await sum(earlier),
    currentFeeds: feedsIn(recent),
    priorFeeds: feedsIn(earlier),
    limit,
  });
  return { topics, days: days.length, feeds: feedsIn(recent), generatedAt: days[0].rolled_at };
}
