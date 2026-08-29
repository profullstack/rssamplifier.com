-- An express lane for feeds a person submitted by hand.
--
-- `dueFeeds` orders by `next_fetch_at asc`, which is right for a directory that
-- is keeping up and exactly wrong for one that is not. A new submission is
-- stamped with `now`, and there are ~307,000 feeds from the bulk uploads whose
-- next_fetch_at is already in the past -- so a blog somebody submits today
-- sorts behind every one of them and is not crawled for days. The submitter
-- watches a status page that says "pending" and concludes the site is broken.
--
-- Priority is set only by the submit route, and only for a submission small
-- enough to have come from a person rather than an export. It is not a general
-- scheduling knob: nothing else writes it.
alter table feeds add column priority integer not null default 0;

-- Partial on purpose, and both halves of the predicate matter.
--
-- `priority > 0` keeps the index to the handful of hand-submitted feeds instead
-- of all 416,000. `last_fetched_at is null` is what makes the lane self-
-- clearing: the crawler sets that column on success *and* on failure, so a feed
-- leaves this index after exactly one attempt and cannot camp in the fast lane
-- for ever. Together they mean the express query reads an index that is
-- normally empty and never larger than one afternoon's submissions.
create index if not exists idx_feeds_express
  on feeds (next_fetch_at)
  where priority > 0 and last_fetched_at is null;
