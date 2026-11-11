/* Service worker de la versión web (iPhone): guarda la app completa en el teléfono para usarla sin señal.
   Al publicar una versión nueva, cambiar VERSION para que los teléfonos descarguen los archivos nuevos. */
const VERSION = 'recorrido-v4';
const ARCHIVOS = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.json',
  'lib/jszip.min.js', 'lib/docx.umd.js', 'lib/tf.min.js',
  'lib/mobilenet/model.json', 'lib/mobilenet/group1-shard1of3.bin',
  'lib/mobilenet/group1-shard2of3.bin', 'lib/mobilenet/group1-shard3of3.bin',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'
];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(VERSION).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', ev => {
  ev.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Archivos de la app: primero del teléfono (funciona sin señal). Mapas satelitales y demás: directo a internet.
self.addEventListener('fetch', ev => {
  const url = new URL(ev.request.url);
  if (ev.request.method !== 'GET' || url.origin !== self.location.origin) return;
  ev.respondWith(caches.match(ev.request, { ignoreSearch: true }).then(r => r || fetch(ev.request)));
});
