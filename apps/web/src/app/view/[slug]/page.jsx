import { webrings } from '@rssamplifier/db';
import { notFound } from 'next/navigation';
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ExternalLink,
  Shuffle,
  User,
  Users,
  X,
} from 'lucide-react';

import { db, siteUrl } from '../../../lib/db.js';
import { loadRing } from '../../../lib/rings.js';
import { findMember, madeByLabel, ringUrl } from '../../../lib/openwebring.js';
import { frameable } from '../../../lib/frameable.js';
import { decodeXml } from '../../../lib/opml-scan.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import ViewerKeys from './ViewerKeys.jsx';

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
    title: `${ring.title} webring, site by site`,
    description: `Browse the ${ring.title} webring one site at a time: previous, random, next, and the ring before and after it.`,
    // The ring page is the one to index; this is a way of reading it.
    robots: { index: false, follow: true },
    alternates: { canonical: ringUrl(siteUrl(), ring.slug) },
  };
}

const MADE_BY_ICON = { human: User, ai: Bot, both: Users };

const STATUS_LABEL = { active: 'links back', pending: 'not yet checked', inactive: 'not linking' };

/**
 * The member before, after and one at random, over the whole ring, wrapping.
 * Random never returns the site being looked at when there is anywhere else.
 *
 * @template {{ member_slug: string }} M
 * @param {M[]} members in ring order
 * @param {M} current
 * @param {() => number} [random]
 * @returns {{ previous: M|null, random: M|null, next: M|null }}
 */
function stepAll(members, current, random = Math.random) {
  const n = members.length;
  if (n < 2) return { previous: null, random: null, next: null };
  const i = members.indexOf(current);
  const others = members.filter((m) => m !== current);
  return {
    previous: members[(i - 1 + n) % n],
    random: others[Math.min(others.length - 1, Math.floor(random() * others.length))],
    next: members[(i + 1) % n],
  };
}

/**
 * The viewer: one member site framed, under a bar that is the whole ring's
 * worth of controls. Previous, random and next step through this ring the
 * way the hop links do (active members only, wrapping); the double chevrons
 * step to the ring before and after this one in the host's list. Arrow keys
 * do the same, r is random, Escape is the ring page.
 *
 * The site's masthead and footer are hidden here rather than left out: the
 * root layout is the only one, so the page takes the viewport back with one
 * hoisted stylesheet and gives it up again on the next navigation.
 *
 * @param {{ params: Promise<{ slug: string }>, searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export default async function ViewPage({ params, searchParams }) {
  const { slug } = await params;
  const query = await searchParams;
  const loaded = await loadRing(slug);
  if (!loaded) notFound();

  const { ring, members } = loaded;
  const ringPath = `/ring/${encodeURIComponent(ring.slug)}`;
  const at = typeof query.at === 'string' ? query.at : '';
  const current = (at && findMember(members, { slug: at })) || members[0] || null;
  // Every member, not only the active ones the spec's hop links land on: the
  // viewer is for looking at the sites in the ring, and whether a site links
  // back yet is a fact shown in the bar rather than a reason to skip it.
  const step = current ? stepAll(members, current) : { previous: null, random: null, next: null };

  const rings = await webrings.listRings(db());
  const index = rings.findIndex((r) => r.slug === ring.slug);
  const around = rings.length > 1 && index >= 0;
  const previousRing = around ? rings[(index - 1 + rings.length) % rings.length] : null;
  const nextRing = around ? rings[(index + 1) % rings.length] : null;

  const view = (/** @type {{ member_slug: string }|null} */ m) =>
    m ? `/view/${encodeURIComponent(ring.slug)}?at=${encodeURIComponent(m.member_slug)}` : null;
  const viewRing = (/** @type {{ slug: string }|null} */ r) =>
    r ? `/view/${encodeURIComponent(r.slug)}` : null;

  const title = current ? decodeXml(current.title) : '';
  const made = current ? madeByLabel(current.made_by) : '';
  const MadeIcon = current ? MADE_BY_ICON[current.made_by] : null;
  const frame = current ? await frameable(current.site_url) : { ok: false, reason: 'nobody' };
  const position = current ? members.indexOf(current) + 1 : 0;

  return (
    <>
      <style precedence="viewer" href="viewer-shell">
        {'body{overflow:hidden}body>header.masthead,body>footer.site{display:none}main#main.wrap{max-width:none;margin:0;padding:0}'}
      </style>
      <ViewerKeys prev={view(step.previous)} next={view(step.next)} random={view(step.random)} exit={ringPath} />

      <div className="flex h-dvh flex-col">
        <div className="bg-background/95 border-border flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-1.5 backdrop-blur">
          <a href="/" className="font-serif text-sm font-bold no-underline" title="RSS Amplifier">
            RSS<span className="text-primary">Amplifier</span>
          </a>

          <div className="flex items-center gap-0.5">
            <Button asChild variant="ghost" size="icon" className="size-8">
              <a href={viewRing(previousRing) ?? ringPath} title={previousRing ? `Previous ring: ${previousRing.title}` : 'Only ring'} rel="nofollow">
                <ChevronsLeft />
              </a>
            </Button>
            <a href={ringPath} className="max-w-[12rem] truncate text-sm font-medium capitalize no-underline hover:underline" title="The ring page">
              {ring.title}
            </a>
            <Button asChild variant="ghost" size="icon" className="size-8">
              <a href={viewRing(nextRing) ?? ringPath} title={nextRing ? `Next ring: ${nextRing.title}` : 'Only ring'} rel="nofollow">
                <ChevronsRight />
              </a>
            </Button>
          </div>

          <div className="flex items-center gap-1">
            <Button asChild variant="outline" size="sm" className="h-8">
              <a href={view(step.previous) ?? ringPath} rel="nofollow" title="Previous site (←)">
                <ChevronLeft /> <span className="max-sm:sr-only">Prev</span>
              </a>
            </Button>
            <Button asChild variant="outline" size="sm" className="h-8">
              <a href={view(step.random) ?? ringPath} rel="nofollow" title="Random site (r)">
                <Shuffle /> <span className="max-sm:sr-only">Random</span>
              </a>
            </Button>
            <Button asChild variant="outline" size="sm" className="h-8">
              <a href={view(step.next) ?? ringPath} rel="nofollow" title="Next site (→)">
                <span className="max-sm:sr-only">Next</span> <ChevronRight />
              </a>
            </Button>
            <span className="text-muted-foreground ml-1 font-mono text-xs tabular-nums">
              {position}/{members.length}
            </span>
          </div>

          {current && (
            <div className="ml-auto flex min-w-0 items-center gap-2">
              <a
                href={current.site_url}
                rel="noopener"
                target="_blank"
                className="min-w-0 max-w-[16rem] truncate text-sm no-underline hover:underline"
                title={title}
              >
                {title}
              </a>
              {made && (
                <Badge variant="secondary" className="max-sm:hidden">
                  {MadeIcon && <MadeIcon />} {made}
                </Badge>
              )}
              <Badge variant={current.status === 'active' ? 'default' : 'outline'} className="max-md:hidden">
                {STATUS_LABEL[current.status] ?? STATUS_LABEL.pending}
              </Badge>
              <Button asChild variant="ghost" size="icon" className="size-8">
                <a href={current.site_url} target="_blank" rel="noopener" title="Open in a new tab">
                  <ExternalLink />
                </a>
              </Button>
              <Button asChild variant="ghost" size="icon" className="size-8">
                <a href={`${ringPath}#${encodeURIComponent(current.member_slug)}`} title="Back to the ring page (Esc)">
                  <X />
                </a>
              </Button>
            </div>
          )}
        </div>

        {!current ? (
          <div className="text-muted-foreground flex flex-1 items-center justify-center p-8 text-sm">
            This ring has no members yet.{' '}
            <a href={ringPath} className="ml-1">
              The ring page
            </a>
          </div>
        ) : frame.ok ? (
          <iframe
            src={current.site_url}
            title={title}
            className="min-h-0 w-full flex-1 border-0 bg-white"
            referrerPolicy="no-referrer-when-downgrade"
            allow="fullscreen"
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="bg-card border-border max-w-md rounded-xl border p-6 text-center shadow-sm">
              <p className="mb-1 font-serif text-lg font-semibold">{title}</p>
              <p className="text-muted-foreground mb-4 text-sm">
                This site asks not to be shown inside another page, so it opens on its own.
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button asChild size="sm">
                  <a href={current.site_url} target="_blank" rel="noopener">
                    <ExternalLink /> Open {new URL(current.site_url).hostname}
                  </a>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <a href={view(step.next) ?? ringPath} rel="nofollow">
                    Skip to the next <ChevronRight />
                  </a>
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
