// sw.js — Service worker: cache básico para funcionar sin conexión (app shell).
const CACHE = "inv-vehiculos-v41";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/styles.css",
  "./js/app.js",
  "./js/vin.js",
  "./js/wmi.js",
  "./js/geo.js",
  "./js/stages.js",
  "./js/scanner.js",
  "./js/ocr.js",
  "./js/vinapi.js",
  "./js/storage.js",
  "./js/agencies.js",
  "./js/events.js",
  "./js/inventory.js",
  "./js/map.js",
  "./js/reports.js",
  "./js/ui.js",
  "./js/auth.js",
  "./js/users.js",
  "./js/audit.js",
  "./js/label.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  // Solo GET del mismo origen; el resto (CDN, tiles) pasa a la red directamente.
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  // Estrategia NETWORK-FIRST: siempre intentamos la versión más reciente de la red
  // y solo usamos la caché como respaldo si no hay conexión. Así el HTML/JS/CSS se
  // actualizan solos (evita servir versiones viejas mezcladas) y sigue funcionando offline.
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req))
  );
});
