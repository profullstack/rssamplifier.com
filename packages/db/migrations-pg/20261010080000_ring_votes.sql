-- Votes for the sites in a ring, from anybody, no account needed.
--
-- A member's footer carries a vote link next to << >> and the die; the
-- reader who follows it is usually not signed in to us and never will be,
-- so a vote is anonymous. What stops one person voting a thousand times is
-- the key: `voter` is an HMAC of the caller's address and the UTC day
-- (IP_HASH_SALT), never the address, so one address gets one vote per site
-- per day and the table cannot be joined across days to follow anyone.
-- The same column carries the hourly cap (webrings.castRingVote).
--
-- Slugs rather than foreign keys, like ring_likes: a member removed from a
-- ring keeps its history and a re-add picks the count back up.
create table if not exists ring_votes (
  ring_slug   text not null,
  member_slug text not null,
  voter       text not null,
  day         text not null,
  created_at  text not null,
  primary key (ring_slug, member_slug, voter, day)
);
create index if not exists ring_votes_member_idx on ring_votes (ring_slug, member_slug);
create index if not exists ring_votes_voter_idx on ring_votes (voter, created_at);
