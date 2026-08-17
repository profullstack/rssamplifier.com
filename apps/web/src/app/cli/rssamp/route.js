import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const dynamic = 'force-dynamic';

/**
 * The CLI, as one executable file.
 *
 * This is what /install.sh downloads. It is served as the literal bytes of
 * apps/cli/src/index.js rather than as a build artifact checked in beside the
 * web app, because a copy is a thing that goes stale: the version people
 * install would drift from the version the tests cover, and nothing would say
 * so. Reading the source at request time means the released program and the
 * repository are the same file by construction.
 *
 * That works because the Docker image ships the whole workspace — see
 * apps/web/Dockerfile, which copies /repo wholesale rather than tracing a
 * standalone bundle. If that ever changes, this route is the thing that breaks.
 */
export async function GET() {
  let source;
  try {
    source = await readSource();
  } catch (err) {
    console.error('cli source unreadable', err);
    return new Response('# The CLI source could not be read. Try https://github.com/profullstack/rssamplifier.com\n', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  return new Response(source, {
    headers: {
      // text/plain, not a JavaScript type: this is downloaded with curl and
      // written to disk, and an application/javascript response invites a
      // browser to try to run it instead of showing it.
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': 'inline; filename="rssamp"',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300',
    },
  });
}

/**
 * Locate apps/cli/src/index.js from inside the running web app.
 *
 * Two candidates, tried in order, because the answer differs between `next
 * dev`, `next start` and the container — and getting it wrong means the install
 * command on the homepage stops working, which is worth a fallback.
 *
 * The first is the workspace layout: the server's cwd is apps/web in every one
 * of those cases, so ../cli/src/index.js is the sibling package. The second
 * resolves the dependency proper, which walks up through node_modules and finds
 * the same file via pnpm's symlink.
 *
 * @returns {Promise<string>}
 */
async function readSource() {
  const candidates = [path.join(process.cwd(), '..', 'cli', 'src', 'index.js')];

  try {
    candidates.push(createRequire(import.meta.url).resolve('@profullstack/rssamplifier'));
  } catch {
    // Not resolvable from here; the cwd-relative path is the answer.
  }

  let lastError;
  for (const candidate of candidates) {
    try {
      // turbopackIgnore, because a computed path makes the bundler trace the
      // entire project into the output in case any of it is needed at runtime.
      // That protects a standalone build, which this app deliberately does not
      // produce — next.config.mjs explains why, and apps/web/Dockerfile ships
      // the whole workspace regardless. Tracing here would cost build time to
      // arrange files that are already there.
      return await readFile(/* turbopackIgnore: true */ candidate, 'utf8');
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('no candidate paths');
}
