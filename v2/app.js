/* Grifos en ruta v2: cualquier punto A → B. La ruta y el lado de cada grifo se calculan aquí,
   en el navegador; los precios de todo el Perú vienen de data/precios.json (scripts/v2/precios.mjs). */
(() => {
"use strict";
const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toFixed(2);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const FUELN = { P: "Gasohol Premium", R: "Gasohol Regular", D: "Diésel DB5" };
const ONROUTE = 150;           // m: a esta distancia o menos se considera "en ruta"
const KEEP = 700;              // m: grifos más lejos que esto no se muestran
const NEAR_PROV = 2000;        // m: provincias con grifos a esta distancia entran al "Actualizar precios"
const SPEED = 85;              // km/h promedio para estimar minutos
const AVISOS = [1000, 300];    // m antes del más barato en que llega una notificación
const ETA = [3, 5];            // min que suele tardar "Actualizar precios"
const GIVEUP = 15;             // min: después de esto se deja de esperar
const OSRM = "https://router.project-osrm.org/route/v1/driving/";
const NOMINATIM = "https://nominatim.openstreetmap.org/";
const dist = (m) => (m >= 1000 ? `${m / 1000} km` : `${m} m`);
const gmaps = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;

const small = new Set(["de", "del", "la", "las", "los", "y", "e", "en"]);
const title = (s) => s.toLowerCase()
  .replace(/(^|[\s(\-–/.])([a-záéíóúñü])/g, (m, a, b) => a + b.toUpperCase())
  .replace(/\b(S\.?a\.?c?\.?|E\.?i\.?r\.?l\.?|S\.?r\.?l\.?|Ee\.?ss\.?|Es)\b/gi, (m) => m.toUpperCase())
  .split(" ").map((w, i) => (i && small.has(w.toLowerCase()) ? w.toLowerCase() : w)).join(" ");

let PRICES, PROVS, ROUTE = null, STATIONS = [], ROUTE_PROVS = [];
const trip = { a: null, b: null };  // { label, lat, lng }
const state = { dir: "S", fuel: "P", gal: 10, horizon: 60, pos: null, source: null, follow: true, hidePassed: true, notify: false, pick: null };
const KEY = "grifos-ruta-v2";
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(`${KEY}:${k}`) || "null"); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(`${KEY}:${k}`) : localStorage.setItem(`${KEY}:${k}`, JSON.stringify(v)); } catch {} }
};

/* ---------- Geometría ---------- */
const RAD = Math.PI / 180;
let P; // proyección plana en metros, centrada en la ruta
function setProjection(lat0) {
  const kx = 6371000 * Math.cos(lat0 * RAD) * RAD, ky = 6371000 * RAD;
  P = ([lat, lng]) => [lng * kx, lat * ky];
}
// Ruta completa con un índice por cuadrículas de 1 km para buscar rápido el tramo más cercano
const CELL = 1000;
function indexRoute(coords, km) {
  const pts = coords.map(P), cum = [0], grid = new Map();
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    cum[i] = cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let x = Math.floor(Math.min(a[0], b[0]) / CELL); x <= Math.floor(Math.max(a[0], b[0]) / CELL); x++)
      for (let y = Math.floor(Math.min(a[1], b[1]) / CELL); y <= Math.floor(Math.max(a[1], b[1]) / CELL); y++) {
        const k = x + "," + y; (grid.get(k) || grid.set(k, []).get(k)).push(i);
      }
  }
  return { pts, cum, grid, scale: (km * 1000) / (cum[cum.length - 1] || 1) };
}
// Tramo más cercano dentro de maxD metros: distancia, km recorrido, lado (R/L) y rumbo del tramo
function nearest(R, q, maxD) {
  const r = Math.ceil(maxD / CELL), cx = Math.floor(q[0] / CELL), cy = Math.floor(q[1] / CELL);
  let best = null;
  for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) {
    for (const i of R.grid.get(x + "," + y) || []) {
      const a = R.pts[i - 1], b = R.pts[i], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
      let t = ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(q[0] - (a[0] + t * dx), q[1] - (a[1] + t * dy));
      if (d <= maxD && (!best || d < best.d)) {
        const cross = dx * (q[1] - a[1]) - dy * (q[0] - a[0]);
        best = { d, km: ((R.cum[i - 1] + t * Math.sqrt(L2)) * R.scale) / 1000, side: cross < 0 ? "R" : "L", dx, dy };
      }
    }
  }
  return best;
}
// Douglas-Peucker para aligerar la ruta que se dibuja y la que usa el GPS
function simplify(coords, eps) {
  if (coords.length < 3) return coords;
  const [y1, x1] = coords[0], [y2, x2] = coords[coords.length - 1];
  let dmax = 0, idx = 0;
  const den = Math.hypot(y2 - y1, x2 - x1) || 1e-12;
  for (let i = 1; i < coords.length - 1; i++) {
    const [y, x] = coords[i];
    const d = Math.abs((y2 - y1) * x - (x2 - x1) * y + x2 * y1 - y2 * x1) / den;
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax <= eps) return [coords[0], coords[coords.length - 1]];
  return simplify(coords.slice(0, idx + 1), eps).slice(0, -1).concat(simplify(coords.slice(idx), eps));
}
function prepRoute(r) {
  const pts = r.coords.map(P), cum = [0];
  for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  r.pts = pts; r.cum = cum; r.scale = (r.km * 1000) / cum[cum.length - 1];
}
function project(r, lat, lng) {
  const q = P([lat, lng]); let best = { d: Infinity, km: 0 };
  for (let i = 1; i < r.pts.length; i++) {
    const a = r.pts[i - 1], b = r.pts[i], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
    let t = ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2; t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(q[0] - (a[0] + t * dx), q[1] - (a[1] + t * dy));
    if (d < best.d) best = { d, km: ((r.cum[i - 1] + t * Math.sqrt(L2)) * r.scale) / 1000 };
  }
  return best;
}

/* ---------- Ruta A → B y grifos cercanos ---------- */
async function osrm(a, b) {
  const res = await fetch(`${OSRM}${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`);
  const j = await res.json();
  if (j.code !== "Ok" || !j.routes?.length) throw new Error(j.code === "NoRoute" ? "No hay ruta en auto entre esos puntos." : "El servicio de rutas no respondió.");
  return { coords: j.routes[0].geometry.coordinates.map(([lng, lat]) => [+lat.toFixed(5), +lng.toFixed(5)]), km: j.routes[0].distance / 1000 };
}
// Con la geometría completa de ida y vuelta calcula, para cada grifo, distancia, km y lado en cada sentido
function analyze(full) {
  setProjection((trip.a.lat + trip.b.lat) / 2);
  const RS = indexRoute(full.S.coords, full.S.km), RN = indexRoute(full.N.coords, full.N.km);
  const m = NEAR_PROV / 111000 * 1.5, box = { s: 90, n: -90, w: 180, e: -180 };
  for (const [lat, lng] of full.S.coords.concat(full.N.coords)) {
    box.s = Math.min(box.s, lat - m); box.n = Math.max(box.n, lat + m); box.w = Math.min(box.w, lng - m); box.e = Math.max(box.e, lng + m);
  }
  const none = { d: 99999, km: 0, side: "R" }, provs = new Set(), out = [];
  for (const s of PRICES.stations) {
    if (s.lat < box.s || s.lat > box.n || s.lng < box.w || s.lng > box.e) continue;
    const q = P([s.lat, s.lng]);
    const a = nearest(RS, q, NEAR_PROV), b = nearest(RN, q, NEAR_PROV);
    if (!a && !b) continue;
    provs.add(s.pv);
    if (Math.min(a?.d ?? 1e9, b?.d ?? 1e9) > KEEP) continue;
    // "Norte a sur" / "sur a norte" en la dirección: vale para el sentido que va así en ese tramo
    let hint;
    const A = s.addr.toUpperCase(), dirTxt = /NORTE A SUR/.test(A) ? -1 : /SUR A NORTE/.test(A) ? 1 : 0;
    if (dirTxt && a && Math.abs(a.dy) > Math.abs(a.dx) * 0.5) hint = Math.sign(a.dy) === dirTxt ? "S" : "N";
    const pick = (r) => (r ? { d: Math.round(r.d), km: +r.km.toFixed(2), side: r.side } : none);
    out.push({ id: s.id, pv: s.pv, name: title(s.name), addr: title(s.addr), lat: s.lat, lng: s.lng, prices: s.prices, S: pick(a), N: pick(b), ...(hint ? { hint } : {}) });
  }
  STATIONS = out.sort((x, y) => x.S.km - y.S.km);
  ROUTE_PROVS = [...provs].sort();
  ROUTE = {
    S: { km: +full.S.km.toFixed(1), coords: simplify(full.S.coords, 0.00005) },
    N: { km: +full.N.km.toFixed(1), coords: simplify(full.N.coords, 0.00005) }
  };
  prepRoute(ROUTE.S); prepRoute(ROUTE.N);
}
let FULL = null; // geometría completa de la última ruta (se guarda para recalcular sin volver a pedirla)
async function calcRoute() {
  if (!trip.a || !trip.b) { $("tripMsg").textContent = "Elige el punto A y el punto B."; return; }
  if (!PRICES) { $("tripMsg").textContent = "Aún no cargan los precios de los grifos. Recarga la página."; return; }
  $("calcBtn").disabled = true; $("tripMsg").textContent = "Calculando la ruta de ida y de vuelta…";
  try {
    const S = await osrm(trip.a, trip.b), N = await osrm(trip.b, trip.a);
    FULL = { S, N };
    store.set("route", { a: trip.a, b: trip.b, full: FULL });
    afterRoute(true);
  } catch (e) {
    $("tripMsg").textContent = e.message || "No se pudo calcular la ruta. Revisa tu conexión.";
  } finally { $("calcBtn").disabled = false; }
}
function afterRoute(fresh) {
  analyze(FULL);
  if (state.source === "manual") { state.source = null; state.pos = null; }
  avisados.clear(); lastKms = [];
  $("manualKm").value = 0;
  $("tripMsg").textContent = `${Math.round(ROUTE.S.km)} km de ida y ${Math.round(ROUTE.N.km)} de vuelta · ${STATIONS.length} grifos cerca de la ruta.`;
  document.querySelectorAll(".needroute").forEach((el) => { el.hidden = false; });
  labels(); stamp(); render();
  if (fresh || !state.pos) fitRoute();
}

/* ---------- Puntos A y B ---------- */
async function search(which) {
  const q = $(which + "Txt").value.trim(), box = $(which + "Res");
  if (!q) return;
  box.innerHTML = `<div class="res muted">Buscando…</div>`;
  try {
    const r = await fetch(`${NOMINATIM}search?format=jsonv2&countrycodes=pe&limit=5&accept-language=es&q=${encodeURIComponent(q)}`);
    const list = await r.json();
    box.innerHTML = list.length
      ? list.map((x, i) => `<button type="button" class="res" data-res="${which}" data-i="${i}">${esc(x.display_name.split(", ").slice(0, 4).join(", "))}</button>`).join("")
      : `<div class="res muted">No encontré ese lugar. Prueba con otro nombre o elígelo en el mapa.</div>`;
    search.last = list;
  } catch { box.innerHTML = `<div class="res muted">No se pudo buscar. Revisa tu conexión.</div>`; }
}
function shortName(x) {
  const a = x.address || {};
  const main = x.name || a.road || a.suburb || a.city || a.town || a.village || "";
  const place = a.city || a.town || a.village || a.county || a.state || "";
  return [main, place].filter((v, i, arr) => v && arr.indexOf(v) === i).join(", ") || x.display_name?.split(", ").slice(0, 2).join(", ") || "Punto en el mapa";
}
function setPoint(which, p) {
  trip[which] = p;
  $(which + "Txt").value = p ? p.label : "";
  $(which + "Res").innerHTML = "";
  $("tripMsg").textContent = trip.a && trip.b ? "Toca «Calcular ruta»." : "";
  drawPoints();
}
async function reverse(lat, lng) {
  try {
    const r = await fetch(`${NOMINATIM}reverse?format=jsonv2&zoom=16&accept-language=es&lat=${lat}&lon=${lng}`);
    return shortName(await r.json());
  } catch { return `Punto en el mapa (${lat.toFixed(4)}, ${lng.toFixed(4)})`; }
}
function startPick(which) {
  state.pick = which;
  $("pickMsg").hidden = false;
  $("pickMsg").textContent = `Toca el mapa donde está el punto ${which.toUpperCase()}.`;
  $("map").scrollIntoView({ behavior: "smooth", block: "center" });
}

/* ---------- ¿Puedo entrar sin dar vuelta? ----------
   La ida y la vuelta van por calzadas distintas de la autopista. Un grifo es de tu sentido
   si está a tu derecha Y más cerca de tu calzada que de la contraria. */
function access(s, dir) {
  const me = s[dir], ot = s[dir === "S" ? "N" : "S"];
  if (s.hint) return s.hint === dir ? (me.d <= KEEP ? "yes" : "off") : (me.d <= ONROUTE ? "no" : "off");
  if (me.d > ONROUTE) return "off";
  const divided = ot.d <= ONROUTE && Math.abs(me.d - ot.d) >= 8;
  if (divided) {
    if (me.side === "R" && me.d < ot.d) return "yes";
    if (me.side === "L" && me.d > ot.d) return "no";
    return "check";
  }
  return me.side === "R" && me.d >= 12 ? "yes" : "check";
}
const quant = (a, q) => { const s = [...a].sort((x, y) => x - y); if (!s.length) return NaN; const p = (s.length - 1) * q, l = Math.floor(p), h = Math.ceil(p); return s[l] + (s[h] - s[l]) * (p - l); };

/* ---------- Mapa ---------- */
let map, routeLayer, stLayer, ptLayer, meMarker, meCircle;
function initMap() {
  map = L.map("map", { zoomControl: true, attributionControl: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  stLayer = L.layerGroup().addTo(map);
  ptLayer = L.layerGroup().addTo(map);
  map.on("dragstart", () => setFollow(false));
  map.on("click", async (e) => {
    if (!state.pick) return;
    const which = state.pick, { lat, lng } = e.latlng;
    state.pick = null; $("pickMsg").hidden = true;
    setPoint(which, { label: "Buscando el nombre…", lat, lng });
    setPoint(which, { label: await reverse(lat, lng), lat, lng });
  });
  map.fitBounds([[-18.4, -81.4], [-0.0, -68.6]]); // Perú
}
function fitRoute() { if (ROUTE) map.fitBounds(L.latLngBounds(ROUTE[state.dir].coords), { padding: [20, 20] }); }
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function drawPoints() {
  ptLayer.clearLayers();
  for (const w of ["a", "b"]) {
    const p = trip[w];
    if (p) L.marker([p.lat, p.lng], { icon: L.divIcon({ className: "abpin", html: w.toUpperCase(), iconSize: [26, 26] }) }).bindTooltip(esc(p.label)).addTo(ptLayer);
  }
  if (!ROUTE && trip.a && trip.b) map.fitBounds([[trip.a.lat, trip.a.lng], [trip.b.lat, trip.b.lng]], { padding: [40, 40] });
  else if (!ROUTE && (trip.a || trip.b)) { const p = trip.a || trip.b; map.setView([p.lat, p.lng], 12); }
}
function drawMap(list, cls) {
  routeLayer.clearLayers(); stLayer.clearLayers();
  L.polyline(ROUTE[state.dir].coords, { color: css("--me"), weight: 5, opacity: .55 }).addTo(routeLayer);
  const order = { off: 0, opp: 1, chk: 2, mid: 3, bad: 4, good: 5 };
  list.map((s) => ({ s, c: s.acc === "yes" ? cls(s) : s.acc === "check" ? "chk" : s.acc === "no" ? "opp" : "off" }))
    .sort((a, b) => order[a.c] - order[b.c])
    .forEach(({ s, c }) => {
      const hollow = c === "opp" || c === "off";
      const m = L.circleMarker([s.lat, s.lng], {
        radius: hollow ? 6 : 8, weight: 2,
        color: hollow ? css("--muted") : c === "chk" ? "#8A6500" : "#fff",
        fillColor: css("--pt-" + (c === "off" ? "opp" : c)), fillOpacity: 1
      }).addTo(stLayer);
      const txt = { yes: "En tu sentido", no: "Otro sentido: necesitas retorno", check: "Por confirmar", off: `A ${s.d} m de la ruta` }[s.acc];
      m.bindPopup(`<div class="pp"><div class="nm">${esc(s.name)}</div><div class="ad">${esc(s.addr)}</div><div class="row2"><span>km ${Math.round(s.km)} · ${txt}</span><b>S/ ${fmt(s.price)}</b></div><a href="${gmaps(s.lat, s.lng)}" target="_blank" rel="noopener">Cómo llegar en Google Maps</a></div>`);
      s._marker = m;
    });
}
function drawMe() {
  if (!state.pos || state.source !== "gps") { meMarker && meMarker.remove(); meCircle && meCircle.remove(); meMarker = meCircle = null; return; }
  const ll = [state.pos.lat, state.pos.lng];
  if (!meMarker) {
    meCircle = L.circle(ll, { radius: state.pos.acc || 30, color: css("--me"), weight: 1, fillOpacity: .12 }).addTo(map);
    meMarker = L.circleMarker(ll, { radius: 9, color: "#fff", weight: 3, fillColor: css("--me"), fillOpacity: 1 }).addTo(map);
  } else { meMarker.setLatLng(ll); meCircle.setLatLng(ll).setRadius(state.pos.acc || 30); }
  if (state.follow) map.setView(ll, Math.max(map.getZoom(), 13), { animate: true });
}
function setFollow(v) { state.follow = v; $("followBtn").setAttribute("aria-pressed", String(v)); }

/* ---------- GPS ---------- */
let watchId = null, wakeLock = null, lastKms = [];
async function startGPS() {
  if (!("geolocation" in navigator)) { $("gpsState").textContent = "Este navegador no tiene GPS disponible."; return; }
  if (!window.isSecureContext) { $("gpsState").textContent = "El GPS solo funciona si abres la página con https (GitHub Pages)."; return; }
  $("gpsState").textContent = "Buscando tu ubicación…";
  watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  $("gpsBtn").textContent = "Detener GPS"; $("gpsBtn").classList.add("on");
  document.querySelector(".manual").classList.add("gps");
  setFollow(true);
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}
function stopGPS() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null; state.source = null; state.pos = null; lastKms = [];
  $("gpsBtn").textContent = "Activar GPS"; $("gpsBtn").classList.remove("on");
  document.querySelector(".manual").classList.remove("gps");
  $("gpsState").textContent = "GPS detenido. Puedes indicar el km a mano.";
  try { wakeLock?.release(); } catch {}
  render();
}
function onPos(p) {
  const { latitude: lat, longitude: lng, accuracy: acc } = p.coords;
  const pr = project(ROUTE[state.dir], lat, lng);
  state.pos = { lat, lng, acc, km: pr.km, off: pr.d }; state.source = "gps";
  const t = new Date(p.timestamp).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
  $("gpsState").textContent = pr.d > 1500
    ? `Estás a ${(pr.d / 1000).toFixed(1)} km de la ruta. Te ubico en el km ${Math.round(pr.km)} más cercano (${t}).`
    : `Vas por el km ${Math.round(pr.km)} de ${Math.round(ROUTE[state.dir].km)} · precisión ${Math.round(acc)} m · ${t}`;
  // ¿el km baja mientras avanzas? probablemente vas en el otro sentido
  lastKms.push(pr.km); if (lastKms.length > 6) lastKms.shift();
  const drop = lastKms.length >= 4 && lastKms[0] - lastKms[lastKms.length - 1] > 0.8;
  $("dirWarn").hidden = !drop;
  if (drop) $("dirWarn").innerHTML = `Parece que vas en el otro sentido. <button type="button" id="swapDir">Cambiar a ${state.dir === "S" ? "vuelta" : "ida"}</button>`;
  render();
}
function onPosErr(e) {
  const msg = { 1: "No diste permiso de ubicación. Actívalo en los ajustes del navegador para esta página.", 2: "No se pudo obtener la ubicación. Revisa que el GPS del celular esté encendido.", 3: "El GPS tarda en responder. Sigue intentando…" }[e.code] || e.message;
  $("gpsState").textContent = msg;
}

/* ---------- Avisos locales ----------
   Notificaciones del propio navegador, sin push ni servidores: se disparan desde la página
   mientras el GPS está activo. La distancia se mide a lo largo de la ruta. */
let swReg = null;
const avisados = new Set(); // "id:metros" ya notificados
async function enableNotify() {
  if (!("Notification" in window)) { $("gpsState").textContent = "Este navegador no permite notificaciones. En iPhone, primero añade la página a la pantalla de inicio y ábrela desde ahí."; return false; }
  if (!window.isSecureContext) { $("gpsState").textContent = "Las notificaciones solo funcionan si abres la página con https (GitHub Pages)."; return false; }
  if (await Notification.requestPermission() !== "granted") { $("gpsState").textContent = "No diste permiso de notificaciones. Actívalo en los ajustes del navegador para esta página."; return false; }
  try { swReg = await navigator.serviceWorker?.register("sw.js"); } catch {}
  return true;
}
async function notify(t, body) {
  const opt = { body, tag: "grifo-cerca", renotify: true, vibrate: [300, 150, 300] };
  try {
    const reg = swReg || await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(t, opt); else new Notification(t, opt);
  } catch (e) { console.warn(e); }
  try { navigator.vibrate?.(opt.vibrate); } catch {}
}
function checkAviso(best, here) {
  if (!state.notify || state.source !== "gps" || !best) return;
  const falta = (best.km - here) * 1000;
  if (falta < -30) return; // ya lo pasaste
  const nuevos = AVISOS.filter((m) => falta <= m && !avisados.has(`${best.id}:${m}`));
  if (!nuevos.length) return;
  AVISOS.filter((m) => falta <= m).forEach((m) => avisados.add(`${best.id}:${m}`)); // si saltó varios umbrales, un solo aviso
  const m = Math.min(...nuevos);
  notify(`En ${dist(m)}, a tu derecha: ${best.name}`, `${FUELN[state.fuel]} a S/ ${fmt(best.price)}. El más barato de los próximos km; entras sin retorno.`);
}

/* ---------- Render ---------- */
function render() {
  if (!ROUTE) return;
  const { dir, fuel, gal } = state;
  const R = ROUTE[dir];
  store.set("prefs", { dir, fuel, tank: gal, horizon: state.horizon, hidePassed: state.hidePassed, notify: state.notify });
  if (state.source === "gps" && state.pos) state.pos.km = project(R, state.pos.lat, state.pos.lng).km;
  const here = state.pos ? state.pos.km : null;

  const all = STATIONS.filter((s) => s.prices[fuel] != null)
    .map((s) => ({ ...s, ...s[dir], price: s.prices[fuel], acc: access(s, dir) }))
    .sort((a, b) => a.km - b.km);
  const on = all.filter((s) => s.acc === "yes");
  const chk = all.filter((s) => s.acc === "check"), opp = all.filter((s) => s.acc === "no");
  const prices = on.map((s) => s.price);
  const p25 = quant(prices, .25), p75 = quant(prices, .75), med = quant(prices, .5);
  const avg = prices.reduce((a, b) => a + b, 0) / (prices.length || 1);
  const cls = (s) => s.price <= p25 ? "good" : s.price >= p75 && s.price - med >= 0.3 ? "bad" : "mid";
  const passed = (s) => here != null && s.km < here - 0.3;

  // Próximos grifos desde mi posición
  if (here != null) {
    const ahead = on.filter((s) => !passed(s));
    const next = ahead[0];
    const win = ahead.filter((s) => s.km - here <= state.horizon);
    const best = [...win].sort((a, b) => a.price - b.price || a.km - b.km)[0];
    const card = (lbl, s, extra) => s ? `<div class="next ${extra || ""}"><div class="lbl">${lbl}</div><div class="nm">${esc(s.name)}</div><div class="meta"><span>en ${Math.max(0, s.km - here).toFixed(1)} km · ~${Math.max(1, Math.round((s.km - here) / SPEED * 60))} min</span><span class="price">${fmt(s.price)}</span></div><div class="links"><button type="button" class="lnk" data-focus="${s.id}">Ver en el mapa</button><a class="lnk" href="${gmaps(s.lat, s.lng)}" target="_blank" rel="noopener">Cómo llegar</a></div></div>`
      : `<div class="next"><div class="lbl">${lbl}</div><div class="nm">No quedan grifos de tu sentido en este tramo.</div></div>`;
    checkAviso(best, here);
    $("nextGrid").innerHTML = card(state.horizon > 5000 ? "Más barato en lo que falta" : `Más barato en los próximos ${state.horizon} km`, best, "best") + (next && best && next.id !== best.id ? card("El próximo de tu sentido", next) : "");
  } else $("nextGrid").innerHTML = "";

  // Paradas sugeridas (tercios del viaje)
  const total = R.km, labelsT = ["Al salir", "A mitad de camino", "Al llegar"];
  $("stops").innerHTML = [0, 1, 2].map((i) => {
    const a = total * i / 3, b = total * (i + 1) / 3;
    const s = on.filter((x) => x.km >= a && x.km < b).sort((x, y) => x.price - y.price)[0];
    return s ? `<div class="stop${passed(s) ? " passed" : ""}"><div class="lbl">${labelsT[i]} · km ${Math.round(a)}–${Math.round(b)}${passed(s) ? " · ya pasaste" : ""}</div><div class="nm">${esc(s.name)}</div><div class="meta"><span>km ${Math.round(s.km)} · entras sin retorno</span><span class="price">${fmt(s.price)}</span></div><div class="ad">${esc(s.addr)}</div><div class="links"><button type="button" class="lnk" data-focus="${s.id}">Ver en el mapa</button><a class="lnk" href="${gmaps(s.lat, s.lng)}" target="_blank" rel="noopener">Cómo llegar</a></div></div>`
      : `<div class="stop"><div class="lbl">${labelsT[i]}</div><div class="nm">Sin grifos con este combustible en el tramo.</div></div>`;
  }).join("");
  if (on.length) {
    const bestAll = on.reduce((a, b) => (b.price < a.price ? b : a));
    $("summary").innerHTML = `<span>${FUELN[fuel]}: ${on.length} grifos en tu sentido</span><span>Promedio <b class="num">S/ ${fmt(avg)}</b></span><span>Con ${gal} gal en el más barato ahorras <b class="num">S/ ${fmt((avg - bestAll.price) * gal)}</b> frente al promedio y <b class="num">S/ ${fmt((p75 - bestAll.price) * gal)}</b> frente a uno de los marcados «Evitar»</span>`;
  } else $("summary").innerHTML = "";

  const lbl = dir === "S" ? `${trip.a.label} → ${trip.b.label}` : `${trip.b.label} → ${trip.a.label}`;
  const visible = state.hidePassed ? on.filter((s) => !passed(s)) : on;
  $("listTitle").textContent = `En tu sentido (${lbl}): ${visible.length} grifos`;
  $("listNote").textContent = "Están a tu derecha, del lado de la calzada por la que vas. Entras y sales sin dar vuelta. Ordenados por el km en que los pasas.";
  $("chkTitle").textContent = `Por confirmar (${chk.length})`;
  $("oppTitle").textContent = `Del otro sentido: necesitas un retorno (${opp.length})`;

  const row = (s) => {
    const c = s.acc === "yes" ? cls(s) : "other";
    const pill = s.acc === "no" ? `<span class="pill bad">Otro sentido</span>` : s.acc === "check" ? `<span class="pill warnp">Verificar</span>`
      : c === "good" ? `<span class="pill good">Cargar aquí</span>` : c === "bad" ? `<span class="pill bad">Evitar</span>` : `<span class="pill mid">Precio medio</span>`;
    const tags = [];
    if (here != null && s.acc === "yes") tags.push(passed(s) ? ["Ya pasaste", ""] : [`En ${(s.km - here).toFixed(1)} km`, "ahead"]);
    if (s.acc === "yes") tags.push(["A tu derecha", ""]);
    if (s.acc === "no") tags.push(["Calzada contraria", ""]);
    if (s.acc === "check") tags.push([s.side === "L" ? "Lado izquierdo" : "Sobre el eje de la vía", ""]);
    return `<div class="row ${c} ${passed(s) && s.acc === "yes" ? "passed" : ""}"><div class="km"><small>KM</small>${Math.round(s.km)}</div><div class="info"><div class="nm">${esc(s.name)}</div><div class="ad">${esc(s.addr)}</div><div class="tags">${tags.map(([t, k]) => `<span class="tag ${k}">${t}</span>`).join("")}</div><div class="links"><button type="button" class="lnk" data-focus="${s.id}">Ver en el mapa</button><a class="lnk" href="${gmaps(s.lat, s.lng)}" target="_blank" rel="noopener">Cómo llegar</a></div></div><div class="right"><span class="price">${fmt(s.price)}</span>${pill}</div></div>`;
  };
  const empty = `<div class="row empty">Ninguno</div>`;
  $("list").innerHTML = visible.map(row).join("") || empty;
  $("chkList").innerHTML = chk.map(row).join("") || empty;
  $("oppList").innerHTML = opp.map(row).join("") || empty;

  drawMap(all.filter((s) => s.acc !== "off"), cls);
  drawMe();
  $("manualKm").max = Math.round(R.km);
  if (state.source !== "gps") $("manualOut").textContent = `km ${$("manualKm").value}`;
  render.all = all;
}
function labels() {
  $("dir").options[0].text = `Ida: ${trip.a.label} → ${trip.b.label}`;
  $("dir").options[1].text = `Vuelta: ${trip.b.label} → ${trip.a.label}`;
  $("routeName").textContent = `${trip.a.label} – ${trip.b.label}`;
}

/* ---------- Antigüedad y "Actualizar precios" ---------- */
const provName = (c) => { const p = PROVS.find((x) => x.c === c); return p ? title(p.prov) : c; };
function routeAge() {
  const ts = ROUTE_PROVS.map((c) => PRICES.provinces[c]);
  if (!ts.length) return null;
  return ts.some((t) => !t) ? 0 : Math.min(...ts.map((t) => +new Date(t)));
}
function ago(ms) {
  const h = (Date.now() - ms) / 36e5;
  if (h < 1) return `hace ${Math.max(1, Math.round(h * 60))} min`;
  if (h < 36) return `hace ${Math.round(h)} h`;
  return `hace ${Math.round(h / 24)} días`;
}
function repoInfo() {
  const h = location.hostname;
  if (!h.endsWith("github.io")) return null;
  const user = h.split(".")[0], repo = location.pathname.split("/").filter(Boolean)[0] || `${user}.github.io`;
  return { user, repo };
}
function stamp() {
  const b = $("updateBtn");
  if (!ROUTE) { $("stamp").textContent = `Precios de todo el Perú del ${new Date(PRICES.updatedAt).toLocaleString("es-PE", { timeZone: "America/Lima", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" })} · Elige A y B.`; b.hidden = true; return; }
  const t = routeAge();
  if (t == null) { $("stamp").textContent = "No hay grifos registrados en Facilito cerca de esta ruta."; b.hidden = true; return; }
  const hours = (Date.now() - t) / 36e5;
  const provs = ROUTE_PROVS.map(provName).join(", ");
  $("stamp").textContent = t === 0
    ? `Aún no hay precios de alguna provincia de esta ruta (${provs}). Actualízalos.`
    : `Precios de esta ruta ${ago(t)} (${new Date(t).toLocaleString("es-PE", { timeZone: "America/Lima", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}) · ${ROUTE_PROVS.length} provincia(s): ${provs}`;
  $("stamp").classList.toggle("stale", t === 0 || hours > 12);
  const gh = repoInfo();
  b.hidden = !gh || !!pending();
  if (gh) {
    const ruta = `${trip.a.label} → ${trip.b.label}`;
    b.href = `https://github.com/${gh.user}/${gh.repo}/issues/new?template=v2-precios.yml&title=${encodeURIComponent("[v2] Actualizar precios · " + ruta)}&ruta=${encodeURIComponent(ruta)}&provincias=${ROUTE_PROVS.join(",")}`;
  }
}
// Mientras la Action trabaja: se consulta precios.json cada 20 s hasta que esas provincias tengan fecha nueva
const pending = () => store.get("pending");
let pollTimer = null;
function watchRefresh() {
  clearInterval(pollTimer);
  const p = pending();
  if (!p) { $("refresh").hidden = true; return; }
  const tick = async () => {
    const min = (Date.now() - p.at) / 6e4;
    if (min > GIVEUP) {
      store.set("pending", null); clearInterval(pollTimer);
      const gh = repoInfo();
      $("refresh").innerHTML = `La actualización no terminó en ${GIVEUP} min. ${gh ? `<a href="https://github.com/${gh.user}/${gh.repo}/actions" target="_blank" rel="noopener">Revisa la Action</a> o vuelve a intentarlo.` : ""}`;
      stamp(); return;
    }
    const left = Math.max(0, ETA[1] - min);
    $("refresh").hidden = false;
    $("refresh").innerHTML = `<b>Actualizando precios de ${p.provs.length} provincia(s)…</b> Si aún no lo hiciste, en GitHub toca <b>Create</b>. Suele tardar ${ETA[0]} a ${ETA[1]} min: van ${Math.floor(min)}:${String(Math.floor((min % 1) * 60)).padStart(2, "0")}${left > 0 ? `, faltan ~${Math.ceil(left)} min` : ", ya casi"}. <button type="button" id="cancelRefresh">Dejar de esperar</button>`;
    try {
      const j = await (await fetch("data/precios.json?v=" + Date.now())).json();
      if (p.provs.every((c) => j.provinces[c] && +new Date(j.provinces[c]) > p.at - 6e4)) {
        store.set("pending", null); clearInterval(pollTimer);
        PRICES = j;
        if (FULL) afterRoute(false);
        $("refresh").innerHTML = `<b>Precios actualizados.</b>`;
        setTimeout(() => { $("refresh").hidden = true; }, 8000);
        stamp();
      }
    } catch {}
  };
  tick(); pollTimer = setInterval(tick, 20000);
}

/* ---------- Eventos ---------- */
function bind() {
  const saved = store.get("prefs") || {};
  $("dir").value = saved.dir || "S"; $("fuel").value = saved.fuel || "P";
  $("tank").value = saved.tank || 10; $("horizon").value = String(saved.horizon || 60);
  $("hidePassed").checked = saved.hidePassed ?? true;
  const read = () => { state.dir = $("dir").value; state.fuel = $("fuel").value; state.gal = Math.max(1, +$("tank").value || 10); state.horizon = +$("horizon").value; state.hidePassed = $("hidePassed").checked; };
  read();
  ["dir", "fuel", "tank", "horizon", "hidePassed"].forEach((id) => $(id).addEventListener("input", () => {
    const dirChanged = id === "dir"; read(); lastKms = []; $("dirWarn").hidden = true;
    if (dirChanged) avisados.clear();
    if (dirChanged && state.source !== "gps") { state.pos = null; $("manualKm").value = 0; }
    render(); if (dirChanged && !state.pos) fitRoute();
  }));
  $("gpsBtn").onclick = () => (watchId == null ? startGPS() : stopGPS());
  $("notifyTxt").textContent = `Avisarme a ${AVISOS.map(dist).join(" y ")} del más barato`;
  state.notify = !!saved.notify && window.Notification?.permission === "granted";
  $("notify").checked = state.notify;
  if (state.notify) navigator.serviceWorker?.register("sw.js").then((r) => { swReg = r; }).catch(() => {});
  $("notify").addEventListener("change", async () => {
    state.notify = $("notify").checked && await enableNotify();
    $("notify").checked = state.notify;
    render();
  });
  $("manualKm").addEventListener("input", () => {
    if (state.source === "gps") return;
    const km = +$("manualKm").value; state.source = "manual"; state.pos = { km };
    $("gpsState").textContent = `Ubicación indicada a mano: km ${km}.`;
    render();
  });
  $("followBtn").onclick = () => { setFollow(!state.follow); drawMe(); };
  $("fitBtn").onclick = () => { setFollow(false); fitRoute(); };

  // Puntos A y B
  for (const w of ["a", "b"]) {
    $(w + "Txt").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); search(w); } });
    $(w + "Txt").addEventListener("input", () => { if (trip[w] && $(w + "Txt").value !== trip[w].label) { trip[w] = null; drawPoints(); } });
  }
  $("aGps").onclick = () => {
    if (!navigator.geolocation) return;
    $("tripMsg").textContent = "Buscando tu ubicación…";
    navigator.geolocation.getCurrentPosition(async (p) => {
      const { latitude: lat, longitude: lng } = p.coords;
      setPoint("a", { label: "Mi ubicación", lat, lng });
      setPoint("a", { label: await reverse(lat, lng), lat, lng });
    }, onPosErr, { enableHighAccuracy: true, timeout: 20000 });
  };
  $("swapAB").onclick = () => { const a = trip.a; setPoint("a", trip.b); setPoint("b", a); };
  $("calcBtn").onclick = calcRoute;
  $("updateBtn").addEventListener("click", () => {
    store.set("pending", { at: Date.now(), provs: ROUTE_PROVS });
    $("updateBtn").hidden = true;
    watchRefresh();
  });

  document.addEventListener("click", (e) => {
    const find = e.target.closest("[data-find]"); if (find) search(find.dataset.find);
    const pick = e.target.closest("[data-pick]"); if (pick) startPick(pick.dataset.pick);
    const res = e.target.closest("[data-res]");
    if (res) { const x = search.last[+res.dataset.i]; setPoint(res.dataset.res, { label: shortName(x), lat: +x.lat, lng: +x.lon }); }
    const b = e.target.closest("[data-focus]");
    if (b) {
      const s = (render.all || []).find((x) => x.id === b.dataset.focus);
      if (s && s._marker) { setFollow(false); map.setView([s.lat, s.lng], 16); s._marker.openPopup(); $("map").scrollIntoView({ behavior: "smooth", block: "center" }); }
    }
    if (e.target.id === "swapDir") { $("dir").value = state.dir === "S" ? "N" : "S"; $("dir").dispatchEvent(new Event("input")); }
    if (e.target.id === "cancelRefresh") { store.set("pending", null); watchRefresh(); stamp(); }
  });
  document.addEventListener("visibilitychange", async () => { if (document.visibilityState === "visible" && watchId != null) { try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {} } });
}

async function main() {
  // Mapa y buscadores funcionan aunque los precios no carguen
  initMap(); bind();
  if (location.protocol === "file:") throw new Error("la página se abrió como archivo; ábrela con un servidor (por ejemplo python -m http.server) o desde GitHub Pages");
  const v = "?v=" + Date.now();
  [PRICES, PROVS] = await Promise.all(["data/precios.json", "provincias.json"].map((f) => fetch(f + v).then((r) => { if (!r.ok) throw new Error("no se encontró " + f); return r.json(); })));
  // Última ruta calculada: se recalcula con los precios de hoy sin volver a pedir la ruta
  const last = store.get("route");
  if (last?.full) {
    setPoint("a", last.a); setPoint("b", last.b); FULL = last.full;
    afterRoute(true);
  } else {
    // Primera vez: se sugiere la ruta de v1
    try {
      const cfg = await (await fetch("../config.json" + v)).json();
      setPoint("a", cfg.route.origin); setPoint("b", cfg.route.destination);
    } catch {}
    stamp();
  }
  watchRefresh();
}
main().catch((e) => { $("stamp").textContent = "No se pudieron cargar los precios: " + e.message + "."; $("stamp").classList.add("stale"); console.error(e); });
})();
