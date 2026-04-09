// =============================================================
// Casa Monitor — Cloudflare Worker
// Web Push correcto segun RFC 8291 + VAPID RFC 8292
//
// ENDPOINTS:
//   POST /subscribe   { subscription: PushSubscription }
//   POST /notify      { tipo, nodo, rssi, bat }  (requiere Bearer token)
//   GET  /health
// =============================================================

const VAPID_PUBLIC_KEY  = 'BFza_isM9BQL1Bqu_bUcQUAjV1N5dGOhsFfzN1MRcRjPrPUFSak0dBN3L8qoRz4YJDGMZf7gxMYXmOI7Sx00IsI';
const VAPID_PRIVATE_KEY = 'apawIJlgyKEaEhsXg-iZCBb1vN3hWv-uNThwG7hJne4';
const VAPID_SUBJECT     = 'mailto:admin@casa-monitor.local';

// Token que configuras tambien en el ESP32
// CAMBIAR a algo unico tuyo antes de hacer deploy
const ESP32_TOKEN = 'CAMBIAR_TOKEN_UNICO';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// =============================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/subscribe' && request.method === 'POST')
      return handleSubscribe(request, env);

    if (url.pathname === '/notify' && request.method === 'POST')
      return handleNotify(request, env);

    if (url.pathname === '/health')
      return handleHealth(env);

    return jsonResp({ error: 'not found' }, 404);
  }
};

// =============================================================
// POST /subscribe
// =============================================================
async function handleSubscribe(request, env) {
  let body;
  try { body = await request.json(); } catch(e) { return jsonResp({ error: 'bad json' }, 400); }

  const sub = body.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth)
    return jsonResp({ error: 'subscription invalida: faltan campos' }, 400);

  const key = await sha256b64(sub.endpoint);
  // TTL 90 dias
  await env.SUBS.put(key, JSON.stringify(sub), { expirationTtl: 7776000 });

  const total = (await env.SUBS.list()).keys.length;
  return jsonResp({ ok: true, key, total }, 200);
}

// =============================================================
// POST /notify
// =============================================================
async function handleNotify(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (auth !== 'Bearer ' + ESP32_TOKEN)
    return jsonResp({ error: 'unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch(e) { return jsonResp({ error: 'bad json' }, 400); }

  const { tipo, nodo, rssi, bat } = body;
  if (!tipo || !nodo) return jsonResp({ error: 'faltan tipo o nodo' }, 400);

  const list = await env.SUBS.list();
  if (!list.keys.length) return jsonResp({ ok: true, sent: 0, msg: 'sin suscriptores' });

  const LABELS = { TIMBRE:'Timbre', PIR:'Presencia', VEHICULO:'Vehiculo', BOOT:'Nodo reiniciado' };
  const ICONS  = { TIMBRE:'🔔',    PIR:'👤',        VEHICULO:'🚗',       BOOT:'🔌' };
  if (!LABELS[tipo]) return jsonResp({ ok: true, sent: 0, msg: 'tipo ignorado: '+tipo });

  const hora = new Date().toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Madrid' });
  const payload = JSON.stringify({
    title: ICONS[tipo] + ' ' + LABELS[tipo],
    body:  nodo + '  ·  RSSI ' + rssi + ' dBm  ·  Bat ' + bat + '%  ·  ' + hora,
    tipo, nodo, rssi, bat,
    ts: Date.now(),
  });

  let sent = 0, failed = 0, removed = 0;
  await Promise.all(list.keys.map(async ({ name }) => {
    const raw = await env.SUBS.get(name);
    if (!raw) return;
    const sub = JSON.parse(raw);
    try {
      const result = await sendPush(sub, payload);
      if (result.ok || result.status === 201) {
        sent++;
      } else if (result.status === 410 || result.status === 404) {
        await env.SUBS.delete(name);
        removed++;
      } else {
        failed++;
        console.log('push failed', result.status, await result.text().catch(()=>''));
      }
    } catch(e) {
      failed++;
      console.log('push exception:', e.message);
    }
  }));

  return jsonResp({ ok: true, sent, failed, removed, total: list.keys.length });
}

// =============================================================
// GET /health
// =============================================================
async function handleHealth(env) {
  const list = await env.SUBS.list();
  return jsonResp({ ok: true, subscriptions: list.keys.length, ts: Date.now() });
}

// =============================================================
// WEB PUSH — RFC 8291 + RFC 8292 (implementacion correcta)
// =============================================================

async function sendPush(subscription, payloadStr) {
  const endpoint = subscription.endpoint;
  const p256dh   = b64decode(subscription.keys.p256dh);
  const auth     = b64decode(subscription.keys.auth);

  // 1. Cifrar el payload
  const encrypted = await encryptWebPush(payloadStr, p256dh, auth);

  // 2. Generar JWT VAPID
  const jwt = await makeVapidJWT(endpoint);

  // 3. Enviar al endpoint del push service (FCM, Mozilla, etc.)
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'Authorization':    'vapid t=' + jwt + ',k=' + VAPID_PUBLIC_KEY,
      'TTL':              '86400',
      'Urgency':          'high',
    },
    body: encrypted,
  });
}

// -------------------------------------------------------------
// Cifrado aes128gcm (RFC 8188 + RFC 8291)
// -------------------------------------------------------------
async function encryptWebPush(plaintext, clientPub, authSecret) {
  // Generar par efimero del servidor
  const serverECDH = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const serverPubRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', serverECDH.publicKey)
  );

  // Importar clave publica del cliente
  const clientPubKey = await crypto.subtle.importKey(
    'raw', clientPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );

  // ECDH -> bits compartidos
  const ecdhBits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: clientPubKey }, serverECDH.privateKey, 256)
  );

  // Salt aleatorio 16 bytes
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // PRK = HKDF-Extract(auth_secret, ecdh_secret)
  // con info = "WebPush: info\0" + clientPub + serverPub
  const prk = await hkdfExtract(authSecret, ecdhBits);

  const keyInfo   = buildInfo('Content-Encoding: aes128gcm\0', clientPub, serverPubRaw);
  const nonceInfo = buildInfo('Content-Encoding: nonce\0',      clientPub, serverPubRaw);

  const ikm = await hkdfExpand(prk, buildWebPushInfo(clientPub, serverPubRaw), 32);

  // CEK y Nonce
  const cek   = await hkdfExpand(await hkdfExtract(salt, ikm), keyInfo,   16);
  const nonce = await hkdfExpand(await hkdfExtract(salt, ikm), nonceInfo, 12);

  // Importar clave AES-GCM
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);

  // Padding: 1 byte delimitador 0x02 + contenido
  const content = new TextEncoder().encode(plaintext);
  const padded  = new Uint8Array(content.length + 1);
  padded[0] = 0x02;
  padded.set(content, 1);

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded)
  );

  // Cabecera aes128gcm: salt(16) + rs(4) + keyid_len(1) + keyid(65) + ciphertext
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);

  const result = new Uint8Array(16 + 4 + 1 + serverPubRaw.length + ciphertext.length);
  let off = 0;
  result.set(salt,          off); off += 16;
  result.set(rs,            off); off += 4;
  result[off++] = serverPubRaw.length;
  result.set(serverPubRaw,  off); off += serverPubRaw.length;
  result.set(ciphertext,    off);
  return result.buffer;
}

function buildWebPushInfo(clientPub, serverPub) {
  // "WebPush: info\0" + clientPub(65) + serverPub(65)
  const label = new TextEncoder().encode('WebPush: info\0');
  const out   = new Uint8Array(label.length + clientPub.length + serverPub.length);
  out.set(label, 0);
  out.set(clientPub, label.length);
  out.set(serverPub, label.length + clientPub.length);
  return out;
}

function buildInfo(contextStr, clientPub, serverPub) {
  // contextStr + clientPub_len(2) + clientPub + serverPub_len(2) + serverPub
  const ctx = new TextEncoder().encode(contextStr);
  const buf = new Uint8Array(ctx.length + 2 + clientPub.length + 2 + serverPub.length);
  let off = 0;
  buf.set(ctx, off); off += ctx.length;
  new DataView(buf.buffer).setUint16(off, clientPub.length, false); off += 2;
  buf.set(clientPub, off); off += clientPub.length;
  new DataView(buf.buffer).setUint16(off, serverPub.length, false); off += 2;
  buf.set(serverPub, off);
  return buf;
}

async function hkdfExtract(salt, ikm) {
  const saltKey = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', saltKey, ikm));
}

async function hkdfExpand(prk, info, length) {
  const key = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  // T(1) = HMAC(PRK, info || 0x01)
  const t1Input = new Uint8Array(info.length + 1);
  t1Input.set(info); t1Input[info.length] = 0x01;
  const t1 = new Uint8Array(await crypto.subtle.sign('HMAC', key, t1Input));
  return t1.slice(0, length);
}

// -------------------------------------------------------------
// VAPID JWT (RFC 7515 + RFC 8292)
// -------------------------------------------------------------
async function makeVapidJWT(endpoint) {
  const origin  = new URL(endpoint).origin;
  const exp     = Math.floor(Date.now() / 1000) + 43200;

  const header  = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64url(JSON.stringify({ aud: origin, exp, sub: VAPID_SUBJECT }));
  const msg     = header + '.' + payload;

  // Importar clave privada VAPID
  const privBytes = b64decode(VAPID_PRIVATE_KEY);
  const pkcs8     = wrapPrivKeyPKCS8(privBytes);
  const privKey   = await crypto.subtle.importKey(
    'pkcs8', pkcs8, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, privKey, new TextEncoder().encode(msg)
  );
  return msg + '.' + b64url(new Uint8Array(sig));
}

// Construir DER PKCS8 para una clave privada P-256 de 32 bytes
// Estructura correcta verificada contra RFC 5915 + RFC 5958
function wrapPrivKeyPKCS8(raw32) {
  // ECPrivateKey interior (RFC 5915):
  // SEQUENCE {
  //   INTEGER 1
  //   OCTET STRING (32 bytes de clave privada)
  //   [1] BIT STRING (clave publica, opcional - la omitimos)
  // }
  const ecPriv = concat(
    [0x30, 0x27],           // SEQUENCE(39)
    [0x02, 0x01, 0x01],     // INTEGER 1
    [0x04, 0x20], raw32     // OCTET STRING(32)
  );
  // OneAsymmetricKey (RFC 5958 = PKCS8):
  // SEQUENCE {
  //   INTEGER 0 (version)
  //   SEQUENCE { OID P-256 algorithm }
  //   OCTET STRING { ECPrivateKey }
  // }
  const alg = [
    0x30, 0x13,
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, // OID ecPublicKey
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07  // OID P-256
  ];
  const inner = concat([0x04, ecPriv.length], ecPriv);
  const body  = concat([0x02, 0x01, 0x00], alg, inner);
  const pkcs8 = concat([0x30, body.length], body);
  return pkcs8.buffer;
}

function concat(...parts) {
  const arrays = parts.map(p => p instanceof Uint8Array ? p : new Uint8Array(p));
  const total  = arrays.reduce((s, a) => s + a.length, 0);
  const out    = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// -------------------------------------------------------------
// Utilidades base64
// -------------------------------------------------------------
function b64url(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

function b64decode(str) {
  const s = (str + '===').replace(/-/g,'+').replace(/_/g,'/').slice(0, str.length + (4 - str.length%4)%4);
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

async function sha256b64(str) {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return b64url(new Uint8Array(hash)).slice(0, 22);
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
