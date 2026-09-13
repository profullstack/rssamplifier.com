import { notFound, redirect } from 'next/navigation';
import { Check, Plus, Trash2 } from 'lucide-react';

import { currentUser } from '../../../../lib/auth.js';
import { loadRing, ownsRing } from '../../../../lib/rings.js';
import { decodeXml } from '../../../../lib/opml-scan.js';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

const FIELD =
  'border-input bg-background text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px]';

/**
 * @param {{ params: Promise<{ slug: string }> }} props
 */
export async function generateMetadata({ params }) {
  const { slug } = await params;
  const loaded = await loadRing(slug);
  return { title: loaded ? `Edit ${loaded.ring.title}` : 'Not found', robots: { index: false } };
}

/**
 * Edit a ring you made: its title and line, the sites in it. Everything is
 * a plain form post to the ring's API, so it works with JavaScript off.
 *
 * @param {{ params: Promise<{ slug: string }>, searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export default async function EditRingPage({ params, searchParams }) {
  const { slug } = await params;
  const query = await searchParams;
  const [loaded, user] = await Promise.all([loadRing(slug), currentUser()]);
  if (!loaded) notFound();
  const { ring, members } = loaded;
  const path = `/ring/${encodeURIComponent(ring.slug)}`;
  if (!user) redirect(`/login?next=${encodeURIComponent(`${path}/edit`)}`);
  if (!ownsRing(user, ring)) redirect(path);

  const saved = query.saved === '1';
  const missing = typeof query.missing === 'string' ? query.missing.split('\n').filter(Boolean) : [];
  const api = `/api/rings/${encodeURIComponent(ring.slug)}`;

  return (
    <>
      <p className="eyebrow">
        <a href="/ring">Webrings</a> · <a href={path}>{ring.title}</a>
      </p>
      <h1>Edit {ring.title}</h1>
      <p className="lede">
        Changes are live as soon as they save. The ring is at <a href={path}>{path}</a>.
      </p>

      {saved && (
        <p className="notice" role="status">
          <Check className="mr-1 inline size-4" /> Saved.
        </p>
      )}
      {missing.length > 0 && (
        <p className="notice" role="alert">
          Not in the directory, so not added: {missing.join(', ')}. <a href="/submit">Submit the feed</a>{' '}
          first, then add it here.
        </p>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="font-serif text-lg">The ring</CardTitle>
            <CardDescription>Its name and the line under it.</CardDescription>
          </CardHeader>
          <CardContent>
            <form method="post" action={api} className="grid gap-4">
              <label className="grid gap-1.5 text-sm font-medium">
                Title
                <input name="title" required maxLength={80} defaultValue={ring.title} className={FIELD} />
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                About it
                <textarea
                  name="description"
                  rows={3}
                  maxLength={500}
                  defaultValue={ring.description ?? ''}
                  className={FIELD}
                />
              </label>
              <div>
                <Button type="submit" size="sm">
                  Save
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="font-serif text-lg">Add sites</CardTitle>
            <CardDescription>They go on the end, in the order given.</CardDescription>
          </CardHeader>
          <CardContent>
            <form method="post" action={`${api}/members`} className="grid gap-4">
              <input type="hidden" name="action" value="add" />
              <textarea
                name="members"
                rows={6}
                required
                aria-label="Sites to add"
                placeholder={'One per line: a site address, a feed address, or a directory slug'}
                className={`${FIELD} font-mono text-xs`}
              />
              <div>
                <Button type="submit" size="sm">
                  <Plus /> Add
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>

      <h2>Members</h2>
      {members.length === 0 ? (
        <p className="empty">Nobody yet.</p>
      ) : (
        <ol className="m-0 grid list-none gap-2 p-0">
          {members.map((m, i) => (
            <li
              key={m.member_slug}
              className="bg-card border-border flex flex-wrap items-center gap-3 rounded-lg border px-4 py-2.5 text-sm"
            >
              <span className="text-muted-foreground w-6 font-mono text-xs">{String(i + 1).padStart(2, '0')}</span>
              <a href={m.site_url} rel="noopener" className="min-w-0 flex-1 truncate font-medium no-underline hover:underline">
                {decodeXml(m.title)}
              </a>
              <span className="text-muted-foreground max-w-[14rem] truncate font-mono text-xs">{m.site_url}</span>
              <form method="post" action={`${api}/members`} className="m-0">
                <input type="hidden" name="action" value="remove" />
                <input type="hidden" name="member" value={m.member_slug} />
                <Button type="submit" variant="ghost" size="icon" className="size-8" title="Remove from the ring">
                  <Trash2 />
                </Button>
              </form>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
