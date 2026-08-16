'use client';

import { useState } from 'react';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';

/**
 * The two passkey ceremonies.
 *
 * The only client-side JavaScript on the site, and it has to be: WebAuthn is a
 * browser API and there is no server-rendered equivalent. Everything else —
 * signing in by link, following a blog — is a plain form, so a reader with
 * JavaScript off loses passkeys and nothing else.
 */

/**
 * Add a passkey to the signed-in account.
 *
 * @param {{ label?: string }} props
 */
export function AddPasskey({ label = 'Add a passkey' }) {
  const [state, setState] = useState({ busy: false, error: null });

  const run = async () => {
    setState({ busy: true, error: null });

    try {
      const optionsRes = await fetch('/api/auth/passkey/register-options', { method: 'POST' });
      if (!optionsRes.ok) throw new Error('Could not start. Try signing in again.');
      const { options, challengeId } = await optionsRes.json();

      const response = await startRegistration({ optionsJSON: options });

      const verifyRes = await fetch('/api/auth/passkey/register-verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId, response }),
      });

      if (!verifyRes.ok) {
        const body = await verifyRes.json().catch(() => ({}));
        throw new Error(friendly(body.error));
      }

      // A full reload rather than local state: the page lists the account's
      // passkeys server-side, and this is the cheapest way to keep that honest.
      window.location.reload();
    } catch (err) {
      setState({ busy: false, error: message(err) });
    }
  };

  return (
    <>
      <button type="button" onClick={run} disabled={state.busy}>
        {state.busy ? 'Waiting for your device…' : label}
      </button>
      {state.error && <p className="notice">{state.error}</p>}
    </>
  );
}

/**
 * Sign in with an existing passkey.
 *
 * @param {{ next?: string }} props
 */
export function PasskeySignIn({ next = '/account' }) {
  const [state, setState] = useState({ busy: false, error: null });

  const run = async () => {
    setState({ busy: true, error: null });

    try {
      const optionsRes = await fetch('/api/auth/passkey/login-options', { method: 'POST' });
      if (!optionsRes.ok) throw new Error('Could not start. Try the email link instead.');
      const { options, challengeId } = await optionsRes.json();

      const response = await startAuthentication({ optionsJSON: options });

      const verifyRes = await fetch('/api/auth/passkey/login-verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId, response }),
      });

      if (!verifyRes.ok) throw new Error('That passkey was not recognised.');

      window.location.href = next;
    } catch (err) {
      setState({ busy: false, error: message(err) });
    }
  };

  return (
    <>
      <button type="button" onClick={run} disabled={state.busy}>
        {state.busy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
      </button>
      {state.error && <p className="notice">{state.error}</p>}
    </>
  );
}

/**
 * Turn a thrown value into something worth showing.
 *
 * A cancelled ceremony throws too, and telling someone "an error occurred"
 * because they dismissed a dialog they chose to dismiss is noise.
 *
 * @param {unknown} err
 * @returns {string|null}
 */
function message(err) {
  const name = err?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return null;
  if (name === 'InvalidStateError') return 'That passkey is already registered to this account.';
  return String(err?.message ?? err);
}

/**
 * @param {string|undefined} code
 * @returns {string}
 */
function friendly(code) {
  if (code === 'challenge-expired') return 'That took too long — try again.';
  if (code === 'sign-in-required') return 'Your session ended. Sign in again.';
  return 'That passkey could not be registered.';
}
