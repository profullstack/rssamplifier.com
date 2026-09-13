'use client';

import { useEffect, useRef } from 'react';

// Native disclosure keeps every link reachable before hydration and without JS.
export default function HeaderMore({ children }) {
  const menu = useRef(null);

  useEffect(() => {
    const closeOutside = (event) => {
      if (menu.current && !menu.current.contains(event.target)) menu.current.open = false;
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('focusin', closeOutside);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('focusin', closeOutside);
    };
  }, []);

  return (
    <details
      className="header-more"
      ref={menu}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && menu.current?.open) {
          event.preventDefault();
          menu.current.open = false;
          menu.current.querySelector('summary').focus();
        }
      }}
    >
      <summary>More</summary>
      <div className="header-more-panel">{children}</div>
    </details>
  );
}
