# rssamplifier CLI

The [RSS Amplifier](https://rssamplifier.com) directory, from a terminal. Find feeds by subject,
search tens of thousands of independent blogs, export OPML, submit a site. No key, no account.

```sh
curl -fsSL https://rssamplifier.com/install.sh | sh
```

That drops one file at `~/.local/bin/rssamp`. Node 22 or newer is the only requirement — there are
no dependencies, so there is nothing else to install and nothing to audit but the one file. Set
`RSSAMP_BIN` to install elsewhere.

It manages itself from there:

```sh
rssamp update        # pull the latest over itself
rssamp remove        # show what uninstalling would delete
rssamp remove --yes  # actually do it
```

`update` stages the download beside the target and renames it into place, so an interrupted upgrade
leaves the working copy working. `remove` deletes the two binaries and nothing else — there is no
config, cache or state anywhere. Neither touches a file it did not write, and both decline when run
out of a checkout or an npm install rather than guessing.

## Start here

```sh
rssamp topics homelab              # what does the directory cover about this?
rssamp topic homelab               # the feeds filed under one subject
rssamp opml --topic homelab > homelab.opml
rssamp urls --topic homelab        # one feed URL per line
```

Run `rssamp --help` for the rest, or read <https://rssamplifier.com/cli>.

## For scripts and agents

Every command takes `--json` and writes to stdout. Exit codes are meant to be branched on: a
submission where nothing was accepted exits non-zero, as does a `urls` that matched no feeds. A
search that legitimately found nothing exits zero — the directory not covering a subject is an
answer, not a failure.

```sh
rssamp search "agentic coding" --json | jq -r '.posts[].url'
rssamp topic homelab --json | jq -r '.feeds[].feedUrl'
```

An agent that can call MCP tools should use <https://rssamplifier.com/mcp> instead: same data,
no subprocess, and the tools describe their own arguments.

## Pointing it elsewhere

`--api` or `$RSSAMP_API` changes the deployment it talks to:

```sh
RSSAMP_API=http://localhost:3000 rssamp list --limit 5
```

## Development

This package is the whole program in `src/index.js` — one file, importable as a module and
executable on its own. The site serves that exact file at `/cli/rssamp`, which is what the
installer downloads, so there is no build step and no artifact to keep in sync.

```sh
pnpm test
```

MIT.
