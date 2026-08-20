// Service worker for the Cloud Play PWA.
//
// Two reasons this exists:
//   1) Chrome requires a service worker (or at least an SW registration)
//      before it shows the "Install app" button for a website.
//   2) Caches the launcher's static assets so the UI shell loads fast on
//      slow networks. Media and API calls always go to the network.
//
// The launcher document is network-first. Stable JS/CSS/images and the
// stream viewer shell are stale-while-revalidate so weak links can draw the
// interface immediately from cache.

const CACHE = 'cloud-play-v4';
const PRECACHE = [
  '/',
  '/index.html',
  '/css/innerPersonal.css',
  '/css/wallpapers.css',
  '/css/refresh.css',
  '/js/app.js',
  '/js/wallpapers.js',
  '/stream.html',
  '/js/stream-client.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache or interfere with:
  //   - cross-origin requests (Spotify CDN, etc.)
  //   - API endpoints (always fresh)
  //   - the streaming WebSocket / WebRTC signaling (under /api/)
  //   - the /host proxy (Apollo's web UI, never cache)
  //   - any non-GET request
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/'))    return;
  if (url.pathname.startsWith('/host/'))   return;
  if (event.request.method !== 'GET')      return;

  const cacheRequest = url.pathname === '/stream.html'
    ? new Request(new URL('/stream.html', self.location.origin).href)
    : event.request;
  const fetchAndCache = () => fetch(event.request).then((res) => {
    if (res && res.status === 200 && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(cacheRequest, copy)).catch(() => {});
    }
    return res;
  });

  const launcherNavigation = event.request.mode === 'navigate' && url.pathname !== '/stream.html';
  if (launcherNavigation) {
    event.respondWith(fetchAndCache().catch(() => caches.match(cacheRequest)));
    return;
  }

  event.respondWith(
    caches.match(cacheRequest).then((cached) => {
      const refresh = fetchAndCache().catch(() => null);
      if (cached) {
        event.waitUntil(refresh);
        return cached;
      }
      return refresh.then((res) => res || Response.error());
    })
  );
});
