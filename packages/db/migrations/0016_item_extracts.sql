-- The article, read off a page the reader was not allowed to frame.
--
-- Kept apart from feed_items.content_html on purpose. That column is what the
-- publisher put in their own feed; this is what we made of their page, and the
-- two have different provenance, different trust and different reasons to be
-- thrown away. Conflating them would also mean rewriting feed_items on every
-- read, and feed_items carries the FTS triggers — every extraction would
-- reindex a row whose title and summary never changed.
--
-- One row per post, not per URL: the reader addresses a post, the toolbar
-- moves between posts, and a URL that two feeds both carry is two posts here
-- anyway.

create table if not exists item_extracts (
  item_id      text primary key references feed_items (id) on delete cascade,
  -- Where it was actually read from, after redirects — which is what the
  -- article's own relative links were resolved against.
  url          text not null,

  title        text,
  byline       text,
  excerpt      text,
  site_name    text,
  -- Sanitized before it is stored, not on the way out: nothing should be able
  -- to read this table and render it without the allowlist having run.
  content_html text,
  -- Characters of text, so "did this work" is a number rather than a guess.
  --
  -- Not called `length`: a libSQL row is array-like, so `row.length` reads the
  -- number of columns and every extraction silently reports the same size.
  text_length  integer not null default 0,

  -- ok: an article worth showing. empty: the page parsed to nothing useful,
  -- which is the normal answer for a paywall or a JavaScript-only page.
  -- blocked: the site refused us. error: the fetch itself failed.
  status       text not null check (status in ('ok', 'empty', 'blocked', 'error')),
  reason       text,

  fetched_at   text not null
);

-- Failures are retried, successes are not, and both decisions are made by age.
create index if not exists item_extracts_fetched_idx on item_extracts (status, fetched_at);
