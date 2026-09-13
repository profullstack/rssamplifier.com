-- OpenWebring (logicsrc.com/openwebring): the directory as a webring host.
--
-- A ring is an ordered, circular list of member sites. The order is the whole
-- point of a ring, and it is the one thing nothing else in this schema keeps:
-- a topic's feeds are re-derived on every crawl and come back in strength
-- order, so a member's neighbours would change under it from one crawl to
-- the next. `position` is therefore an explicit column, assigned once when a
-- member is added and never rewritten. New members append at the end.
--
-- Purely additive. A feed that stops linking back is marked inactive, never
-- removed, which is the IndieWeb verification model the spec adopts; the row
-- also carries the member's own statement of who makes the site (made_by),
-- read from their descriptor or set by the owner, and absent means unstated.
create table if not exists rings (
  slug        text primary key,
  title       text not null,
  description text,
  -- 'topic': seeded from a topic's feeds. 'curated': assembled by hand.
  kind        text not null check (kind in ('topic', 'curated')),
  topic_slug  text,
  -- JSON array of the made_by values the ring accepts, or null for all.
  accepts     text,
  public      integer not null default 1,
  created_at  text not null,
  updated_at  text not null
);

create table if not exists ring_members (
  ring_slug      text not null references rings (slug) on delete cascade,
  feed_id        text not null references feeds (id) on delete cascade,
  -- The member's name in hop URLs: /ring/<ring>/<member_slug>/next.
  member_slug    text not null,
  position       integer not null,
  site_url       text not null,
  -- The member's own word, unverified: 'human', 'ai' or 'both'. Null is
  -- unstated, never a default.
  made_by        text check (made_by in ('human', 'ai', 'both')),
  -- Where made_by came from. A descriptor pass never overwrites an owner's
  -- or an admin's value.
  made_by_source text check (made_by_source in ('descriptor', 'owner', 'admin')),
  -- The W3C ai-disclosure vocabulary, verbatim: none, ai-assisted,
  -- ai-generated, autonomous.
  disclosure     text,
  descriptor_url text,
  -- 'pending' until first checked; 'active' while the site links to the
  -- ring; 'inactive' when it stopped. Listed in every state, skipped by hops
  -- unless active.
  status         text not null default 'pending' check (status in ('active', 'inactive', 'pending')),
  checked_at     text,
  joined_at      text not null,
  primary key (ring_slug, feed_id),
  unique (ring_slug, position),
  unique (ring_slug, member_slug)
);

create index if not exists ring_members_order_idx on ring_members (ring_slug, position);
