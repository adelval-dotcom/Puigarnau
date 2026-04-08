// ============================================================
// CASA MONITOR — SERVICE WORKER
// Mantiene conexión MQTT a HiveMQ en background.
// Muestra notificaciones del sistema aunque la app esté cerrada.
//
// Funcionamiento en Android:
//   - App abierta:     UI + SW conectados (doble conexión, dedup)
//   - App minimizada:  SW mantiene conexión, notificaciones activas
//   - App cerrada:     SW sigue activo si Chrome no está optimizado
//   - Doze mode:       Chrome puede matar el SW (ver instrucciones)
// ============================================================

// Cargar MQTT.js desde CDN (importScripts funciona en SW)
try {
  importScripts('https://unpkg.com/mqtt@5.3.4/dist/mqtt.min.js');
} catch(e) {
  console.error('[SW] Error cargando MQTT.js:', e);
}

const SW_VERSION   = 'casa-monitor-v3';
const TOPIC_EVENTO = 'casa/puerta/evento';
const TOPIC_STATUS = 'casa/centralita/status';

// Estado interno del SW
let mqttClient  = null;
let credentials = null;
let connected   = false;
let lastSeq     = -1;      // Deduplicación de mensajes
let reconnTimer = null;

// ── Ciclo de vida del SW ──────────────────────────────────

self.addEventListener('install', event => {
  console.log('[SW] Instalado', SW_VERSION);
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  console.log('[SW] Activado', SW_VERSION);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SW_VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .then(() => notificarClientes({type: 'SW_READY'}))
  );
});

// ── Mensajes desde la app principal ──────────────────────

self.addEventListener('message', event => {
  const msg = event.data;
  if (!msg) return;

  switch(msg.type) {
    case 'INIT':
      // Credenciales enviadas desde la app
      credentials = { host: msg.host, port: msg.port,
                      user: msg.user, pass: msg.pass };
      console.log('[SW] Credenciales recibidas, conectando MQTT...');
      mqttConectar();
      break;

    case 'PING':
      event.source?.postMessage({type: 'PONG'});
      break;
  }
});

// ── Conexión MQTT en background ───────────────────────────

function mqttConectar() {
  if (!credentials) return;
  if (mqttClient) {
    try { mqttClient.end(true); } catch(e){}
    mqttClient = null;
  }
  clearTimeout(reconnTimer);

  const { host, port, user, pass } = credentials;
  const url = `wss://${host}:${port}/mqtt`;
  const clientId = 'sw_bg_' + Math.random().toString(16).slice(2, 10);

  console.log('[SW] Conectando a', url);

  try {
    mqttClient = mqtt.connect(url, {
      clientId,
      username: user,
      password: pass,
      clean:    true,
      // Keepalive cada 30s — mantiene el WebSocket vivo
      // lo que a su vez mantiene el SW vivo en Android/Chrome
      keepalive: 30,
      reconnectPeriod: 5000,
      connectTimeout: 15000,
      rejectUnauthorized: false,
    });
  } catch(e) {
    console.error('[SW] Error creando cliente MQTT:', e);
    return;
  }

  mqttClient.on('connect', () => {
    connected = true;
    console.log('[SW] MQTT conectado');
    mqttClient.subscribe([TOPIC_EVENTO, TOPIC_STATUS], { qos: 1 });
    notificarClientes({ type: 'SW_STATUS', status: 'connected' });
  });

  mqttClient.on('message', (topic, payload) => {
    try {
      const data = JSON.parse(payload.toString());
      manejarMensaje(topic, data);
    } catch(e) {
      console.error('[SW] JSON error:', e);
    }
  });

  mqttClient.on('offline', () => {
    connected = false;
    console.log('[SW] MQTT offline');
    notificarClientes({ type: 'SW_STATUS', status: 'offline' });
  });

  mqttClient.on('reconnect', () => {
    console.log('[SW] MQTT reconectando...');
  });

  mqttClient.on('error', err => {
    console.error('[SW] MQTT error:', err.message);
  });

  // Keepalive del SW: hacer algo cada 25s para que Chrome
  // no cierre el service worker por inactividad
  setInterval(() => {
    if (mqttClient && connected) {
      // El keepalive de MQTT ya mantiene el WS vivo,
      // pero registramos actividad explícita para Chrome
      console.log('[SW] keepalive — connected:', connected);
    }
  }, 25000);
}

// ── Procesar mensaje recibido ─────────────────────────────

function manejarMensaje(topic, data) {
  if (topic === TOPIC_STATUS) {
    console.log('[SW] Centralita online');
    return;
  }

  const { tipo, nodo, rssi, bat, seq } = data;

  // Ignorar heartbeats
  if (tipo === 'HEARTBEAT') return;

  // Deduplicar (el nodo puerta envía 3 copias del mismo seq)
  if (seq !== undefined && seq === lastSeq) {
    console.log('[SW] Duplicado seq=' + seq + ' ignorado');
    return;
  }
  if (seq !== undefined) lastSeq = seq;

  console.log('[SW] Evento:', tipo, 'de', nodo);

  // Reenviar a la app si está abierta en primer plano
  notificarClientes({ type: 'EVENTO', payload: data });

  // Verificar si la app está activa y visible
  self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(clients => {
      const appActiva = clients.some(c => c.visibilityState === 'visible');

      // Mostrar notificación del sistema si:
      // - App está cerrada/minimizada, O
      // - App visible pero queremos notificación igualmente (timbre)
      const mostrar = !appActiva || tipo === 'TIMBRE';

      if (mostrar) {
        mostrarNotificacion(tipo, nodo, rssi, bat);
      }
    });
}

// ── Notificación del sistema ──────────────────────────────

const TIPOS = {
  TIMBRE:   { icon: '🔔', title: 'Timbre',     vibrate: [200,100,200,100,400] },
  PIR:      { icon: '👤', title: 'Presencia',  vibrate: [150, 80, 150] },
  VEHICULO: { icon: '🚗', title: 'Vehículo',   vibrate: [150, 80, 150] },
  BOOT:     { icon: '🔌', title: 'Nodo activo',vibrate: [60] },
};

function mostrarNotificacion(tipo, nodo, rssi, bat) {
  const info = TIPOS[tipo] || { icon: '📡', title: tipo, vibrate: [100] };
  const hora = new Date().toLocaleTimeString('es', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  const options = {
    body:      `${nodo}  ·  RSSI ${rssi}dBm  ·  Batería ${bat}%\n${hora}`,
    icon:      svgIcon(info.icon),
    badge:     svgIcon('🏠'),
    tag:       'casa-evento',    // Una sola notificación (se reemplaza)
    renotify:  true,             // Vibrar aunque sea el mismo tag
    vibrate:   info.vibrate,
    silent:    false,
    // Datos para cuando el usuario toca la notificación
    data: { tipo, nodo, url: self.registration.scope },
    // Android: mostrar siempre aunque la app esté en primer plano
    requireInteraction: tipo === 'TIMBRE',
  };

  // waitUntil mantiene el SW vivo mientras muestra la notificación
  return self.registration.showNotification(
    `${info.icon} ${info.title}`,
    options
  );
}

function svgIcon(emoji) {
  return `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 192 192'><rect width='192' height='192' rx='40' fill='%230a0c14'/><text y='138' font-size='110' text-anchor='middle' x='96'>${encodeURIComponent(emoji)}</text></svg>`;
}

// ── Tap en notificación → abrir/enfocar la app ────────────

self.addEventListener('notificationclick', event => {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        // Si la app ya está abierta, enfocarla
        for (const client of clients) {
          if (client.url.includes(self.registration.scope)) {
            return client.focus();
          }
        }
        // Si no, abrir una pestaña nueva
        return self.clients.openWindow(self.registration.scope);
      })
  );
});

// ── Fetch handler (offline básico) ───────────────────────

self.addEventListener('fetch', event => {
  // Solo cachear recursos propios, no CDN
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(event.request)
      .then(cached => cached || fetch(event.request)
        .then(response => {
          // Guardar en caché para offline
          const clone = response.clone();
          caches.open(SW_VERSION).then(c => c.put(event.request, clone));
          return response;
        })
      )
      .catch(() => {
        // Fallback offline: devolver index.html desde caché
        return caches.match('./index.html');
      })
  );
});

// ── Utilidades ────────────────────────────────────────────

function notificarClientes(mensaje) {
  self.clients.matchAll({ includeUncontrolled: true })
    .then(clients => clients.forEach(c => {
      try { c.postMessage(mensaje); } catch(e){}
    }));
}
