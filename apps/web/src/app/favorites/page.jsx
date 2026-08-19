import { redirect } from 'next/navigation';
import { reactions } from '@rssamplifier/db';

import { db } from '../../lib/db.js';
import { currentUser } from '../../lib/auth.js';
import { postThumb } from '../../lib/thumbs.js';
import Thumb from '../Thumb.jsx';
import Toolbar from '../Toolbar.jsx';
import ListFilter from '../ListFilter.jsx';
import { FILTER_FROM } from '../../lib/listFilter.js';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Favorites',
  description: 'Posts you have saved.',
  // One reader's shelf. Nothing here should be in an index.
  robots: { index: false, follow: false },
};

/**
 * Everything the signed-in reader has liked.
 *
 * The like button in the reader is the only way in, and this is where it goes —
 * a private shelf, in the order things were saved rather than the order they
 * were published, because the useful question here is "what did I keep" and not
 * "what is new".
 */
export default async function FavoritesPage() {
  const user = await currentUser();
  if (!user) redirect('/login?next=%2Ffavorites');

  const client = db();
  const items = await reactions.likedItems(client, String(user.id));

  return (
    <>
      <h1>Favorites</h1>

      {items.length === 0 ? (
        <p className="lede">
          Nothing saved yet. The ♡ in the reader puts a post here — try{' '}
          <a href="/random">a random blog</a>.
        </p>
      ) : (
        <>
          <p className="lede">
            {items.length} saved post{items.length === 1 ? '' : 's'}, most recent first.
          </p>

          {items.length >= FILTER_FROM && (
            <ListFilter target=".post-list > li" noun="saved post" />
          )}

          <ul className="post-list">
            {items.map((item) => {
              const slug = String(item.feed_slug);
              const guid = String(item.guid);

              const thumb = postThumb(item);
              const href = `/${slug}/read?p=${encodeURIComponent(guid)}`;

              return (
                <li key={`${slug}:${guid}`} className={thumb ? 'has-thumb' : undefined}>
                  <Thumb src={thumb} href={href} />
                  <a href={href}>{String(item.title)}</a>
                  <p className="meta">
                    <a href={`/${slug}`}>{String(item.feed_title)}</a>
                    {item.published_at ? ` · ${when(item.published_at)}` : ''}
                  </p>
                  {item.summary && <p className="summary">{String(item.summary)}</p>}
                </li>
              );
            })}
          </ul>
        </>
      )}

      <Toolbar />
    </>
  );
}

/**
 * @param {unknown} iso
 * @returns {string}
 */
function when(iso) {
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
