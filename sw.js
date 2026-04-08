// Casa Monitor — Service Worker v4
// Solo offline caching. Las push notifications las gestiona ntfy.sh.
const VER = 'casa-v4';
const CACHE = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VER).then(c => c.addAll(CACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k!==VER).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (!e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached ||
      fetch(e.request).then(r => {
        const clone = r.clone();
        caches.open(VER).then(c => c.put(e.request, clone));
        return r;
      })
    ).catch(() => caches.match('./index.html'))
  );
});

self.addEventListener('push', e => {
  // Por si ntfy.sh envía push directo en el futuro
  const data = e.data?.json() || {title:'Casa Monitor', body:'Nuevo evento'};
  e.waitUntil(self.registration.showNotification(data.title || 'Casa Monitor', {
    body: data.body || data.message || '',
    icon: './icon-192.png', badge: './icon-192.png',
    tag: 'casa-evento', renotify: true, silent: false,
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs => {
      for (const c of cs) if (c.url.includes(self.registration.scope)) return c.focus();
      return self.clients.openWindow(self.registration.scope);
    })
  );
});
