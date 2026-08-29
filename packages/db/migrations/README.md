# Migrations

Name a new migration `YYYYMMDDHHMMSS_what_it_does.sql`, in UTC:

```sh
printf '%s_add_thing.sql\n' "$(date -u +%Y%m%d%H%M%S)"
```

## Why timestamps rather than the next number

Because the next number is not knowable from a branch. On 2026-08-19 two
branches both took `0032` — `0032_feed_refetch_signals.sql` (#127) and
`0032_queue_hourly.sql` (#128) — and **git raised no conflict**, because they
are different filenames. Nothing failed, nothing warned, and the collision was
only noticed because somebody happened to list the table afterwards.

Writing the test that now guards this found it had happened twice before:

    0006  feed_items_created_idx, feeds_sitemap_index
    0018  crawl_log, queue, scraped_feeds        <- three files
    0032  feed_refetch_signals, queue_hourly

None of it ever broke anything, because `migrate()` keys `_migrations` on the
filename rather than the number, so each file still ran exactly once. That is
luck rather than design: it holds only while the colliding files commute, and
nothing was checking that they did.

That is the whole argument. A sequential scheme is only correct if whoever
merges second renumbers, and they are never prompted to, because the tool that
would prompt them sees two unrelated new files.

Timestamps make the collision essentially impossible: two people would have to
create a migration in the same second.

## What timestamps do not fix, so you know

They order by **when a migration was written, not when it was merged.** Write
one on Monday, merge it on Friday, and a colleague's Wednesday migration will
have run first in production while a freshly created database replays yours
first.

This is not a regression — sequential numbering had the same divergence *and*
the silent collisions — but it is worth knowing:

- **Keep migrations independent of each other.** Additive `alter table add
  column` and `create index if not exists` commute, so order does not matter.
  Two migrations that must run in a fixed order belong in one file.
- The order production actually used is recorded in `_migrations.applied_at`,
  which is the authority when the two disagree.

## Never rename a migration that has been applied

`migrate()` keys `_migrations` on the **filename**. Rename an applied file and
the runner sees a migration it has never run and runs it again. For a purely
additive file that is survivable — `ALREADY_APPLIED` in `migrate.js` swallows
"duplicate column name" and "already exists" — but `0001_init.sql`,
`0013_feed_category.sql` and `0017_crawl_hourly.sql` also carry `insert` and
`update` statements, and those are not idempotent.

So the `0001`–`0032` files stay exactly as they are, every duplicate included.
They sort before any timestamp anyway, since `'0'` precedes `'2'`, so the
history keeps its order for good and needs no tidying to stay correct.

## Statements

Files are split on `;` outside `BEGIN…END`, so trigger bodies are safe. Each
statement runs on its own; a file that fails partway is retried from the
statement that failed the next time the poller boots, and only recorded once
the whole file lands.
