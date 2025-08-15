// --- Config ---
const VERSION = 'v4';                       // súbelo en cada despliegue
const CACHE_NAME = `acustic-${VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// --- Install: precarga del shell ---
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

// --- Activate: limpia caches antiguas + Navigation Preload ---
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== CACHE_NAME ? caches.delete(k) : null)));
    if ('navigationPreload' in self.registration) {
      try { await self.registration.navigationPreload.enable(); } catch {}
    }
  })());
  self.clients.claim();
});

// --- Fetch strategies ---
// - Navegación (HTML): network-first (usa navigation preload si existe) + fallback a index (offline)
// - Assets del shell (ASSETS): cache-first
// - Otros mismos-origen: stale-while-revalidate
// - audio/video: no se cachean
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  if (request.destination === 'audio' || request.destination === 'video') return;

  // Navegación (PWA/SPA)
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const preload = await event.preloadResponse; // puede ser null
        if (preload) {
          const cache = await caches.open(CACHE_NAME);
          cache.put('./index.html', preload.clone());
          return preload;
        }
        const fresh = await fetch(request, { cache: 'no-store' });
        const cache = await caches.open(CACHE_NAME);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match('./index.html');
        return cached || Response.error();
      }
    })());
    return;
  }

  if (!sameOrigin) return; // Ignora terceros

  // Shell: cache-first
  const isPreCached = ASSETS.some(asset => url.pathname.endsWith(asset.replace('./','/')));
  if (isPreCached) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
    return;
  }

  // Resto: stale-while-revalidate
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    const network = fetch(request).then(res => {
      if (res && res.status === 200 && res.type === 'basic') cache.put(request, res.clone());
      return res;
    }).catch(() => null);
    return cached || network || new Response('', { status: 504 });
  })());
});

// Permite forzar actualización desde la app
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// Recarga amable cuando el nuevo SW toma control
self.addEventListener('controllerchange', () => {
  if (self.___reloading) return;
  self.___reloading = true;
  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    for (const client of clients) client.postMessage({ type: 'RELOAD_ONCE' });
  });
});