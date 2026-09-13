-- A ring somebody made on the site, rather than one seeded from a topic or
-- curated by hand: the account that made it, which is the account that may
-- edit it. Null for every ring that was here before, and for seeded rings.
alter table rings add column owner_id text;

create index if not exists rings_owner_idx on rings (owner_id);
