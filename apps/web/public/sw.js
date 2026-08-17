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
// not this version, which is what evicts the old SVG icon and the manifest that
// pointed at it from clients that already installed them.
const VERSION = 'v2';
const SHELL = `shell-${VERSION}`;
const ASSETS = `assets-${VERSION}`;

const OFFLINE_URL = '/offline';
// The logo is in the shell because the masthead is on the offline page too, and
// a brand that only appears once you are back online is worse than none.
// Both logos, because which one the masthead asks for is decided by the
// reader's colour scheme and the install has no way to know which that is.
const SHELL_URLS = [
  OFFLINE_URL,
  '/logo.png',
  '/logo-dark.png',
  '/icon-192.png',
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
