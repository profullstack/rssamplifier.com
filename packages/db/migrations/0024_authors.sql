-- Authors: the people behind the feeds.
--
-- The directory has always stored `feeds.author` and `feed_items.author` as
-- bare text, and in production not one of 52,691 feeds had a value in it —
-- `markCrawlSuccess` never wrote the column. A name in a text field would not
-- have been worth much anyway: the useful thing about a small-web author is
-- not that they are called Jane, it is that Jane publishes a homepage, a
-- Mastodon account and a links page, and every one of those is a way to reach
-- her. So authors are their own rows with their own links, not a string.
--
-- Identity is keyed on a URL the person controls, never on their name. Name
-- alone would merge every John Smith in the directory into one person, which
-- is worse than storing him three times; a `rel="me"` homepage is a claim the
-- author made about themselves and is safe to merge on. When there is no such
-- URL the key falls back to name-plus-host, which keeps two unrelated Johns
-- apart at the cost of not noticing when they are the same man.

create table if not exists authors (
  id            text primary key,
  -- The public page: rssamplifier.com/authors/<slug>
  slug          text not null unique,
  -- What we merge on. Either a normalized URL the author controls, or
  -- '<normalized name>@<host of the feed they were found on>'.
  identity_key  text not null unique,

  name          text not null,
  -- Lowercased and whitespace-collapsed, for lookups that should not care
  -- about "Jane  Doe" vs "jane doe".
  norm_name     text not null,

  bio           text,
  avatar_url    text,
  -- Their own site, when they publish one distinct from the feed's.
  site_url      text,
  -- Only ever an address the author published as their own contact. Role
  -- mailboxes are dropped during extraction rather than stored and filtered
  -- later, because anything stored here is something somebody will email.
  email         text,

  -- 0..1. How sure we are the name belongs to a person who writes this feed,
  -- from the strength of the evidence that produced it. Consumers gate on it
  -- rather than treating every extraction as equally true.
  confidence    real not null default 0,

  created_at    text not null,
  updated_at    text not null
);

create index if not exists authors_norm_name_idx on authors (norm_name);
create index if not exists authors_confidence_idx on authors (confidence desc);

-- Where an author can be found. One row per URL, so a person with a Mastodon
-- account, a GitHub and a Linktree has three.
create table if not exists author_links (
  id         text primary key,
  author_id  text not null references authors (id) on delete cascade,

  -- 'website', 'mastodon', 'bluesky', 'github', 'linktree', 'email', … The
  -- vocabulary lives in packages/feed/src/identity.js; storing the label
  -- rather than a foreign key keeps a new network from needing a migration.
  network    text not null,
  url        text not null,
  -- '@jane@example.social', 'janedoe' — the part a human would type.
  handle     text,

  -- How we came to believe it: 'rel-me', 'h-card', 'json-ld', 'feed',
  -- 'linktree', 'page-link'. Kept because the weakest source, a bare link in
  -- a page footer, is also the one most likely to be the site's publisher
  -- rather than the author, and a consumer may want to exclude it.
  source     text not null,

  -- 1 when the destination links back — a rel="me" pair, which is the
  -- IndieWeb handshake and the only cheap proof that the account is really
  -- theirs and not merely mentioned by them.
  verified   integer not null default 0,

  created_at text not null,

  unique (author_id, url)
);

create index if not exists author_links_author_idx on author_links (author_id);
create index if not exists author_links_network_idx on author_links (network);

-- Which feeds an author writes. Many-to-many in both directions: a group blog
-- has several authors, and one person often publishes several feeds.
create table if not exists feed_authors (
  feed_id    text not null references feeds (id) on delete cascade,
  author_id  text not null references authors (id) on delete cascade,

  -- 'author' for a byline, 'owner' for the itunes:owner or the site's h-card
  -- — the person responsible for the feed, who may not write every post.
  role       text not null default 'author',
  confidence real not null default 0,
  -- The extraction step that credited them, for debugging a bad byline
  -- without re-running the crawl.
  evidence   text,

  created_at text not null,

  primary key (feed_id, author_id)
);

create index if not exists feed_authors_author_idx on feed_authors (author_id);

-- When this feed was last looked at for authorship, null for never.
--
-- Separate from the crawl schedule on purpose. Enrichment fetches the site's
-- HTML, which a crawl does not, so running it inline would add a second
-- request to every one of the directory's hourly feed fetches. People change
-- their links far more slowly than they publish, so this gets its own slow
-- pass over the directory instead.
alter table feeds add column authors_checked_at text;

-- The due query is "active feeds, least recently checked first", and nulls
-- sort first in SQLite ascending — which is exactly the wanted order, since a
-- feed that has never been checked should be checked before one that has.
create index if not exists feeds_authors_due_idx
  on feeds (authors_checked_at) where status = 'active';
