const SNIPPET_URL = 'https://pit.world/snippets/footer.html?site=rssamplifier.com';

/**
 * The pit.world global footer: site name, Search, Ring, Publish here — the
 * same bar every site in the network carries, fetched server side so it costs
 * the reader no script and no extra request.
 *
 * Cached for an hour in Next's data cache and given three seconds to answer.
 * Any failure — timeout, non-200, a network error — renders nothing: the
 * network's footer is never a reason for one of our pages to break.
 */
export default async function PitFooter() {
  try {
    const res = await fetch(SNIPPET_URL, {
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    // Folded onto one line: the fragment is pure markup and CSS (no <pre>),
    // and a page that greps for data-pit-footer — the pit.world proxy, our own
    // checks — then sees the rendered copy and the RSC payload's copy as the
    // single line they are on rather than two.
    const html = (await res.text()).replace(/\s*\n\s*/g, ' ').trim();
    if (!html.includes('data-pit-footer')) return null;
    return <div dangerouslySetInnerHTML={{ __html: html }} />;
  } catch {
    return null;
  }
}
