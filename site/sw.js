// App shell is cache-first (bumped by VERSION); /data is network-first with a
// cache fallback so search still works with bad signal at a show; /api is never cached.
const VERSION = "v2";
const SHELL = ["/", "/index.html", "/css/app.css", "/js/app.js", "/js/forecast.js", "/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open("shell-" + VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k.startsWith("shell-") && k !== "shell-" + VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/data/")) {
    e.respondWith(fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open("data").then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request).then(r => r || Response.error())));
    return;
  }
  // Shell: serve cached, refresh in the background so the next open is current.
  e.respondWith(caches.match(e.request, {ignoreSearch: true}).then(hit => {
    const net = fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open("shell-" + VERSION).then(c => c.put(e.request, copy)); }
      return r;
    });
    return hit || net.catch(() => caches.match("/index.html"));
  }));
});
