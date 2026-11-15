const CACHE_NAME = 'ignis-v9';
const IMMUTABLE_ASSETS = [
  '/icons/ignis-logo-256.png',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/js/vendor/chart.umd.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(IMMUTABLE_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      const stale = keys.filter((key) => key !== CACHE_NAME);
      return Promise.all(stale.map((key) => caches.delete(key)))
        .then(() => self.clients.claim())
        .then(() => {
          if (stale.length === 0) return;
          return self.clients
            .matchAll({ type: 'window' })
            .then((clients) =>
              Promise.all(clients.map((c) => c.navigate(c.url).catch(() => {})))
            );
        });
    })
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Only cache immutable binary/vendor assets (PDFs, icons, Chart.js).
  // Never intercept HTML, JS, CSS, or API calls so updates always load immediately.
  const isImmutable =
    url.pathname.startsWith('/papers/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/js/vendor/');

  if (!isImmutable) return;

  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request).then((resp) => {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return resp;
        })
    )
  );
});
