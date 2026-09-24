'use client';

import { useEffect, useState } from 'react';
import {
  PushError,
  getSubscription,
  getVapidPublicKey,
  pushSupport,
  subscribe as subscribeBrowser,
} from '@profullstack/notifications/client';

/**
 * Turning on alerts in this browser.
 *
 * The only control on the site that cannot be a plain form. A push subscription
 * is minted by the browser against the push service it trusts, and the result —
 * an endpoint and two encryption keys — exists only in JavaScript. So this is a
 * button that does four things in order, each of which can fail on its own:
 * ask permission, fetch the server's key, subscribe, and tell the server. The
 * first three are `@profullstack/notifications/client`, shared with every other
 * Profullstack app.
 *
 * It reports where it got to rather than succeeding or failing, because the
 * failures are things a reader can act on. "Blocked" means the permission was
 * refused and the fix is in browser settings, not here — a button that just said
 * "failed" would have them clicking it forever.
 */
export default function PushToggle() {
  /** @type {['loading'|'unsupported'|'unconfigured'|'off'|'on'|'blocked'|'error', Function]} */
  const [state, setState] = useState('loading');
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState('');

  useEffect(() => {
    let live = true;

    (async () => {
      // Why not, in words, rather than a flat "not supported": plain http, an
      // iPhone that needs the site on its Home Screen first, notifications
      // blocked in settings. Each has a different fix and the reader is told it.
      const support = pushSupport();
      if (!support.supported) {
        if (!live) return;
        if (support.reason === 'denied') setState('blocked');
        else {
          setDetail(support.message ?? '');
          setState('unsupported');
        }
        return;
      }

      // The deployment may have no VAPID pair, in which case there is nothing to
      // subscribe against and the honest answer is to say so. The key is asked
      // for at run time, never compiled in, so a build without it cannot turn
      // into every browser being told push is unsupported.
      try {
        await getVapidPublicKey();
      } catch {
        if (live) setState('unconfigured');
        return;
      }

      // Whether *this* browser is already subscribed, which is not the same
      // question as whether the account has any browsers attached — the account
      // page lists those, and this button speaks only for the one in front of
      // you.
      const existing = await getSubscription();
      if (live) setState(existing ? 'on' : 'off');
    })().catch(() => {
      if (live) setState('error');
    });

    return () => {
      live = false;
    };
  }, []);

  async function subscribe() {
    setBusy(true);
    setDetail('');

    try {
      // Asks permission, fetches the key, registers /sw.js if nothing has yet
      // (the deferred registration in ServiceWorker.jsx may not have run), and
      // replaces a subscription made under an older key.
      await subscribeBrowser({
        save: async (subscription) => {
          const saved = await fetch('/api/alerts/push', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...subscription, label: browserLabel() }),
          });
          if (!saved.ok) throw new Error(`push: ${saved.status}`);
        },
      });
      setState('on');
    } catch (err) {
      if (err instanceof PushError && err.reason === 'no-server-key') {
        setState('unconfigured');
      } else if (err instanceof PushError && err.reason === 'denied') {
        // Refused outright, or the prompt was dismissed — which leaves the
        // button usable, because the browser will ask again.
        setState(Notification.permission === 'denied' ? 'blocked' : 'off');
      } else if (err instanceof PushError) {
        setDetail(err.message);
        setState('unsupported');
      } else {
        setState('error');
        setDetail(String(err?.message ?? err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function unsubscribe() {
    setBusy(true);

    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const subscription = await reg?.pushManager.getSubscription();

      // The server is told first, and told the endpoint, because after
      // `unsubscribe()` the object is gone and with it the only handle on the
      // row that needs clearing.
      if (subscription) {
        await fetch('/api/alerts/push', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'unsubscribe', endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }

      setState('off');
    } catch (err) {
      setState('error');
      setDetail(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  if (state === 'loading') return <p className="hint">Checking this browser…</p>;

  if (state === 'unsupported') {
    return <p className="hint">{detail || 'This browser cannot receive push notifications.'}</p>;
  }

  if (state === 'unconfigured') {
    return <p className="hint">Browser alerts are not switched on for this deployment.</p>;
  }

  if (state === 'blocked') {
    return (
      <p className="hint">
        This browser is blocking notifications from the site. Allow them in its site settings and
        reload — nothing here can ask again once it has been refused.
      </p>
    );
  }

  return (
    <>
      <button type="button" className={state === 'on' ? 'secondary-button' : ''} onClick={state === 'on' ? unsubscribe : subscribe} disabled={busy}>
        {state === 'on' ? 'Stop alerting this browser' : 'Alert this browser'}
      </button>
      {state === 'error' && (
        <p className="hint">That did not work{detail ? `: ${detail}` : ''}. Try again?</p>
      )}
    </>
  );
}

/**
 * Something to call this browser in the list of attached devices.
 *
 * A guess, and deliberately a coarse one: the user agent is the only thing on
 * offer and parsing it properly is a library. "Chrome on Android" is enough to
 * tell two devices apart, which is all the list is for.
 *
 * @returns {string}
 */
function browserLabel() {
  const ua = navigator.userAgent;
  const browser = /Firefox\//.test(ua)
    ? 'Firefox'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /OPR\//.test(ua)
        ? 'Opera'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';

  const platform = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';

  return platform ? `${browser} on ${platform}` : browser;
}
