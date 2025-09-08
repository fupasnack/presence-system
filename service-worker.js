// service-worker.js — cache dasar untuk shell offline
const CACHE = "presensi-fupa-v4";
const ASSETS = [
  "./",
  "./index.html",
  "./karyawan.html", 
  "./admin.html",
  "./app.js",
  "./manifest.webmanifest",
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap",
  "https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:FILL,GRAD@1,200",
  "https://cdn.jsdelivr.net/gh/google/material-design-icons@master/sprites/svg-sprite/svg-sprite-action.svg",
  "https://api.iconify.design/material-symbols/workspace-premium.svg?color=%23ffb300"
];

self.addEventListener("install", (e) => {
  console.log("[Service Worker] Install");
  e.waitUntil(
    caches.open(CACHE)
      .then(cache => {
        console.log("[Service Worker] Caching all: app shell and content");
        return cache.addAll(ASSETS);
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  console.log("[Service Worker] Activate");
  e.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    }).then(() => {
      console.log("[Service Worker] Claiming clients");
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", (e) => {
  // Skip cross-origin requests
  if (!e.request.url.startsWith(self.location.origin) && !e.request.url.includes('fonts.googleapis.com') && !e.request.url.includes('cdn.jsdelivr.net') && !e.request.url.includes('api.iconify.design')) {
    return;
  }

  // For API calls and dynamic data, use network first
  if (e.request.url.includes('/api/') || e.request.url.includes('firestore.googleapis.com') || e.request.url.includes('cloudinary.com')) {
    e.respondWith(
      fetch(e.request)
        .then(response => {
          // Optionally cache API responses if needed
          return response;
        })
        .catch(() => {
          // Return offline fallback for API calls if needed
          return new Response(JSON.stringify({ error: "You are offline" }), {
            headers: { 'Content-Type': 'application/json' }
          });
        })
    );
    return;
  }

  // For all other requests, use cache first with network fallback
  e.respondWith(
    caches.match(e.request)
      .then(cachedResponse => {
        if (cachedResponse) {
          console.log("[Service Worker] Serving from cache:", e.request.url);
          return cachedResponse;
        }

        return fetch(e.request)
          .then(response => {
            // Check if we received a valid response
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }

            // Clone the response
            const responseToCache = response.clone();

            caches.open(CACHE)
              .then(cache => {
                cache.put(e.request, responseToCache);
              });

            return response;
          })
          .catch(() => {
            // For HTML pages, return the offline page
            if (e.request.headers.get('accept').includes('text/html')) {
              return caches.match('./index.html');
            }
            
            // For other file types, return appropriate fallback
            return new Response('Offline content not available');
          });
      })
  );
});

// Background sync for offline data submission
self.addEventListener('sync', (event) => {
  if (event.tag === 'background-sync') {
    console.log('[Service Worker] Background sync triggered');
    event.waitUntil(doBackgroundSync());
  }
});

async function doBackgroundSync() {
  // Implement background sync logic here for offline data submission
  // This would check for any pending presensi data and try to submit it
  console.log('[Service Worker] Doing background sync');
}

// Push notifications
self.addEventListener('push', (event) => {
  if (event.data) {
    const data = event.data.json();
    const options = {
      body: data.body,
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-72x72.png',
      vibrate: [100, 50, 100],
      data: {
        dateOfArrival: Date.now(),
        primaryKey: 1
      }
    };
    
    event.waitUntil(
      self.registration.showNotification(data.title, options)
    );
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  
  event.waitUntil(
    clients.openWindow('/')
  );
});