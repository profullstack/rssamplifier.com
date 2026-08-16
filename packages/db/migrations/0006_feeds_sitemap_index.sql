-- An index in sitemap-chunk order.
--
-- Sitemap chunks select a month of feeds with a half-open range on created_at
-- and order them by (created_at, id). The existing feeds_created_idx is
-- (created_at desc) alone, which covers neither the tie-break nor the direction
-- this needs, so each chunk request would scan and sort the whole table.
--
-- The tie-break matters more here than it looks: the entire directory was bulk
-- imported in one batch, so tens of thousands of rows share a created_at to the
-- second. Ordering by created_at alone leaves their relative order undefined,
-- and OFFSET into an undefined order can repeat a blog in one chunk file while
-- dropping it from another.

create index if not exists feeds_sitemap_idx on feeds (created_at, id);
