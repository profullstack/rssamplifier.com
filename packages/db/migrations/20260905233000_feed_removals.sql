-- Feeds removed at the owner's request, and kept out for good.
--
-- Deleting a feed's rows honours a removal request for exactly as long as it
-- takes discovery or a resubmission to find the same URL again. This table is
-- the memory: every insert path checks it, so a publisher who asked to be
-- taken down stays down without anyone having to remember them.
--
-- Matching is by host as well as by exact URL. A Substack, a Ghost site or a
-- personal domain is one publisher, and the request was about the publisher,
-- not about one of their several feed URLs.

create table if not exists feed_removals (
  id            text primary key,
  -- The URL that was removed, as it appeared in feeds.feed_url.
  feed_url      text not null unique,
  -- Lower-case hostname of that URL, without a leading "www.". Any feed on this
  -- host is refused.
  host          text not null,
  -- What the row looked like when it went, for the record.
  slug          text,
  title         text,
  -- Why, and who asked: a name or address from the request email, or 'operator'.
  reason        text,
  requested_by  text,
  -- How much went with it.
  items_removed integer not null default 0,
  created_at    text not null
);

create index if not exists feed_removals_host_idx on feed_removals (host);
