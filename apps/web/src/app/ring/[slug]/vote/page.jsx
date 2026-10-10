import { webrings } from '@rssamplifier/db';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { ChevronUp } from 'lucide-react';

import { db } from '../../../../lib/db.js';
import { loadRing } from '../../../../lib/rings.js';
import { findMember, resolveFrom } from '../../../../lib/openwebring.js';
import { decodeXml } from '../../../../lib/opml-scan.js';
import { feedImage } from '../../../../lib/thumbs.js';
import { Avatar } from '../../../Thumb.jsx';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Vote', robots: { index: false } };

const OUTCOME = {
  voted: 'Counted. Thank you.',
  already: 'You have already voted for this site today. Come back tomorrow.',
  throttled: 'That is a lot of votes in one hour. Try again later.',
  unavailable: 'Voting is not available right now.',
};

/**
 * Where a member footer's vote link lands. A page rather than the vote
 * itself: the footer link is a GET that crawlers and prefetchers follow too,
 * so the vote is the button here, a plain form post that works with
 * JavaScript off. No account needed.
 *
 * @param {{ params: Promise<{ slug: string }>, searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export default async function VotePage({ params, searchParams }) {
  const { slug } = await params;
  const query = await searchParams;
  const loaded = await loadRing(slug);
  if (!loaded) notFound();
  const { ring, members } = loaded;
  const path = `/ring/${encodeURIComponent(ring.slug)}`;

  // Every shape a hop accepts: ?member=, ?from= (and the other rings'
  // spellings), or no query at all and the Referer of the footer it was
  // clicked in, which is how @profullstack/footer links here.
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (typeof v === 'string') params.set(k, v);
  const from =
    typeof query.member === 'string'
      ? { slug: query.member }
      : resolveFrom({ params, referer: (await headers()).get('referer') });
  const member = from ? findMember(members, from) : null;
  const outcome = typeof query.voted === 'string' ? OUTCOME[query.voted] ?? '' : '';

  if (!member) {
    return (
      <>
        <p className="eyebrow">
          <a href="/ring">Webrings</a> · <a href={path}>{ring.title}</a>
        </p>
        <h1>Vote</h1>
        <p className="lede">
          That site is not in this ring. <a href={path}>See the sites that are</a> and vote from there.
        </p>
      </>
    );
  }

  const votes = (await webrings.ringVoteCounts(db(), ring.slug))[member.member_slug] ?? 0;
  const title = decodeXml(member.title);
  const from = encodeURIComponent(member.site_url);

  return (
    <>
      <p className="eyebrow">
        <a href="/ring">Webrings</a> · <a href={path}>{ring.title}</a>
      </p>
      <h1>Vote for {title}</h1>
      <p className="lede">
        One vote per site per day, no account needed. Votes rank the sites on the{' '}
        <a href={path}>{ring.title}</a> ring page.
      </p>

      <Card className="max-w-xl">
        <CardHeader>
          <div className="flex items-start gap-3">
            <Avatar src={feedImage(member)} title={title} slug={member.member_slug} />
            <div className="min-w-0 flex-1">
              <CardTitle className="font-serif text-lg leading-tight">
                <a href={member.site_url} rel="noopener">
                  {title}
                </a>
              </CardTitle>
              <CardDescription className="mt-1.5">
                {votes} {votes === 1 ? 'vote' : 'votes'}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4">
          {outcome && (
            <p className="notice" role="status">
              {outcome}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {!outcome && (
              <form method="post" action={`/api/rings/${encodeURIComponent(ring.slug)}/vote`}>
                <input type="hidden" name="member" value={member.member_slug} />
                <Button type="submit">
                  <ChevronUp /> Vote
                </Button>
              </form>
            )}
            <a href={member.site_url} rel="noopener" className="text-sm hover:underline">
              Back to {title}
            </a>
            <a href={`${path}/next?from=${from}`} rel="nofollow" className="text-sm hover:underline">
              Next site &gt;&gt;
            </a>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
