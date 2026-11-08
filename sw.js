const CACHE = "invicta-app-v6";
const OFFLINE = "/offline.html";
const SHELL = [OFFLINE, "/conta.html", "/hosting.js", "/styles.css", "/app.css", "/storefront.css", "/client/api.js", "/client/pwa.js", "/client/account.js", "/client/checkout.js", "/vendor/qrcode.mjs", "/assets/app-icon.svg"];
self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("invicta-app-") && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
    if (event.request.mode === "navigate") {
        const key = url.origin + url.pathname;
        event.respondWith(fetch(event.request).then(async (response) => {
            if (response.ok) { const cache = await caches.open(CACHE); await cache.put(key, response.clone()); }
            return response;
        }).catch(async () => (await caches.match(key)) || caches.match(OFFLINE)));
    } else if (/\.(css|m?js|woff2|svg|webp|png)$/.test(url.pathname)) {
        event.respondWith(fetch(event.request).then(async (response) => {
            if (response.ok) { const cache = await caches.open(CACHE); await cache.put(event.request, response.clone()); }
            return response;
        }).catch(() => caches.match(event.request)));
    }
});
self.addEventListener("push", (event) => {
    let payload;
    try { payload = event.data.json(); } catch { return; }
    event.waitUntil(self.registration.showNotification(payload.title || "Invicta", {
        body: payload.body, icon: "/assets/app-icon-192.png", badge: "/assets/app-icon-192.png",
        tag: payload.tag, data: { url: payload.url || "/conta.html" }
    }));
});
self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    let target = new URL(event.notification.data?.url || "/conta.html", self.location.origin);
    if (target.origin !== self.location.origin) target = new URL("/conta.html", self.location.origin);
    event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
        for (const client of clients) {
            if ("focus" in client) { await client.navigate(target.href); return client.focus(); }
        }
        return self.clients.openWindow(target.href);
    }));
});
