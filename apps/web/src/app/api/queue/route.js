import { q, queue } from '@rssamplifier/db';

import { db } from '../../../lib/db.js';
import { currentUser } from '../../../lib/auth.js';
import { laneFor, trackFor } from '../../../lib/queue.js';
import { PLAYLIST_LIMIT } from '../../../lib/topicFeed.js';
import { topicGroup } from '../../../lib/topicGroups.js';

export const dynamic = 'force-dynamic';

/** What this endpoint accepts. */
const ACTIONS = new Set([
  'add',
  'remove',
  'add-topic',
  'remove-topic',
  'done',
  'undone',
  'up',
  'down',
  'clear',
  'clear-done',
]);

/**
 * The reader's own queue: add, remove, reorder, finish.
 *
 * Plain forms posting here, like every other control on the site — the buttons
 * work with JavaScript off, and the 303 puts the reader back where they were.
 * The docked player posts to the same endpoint with `Accept: application/json`
 * and gets the queue back instead of a redirect, so there is one set of rules
 * about what a queue is and both callers obey it.
 *
 * A post is addressed by slug and guid, like reactions are, because those are
 * the only handles the site publishes. An entry that already exists is
 * addressed by its own id: it is the reader's own row, it is the only way to
 * name a position in a running order, and every statement behind it is scoped
 * by user_id — so a forged id addresses somebody else's queue and matches
 * nothing.
 *
 * @param {Request} req
 */
export async function POST(req) {
  const user = await currentUser();
  const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html');

  /** @type {Record<string, string>} */
  let body = {};
  try {
    if ((req.headers.get('content-type') ?? '').includes('application/json')) {
      const parsed = await req.json();
      body = Object.fromEntries(
        Object.entries(parsed ?? {}).map(([k, v]) => [k, v === null ? '' : String(v)]),
      );
    } else {
      const form = await req.formData();
      body = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
    }
  } catch {
    return json({ error: 'bad-request' }, 400);
  }

  const action = String(body.action ?? '');
  const lane = String(body.lane ?? '');
  const slug = String(body.slug ?? '');
  const guid = String(body.guid ?? '');
  const entryId = String(body.entry ?? '');

  if (!ACTIONS.has(action)) return json({ error: 'bad-action' }, 400);

  // Where an HTML caller is sent afterwards: the page the button was on, so a
  // queue button in the middle of a blog's archive does not teleport the reader
  // to /queue. Only a path on this site, never an absolute URL somebody put in
  // a form — that would make this an open redirect.
  const back = safePath(body.next) ?? '/queue';

  if (!user) {
    if (wantsHtml) return redirect(`/login?next=${encodeURIComponent(back)}`);
    return json({ error: 'sign-in-required' }, 401);
  }

  const client = db();
  const userId = String(user.id);

  if (action === 'add-topic' || action === 'remove-topic') {
    // A whole playlist, named by the page that is showing it rather than sent
    // as fifty pairs of hidden inputs. The server re-runs the same query the
    // page was drawn from, at the same limit, so "add all" adds exactly what
    // the reader is looking at — and a form that carried the list instead
    // would be four kilobytes of guids that a stale tab could replay.
    const group = body.group ? topicGroup(body.group) : null;
    if (body.group && !group) return wantsHtml ? redirect(back) : json({ error: 'not-found' }, 404);

    const rows = await q.mediaForTopic(client, String(body.topic ?? ''), {
      limit: PLAYLIST_LIMIT,
      kinds: group?.kinds ?? null,
    });

    // One lane per post rather than one for the playlist. A topic's media is
    // episodes and videos together, and dropping the videos into the listen
    // lane would put a queue of things to watch behind an audio player.
    const entries = rows
      .filter((row) => row.item_id)
      .map((row) => ({ itemId: String(row.item_id), lane: laneFor(row) }));

    const changed =
      action === 'add-topic'
        ? await queue.addMany(client, userId, entries)
        : await queue.removeMany(client, userId, entries);

    if (wantsHtml) return redirect(back);
    return json({ ok: true, action, changed, counts: await queue.counts(client, userId) });
  }

  if (action === 'add' || (action === 'remove' && !entryId)) {
    if (!queue.isLane(lane)) return json({ error: 'bad-lane' }, 400);

    const feed = await q.feedBySlug(client, slug);
    if (!feed) return wantsHtml ? redirect(back) : json({ error: 'not-found' }, 404);

    const item = await q.itemByGuid(client, String(feed.id), guid);
    if (!item) return wantsHtml ? redirect(back) : json({ error: 'not-found' }, 404);

    if (action === 'add') await queue.add(client, userId, String(item.id), lane);
    else await queue.removeItem(client, userId, String(item.id), lane);
  } else if (action === 'remove') {
    await queue.removeEntry(client, userId, entryId);
  } else if (action === 'done' || action === 'undone') {
    await queue.setDone(client, userId, entryId, action === 'done');
  } else if (action === 'up' || action === 'down') {
    await queue.move(client, userId, entryId, action);
  } else {
    if (!queue.isLane(lane)) return json({ error: 'bad-lane' }, 400);
    await queue.clearLane(client, userId, lane, { doneOnly: action === 'clear-done' });
  }

  if (wantsHtml) return redirect(back);

  // A JSON caller is the player, and what it wants next is always the lane it
  // just changed — so the answer is the new running order rather than an "ok"
  // it would have to follow with another request.
  const which = queue.isLane(lane) ? lane : 'listen';
  return json({ ok: true, lane: which, ...(await lanePayload(client, userId, which)) });
}

/**
 * A lane, as JSON — the running order the player works from, and the same
 * answer an agent gets for "what am I meant to be reading".
 *
 * @param {Request} req
 */
export async function GET(req) {
  const user = await currentUser();
  if (!user) return json({ error: 'sign-in-required' }, 401);

  const url = new URL(req.url);
  const lane = url.searchParams.get('lane') ?? 'listen';
  if (!queue.isLane(lane)) return json({ error: 'bad-lane' }, 400);

  const done = url.searchParams.get('done') === '1';
  const client = db();

  return json({ lane, done, ...(await lanePayload(client, String(user.id), lane, done)) });
}

/**
 * One lane, shaped for both callers: entries for a list, and the subset the
 * dock can actually play, already resolved to a source.
 *
 * @param {import('@libsql/client').Client} client
 * @param {string} userId
 * @param {'read'|'listen'|'watch'} lane
 * @param {boolean} [done]
 */
async function lanePayload(client, userId, lane, done = false) {
  const rows = await queue.list(client, userId, lane, { done });

  const entries = rows.map((row) => {
    const slug = String(row.feed_slug);
    const track = trackFor(row, {
      slug,
      feedTitle: String(row.feed_title),
      entryId: String(row.id),
    });

    return {
      id: String(row.id),
      lane: String(row.lane),
      title: String(row.title),
      feed: String(row.feed_title),
      slug,
      guid: String(row.guid),
      href: `/${slug}/read?p=${encodeURIComponent(String(row.guid))}`,
      addedAt: String(row.added_at),
      doneAt: row.done_at ? String(row.done_at) : null,
      // Null for a post the dock cannot carry — a YouTube embed, or anything
      // with no enclosure at all. The player reads this to decide between
      // playing a thing and walking the reader to it.
      track,
    };
  });

  return { count: entries.length, entries };
}

/**
 * A path on this site, or null.
 *
 * `//evil.example` is a protocol-relative URL and a browser follows it off the
 * site, so "starts with a slash" is not enough on its own.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function safePath(value) {
  const path = String(value ?? '');
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  return path;
}

/**
 * @param {string} location
 * @returns {Response}
 */
function redirect(location) {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

/**
 * @param {unknown} body
 * @param {number} [status]
 * @returns {Response}
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
