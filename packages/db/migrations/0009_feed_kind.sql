-- What kind of thing a feed is, so the directory can be browsed as blogs and
-- podcasts rather than one undifferentiated list.
--
-- The value is derived from the feed document itself (an audio enclosure, or
-- the itunes/podcast namespaces), never from the submitter — anyone can add a
-- feed here, so a self-declared category would be a free-text field filled in
-- by whoever wanted their blog listed under podcasts.
--
-- 'blog' is the default because it is what an unclassified feed is: the column
-- is re-derived on every successful crawl, so the directory converges on the
-- truth as the poller works through it and no backfill script is needed. Feeds
-- already marked dead never crawl again and stay 'blog', which is the right
-- answer for a listing nobody can verify anymore.

alter table feeds add column kind text not null default 'blog'
  check (kind in ('blog', 'podcast'));

-- Category pages select one kind newest-first, so the index carries the
-- ordering as well as the filter. (created_at, id) rather than created_at alone
-- for the reason the sitemap index gives: the directory was bulk imported, tens
-- of thousands of rows share a created_at to the second, and paging through an
-- undefined order repeats rows on one page while dropping them from another.
create index if not exists feeds_kind_created_idx
  on feeds (kind, created_at desc, id desc) where status <> 'dead';
