/* sw.js – offline-first pro app shell + průběžné aktualizace (stale-while-revalidate)
   - Offline: vše potřebné je v precache (ASSETS) + navigace padá na cached index.html
   - Update: pro stejné origin soubory vracíme cache hned, ale na pozadí dotahujeme novou verzi a ukládáme do cache.
   - UI může vynutit okamžitou aktivaci přes message {type:'SKIP_WAITING'}.
*/
const CACHE_PREFIX = "noise-pwa-";
const CACHE_NAME = "noise-pwa-v30-android-media-controls";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./media-session.js",
  "./noise-worklet.js",
  "./manifest.webmanifest",
  "./waterfall-real.mp3",
  "./sea-real.mp3",
  "./wind-real.mp3",
  "./rain-real.mp3",
  "./icons/icon.svg",
  "./icons/maskable.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-192.png",
  "./icons/maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(ASSETS);
  })());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
        .map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

async function cachePut(request, response) {
  if (!response || response.status !== 200) return;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        event.waitUntil(cachePut("./index.html", fresh.clone()));
        return fresh;
      } catch (e) {
        const cached = await caches.match("./index.html");
        return cached || Response.error();
      }
    })());
    return;
  }

  if (sameOrigin) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      const fetchPromise = fetch(req).then((fresh) => {
        event.waitUntil(cachePut(req, fresh.clone()));
        return fresh;
      }).catch(() => null);

      return cached || (await fetchPromise) || Response.error();
    })());
    return;
  }
});