// Network first so updates show up right away; cached copy only if offline.
// API calls are never cached here (the page keeps its own last-loaded copy for offline viewing).
const CACHE = "wishlist-v52";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png", "/xlsx.js", "/giftcards.js", "/qr.js", "/fonts/fonts.css", "/fonts/figtree-latin-wght-normal.woff2", "/fonts/bricolage-grotesque-latin-standard-normal.woff2", "/theme.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("wishlist-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("/")))
  );
});

// Notifications (sent by src/push.js): { title, body, url, tag, badge? }. Tapping one opens that screen in the app.
// badge: how many new wishes, shown on the home screen icon where the phone supports it.
// The small status bar icon (badge.png) is a white H on transparent, since Android draws it as a silhouette.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() }; }
  const count = typeof d.badge === "number" && "setAppBadge" in self.navigator
    ? (d.badge > 0 ? self.navigator.setAppBadge(d.badge) : self.navigator.clearAppBadge()).catch(() => {})
    : null;
  e.waitUntil(Promise.all([count, self.registration.showNotification(d.title || "Hints", {
    body: d.body || "",
    tag: d.tag || undefined,
    icon: "/icons/icon-192.png",
    badge: "/icons/badge.png",
    data: { url: d.url || "/" },
  })]));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) return win.navigate(url).then((w) => (w || win).focus()).catch(() => win.focus());
    return self.clients.openWindow(url);
  }));
});
