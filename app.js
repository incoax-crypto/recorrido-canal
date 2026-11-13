'use strict';

/* Recorrido Canal: captura de estructuras en campo y generación de reportes (Word, KMZ, CSV). */

const APP = !!(window.Android && window.Android.isApp);
const $ = s => document.querySelector(s);

const TIPOS = ['Toma granja', 'Toma lateral', 'Represa / Derivadora', 'Compuerta', 'Alcantarilla',
  'Puente vehicular', 'Puente peatonal', 'Sifón', 'Caída', 'Rápida', 'Aforador', 'Desfogue / Vertedor',
  'Puente canal', 'Entrada de agua', 'Canaleta / Dren', 'Otra'];
const ESTADOS = ['Bueno', 'Regular', 'Malo', 'Fuera de servicio'];
const COLOR_ESTADO = { 'Bueno': '#2e7d32', 'Regular': '#f9a825', 'Malo': '#c62828', 'Fuera de servicio': '#6a1b9a' };
const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

/* ---------- Base de datos local (IndexedDB) ---------- */

let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('recorridoCanal', 3);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('recorridos')) d.createObjectStore('recorridos', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('estructuras')) d.createObjectStore('estructuras', { keyPath: 'id' }).createIndex('rec', 'recId');
      if (!d.objectStoreNames.contains('config')) d.createObjectStore('config'); // último KMZ cargado, etc.
      if (!d.objectStoreNames.contains('ejemplos')) d.createObjectStore('ejemplos', { keyPath: 'id' }); // huellas de fotos por tipo
    };
    r.onsuccess = () => { db = r.result; res(); };
    r.onerror = () => rej(r.error);
  });
}
const store = (s, mode = 'readonly') => db.transaction(s, mode).objectStore(s);
const prom = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const dbPut = (s, v) => prom(store(s, 'readwrite').put(v));
const dbGet = (s, k) => prom(store(s).get(k));
const dbDel = (s, k) => prom(store(s, 'readwrite').delete(k));
const dbAll = s => prom(store(s).getAll());
const cfgGet = k => prom(store('config').get(k));
const cfgSet = (k, v) => prom(store('config', 'readwrite').put(v, k));
const estructurasDe = recId => prom(store('estructuras').index('rec').getAll(recId)).then(a => a.sort((x, y) => x.num - y.num));

/* ---------- Utilidades ---------- */

const pad = (n, l = 2) => String(n).padStart(l, '0');
const fechaTxt = t => { const d = new Date(t); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; };
const horaTxt = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const hoy = () => { const d = new Date(); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`; };
const rad = Math.PI / 180;

/* Conversión geográficas WGS84 → UTM (zona automática). */
function utm(lat, lon) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const zona = Math.min(60, Math.floor((lon + 180) / 6) + 1);
  const banda = 'CDEFGHJKLMNPQRSTUVWXX'[Math.max(0, Math.min(20, Math.floor((lat + 80) / 8)))];
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const p = lat * rad, s = Math.sin(p), c = Math.cos(p), t = Math.tan(p);
  const N = a / Math.sqrt(1 - e2 * s * s), T = t * t, C = ep2 * c * c;
  const A = c * (lon - ((zona - 1) * 6 - 177)) * rad;
  const M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * p
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * p)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * p)
    - (35 * e2 ** 3 / 3072) * Math.sin(6 * p));
  const este = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
  let norte = k0 * (M + N * t * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24
    + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
  if (lat < 0) norte += 10000000;
  return { zona: `${zona}${banda}`, este, norte };
}
const miles = n => n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const coordTxt = (lat, lon) => { const u = utm(lat, lon); return `UTM ${u.zona} E ${miles(u.este)} N ${miles(u.norte)}`; };

/* ---------- Trazo del canal (KMZ/KML) y cadenamiento ---------- */

/* Decodifica un KML respetando la codificación declarada (UTF-8, Windows-1252, ISO-8859-1…) y quita el BOM. */
function decodificarKml(bytes) {
  const cab = String.fromCharCode(...bytes.slice(0, 300));
  let enc = (cab.match(/encoding\s*=\s*["']([^"']+)["']/i) || [])[1] || 'utf-8';
  let texto;
  try { texto = new TextDecoder(enc).decode(bytes); } catch (e) { texto = new TextDecoder('utf-8').decode(bytes); }
  return texto.replace(/^[﻿\s]+/, '');
}

/* Interpreta un KML: primero como XML estricto y, si falla, con el lector tolerante de HTML. */
function extraerGeometria(texto, lineas, puntos) {
  let doc = new DOMParser().parseFromString(texto, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(texto, 'text/html');
  const coords = s => s.trim().split(/\s+/).map(x => x.split(',').map(Number))
    .filter(c => c.length >= 2 && isFinite(c[0]) && isFinite(c[1])).map(c => [c[0], c[1]]);
  const hijo = (el, tag) => el.getElementsByTagName(tag)[0];
  const nombreDe = el => ([...el.children].find(c => c.localName.toLowerCase() === 'name')?.textContent || '')
    .replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const carpeta = el => { for (let p = el.parentElement; p; p = p.parentElement) { const n = nombreDe(p); if (n) return n; } return ''; };
  const contador = {};
  for (const pm of doc.getElementsByTagName('Placemark')) {
    // Las líneas sin nombre (o llamadas "0") toman el nombre de su carpeta: "Red distribución … – tramo 3"
    let nombre = nombreDe(pm);
    if (!nombre || /^\d+$/.test(nombre)) {
      const base = carpeta(pm) || 'Tramo';
      contador[base] = (contador[base] || 0) + 1;
      nombre = `${base} – tramo ${contador[base]}`;
    }
    const nuevaLinea = cc => { if (cc.length >= 2) lineas.push({ nombre: nombre || `Tramo ${lineas.length + 1}`, coords: cc }); };
    for (const ls of [...pm.getElementsByTagName('LineString'), ...pm.getElementsByTagName('LinearRing')]) {
      const c = hijo(ls, 'coordinates');
      if (c) nuevaLinea(coords(c.textContent));
    }
    for (const tr of pm.getElementsByTagName('gx:Track')) {
      nuevaLinea([...tr.getElementsByTagName('gx:coord')].map(c => c.textContent.trim().split(/\s+/).map(Number))
        .filter(c => isFinite(c[0]) && isFinite(c[1])).map(c => [c[0], c[1]]));
    }
    for (const pt of pm.getElementsByTagName('Point')) {
      const c = hijo(pt, 'coordinates');
      const cc = c ? coords(c.textContent) : [];
      if (cc.length) puntos.push({ nombre, lon: cc[0][0], lat: cc[0][1] });
    }
  }
}

async function leerTrazo(file) {
  const u = new Uint8Array(await file.arrayBuffer());
  if (!u.length) throw new Error('el archivo llegó vacío. Cópialo a la memoria del teléfono (carpeta Descargas) y elígelo desde ahí');
  const lineas = [], puntos = [];
  if (u[0] === 0x50 && u[1] === 0x4B) {
    let z;
    try { z = await JSZip.loadAsync(u); } catch (e) { throw new Error('el KMZ está dañado o incompleto'); }
    const kmls = Object.keys(z.files).filter(n => /\.kml$/i.test(n) && !z.files[n].dir)
      .sort((a, b) => /(^|\/)doc\.kml$/i.test(b) - /(^|\/)doc\.kml$/i.test(a));
    if (!kmls.length) throw new Error('el KMZ no contiene ningún archivo KML');
    for (const k of kmls) extraerGeometria(decodificarKml(await z.file(k).async('uint8array')), lineas, puntos);
  } else {
    const texto = decodificarKml(u);
    if (!texto.startsWith('<')) throw new Error('el archivo no es un KMZ ni un KML');
    extraerGeometria(texto, lineas, puntos);
  }
  if (!lineas.length) {
    throw new Error(puntos.length
      ? `el archivo solo tiene puntos (${puntos.length}), no líneas. Dibuja el eje del canal como "Ruta" en Google Earth`
      : 'no se encontraron líneas (tramos) en el archivo. Si en Google Earth el trazo está en una carpeta "vinculada", guárdalo de nuevo como KMZ');
  }
  if (lineas.some(l => l.coords.some(c => Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90))) {
    throw new Error('las coordenadas del archivo no son geográficas (latitud/longitud). Expórtalo de nuevo como KMZ desde Google Earth');
  }
  return { archivo: file.name, lineas, puntos, sentidos: {} };
}

const distM = (a, b) => Math.hypot((b[0] - a[0]) * Math.cos((a[1] + b[1]) / 2 * rad), b[1] - a[1]) * rad * 6371000;
const largo = l => l.coords.reduce((s, c, i) => i ? s + distM(l.coords[i - 1], c) : 0, 0);
function kmTxt(m) { const r = Math.round(m); return `${Math.floor(r / 1000)}+${pad(r % 1000, 3)}`; }

/* Proyecta un punto sobre la línea más cercana. Devuelve: li (índice de la línea), tramo (nombre),
   dist (m al eje), kmN (m desde el primer vértice), L (largo de la línea), sentido ('n', 'inv' o null)
   y km (cadenamiento según el sentido elegido por el usuario para esa línea). */
function cadenamiento(lat, lon, trazo) {
  const R = 6371000, k = Math.cos(lat * rad);
  let best = null;
  trazo.lineas.forEach((l, li) => {
    const c = l.coords;
    let acum = 0;
    for (let i = 0; i < c.length - 1; i++) {
      const a = c[i], b = c[i + 1];
      const bx = (b[0] - a[0]) * k * rad * R, by = (b[1] - a[1]) * rad * R;
      const px = (lon - a[0]) * k * rad * R, py = (lat - a[1]) * rad * R;
      const L2 = bx * bx + by * by, seg = Math.sqrt(L2);
      const t = L2 ? Math.max(0, Math.min(1, (px * bx + py * by) / L2)) : 0;
      const d = Math.hypot(px - t * bx, py - t * by);
      if (!best || d < best.dist) best = { li, tramo: l.nombre, dist: d, kmN: acum + t * seg };
      acum += seg;
    }
    if (best && best.li === li) best.L = acum;
  });
  if (!best) return null;
  best.sentido = (trazo.sentidos && trazo.sentidos[best.li]) || null;
  best.km = best.sentido === 'inv' ? best.L - best.kmN : best.kmN;
  return best;
}
const tipoDe = e => e.tipo === 'Otra' ? (e.tipoOtro || 'Otra estructura') : e.tipo;
const tick = () => new Promise(r => setTimeout(r, 0));
function slug(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, 40) || 'canal';
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } }

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function busy(msg) { $('#ovMsg').textContent = msg; $('#overlay').hidden = false; }
function idle() { $('#overlay').hidden = true; }

/* ---------- Estado y vistas ---------- */

let rec = null;      // recorrido activo
let cur = null;      // estructura en edición
let dirty = false;
let vista = 'inicio';
let urls = [];       // object URLs de miniaturas
let estsRec = [];    // estructuras del recorrido mostrado (para el croquis)
let trazoNuevo = null;
let destinoTrazo = 'nuevo';
let canalAuto = false; // el nombre del canal del inicio se llenó con la línea más cercana del KMZ

function objUrl(b) { const u = URL.createObjectURL(b); urls.push(u); return u; }
function liberarUrls() { urls.forEach(u => URL.revokeObjectURL(u)); urls = []; }

function mostrar(v) {
  vista = v;
  $('#vInicio').hidden = v !== 'inicio';
  $('#vRec').hidden = v !== 'rec';
  $('#vEst').hidden = v !== 'est';
  $('#btnBack').hidden = v === 'inicio';
  $('#gps').hidden = v === 'inicio';
  window.scrollTo(0, 0);
  if (v !== 'inicio') startGPS();
}

/* ---------- GPS ---------- */

let pos = null, watchId = null;
function startGPS() {
  if (watchId !== null) return;
  if (!navigator.geolocation) { gpsChip('Sin GPS', 'bad'); return; }
  gpsChip('Buscando GPS…', '');
  watchId = navigator.geolocation.watchPosition(p => {
    pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, alt: p.coords.altitude, t: Date.now() };
    renderGps();
    if (vista === 'rec') dibujarCroquis();
    if (vista === 'inicio') autoCanal();
  }, err => {
    gpsChip(err.code === 1 ? 'GPS sin permiso' : 'Sin señal GPS', 'bad');
  }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 60000 });
}
function gpsChip(txt, cls) { const el = $('#gps'); el.textContent = txt; el.className = 'chip ' + cls; }
function renderGps() {
  if (!pos) return;
  if (Date.now() - pos.t > 60000) { gpsChip('GPS sin actualizar', 'bad'); return; }
  const a = Math.round(pos.acc);
  gpsChip(`GPS ±${a} m`, a <= 10 ? 'ok' : a <= 30 ? 'mid' : 'bad');
}
setInterval(renderGps, 10000);

/* ---------- Inicio: recorridos ---------- */

async function renderInicio() {
  mostrar('inicio');
  liberarUrls();
  $('#hTitle').textContent = 'Recorrido de Canal';
  $('#hSub').textContent = 'Reconocimiento de estructuras';
  if (trazoNuevo) { startGPS(); autoCanal(); }
  const recs = (await dbAll('recorridos')).sort((a, b) => b.creado - a.creado);
  const cuenta = {};
  // Solo se cuentan (sin cargar estructuras ni fotos en memoria)
  for (const r of recs) cuenta[r.id] = await prom(store('estructuras').index('rec').count(r.id));
  $('#listaRec').innerHTML = recs.length ? recs.map(r => `
    <div class="item" data-id="${r.id}">
      <div class="info">
        <div class="t">${esc(r.canal)}</div>
        <div class="s">${fechaTxt(r.creado)} · ${cuenta[r.id] || 0} estructuras${r.resp ? ' · ' + esc(r.resp) : ''}</div>
        ${r.tramo ? `<div class="s">${esc(r.tramo)}</div>` : ''}
        <div class="acc">
          <button type="button" class="btn guardar" data-exp="${r.id}">Guardar .rcanal</button>
          <button type="button" class="btn danger" data-del="${r.id}">Borrar</button>
        </div>
      </div>
    </div>`).join('') : '<div class="empty">Aún no hay recorridos guardados.</div>';
  $('#btnRespaldo').hidden = !recs.length;
  await renderAvisoRespaldo();
}

async function iniciarRecorrido() {
  const canal = $('#inCanal').value.trim();
  if (!canal) { toast('Escribe el nombre del canal'); $('#inCanal').focus(); return; }
  const r = { id: 'r' + Date.now(), canal, resp: $('#inResp').value.trim(), tramo: $('#inTramo').value.trim(), creado: Date.now(), trazo: trazoNuevo };
  await dbPut('recorridos', r);
  lsSet('resp', r.resp);
  // El KMZ se conserva para el siguiente recorrido; el nombre se volverá a llenar con el canal más cercano
  $('#inCanal').value = ''; $('#inTramo').value = '';
  canalAuto = true;
  rec = r;
  renderRec();
}

async function eliminarRecorrido(id) {
  const r = await dbGet('recorridos', id);
  const ests = await estructurasDe(id);
  if (!confirm(`¿Eliminar el recorrido "${r.canal}" y sus ${ests.length} estructuras? Esta acción no se puede deshacer.`)) return;
  for (const e of ests) await dbDel('estructuras', e.id);
  await dbDel('recorridos', id);
  renderInicio();
}

/* ---------- Recorrido: lista de estructuras ---------- */

async function renderRec() {
  mostrar('rec');
  liberarUrls();
  const ests = await estructurasDe(rec.id);
  estsRec = ests;
  $('#hTitle').textContent = rec.canal;
  $('#hSub').textContent = `${ests.length} estructura${ests.length === 1 ? '' : 's'}${rec.tramo ? ' · ' + rec.tramo : ''}`;
  const t = rec.trazo;
  $('#trazoBar').innerHTML = t ? `
    <div class="trzinfo"><b>Trazo:</b> ${esc(t.archivo)} · ${t.lineas.length} línea(s), ${(t.lineas.reduce((s, l) => s + largo(l), 0) / 1000).toFixed(2)} km</div>
    <button class="btn ghost block" style="margin-top:0" data-act="cambiar">Cambiar KMZ</button>` :
    '<button class="btn ghost block" style="margin-top:0" data-act="cambiar">Cargar KMZ con el trazo del canal</button>';
  $('#croquis').hidden = !t && !ests.some(e => e.lat != null);
  dibujarCroquis();
  $('#listaEst').innerHTML = ests.length ? ests.map(e => {
    const f = e.fotos[0];
    return `<div class="item" data-id="${e.id}">
      ${f ? `<img src="${objUrl(f.mini || f.blob)}" alt="" loading="lazy">` : '<div class="noimg"></div>'}
      <div class="info">
        <div class="t">${esc(e.codigo)} · ${esc(tipoDe(e))}<span class="badge" style="background:${COLOR_ESTADO[e.estado] || '#78909c'}">${esc(e.estado || 's/e')}</span></div>
        <div class="s">${e.km ? 'Km ' + esc(e.km) + ' · ' : ''}${e.lat != null ? coordTxt(e.lat, e.lon) : 'Sin coordenadas'} · ${e.fotos.length} foto(s)</div>
        <div class="d">${esc(e.desc) || '<i>Sin descripción</i>'}</div>
      </div>
    </div>`;
  }).join('') : '<div class="empty">Toca <b>+ Estructura</b> para registrar la primera estructura del recorrido.</div>';
  asegurarMinis(ests); // en segundo plano, para fotos de versiones anteriores
}

/* Croquis sin internet: trazo del canal, estructuras y posición actual. */
function dibujarCroquis() {
  const cv = $('#croquis');
  if (cv.hidden) return;
  const W = cv.clientWidth || 340, H = 240, dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.fillStyle = '#eef3f8'; g.fillRect(0, 0, W, H);
  const lineas = rec.trazo ? rec.trazo.lineas : [];
  const geo = estsRec.filter(e => e.lat != null);
  // Encuadre: estructuras y posición actual (si está dentro de la red); sin ellas, toda la red
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const ext = (x, y) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
  lineas.forEach(l => l.coords.forEach(c => ext(c[0], c[1])));
  const red = [x0, x1, y0, y1];
  const posEnRed = pos && pos.lon >= red[0] - 0.02 && pos.lon <= red[1] + 0.02 && pos.lat >= red[2] - 0.02 && pos.lat <= red[3] + 0.02;
  if (geo.length || posEnRed) {
    x0 = y0 = Infinity; x1 = y1 = -Infinity;
    geo.forEach(e => ext(e.lon, e.lat));
    if (posEnRed) ext(pos.lon, pos.lat);
    const MIN = 0.006; // ~650 m
    if (x1 - x0 < MIN) { const c = (x0 + x1) / 2; x0 = c - MIN / 2; x1 = c + MIN / 2; }
    if (y1 - y0 < MIN) { const c = (y0 + y1) / 2; y0 = c - MIN / 2; y1 = c + MIN / 2; }
  }
  if (!isFinite(x0)) return;
  g.save(); g.beginPath(); g.rect(0, 0, W, H); g.clip();
  const k = Math.cos((y0 + y1) / 2 * rad);
  const s = Math.min((W - 90) / Math.max((x1 - x0) * k, 1e-5), (H - 70) / Math.max(y1 - y0, 1e-5));
  const P = (lon, lat) => [W / 2 + (lon - (x0 + x1) / 2) * k * s, H / 2 - (lat - (y0 + y1) / 2) * s];
  g.lineJoin = 'round'; g.lineCap = 'round';
  for (const [w, col] of [[6, '#ffffff'], [3, '#1e88e5']]) {
    g.lineWidth = w; g.strokeStyle = col;
    lineas.forEach(l => { g.beginPath(); l.coords.forEach((c, i) => { const [x, y] = P(c[0], c[1]); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); });
  }
  g.font = 'bold 11px sans-serif';
  geo.forEach(e => {
    const [x, y] = P(e.lon, e.lat);
    g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2);
    g.fillStyle = COLOR_ESTADO[e.estado] || '#e53935'; g.fill();
    g.lineWidth = 1.5; g.strokeStyle = '#fff'; g.stroke();
    if (geo.length <= 40) { g.fillStyle = '#17212b'; g.fillText(e.codigo, x + 7, y - 6); }
  });
  if (pos) {
    const [x, y] = P(pos.lon, pos.lat);
    if (x > 0 && x < W && y > 0 && y < H) {
      g.beginPath(); g.arc(x, y, 12, 0, Math.PI * 2); g.fillStyle = 'rgba(33,150,243,.25)'; g.fill();
      g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fillStyle = '#1565c0'; g.fill();
      g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
    }
  }
  g.restore();
  g.fillStyle = '#5b6876'; g.font = '11px sans-serif';
  g.fillText('Croquis (sin escala)  ● estructura   ◉ tu posición', 8, H - 8);
}

/* Nombre del canal donde está el punto: la línea del KMZ más cercana (si está a menos de 300 m). */
function canalEn(lat, lon) {
  const c = rec && rec.trazo && lat != null ? cadenamiento(lat, lon, rec.trazo) : null;
  return c && c.dist <= 300 ? c.tramo : rec.canal;
}

/* En el inicio: llena "Nombre del canal" con la línea del KMZ más cercana a la posición actual. */
function autoCanal() {
  if (!trazoNuevo) return;
  const info = $('#trazoNuevoInfo');
  const resumen = `✓ ${esc(trazoNuevo.archivo)}: ${trazoNuevo.lineas.length} línea(s), ${(trazoNuevo.lineas.reduce((s, l) => s + largo(l), 0) / 1000).toFixed(2)} km`;
  if (!pos) { info.innerHTML = `${resumen}<br>Buscando GPS para identificar el canal…`; return; }
  const c = cadenamiento(pos.lat, pos.lon, trazoNuevo);
  const campo = $('#inCanal');
  if (c && (!campo.value.trim() || canalAuto)) { campo.value = c.tramo; canalAuto = true; }
  info.innerHTML = resumen + (c ? `<br>Canal más cercano: <b>${esc(c.tramo)}</b> (a ${Math.round(c.dist)} m)` : '');
}

async function cargarTrazo(file) {
  if (!file) return;
  busy('Leyendo trazo del canal…');
  const t = await leerTrazo(file);
  const km = (t.lineas.reduce((s, l) => s + largo(l), 0) / 1000).toFixed(2);
  await cfgSet('trazo', t); // se recuerda para llenar el canal automáticamente al abrir la app
  if (destinoTrazo === 'nuevo') {
    trazoNuevo = t;
    canalAuto = true;
    $('#btnTrazoNuevo').textContent = 'Cambiar KMZ / KML';
    startGPS();
    autoCanal();
  } else {
    rec.trazo = t;
    await dbPut('recorridos', rec);
    await recalcularKm();
    await renderRec();
    toast(`Trazo cargado: ${t.lineas.length} tramo(s), ${km} km`);
  }
}

/* Actualiza tramo, distancia al eje y cadenamiento automático de las estructuras del recorrido. */
async function recalcularKm() {
  for (const e of await estructurasDe(rec.id)) {
    if (e.lat == null) continue;
    const c = rec.trazo ? cadenamiento(e.lat, e.lon, rec.trazo) : null;
    if (!c) continue;
    e.tramoCanal = c.tramo; e.distEje = c.dist;
    if (c.sentido && (!e.km || e.kmAuto)) { e.km = kmTxt(c.km); e.kmAuto = true; }
    await dbPut('estructuras', e);
  }
}

async function accionTrazo(act) {
  if (act === 'cambiar') { destinoTrazo = 'rec'; $('#inKmz').value = ''; $('#inKmz').click(); }
}

/* ---------- Sentido del cadenamiento por canal ---------- */

function rumbo(a, b) {
  const dx = (b[0] - a[0]) * Math.cos((a[1] + b[1]) / 2 * rad), dy = b[1] - a[1];
  const g = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  return ['el Norte', 'el Noreste', 'el Oriente', 'el Sureste', 'el Sur', 'el Suroeste', 'el Poniente', 'el Noroeste'][Math.round(g / 45) % 8];
}

/* Pregunta al usuario hacia dónde avanza el kilometraje de la línea li. Resuelve 'n' o 'inv'. */
function preguntarSentido(c) {
  idle();
  const l = rec.trazo.lineas[c.li], a = l.coords[0], b = l.coords[l.coords.length - 1];
  $('#sentMsg').innerHTML = `<b>${esc(c.tramo)}</b><br>Longitud en el KMZ: ${(c.L / 1000).toFixed(3)} km<br><br>` +
    '¿Hacia dónde avanza el kilometraje de este canal? (el Km 0+000 queda en el extremo contrario)';
  $('#sentA').innerHTML = `Avanza hacia ${rumbo(a, b)}<small>Esta estructura quedaría en Km ${kmTxt(c.kmN)}</small>`;
  $('#sentB').innerHTML = `Avanza hacia ${rumbo(b, a)}<small>Esta estructura quedaría en Km ${kmTxt(c.L - c.kmN)}</small>`;
  $('#dlgSentido').hidden = false;
  return new Promise(res => {
    $('#sentA').onclick = () => { $('#dlgSentido').hidden = true; res('n'); };
    $('#sentB').onclick = () => { $('#dlgSentido').hidden = true; res('inv'); };
  });
}

/* Guarda el sentido de una línea en el recorrido y en el KMZ recordado, y recalcula las estructuras. */
async function fijarSentido(li, sentido) {
  rec.trazo.sentidos = { ...(rec.trazo.sentidos || {}), [li]: sentido };
  await dbPut('recorridos', rec);
  const cfg = await cfgGet('trazo');
  if (cfg && cfg.archivo === rec.trazo.archivo && cfg.lineas.length === rec.trazo.lineas.length) {
    cfg.sentidos = { ...(cfg.sentidos || {}), [li]: sentido };
    await cfgSet('trazo', cfg);
    if (trazoNuevo) trazoNuevo.sentidos = cfg.sentidos;
  }
  await recalcularKm();
}

async function cambiarSentido() {
  const c = cadenamiento(cur.lat, cur.lon, rec.trazo);
  if (!c) return;
  await fijarSentido(c.li, c.sentido === 'inv' ? 'n' : 'inv');
  cur.kmAuto = true;
  await autoKm();
  renderUbic();
  toast('Sentido del canal cambiado');
}

/* ---------- Formulario de estructura ---------- */

async function nuevaEstructura() {
  const ests = await estructurasDe(rec.id);
  const num = ests.reduce((m, e) => Math.max(m, e.num), 0) + 1;
  cur = {
    id: 'e' + Date.now(), recId: rec.id, num, codigo: 'E-' + pad(num), tipo: '', tipoOtro: '',
    km: '', estado: '', desc: '', lat: null, lon: null, acc: null, alt: null, fecha: Date.now(), fotos: [], nuevo: true
  };
  abrirForm();
}

async function editarEstructura(id) {
  cur = await dbGet('estructuras', id);
  abrirForm();
}

function abrirForm() {
  mostrar('est');
  $('#hTitle').textContent = cur.nuevo ? 'Nueva estructura' : 'Editar ' + cur.codigo;
  $('#hSub').textContent = rec.canal;
  $('#fCodigo').value = cur.codigo;
  $('#fKm').value = cur.km;
  $('#fTipo').value = cur.tipo;
  $('#fTipoOtro').value = cur.tipoOtro;
  $('#lblOtro').hidden = cur.tipo !== 'Otra';
  $('#fDesc').value = cur.desc;
  $('#btnEliminar').hidden = !!cur.nuevo;
  $('.bar').style.gridTemplateColumns = cur.nuevo ? '1fr' : '1fr 2fr';
  $('#fMejorar').checked = lsGet('mejorar') !== '0';
  $('#fGaleria').checked = lsGet('galeria') !== '0';
  renderBotonFotos();
  renderEstado(); renderUbic(); renderFotos();
  if (cur.nuevo) sugerir(); else ['#fSugerencia', '#fSugEstado', '#fSugDesc'].forEach(s => { $(s).hidden = true; });
  cargarModelo(); // se prepara mientras el usuario toma la foto
  dirty = false;
}

function leerForm() {
  cur.codigo = $('#fCodigo').value.trim() || cur.codigo;
  cur.km = $('#fKm').value.trim();
  cur.tipo = $('#fTipo').value;
  cur.tipoOtro = $('#fTipoOtro').value.trim();
  cur.desc = $('#fDesc').value.trim();
}

function renderEstado() {
  $('#fEstado').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === cur.estado));
}

function renderUbic() {
  if (cur.lat == null) { $('#fUbic').innerHTML = 'Sin coordenadas. Se tomarán con la primera foto.'; return; }
  const u = utm(cur.lat, cur.lon);
  let h = `UTM zona ${u.zona} (WGS84)<br>E ${miles(u.este)} m<br>N ${miles(u.norte)} m` +
    (cur.acc ? `<br>Precisión ±${Math.round(cur.acc)} m` : '') +
    (cur.alt != null ? `<br>Altitud ${Math.round(cur.alt)} m` : '');
  const c = rec.trazo ? cadenamiento(cur.lat, cur.lon, rec.trazo) : null;
  if (c) {
    h += `<div class="trz">Canal: <b>${esc(c.tramo)}</b><br>` +
      (c.sentido ? `Km ${kmTxt(c.km)} · ` : 'Km sin definir (falta el sentido del canal) · ') + `a ${Math.round(c.dist)} m del eje` +
      (c.dist > 150 ? '<br>⚠ La estructura está lejos del trazo' : '') +
      (c.sentido
        ? `<br><button type="button" class="btn ghost" data-km="${kmTxt(c.km)}">Usar Km ${kmTxt(c.km)}</button>
           <button type="button" class="btn ghost" data-sentido="cambiar">Cambiar sentido de este canal</button>`
        : '<br><button type="button" class="btn ghost" data-sentido="definir">Indicar sentido del canal</button>') +
      '</div>';
  }
  $('#fUbic').innerHTML = h;
}

/* Llena el cadenamiento con el calculado sobre el trazo si el campo está vacío o era automático.
   Si el canal aún no tiene sentido definido, lo pregunta (solo si la estructura está cerca del canal). */
async function autoKm(forzarPregunta = false) {
  if (cur.lat == null || !rec.trazo) return;
  let c = cadenamiento(cur.lat, cur.lon, rec.trazo);
  if (!c) return;
  if (!c.sentido && (c.dist <= 300 || forzarPregunta)) {
    await fijarSentido(c.li, await preguntarSentido(c));
    c = cadenamiento(cur.lat, cur.lon, rec.trazo);
  }
  cur.tramoCanal = c.tramo; cur.distEje = c.dist;
  if (c.sentido && (!$('#fKm').value.trim() || cur.kmAuto)) { cur.km = kmTxt(c.km); cur.kmAuto = true; $('#fKm').value = cur.km; }
}

function renderFotos() {
  liberarUrls();
  $('#fFotos').innerHTML = cur.fotos.map((f, i) => `
    <div class="foto" data-i="${i}">
      <img src="${objUrl(f.mini || f.blob)}" alt="Foto ${i + 1}">
      <button class="del" data-del="${i}" aria-label="Quitar foto">&times;</button>
      <button class="ver" data-ver="${i}" aria-label="Ver foto completa">&#128269;</button>
      ${i === 0 ? '<span class="main">Principal</span>' : ''}
    </div>`).join('');
}

/* Muestra una foto en tamaño completo (toca para cerrar). */
let urlVisor = null;
function verFoto(f) {
  if (!f) return;
  if (urlVisor) URL.revokeObjectURL(urlVisor);
  urlVisor = URL.createObjectURL(f.blob);
  $('#visorImg').src = urlVisor;
  $('#visorPie').textContent = f.lat != null ? `${coordTxt(f.lat, f.lon)} · ${fechaTxt(f.fecha)} ${horaTxt(f.fecha)}` : `${fechaTxt(f.fecha)} ${horaTxt(f.fecha)}`;
  $('#visor').hidden = false;
}
function cerrarVisor() {
  $('#visor').hidden = true;
  $('#visorImg').removeAttribute('src');
  if (urlVisor) { URL.revokeObjectURL(urlVisor); urlVisor = null; }
}

async function fijarUbicacion() {
  if (!pos) { toast('Esperando señal GPS…'); return; }
  Object.assign(cur, { lat: pos.lat, lon: pos.lon, acc: pos.acc, alt: pos.alt });
  dirty = true;
  await autoKm();
  renderUbic();
  toast('Ubicación actualizada');
}

async function agregarFotos(files, fuente) {
  if (!files || !files.length) return;
  leerForm();
  busy('Procesando foto…');
  try {
    let sinGpsGaleria = 0;
    const nuevas = [];
    for (const [i, f] of files.entries()) {
      const foto = await procesarFoto(f, fuente, i);
      if (fuente === 'gal' && foto.lat == null) sinGpsGaleria++;
      cur.fotos.push(foto);
      nuevas.push(foto);
      if (cur.lat == null && foto.lat != null) Object.assign(cur, { lat: foto.lat, lon: foto.lon, acc: foto.acc, alt: foto.alt });
    }
    dirty = true;
    sugerirTipo();
    sugerirEstado();
    await autoKm();
    sugerirDescripcion();
    if (fuente === 'cam' && lsGet('galeria') !== '0') for (const foto of nuevas) await copiarAGaleria(foto);
    renderFotos(); renderUbic();
    if (sinGpsGaleria) toast(`${sinGpsGaleria === 1 ? 'La foto no tiene' : sinGpsGaleria + ' fotos no tienen'} coordenadas en sus metadatos. Usa "Usar ubicación actual" si estás en la estructura.`, 5000);
    else if (cur.lat == null) toast('Sin GPS todavía: la foto se guardó sin coordenadas');
  } catch (err) {
    alert('No se pudo procesar la foto: ' + mensajeError(err));
  } finally {
    idle();
  }
}

const blobB64 = b => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(b);
});

window.__galeriaHecha = ok => { if (!ok) toast('No se pudo guardar la foto en la galería'); };

/* Guarda una foto de cámara en la galería del teléfono (álbum RecorridoCanal) con GPS y fecha en su EXIF. */
let fotosPendientes = []; // versión web: fotos de cámara por guardar en Fotos (iOS pide un toque del usuario)

async function copiarAGaleria(foto) {
  const d = new Date(foto.fecha), codigo = $('#fCodigo').value.trim() || cur.codigo;
  const canal = foto.lat != null ? canalEn(foto.lat, foto.lon) : rec.canal;
  const nombre = `${slug(canal)}_${slug(codigo)}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jpg`;
  const desc = `${canal} | ${codigo}${tipoDe(cur) ? ' | ' + tipoDe(cur) : ''}` + (foto.lat != null ? ` | ${coordTxt(foto.lat, foto.lon)}` : '');
  if (APP) {
    if (Android.guardarEnGaleria) Android.guardarEnGaleria(nombre, await blobB64(foto.blob),
      foto.lat ?? 999, foto.lon ?? 999, foto.alt ?? -99999, foto.fecha, desc, rec.canal); // 999 / -99999 = sin dato
    return;
  }
  const bytes = conExif(new Uint8Array(await foto.blob.arrayBuffer()), { lat: foto.lat, lon: foto.lon, alt: foto.alt, fecha: foto.fecha, desc });
  fotosPendientes.push(new File([bytes], nombre, { type: 'image/jpeg' }));
  renderBotonFotos();
}

function renderBotonFotos() {
  const b = $('#btnGuardarFotos'), n = fotosPendientes.length;
  b.hidden = APP || !n;
  b.textContent = `Guardar ${n} foto${n === 1 ? '' : 's'} en Fotos (con ubicación)`;
}

/* iOS solo permite guardar en Fotos desde el menú Compartir ("Guardar imagen"), tras un toque del usuario. */
async function guardarFotosPendientes() {
  if (!fotosPendientes.length) return;
  await compartirArchivos(fotosPendientes);
  fotosPendientes = [];
  renderBotonFotos();
}

/* Inserta en un JPEG los metadatos EXIF: GPS (lat, lon, alt), fecha de toma y descripción. */
function conExif(jpg, { lat, lon, alt, fecha, desc }) {
  const u16 = v => [(v >> 8) & 255, v & 255], u32 = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const ascii = s => ({ type: 2, data: [...String(s).normalize('NFD').replace(/[^\x20-\x7E]/g, '')].map(c => c.charCodeAt(0)).concat(0) });
  const rac = pares => ({ type: 5, data: pares.flatMap(([n, d]) => [...u32(n), ...u32(d)]) });
  const gms = v => { v = Math.abs(v); const g = Math.floor(v), m = (v - g) * 60, mi = Math.floor(m); return [[g, 1], [mi, 1], [Math.min(599999, Math.round((m - mi) * 600000)), 10000]]; };
  const f = new Date(fecha), fTxt = `${f.getFullYear()}:${pad(f.getMonth() + 1)}:${pad(f.getDate())} ${pad(f.getHours())}:${pad(f.getMinutes())}:${pad(f.getSeconds())}`;
  const largo = e => e.type === 5 ? e.data.length / 8 : e.type === 4 ? e.data.length / 4 : e.data.length; // nº de valores
  // Construye un IFD ubicado en `inicio` (desplazamiento dentro del TIFF); los valores largos van después de él
  const ifd = (entradas, inicio) => {
    const lista = Object.entries(entradas).map(([t, e]) => ({ tag: +t, ...e })).sort((a, b) => a.tag - b.tag);
    const tam = 2 + lista.length * 12 + 4, cab = [...u16(lista.length)], datos = [];
    for (const e of lista) {
      cab.push(...u16(e.tag), ...u16(e.type), ...u32(largo(e)));
      if (e.data.length <= 4) cab.push(...e.data, ...Array(4 - e.data.length).fill(0));
      else { cab.push(...u32(inicio + tam + datos.length)); datos.push(...e.data); if (datos.length % 2) datos.push(0); }
    }
    return [...cab, 0, 0, 0, 0, ...datos];
  };
  const LONG = v => ({ type: 4, data: u32(v) });
  const ifd0 = p => ({ 0x010E: ascii(desc || ''), 0x0131: ascii('Recorrido Canal'), 0x0132: ascii(fTxt), 0x8769: LONG(p.exif), 0x8825: LONG(p.gps) });
  const exif = { 0x9003: ascii(fTxt) };
  const gps = { 0x0000: { type: 1, data: [2, 2, 0, 0] } };
  if (lat != null && lon != null) {
    Object.assign(gps, {
      0x0001: ascii(lat >= 0 ? 'N' : 'S'), 0x0002: rac(gms(lat)),
      0x0003: ascii(lon >= 0 ? 'E' : 'W'), 0x0004: rac(gms(lon))
    });
    if (alt != null && isFinite(alt)) Object.assign(gps, { 0x0005: { type: 1, data: [alt < 0 ? 1 : 0] }, 0x0006: rac([[Math.round(Math.abs(alt) * 100), 100]]) });
  }
  const l0 = ifd(ifd0({ exif: 0, gps: 0 }), 8).length;
  const lExif = ifd(exif, 8 + l0).length;
  const p = { exif: 8 + l0, gps: 8 + l0 + lExif };
  const tiff = [0x4D, 0x4D, 0, 42, ...u32(8), ...ifd(ifd0(p), 8), ...ifd(exif, p.exif), ...ifd(gps, p.gps)];
  const app1 = [0xFF, 0xE1, ...u16(2 + 6 + tiff.length), 0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  // Se inserta después del encabezado JFIF (APP0) si existe
  let pos = 2;
  if (jpg[2] === 0xFF && jpg[3] === 0xE0) pos = 4 + ((jpg[4] << 8) | jpg[5]);
  const out = new Uint8Array(jpg.length + app1.length);
  out.set(jpg.subarray(0, pos)); out.set(app1, pos); out.set(jpg.subarray(pos), pos + app1.length);
  return out;
}

async function guardar() {
  leerForm();
  if (!tipoDe(cur)) { toast('Elige el tipo de estructura'); $('#fTipo').focus(); return; }
  if (!cur.fotos.length && !confirm('La estructura no tiene fotos. ¿Guardar de todos modos?')) return;
  delete cur.nuevo;
  cur.mod = Date.now();
  await dbPut('estructuras', cur);
  await aprender(cur);
  dirty = false;
  toast(`${cur.codigo} guardada`);
  renderRec();
}

async function eliminarEstructura() {
  if (!confirm(`¿Eliminar la estructura ${cur.codigo}?`)) return;
  await dbDel('estructuras', cur.id);
  dirty = false;
  renderRec();
}

function salirForm() {
  if (dirty && !confirm('Hay cambios sin guardar. ¿Salir sin guardar?')) return;
  dirty = false;
  renderRec();
}

window.appBack = function () {
  if (!$('#overlay').hidden || !$('#dlgSentido').hidden) return true;
  if (!$('#visor').hidden) { cerrarVisor(); return true; }
  if (!$('#dlg').hidden) { $('#dlg').hidden = true; return true; }
  if (vista === 'est') { salirForm(); return true; }
  if (vista === 'rec') { renderInicio(); return true; }
  return false;
};

/* ---------- Fotos georreferenciadas ---------- */

/* iOS limita la memoria total de lienzos (canvas) y la libera tarde: se suelta en cuanto se termina de usar. */
function soltar(...lienzos) { for (const c of lienzos) if (c) { c.width = 0; c.height = 0; } }

/* Miniatura ligera (360 px) para listas y cuadrícula de fotos: evita abrir decenas de fotos grandes a la vez. */
async function miniatura(fuente, max = 360) {
  const w = fuente.naturalWidth || fuente.width, h = fuente.naturalHeight || fuente.height;
  const k = Math.min(1, max / Math.max(w, h));
  const m = document.createElement('canvas');
  m.width = Math.round(w * k); m.height = Math.round(h * k);
  m.getContext('2d').drawImage(fuente, 0, 0, m.width, m.height);
  const b = await new Promise(r => m.toBlob(r, 'image/jpeg', 0.75));
  soltar(m);
  return b;
}

/* Fotos guardadas con versiones anteriores no tienen miniatura: se crea una por una y se guarda. */
let creandoMinis = false;
async function asegurarMinis(ests) {
  if (creandoMinis) return;
  creandoMinis = true;
  try {
    for (const e of ests) {
      const faltan = e.fotos.map((f, i) => f.mini ? -1 : i).filter(i => i >= 0);
      if (!faltan.length) continue;
      const minis = {};
      for (const i of faltan) {
        const img = await loadImage(e.fotos[i].blob);
        minis[i] = await miniatura(img);
        img.src = '';
      }
      // Se relee el registro para no pisar cambios hechos mientras tanto
      const fresco = await dbGet('estructuras', e.id);
      if (!fresco) continue;
      for (const i of faltan) if (fresco.fotos[i] && fresco.fotos[i].fecha === e.fotos[i].fecha) fresco.fotos[i].mini = minis[i];
      await dbPut('estructuras', fresco);
      const el = vista === 'rec' && document.querySelector(`#listaEst .item[data-id="${e.id}"] img`);
      if (el && minis[0]) el.src = objUrl(minis[0]);
    }
  } catch (err) {
    console.warn('Miniaturas', err);
  } finally {
    creandoMinis = false;
  }
}

function loadImage(blob) {
  return new Promise((res, rej) => {
    const u = URL.createObjectURL(blob);
    const i = new Image();
    i.onload = () => { URL.revokeObjectURL(u); res(i); };
    i.onerror = () => { URL.revokeObjectURL(u); rej(new Error('imagen no válida')); };
    i.src = u;
  });
}

/* Lee las coordenadas GPS del EXIF de un JPEG (para fotos tomadas de la galería). */
async function exifGPS(file) {
  try {
    const v = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (v.getUint16(0) !== 0xFFD8) return null;
    let o = 2;
    while (o < v.byteLength - 4) {
      const m = v.getUint16(o);
      if (m === 0xFFE1 && v.getUint32(o + 4) === 0x45786966) return gpsDeTiff(v, o + 10);
      if ((m & 0xFF00) !== 0xFF00) break;
      o += 2 + v.getUint16(o + 2);
    }
  } catch (e) { /* EXIF ilegible */ }
  return null;
}
function gpsDeTiff(v, t) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = o => v.getUint16(o, le), u32 = o => v.getUint32(o, le);
  const ifd0 = t + u32(t + 4);
  let gps = null;
  for (let i = 0; i < u16(ifd0); i++) if (u16(ifd0 + 2 + i * 12) === 0x8825) gps = t + u32(ifd0 + 2 + i * 12 + 8);
  if (gps == null) return null;
  const rat = (off, n) => Array.from({ length: n }, (_, k) => u32(off + k * 8) / u32(off + k * 8 + 4));
  const r = {};
  for (let i = 0; i < u16(gps); i++) {
    const e = gps + 2 + i * 12, tag = u16(e);
    if (tag === 1 || tag === 3) r[tag] = String.fromCharCode(v.getUint8(e + 8));
    else if (tag === 2 || tag === 4) r[tag] = rat(t + u32(e + 8), 3);
    else if (tag === 6) r[6] = rat(t + u32(e + 8), 1)[0];
  }
  if (!r[2] || !r[4]) return null;
  const dec = a => a[0] + a[1] / 60 + a[2] / 3600;
  const lat = dec(r[2]) * (r[1] === 'S' ? -1 : 1), lon = dec(r[4]) * (r[3] === 'W' ? -1 : 1);
  if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) return null;
  return { lat, lon, acc: null, alt: isFinite(r[6]) ? r[6] : null };
}

/* GPS y fecha que Android leyó del EXIF original de la foto i de la galería (o null). */
function exifNativo(i) {
  if (!APP || !Android.galeriaGps) return null;
  try { return JSON.parse(Android.galeriaGps())[i] || null; } catch (e) { return null; }
}

/* Reduce la foto a 1600 px y le graba canal, clave, coordenadas y fecha.
   Cámara: GPS actual del teléfono. Galería: GPS y fecha de los metadatos (EXIF) de la foto. */
async function procesarFoto(file, fuente, i = 0) {
  let geo = null, fechaExif = null;
  if (fuente === 'cam') {
    if (pos && Date.now() - pos.t < 120000) geo = { ...pos };
    if (!geo) geo = await exifGPS(file);
  } else {
    const nat = exifNativo(i);
    if (nat && isFinite(nat.lat) && isFinite(nat.lon)) geo = { lat: nat.lat, lon: nat.lon, acc: null, alt: isFinite(nat.alt) ? nat.alt : null };
    if (!geo) geo = await exifGPS(file);
    if (nat && nat.fecha) fechaExif = nat.fecha;
  }
  const img = await loadImage(file);
  const k = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('el teléfono se quedó sin memoria para procesar fotos; cierra y vuelve a abrir la app');
  g.drawImage(img, 0, 0, w, h);
  img.src = '';
  const emb = await huella(c);              // para identificar el tipo (antes del sello)
  if (lsGet('mejorar') !== '0') mejorarImagen(c);

  const fecha = fuente === 'cam' ? Date.now() : (fechaExif || file.lastModified || Date.now());
  const fs = Math.max(14, Math.round(Math.min(w, h) * 0.03)), lh = fs * 1.3;
  const lineas = [
    `${geo ? canalEn(geo.lat, geo.lon) : rec.canal} · ${$('#fCodigo').value.trim() || cur.codigo}`,
    geo ? `${coordTxt(geo.lat, geo.lon)}${geo.acc ? '  ±' + Math.round(geo.acc) + ' m' : ''}` : 'Sin coordenadas GPS',
    `${fechaTxt(fecha)}  ${horaTxt(fecha)}`
  ];
  const bh = Math.round(lh * lineas.length + fs * 0.8);
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(0, h - bh, w, bh);
  g.fillStyle = '#fff';
  g.font = `600 ${fs}px sans-serif`;
  g.textBaseline = 'top';
  lineas.forEach((t, i) => g.fillText(t, fs * 0.6, h - bh + fs * 0.4 + i * lh, w - fs * 1.2));

  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
  const mini = await miniatura(c);
  soltar(c);
  return { blob, mini, w, h, emb, lat: geo ? geo.lat : null, lon: geo ? geo.lon : null, acc: geo ? geo.acc : null, alt: geo ? geo.alt : null, fecha, fuente };
}

/* ---------- Mejora automática de imagen (sin internet) ---------- */

/* Niveles automáticos, balance de blancos moderado, aclarado de sombras, color y nitidez. */
function mejorarImagen(c) {
  const w = c.width, h = c.height, g = c.getContext('2d');
  const im = g.getImageData(0, 0, w, h), d = im.data;
  const hist = new Uint32Array(256);
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let i = 0; i < d.length; i += 16) {
    const r = d[i], gg = d[i + 1], b = d[i + 2];
    hist[(r * 77 + gg * 150 + b * 29) >> 8]++;
    sr += r; sg += gg; sb += b; n++;
  }
  // Puntos de negro y blanco (0.5 % de recorte), sin estirar de más
  let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.005) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.005) { hi = v; break; } }
  lo = Math.min(lo, 50); hi = Math.max(hi, 200);
  // Balance de blancos "mundo gris" al 50 % y limitado a ±12 %
  const prom = (sr + sg + sb) / 3 / n, lim = x => 1 + (Math.max(0.88, Math.min(1.12, x)) - 1) * 0.5;
  const kr = lim(prom / (sr / n)), kg = lim(prom / (sg / n)), kb = lim(prom / (sb / n));
  // Aclarar sombras si la foto quedó oscura
  let media = 0;
  for (let v = 0; v < 256; v++) media += hist[v] * v;
  const mediaN = (media / n - lo) / (hi - lo);
  const gamma = mediaN < 0.38 ? 0.78 : mediaN < 0.46 ? 0.88 : 1;
  const tabla = kc => {
    const t = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) t[v] = Math.pow(Math.max(0, Math.min(1, (v * kc - lo) / (hi - lo))), gamma) * 255;
    return t;
  };
  const TR = tabla(kr), TG = tabla(kg), TB = tabla(kb), SAT = 1.1;
  for (let i = 0; i < d.length; i += 4) {
    const r = TR[d[i]], gg = TG[d[i + 1]], b = TB[d[i + 2]], l = 0.299 * r + 0.587 * gg + 0.114 * b;
    d[i] = l + (r - l) * SAT; d[i + 1] = l + (gg - l) * SAT; d[i + 2] = l + (b - l) * SAT;
  }
  g.putImageData(im, 0, 0);
  // Nitidez (máscara de desenfoque)
  const bc = document.createElement('canvas');
  bc.width = w; bc.height = h;
  const bg = bc.getContext('2d');
  bg.filter = 'blur(1.2px)';
  let bd;
  if (bg.filter === 'blur(1.2px)') {
    bg.drawImage(c, 0, 0);
    bd = bg.getImageData(0, 0, w, h).data;
  } else {
    bd = desenfoque3x3(d, w, h); // Safari (iPhone) no tiene filtros de canvas
  }
  for (let i = 0; i < d.length; i += 4) {
    d[i] += 0.55 * (d[i] - bd[i]); d[i + 1] += 0.55 * (d[i + 1] - bd[i + 1]); d[i + 2] += 0.55 * (d[i + 2] - bd[i + 2]);
  }
  g.putImageData(im, 0, 0);
  soltar(bc);
}

/* Desenfoque de caja 3×3 (en dos pasadas) para la máscara de nitidez cuando no hay ctx.filter. */
function desenfoque3x3(d, w, h) {
  const tmp = new Uint8ClampedArray(d.length), out = new Uint8ClampedArray(d.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, a = x > 0 ? i - 4 : i, b = x < w - 1 ? i + 4 : i;
      for (let k = 0; k < 3; k++) tmp[i + k] = (d[a + k] + d[i + k] + d[b + k]) / 3;
    }
  }
  const fila = w * 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, a = y > 0 ? i - fila : i, b = y < h - 1 ? i + fila : i;
      for (let k = 0; k < 3; k++) out[i + k] = (tmp[a + k] + tmp[i + k] + tmp[b + k]) / 3;
    }
  }
  return out;
}

/* Reduce una foto para insertarla en el Word o el KMZ (evita archivos enormes). */
async function reducir(blob, max) {
  const img = await loadImage(blob);
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  if (k === 1) return blob;
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  img.src = '';
  const b = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
  soltar(c);
  return b;
}

/* ---------- Identificación del tipo de estructura (aprende de las fotos del usuario) ---------- */

let modelo = null, cargaModelo = null, ejemplos = [];

/* Carga MobileNetV2 (incluido en la app, sin internet). Devuelve null si el dispositivo no puede. */
function cargarModelo() {
  if (!cargaModelo) {
    cargaModelo = (async () => {
      try {
        if (!window.tf) return null;
        await tf.ready();
        modelo = await tf.loadLayersModel('lib/mobilenet/model.json');
        tf.tidy(() => modelo.predict(tf.zeros([1, 224, 224, 3])));
        return modelo;
      } catch (e) { console.warn('Modelo no disponible', e); return null; }
    })();
  }
  return cargaModelo;
}

/* Huella de la foto: vector de 1280 rasgos visuales normalizado (centro de la imagen a 224×224). */
async function huella(c) {
  const m = await cargarModelo();
  if (!m) return null;
  const s = 224, lado = Math.min(c.width, c.height);
  const t = document.createElement('canvas');
  t.width = t.height = s;
  t.getContext('2d').drawImage(c, (c.width - lado) / 2, (c.height - lado) / 2, lado, lado, 0, 0, s, s);
  const v = tf.tidy(() => {
    const x = tf.browser.fromPixels(t).toFloat().div(127.5).sub(1).expandDims(0);
    const f = m.predict(x).mean([1, 2]).squeeze();
    return f.div(f.norm());
  });
  soltar(t);
  const arr = await v.data();
  v.dispose();
  return new Float32Array(arr);
}

async function cargarEjemplos() { ejemplos = await dbAll('ejemplos'); }

/* Resta a cada huella lo que todas las fotos tienen en común (cielo, tierra, vegetación)
   para resaltar lo que distingue a cada tipo de estructura. */
function centrar(v, media) {
  const r = new Float32Array(v.length);
  let n = 0;
  for (let i = 0; i < v.length; i++) { r[i] = v[i] - media[i]; n += r[i] * r[i]; }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) r[i] /= n;
  return r;
}

/* Compara la huella con los ejemplos guardados (k vecinos más parecidos) y vota el valor de `campo`
   ('tipo' o 'estado'). Devuelve también el ejemplo más parecido, para proponer su descripción. */
function identificar(emb, campo = 'tipo') {
  const base = ejemplos.filter(ej => ej[campo]);
  if (!emb || !base.length) return null;
  const D = emb.length, media = new Float32Array(D);
  const varios = new Set(base.map(e => e[campo])).size > 1 && base.length >= 4;
  if (varios) base.forEach(ej => { for (let i = 0; i < D; i++) media[i] += ej.vec[i] / base.length; });
  const v = varios ? centrar(emb, media) : emb;
  const sims = base.map(ej => {
    const u = varios ? centrar(ej.vec, media) : ej.vec;
    let s = 0, cruda = 0;
    for (let i = 0; i < D; i++) { s += v[i] * u[i]; cruda += emb[i] * ej.vec[i]; }
    return { valor: ej[campo], s, cruda, ej };
  }).sort((a, b) => b.s - a.s).slice(0, 7);
  const votos = {};
  sims.forEach(x => { votos[x.valor] = (votos[x.valor] || 0) + Math.max(0, x.s) ** 4; });
  const total = Object.values(votos).reduce((a, b) => a + b, 0);
  const [valor, votoGanador] = Object.entries(votos).sort((a, b) => b[1] - a[1])[0];
  const clases = new Set(base.map(e => e[campo])).size;
  return {
    valor, tipo: valor, conf: total ? votoGanador / total : 0, parecido: sims[0].cruda, clases,
    n: base.filter(e => e[campo] === valor).length, vecino: sims[0].ej
  };
}

/* Al guardar una estructura, sus fotos se vuelven ejemplos de su tipo, estado y descripción (o de lo corregido). */
async function aprender(e) {
  const tipo = tipoDe(e);
  if (!tipo) return;
  const viejos = ejemplos.filter(x => x.estId === e.id);
  for (const x of viejos) await dbDel('ejemplos', x.id);
  ejemplos = ejemplos.filter(x => x.estId !== e.id);
  for (const [i, f] of e.fotos.entries()) {
    if (!f.emb) continue;
    const ej = { id: `${e.id}_${i}`, estId: e.id, codigo: e.codigo, tipo, estado: e.estado || '', desc: e.desc || '', vec: f.emb };
    await dbPut('ejemplos', ej);
    ejemplos.push(ej);
  }
}

/* Sugiere tipo, estado y descripción a partir de la foto principal. */
function sugerir() {
  sugerirTipo();
  sugerirEstado();
  sugerirDescripcion();
}

function sugerirEstado() {
  const box = $('#fSugEstado');
  const f = cur.fotos.find(x => x.emb);
  const r = f && identificar(f.emb, 'estado');
  if (!r || r.parecido < 0.35) { box.hidden = true; return; }
  const pct = Math.round(r.conf * 100), segura = pct >= 70 && r.clases >= 2;
  if (segura && !cur.estadoManual && cur.nuevo) { cur.estado = r.valor; renderEstado(); }
  const datos = `${pct} % · ${r.n} ejemplo${r.n === 1 ? '' : 's'}${r.clases < 2 ? ', aún aprendiendo' : ''}`;
  box.hidden = false;
  box.className = 'sug ' + (segura ? 'alta' : 'media');
  box.innerHTML = segura
    ? `Estado propuesto: <b>${esc(r.valor)}</b> (${datos}). Si no es correcto, toca el estado real.`
    : `Posiblemente en estado <b>${esc(r.valor)}</b> (${datos}).<br><button type="button" class="btn ghost" data-usar-estado="${esc(r.valor)}">Usar "${esc(r.valor)}"</button>`;
}

const FEMENINOS = /^(toma|represa|compuerta|alcantarilla|caída|rápida|entrada|canaleta|estructura|obra|presa|válvula)/i;

/* Primera frase de la descripción: tipo, cadenamiento, canal y estado. */
function frasePlantilla() {
  const tipo = tipoDe(cur);
  if (!tipo) return '';
  const km = $('#fKm').value.trim();
  const canal = cur.tramoCanal || rec.canal;
  const lugar = km ? ` en el Km ${km}${canal ? ` del ${canal}` : ''}` : (canal ? ` en el ${canal}` : '');
  return `${tipo} ubicad${FEMENINOS.test(tipo) ? 'a' : 'o'}${lugar}` +
    (cur.estado ? `, en estado físico ${cur.estado.toLowerCase()}` : '') + '.';
}

/* Propone la descripción: frase con los datos conocidos + lo escrito en la estructura más parecida del mismo tipo. */
function propuestaDescripcion() {
  const frase = frasePlantilla();
  if (!frase) return { texto: '', base: null };
  const f = cur.fotos.find(x => x.emb);
  let base = null;
  if (f) {
    const mismos = ejemplos.filter(ej => ej.tipo === tipoDe(cur) && ej.desc && ej.estId !== cur.id);
    let mejor = -1;
    for (const ej of mismos) {
      let s = 0;
      for (let i = 0; i < f.emb.length; i++) s += f.emb[i] * ej.vec[i];
      if (s > mejor) { mejor = s; base = ej; }
    }
  }
  // De la estructura parecida se toma el detalle, sin su propia frase de ubicación
  const detalle = base ? base.desc.replace(/^[^.]*\bubicad[oa]\b[^.]*\.\s*/i, '').trim() : '';
  return { texto: detalle ? `${frase} ${detalle}` : frase, base: detalle ? base : null };
}

/* Llena la descripción con la propuesta mientras el usuario no la haya escrito o editado. */
function sugerirDescripcion() {
  const box = $('#fSugDesc'), campo = $('#fDesc');
  const p = propuestaDescripcion();
  if (!p.texto || !cur.nuevo) { box.hidden = true; return; }
  const libre = !campo.value.trim() || campo.value === cur.descAuto;
  if (libre) { campo.value = p.texto; cur.descAuto = p.texto; }
  box.hidden = false;
  box.className = 'sug media';
  box.innerHTML = (libre
    ? 'Descripción <b>propuesta</b>' + (p.base ? ` con base en ${esc(p.base.codigo || 'una estructura parecida')}` : '') + '. Revísala y corrígela con lo que observas.'
    : 'Ya escribiste tu propia descripción.') +
    (!libre ? `<br><button type="button" class="btn ghost" data-usar-desc="1">Reemplazar por la propuesta</button>` : '');
  box.dataset.propuesta = p.texto;
}

/* Sugiere el tipo de la estructura a partir de su foto principal, salvo que el usuario ya lo haya elegido. */
function sugerirTipo() {
  const box = $('#fSugerencia');
  const f = cur.fotos.find(x => x.emb);
  if (!f) { box.hidden = true; return; }
  const r = identificar(f.emb, 'tipo');
  box.hidden = false;
  if (!r || r.parecido < 0.35) {
    box.innerHTML = ejemplos.length
      ? 'No reconozco esta estructura todavía. Elige el tipo: al guardar, la app aprenderá de esta foto.'
      : 'La app está aprendiendo: elige el tipo y al guardar aprenderá a reconocerlo en las siguientes fotos.';
    box.className = 'sug nueva';
    return;
  }
  const pct = Math.round(r.conf * 100), segura = pct >= 70 && r.clases >= 2;
  // Solo se selecciona sola cuando la confianza es alta; si no, queda como sugerencia
  if (segura && !cur.tipoManual && cur.nuevo) {
    if (TIPOS.includes(r.tipo)) { cur.tipo = r.tipo; cur.tipoOtro = ''; } else { cur.tipo = 'Otra'; cur.tipoOtro = r.tipo; }
    $('#fTipo').value = cur.tipo; $('#fTipoOtro').value = cur.tipoOtro; $('#lblOtro').hidden = cur.tipo !== 'Otra';
  }
  const datos = `${pct} % · ${r.n} ejemplo${r.n === 1 ? '' : 's'}${r.clases < 2 ? ', aún aprendiendo' : ''}`;
  box.innerHTML = segura
    ? `Identificada como <b>${esc(r.tipo)}</b> (${datos}).<br>Si no es correcta, elige el tipo correcto arriba.`
    : `Posiblemente: <b>${esc(r.tipo)}</b> (${datos}).<br><button type="button" class="btn ghost" data-usar-tipo="${esc(r.tipo)}">Usar "${esc(r.tipo)}"</button>`;
  box.className = 'sug ' + (segura ? 'alta' : 'media');
}

/* ---------- Mapas satelitales (imagen con marcador) ---------- */

const lon2px = (lon, z) => (lon + 180) / 360 * 256 * 2 ** z;
const lat2px = (lat, z) => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z; };
const px2lat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / (256 * 2 ** z)))) * 180 / Math.PI;

const tileCache = new Map();
const pendientes = {};
let seq = 0;
window.__fetchDone = (id, b64) => { const f = pendientes[id]; delete pendientes[id]; if (f) f(b64); };

function imgDeSrc(src) {
  return new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
}
function descargarTile(url) {
  return APP
    ? new Promise(res => { const id = 't' + (++seq); pendientes[id] = res; Android.fetchAsync(url, id); })
      .then(b64 => b64 ? imgDeSrc('data:image/jpeg;base64,' + b64) : null)
    : fetch(url).then(r => r.ok ? r.blob() : null).then(b => b ? loadImage(b) : null).catch(() => null);
}

/* Descarga un mosaico satelital con hasta 3 intentos; solo se guardan en caché los que sí llegaron. */
async function tile(z, x, y) {
  const url = TILE_URL.replace('{z}', z).replace('{y}', y).replace('{x}', x);
  if (tileCache.has(url)) return tileCache.get(url);
  for (let intento = 1; intento <= 3; intento++) {
    const im = await descargarTile(url);
    if (im) { tileCache.set(url, im); return im; }
    await new Promise(r => setTimeout(r, 1000 * intento));
  }
  return null;
}

function fitView(pts, W, H) {
  let la0 = Infinity, la1 = -Infinity, lo0 = Infinity, lo1 = -Infinity;
  for (const p of pts) { la0 = Math.min(la0, p.lat); la1 = Math.max(la1, p.lat); lo0 = Math.min(lo0, p.lon); lo1 = Math.max(lo1, p.lon); }
  for (let z = 17; z >= 3; z--) {
    const x0 = lon2px(lo0, z), x1 = lon2px(lo1, z), y0 = lat2px(la1, z), y1 = lat2px(la0, z);
    if ((x1 - x0 <= W - 140 && y1 - y0 <= H - 140) || z === 3) {
      // El centro se calcula en píxeles del mismo zoom con el que se dibuja el mapa
      const zf = pts.length === 1 ? 16 : z;
      return { z: zf, cx: (lon2px(lo0, zf) + lon2px(lo1, zf)) / 2, cy: (lat2px(la1, zf) + lat2px(la0, zf)) / 2 };
    }
  }
}

function pin(g, x, y, color, label, grande) {
  const r = grande ? 11 : 8, cy = y - r * 2.3;
  g.save();
  g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = 5;
  g.beginPath();
  g.moveTo(x, y);
  g.quadraticCurveTo(x - r, cy + r * 0.9, x - r, cy);
  g.arc(x, cy, r, Math.PI, 0);
  g.quadraticCurveTo(x + r, cy + r * 0.9, x, y);
  g.fillStyle = color; g.fill();
  g.shadowBlur = 0; g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
  g.beginPath(); g.arc(x, cy, r * 0.38, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
  if (label) {
    const fs = grande ? 17 : 13;
    g.font = `bold ${fs}px sans-serif`;
    const tw = g.measureText(label).width, bx = x + r + 4, by = cy - fs * 0.7;
    g.fillStyle = 'rgba(255,255,255,.92)';
    g.fillRect(bx, by, tw + 10, fs * 1.4);
    g.fillStyle = '#111'; g.textBaseline = 'middle';
    g.fillText(label, bx + 5, by + fs * 0.7);
  }
  g.restore();
}

/* Dibuja un mapa satelital W×H centrado en (cx, cy) píxeles del zoom z, con el trazo del canal y marcadores. */
async function renderMap(v, W, H, marcas, lineas = []) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#cfd6de'; g.fillRect(0, 0, W, H);
  const x0 = v.cx - W / 2, y0 = v.cy - H / 2, n = 2 ** v.z;
  let ok = 0, total = 0;
  const trabajos = [];
  for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + W) / 256); tx++)
    for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + H) / 256); ty++) {
      if (ty < 0 || ty >= n) continue;
      total++;
      trabajos.push(tile(v.z, ((tx % n) + n) % n, ty).then(im => { if (im) { g.drawImage(im, tx * 256 - x0, ty * 256 - y0); ok++; } }));
    }
  await Promise.all(trabajos);
  if (!ok) {
    g.fillStyle = '#555'; g.font = 'bold 18px sans-serif'; g.textAlign = 'center';
    g.fillText('Mapa no disponible (sin conexión a internet)', W / 2, 40);
    g.textAlign = 'left';
  }
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  for (const [w, col] of [[7, 'rgba(0,0,0,.45)'], [3.5, '#00e5ff']]) {
    g.lineWidth = w; g.strokeStyle = col;
    for (const l of lineas) {
      g.beginPath();
      l.coords.forEach(([lon, lat], i) => { const x = lon2px(lon, v.z) - x0, y = lat2px(lat, v.z) - y0; i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.stroke();
    }
  }
  g.restore();
  const enMapa = m => ({ ...m, x: lon2px(m.lon, v.z) - x0, y: lat2px(m.lat, v.z) - y0 });
  marcas.map(enMapa).filter(m => m.x > -20 && m.x < W + 20 && m.y > -20 && m.y < H + 40)
    .sort((a, b) => a.grande - b.grande)
    .forEach(m => pin(g, m.x, m.y, m.color, m.label, m.grande));

  // Escala gráfica
  const mpp = 156543.03392 * Math.cos(px2lat(v.cy, v.z) * Math.PI / 180) / n;
  const meta = W * 0.22 * mpp, p10 = 10 ** Math.floor(Math.log10(meta));
  const dist = [1, 2, 5, 10].map(k => k * p10).filter(d => d <= meta).pop();
  const bw = dist / mpp, txt = dist >= 1000 ? dist / 1000 + ' km' : dist + ' m';
  g.fillStyle = 'rgba(255,255,255,.88)'; g.fillRect(10, H - 38, bw + 20, 28);
  g.fillStyle = '#111'; g.fillRect(20, H - 18, bw, 4);
  g.fillRect(20, H - 24, 2, 10); g.fillRect(20 + bw - 2, H - 24, 2, 10);
  g.font = 'bold 12px sans-serif'; g.textBaseline = 'alphabetic'; g.fillText(txt, 24, H - 23);
  // Norte
  g.fillStyle = 'rgba(255,255,255,.88)'; g.beginPath(); g.arc(W - 26, 30, 18, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#c62828'; g.beginPath(); g.moveTo(W - 26, 15); g.lineTo(W - 33, 34); g.lineTo(W - 19, 34); g.fill();
  g.fillStyle = '#111'; g.font = 'bold 11px sans-serif'; g.textAlign = 'center'; g.fillText('N', W - 26, 45); g.textAlign = 'left';
  // Atribución
  g.font = '10px sans-serif';
  const at = 'Imagen: Esri World Imagery';
  const aw = g.measureText(at).width;
  g.fillStyle = 'rgba(255,255,255,.75)'; g.fillRect(W - aw - 10, H - 16, aw + 10, 16);
  g.fillStyle = '#333'; g.fillText(at, W - aw - 5, H - 4);
  return { canvas: c, ok: ok > 0, completo: ok === total };
}

/* Detecta los mosaicos grises "Map data not yet available" (zona sin imagen a ese zoom). */
function sinImagen(c) {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let gris = 0, n = 0;
  for (let y = 20; y < c.height - 20; y += 23) {
    for (let x = 20; x < c.width - 20; x += 23) {
      const i = (y * c.width + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
      n++;
      if (Math.abs(r - g) < 6 && Math.abs(g - b) < 6 && r > 185 && r < 225) gris++;
    }
  }
  return gris / n > 0.4;
}

const canvasBytes = c => new Promise(r => c.toBlob(r, 'image/jpeg', 0.88)).then(b => b.arrayBuffer()).then(a => new Uint8Array(a));

/* ---------- Guardar / compartir archivos ---------- */

let ultimo = null;
/* `datos`: texto base64 (Android) o Blob (versión web: evita duplicar el archivo en memoria). */
async function guardarArchivo(nombre, datos, mime, nota = '') {
  if (APP) {
    const b64 = typeof datos === 'string' ? datos : await blobB64(datos);
    Android.startFile(nombre);
    const CH = 1 << 20;
    for (let i = 0; i < b64.length; i += CH) { Android.appendFile(nombre, b64.slice(i, i + CH)); await tick(); }
    const r = Android.finishFile(nombre, mime);
    const sep = r.indexOf('|');
    if (r.slice(0, sep) !== 'OK') throw new Error(r.slice(sep + 1));
    ultimo = { nombre, mime };
    idle();
    $('#dlgMsg').innerHTML = `Archivo guardado en:<br><b>${esc(r.slice(sep + 1))}</b>${nota}`;
    $('#dlg').hidden = false;
  } else {
    // Versión web (iPhone): el archivo se entrega con el menú Compartir (Guardar en Archivos, WhatsApp, correo…)
    const blob = typeof datos === 'string' ? new Blob([b64Bytes(datos)], { type: mime }) : new Blob([datos], { type: mime });
    ultimo = { nombre, mime, blob };
    idle();
    $('#dlgMsg').innerHTML = `Archivo listo: <b>${esc(nombre)}</b><br>Usa <b>Compartir</b> y elige <i>Guardar en Archivos</i>, WhatsApp o correo.${nota}`;
    $('#dlg').hidden = false;
  }
}

/* Versión web: comparte archivos con el menú del sistema; si el navegador no puede, los descarga. */
async function compartirArchivos(archivos) {
  if (navigator.canShare && navigator.canShare({ files: archivos })) {
    try { await navigator.share({ files: archivos }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  for (const f of archivos) descargar(f, f.name);
}

function descargar(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* Mensaje entendible para el usuario, con los casos conocidos del teléfono. */
function mensajeError(e) {
  const nombre = e && e.name, texto = String((e && e.message) || e || 'desconocido');
  if (nombre === 'QuotaExceededError' || /quota/i.test(texto))
    return 'el teléfono no tiene espacio para guardar más. Respalda tus recorridos y libera espacio (fotos, videos, apps).';
  if (/memory|memoria|canvas/i.test(texto))
    return 'el teléfono se quedó sin memoria. Cierra la app por completo y vuelve a abrirla; tus datos se conservan.';
  return texto;
}

async function ejecutar(fn) {
  try { await fn(); }
  catch (e) { console.error(e); alert('Error: ' + mensajeError(e)); }
  finally { idle(); }
}

/* ---------- Reporte Word ---------- */

async function generarWord() {
  const ests = await estructurasDe(rec.id);
  if (!ests.length) { toast('No hay estructuras registradas'); return; }
  const D = window.docx;
  const { Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, WidthType, AlignmentType,
    HeadingLevel, BorderStyle, TableLayoutType, Footer, PageNumber, ShadingType, VerticalAlign } = D;

  // Mapas
  busy('Descargando imagen satelital…');
  const geo = ests.filter(e => e.lat != null);
  const marcas = geo.map(e => ({ id: e.id, lat: e.lat, lon: e.lon, label: e.codigo }));
  const lineas = rec.trazo ? rec.trazo.lineas : [];
  let mapasFallidos = 0, general = null;
  if (geo.length || lineas.length) {
    // Con estructuras se encuadra su zona (el trazo se dibuja alrededor); sin ellas, toda la red
    const extension = geo.length ? geo : lineas.flatMap(l => l.coords.map(c => ({ lon: c[0], lat: c[1] })));
    const m = await renderMap(fitView(extension, 1000, 620), 1000, 620, marcas.map(k => ({ ...k, color: '#e53935', grande: true })), lineas);
    if (!m.completo) mapasFallidos++;
    general = await canvasBytes(m.canvas);
    soltar(m.canvas);
  }
  const mapas = {};
  for (let i = 0; i < geo.length; i++) {
    const e = geo[i];
    busy(`Mapa de ubicación ${i + 1} de ${geo.length}…`);
    // Solo la estructura de la ficha, lo más cerca posible (zoom 18; si no hay imagen tan detallada, zoom 17)
    const propia = [{ id: e.id, lat: e.lat, lon: e.lon, label: e.codigo, grande: true, color: '#e53935' }];
    const dibujar = z => renderMap({ z, cx: lon2px(e.lon, z), cy: lat2px(e.lat, z) }, 640, 480, propia, lineas);
    let m = await dibujar(18);
    if (!m.completo || sinImagen(m.canvas)) { soltar(m.canvas); m = await dibujar(17); }
    if (!m.completo) mapasFallidos++;
    mapas[e.id] = await canvasBytes(m.canvas);
    soltar(m.canvas);
  }

  busy('Armando documento Word…');
  const ANCHO = 10224, MEDIO = ANCHO / 2;
  const NADA = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const LINEA = { style: BorderStyle.SINGLE, size: 4, color: '9AA7B5' };
  const SIN = { top: NADA, bottom: NADA, left: NADA, right: NADA, insideHorizontal: NADA, insideVertical: NADA };
  const CON = { top: LINEA, bottom: LINEA, left: LINEA, right: LINEA, insideHorizontal: LINEA, insideVertical: LINEA };

  const p = (text, o = {}) => new Paragraph({
    alignment: o.align, keepNext: o.keepNext, spacing: { before: o.before || 0, after: o.after ?? 80 },
    children: [new TextRun({ text, bold: o.bold, italics: o.italics, size: o.size, color: o.color })]
  });
  const imagen = (data, w, h, keepNext = false) => new Paragraph({
    alignment: AlignmentType.CENTER, keepNext, spacing: { after: 40 },
    children: [new ImageRun({ data, transformation: { width: Math.round(w), height: Math.round(h) } })]
  });
  const pie = (etiqueta, texto) => new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 120 },
    children: [new TextRun({ text: etiqueta + ' ', bold: true, size: 18 }), new TextRun({ text: texto, italics: true, size: 18 })]
  });
  const celda = (children, w, extra = {}) => new TableCell({
    width: { size: w, type: WidthType.DXA }, verticalAlign: VerticalAlign.TOP,
    margins: { top: 60, bottom: 60, left: 80, right: 80 }, children, ...extra
  });
  const fotoAjustada = async (f, maxW = 320, maxH = 330) => {
    const s = Math.min(maxW / f.w, maxH / f.h);
    return imagen(new Uint8Array(await (await reducir(f.blob, 1600)).arrayBuffer()), f.w * s, f.h * s);
  };

  const fechas = ests.map(e => e.fecha);
  const f0 = fechaTxt(Math.min(...fechas)), f1 = fechaTxt(Math.max(...fechas));
  const hoja = [];
  hoja.push(p('REPORTE DE CAMPO', { align: AlignmentType.CENTER, bold: true, size: 32, color: '0D47A1', after: 40 }));
  hoja.push(p('Reconocimiento de estructuras existentes', { align: AlignmentType.CENTER, size: 24, after: 200 }));
  const filaInfo = (k, v) => new TableRow({
    children: [
      celda([p(k, { bold: true, after: 0 })], 3000, { shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'E3EAF3' } }),
      celda([p(v, { after: 0 })], ANCHO - 3000)
    ]
  });
  hoja.push(new Table({
    width: { size: ANCHO, type: WidthType.DXA }, columnWidths: [3000, ANCHO - 3000], layout: TableLayoutType.FIXED, borders: CON,
    rows: [
      filaInfo('Canal', rec.canal),
      ...(rec.tramo ? [filaInfo('Tramo', rec.tramo)] : []),
      filaInfo('Responsable', rec.resp || '—'),
      filaInfo('Fecha del recorrido', f0 === f1 ? f0 : `${f0} al ${f1}`),
      filaInfo('Estructuras registradas', String(ests.length))
    ]
  }));

  let nFoto = 0, nFig = 0;
  if (general) {
    hoja.push(p('', { after: 120 }));
    hoja.push(imagen(general, 680, 680 * 620 / 1000, true));
    hoja.push(pie(`Figura ${++nFig}.`, `Ubicación general de las estructuras${lineas.length ? ' sobre el trazo' : ''} del ${rec.canal}.`));
  }

  // Tabla resumen (coordenadas UTM WGS84)
  const cols = [700, 1400, 850, 950, 650, 1350, 1424, 2900];
  const celdaTabla = (t, i, head) => celda([p(t, { after: 0, size: 16, bold: head, color: head ? 'FFFFFF' : undefined })], cols[i],
    head ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: '0D47A1' } } : {});
  hoja.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 }, keepNext: true, children: [new TextRun('Resumen de estructuras')] }));
  hoja.push(new Table({
    width: { size: ANCHO, type: WidthType.DXA }, columnWidths: cols, layout: TableLayoutType.FIXED, borders: CON,
    rows: [
      new TableRow({ tableHeader: true, children: ['Clave', 'Tipo', 'Km', 'Estado', 'Zona', 'Este X (m)', 'Norte Y (m)', 'Descripción'].map((t, i) => celdaTabla(t, i, true)) }),
      ...ests.map(e => {
        const u = e.lat != null ? utm(e.lat, e.lon) : null;
        return new TableRow({
          cantSplit: true,
          children: [e.codigo, tipoDe(e), e.km || '—', e.estado || '—',
            u ? u.zona : '—', u ? miles(u.este) : '—', u ? miles(u.norte) : '—', e.desc || '—'].map((t, i) => celdaTabla(t, i, false))
        });
      })
    ]
  }));
  hoja.push(p('Coordenadas UTM, datum WGS84, obtenidas con el GPS del dispositivo móvil.', { size: 16, italics: true, color: '5B6876', before: 60 }));

  // Fichas: foto con su descripción como pie y, a un lado, el mapa de ubicación
  hoja.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, spacing: { after: 120 }, children: [new TextRun('Fichas de estructuras')] }));
  for (let i = 0; i < ests.length; i++) {
    const e = ests[i];
    busy(`Agregando ${e.codigo} (${i + 1} de ${ests.length})…`);
    await tick();
    hoja.push(new Paragraph({
      heading: HeadingLevel.HEADING_2, keepNext: true, spacing: { before: 240, after: 60 },
      children: [new TextRun(`${e.codigo} — ${tipoDe(e)}${e.km ? '  (Km ' + e.km + ')' : ''}`)]
    }));
    if (e.tramoCanal) hoja.push(p(`Canal: ${e.tramoCanal} (a ${Math.round(e.distEje)} m del eje)`, { size: 18, bold: true, color: '37474F', keepNext: true, after: 0 }));
    hoja.push(p(`Estado: ${e.estado || 'Sin evaluar'}     Fecha: ${fechaTxt(e.fecha)}` +
      (e.codigoCampo && e.codigoCampo !== e.codigo ? `     Clave en campo: ${e.codigoCampo}` : ''), { size: 18, color: '5B6876', keepNext: true, after: 0 }));
    hoja.push(p(`Coordenadas: ${e.lat != null ? coordTxt(e.lat, e.lon) + (e.acc ? ` (±${Math.round(e.acc)} m)` : '') : 'sin coordenadas'}`,
      { size: 18, color: '5B6876', keepNext: true }));

    const izq = e.fotos.length
      ? [await fotoAjustada(e.fotos[0]), pie(`Foto ${++nFoto}.`, `${e.codigo} ${tipoDe(e)}${e.desc ? ': ' + e.desc : '.'}`)]
      : [p('Sin fotografía', { align: AlignmentType.CENTER, italics: true })];
    const der = mapas[e.id]
      ? [imagen(mapas[e.id], 320, 240), pie(`Figura ${++nFig}.`, `Ubicación de ${e.codigo} (${coordTxt(e.lat, e.lon)}).`)]
      : [p('Sin coordenadas para ubicar en el mapa', { align: AlignmentType.CENTER, italics: true })];
    const filas = [new TableRow({ cantSplit: true, children: [celda(izq, MEDIO), celda(der, MEDIO)] })];
    for (let k = 1; k < e.fotos.length; k += 2) {
      const par = [];
      for (const j of [k, k + 1]) {
        par.push(celda(e.fotos[j]
          ? [await fotoAjustada(e.fotos[j]), pie(`Foto ${++nFoto}.`, `${e.codigo} ${tipoDe(e)}, vista complementaria.`)]
          : [p('')], MEDIO));
      }
      filas.push(new TableRow({ cantSplit: true, children: par }));
    }
    hoja.push(new Table({ width: { size: ANCHO, type: WidthType.DXA }, columnWidths: [MEDIO, MEDIO], layout: TableLayoutType.FIXED, borders: SIN, rows: filas }));
  }

  const gris = { size: 16, color: '777777' };
  const doc = new Document({
    creator: rec.resp || 'Recorrido Canal',
    title: `Reporte de campo - ${rec.canal}`,
    styles: { default: { document: { run: { font: 'Arial', size: 20 } } } },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1008, bottom: 1008, left: 1008, right: 1008 } } },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: `${rec.canal} · Reporte de campo · Página `, ...gris }),
              new TextRun({ children: [PageNumber.CURRENT], ...gris }), new TextRun({ text: ' de ', ...gris }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], ...gris })]
          })]
        })
      },
      children: hoja
    }]
  });
  busy('Guardando Word…');
  const b64 = APP ? await Packer.toBase64String(doc) : await Packer.toBlob(doc);
  const sinCoord = ests.length - geo.length;
  let nota = '';
  if (mapasFallidos) nota += `<br><br>⚠ ${mapasFallidos} mapa(s) quedaron incompletos por falta de señal. Genera el Word de nuevo con WiFi o mejor señal.`;
  if (sinCoord) nota += `<br><br>⚠ ${sinCoord} estructura(s) sin coordenadas.`;
  await guardarArchivo(`Reporte_${slug(rec.canal)}_${hoy()}.docx`, b64,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', nota);
}

/* ---------- KMZ (Google Earth) ---------- */

/* Ícono de foto para el KMZ: 200 px de ancho, con marco de 8 px del color del estado. */
async function iconoFoto(foto, color) {
  const img = await loadImage(foto.mini || foto.blob);
  const W = 200, H = Math.round(W * img.naturalHeight / img.naturalWidth), B = 8;
  const c = document.createElement('canvas');
  c.width = W + 2 * B; c.height = H + 2 * B;
  const g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, B, B, W, H);
  img.src = '';
  const b = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  soltar(c);
  return b;
}

async function generarKMZ() {
  const ests = await estructurasDe(rec.id);
  const geo = ests.filter(e => e.lat != null);
  if (!geo.length) { toast('Ninguna estructura tiene coordenadas'); return; }
  busy('Generando KMZ…');
  const ICONO = { 'Bueno': 'grn', 'Regular': 'ylw', 'Malo': 'red', 'Fuera de servicio': 'purple' };
  const estilo = e => ICONO[e.estado] || 'wht';
  const cdata = s => String(s).replace(/]]>/g, ']]&gt;');
  const zip = new JSZip();
  const fotos = [];
  // Ícono de cada estructura: miniatura de su foto principal con marco del color de su estado
  const iconos = {};
  for (const [i, e] of geo.entries()) {
    if (!e.fotos.length) continue;
    busy(`Preparando fotos del KMZ (${i + 1} de ${geo.length})…`);
    const n = `files/icono_${slug(e.codigo)}.jpg`;
    zip.file(n, await iconoFoto(e.fotos[0], COLOR_ESTADO[e.estado] || '#ffffff'), { compression: 'STORE' });
    iconos[e.id] = n;
  }
  busy('Generando KMZ…');
  const marcas = geo.map(e => {
    const imgs = e.fotos.map((f, i) => {
      const n = `files/${slug(e.codigo)}_${i + 1}.jpg`;
      fotos.push([n, f.blob]);
      return `<img src="${n}" width="380"><br>`;
    }).join('');
    const html = `<b>${esc(tipoDe(e))}</b><br>` +
      (e.km ? `Cadenamiento: ${esc(e.km)}<br>` : '') +
      (e.tramoCanal ? `Canal: ${esc(e.tramoCanal)} (a ${Math.round(e.distEje)} m del eje)<br>` : '') +
      `Estado: ${esc(e.estado || 'Sin evaluar')}<br>Coordenadas: ${coordTxt(e.lat, e.lon)}<br>Fecha: ${fechaTxt(e.fecha)}<br><br>` +
      `${esc(e.desc).replace(/\n/g, '<br>')}<br><br>${imgs}`;
    // Con foto: la propia foto es el marcador; sin foto: el alfiler de color del estado
    const marca = iconos[e.id]
      ? `<Style><IconStyle><scale>2.8</scale><Icon><href>${iconos[e.id]}</href></Icon><hotSpot x="0.5" y="0" xunits="fraction" yunits="fraction"/></IconStyle><LabelStyle><scale>0.9</scale></LabelStyle></Style>`
      : `<styleUrl>#${estilo(e)}</styleUrl>`;
    return `    <Placemark>
      <name>${esc(e.codigo + ' ' + tipoDe(e))}</name>
      <description><![CDATA[${cdata(html)}]]></description>
      ${marca}
      <Point><coordinates>${e.lon.toFixed(7)},${e.lat.toFixed(7)},0</coordinates></Point>
    </Placemark>`;
  }).join('\n');
  const estilos = ['grn', 'ylw', 'red', 'purple', 'wht'].map(c => `  <Style id="${c}">
    <IconStyle><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/${c}-circle.png</href></Icon><hotSpot x="32" y="1" xunits="pixels" yunits="pixels"/></IconStyle>
    <LabelStyle><scale>0.9</scale></LabelStyle>
  </Style>`).join('\n');
  const pt = c => `${c[0].toFixed(7)},${c[1].toFixed(7)},0`;
  const trazo = rec.trazo ? `  <Folder>
    <name>Trazo del canal (${esc(rec.trazo.archivo)})</name>
${rec.trazo.lineas.map(l => `    <Placemark><name>${esc(l.nombre)}</name><description>Longitud: ${(largo(l) / 1000).toFixed(3)} km</description><styleUrl>#canal</styleUrl><LineString><tessellate>1</tessellate><coordinates>${l.coords.map(pt).join(' ')}</coordinates></LineString></Placemark>`).join('\n')}
${rec.trazo.puntos.map(q => `    <Placemark><name>${esc(q.nombre)}</name><styleUrl>#ref</styleUrl><Point><coordinates>${pt([q.lon, q.lat])}</coordinates></Point></Placemark>`).join('\n')}
  </Folder>
` : '';
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${esc(rec.canal)}</name>
  <description>${esc(`Reconocimiento de estructuras. ${rec.tramo || ''} Responsable: ${rec.resp || '—'}`)}</description>
${estilos}
  <Style id="canal"><LineStyle><color>ffffff00</color><width>4</width></LineStyle></Style>
  <Style id="ref"><IconStyle><scale>0.7</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>
${trazo}  <Folder>
    <name>Estructuras (${geo.length})</name>
${marcas}
  </Folder>
</Document>
</kml>`;
  zip.file('doc.kml', kml);
  for (const [n, b] of fotos) zip.file(n, await reducir(b, 1280), { compression: 'STORE' });
  const b64 = await zip.generateAsync({ type: APP ? 'base64' : 'blob', compression: 'DEFLATE' });
  const sinCoord = ests.length - geo.length;
  await guardarArchivo(`${slug(rec.canal)}_${hoy()}.kmz`, b64, 'application/vnd.google-earth.kmz',
    sinCoord ? `<br><br>⚠ ${sinCoord} estructura(s) sin coordenadas no se incluyeron.` : '');
}

/* ---------- Archivo de recorrido (.rcanal): respaldo y traspaso entre teléfonos ---------- */

/* Formato: ZIP con recorrido.json (recorrido, KMZ del canal, estructuras, huellas para identificar) y fotos/*.jpg */
const FORMATO_REC = 'recorrido-canal';

function bytesB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
const b64Bytes = b => Uint8Array.from(atob(b), c => c.charCodeAt(0));

/* Agrega al ZIP las fotos de un recorrido y devuelve su parte del recorrido.json. */
async function empaquetar(zip, r) {
  const ests = await estructurasDe(r.id);
  const estructuras = [];
  for (const e of ests) {
    const { fotos, nuevo, tipoManual, estadoManual, descAuto, ...resto } = e;
    const fotosJson = [];
    for (const [i, f] of fotos.entries()) {
      const archivo = `fotos/${slug(e.codigo)}_${i + 1}_${e.id}.jpg`;
      zip.file(archivo, f.blob);
      const { blob, mini, emb, ...meta } = f; // la miniatura se vuelve a crear al abrirlo
      fotosJson.push({ ...meta, archivo, emb: emb ? bytesB64(new Uint8Array(emb.buffer, emb.byteOffset, emb.byteLength)) : null });
    }
    estructuras.push({ ...resto, fotos: fotosJson });
  }
  return { recorrido: r, estructuras };
}

/* Guarda un recorrido como .rcanal (el abierto, o el elegido desde la lista del inicio). */
async function exportarRecorrido(r = rec) {
  busy('Preparando archivo del recorrido…');
  const zip = new JSZip();
  const parte = await empaquetar(zip, r);
  zip.file('recorrido.json', JSON.stringify({ formato: FORMATO_REC, version: 1, exportado: Date.now(), ...parte }));
  const datos = await zip.generateAsync({ type: APP ? 'base64' : 'blob', compression: 'STORE' });
  await guardarArchivo(`Recorrido_${slug(r.canal)}_${hoy()}.rcanal`, datos, 'application/octet-stream',
    `<br><br>${parte.estructuras.length} estructura(s) con sus fotos. Ábrelo en otro teléfono con la app <b>Recorrido Canal</b> ` +
    '(tocando el archivo o con "Abrir recorrido desde archivo").');
}

/* ---------- Actualización de la versión web: primero respaldar, luego actualizar ---------- */

let swEnEspera = null;
const respaldoReciente = () => Date.now() - (+lsGet('ultimoRespaldo') || 0) < 3600000; // última hora

function mostrarActualizacion(sw) {
  swEnEspera = sw;
  $('#avisoActualizacion').hidden = false;
  estadoActualizacion();
}

function estadoActualizacion() {
  $('#actEstado').textContent = respaldoReciente()
    ? '✓ Respaldo hecho. Ya puedes actualizar.'
    : 'Toca "Respaldar todo", elige Guardar en Archivos (o Drive) y después "Actualizar ahora".';
}

/* Recordatorio en el inicio cuando hay trabajo sin respaldar desde hace más de 3 días (o nunca). */
async function renderAvisoRespaldo() {
  const caja = $('#avisoRespaldo');
  const ultimoR = +lsGet('ultimoRespaldo') || 0;
  const n = await prom(store('estructuras').count());
  const dias = Math.floor((Date.now() - ultimoR) / 86400000);
  caja.hidden = !n || dias < 3;
  caja.innerHTML = ultimoR
    ? `Tu último respaldo fue hace ${dias} días. Respalda tus recorridos y guarda el archivo fuera del teléfono.`
    : `Tienes ${n} estructura(s) sin respaldo. Respalda tus recorridos y guarda el archivo fuera del teléfono ` +
      '(si se borra la app, sus datos se pierden).';
}

/* Respaldo de TODOS los recorridos del teléfono en un solo archivo .rcanal. */
async function respaldarTodo() {
  const recs = (await dbAll('recorridos')).sort((a, b) => a.creado - b.creado);
  if (!recs.length) { toast('No hay recorridos para respaldar'); return; }
  const zip = new JSZip();
  const partes = [];
  for (const [i, r] of recs.entries()) {
    busy(`Preparando respaldo (${i + 1} de ${recs.length})…`);
    partes.push(await empaquetar(zip, r));
  }
  zip.file('recorrido.json', JSON.stringify({ formato: FORMATO_REC, version: 2, exportado: Date.now(), recorridos: partes }));
  busy('Armando archivo de respaldo…');
  const datos = await zip.generateAsync({ type: APP ? 'base64' : 'blob', compression: 'STORE' });
  const n = partes.reduce((s, p) => s + p.estructuras.length, 0);
  lsSet('ultimoRespaldo', String(Date.now()));
  await guardarArchivo(`Respaldo_RecorridoCanal_${hoy()}.rcanal`, datos, 'application/octet-stream',
    `<br><br>${recs.length} recorrido(s) y ${n} estructura(s). Guárdalo fuera del teléfono (Archivos, Drive o correo). ` +
    'Para recuperarlo usa "Abrir recorrido desde archivo".');
  await renderAvisoRespaldo();
}

/* Importa un recorrido (de un archivo .rcanal) a este teléfono. Devuelve el recorrido guardado. */
async function importarUno(zip, parte) {
  let r = parte.recorrido, sufijo = '';
  const existe = await dbGet('recorridos', r.id);
  if (existe) {
    idle();
    if (confirm(`Ya tienes el recorrido "${existe.canal}" en este teléfono.\n\nAceptar: reemplazarlo con el del archivo.\nCancelar: guardarlo como copia.`)) {
      for (const e of await estructurasDe(r.id)) await dbDel('estructuras', e.id);
    } else {
      sufijo = '_c' + Date.now();
      r = { ...r, id: r.id + sufijo, canal: r.canal + ' (copia)' };
    }
  }
  busy(`Abriendo "${r.canal}"…`);
  for (const e of parte.estructuras) {
    const est = { ...e, id: e.id + sufijo, recId: r.id, fotos: await fotosDesdeZip(zip, e.fotos) };
    await dbPut('estructuras', est);
    await aprender(est); // lo aprendido en el otro teléfono también sirve aquí
  }
  await dbPut('recorridos', r);
  return r;
}

/* ---------- Orden por cadenamiento y unión de varios recorridos ---------- */

/* Cadenamiento a metros: "2+715" → 2715, "2.715" (km) → 2715, "850" → 850; vacío o inválido → null. */
function kmMetros(km) {
  const s = String(km || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d+)\s*\+\s*(\d+(?:[.,]\d+)?)$/);
  if (m) return +m[1] * 1000 + parseFloat(m[2].replace(',', '.'));
  const v = parseFloat(s.replace(',', '.'));
  return isFinite(v) ? (/[.,]/.test(s) ? v * 1000 : v) : null;
}

/* Ordena las estructuras por canal (si hay varios) y cadenamiento, y las renumera E-01, E-02…
   La clave anterior se conserva como clave de campo: es la que aparece en el sello de la foto. */
async function ordenarPorCadenamiento(r = rec) {
  const ests = await estructurasDe(r.id);
  const canalDe = e => e.tramoCanal || r.canal;
  const varios = new Set(ests.map(canalDe)).size > 1;
  const cmp = (x, y) => x === y ? 0 : x < y ? -1 : 1;
  const metros = e => { const v = kmMetros(e.km); return v == null ? Infinity : v; }; // sin Km: al final
  ests.sort((a, b) => (varios ? canalDe(a).localeCompare(canalDe(b), 'es') : 0) || cmp(metros(a), metros(b)) || cmp(a.fecha, b.fecha));
  for (const [i, e] of ests.entries()) {
    const nuevo = 'E-' + pad(i + 1);
    if (!e.codigoCampo && e.codigo !== nuevo) e.codigoCampo = e.codigo;
    e.num = i + 1;
    e.codigo = nuevo;
    await dbPut('estructuras', e);
  }
  return ests.length;
}

/* Lee las fotos de una estructura desde el ZIP de un .rcanal. */
async function fotosDesdeZip(zip, fotosJson) {
  const fotos = [];
  for (const f of fotosJson) {
    const arch = zip.file(f.archivo);
    if (!arch) continue;
    const blob = new Blob([await arch.async('uint8array')], { type: 'image/jpeg' });
    const { archivo, emb, ...meta } = f;
    fotos.push({ ...meta, blob, emb: emb ? new Float32Array(b64Bytes(emb).buffer) : null });
  }
  return fotos;
}

async function leerRcanal(f) {
  let zip, datos;
  try {
    zip = await JSZip.loadAsync(await f.arrayBuffer());
    datos = JSON.parse(await zip.file('recorrido.json').async('string'));
  } catch (e) {
    throw new Error(`"${f.name}" no es un recorrido de la app (.rcanal) o está dañado`);
  }
  if (datos.formato !== FORMATO_REC) throw new Error(`"${f.name}" no es un recorrido de la app (.rcanal)`);
  return { zip, partes: datos.recorridos || [datos] };
}

/* Une varios archivos .rcanal en un recorrido nuevo, ordenado por cadenamiento.
   Si una misma estructura viene en dos archivos, se queda la versión modificada más reciente. */
async function unirRecorridos(archivos) {
  const fuentes = [];
  for (const [i, a] of archivos.entries()) {
    busy(`Leyendo archivo ${i + 1} de ${archivos.length}…`);
    const f = await a;
    const { zip, partes } = await leerRcanal(f);
    for (const parte of partes) fuentes.push({ zip, parte, archivo: f.name });
  }
  if (!fuentes.length) return;
  const recs = fuentes.map(s => s.parte.recorrido);
  const nombres = [...new Set(recs.map(r => r.canal))];
  idle();
  const sugerido = nombres.length === 1 ? nombres[0] : `${nombres[0]} y otros (unido)`;
  const canal = (prompt(`Se unirán ${fuentes.length} recorrido(s):\n• ${nombres.join('\n• ')}\n\nNombre del recorrido unido:`, sugerido) || '').trim();
  if (!canal) return;

  const porId = new Map();
  for (const s of fuentes) {
    for (const e of s.parte.estructuras) {
      const prev = porId.get(e.id), t = e.mod || e.fecha || 0;
      if (!prev || t > (prev.e.mod || prev.e.fecha || 0)) porId.set(e.id, { e, zip: s.zip, archivo: s.archivo });
    }
  }
  const unico = v => [...new Set(recs.map(v).filter(Boolean))];
  const conTrazo = recs.find(r => r.trazo);
  const r = {
    id: 'r' + Date.now(), canal, resp: unico(x => x.resp).join(', '), tramo: unico(x => x.tramo).join('; '),
    creado: Math.min(...recs.map(x => x.creado || Date.now())), trazo: conTrazo ? conTrazo.trazo : null,
    unidoDe: [...new Set(fuentes.map(s => s.archivo))]
  };
  let i = 0;
  const base = Date.now();
  for (const { e, zip, archivo } of porId.values()) {
    busy(`Uniendo estructuras (${++i} de ${porId.size})…`);
    const est = {
      ...e, id: `e${base}_${i}`, recId: r.id, fotos: await fotosDesdeZip(zip, e.fotos),
      codigoCampo: e.codigoCampo || e.codigo, archivoOrigen: archivo
    };
    await dbPut('estructuras', est);
    await aprender(est);
  }
  await dbPut('recorridos', r);
  rec = r;
  if (r.trazo) await recalcularKm();
  busy('Ordenando por cadenamiento…');
  await ordenarPorCadenamiento(r);
  await renderRec();
  const repetidas = fuentes.reduce((s, x) => s + x.parte.estructuras.length, 0) - porId.size;
  toast(`Recorrido unido: ${porId.size} estructura(s) ordenadas por cadenamiento` + (repetidas ? ` (${repetidas} repetida(s) omitida(s))` : ''), 6000);
}

/* Abre un archivo .rcanal: un recorrido o un respaldo con varios. Si alguno ya existe, pregunta qué hacer. */
async function importarRecorrido(bytes) {
  busy('Abriendo recorrido…');
  let zip, datos;
  try {
    zip = await JSZip.loadAsync(bytes);
    datos = JSON.parse(await zip.file('recorrido.json').async('string'));
  } catch (e) {
    throw new Error('el archivo no es un recorrido de la app (.rcanal) o está dañado');
  }
  if (datos.formato !== FORMATO_REC) throw new Error('el archivo no es un recorrido de la app (.rcanal)');
  const partes = datos.recorridos || [datos];
  let ultimoAbierto = null, n = 0;
  for (const p of partes) { ultimoAbierto = await importarUno(zip, p); n += p.estructuras.length; }
  if (partes.length === 1) {
    rec = ultimoAbierto;
    await renderRec();
    toast(`Recorrido abierto: ${n} estructura(s)`, 4000);
  } else {
    await renderInicio();
    toast(`Respaldo abierto: ${partes.length} recorridos, ${n} estructura(s)`, 5000);
  }
}

/* Android: archivo .rcanal abierto desde WhatsApp, Archivos, correo… (lo entrega MainActivity en trozos). */
window.__abrirEntrante = () => ejecutar(async () => {
  if (!APP || !Android.entranteTrozos) return;
  const n = Android.entranteTrozos();
  if (!n) return;
  busy('Recibiendo archivo…');
  const partes = [];
  for (let i = 0; i < n; i++) { partes.push(b64Bytes(Android.entranteTrozo(i))); await tick(); }
  Android.entranteLiberar();
  const total = partes.reduce((s, p) => s + p.length, 0), bytes = new Uint8Array(total);
  let o = 0;
  for (const p of partes) { bytes.set(p, o); o += p.length; }
  await importarRecorrido(bytes);
});

/* ---------- Tabla CSV (Excel) ---------- */

async function generarCSV() {
  const ests = await estructurasDe(rec.id);
  if (!ests.length) { toast('No hay estructuras registradas'); return; }
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const filas = [['Recorrido', 'Clave', 'Tipo', 'Canal', 'Cadenamiento', 'Dist_eje_m', 'Estado', 'Zona_UTM', 'Este_X', 'Norte_Y',
    'Latitud', 'Longitud', 'Precision_m', 'Altitud_m', 'Fecha', 'Hora', 'Fotos', 'Descripcion']];
  ests.forEach(e => {
    const u = e.lat != null ? utm(e.lat, e.lon) : null;
    filas.push([rec.canal, e.codigo, tipoDe(e), e.tramoCanal, e.km, e.distEje != null ? Math.round(e.distEje) : '', e.estado,
      u ? u.zona : '', u ? u.este.toFixed(2) : '', u ? u.norte.toFixed(2) : '',
      e.lat != null ? e.lat.toFixed(7) : '', e.lon != null ? e.lon.toFixed(7) : '',
      e.acc ? Math.round(e.acc) : '', e.alt != null ? Math.round(e.alt) : '',
      fechaTxt(e.fecha), horaTxt(e.fecha), e.fotos.length, e.desc]);
  });
  const csv = '﻿' + filas.map(f => f.map(q).join(',')).join('\r\n');
  const b64 = btoa(unescape(encodeURIComponent(csv)));
  await guardarArchivo(`Tabla_${slug(rec.canal)}_${hoy()}.csv`, b64, 'text/csv');
}

/* ---------- Eventos ---------- */

async function init() {
  $('#fTipo').innerHTML = '<option value="">— Selecciona el tipo —</option>' + TIPOS.map(t => `<option>${t}</option>`).join('');
  $('#fEstado').innerHTML = ESTADOS.map(e => `<button type="button" data-v="${e}">${e}</button>`).join('');
  $('#inResp').value = lsGet('resp');

  $('#btnIniciar').onclick = () => ejecutar(iniciarRecorrido);
  $('#inCanal').addEventListener('input', () => { canalAuto = false; });
  $('#btnTrazoNuevo').onclick = () => { destinoTrazo = 'nuevo'; $('#inKmz').value = ''; $('#inKmz').click(); };
  $('#inKmz').onchange = ev => ejecutar(() => cargarTrazo(ev.target.files[0]));
  $('#trazoBar').onclick = ev => { const b = ev.target.closest('[data-act]'); if (b) ejecutar(() => accionTrazo(b.dataset.act)); };
  $('#fKm').addEventListener('input', () => { cur.kmAuto = false; sugerirDescripcion(); });
  $('#fUbic').onclick = ev => {
    const s = ev.target.closest('[data-sentido]');
    if (s) {
      ejecutar(async () => {
        if (s.dataset.sentido === 'cambiar') await cambiarSentido();
        else { await autoKm(true); renderUbic(); }
        dirty = true;
      });
      return;
    }
    const b = ev.target.closest('[data-km]');
    if (b) { $('#fKm').value = cur.km = b.dataset.km; cur.kmAuto = true; dirty = true; toast('Cadenamiento asignado'); }
  };
  window.addEventListener('resize', () => { if (vista === 'rec') dibujarCroquis(); });
  $('#btnBack').onclick = () => window.appBack();
  $('#listaRec').onclick = ev => {
    const del = ev.target.closest('[data-del]');
    if (del) { ejecutar(() => eliminarRecorrido(del.dataset.del)); return; }
    const exp = ev.target.closest('[data-exp]');
    if (exp) { ejecutar(async () => exportarRecorrido(await dbGet('recorridos', exp.dataset.exp))); return; }
    const it = ev.target.closest('.item');
    if (it) ejecutar(async () => { rec = await dbGet('recorridos', it.dataset.id); await renderRec(); });
  };
  $('#listaEst').onclick = ev => {
    const it = ev.target.closest('.item');
    if (it) ejecutar(() => editarEstructura(it.dataset.id));
  };
  $('#btnNueva').onclick = () => ejecutar(nuevaEstructura);
  $('#btnWord').onclick = () => ejecutar(generarWord);
  $('#btnKmz').onclick = () => ejecutar(generarKMZ);
  $('#btnCsv').onclick = () => ejecutar(generarCSV);
  $('#btnExportar').onclick = () => ejecutar(exportarRecorrido);
  $('#btnImportar').onclick = () => { $('#inRec').value = ''; $('#inRec').click(); };
  $('#btnRespaldo').onclick = () => ejecutar(respaldarTodo);
  $('#inRec').onchange = ev => { if (ev.target.files.length) abrirArchivosRecorrido([...ev.target.files]); };
  $('#btnUnir').onclick = () => { $('#inUnir').value = ''; $('#inUnir').click(); };
  $('#inUnir').onchange = ev => {
    const fs = [...ev.target.files];
    if (fs.length < 2) { toast('Elige dos o más archivos .rcanal para unirlos'); return; }
    ejecutar(() => unirRecorridos(fs));
  };
  $('#btnOrdenar').onclick = () => ejecutar(async () => {
    const n = await ordenarPorCadenamiento(rec);
    await renderRec();
    toast(`${n} estructura(s) ordenadas por cadenamiento y renumeradas`);
  });

  $('#vEst').addEventListener('input', () => { dirty = true; });
  $('#fTipo').onchange = () => {
    cur.tipo = $('#fTipo').value;
    $('#lblOtro').hidden = cur.tipo !== 'Otra';
    cur.tipoManual = true; dirty = true;
    sugerirDescripcion();
  };
  $('#fTipoOtro').addEventListener('input', () => { cur.tipoOtro = $('#fTipoOtro').value.trim(); cur.tipoManual = true; sugerirDescripcion(); });
  $('#fSugerencia').onclick = ev => {
    const b = ev.target.closest('[data-usar-tipo]');
    if (!b) return;
    const t = b.dataset.usarTipo;
    if (TIPOS.includes(t)) { cur.tipo = t; cur.tipoOtro = ''; } else { cur.tipo = 'Otra'; cur.tipoOtro = t; }
    $('#fTipo').value = cur.tipo; $('#fTipoOtro').value = cur.tipoOtro; $('#lblOtro').hidden = cur.tipo !== 'Otra';
    cur.tipoManual = true; dirty = true;
    sugerirDescripcion();
  };
  $('#fSugEstado').onclick = ev => {
    const b = ev.target.closest('[data-usar-estado]');
    if (!b) return;
    cur.estado = b.dataset.usarEstado; cur.estadoManual = true; dirty = true;
    renderEstado(); sugerirDescripcion();
  };
  $('#fSugDesc').onclick = ev => {
    if (!ev.target.closest('[data-usar-desc]')) return;
    $('#fDesc').value = cur.descAuto = $('#fSugDesc').dataset.propuesta;
    dirty = true; sugerirDescripcion();
  };
  $('#fMejorar').onchange = ev => { lsSet('mejorar', ev.target.checked ? '1' : '0'); };
  $('#fGaleria').onchange = ev => { lsSet('galeria', ev.target.checked ? '1' : '0'); };
  $('#fEstado').onclick = ev => {
    const b = ev.target.closest('button');
    if (!b) return;
    cur.estado = cur.estado === b.dataset.v ? '' : b.dataset.v;
    cur.estadoManual = true;
    dirty = true;
    renderEstado();
    sugerirDescripcion();
  };
  $('#btnFijar').onclick = fijarUbicacion;
  $('#btnCam').onclick = () => { $('#inCam').value = ''; $('#inCam').click(); };
  $('#btnGal').onclick = () => { $('#inGal').value = ''; $('#inGal').click(); };
  $('#inCam').onchange = ev => agregarFotos([...ev.target.files], 'cam');
  $('#inGal').onchange = ev => agregarFotos([...ev.target.files], 'gal');
  $('#visor').onclick = cerrarVisor;
  $('#fFotos').onclick = ev => {
    const ver = ev.target.closest('[data-ver]');
    if (ver) { verFoto(cur.fotos[+ver.dataset.ver]); return; }
    const del = ev.target.closest('[data-del]');
    if (del) {
      if (confirm('¿Quitar esta foto?')) { cur.fotos.splice(+del.dataset.del, 1); dirty = true; renderFotos(); }
      return;
    }
    const f = ev.target.closest('.foto');
    if (f && +f.dataset.i > 0) {
      cur.fotos.unshift(cur.fotos.splice(+f.dataset.i, 1)[0]);
      dirty = true;
      renderFotos();
      toast('Foto principal cambiada');
    }
  };
  $('#btnGuardar').onclick = () => ejecutar(guardar);
  $('#btnEliminar').onclick = () => ejecutar(eliminarEstructura);

  $('#dlgClose').onclick = () => { $('#dlg').hidden = true; };
  $('#dlgOpen').onclick = () => {
    if (!ultimo) return;
    if (APP) Android.openFile(ultimo.nombre, ultimo.mime);
    else window.open(URL.createObjectURL(ultimo.blob), '_blank');
  };
  $('#dlgShare').onclick = () => {
    if (!ultimo) return;
    if (APP) Android.shareFile(ultimo.nombre, ultimo.mime);
    else compartirArchivos([new File([ultimo.blob], ultimo.nombre, { type: ultimo.mime })]);
  };
  $('#btnGuardarFotos').onclick = () => ejecutar(guardarFotosPendientes);
  $('#btnActRespaldo').onclick = () => ejecutar(async () => { await respaldarTodo(); estadoActualizacion(); });
  $('#btnActAplicar').onclick = () => {
    if (!swEnEspera) return;
    if (!respaldoReciente() && !confirm('Aún no has respaldado tus recorridos.\n\nTus recorridos se conservan al actualizar, ' +
      'pero se recomienda respaldar primero. ¿Actualizar de todos modos?')) return;
    busy('Actualizando…');
    // Cuando la versión nueva queda activa, se recarga la pantalla para usarla
    swEnEspera.addEventListener('statechange', () => {
      if (swEnEspera.state === 'activated') { lsSet('recienActualizada', '1'); location.reload(); }
    });
    swEnEspera.postMessage('actualizar');
  };

  if (!APP) {
    // Versión web (iPhone): funciona sin señal y conserva los datos
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      const habiaVersion = !!navigator.serviceWorker.controller;
      let recargando = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        // Ya se aplicó la versión nueva: se recarga para usarla (los recorridos siguen en el teléfono)
        if (!habiaVersion || recargando) return;
        recargando = true;
        lsSet('recienActualizada', '1');
        location.reload();
      });
      navigator.serviceWorker.register('sw.js').then(reg => {
        if (reg.waiting && navigator.serviceWorker.controller) mostrarActualizacion(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const nuevo = reg.installing;
          nuevo.addEventListener('statechange', () => {
            if (nuevo.state === 'installed' && navigator.serviceWorker.controller) mostrarActualizacion(nuevo);
          });
        });
        reg.update().catch(() => {});
      }).catch(e => console.warn('Sin modo sin conexión', e));
      if (lsGet('recienActualizada')) {
        lsSet('recienActualizada', '');
        setTimeout(() => toast('App actualizada. Tus recorridos y fotos se conservan.', 5000), 800);
      }
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    $('#inKmz').removeAttribute('accept'); // iOS no reconoce .kmz como tipo y lo deja gris
  }

  await openDB();
  await cargarEjemplos();
  trazoNuevo = await cfgGet('trazo') || null;
  if (trazoNuevo) { canalAuto = true; $('#btnTrazoNuevo').textContent = 'Cambiar KMZ / KML'; }
  await renderInicio();
  window.__abrirEntrante(); // ¿la app se abrió tocando un archivo .rcanal?

  // PC (Edge/Chrome con la app instalada): doble clic en un .rcanal abre la app con ese archivo
  if ('launchQueue' in window) {
    launchQueue.setConsumer(params => {
      if (params.files && params.files.length) abrirArchivosRecorrido(params.files.map(h => h.getFile()));
    });
  }
  // PC: arrastrar y soltar archivos .rcanal sobre la ventana
  document.addEventListener('dragover', ev => { ev.preventDefault(); document.body.classList.add('soltar'); });
  document.addEventListener('dragleave', ev => { if (!ev.relatedTarget) document.body.classList.remove('soltar'); });
  document.addEventListener('drop', ev => {
    ev.preventDefault();
    document.body.classList.remove('soltar');
    const fs = [...(ev.dataTransfer && ev.dataTransfer.files || [])];
    if (fs.length) abrirArchivosRecorrido(fs);
  });
}

/* Abre uno o varios archivos .rcanal (o promesas de archivo) en orden. */
function abrirArchivosRecorrido(archivos) {
  if (archivos.length > 1 && confirm(`Elegiste ${archivos.length} archivos .rcanal.\n\n` +
    'Aceptar: UNIRLOS en un solo recorrido ordenado por cadenamiento.\nCancelar: abrir cada uno por separado.')) {
    ejecutar(() => unirRecorridos(archivos));
    return;
  }
  ejecutar(async () => {
    for (const a of archivos) {
      const f = await a;
      await importarRecorrido(new Uint8Array(await f.arrayBuffer()));
    }
  });
}

// Cualquier error inesperado se muestra (en vez de fallar en silencio) para poder reportarlo
window.addEventListener('error', ev => toast('Error: ' + mensajeError(ev.error || ev.message), 7000));
window.addEventListener('unhandledrejection', ev => toast('Error: ' + mensajeError(ev.reason), 7000));

init().catch(e => alert('Error al iniciar: ' + mensajeError(e)));
