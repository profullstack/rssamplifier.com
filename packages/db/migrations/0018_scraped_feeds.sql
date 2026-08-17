-- Feeds this directory built itself, for sites that publish none.
--
-- Marked rather than inferred. A scraped source's feed_url is the page it was
-- read off, which is indistinguishable from an ordinary site URL, and the
-- re-crawl has to know which of the two it is holding: fetching a page and
-- parsing it as XML fails, and fetching a real feed and scraping it for links
-- returns nothing.
--
-- It also keeps a temporary outage honest. Without the column, a blog whose
-- feed 404s for an afternoon would be silently converted into a scraped page by
-- the next crawl and would never go back, because nothing would remember that
-- it used to publish properly.
alter table feeds
  add column source_kind text not null default 'feed'
  check (source_kind in ('feed', 'scraped'));

-- The crawler asks for due feeds by next_fetch_at and then needs to know how to
-- fetch each one. Carrying source_kind in that index keeps the lookup covering.
create index if not exists feeds_due_kind_idx
  on feeds (next_fetch_at, source_kind) where status <> 'dead';
