import assert from 'node:assert/strict';
import { test } from 'node:test';

import { feedContacts, feedCredits } from '../src/identity.js';

test('a feed whose only byline is a role keeps the mailbox that role published', () => {
  // The shape this exists for. A publisher writes something in the owner tag
  // that is plainly not a person, and a real personal mailbox beside it. The
  // name is correctly refused; discarding the mailbox with it would throw away
  // the only way anybody offered to reach them.
  const channel = {
    title: 'A Podcast',
    'itunes:owner': { 'itunes:name': 'The Editorial Team', 'itunes:email': 'marta@example.com' },
  };

  assert.deepEqual(feedCredits(channel, [], 'rss'), []);
  assert.deepEqual(feedContacts(channel, 'rss'), [
    { url: 'mailto:marta@example.com', network: 'email' },
  ]);
});

test('a role mailbox is not a contact, on the feed any more than on a person', () => {
  const channel = {
    title: 'A Podcast',
    'itunes:owner': { 'itunes:name': 'Editor', 'itunes:email': 'info@example.com' },
  };

  assert.deepEqual(feedContacts(channel, 'rss'), []);
});

test('a named person keeps their own address rather than leaking it to the feed', () => {
  // The double-filing this guards against: when the name survives, the credit
  // owns the address and `feedCredits` has already routed it to that author.
  const channel = {
    title: 'A Podcast',
    'itunes:owner': { 'itunes:name': 'Marta Nowak', 'itunes:email': 'marta@example.com' },
  };

  const [author] = feedCredits(channel, [], 'rss');
  assert.equal(author.name, 'Marta Nowak');
  assert.equal(author.email, 'marta@example.com');

  assert.deepEqual(feedContacts(channel, 'rss'), []);
});

test('a profile published beside a rejected name is kept as the feed’s', () => {
  // A group byline with an account attached: the account is real and reachable
  // and belongs to the publication, so it goes on the feed. No author row is
  // invented to hold it — that is what `feed_links` is for.
  const channel = {
    title: 'A Blog',
    author: [{ name: 'Wirecutter Staff', uri: 'https://github.com/wirecutter' }],
  };

  assert.deepEqual(feedCredits(channel, [], 'atom'), []);
  assert.deepEqual(feedContacts(channel, 'atom'), [
    { url: 'https://github.com/wirecutter', network: 'github' },
  ]);
});

test('a link that is not anybody’s profile is not made into a contact', () => {
  // Most of what a channel element points at is not a person, and refusing
  // those is where `classifyLink` earns its place: a repository is two path
  // segments and no profile.
  const channel = {
    title: 'A Blog',
    author: [{ name: 'The Editorial Team', uri: 'https://github.com/acme/widgets' }],
  };

  assert.deepEqual(feedContacts(channel, 'atom'), []);
});

test('the same address published twice is one contact', () => {
  const channel = {
    title: 'A Podcast',
    managingEditor: 'marta@example.com (The Editorial Team)',
    'itunes:owner': { 'itunes:name': 'Editorial Team', 'itunes:email': 'marta@example.com' },
  };

  assert.deepEqual(feedContacts(channel, 'rss'), [
    { url: 'mailto:marta@example.com', network: 'email' },
  ]);
});

test('a feed that credits nobody at all offers no contacts', () => {
  assert.deepEqual(feedContacts({ title: 'A Blog' }, 'rss'), []);
  assert.deepEqual(feedContacts(null, 'rss'), []);
});
