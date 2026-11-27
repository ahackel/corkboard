// Offline copy: network first (so a new deploy is never shadowed), the last good response when offline.
const KEPT = 'corkboard-v1';

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }
  event.respondWith((async () => {
    const kept = await caches.open(KEPT);
    try {
      const fresh = await fetch(request);
      if (fresh.ok) {
        await kept.put(request, fresh.clone());
      }
      return fresh;
    } catch (offline) {
      // the page is the same file whatever its query string says
      const copy = await kept.match(request, { ignoreSearch: request.mode === 'navigate' });
      if (copy) {
        return copy;
      }
      throw offline;
    }
  })());
});
