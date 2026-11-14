/* Service worker: makes the wetland form work offline.
   Bump VERSION whenever index.html or other app files change so phones pick up the update. */
const VERSION = "v7";
const APP_CACHE = "wetland-app-" + VERSION;
const FONT_CACHE = "wetland-fonts";
const TILE_CACHE = "wetland-basemap";
const TILE_HOSTS = ["basemap.nationalmap.gov"];
const TILE_LIMIT = 3000; // basemap tiles kept for offline use (roughly 30-60 MB); oldest are dropped first
const APP_FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./species.json",
  "./lib/maplibre-gl.js",
  "./lib/maplibre-gl.css",
  "./lib/proj4.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(APP_CACHE).then(c => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith("wetland-app-") && k !== APP_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Google Fonts: cache-first so the typeface keeps working offline after the first online visit.
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(
      caches.open(FONT_CACHE).then(async c => {
        const hit = await c.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok || res.type === "opaque") c.put(req, res.clone());
          return res;
        } catch (err) {
          return new Response("", { status: 503 });
        }
      })
    );
    return;
  }

  // USGS basemap tiles: cache-first (downloaded offline areas or tiles viewed before), so they show offline.
  // Viewed tiles are capped at TILE_LIMIT; tiles in downloaded areas are kept until the area is deleted.
  if (TILE_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.open(TILE_CACHE).then(async c => {
        const hit = await caches.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok) {
            await c.put(req, res.clone());
            if (Math.random() < 0.05) {  // trim now and then, not on every tile
              const keys = await c.keys();
              for (const k of keys.slice(0, Math.max(0, keys.length - TILE_LIMIT))) await c.delete(k);
            }
          }
          return res;
        } catch (err) {
          return new Response("", { status: 504 });
        }
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Soil and NWI data are large; the page downloads them into their own caches and reads them from there.
  if (url.pathname.includes("/soils/") || url.pathname.includes("/nwi/")) return;

  // Page navigations: serve the cached app shell, refresh it in the background when online.
  if (req.mode === "navigate") {
    e.respondWith(
      caches.open(APP_CACHE).then(async c => {
        const cached = await c.match("./index.html");
        const network = fetch(req).then(res => {
          if (res.ok) c.put("./index.html", res.clone());
          return res;
        }).catch(() => null);
        return cached || (await network) || new Response("Offline", { status: 503 });
      })
    );
    return;
  }

  // Species list: use the saved copy right away, and fetch a fresh one in the background so a
  // rebuilt species.json reaches phones on the next launch without bumping VERSION.
  if (url.pathname.endsWith("/species.json")) {
    e.respondWith(
      caches.open(APP_CACHE).then(async c => {
        const cached = await c.match("./species.json");
        const network = fetch(req).then(res => {
          if (res.ok) c.put("./species.json", res.clone());
          return res;
        }).catch(() => null);
        if (cached) { e.waitUntil(network); return cached; }
        return (await network) || new Response("{}", { status: 503 });
      })
    );
    return;
  }

  // Other same-origin files: cache-first, fall back to network.
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(APP_CACHE).then(c => c.put(req, copy)); }
      return res;
    }))
  );
});
