const CACHE_NAME = 'flame-freefall-v3';
const ASSETS = [
  '/',
  '/manifest.json',
  '/css/styles.css',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/js/vendor/chart.umd.min.js',
  '/js/api.js',
  '/js/app.js',
  '/js/cabin.js',
  '/js/chat.js',
  '/js/dashboard.js',
  '/js/explorer.js',
  '/js/flame-physics.js',
  '/js/flame-shader.js',
  '/js/flame-twin.js',
  '/js/graph.js',
  '/js/ranking.js',
  '/js/resources.js',
  '/js/state.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Network-first for API requests, falling back to cache if offline
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request)
        .then((resp) => resp)
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first with background network refresh for static app shell assets
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((resp) => {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return resp;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
