-- Where a feed can be found, when we cannot say who writes it.
--
-- The authors table answers "who publishes this, and how do I reach them",
-- which needs a name. Plenty of the small web does not give one: a blog with a
-- Mastodon link in its footer and no byline anywhere is a common shape, and on
-- a first pass over fifteen production feeds twelve published at least one
-- account while only nine named anybody. Every one of those accounts was being
-- discarded, because a link with nobody to attach it to had nowhere to go.
--
-- A footer's accounts are also the right home for a group blog's links. The
-- author path deliberately refuses to attribute them — a page crediting three
-- people does not say which of them the Mastodon belongs to — and until now
-- that refusal meant losing them rather than filing them correctly.
--
-- So: links belong to the feed, and separately to a person when we know one.
-- The two are not the same claim and are not stored as if they were.

create table if not exists feed_links (
  id         text primary key,
  feed_id    text not null references feeds (id) on delete cascade,

  -- Same vocabulary as author_links, from packages/feed/src/identity.js.
  network    text not null,
  url        text not null,
  handle     text,
  source     text not null,
  verified   integer not null default 0,

  created_at text not null,

  unique (feed_id, url)
);

create index if not exists feed_links_feed_idx on feed_links (feed_id);
create index if not exists feed_links_network_idx on feed_links (network);
