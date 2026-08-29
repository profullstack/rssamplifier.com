'use client';

import { useEffect, useRef, useState } from 'react';

import { matches, normalise, terms as termsOf } from '../lib/listFilter.js';

/**
 * Type-to-narrow filtering over a list that is already on the page.
 *
 * Every other control on this site is a form that posts and comes back with new
 * markup, and the long lists here — three hundred topics, sixty feeds, a river
 * of posts — are the one place that reads badly. Round-tripping to the server to
 * answer "is `rust` in here?" costs a page load for a question the browser can
 * already answer, because the answer is in the DOM in front of you.
 *
 * So this filters the rendered rows in place. It never fetches, never touches
 * the URL, and never removes anything: rows it rules out get a class that hides
 * them, and clearing the box puts every one of them back.
 *
 * Two deliberate choices are worth knowing about.
 *
 * It renders nothing until it has mounted. A search box that does nothing is
 * worse than no search box, and with JavaScript off that is exactly what this
 * would be — the rest of the page still works without it, so the honest thing
 * is to be absent rather than broken.
 *
 * And it filters rows, not records. What it can see is the current page of the
 * list, which is why the count says so and why `searchHref` exists: someone
 * typing a word that is not on this page wants the whole directory, not an
 * empty box. That link is the escape hatch to the real, server-side search.
 *
 * @param {object} props
 * @param {string} props.target CSS selector matching each row of the list.
 * @param {string} props.noun Singular name for a row, e.g. 'topic'.
 * @param {string} [props.plural] Plural, where an `s` will not do.
 * @param {string} [props.label] Accessible label for the box.
 * @param {string} [props.placeholder]
 * @param {string} [props.searchHref] Path to send an unmatched query to, with
 *   the query appended — `/search?q=` becomes `/search?q=rust`.
 * @param {string} [props.searchLabel] Wording for that link.
 */
export default function ListFilter({
  target,
  noun,
  plural,
  label,
  placeholder,
  searchHref = null,
  searchLabel = 'Search the whole directory →',
}) {
  const [mounted, setMounted] = useState(false);
  const [query, setQuery] = useState('');
  const [counts, setCounts] = useState({ shown: 0, total: 0 });
  // Normalised row text, cached against the element itself: the text of a row
  // cannot change between keystrokes, and re-reading textContent off three
  // hundred nodes on every one of them is work nobody asked for. A WeakMap so
  // a re-rendered list does not pin its old nodes in memory.
  const textRef = useRef(new WeakMap());

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return undefined;

    const rows = Array.from(document.querySelectorAll(target));
    const wanted = termsOf(query);
    const cache = textRef.current;

    let shown = 0;

    for (const row of rows) {
      if (!cache.has(row)) cache.set(row, normalise(row.textContent ?? ''));
      const haystack = cache.get(row);

      const match = matches(haystack, wanted);

      row.classList.toggle('filtered-out', !match);
      if (match) shown += 1;
    }

    setCounts({ shown, total: rows.length });

    // Leaving the page (or the list re-rendering under us) must not leave rows
    // hidden with no box on screen to un-hide them.
    return () => {
      for (const row of rows) row.classList.remove('filtered-out');
    };
  }, [mounted, query, target]);

  if (!mounted) return null;

  const many = plural ?? `${noun}s`;
  const filtering = query.trim().length > 0;
  const empty = filtering && counts.shown === 0;

  return (
    <div className="list-filter">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // Escape clears, the way it does in every other search box. The
          // browser's own clear button does this on a type=search input, but
          // only on some of them, and only with a mouse.
          if (e.key === 'Escape') setQuery('');
        }}
        placeholder={placeholder ?? `Filter these ${many}…`}
        aria-label={label ?? `Filter ${many} on this page`}
        autoComplete="off"
      />

      {/* role=status rather than a bare count: the number is the only feedback
          that typing did anything, and a screen reader gets no other signal
          that two hundred rows just vanished. */}
      <p className="filter-count" role="status">
        {filtering ? (
          <>
            {/* "1 of 300 topics" — the noun agrees with the number next to it,
                which is the total, not the number that matched. */}
            {counts.shown} of {counts.total} {counts.total === 1 ? noun : many} on this page
            {counts.shown > 0 && ' '}
            {counts.shown > 0 && (
              <button type="button" className="linkish" onClick={() => setQuery('')}>
                Clear
              </button>
            )}
          </>
        ) : (
          <>
            {counts.total} {counts.total === 1 ? noun : many} on this page
          </>
        )}
      </p>

      {empty && (
        <p className="empty">
          Nothing on this page matches <strong>{query.trim()}</strong>.{' '}
          {searchHref ? (
            <a href={`${searchHref}${encodeURIComponent(query.trim())}`}>
              {searchLabel}
            </a>
          ) : (
            'Try another word, or the pager below.'
          )}
        </p>
      )}
    </div>
  );
}
