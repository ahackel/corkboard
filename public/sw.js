// Corkboard without a network. The app is ONE html file (plus its icons and manifest), so being offline
// is a matter of keeping the last copy that loaded: every same-origin GET is asked of the network first —
// a new deploy is picked up on the next visit, never a stale build while online — and answered from the
// copy kept here only when the network does not answer. Notes are not involved: they never leave the
// device (src/store/).
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
