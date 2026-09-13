/**
 * Seed the webrings by hand, once.
 *
 * The poller does this on its own every RING_SEED_SECONDS (apps/poller); this
 * is for the first time, or for a topic that should have a ring before the
 * next pass comes round.
 *
 *   node --env-file=.env scripts/seed-rings.mjs                 the top RING_TOPICS topics
 *   node --env-file=.env scripts/seed-rings.mjs --topics 40     more of them
 *   node --env-file=.env scripts/seed-rings.mjs --topic homelab one topic
 *   node --env-file=.env scripts/seed-rings.mjs --verify        then check one batch of members
 *
 * `--limit N` caps a ring's size (default 100 members). Seeding is
 * idempotent: an existing ring keeps every member's position and gains new
 * feeds at the end, so running this twice changes nothing the second time.
 */
import { connect, migrate, webrings } from '@rssamplifier/db';
import { seedTopRings, verifyRingMembers } from '@rssamplifier/ingest';

const env = process.env;
const args = process.argv.slice(2);

/**
 * @param {string} name
 * @returns {string|null}
 */
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : (args[i + 1] ?? '');
}

const topics = Number(flag('topics') ?? env['RING_TOPICS']) || 20;
const limit = Number(flag('limit')) || webrings.DEFAULT_RING_LIMIT;
const one = flag('topic');
const verify = args.includes('--verify');
const base = (env['SITE_URL'] || 'https://rssamplifier.com').replace(/\/+$/, '');

const db = connect();
await migrate(db);

if (one) {
  const size = await webrings.topicRingSize(db, one);
  if (size < 2) {
    console.error(`topic '${one}' has ${size} eligible feed(s); a ring needs somewhere to hop to`);
    process.exit(1);
  }
  const result = await webrings.seedTopicRing(db, one, { limit });
  console.log(`ring ${result.slug}: ${result.created ? 'created' : 'kept'}, ${result.added} added, ${result.total} members`);
} else {
  const tally = await seedTopRings(db, { topics, minMembers: 5, limit });
  console.log(`rings: ${tally.rings} seeded (${tally.created} new), ${tally.added} members added, ${tally.skipped} topics too small`);
}

if (verify) {
  const tally = await verifyRingMembers(db, {
    base,
    batch: Number(env['RING_BATCH']) || 25,
    recheckDays: Number(env['RING_RECHECK_DAYS']) || 7,
    onEvent: (event) => console.log(JSON.stringify(event)),
  });
  console.log(`checked ${tally.checked}: ${tally.active} active, ${tally.inactive} inactive, ${tally.declared} declared made_by, ${tally.unreachable} unreachable`);
}

const rings = await webrings.listRings(db);
for (const ring of rings) {
  console.log(`${ring.slug.padEnd(32)} ${String(ring.active_count).padStart(4)} active of ${String(ring.member_count).padStart(4)}  ${ring.title}`);
}
