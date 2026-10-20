/* ==========================================================================
   Service Worker del Portal de Control - Combuses

   Estrategias por tipo de recurso:
     - Páginas (navegación) ............... red primero sin caché HTTP, cae al shell
     - App shell (HTML/CSS/JS/iconos) ..... caché primero + revalidación de fondo
     - Librerías de CDN y tipografías ..... caché primero (están versionadas)
     - API Supabase (REST/Auth/Storage) ... solo red, nunca se guarda
     - Mapa (cuadritos de OpenStreetMap) .. solo red: son miles y no hacen falta sin internet

   Lo de Supabase nunca se guarda: control siempre ve los números de ahora, y
   las tarjetas y la sesión no quedan en el disco del PC.

   Actualizaciones: una versión nueva se descarga completa y queda en espera.
   La página (js/control.js, bloque "aplicación") avisa "Hay una versión nueva"
   y la activa cuando la persona toca Actualizar.
   ========================================================================== */

// Igual a VERSION de js/control-config.js. No se cambia a mano: lo hace
// nueva-version.ps1 en todos los sitios a la vez. Que este archivo cambie es
// lo que avisa a los PC de que hay una versión nueva.
const VERSION = "v0.16.0";
const CACHE_APP = "control-app-" + VERSION;
const CACHE_CDN = "control-cdn-" + VERSION;

const APP_SHELL = [
  "./",
  "./index.html",
  "./css/control.css",
  "./js/control-config.js",
  "./js/control.js",
  "./manifest.webmanifest",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/icon-maskable-512.png",
  "./assets/apple-touch-icon.png",
  "./assets/favicon-64.png",
];

const CDN_PRECACHE = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4",
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
];

// Hosts cuyas respuestas nunca deben quedar en caché.
const HOSTS_SIN_CACHE = ["supabase.co", "supabase.in", "tile.openstreetmap.org"];

// -------------------------------------------------------------- install
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_APP);
    // cache.addAll() falla entero si un solo recurso falla; se añaden uno a
    // uno para que un archivo faltante no impida instalar el service worker.
    await Promise.all(
      APP_SHELL.map((url) =>
        cache.add(new Request(url, { cache: "reload" })).catch(() => null)
      )
    );
    const cdn = await caches.open(CACHE_CDN);
    await Promise.all(
      CDN_PRECACHE.map((url) =>
        cdn.add(new Request(url, { mode: "cors", cache: "reload" })).catch(() => null)
      )
    );
    // Sin skipWaiting: la versión nueva queda en espera y la persona decide
    // cuándo activarla, para no recargar a mitad de una corrección. (La primera
    // instalación, sin versión anterior, se activa sola de todos modos.)
  })());
});

// ------------------------------------------------------------- activate
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const vigentes = [CACHE_APP, CACHE_CDN];
    const claves = await caches.keys();
    await Promise.all(
      claves
        .filter((k) => k.startsWith("control-") && !vigentes.includes(k))
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  const tipo = event.data && event.data.type;
  if (tipo === "SKIP_WAITING") self.skipWaiting();
  // La página pregunta qué versión trae el service worker en espera, para
  // anunciarla antes de instalarla.
  if (tipo === "VERSION" && event.ports && event.ports[0]) event.ports[0].postMessage(VERSION);
});

// ---------------------------------------------------------------- fetch
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  // Datos vivos: siempre a la red, nunca desde caché.
  if (HOSTS_SIN_CACHE.some((h) => url.hostname.endsWith(h))) return;

  // Navegaciones: red primero para tomar la versión nueva, con el shell como
  // red de seguridad si no hay internet.
  if (req.mode === "navigate") {
    event.respondWith(navegacion(req));
    return;
  }

  if (url.origin !== self.location.origin) {
    event.respondWith(cachePrimero(req, CACHE_CDN));
    return;
  }

  event.respondWith(cachePrimeroRevalidando(req, CACHE_APP));
});

// ------------------------------------------------------------ estrategias
async function navegacion(req) {
  try {
    // "no-cache" revalida con el servidor en vez de fiarse de la caché HTTP:
    // GitHub Pages sirve el HTML con max-age=600, y sin esto una versión recién
    // publicada podía tardar 10 minutos en llegar aunque se recargara.
    const res = await fetch(req.url, { cache: "no-cache", credentials: "same-origin" });
    // Una navegación no acepta una respuesta que ya siguió una redirección:
    // se le devuelve la redirección y el navegador la sigue.
    if (res.redirected) return Response.redirect(res.url, 302);
    if (res && res.ok) {
      const cache = await caches.open(CACHE_APP);
      cache.put(req, res.clone());
    }
    return res;
  } catch (_) {
    const cache = await caches.open(CACHE_APP);
    return (await cache.match(req)) ||
      (await cache.match("./index.html")) ||
      (await cache.match("./")) ||
      new Response("Sin conexión", { status: 503, statusText: "Sin conexión" });
  }
}

async function cachePrimero(req, nombreCache) {
  const cache = await caches.open(nombreCache);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
    return res;
  } catch (err) {
    return new Response("Sin conexión", { status: 503, statusText: "Sin conexión" });
  }
}

async function cachePrimeroRevalidando(req, nombreCache) {
  const cache = await caches.open(nombreCache);
  const hit = await cache.match(req);

  const enRed = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);

  if (hit) return hit;                       // se sirve ya, se actualiza detrás
  const res = await enRed;
  return res || new Response("Sin conexión", { status: 503, statusText: "Sin conexión" });
}
