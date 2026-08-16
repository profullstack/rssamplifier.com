-- rssamplifier.com — schema for Turso / libSQL (SQLite).
--
-- Anyone may submit a feed and nobody has an account, so there are no owner
-- columns and no row-level security: SQLite has none, and every write already
-- goes through the server, which is the only holder of the auth token.
--
-- Timestamps are ISO-8601 TEXT. SQLite has no native date type, and ISO-8601
-- sorts correctly as a string, so ordering and range queries work unchanged.

create table if not exists feeds (
  id                     text primary key,
  -- The public identity of a blog: rssamplifier.com/<slug>
  slug                   text not null unique,
  feed_url               text not null unique,
  site_url               text,
  title                  text not null,
  description            text,
  language               text,
  image_url              text,
  author                 text,
  -- JSON array; SQLite has no array type and json_each() covers the few
  -- queries that need to look inside.
  categories             text not null default '[]',

  -- pending: accepted, not yet crawled. active: healthy.
  -- error: failing but still retried. dead: given up, page still served.
  status                 text not null default 'pending'
                         check (status in ('pending', 'active', 'error', 'dead')),

  last_fetched_at        text,
  last_success_at        text,
  last_error             text,
  error_count            integer not null default 0,
  -- Backoff is per feed so one flaky host is throttled alone.
  fetch_interval_minutes integer not null default 60,
  next_fetch_at          text not null,

  item_count             integer not null default 0,
  created_at             text not null,
  updated_at             text not null
);

create index if not exists feeds_due_idx on feeds (next_fetch_at) where status <> 'dead';
create index if not exists feeds_created_idx on feeds (created_at desc);
create index if not exists feeds_status_idx on feeds (status);

create table if not exists feed_items (
  id           text primary key,
  feed_id      text not null references feeds (id) on delete cascade,
  -- guid is only unique within its feed, hence the composite constraint.
  guid         text not null,
  url          text,
  title        text not null,
  summary      text,
  content_html text,
  author       text,
  image_url    text,
  published_at text,
  created_at   text not null,

  unique (feed_id, guid)
);

create index if not exists feed_items_feed_pub_idx on feed_items (feed_id, published_at desc);
create index if not exists feed_items_pub_idx on feed_items (published_at desc);

-- Audit trail for a wholly open endpoint. ip_hash is a salted HMAC, never a raw
-- address, so abuse triage stays possible without storing personal data.
create table if not exists submissions (
  id             text primary key,
  kind           text not null check (kind in ('url', 'list', 'opml')),
  raw_input      text,
  accepted_count integer not null default 0,
  rejected_count integer not null default 0,
  errors         text not null default '[]',
  ip_hash        text,
  user_agent     text,
  created_at     text not null
);

create index if not exists submissions_ip_idx on submissions (ip_hash, created_at desc);
create index if not exists submissions_created_idx on submissions (created_at desc);

-- ---------------------------------------------------------------- search
--
-- FTS5 in external-content mode: the index stores no copy of the text, it
-- points back at feed_items by rowid. Cheaper to store, but it means the
-- triggers below are mandatory — without them the index silently drifts.

create virtual table if not exists feed_items_fts using fts5 (
  title,
  summary,
  content = 'feed_items',
  content_rowid = 'rowid',
  tokenize = 'porter unicode61'
);

create trigger if not exists feed_items_ai after insert on feed_items begin
  insert into feed_items_fts (rowid, title, summary)
  values (new.rowid, new.title, new.summary);
end;

create trigger if not exists feed_items_ad after delete on feed_items begin
  insert into feed_items_fts (feed_items_fts, rowid, title, summary)
  values ('delete', old.rowid, old.title, old.summary);
end;

create trigger if not exists feed_items_au after update on feed_items begin
  insert into feed_items_fts (feed_items_fts, rowid, title, summary)
  values ('delete', old.rowid, old.title, old.summary);
  insert into feed_items_fts (rowid, title, summary)
  values (new.rowid, new.title, new.summary);
end;

create virtual table if not exists feeds_fts using fts5 (
  title,
  description,
  content = 'feeds',
  content_rowid = 'rowid',
  tokenize = 'porter unicode61'
);

create trigger if not exists feeds_ai after insert on feeds begin
  insert into feeds_fts (rowid, title, description)
  values (new.rowid, new.title, new.description);
end;

create trigger if not exists feeds_ad after delete on feeds begin
  insert into feeds_fts (feeds_fts, rowid, title, description)
  values ('delete', old.rowid, old.title, old.description);
end;

create trigger if not exists feeds_au after update on feeds begin
  insert into feeds_fts (feeds_fts, rowid, title, description)
  values ('delete', old.rowid, old.title, old.description);
  insert into feeds_fts (rowid, title, description)
  values (new.rowid, new.title, new.description);
end;
