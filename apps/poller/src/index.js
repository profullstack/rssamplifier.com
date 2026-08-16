import { createClient } from '@supabase/supabase-js';
import { crawlDue } from '@rssamplifier/ingest';

/**
 * Feed crawler daemon.
 *
 * Runs as its own Railway service so a slow crawl can never occupy a web
 * request, and so the two can be scaled apart.
 */

const env = process.env;

const url = env['SUPABASE_URL'];
const key = env['SUPABASE_SERVICE_ROLE_KEY'];

if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  process.exit(1);
}

const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const intervalMs = (Number(env['POLL_INTERVAL_SECONDS']) || 60) * 1000;
const batchSize = Number(env['POLL_BATCH_SIZE']) || 25;

let running = false;
let stopping = false;

/**
 * Crawl one batch, guarding against overlapping runs.
 *
 * A slow batch must not stack on top of the next tick — that would multiply
 * outbound requests to the same hosts.
 */
async function tick() {
  if (running || stopping) return;
  running = true;

  try {
    const { crawled, failed } = await crawlDue(sb, batchSize);
    if (crawled || failed) {
      console.log(
        JSON.stringify({ at: new Date().toISOString(), event: 'crawl', crawled, failed }),
      );
    }
  } catch (err) {
    console.error(
      JSON.stringify({ at: new Date().toISOString(), event: 'crawl-error', message: String(err) }),
    );
  } finally {
    running = false;
  }
}

const timer = setInterval(tick, intervalMs);
void tick();

console.log(
  JSON.stringify({
    at: new Date().toISOString(),
    event: 'started',
    intervalSeconds: intervalMs / 1000,
    batchSize,
  }),
);

/**
 * Shut down cleanly so Railway's SIGTERM does not sever an in-flight crawl.
 *
 * @param {string} signal
 */
function shutdown(signal) {
  stopping = true;
  clearInterval(timer);
  console.log(JSON.stringify({ at: new Date().toISOString(), event: 'stopping', signal }));

  // Give an in-flight batch a moment to finish before exiting.
  const deadline = Date.now() + 20_000;
  const wait = setInterval(() => {
    if (!running || Date.now() > deadline) {
      clearInterval(wait);
      process.exit(0);
    }
  }, 250);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
