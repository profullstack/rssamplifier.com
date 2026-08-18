import { siteUrl } from '../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * The installer, for `curl -fsSL https://rssamplifier.com/install.sh | sh`.
 *
 * Generated rather than static so the URLs in it are this deployment's own:
 * an installer served from a preview or a local run should install that
 * deployment's CLI, not production's.
 *
 * Deliberately POSIX sh and deliberately short. It downloads one file, checks
 * it looks like the program, and puts it on PATH — a script people pipe into a
 * shell unread should be a script they *could* read in a minute, and every
 * clever thing it does is a thing they would have to audit.
 */
export async function GET() {
  return new Response(script(siteUrl()), {
    headers: {
      'content-type': 'text/x-shellscript; charset=utf-8',
      'access-control-allow-origin': '*',
      // Short: this is the URL printed on the homepage, and a stale installer
      // pointing at a moved download is the one failure nobody can debug.
      'cache-control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600',
    },
  });
}

/**
 * @param {string} site
 * @returns {string}
 */
function script(site) {
  return `#!/bin/sh
# rssamplifier CLI installer.
#
#   curl -fsSL ${site}/install.sh | sh
#
# Installs a single Node script to ~/.local/bin/rssamp. Nothing else is written,
# no package manager is invoked, and uninstalling is \`rm\` on the two files it
# names. Override the destination with RSSAMP_BIN=/somewhere/bin.
set -eu

SITE="\${RSSAMP_SITE:-${site}}"
BIN="\${RSSAMP_BIN:-\$HOME/.local/bin}"
SOURCE="\$SITE/cli/rssamp"

say() { printf '%s\\n' "\$*"; }
fail() { printf 'error: %s\\n' "\$*" >&2; exit 1; }

# Node, and a new enough one. The CLI uses top-level await and a global fetch,
# so an old node fails at parse time with a message that has nothing to do with
# the real problem.
command -v node >/dev/null 2>&1 || fail "node is required. Install Node 22 or newer, then run this again."
node -e 'process.exit(parseInt(process.versions.node, 10) >= 22 ? 0 : 1)' 2>/dev/null ||
  fail "Node 22 or newer is required (found \$(node -v))."

# curl or wget, whichever is here.
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "\$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO- "\$1"; }
else
  fail "curl or wget is required."
fi

TMP="\$(mktemp)"
# Clean up on any exit, including the failure paths below.
trap 'rm -f "\$TMP"' EXIT INT TERM

say "Downloading \$SOURCE"
fetch "\$SOURCE" > "\$TMP" || fail "download failed."

# Two cheap sanity checks. A proxy or a captive portal answering 200 with an
# HTML error page is the common failure, and installing that as an executable
# gives you a broken command with a baffling error rather than a clear one here.
head -n 1 "\$TMP" | grep -q '^#!' || fail "downloaded file is not the CLI (no shebang). Check \$SOURCE."
[ -s "\$TMP" ] || fail "downloaded file is empty."

mkdir -p "\$BIN"
install -m 0755 "\$TMP" "\$BIN/rssamp" 2>/dev/null || {
  cp "\$TMP" "\$BIN/rssamp" && chmod 0755 "\$BIN/rssamp"
}

# The long name as a copy rather than a symlink: a symlink into ~/.local/bin
# breaks if the target is later removed, and this file is small enough that a
# second copy costs nothing.
cp "\$BIN/rssamp" "\$BIN/rssamplifier"
chmod 0755 "\$BIN/rssamplifier"

VERSION="\$("\$BIN/rssamp" --version 2>/dev/null || echo '?')"
say ""
say "Installed rssamp \$VERSION to \$BIN"

# Only mention PATH when it is actually a problem. Telling everyone to edit
# their shell profile trains them to ignore the last line of installers.
case ":\$PATH:" in
  *":\$BIN:"*) say "Try:  rssamp topics homelab" ;;
  *)
    say ""
    say "\$BIN is not on your PATH. Add it:"
    say "  echo 'export PATH=\\"\$BIN:\\\$PATH\\"' >> ~/.profile && . ~/.profile"
    say ""
    say "Or run it directly:  \$BIN/rssamp topics homelab"
    ;;
esac

say ""
say "Upgrade later with \\\`rssamp update\\\`, uninstall with \\\`rssamp remove\\\`."
say "Docs: \$SITE/cli"
`;
}
