import { accounts } from '@rssamplifier/db';
import { notFound } from 'next/navigation';
import {
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Eye,
  Link2,
  Link2Off,
  Rss,
  Shuffle,
  User,
  Users,
} from 'lucide-react';

import { db, siteUrl } from '../../../lib/db.js';
import { currentUser } from '../../../lib/auth.js';
import { loadRing } from '../../../lib/rings.js';
import { joinSnippet, madeByLabel, ringUrl } from '../../../lib/openwebring.js';
import { feedImage } from '../../../lib/thumbs.js';
import { decodeXml } from '../../../lib/opml-scan.js';
import FollowButton from '../../FollowButton.jsx';
import { Avatar } from '../../Thumb.jsx';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

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

/** How a member's status reads: the badge, its icon, and the hover. */
const STATUS = {
  active: { label: 'active', title: 'Its page links to this ring', variant: 'default', Icon: Link2 },
  pending: {
    label: 'not yet checked',
    title: 'Nobody has looked for the links yet',
    variant: 'secondary',
    Icon: CircleDashed,
  },
  inactive: {
    label: 'not linking',
    title: 'No link to this ring was found on its page',
    variant: 'outline',
    Icon: Link2Off,
  },
};

/** What the made_by value means, for the hover and the icon on the badge. */
const MADE_BY = {
  human: { title: 'The site says a person makes it', Icon: User },
  ai: { title: 'The site says a model or agent makes it', Icon: Bot },
  both: { title: 'The site says a person and AI both make it', Icon: Users },
};

/**
 * One ring: the hops, the members as cards with a follow button each, and
 * how to join, folded away until wanted.
 *
 * A member card carries the ring's two facts about the site: what it says
 * about who makes it, and whether its page links here. The follow button
 * follows the feed the site publishes, the same follow as on the feed's own
 * page, so a ring is also a reading list you can subscribe to one site at a
 * time (or all at once, as OPML).
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
  const unstated = members.length - said.human - said.ai - said.both;
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

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button asChild size="sm">
          <a href={`/view/${encodeURIComponent(ring.slug)}`} title="Browse the ring's sites one by one, framed">
            <Eye /> View webring
          </a>
        </Button>
        <Button asChild variant="outline" size="sm">
          <a href={`${page}/previous`} rel="prev">
            <ChevronLeft /> Previous
          </a>
        </Button>
        <Button asChild variant="outline" size="sm">
          <a href={`${page}/random`}>
            <Shuffle /> Random
          </a>
        </Button>
        <Button asChild variant="outline" size="sm">
          <a href={`${page}/next`} rel="next">
            Next <ChevronRight />
          </a>
        </Button>
        <Button asChild variant="secondary" size="sm" className="sm:ml-auto">
          <a href={`${page}/opml`} title="Every member's feed, as an OPML subscription list">
            <Rss /> Subscribe to all
          </a>
        </Button>
      </div>

      <div className="mb-6 flex flex-wrap gap-1.5">
        <Badge variant="outline">{members.length} members</Badge>
        <Badge variant="outline">
          <Link2 /> {active} active
        </Badge>
        {said.human > 0 && (
          <Badge variant="outline">
            <User /> {said.human} by people
          </Badge>
        )}
        {said.ai > 0 && (
          <Badge variant="outline">
            <Bot /> {said.ai} by AI
          </Badge>
        )}
        {said.both > 0 && (
          <Badge variant="outline">
            <Users /> {said.both} by people and AI
          </Badge>
        )}
        {unstated > 0 && <Badge variant="outline">{unstated} unstated</Badge>}
      </div>

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
        <ol className="m-0 grid list-none gap-4 p-0 md:grid-cols-2">
          {members.map((m, i) => {
            const status = STATUS[m.status] ?? STATUS.pending;
            const made = madeByLabel(m.made_by);
            const MadeIcon = MADE_BY[m.made_by]?.Icon;
            const memberPath = `/${encodeURIComponent(m.member_slug)}`;
            // Some feeds arrive with their title already entity-escaped
            // (`Feed of &#34;x&#34;`); shown as text, that reads literally.
            const title = decodeXml(m.title);
            const description = m.description ? decodeXml(m.description) : '';
            return (
              <li key={m.member_slug} id={m.member_slug} className="min-w-0">
                <Card className="h-full gap-4 py-5">
                  <CardHeader className="px-5">
                    <div className="flex items-start gap-3">
                      <Avatar src={feedImage(m)} title={title} slug={m.member_slug} />
                      <div className="min-w-0 flex-1">
                        <CardTitle className="font-serif text-lg leading-tight">
                          <span
                            className="text-muted-foreground mr-2 font-mono text-xs font-normal"
                            aria-label={`Position ${i + 1}`}
                          >
                            {String(i + 1).padStart(2, '0')}
                          </span>
                          <a href={m.site_url} rel="noopener" className="no-underline hover:underline">
                            {title}
                          </a>
                        </CardTitle>
                        {description && (
                          <CardDescription className="mt-1.5 line-clamp-2">
                            {description}
                          </CardDescription>
                        )}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-wrap gap-1.5 px-5">
                    {made && (
                      <Badge variant="secondary" title={MADE_BY[m.made_by]?.title}>
                        {MadeIcon && <MadeIcon />} {made}
                      </Badge>
                    )}
                    {m.disclosure && <Badge variant="outline">{m.disclosure}</Badge>}
                    <Badge variant={status.variant} title={status.title}>
                      <status.Icon /> {status.label}
                    </Badge>
                    {m.item_count > 0 && (
                      <Badge variant="outline">
                        {m.item_count} {m.category === 'podcast' ? 'episodes' : 'posts'}
                      </Badge>
                    )}
                  </CardContent>
                  <CardFooter className="text-muted-foreground mt-auto gap-4 px-5 text-xs">
                    <a href={memberPath} className="hover:underline">
                      In the directory
                    </a>
                    <a
                      href={`${page}/${encodeURIComponent(m.member_slug)}/next`}
                      rel="nofollow"
                      className="hover:underline"
                    >
                      Next from here
                    </a>
                    <div className="ml-auto">
                      {/* The same follow as the feed's own page: a plain form
                          under the button so it works with JavaScript off, and
                          a click that lands flips the button in place. */}
                      <FollowButton
                        endpoint="/api/follows"
                        slug={String(m.member_slug)}
                        following={followed.has(String(m.feed_id))}
                        signedIn={Boolean(user)}
                        next={`${path}#${encodeURIComponent(m.member_slug)}`}
                        label="Follow"
                        followingLabel="Following"
                        variant="ui"
                      />
                    </div>
                  </CardFooter>
                </Card>
              </li>
            );
          })}
        </ol>
      )}

      <p className="meta mt-4">
        Machine-readable: <a href={`${page}/openwebring.json`}>openwebring.json</a> ·{' '}
        <a href={`${page}/opml`}>OPML</a> ·{' '}
        <a href={`/api/rings/${encodeURIComponent(ring.slug)}`}>JSON API</a> ·{' '}
        <a href="/.well-known/openwebring.json">every ring here</a> ·{' '}
        <a href="https://nichedb.dev/rings">every ring anywhere</a> ·{' '}
        <a href="https://logicsrc.com/openwebring">the spec</a>
      </p>

      <Card className="mt-8 gap-0 py-0">
        <details className="group" id="join">
          <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 [&::-webkit-details-marker]:hidden">
            <h2 className="m-0 font-serif text-lg font-semibold">Join this ring</h2>
            <ChevronDown className="text-muted-foreground size-4 transition-transform group-open:rotate-180" />
          </summary>
          <div className="border-border border-t px-5 py-4 text-sm [&_p]:my-3">
            <p>
              Membership is a fact about your site rather than a form. Your feed is listed under{' '}
              <a href={`/topics/${encodeURIComponent(ring.topic_slug ?? ring.slug)}`}>{ring.title}</a>{' '}
              in the directory (<a href="/submit">submit it</a> if it is not), and the ring lists it.
              To be active, put these three links anywhere on your front page, with your own
              address in <code>from</code>:
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
          </div>
        </details>
      </Card>

      <Card className="mt-4 gap-0 py-0">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 [&::-webkit-details-marker]:hidden">
            <h2 className="m-0 font-serif text-lg font-semibold">Say who makes your site</h2>
            <ChevronDown className="text-muted-foreground size-4 transition-transform group-open:rotate-180" />
          </summary>
          <div className="border-border border-t px-5 py-4 text-sm [&_p]:my-3">
            <p>
              Optional. Publish <code>/.well-known/openwebring.json</code> on your site (or point at
              it with <code>&lt;link rel="openwebring" href="…"&gt;</code> from your front page) with{' '}
              <code>made_by</code> set to <code>human</code>, <code>ai</code> or <code>both</code>,
              and the ring will show it on your card after the next check. Naming this ring in{' '}
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
          </div>
        </details>
      </Card>
    </>
  );
}
