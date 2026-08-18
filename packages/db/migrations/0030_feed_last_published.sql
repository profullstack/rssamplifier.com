-- When this feed last published anything, as opposed to when we last read it.
--
-- Those are two different facts and the directory could only state one of them.
-- `last_success_at` says when the crawler last succeeded; nothing said whether
-- the publisher was still publishing. An agent pulling a post out of here is
-- trusting both, cannot check either, and the failure is silent in both
-- directions -- a retired blog served from a fresh crawl looks exactly like a
-- live one.
--
-- It matters at this scale rather than in principle: sampling 400 active feeds
-- in production, **15.8% had published nothing in over two years** and three
-- quarters had published nothing in a month. A sixth of the directory is
-- dormant, and until now a page or an API response had no way to say so.
--
-- Derived rather than joined. The obvious implementation is
-- `max(published_at)` over feed_items per feed, and that is exactly the join
-- 0017 already established must never be run on a page: against this database a
-- feed_items-to-feeds aggregate took 215 seconds. The crawler, on the other
-- hand, has the newest date in hand for free -- it already reads every
-- document's dates to schedule the feed (packages/ingest/src/cadence.js), so
-- this column costs one more bound parameter on a write that was happening
-- anyway.
--
-- Null until a feed's next crawl, and callers must treat it as "not known yet"
-- rather than as "never published". The feed page falls back to the newest post
-- in the list it has already loaded, so the signal is right immediately for
-- anything anybody actually looks at; everything else fills in over one crawl
-- cycle.
alter table feeds add column last_published_at text;

-- Answering "what in this directory has gone quiet" without a scan.
--
-- Partial, because null means "not crawled since this column existed" and those
-- rows are not evidence of anything -- including them would make the index
-- mostly a list of feeds we simply have not asked yet, and would double its
-- size on the way.
create index if not exists feeds_last_published_idx
  on feeds (last_published_at)
  where last_published_at is not null;
