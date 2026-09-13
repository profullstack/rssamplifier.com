'use client';

import { useEffect } from 'react';

/**
 * The viewer's keys: left and right arrows (or k and j) step through the
 * ring, r is a random site, Escape goes back to the ring page.
 *
 * Only while the viewer itself has focus: a key pressed inside the framed
 * site stays in that site, and one typed into a field is a character.
 *
 * @param {{ prev: string|null, next: string|null, random: string|null, exit: string }} props
 */
export default function ViewerKeys({ prev, next, random, exit }) {
  useEffect(() => {
    /** @param {KeyboardEvent} event */
    function onKey(event) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = /** @type {HTMLElement|null} */ (event.target);
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;

      const go = (/** @type {string|null} */ href) => {
        if (!href) return;
        event.preventDefault();
        window.location.assign(href);
      };
      if (event.key === 'ArrowRight' || event.key === 'j') go(next);
      else if (event.key === 'ArrowLeft' || event.key === 'k') go(prev);
      else if (event.key === 'r') go(random);
      else if (event.key === 'Escape') go(exit);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prev, next, random, exit]);

  return null;
}
