// Make or extend a curated ring from feed slugs, idempotently.
//   node --env-file=<env> scripts/curate-ring.mjs <ring-slug> "<title>" "<description>" <feed-slug>...
// Existing members keep their position; new slugs append; a slug the directory
// does not have, or a feed with no site to link from, is reported and skipped.
import { connect, nowIso } from '../index.js';

const [slug, title, description, ...feedSlugs] = process.argv.slice(2);
if (!slug || !title || !feedSlugs.length) {
  console.error('usage: curate-ring.mjs <ring-slug> "<title>" "<description>" <feed-slug>...');
  process.exit(2);
}
const db = connect();
const now = nowIso();
await db.execute({
  sql: `insert into rings (slug, title, description, kind, topic_slug, accepts, public, created_at, updated_at)
        values (?, ?, ?, 'curated', null, null, 1, ?, ?) on conflict (slug) do nothing`,
  args: [slug, title, description || null, now, now],
});
const current = await db.execute({ sql: `select feed_id, position from ring_members where ring_slug = ?`, args: [slug] });
const have = new Set(current.rows.map((r) => String(r.feed_id)));
let position = current.rows.reduce((max, r) => Math.max(max, Number(r.position)), -1);
for (const feedSlug of feedSlugs) {
  const { rows } = await db.execute({ sql: `select id, slug, site_url, status from feeds where slug = ?`, args: [feedSlug] });
  const feed = rows[0];
  if (!feed) { console.log(`skip ${feedSlug}: not in the directory`); continue; }
  if (!feed.site_url) { console.log(`skip ${feedSlug}: no site url`); continue; }
  if (have.has(String(feed.id))) { console.log(`have ${feedSlug}`); continue; }
  position += 1;
  await db.execute({
    sql: `insert into ring_members (ring_slug, feed_id, member_slug, position, site_url, status, joined_at)
          values (?, ?, ?, ?, ?, 'pending', ?) on conflict (ring_slug, feed_id) do nothing`,
    args: [slug, feed.id, feed.slug, position, feed.site_url, now],
  });
  console.log(`added ${feedSlug} at ${position}: ${feed.site_url} (${feed.status})`);
}
await db.execute({ sql: `update rings set updated_at = ? where slug = ?`, args: [now, slug] });
const count = await db.execute({ sql: `select count(*) as n from ring_members where ring_slug = ?`, args: [slug] });
console.log(`ring ${slug}: ${count.rows[0].n} members`);
