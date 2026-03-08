const CACHE_NAME = 'storytap-v1.1.0';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './quickstories.js'
];

// External resources to cache for offline support
const EXTERNAL_RESOURCES = [
  'https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&family=Crimson+Pro:wght@400;500;600&display=swap'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      console.log('SW: Caching core assets');

      // Cache local assets
      await cache.addAll(ASSETS_TO_CACHE).catch(err => {
        console.warn('SW: Some local assets failed to cache', err);
      });

      // Try to cache external resources (fonts), but don't fail if offline
      for (const url of EXTERNAL_RESOURCES) {
        try {
          await cache.add(url);
        } catch (err) {
          console.warn('SW: External resource failed to cache:', url);
        }
      }
    })
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(keyList.map((key) => {
        if (key !== CACHE_NAME) {
          console.log('SW: Removing old cache', key);
          return caches.delete(key);
        }
      }));
    })
  );
  return self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Skip non-GET requests
  if (e.request.method !== 'GET') return;

  // Skip chrome-extension and other non-http(s) requests
  if (!url.protocol.startsWith('http')) return;

  // Navigation requests: Network first, fall back to cache
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(response => {
          // Clone and cache the response
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(e.request, responseClone);
          });
          return response;
        })
        .catch(async () => {
          const cachedIndex = await caches.match('./index.html');
          if (cachedIndex) return cachedIndex;
          const cachedReq = await caches.match(e.request);
          if (cachedReq) return cachedReq;
          return new Response('Offline', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        })
    );
    return;
  }

  // Font files: Cache first (fonts rarely change)
  if (url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.pathname.endsWith('.woff2') ||
    url.pathname.endsWith('.woff')) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(response => {
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(e.request, responseClone);
            });
          }
          return response;
        });
      })
    );
    return;
  }

  // Model/WASM files (HuggingFace, laurentmazare.github.io): pass through to browser HTTP cache.
  // These are large files (240MB+) — caching them in SW storage causes the entire cache to be
  // wiped on every SW version bump, forcing a full re-download. The browser's own HTTP cache
  // (which respects Cache-Control headers) handles these much better.
  if (url.hostname.includes('huggingface.co') ||
    url.hostname.includes('laurentmazare.github.io')) {
    return; // Let browser handle natively
  }

  // CDN resources (esm.sh, unpkg, etc): Cache first with revalidation
  if (url.hostname.includes('esm.sh') ||
    url.hostname.includes('unpkg.com') ||
    url.hostname.includes('cdn.')) {
    e.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cachedResponse = await cache.match(e.request);

        // Start network fetch in background
        const networkFetch = fetch(e.request).then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            cache.put(e.request, networkResponse.clone());
          }
          return networkResponse;
        }).catch(() => undefined);

        // Return cached if available, else wait for network
        if (cachedResponse) return cachedResponse;
        const net = await networkFetch;
        if (net) return net;
        return new Response('', { status: 504, statusText: 'Gateway Timeout' });
      })
    );
    return;
  }

  // Local assets: Network First (Freshness over speed)
  // This ensures users always get the latest code/stories if online.
  e.respondWith(
    fetch(e.request)
      .then(response => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }

        // Clone and update cache
        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(e.request, responseToCache);
        });

        return response;
      })
      .catch(() => {
        // Network failed, fall back to cache
        return caches.match(e.request);
      })
  );
});
