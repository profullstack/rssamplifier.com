import { PROFILE_HEADERS, loadAuthorProfile } from '../../../../lib/authorProfile.js';

export const dynamic = 'force-dynamic';

/**
 * The author's OpenProfile.md, at the conventional platform path
 * (logicsrc.com/openprofile, Discovery, rule 3): next to the profile page,
 * pointed at by `<link rel="openprofile">` on it.
 *
 * Generated from what the author published, corrected by what they told us.
 * An owner who switched the file off gets a 404 here while their page stays.
 *
 * @param {Request} _req
 * @param {{ params: Promise<{ slug: string }> }} ctx
 */
export async function GET(_req, ctx) {
  const { slug } = await ctx.params;
  const loaded = await loadAuthorProfile(slug.toLowerCase());

  if (!loaded || (loaded.profile && !loaded.profile.public)) {
    return new Response('not found\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' },
    });
  }

  return new Response(loaded.markdown, {
    headers: {
      ...PROFILE_HEADERS,
      link: `<${loaded.page}>; rel="alternate"; type="text/html"`,
    },
  });
}
