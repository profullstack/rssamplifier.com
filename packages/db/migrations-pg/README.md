# PostgreSQL schema and the SQLite to Postgres port

`0001_schema.sql` is the whole schema. It was derived from the SQLite
migrations in `../migrations` (kept for reference; the migration runner no
longer reads them). The client surface did not change: `db.execute({ sql, args })`
and `db.batch(statements, mode)` are served by `src/pg.js` on a `pg` pool, with
`?` placeholders translated to `$n`.

## What stayed the same, deliberately

- Timestamps are ISO-8601 `text`. Ids are text UUIDs made in the app.
- Flags are integer 0/1. JSON is stored as text.
- `feeds`, `feed_items`, `item_extracts` have a real column called `rowid`
  (identity, unique index), so the export cursors and `order by rowid` work as
  written.
- `on conflict (...) do update set x = excluded.x`, `on conflict do nothing`,
  `returning`, `coalesce`, `substr`, `||`, `limit ? offset ?`: identical.

## What had to change in queries

| SQLite | Postgres |
|---|---|
| `feeds_fts match ?` + `bm25(feeds_fts)` join on rowid | `feeds.search @@ websearch_to_tsquery('english', ?)`, order by `ts_rank_cd(search, query) desc`; same for `feed_items` |
| `json_extract(col, '$.k')` | `(col::jsonb ->> 'k')` (text) or `(col::jsonb -> 'k')::int` |
| `json_each(col)` | `jsonb_array_elements_text(col::jsonb)` |
| `json_group_array(json_object('a', x, ...))` | `json_agg(json_build_object('a', x, ...))` |
| `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+N minutes')` | `to_char((now() at time zone 'utc') + make_interval(mins => N), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` |
| `julianday('now') - julianday(col)` | `extract(epoch from now() - col::timestamptz) / 86400` |
| `max(a, b)` / `min(a, b)` as scalars | `greatest(a, b)` / `least(a, b)` |
| `x is not 'ok'` / `a is not b` | `x is distinct from 'ok'` / `a is distinct from b` |
| `like` (case-insensitive on ASCII) | `ilike` where the match is user text; `like` where the pattern is a prefix on data we wrote |
| `glob 'a*'` | `like 'a%'` (or a regex `~`) |
| `insert or ignore into` | `insert into ... on conflict do nothing` |
| `insert or replace into` | `insert into ... on conflict (pk) do update set ...` |
| `integer primary key autoincrement` | `bigint generated always as identity`; no `lastInsertRowid`, use `returning id` |
| `order by nullable_col desc` (NULLs last) | `order by nullable_col desc nulls last` (Postgres puts NULLs first on desc) |
| `'text' \|\| 123` | `'text' \|\| (123)::text` |
| `instr(a, b)` | `position(b in a)` |
| `count(*)` returned as number | still a number: `pg.js` parses int8 as JS number |
| `total(x)` | `coalesce(sum(x), 0)` |
| `randomblob`, `hex`, `printf` | not used |
| Unique violation message `UNIQUE constraint failed: ...` | `pg.js` rewrites error 23505 to that wording |

Booleans: SQLite compared `flag = 1`; unchanged, the columns are still integers.
Postgres is stricter about types in `case`/`coalesce` branches (`text` vs
`integer`): cast explicitly where a query mixed them.

## Tests

`connectTest()` (src/testdb.js) creates a fresh database per test file on
`TEST_DATABASE_URL` (default `postgres://postgres:postgres@127.0.0.1:5439/postgres`),
migrates it, and drops it on `close()`. Locally:

```sh
docker run -d --name rssamp-test-pg -p 127.0.0.1:5439:5432 \
  -e POSTGRES_PASSWORD=postgres postgres:17-alpine
pnpm -r test
```

CI runs the same image as a service container.
