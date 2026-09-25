// Read-only: time the statements the ring seed runs, against the database in
// the environment (DATABASE_URL), with their query plans.
//   node --env-file=<env> scripts/time-ring-queries.mjs one news
import { connect } from '../index.js';

const db = connect();
const slugs = process.argv.slice(2).length ? process.argv.slice(2) : ['one'];

const statements = (slug) => ({
  label: {
    sql: `select lk.keyword from feed_keywords lk where lk.slug = ? group by lk.keyword order by count(distinct lk.feed_id) desc, length(lk.keyword) asc, lk.keyword asc limit 1`,
    args: [slug],
  },
  size_cap5: {
    sql: `select count(*) as n from (select f.id from feeds f where f.status = 'active' and f.site_url is not null and f.site_url <> '' and exists (select 1 from feed_keywords k where k.feed_id = f.id and k.slug = ?) limit ?)`,
    args: [slug, 5],
  },
  candidates_exists: {
    sql: `select f.id from feeds f where f.status = 'active' and f.site_url is not null and f.site_url <> '' and exists (select 1 from feed_keywords k where k.feed_id = f.id and k.slug = ?) order by f.created_at asc, f.id asc limit ?`,
    args: [slug, 100],
  },
  // These two carried an `indexed by feed_keywords_slug_idx` hint on SQLite;
  // Postgres has no such hint and its planner takes the index on its own (the
  // plan printed below is how to check that it did).
  candidates_indexed: {
    sql: `select f.id from feed_keywords k cross join feeds f on f.id = k.feed_id where k.slug = ? and f.status = 'active' and f.site_url is not null and f.site_url <> '' order by k.count desc limit ?`,
    args: [slug, 100],
  },
  category_count_indexed: {
    sql: `select count(*) as n from feed_keywords k cross join feeds f on f.id = k.feed_id where k.slug = ? and k.source = 'category' and f.status = 'active' and f.site_url is not null and f.site_url <> ''`,
    args: [slug],
  },
  title_from_rollup: { sql: `select keyword from topics where slug = ?`, args: [slug] },
  candidates_join: {
    sql: `select f.id from feed_keywords k join feeds f on f.id = k.feed_id where k.slug = ? and f.status = 'active' and f.site_url is not null and f.site_url <> '' group by f.id order by f.created_at asc, f.id asc limit ?`,
    args: [slug, 100],
  },
  category_count: {
    sql: `select count(distinct k.feed_id) as n from feed_keywords k join feeds f on f.id = k.feed_id where k.slug = ? and k.source = 'category' and f.status = 'active' and f.site_url is not null and f.site_url <> ''`,
    args: [slug],
  },
});

const counts = await db.execute(`select (select count(*) from feeds) as feeds, (select count(*) from feed_keywords) as keywords`);
console.log('feeds', counts.rows[0].feeds, 'keyword rows', counts.rows[0].keywords);

for (const slug of slugs) {
  const rows = await db.execute({ sql: `select count(*) as n from feed_keywords where slug = ?`, args: [slug] });
  console.log(`\n== ${slug}: ${rows.rows[0].n} keyword rows`);
  for (const [name, st] of Object.entries(statements(slug))) {
    if (name === 'candidates_exists' || name === 'candidates_join') continue;
    const plan = await db.execute({ sql: `explain ${st.sql}`, args: st.args });
    const started = Date.now();
    let result = 'ok';
    try {
      const r = await db.execute({ sql: st.sql, args: st.args });
      result = `${r.rows.length} rows`;
    } catch (e) {
      result = `FAILED ${String(e.message).slice(0, 80)}`;
    }
    console.log(`${name}: ${Date.now() - started} ms, ${result}`);
    for (const p of plan.rows) console.log('   plan:', p['QUERY PLAN']);
  }
}

db.close();
