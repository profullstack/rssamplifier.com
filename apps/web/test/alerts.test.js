import assert from 'node:assert/strict';
import { test } from 'node:test';

import { alerts } from '@rssamplifier/db';

import { TOPIC_GROUPS } from '../src/lib/topicGroups.js';

/**
 * The one thing about alerts that can only be checked from here.
 *
 * A topic follow can be narrowed to a sub-group — /topics/ai/podcasts is a
 * separate follow from /topics/ai — and the segments come from the web app's
 * TOPIC_GROUPS, which is built from the category table. The sender runs in the
 * poller and cannot import any of that, so it carries its own map of segment to
 * categories.
 *
 * Duplication is only safe while something notices it drifting. Without this
 * test, renaming a category page would leave the alert query filtering on a
 * segment nothing matches — and the symptom would be one reader's alerts going
 * quiet, indistinguishable from a topic nobody happens to be writing about.
 */

test('the sender knows the same sub-groups the topic pages mint', () => {
  const fromPages = Object.fromEntries(
    TOPIC_GROUPS.map((group) => [group.segment, [...group.kinds].sort()]),
  );
  const fromSender = Object.fromEntries(
    Object.entries(alerts.SEGMENT_KINDS).map(([segment, kinds]) => [segment, [...kinds].sort()]),
  );

  assert.deepEqual(fromSender, fromPages);
});

test('every sub-group resolves to the categories its page shows', () => {
  for (const group of TOPIC_GROUPS) {
    assert.deepEqual(
      [...(alerts.segmentKinds(group.segment) ?? [])].sort(),
      [...group.kinds].sort(),
      `${group.segment} filters on the same categories as its page`,
    );
  }
});

test('the whole topic is no filter, not every category', () => {
  assert.equal(alerts.segmentKinds(''), null);
  assert.equal(alerts.segmentKinds(undefined), null);

  // A segment renamed since the follow was made. Treated as the whole topic,
  // the way the topic pages treat the same input — a follow that quietly matched
  // nothing would look exactly like a subject nobody writes about.
  assert.equal(alerts.segmentKinds('gramophones'), null);
});

test('a segment is matched case-insensitively, like the URLs it comes from', () => {
  assert.deepEqual(alerts.segmentKinds('Podcasts'), ['podcast']);
  assert.deepEqual(alerts.segmentKinds(' PODCASTS '), ['podcast']);
});
