// Casa Monitor — Service Worker v5
// Gestiona push notifications nativas via Web Push API
const VER = 'casa-v5';
const CACHE = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VER).then(c => c.addAll(CACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k=>k!==VER).map(k=>caches.delete(k))))
    .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (!e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    caches.match(e.request)
      .then(c => c || fetch(e.request).then(r => {
        const clone = r.clone();
        caches.open(VER).then(c => c.put(e.request, clone));
        return r;
      }))
      .catch(() => caches.match('./index.html'))
  );
});

// ── Push event — recibido desde Cloudflare Worker via FCM ─
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data?.json() || {}; } catch(_) { data = { title: 'Casa Monitor', body: e.data?.text() || '' }; }

  const options = {
    body:      data.body  || 'Nuevo evento',
    icon:      './icon-192.png',
    badge:     './icon-192.png',
    tag:       'casa-evento',
    renotify:  true,
    silent:    false,
    vibrate:   data.tipo === 'TIMBRE' ? [200,100,200,100,400] : [150,80,150],
    data:      { url: self.registration.scope, tipo: data.tipo },
    requireInteraction: data.tipo === 'TIMBRE',
    actions: data.tipo === 'TIMBRE' ? [
      { action: 'open', title: 'Abrir app' }
    ] : [],
  };

  e.waitUntil(self.registration.showNotification(data.title || 'Casa Monitor', options));
});

// ── Tap en notificación ────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      for (const c of cs) if (c.url.includes(self.registration.scope)) return c.focus();
      return self.clients.openWindow(self.registration.scope);
    })
  );
});
