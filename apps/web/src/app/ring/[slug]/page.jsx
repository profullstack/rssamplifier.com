import { accounts } from '@rssamplifier/db';
import { notFound } from 'next/navigation';

import { db, siteUrl } from '../../../lib/db.js';
import { currentUser } from '../../../lib/auth.js';
import { loadRing } from '../../../lib/rings.js';
import { joinSnippet, madeByLabel, ringUrl } from '../../../lib/openwebring.js';
import { feedImage } from '../../../lib/thumbs.js';
import FollowButton from '../../FollowButton.jsx';
import { Avatar } from '../../Thumb.jsx';

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

/** How a member's status reads, and the colour it borrows from the freshness scale. */
const STATUS = {
  active: { label: 'active', title: 'Its page links to this ring', className: 'freshness-live' },
  pending: { label: 'not yet checked', title: 'Nobody has looked for the links yet', className: 'freshness-unread' },
  inactive: { label: 'not linking', title: 'No link to this ring was found on its page', className: 'freshness-dormant' },
};

/** The made_by pill: the member's own word, or nothing. */
const MADE_BY_TITLE = {
  human: 'The site says a person makes it',
  ai: 'The site says a model or agent makes it',
  both: 'The site says a person and AI both make it',
};

/**
 * One ring: the hops, the members as cards with a follow button each, and
 * how to join, folded away until wanted.
 *
 * A member card is the same card the directory uses for a feed, with the
 * ring's two facts on it: what the site says about who makes it, and whether
 * its page links here. The follow button follows the feed the site publishes,
 * the same follow as on the feed's own page, so a ring is also a reading
 * list you can subscribe to one site at a time (or all at once, as OPML).
 *
 * @param {{ params: Promise<{ slug: string }>, searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export default async function RingPage({ params, searchParams }) {
  const { slug } = await params;
  const query = await searchParams;
  const [loaded, user] = await Promise.all([loadRing(slug), currentUser()]);
  if (!loaded) notFound();

  const { ring, members } = loaded;
  const base = siteUrl();
  const page = ringUrl(base, ring.slug);
  const path = `/ring/${encodeURIComponent(ring.slug)}`;
  const active = members.filter((m) => m.status === 'active').length;
  const said = { human: 0, ai: 0, both: 0 };
  for (const m of members) if (m.made_by && m.made_by in said) said[m.made_by] += 1;
  const checked = typeof query.checked === 'string' ? query.checked : '';
  const outcome = typeof query.status === 'string' ? query.status : '';

  // One query for every button on the page, rather than one per member.
  const followed = new Set(
    user ? (await accounts.followedFeeds(db(), String(user.id), 1000)).map((f) => String(f.id)) : [],
  );

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
        {ring.description ?? `Sites in the directory about ${ring.title}.`} Follow the ring site by
        site, or subscribe to all of them at once. Who makes each site is the site&rsquo;s own word.
      </p>

      <div className="detail-actions ring-hops">
        <a className="button" href={`${page}/previous`} rel="prev">
          ← Previous site
        </a>
        <a className="button" href={`${page}/random`}>
          Random site
        </a>
        <a className="button" href={`${page}/next`} rel="next">
          Next site →
        </a>
        <a className="button" href={`${page}/opml`} title="Every member's feed, as an OPML subscription list">
          Subscribe to all (OPML)
        </a>
      </div>

      <p className="meta ring-stats">
        <span className="pill">{members.length} members</span>{' '}
        <span className="pill freshness freshness-live">{active} active</span>{' '}
        {said.human > 0 && <span className="pill">{said.human} made by people</span>}{' '}
        {said.ai > 0 && <span className="pill">{said.ai} made by AI</span>}{' '}
        {said.both > 0 && <span className="pill">{said.both} made by both</span>}{' '}
        {members.length - said.human - said.ai - said.both > 0 && (
          <span className="pill">{members.length - said.human - said.ai - said.both} unstated</span>
        )}
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
              under Join, publish, and check again.
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

      {members.length === 0 ? (
        <p className="empty">Nobody yet.</p>
      ) : (
        <ol className="feed-list ring-members">
          {members.map((m, i) => {
            const status = STATUS[m.status] ?? STATUS.pending;
            const made = madeByLabel(m.made_by);
            const memberPath = `/${encodeURIComponent(m.member_slug)}`;
            return (
              <li className="feed-row ring-member" key={m.member_slug} id={m.member_slug}>
                <Avatar src={feedImage(m)} title={m.title} slug={m.member_slug} />
                <h3>
                  <span className="ring-position" aria-label={`Position ${i + 1}`}>
                    {i + 1}
                  </span>{' '}
                  <a href={m.site_url} rel="noopener">
                    {m.title}
                  </a>
                </h3>
                {m.description && <p>{m.description}</p>}
                <div className="feed-meta">
                  {made && (
                    <span className="pill" title={MADE_BY_TITLE[m.made_by] ?? ''}>
                      {made}
                      {m.disclosure ? ` · ${m.disclosure}` : ''}
                    </span>
                  )}
                  <span className={`pill freshness ${status.className}`} title={status.title}>
                    {status.label}
                  </span>
                  {m.item_count > 0 && (
                    <span>
                      {m.item_count} {m.category === 'podcast' ? 'episodes' : 'posts'}
                    </span>
                  )}
                  <a href={memberPath}>in the directory</a>
                  <a href={`${page}/${encodeURIComponent(m.member_slug)}/next`} rel="nofollow">
                    next from here →
                  </a>
                </div>
                <div className="detail-actions ring-follow">
                  {/* The same follow as the feed's own page: a plain form under
                      the button so it works with JavaScript off, and a click
                      that lands flips the button in place. */}
                  <FollowButton
                    endpoint="/api/follows"
                    slug={String(m.member_slug)}
                    following={followed.has(String(m.feed_id))}
                    signedIn={Boolean(user)}
                    next={`${path}#${encodeURIComponent(m.member_slug)}`}
                    label="+ Follow"
                    followingLabel="− Unfollow"
                  />
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <p className="meta">
        Machine-readable: <a href={`${page}/openwebring.json`}>openwebring.json</a> ·{' '}
        <a href={`${page}/opml`}>OPML</a> ·{' '}
        <a href={`/api/rings/${encodeURIComponent(ring.slug)}`}>JSON API</a> ·{' '}
        <a href="/.well-known/openwebring.json">every ring here</a> ·{' '}
        <a href="https://logicsrc.com/openwebring">the spec</a>
      </p>

      <details className="ring-join" id="join">
        <summary>
          <h2>Join this ring</h2>
        </summary>
        <p>
          Membership is a fact about your site rather than a form. Your feed is listed under{' '}
          <a href={`/topics/${encodeURIComponent(ring.topic_slug ?? ring.slug)}`}>{ring.title}</a>{' '}
          in the directory (<a href="/submit">submit it</a> if it is not), and the ring lists it.
          To be active, put these three links anywhere on your front page, with your own address in{' '}
          <code>from</code>:
        </p>
        <pre className="code-block">{joinSnippet({ base, ring })}</pre>
        <p className="hint">
          Any one link to this ring counts, in any order, with any text. The crawler looks again
          about once a week; to be looked at now, ask here:
        </p>
        <form className="submit-box" method="post" action={`${page}/check`}>
          <input
            type="url"
            name="url"
            placeholder="https://your.site/"
            aria-label="Your site's address"
            required
          />
          <div className="submit-actions">
            <button type="submit">Check my site</button>
          </div>
        </form>
      </details>

      <details className="ring-join">
        <summary>
          <h2>Say who makes your site</h2>
        </summary>
        <p>
          Optional. Publish <code>/.well-known/openwebring.json</code> on your site (or point at it
          with <code>&lt;link rel="openwebring" href="…"&gt;</code> from your front page) with{' '}
          <code>made_by</code> set to <code>human</code>, <code>ai</code> or <code>both</code>, and the
          ring will show it beside your name after the next check. Naming this ring in{' '}
          <code>rings</code> counts as linking to it. Absent means unstated; nothing is assumed.
        </p>
        <pre className="code-block">
          {JSON.stringify(
            {
              openwebring: '0.1',
              site: { url: 'https://your.site/', name: 'Your site' },
              made_by: 'human',
              rings: [{ ring: page, slug: 'your-slug-in-this-ring' }],
            },
            null,
            2,
          )}
        </pre>
        <p className="hint">
          The person who claimed the author profile of the feed can also set it directly:{' '}
          <code>PUT /api/rings/{ring.slug}/members/&lt;slug&gt;</code> with{' '}
          <code>{'{ "made_by": "human" }'}</code>.
        </p>
      </details>
    </>
  );
}
