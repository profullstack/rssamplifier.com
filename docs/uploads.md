# Large OPML uploads

The submit endpoint takes a catalogue of any size by reading it as a stream. This
note records why it is built that way and, more usefully, where the remaining
ceilings actually are — every number below was measured on the development box
rather than reasoned about, and the ones that surprised us are the point.

## The two paths

| Content type | Read by | Holds the document? |
| --- | --- | --- |
| `multipart/form-data` | busboy, from `req.body` | no |
| `application/xml`, `text/xml`, `application/opml+xml`, `*+xml` | `req.body` directly | no |
| `application/json` with an `opml` string | `JSON.parse` | yes, necessarily |
| `application/x-www-form-urlencoded` | `req.formData()` | yes — it is the paste box |

The first two are the upload paths and neither ever assembles the file. The JSON
and urlencoded paths are unchanged: a JSON body is already a string by the time
it is a body, and the paste box is a textarea.

`text/plain` is deliberately *not* an OPML type. Posting a list of URLs as plain
text is a thing people do, and reading it as a catalogue would find no outlines
and accept nothing at all, silently.

## Why streaming, in numbers

`parseOpml` builds a tree with fast-xml-parser. Measured here:

| File | Feeds | Time | Peak RSS |
| --- | --- | --- | --- |
| 8 MiB | 106,184 | 0.9s | 251 MiB |
| 64 MiB | 849,479 | 6.7s | 761 MiB |
| 128 MiB | 1,698,958 | 13.9s | 1,470 MiB |
| 256 MiB | 3,397,917 | 30.2s | 2,634 MiB |

Roughly ten times the file, in memory, at once. And above **512 MiB** it cannot
run at all: that is `buffer.constants.MAX_STRING_LENGTH`, so `await file.text()`
throws before the parser is ever reached.

`streamOpmlOutlines` scans instead of parsing. It holds one partial tag, so its
memory does not depend on the file at all. What it gives up is nesting — it
cannot tell which folder an outline sat in — and nothing downstream ever used
that, since `parseOpml` flattens the tree and keeps only nodes with an `xmlUrl`.
`opml-stream.test.js` asserts the two agree on every document both can read.

## The ceilings, in the order you will hit them

**1. Node's request timeout.** `http.Server` defaults `requestTimeout` to 300
seconds and answers `408` when a request takes longer than that to be *received*.
Next never sets the option and `next start` has no flag for it. A 600 MiB upload
here queued 739,000 feeds and was then cut off at 332 seconds with `ECONNRESET`,
the submission left unfinished.

This one is worth understanding before you try to reproduce it, because it does
not behave like a stopwatch. A *slow* upload of the same total duration survives
— a 1 MiB file at 2 KiB/s took 517 seconds and returned `200`. What dies is the
fast-client-slow-consumer shape: the importer reads the socket only as fast as it
can write feeds, so back-pressure leaves the connection quiet for long stretches
and Node reaps it. That is every real import, and it is why a naive timing test
says the problem does not exist.

The fix is `apps/web/server-timeouts.mjs`, preloaded via `NODE_OPTIONS`
(`--import`) in the Dockerfile. It has to be a preload:

> `instrumentation.js` is the obvious home for this and is the wrong one. Its
> `register()` runs *after* `startServer` has already called
> `http.createServer` — confirmed by logging from `register()` and watching the
> line print after "Ready" — so a patch installed there is inert while looking
> perfectly healthy.

It raises the limit to six hours rather than removing it. `0` disables the
timeout and hands you back the slowloris the default was written to prevent. If a
future Next exposes the option properly, delete the preload and use it.

**2. The importer's deduplication set — the real limit on a single import.**
`importFeeds` reads every existing feed URL and slug into two Sets, then adds to
them as it accepts rows. That read is bounded by the directory, which is small;
the *growth* is bounded by the number of new feeds in the upload, which is not.
Both `feeds.slug` and `feeds.feed_url` are `unique` and `insertFeedsBulk` says
`on conflict do nothing`, so the URL set is only an optimisation — but the slug
set is load-bearing. Without it, a slug collision is not resolved to `-2`, it is
a row silently dropped.

So the parse is flat and the import is not. Budget roughly **1 KB of resident
memory per new feed**: 739,000 feeds sat at just under 1 GiB. Fixing this means
either per-batch existence queries or a slug scheme that needs no global
knowledge, and the second changes user-visible URLs. Neither was worth doing
unprompted.

**3. Write throughput.** Feeds are queued in batches of 500. That batch size is
also the durability granularity: an upload refused or disconnected mid-stream
keeps every completed batch, which is why a failed import still has a status page
worth reading, but the current partial batch is lost.

## What `OPML_MAX_BYTES` is and is not

It is 10 GiB, enforced while the stream is read, and it raises
`OpmlTooLargeError` → `413`. It is a transport guard: the point past which we
would rather refuse than hold a socket open. It is **not** a promise that any
10 GiB file will import in one request — ceiling 2 above will stop you long
before, on any machine you would actually run this on. Ten gibibytes of OPML is
roughly fifty million feeds, which is more than the syndicated web has.

## Reproducing the measurements

```sh
TURSO_DATABASE_URL=file:/tmp/big.db node packages/db/src/migrate.js

cd apps/web
NODE_OPTIONS="--import ./server-timeouts.mjs --max-old-space-size=512" \
  npx next start -p 3311

curl -X POST http://localhost:3311/api/submit -H 'accept: application/json' \
  -F opml=@huge.opml -F email=you@example.com
```

The `NODE_OPTIONS` is not optional for the large cases: drop the `--import` and
you are testing the 300-second timeout instead of whatever you meant to test.
A 512 MiB `--max-old-space-size` is a good forcing function in the other
direction — the old path cannot survive it at any interesting file size.

Watch `/proc/<pid>/status` for `VmRSS` while it runs.
