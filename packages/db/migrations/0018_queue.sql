-- One reader's queue: the posts they mean to get to, in the order they mean to.
--
-- Three lanes rather than one list, because "later" is not one intention. A
-- long read waits for a chair and an hour; an episode waits for a walk; a video
-- waits for a screen you are not typing on. A single queue mixing them makes
-- every one of those moments start with skipping past the other two.
--
-- Separate from post_reactions (0005) on purpose, although both are "a reader
-- and a post". A like is a standing opinion — one row per pair, toggled, no
-- order. A queue entry is an intention with a position in a running order, a
-- lane, and an end: it is finished and leaves. Same two ids, different lifetime,
-- so a different table rather than more columns on that one.

create table if not exists queue_entries (
  id       text primary key,
  user_id  text not null references users (id) on delete cascade,
  item_id  text not null references feed_items (id) on delete cascade,

  lane     text not null check (lane in ('read', 'listen', 'watch')),

  -- Dense-ish integer, assigned max+1 within (user, lane). Reordering swaps two
  -- rows rather than renumbering the list, so the numbers develop gaps as
  -- entries are finished and that is fine — nothing reads them except ORDER BY.
  position integer not null,

  added_at text not null,
  -- Set when the entry is finished, not deleted. The queue is also a record of
  -- what you got through, and the player needs somewhere to put an episode it
  -- has just played out without making it vanish mid-navigation.
  done_at  text
);

-- The same post can sit in two lanes at once — show notes to read, episode to
-- hear — so the lane is part of the identity of an entry. Adding a post twice
-- to the same lane is a double click, not a second intention.
create unique index if not exists queue_entries_unique_idx
  on queue_entries (user_id, lane, item_id);

-- The running order, which is every read the player and the queue page make.
create index if not exists queue_entries_lane_idx
  on queue_entries (user_id, lane, position) where done_at is null;

-- What has been finished, newest first — the "done" shelf on the queue page.
create index if not exists queue_entries_done_idx
  on queue_entries (user_id, done_at desc) where done_at is not null;

-- Answering "is this post already queued" for a page of fifty posts, which is
-- one statement with fifty ids in it rather than fifty statements.
create index if not exists queue_entries_item_idx on queue_entries (user_id, item_id);
