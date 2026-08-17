'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Share this page: the link, or the link with the post around it.
 *
 * Every other control on the site is a form that works with JavaScript off,
 * and the clipboard is the one thing that cannot be. So the panel is built the
 * other way round: what it opens with is the URL itself, in a field, selected
 * on focus — which is the copy every browser has always had. The buttons are
 * an improvement on that, and they are only rendered once there is a browser
 * running them, because a button that silently does nothing is worse than no
 * button at all.
 *
 * `<details>` rather than a popover so that opening it costs nothing either.
 *
 * Two copies, because they are pasted into different places. The link unfurls
 * on its own in anything that previews URLs; the post is the title and the gist
 * above it, for a mail or a note that will show exactly the characters it was
 * given and nothing more.
 *
 * @param {{
 *   url: string,
 *   title: string,
 *   text?: string|null,
 *   label?: string,
 *   textLabel?: string,
 * }} props
 */
export default function Share({
  url,
  title,
  text = null,
  label = 'Share',
  // Named after what is being copied rather than left as "Copy text": on a
  // post it is the post, and a button that says so is the difference between
  // two buttons and a choice.
  textLabel = 'Copy text',
}) {
  // Nothing browser-only renders on the server, so the markup the client first
  // sees is the markup React produced — no hydration mismatch, and a reader
  // with scripts blocked keeps the field.
  const [mounted, setMounted] = useState(false);
  const [native, setNative] = useState(false);
  const [done, setDone] = useState('');
  const timer = useRef(null);

  useEffect(() => {
    setMounted(true);
    setNative(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  /**
   * @param {string} value
   * @param {string} what what to say once it is on the clipboard
   */
  async function copy(value, what) {
    const ok = await write(value);
    // Opens a sentence, so it is capitalised here rather than at every call.
    const noun = what.charAt(0).toUpperCase() + what.slice(1);
    say(ok ? `${noun} copied` : 'Press ⌘C or Ctrl+C to copy');
  }

  /** @param {string} message */
  function say(message) {
    setDone(message);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(''), 2500);
  }

  async function share() {
    try {
      await navigator.share({ title, text: text ?? undefined, url });
    } catch (error) {
      // Cancelling the sheet rejects, and a cancelled share is not a failure
      // worth reporting back to the reader.
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        say('Sharing failed — the link is above');
      }
    }
  }

  return (
    <details className="share">
      {/* The word stays, even in the reactions row where every other control
          is a glyph. "↗" on its own is already the toolbar's "Open", and two
          arrows on one page meaning two different things is worse than one
          button being wider than its neighbours. */}
      <summary title="Share this page">
        <span aria-hidden="true">↗</span>
        <span className="label">{label}</span>
      </summary>

      <div className="share-panel">
        <input
          type="text"
          className="share-url"
          value={url}
          readOnly
          aria-label="Link to this page"
          // Focus selects the whole thing, which is what makes this usable
          // without the buttons: tab to it, then copy.
          onFocus={(event) => event.currentTarget.select()}
          onClick={(event) => event.currentTarget.select()}
        />

        {mounted && (
          <div className="share-buttons">
            <button type="button" onClick={() => copy(url, 'Link')}>
              Copy link
            </button>

            {text && (
              <button type="button" onClick={() => copy(text, textLabel.replace(/^Copy /, ''))}>
                {textLabel}
              </button>
            )}

            {native && (
              <button type="button" className="share-native" onClick={share}>
                Share…
              </button>
            )}
          </div>
        )}

        {/* Announced rather than only shown: the button's own label does not
            change, so a screen reader would otherwise get no confirmation that
            anything happened. */}
        <p className="share-said" role="status" aria-live="polite">
          {done}
        </p>
      </div>
    </details>
  );
}

/**
 * Put text on the clipboard, by whichever route this browser allows.
 *
 * `navigator.clipboard` needs a secure context and is missing on plenty of
 * in-app browsers; the textarea route is deprecated and still the only thing
 * that works there. Failing both, the caller says so and the field is still on
 * screen to copy by hand.
 *
 * @param {string} value
 * @returns {Promise<boolean>}
 */
async function write(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Denied permission or an insecure origin — fall through and try the old way.
  }

  try {
    const field = document.createElement('textarea');
    field.value = value;
    // Off-screen rather than hidden: a display:none element cannot be selected,
    // and scrolling the page under the reader is its own bug.
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.top = '-1000px';
    field.style.opacity = '0';
    document.body.append(field);
    field.select();
    const ok = document.execCommand('copy');
    field.remove();
    return ok;
  } catch {
    return false;
  }
}
