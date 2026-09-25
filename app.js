/* Grifos en ruta: app estática (GitHub Pages). Datos en data/*.json, generados por scripts/build.mjs */
(() => {
"use strict";
const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toFixed(2);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const FUELN = { P: "Gasohol Premium", R: "Gasohol Regular", D: "Diésel DB5" };
const ONROUTE = 150;           // m: a esta distancia o menos se considera "en ruta"
const SPEED = 85;              // km/h promedio para estimar minutos
const AVISOS = [1000, 300];     // m antes del más barato en que llega una notificación
const dist = (m) => (m >= 1000 ? `${m / 1000} km` : `${m} m`);
const gmaps = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;

const small = new Set(["de", "del", "la", "las", "los", "y", "e", "en"]);
const title = (s) => s.toLowerCase()
  .replace(/(^|[\s(\-–/.])([a-záéíóúñü])/g, (m, a, b) => a + b.toUpperCase())
  .replace(/\b(S\.?a\.?c?\.?|E\.?i\.?r\.?l\.?|S\.?r\.?l\.?|Ee\.?ss\.?|Es)\b/gi, (m) => m.toUpperCase())
  .split(" ").map((w, i) => (i && small.has(w.toLowerCase()) ? w.toLowerCase() : w)).join(" ");

let CFG, ROUTE, STATIONS, META;
const state = { dir: "S", fuel: "P", gal: 10, horizon: 60, pos: null, source: null, follow: true, hidePassed: true, notify: false };
const store = {
  get() { try { return JSON.parse(localStorage.getItem("grifos-ruta") || "{}"); } catch { return {}; } },
  set(v) { try { localStorage.setItem("grifos-ruta", JSON.stringify(v)); } catch {} }
};

/* ---------- Geometría ---------- */
const RAD = Math.PI / 180;
let P; // proyección plana en metros
function prepRoute(r) {
  const pts = r.coords.map(P), cum = [0];
  for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  r.pts = pts; r.cum = cum; r.scale = (r.km * 1000) / cum[cum.length - 1]; // corrige la simplificación
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

/* ---------- ¿Puedo entrar sin dar vuelta? ----------
   La ida y la vuelta van por calzadas distintas de la autopista. Un grifo es de tu sentido
   si está a tu derecha Y más cerca de tu calzada que de la contraria. */
function access(s, dir) {
  const me = s[dir], ot = s[dir === "S" ? "N" : "S"];
  if (s.hint) return s.hint === dir ? (me.d <= 700 ? "yes" : "off") : (me.d <= ONROUTE ? "no" : "off");
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
let map, routeLayer, stLayer, meMarker, meCircle;
function initMap() {
  map = L.map("map", { zoomControl: true, attributionControl: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  stLayer = L.layerGroup().addTo(map);
  map.on("dragstart", () => setFollow(false));
}
function fitRoute() { map.fitBounds(L.latLngBounds(ROUTE[state.dir].coords), { padding: [20, 20] }); }
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function drawMap(list, cls) {
  routeLayer.clearLayers(); stLayer.clearLayers();
  L.polyline(ROUTE[state.dir].coords, { color: css("--me"), weight: 5, opacity: .55 }).addTo(routeLayer);
  const order = { off: 0, opp: 1, chk: 2, mid: 3, bad: 4, good: 5 };
  list.map((s) => ({ s, c: s.acc === "yes" ? cls(s) : s.acc === "check" ? "chk" : s.acc === "no" ? "opp" : "off" }))
    .sort((a, b) => order[a.c] - order[b.c])
    .forEach(({ s, c }) => {
      const hollow = c === "opp" || c === "off";
      const m = L.circleMarker([s.lat, s.lng], {
        radius: hollow ? 6 : 8, weight: hollow ? 2 : 2,
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
   mientras el GPS está activo. La distancia se mide a lo largo de la ruta (el grifo puede
   estar hasta 150 m al costado de la pista). */
let swReg = null;
const avisados = new Set(); // "id:metros" ya notificados
async function enableNotify() {
  if (!("Notification" in window)) { $("gpsState").textContent = "Este navegador no permite notificaciones. En iPhone, primero añade la página a la pantalla de inicio y ábrela desde ahí."; return false; }
  if (!window.isSecureContext) { $("gpsState").textContent = "Las notificaciones solo funcionan si abres la página con https (GitHub Pages)."; return false; }
  if (await Notification.requestPermission() !== "granted") { $("gpsState").textContent = "No diste permiso de notificaciones. Actívalo en los ajustes del navegador para esta página."; return false; }
  try { swReg = await navigator.serviceWorker?.register("sw.js"); } catch {}
  return true;
}
async function notify(title, body) {
  const opt = { body, tag: "grifo-cerca", renotify: true, vibrate: [300, 150, 300] };
  try {
    const reg = swReg || await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, opt); else new Notification(title, opt);
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
  const { dir, fuel, gal } = state;
  const R = ROUTE[dir];
  store.set({ dir, fuel, tank: gal, horizon: state.horizon, hidePassed: state.hidePassed, notify: state.notify });
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
  const total = R.km, labels = ["Al salir", "A mitad de camino", "Al llegar"];
  $("stops").innerHTML = [0, 1, 2].map((i) => {
    const a = total * i / 3, b = total * (i + 1) / 3;
    const s = on.filter((x) => x.km >= a && x.km < b).sort((x, y) => x.price - y.price)[0];
    return s ? `<div class="stop${passed(s) ? " passed" : ""}"><div class="lbl">${labels[i]} · km ${Math.round(a)}–${Math.round(b)}${passed(s) ? " · ya pasaste" : ""}</div><div class="nm">${esc(s.name)}</div><div class="meta"><span>km ${Math.round(s.km)} · entras sin retorno</span><span class="price">${fmt(s.price)}</span></div><div class="ad">${esc(s.addr)}</div><div class="links"><button type="button" class="lnk" data-focus="${s.id}">Ver en el mapa</button><a class="lnk" href="${gmaps(s.lat, s.lng)}" target="_blank" rel="noopener">Cómo llegar</a></div></div>`
      : `<div class="stop"><div class="lbl">${labels[i]}</div><div class="nm">Sin grifos con este combustible en el tramo.</div></div>`;
  }).join("");
  if (on.length) {
    const bestAll = on.reduce((a, b) => (b.price < a.price ? b : a));
    $("summary").innerHTML = `<span>${FUELN[fuel]}: ${on.length} grifos en tu sentido</span><span>Promedio <b class="num">S/ ${fmt(avg)}</b></span><span>Con ${gal} gal en el más barato ahorras <b class="num">S/ ${fmt((avg - bestAll.price) * gal)}</b> frente al promedio y <b class="num">S/ ${fmt((p75 - bestAll.price) * gal)}</b> frente a uno de los marcados «Evitar»</span>`;
  } else $("summary").innerHTML = "";

  const lbl = dir === "S" ? `${CFG.route.origin.label} → ${CFG.route.destination.label}` : `${CFG.route.destination.label} → ${CFG.route.origin.label}`;
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

/* ---------- Eventos ---------- */
function bind() {
  const saved = store.get();
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
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-focus]");
    if (b) {
      const s = (render.all || []).find((x) => x.id === b.dataset.focus);
      if (s && s._marker) { setFollow(false); map.setView([s.lat, s.lng], 16); s._marker.openPopup(); $("map").scrollIntoView({ behavior: "smooth", block: "center" }); }
    }
    if (e.target.id === "swapDir") { $("dir").value = state.dir === "S" ? "N" : "S"; $("dir").dispatchEvent(new Event("input")); }
  });
  document.addEventListener("visibilitychange", async () => { if (document.visibilityState === "visible" && watchId != null) { try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {} } });
}

function stamp() {
  const d = new Date(META.updatedAt);
  const txt = d.toLocaleString("es-PE", { timeZone: "America/Lima", weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
  const hours = (Date.now() - d) / 36e5;
  $("stamp").textContent = `Precios de Facilito (Osinergmin) del ${txt}` + (hours > 30 ? ` · tienen más de ${Math.floor(hours / 24) || 1} día(s), actualízalos` : "");
  $("stamp").classList.toggle("stale", hours > 30);
  // Botón que lleva a la Action del repo (solo en GitHub Pages)
  const h = location.hostname;
  if (h.endsWith("github.io")) {
    const user = h.split(".")[0], repo = location.pathname.split("/").filter(Boolean)[0] || `${user}.github.io`;
    const b = $("updateBtn"); b.href = `https://github.com/${user}/${repo}/actions/workflows/update.yml`; b.hidden = false;
  }
}

async function main() {
  const v = "?v=" + Date.now();
  [CFG, ROUTE, STATIONS, META] = await Promise.all(["config.json", "data/route.json", "data/stations.json", "data/meta.json"].map((f) => fetch(f + v).then((r) => { if (!r.ok) throw new Error(f); return r.json(); })));
  STATIONS.forEach((s) => { s.id = String(s.id); s.name = title(s.name); s.addr = title(s.addr); });
  const lat0 = (CFG.route.origin.lat + CFG.route.destination.lat) / 2;
  const kx = 6371000 * Math.cos(lat0 * RAD) * RAD, ky = 6371000 * RAD;
  P = ([lat, lng]) => [lng * kx, lat * ky];
  prepRoute(ROUTE.S); prepRoute(ROUTE.N);
  $("routeName").textContent = `Panamericana Sur · ${CFG.route.name}`;
  $("dir").options[0].text = `Ida: ${CFG.route.origin.label} → ${CFG.route.destination.label}`;
  $("dir").options[1].text = `Vuelta: ${CFG.route.destination.label} → ${CFG.route.origin.label}`;
  stamp(); initMap(); bind(); render(); fitRoute();
}
main().catch((e) => { $("stamp").textContent = "No se pudieron cargar los datos (" + e.message + "). Revisa que la carpeta data/ esté en el repositorio."; console.error(e); });
})();
