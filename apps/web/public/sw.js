/*
 * Service worker.
 *
 * Deliberately conservative. The directory is a live database view, so caching
 * pages aggressively would show people stale listings. The strategy is:
 *
 *   - navigations: network first, fall back to the offline page
 *   - static assets: cache first, they are immutable enough
 *   - API + agent surfaces: never cached, always live
 *
 * Nothing is precached beyond the shell, so a deploy cannot strand a client on
 * an old bundle.
 */

// Bumped with the brand assets: the activate handler drops every cache that is
// not this version, which is what evicts the previous artwork from clients that
// already installed it. The filenames do not change when the art does, so
// without the bump an installed app keeps serving the logo it cached.
//
// v4 adds the push handlers below. A browser that subscribed under v3 keeps its
// subscription — the endpoint belongs to the registration, not to the script —
// but it would go on running the old script, which drops every push on the
// floor, until something evicted it.
//
// v5 is a pure artwork bump: both logos were recut and the home-screen icons
// were redrawn from the current mark, under the names they already had.
//
// v6 drops the dark wordmark: the masthead serves one logo to every palette
// now, so the shell is one URL shorter. Without the bump an install that
// precached the pair under v5 would hold the retired file forever, since
// nothing requests it any more and only the version sweep can evict it.
//
// v7 is a manifest bump: the manifest gained a launch_handler and it is one of
// the shell URLs, so the copy taken at install is now out of date. Nothing
// serves that copy today — the fetch handler below lets .webmanifest fall
// through to the network — but the shell is meant to hold what the site
// currently ships, and the version sweep is the only thing that can replace
// it. The browser reads launch_handler over the network either way, so this
// bump is hygiene rather than the fix.
const VERSION = 'v7';
const SHELL = `shell-${VERSION}`;
const ASSETS = `assets-${VERSION}`;

const OFFLINE_URL = '/offline';
// The logo is in the shell because the masthead is on the offline page too, and
// a brand that only appears once you are back online is worse than none.
// One logo, because the masthead asks for the same file whatever the reader's
// colour scheme is, so there is no second variant for the install to guess at.
// The icon is the one the manifest names, not the root alias beside it: an
// install that precached a different URL than the manifest asks for is an
// install holding two copies of the same drawing.
const SHELL_URLS = [
  OFFLINE_URL,
  '/logo.png',
  '/icons/icon-192x192.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      // Individually, so one 404 does not fail the whole install.
      .then((cache) => Promise.allSettled(SHELL_URLS.map((u) => cache.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Live surfaces: never serve these from cache.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname === '/random' ||
    url.pathname === '/opml' ||
    url.pathname === '/llms.txt' ||
    url.pathname === '/sitemap.xml'
  ) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match(request);
        return cached ?? (await caches.match(OFFLINE_URL)) ?? Response.error();
      }),
    );
    return;
  }

  if (url.pathname.startsWith('/_next/static/') || /\.(svg|png|ico|woff2?|css|js)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(ASSETS).then((c) => c.put(request, copy));
            }
            return res;
          }),
      ),
    );
  }
});

/*
 * ------------------------------------------------------------------- alerts
 *
 * A push arrives whether or not a tab is open, which is the whole point of it
 * and also the reason this code has to be careful: it runs with no page, no
 * DOM, and no second chance.
 *
 * Every browser that delivers a push requires a notification to be shown for
 * it. There is no silent path — a handler that decides there is nothing worth
 * showing gets the "This site has been updated in the background" notice
 * instead, which is worse than anything it could have shown on purpose. So the
 * fallback below is deliberate rather than defensive.
 */

const FALLBACK = {
  title: 'New posts',
  body: 'Something you follow has published.',
  url: '/following',
  tag: 'rssamplifier-alert',
};

self.addEventListener('push', (event) => {
  let payload = FALLBACK;

  try {
    // The sender always encrypts JSON. A body that is not JSON is a push from
    // something else, or a version of the sender this script does not know, and
    // showing the fallback is better than showing nothing.
    payload = { ...FALLBACK, ...(event.data ? event.data.json() : {}) };
  } catch {
    payload = FALLBACK;
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon-192.png',
      // The maskable icon is the one Android shrinks into its status bar; the
      // full one there comes out cropped.
      badge: '/icon-maskable.png',
      // A shared tag makes a second batch replace the first rather than stack
      // on it. Somebody who has not read one notification does not want two.
      tag: payload.tag || FALLBACK.tag,
      // Where the tap goes. Carried in the notification because the click
      // handler below runs in a fresh invocation with none of this in scope.
      data: { url: payload.url || FALLBACK.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || FALLBACK.url, self.location.origin).href;

  event.waitUntil(
    (async () => {
      // Reuse a window on this site if one is open. Opening a third tab of a
      // directory somebody already has open twice is not helpful.
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        // Only if it can: navigate() is refused on a client this worker does
        // not control, and focusing the tab is still better than nothing.
        if ('navigate' in client) await client.navigate(target).catch(() => {});
        return;
      }

      await self.clients.openWindow(target);
    })(),
  );
});

/*
 * A subscription can be rotated by the push service without anybody asking.
 * When that happens the old endpoint stops working and the server holds a row
 * that will fail until it retires itself — so the new one is registered here,
 * from the only context that is told about it.
 *
 * The request is unauthenticated in the sense that matters: a service worker
 * sends the session cookie, so the server knows whose subscription this is
 * without the worker holding any credential of its own.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const fresh = event.newSubscription
        ? event.newSubscription
        : await self.registration.pushManager
            .subscribe(event.oldSubscription?.options ?? { userVisibleOnly: true })
            .catch(() => null);

      if (event.oldSubscription?.endpoint) {
        await post({ action: 'unsubscribe', endpoint: event.oldSubscription.endpoint });
      }

      if (fresh) await post(fresh.toJSON());
    })(),
  );
});

/**
 * @param {object} body
 * @returns {Promise<void>}
 */
async function post(body) {
  await fetch('/api/alerts/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {
    // Nothing here can recover from a failed re-registration, and throwing out
    // of a waitUntil only logs. The next subscribe from the page fixes it.
  });
}
