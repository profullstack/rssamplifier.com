import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect } from '../src/client.js';
import { migrate } from '../src/migrate.js';
import * as a from '../src/accounts.js';
import * as q from '../src/queries.js';
import * as r from '../src/reactions.js';

let dir;
let db;
let itemId;
let alice;
let bob;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-reactions-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);

  const feed = await q.insertFeed(db, {
    slug: 'reactions-blog',
    feed_url: 'https://reactions.example/feed.xml',
    site_url: 'https://reactions.example/',
    title: 'Reactions Blog',
  });

  await q.upsertItems(db, feed.id, [
    { guid: 'post-1', title: 'A post', summary: 'text', publishedAt: '2026-08-01T00:00:00Z' },
  ]);

  const item = await q.itemByGuid(db, feed.id, 'post-1');
  itemId = String(item.id);

  alice = (await a.findOrCreateUser(db, 'alice@example.com')).id;
  bob = (await a.findOrCreateUser(db, 'bob@example.com')).id;
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('a like and a vote live on one row without overwriting each other', async () => {
  await r.setLike(db, alice, itemId, true);
  await r.setVote(db, alice, itemId, 1);

  const state = await r.reactionFor(db, alice, itemId);
  assert.equal(state.liked, true, 'the vote did not clear the like');
  assert.equal(state.vote, 1);

  // Clearing the vote must leave the like standing: saving something and
  // endorsing it are separate acts.
  await r.setVote(db, alice, itemId, 0);
  const after = await r.reactionFor(db, alice, itemId);
  assert.equal(after.liked, true);
  assert.equal(after.vote, 0);
});

test('a reader with no row reads as neutral rather than missing', async () => {
  const state = await r.reactionFor(db, bob, itemId);
  assert.deepEqual(state, { liked: false, vote: 0 });
});

test('score is the sum of votes, counted per reader', async () => {
  await r.setVote(db, alice, itemId, 1);
  await r.setVote(db, bob, itemId, 1);

  let score = await r.scoreFor(db, itemId);
  assert.deepEqual(score, { score: 2, up: 2, down: 0 });

  // A reader changing their mind moves the score, it does not add to it.
  await r.setVote(db, bob, itemId, -1);
  score = await r.scoreFor(db, itemId);
  assert.deepEqual(score, { score: 0, up: 1, down: 1 });
});

test('likes are private to the reader who made them', async () => {
  const hers = await r.likedItems(db, alice);
  assert.equal(hers.length, 1);
  assert.equal(String(hers[0].title), 'A post');
  assert.equal(String(hers[0].feed_slug), 'reactions-blog');

  assert.equal((await r.likedItems(db, bob)).length, 0, "bob's vote is not a like");
  assert.equal(await r.countLikes(db, alice), 1);
});

test('unliking removes it from the shelf but keeps the vote', async () => {
  await r.setLike(db, alice, itemId, false);

  assert.equal((await r.likedItems(db, alice)).length, 0);
  assert.equal((await r.reactionFor(db, alice, itemId)).vote, 1, 'vote survived the unlike');

  await r.setLike(db, alice, itemId, true);
});

test('an empty comment is refused rather than stored', async () => {
  assert.equal(await r.addComment(db, itemId, alice, '   '), null);
  assert.equal(await r.countComments(db, itemId), 0);
});

test('comments come back oldest first, with the author', async () => {
  const first = await r.addComment(db, itemId, alice, 'Good post');
  const second = await r.addComment(db, itemId, bob, 'Agreed');

  assert.ok(first && second);

  const thread = await r.commentsFor(db, itemId);
  assert.equal(thread.length, 2);
  assert.equal(String(thread[0].body), 'Good post');
  assert.equal(String(thread[0].email), 'alice@example.com');
  assert.equal(String(thread[1].body), 'Agreed');
  assert.equal(await r.countComments(db, itemId), 2);
});

test('a comment can only be deleted by its author, and leaves a gap', async () => {
  const thread = await r.commentsFor(db, itemId);
  const alices = thread.find((c) => String(c.email) === 'alice@example.com');

  assert.equal(
    await r.deleteComment(db, String(alices.id), bob),
    false,
    'bob cannot delete a comment he did not write',
  );

  assert.equal(await r.deleteComment(db, String(alices.id), alice), true);

  const after = await r.commentsFor(db, itemId);
  assert.equal(after.length, 2, 'the row stays so the thread still reads in order');
  const removed = after.find((c) => String(c.id) === String(alices.id));
  assert.equal(removed.body, null, 'the text is withheld once withdrawn');
  assert.ok(removed.deleted_at);
  assert.equal(await r.countComments(db, itemId), 1, 'withdrawn comments are not counted');

  // Deleting twice is not an error, but it is not a second deletion either.
  assert.equal(await r.deleteComment(db, String(alices.id), alice), false);
});

test('a long comment is capped rather than rejected', async () => {
  const id = await r.addComment(db, itemId, bob, 'x'.repeat(r.COMMENT_MAX + 500));
  const thread = await r.commentsFor(db, itemId);
  const posted = thread.find((c) => String(c.id) === id);

  assert.equal(String(posted.body).length, r.COMMENT_MAX);
});
