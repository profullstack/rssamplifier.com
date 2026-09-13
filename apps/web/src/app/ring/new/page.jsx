import { LogIn, Plus } from 'lucide-react';

import { currentUser } from '../../../lib/auth.js';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Make a webring',
  description:
    'Make your own webring on RSS Amplifier: a title, a line about it, and the sites in it. Published the moment you save it.',
};

const FIELD =
  'border-input bg-background text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px]';

const ERRORS = {
  title: 'A ring needs a title.',
  members: 'None of those is in the directory yet. Submit the feed first, then add it here.',
  slug: 'That name is taken; try another title.',
  'bad-request': 'The form did not come through. Try again.',
};

/**
 * Make a ring. Signed in, because a ring has an owner who can edit it; the
 * form itself is three fields and a plain post, and the ring is public the
 * moment it exists.
 *
 * @param {{ searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export default async function NewRingPage({ searchParams }) {
  const user = await currentUser();
  const query = await searchParams;
  const error = typeof query.error === 'string' ? ERRORS[query.error] : '';
  const missing = typeof query.missing === 'string' ? query.missing.split('\n').filter(Boolean) : [];

  return (
    <>
      <p className="eyebrow">
        <a href="/ring">Webrings</a>
      </p>
      <h1>Make a webring</h1>
      <p className="lede">
        A ring is an ordered, circular list of sites with next, previous and random hops. Name it,
        list the sites, and it is published: on the ring index, on the host file every directory
        reads, with an OPML of its feeds and a viewer that frames its sites one at a time.
      </p>

      {!user ? (
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle className="font-serif text-lg">Sign in to make a ring</CardTitle>
            <CardDescription>A ring has an owner, who is the one who can edit it later.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <a href="/login?next=%2Fring%2Fnew">
                <LogIn /> Sign in
              </a>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <form method="post" action="/api/rings" className="grid max-w-xl gap-5">
          {error && (
            <p className="notice" role="alert">
              {error}
              {missing.length > 0 && (
                <>
                  {' '}
                  Not found: {missing.join(', ')}.
                </>
              )}
            </p>
          )}
          <label className="grid gap-1.5 text-sm font-medium">
            Title
            <input name="title" required maxLength={80} placeholder="Indie game devlogs" className={FIELD} />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            About it <span className="text-muted-foreground font-normal">(optional)</span>
            <textarea
              name="description"
              rows={2}
              maxLength={500}
              placeholder="One line on what the ring is for."
              className={FIELD}
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Sites
            <textarea
              name="members"
              rows={8}
              required
              placeholder={'One per line: a site address, a feed address, or a directory slug\nhttps://example.com/\nhttps://another.example/feed.xml\nsome-blog'}
              className={`${FIELD} font-mono text-xs`}
            />
            <span className="text-muted-foreground text-xs font-normal">
              Members are sites in the directory; <a href="/submit">submit a feed</a> first if one is
              not. The order you give is the ring&rsquo;s order. You can add and remove sites later.
            </span>
          </label>
          <div>
            <Button type="submit">
              <Plus /> Publish the ring
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
