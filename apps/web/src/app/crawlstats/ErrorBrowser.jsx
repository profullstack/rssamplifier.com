'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The error count at the top of the status page, with its details kept hidden
 * until somebody asks for them.
 *
 * @param {{ total: number, dead: number, errors: Array<{ id: string, kind: string, at: string|null, source: string, href?: string|null, message: string }> }} props
 */
export default function ErrorBrowser({ total, dead, errors }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(null);
  const panel = useRef(null);

  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);

  useEffect(() => {
    const show = () => {
      setOpen(true);
      window.setTimeout(() => panel.current?.focus(), 0);
    };
    window.addEventListener('rssamplifier:open-errors', show);
    return () => window.removeEventListener('rssamplifier:open-errors', show);
  }, []);

  const copy = async (text, key) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1500);
    } catch {
      setCopied('failed');
    }
  };

  const all = errors
    .map((row) => [row.at, row.kind, row.source, row.message].filter(Boolean).join(' | '))
    .join('\n');

  return (
    <>
      <button
        type="button"
        className="stat stat-link stat-button"
        aria-expanded={open}
        aria-controls="crawl-error-browser"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="stat-value">{Number(total).toLocaleString('en-US')}</span>
        <span className="stat-label">Erroring</span>
        <span className="stat-note">
          {open ? 'hide messages' : 'view messages'} · {Number(dead).toLocaleString('en-US')} given up
        </span>
      </button>

      {open && (
        <section
          id="crawl-error-browser"
          className="crawl-error-browser"
          ref={panel}
          tabIndex={-1}
          aria-label="Crawler error messages"
        >
          <header className="crawl-error-browser-head">
            <div>
              <h2>Error messages</h2>
              <p>
                The worst currently failing feeds and daemon failures from the last 24 hours.
              </p>
            </div>
            <div className="crawl-error-browser-actions">
              <button type="button" onClick={() => copy(all, 'all')} disabled={errors.length === 0}>
                {copied === 'all' ? 'Copied' : 'Copy all'}
              </button>
              <button type="button" onClick={() => setOpen(false)}>Close</button>
            </div>
          </header>

          {errors.length === 0 ? (
            <p>No error messages are currently available.</p>
          ) : (
            <ul className="crawl-error-browser-list">
              {errors.map((row) => (
                <li key={row.id}>
                  <div className="crawl-error-browser-meta">
                    <span className="job-state">{row.kind}</span>
                    {row.href ? <a href={row.href}>{row.source}</a> : <strong>{row.source}</strong>}
                    {row.at && <time dateTime={row.at}>{new Date(row.at).toISOString()}</time>}
                    <button type="button" onClick={() => copy(row.message, row.id)}>
                      {copied === row.id ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <pre>{row.message}</pre>
                </li>
              ))}
            </ul>
          )}

          {copied === 'failed' && (
            <p className="crawl-error-copy-failed" role="status">
              Clipboard access was refused. Select the message text and copy it normally.
            </p>
          )}
        </section>
      )}
    </>
  );
}

/**
 * Open the shared error panel from counts elsewhere on the page.
 *
 * @param {{ className?: string, children: import('react').ReactNode }} props
 */
export function ErrorBrowserButton({ className, children }) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => window.dispatchEvent(new Event('rssamplifier:open-errors'))}
    >
      {children}
    </button>
  );
}
