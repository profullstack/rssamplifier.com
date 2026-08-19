-- Following a person rather than a publication or a subject.
--
-- `follows` (0003) answers "tell me when this blog posts" and `topic_follows`
-- (0021) answers "tell me when anybody posts about this". Neither answers the
-- question an author page invites: a writer with a blog, a newsletter and a
-- podcast is three rows in `feeds` and one person, and following all three by
-- hand both misses the fourth when they start it and says nothing about who
-- they are.
--
-- Keyed on `author_id` rather than on the slug, which is the opposite of what
-- `topic_follows` does, and deliberately. A topic slug is the only identity a
-- topic has, because `topics` is a disposable rollup the poller rebuilds. An
-- author is a real row with a stable primary key and a unique `identity_key`
-- that the extractor merges on, and nothing in the codebase ever deletes one.
-- So the foreign key is honest here, and it buys the cascade: an author that
-- does go away takes its follows with it instead of leaving rows pointing at
-- a page that 404s.

create table if not exists author_follows (
  user_id    text not null references users (id) on delete cascade,
  author_id  text not null references authors (id) on delete cascade,

  -- Off by default, matching both older follow tables. Following is "collect
  -- this for me"; being interrupted is a second decision, made with the bell.
  alerts     integer not null default 0,

  created_at text not null,

  primary key (user_id, author_id)
);

-- The following page's query: what one reader follows, most recent first.
create index if not exists author_follows_user_idx on author_follows (user_id, created_at desc);

-- The other direction, for "how many people follow this author".
create index if not exists author_follows_author_idx on author_follows (author_id);
