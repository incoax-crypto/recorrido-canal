/* Service worker de la versión web (iPhone): guarda la app completa en el teléfono para usarla sin señal.
   Al publicar una versión nueva, cambiar VERSION para que los teléfonos descarguen los archivos nuevos.
   La versión nueva queda en espera hasta que el usuario toca "Actualizar ahora" (después de respaldar). */
const VERSION = 'recorrido-v10';
const ARCHIVOS = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.json',
  'lib/jszip.min.js', 'lib/docx.umd.js', 'lib/tf.min.js',
  'lib/mobilenet/model.json', 'lib/mobilenet/group1-shard1of3.bin',
  'lib/mobilenet/group1-shard2of3.bin', 'lib/mobilenet/group1-shard3of3.bin',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'
];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(VERSION).then(c => c.addAll(ARCHIVOS)));
});

// La app pide aplicar la actualización cuando el usuario lo decide
self.addEventListener('message', ev => {
  if (ev.data === 'actualizar') self.skipWaiting();
});

// Solo se borran archivos del programa de versiones anteriores; los recorridos (IndexedDB) nunca se tocan
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
