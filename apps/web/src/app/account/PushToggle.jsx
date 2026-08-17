'use client';

import { useEffect, useState } from 'react';

/**
 * Turning on alerts in this browser.
 *
 * The only control on the site that cannot be a plain form. A push subscription
 * is minted by the browser against the push service it trusts, and the result —
 * an endpoint and two encryption keys — exists only in JavaScript. So this is a
 * button that does four things in order, each of which can fail on its own:
 * register a service worker, ask permission, subscribe, and tell the server.
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
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        if (live) setState('unsupported');
        return;
      }

      // The deployment may have no VAPID pair, in which case there is nothing to
      // subscribe against and the honest answer is to say so.
      const res = await fetch('/api/alerts/push', { headers: { accept: 'application/json' } });
      const config = await res.json().catch(() => null);
      if (!live) return;
      if (!config?.enabled) {
        setState('unconfigured');
        return;
      }

      if (Notification.permission === 'denied') {
        setState('blocked');
        return;
      }

      // Whether *this* browser is already subscribed, which is not the same
      // question as whether the account has any browsers attached — the account
      // page lists those, and this button speaks only for the one in front of
      // you.
      const reg = await navigator.serviceWorker.getRegistration();
      const existing = await reg?.pushManager.getSubscription();
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
      const config = await (await fetch('/api/alerts/push')).json();
      if (!config?.enabled) {
        setState('unconfigured');
        return;
      }

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'blocked' : 'off');
        return;
      }

      // `register` rather than `getRegistration`: the reader may have arrived,
      // pressed this and never triggered the deferred registration in
      // ServiceWorker.jsx, and `ready` on an unregistered worker never resolves.
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;

      const subscription = await reg.pushManager.subscribe({
        // Non-negotiable on every current browser: a subscription that could
        // deliver silently is not allowed, and asking for one throws.
        userVisibleOnly: true,
        applicationServerKey: decodeKey(config.key),
      });

      const saved = await fetch('/api/alerts/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...subscription.toJSON(), label: browserLabel() }),
      });

      if (!saved.ok) throw new Error(`push: ${saved.status}`);
      setState('on');
    } catch (err) {
      setState('error');
      setDetail(String(err?.message ?? err));
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
    return <p className="hint">This browser cannot receive push notifications.</p>;
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
 * The VAPID public key, as `pushManager.subscribe` wants it.
 *
 * base64url in, raw bytes out. The API takes a BufferSource and rejects the
 * string form, which is the single most common way this call fails.
 *
 * @param {string} key
 * @returns {Uint8Array}
 */
function decodeKey(key) {
  const padded = String(key).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
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
