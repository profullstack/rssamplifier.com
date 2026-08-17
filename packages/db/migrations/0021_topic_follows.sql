-- Following a subject rather than a publication.
--
-- The `follows` table in 0003 answers "tell me when this blog posts". This one
-- answers "tell me when anybody posts about this", which is the question the
-- topic pages already answer for a visitor standing on them and could not
-- answer for somebody who had walked away.
--
-- Deliberately no foreign key to `topics`: that table is a disposable rollup the
-- poller rebuilds, and a topic below its minimum feed count is absent from it
-- while still having a perfectly good page. A follow keyed to it would be
-- deleted by a refresh. The slug is the identity everywhere else that a topic is
-- addressed — /topics/<slug> and feed_keywords.slug — so it is the identity here.

create table if not exists topic_follows (
  user_id    text not null references users (id) on delete cascade,
  -- The normalised topic slug, as slugFromUrl() produces it. Never raw input:
  -- /topics/Home%20Lab and /topics/home-lab are one page, so they must be one
  -- follow.
  slug       text not null,
  -- Which cut of the topic. '' is the whole thing; anything else is one of the
  -- sub-group segments the topic pages use ('podcasts', 'videos', 'audio'…), so
  -- /topics/ai and /topics/ai/podcasts are two separate follows the way they
  -- are two separate pages. Empty string rather than null because it is half of
  -- the primary key, and in SQLite two null halves do not conflict — which
  -- would let the same whole-topic follow be inserted without limit.
  segment    text not null default '',
  created_at text not null,

  primary key (user_id, slug, segment)
);

-- The following page's query: what one reader follows, most recent first.
create index if not exists topic_follows_user_idx on topic_follows (user_id, created_at desc);

-- The other direction, for "how many people follow this topic".
create index if not exists topic_follows_slug_idx on topic_follows (slug, segment);
