/* sw.js – offline-first pro app shell + průběžné aktualizace (stale-while-revalidate)
   - Offline: vše potřebné je v precache (ASSETS) + navigace padá na cached index.html
   - Update: pro stejné origin soubory vracíme cache hned, ale na pozadí dotahujeme novou verzi a ukládáme do cache.
   - UI může vynutit okamžitou aktivaci přes message {type:'SKIP_WAITING'}.
*/
const CACHE_NAME = "noise-pwa-v27";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./noise-worklet.js",
  "./manifest.webmanifest",
  "./waterfall-real.mp3",
  "./sea-real.mp3",
  "./wind-real.mp3",
  "./rain-real.mp3",
  "./icons/icon.svg",
  "./icons/maskable.svg"
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
    await Promise.all(keys.map(k => (k !== CACHE_NAME) ? caches.delete(k) : null));
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

  // Jen GET
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Navigace (index.html jako app-shell). Chceme aktualizace => network-first, offline => cache.
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        event.waitUntil(cachePut("./index.html", fresh.clone()));
        return fresh;
      } catch (e) {
        // offline fallback
        const cached = await caches.match("./index.html");
        return cached || Response.error();
      }
    })());
    return;
  }

  // Pro stejné origin soubory: stale-while-revalidate
  if (sameOrigin) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      const fetchPromise = fetch(req).then((fresh) => {
        event.waitUntil(cachePut(req, fresh.clone()));
        return fresh;
      }).catch(() => null);

      // vrať cache hned, ale aktualizuj na pozadí
      return cached || (await fetchPromise) || Response.error();
    })());
    return;
  }

  // Cizí origin: necháme normálně síť (ať zbytečně necachujeme)
});
