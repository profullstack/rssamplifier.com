import { notFound } from 'next/navigation';

import { siteUrl } from '../../../lib/db.js';
import { loadRing } from '../../../lib/rings.js';
import { joinSnippet, madeByLabel, ringUrl } from '../../../lib/openwebring.js';

export const dynamic = 'force-dynamic';

/**
 * @param {{ params: Promise<{ slug: string }> }} props
 */
export async function generateMetadata({ params }) {
  const { slug } = await params;
  const loaded = await loadRing(slug);
  if (!loaded) return { title: 'Not found' };
  const { ring } = loaded;
  return {
    title: `${ring.title} webring`,
    description: `${ring.member_count} sites about ${ring.title}, in a ring: next, previous and random hops, an OPML of their feeds, and who makes each one.`,
    alternates: { canonical: ringUrl(siteUrl(), ring.slug) },
  };
}

/** How a member's status reads, and the colour it borrows. */
const STATUS = {
  active: { label: 'active', className: 'freshness-live' },
  pending: { label: 'not yet checked', className: 'freshness-unread' },
  inactive: { label: 'not linking', className: 'freshness-dormant' },
};

/**
 * One ring: its members in order, the hops, and how to join.
 *
 * The page is also the place a member checks their own link, with a plain
 * form that posts to the check route and comes back here. No account, no
 * script: the ring asks one link of a site and the site asks one click of
 * the ring.
 *
 * @param {{ params: Promise<{ slug: string }>, searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export default async function RingPage({ params, searchParams }) {
  const { slug } = await params;
  const query = await searchParams;
  const loaded = await loadRing(slug);
  if (!loaded) notFound();

  const { ring, members } = loaded;
  const base = siteUrl();
  const page = ringUrl(base, ring.slug);
  const active = members.filter((m) => m.status === 'active').length;
  const checked = typeof query.checked === 'string' ? query.checked : '';
  const outcome = typeof query.status === 'string' ? query.status : '';

  return (
    <>
      {/* The spec's one registered rel: it points a consumer at the ring
          file. React hoists a <link> rendered here into the head. */}
      <link rel="openwebring" href={`${page}/openwebring.json`} />

      <p className="eyebrow">
        <a href="/ring">Webrings</a>
      </p>
      <h1>{ring.title} webring</h1>
      <p className="lede">
        {ring.description ?? `Sites in the directory about ${ring.title}.`} A member is in the ring
        from the moment its site links here; a site that stops linking is kept in its place and
        skipped. Who makes each site is the site&rsquo;s own word, unverified, and absent means
        they have not said.
      </p>

      <p className="detail-actions">
        <a href={`${page}/previous`}>previous site</a> · <a href={`${page}/random`}>random site</a>{' '}
        · <a href={`${page}/next`}>next site</a>
      </p>

      <p className="meta">
        Machine-readable: <a href={`${page}/openwebring.json`}>openwebring.json</a> ·{' '}
        <a href={`${page}/opml`}>OPML</a> ·{' '}
        <a href={`/api/rings/${encodeURIComponent(ring.slug)}`}>JSON API</a> ·{' '}
        <a href="/.well-known/openwebring.json">every ring here</a>
      </p>

      {checked && (
        <p className="notice">
          {outcome === 'active' && (
            <>
              <strong>{checked}</strong> links to the ring and is active.
            </>
          )}
          {outcome === 'inactive' && (
            <>
              No link to this ring was found on <strong>{checked}</strong> yet. Paste the snippet
              below, publish, and check again.
            </>
          )}
          {outcome === 'busy' && <>The checker is busy right now. Try again in a moment.</>}
          {outcome === 'unknown' && (
            <>
              <strong>{checked}</strong> is not a member of this ring. Members are the sites in the
              directory filed under this topic; <a href="/submit">submit the feed</a> first.
            </>
          )}
        </p>
      )}

      <h2>
        Members{' '}
        <span className="pill">
          {active} active of {members.length}
        </span>
      </h2>

      {members.length === 0 ? (
        <p className="empty">Nobody yet.</p>
      ) : (
        <ol className="post-list">
          {members.map((m) => {
            const status = STATUS[m.status] ?? STATUS.pending;
            const made = madeByLabel(m.made_by);
            return (
              <li key={m.member_slug}>
                <a href={m.site_url}>{m.title}</a>{' '}
                <a className="meta" href={`/${encodeURIComponent(m.member_slug)}`}>
                  in the directory
                </a>{' '}
                {made && <span className="pill">{made}</span>}{' '}
                <span className={`pill freshness ${status.className}`}>{status.label}</span>{' '}
                <span className="meta">
                  <a href={`${page}/${encodeURIComponent(m.member_slug)}/next`}>next from here</a>
                </span>
              </li>
            );
          })}
        </ol>
      )}

      <h2 id="join">Join</h2>
      <p>
        Membership is a fact about your site rather than a form. Your feed is listed under{' '}
        <a href={`/topics/${encodeURIComponent(ring.topic_slug ?? ring.slug)}`}>{ring.title}</a> in
        the directory (<a href="/submit">submit it</a> if it is not), and the ring lists it. To be
        active, put these three links anywhere on your front page, with your own address in{' '}
        <code>from</code>:
      </p>
      <pre className="code-block">{joinSnippet({ base, ring })}</pre>
      <p className="hint">
        Any one link to this ring counts, in any order, with any text. The crawler looks again
        about once a week; to be looked at now, ask here:
      </p>
      <form className="submit-box" method="post" action={`${page}/check`}>
        <input type="url" name="url" placeholder="https://your.site/" aria-label="Your site's address" required />
        <div className="submit-actions">
          <button type="submit">Check my site</button>
        </div>
      </form>

      <h3>Say who makes your site</h3>
      <p>
        Optional. Publish <code>/.well-known/openwebring.json</code> on your site with{' '}
        <code>made_by</code> set to <code>human</code>, <code>ai</code> or <code>both</code>, and the
        ring will show it beside your name after the next check. Naming this ring in{' '}
        <code>rings</code> counts as linking to it. Absent means unstated; nothing is assumed.
      </p>
      <pre className="code-block">{JSON.stringify(
        {
          openwebring: '0.1',
          site: { url: 'https://your.site/', name: 'Your site' },
          made_by: 'human',
          rings: [{ ring: page, slug: 'your-slug-in-this-ring' }],
        },
        null,
        2,
      )}</pre>
      <p className="hint">
        The person who claimed the author profile of the feed can also set it directly:{' '}
        <code>PUT /api/rings/{ring.slug}/members/&lt;slug&gt;</code> with{' '}
        <code>{'{ "made_by": "human" }'}</code>. The spec is at{' '}
        <a href="https://logicsrc.com/openwebring">logicsrc.com/openwebring</a>.
      </p>
    </>
  );
}
