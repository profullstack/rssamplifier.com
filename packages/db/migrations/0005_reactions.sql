-- Reactions and comments on a post.
--
-- Three verbs land here, and they are not the same thing:
--
--   like     private. The reader's own shelf — /favorites — and nobody else's
--            business, so it is never counted into anything public.
--   vote     public. Up or down, summed into a score shown to everyone.
--   comment  public, attributed, and the only one that carries prose.
--
-- Like and vote share a row because they share a lifetime: both are one
-- reader's standing opinion of one post, both are toggled rather than
-- appended, and keeping them together makes "what has this reader done to this
-- post" a single primary-key lookup instead of two.

create table if not exists post_reactions (
  user_id    text not null references users (id) on delete cascade,
  item_id    text not null references feed_items (id) on delete cascade,

  liked      integer not null default 0 check (liked in (0, 1)),
  -- 0 means "no opinion", which is a real state and distinct from no row:
  -- a reader who upvotes, then clears the vote, still has a like on the row.
  vote       integer not null default 0 check (vote in (-1, 0, 1)),

  created_at text not null,
  updated_at text not null,

  primary key (user_id, item_id)
);

-- Partial index: /favorites reads only liked rows, and the site will hold far
-- more votes than likes.
create index if not exists post_reactions_liked_idx
  on post_reactions (user_id, updated_at desc) where liked = 1;

-- Scores are summed per post, so the item has to be the leading column.
create index if not exists post_reactions_item_idx on post_reactions (item_id) where vote <> 0;

create table if not exists comments (
  id         text primary key,
  item_id    text not null references feed_items (id) on delete cascade,
  user_id    text not null references users (id) on delete cascade,
  body       text not null,
  created_at text not null,
  -- Soft delete: a removed comment leaves a gap in a conversation, and the
  -- replies around it read as non-sequiturs if the row simply vanishes.
  deleted_at text
);

create index if not exists comments_item_idx on comments (item_id, created_at);
create index if not exists comments_user_idx on comments (user_id, created_at desc);
