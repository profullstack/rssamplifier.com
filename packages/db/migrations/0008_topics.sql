-- Topics: what a feed is about, so the directory can be browsed by subject.
--
-- Two sources feed this. A publisher's own <category> tags are the better
-- evidence and are stored per item, because they belong to the post rather than
-- to the blog — and because most publishers leave them empty, which is exactly
-- why they cannot be the only source. The rest is extracted from the text the
-- feed already gives us, by the same phrase-counting the keyword bookmarklet
-- does on a rendered page.

alter table feed_items add column categories text not null default '[]';

-- One row per (feed, topic). Keywords are derived, so this table is disposable:
-- a feed's rows are replaced wholesale when it is re-crawled, and losing the
-- table entirely would cost a crawl cycle rather than any real data.
create table if not exists feed_keywords (
  feed_id text not null references feeds (id) on delete cascade,
  -- The URL form, and the primary key half that matters: /topics/<slug>.
  slug    text not null,
  -- The human form, for display. Differs from the slug for anything with a
  -- space, a + or a # in it.
  keyword text not null,
  words   integer not null default 1,
  -- Blocks the phrase appeared in, or items carrying the category.
  count   integer not null default 0,
  -- 'category' is the publisher's own tag, 'content' is counted from the text.
  -- Kept apart so a topic page can say which it is, and so a future change of
  -- extraction can rewrite one without touching the other.
  source  text not null default 'content' check (source in ('content', 'category')),

  primary key (feed_id, slug)
);

-- The topic page's query: every feed on one slug, strongest first.
create index if not exists feed_keywords_slug_idx on feed_keywords (slug, count desc);

-- A rollup of the above, so the topics index does not group over the whole
-- table on every request.
--
-- It is refreshed on a timer by the poller rather than maintained by each
-- crawl: a crawl replaces one feed's keywords, and turning that into exact
-- per-topic deltas means reading the old rows back to diff them, on every feed,
-- forever. The index is a browsing aid — being a few minutes behind the
-- keywords costs nothing, and a topic's own page reads feed_keywords directly
-- and is never stale.
create table if not exists topics (
  slug         text primary key,
  keyword      text not null,
  feed_count   integer not null default 0,
  refreshed_at text not null
);

create index if not exists topics_popular_idx on topics (feed_count desc, slug);
