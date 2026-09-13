-- Rings people like, and what people do with rings.
--
-- A like is one row per account per ring, so it is on or off and never
-- counted twice. The ring's slug rather than a foreign key, because a topic
-- is a ring before it has a row (see webrings.topicRingPreview), and liking
-- the software ring must work on the day it is still computed.
create table if not exists ring_likes (
  ring_slug  text not null,
  user_id    text not null references users (id) on delete cascade,
  created_at text not null,
  primary key (ring_slug, user_id)
);

create index if not exists ring_likes_user_idx on ring_likes (user_id);

-- Every action on a ring, as a fact with a time: somebody looked at a site
-- in the viewer, shared a ring, liked it, followed a member from it, added a
-- site to their own ring, made a ring. The leaderboard is a projection over
-- this table (lib/ringLeaderboard.js), so points are a reading of the log
-- and can be re-weighted without touching a row. user_id is null for an
-- action nobody was signed in for (a share by a stranger still counts for
-- the ring, just not for anyone's score).
create table if not exists ring_events (
  id          integer primary key autoincrement,
  kind        text not null check (kind in ('view', 'share', 'like', 'follow', 'add', 'make')),
  ring_slug   text not null,
  member_slug text,
  user_id     text references users (id) on delete cascade,
  created_at  text not null
);

create index if not exists ring_events_user_idx on ring_events (user_id, created_at);
create index if not exists ring_events_ring_idx on ring_events (ring_slug, created_at);
create index if not exists ring_events_at_idx on ring_events (created_at);
