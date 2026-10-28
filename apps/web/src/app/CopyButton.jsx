'use client';

import { useState } from 'react';

/**
 * Copies the text of the element `target` names. Progressive: without script
 * the button is never rendered usefully, and the snippet above it is still
 * plain text in a <pre> to select by hand.
 *
 * @param {{ target: string, label?: string }} props
 */
export default function CopyButton({ target, label = 'Copy' }) {
  const [state, setState] = useState('idle');

  async function copy() {
    const text = document.getElementById(target)?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(text);
      setState('done');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 2000);
  }

  return (
    <button type="button" className="copy-button" onClick={copy} aria-live="polite">
      {state === 'done' ? 'Copied' : state === 'failed' ? 'Select and copy' : label}
    </button>
  );
}
