// Descarga la ruta (OSRM) y los precios de Facilito (Osinergmin) y genera los archivos de data/.
// Uso: node scripts/build.mjs   (Node 20 o superior, sin dependencias)
import { readFile, writeFile, mkdir } from "node:fs/promises";

const ROOT = new URL("..", import.meta.url);
const cfg = JSON.parse(await readFile(new URL("config.json", ROOT), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = "grifos-ruta/1.0 (proyecto personal; GitHub Actions)";

async function get(url, { binary = false, tries = 3 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "es-PE,es" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
      return binary ? new Uint8Array(await res.arrayBuffer()) : await res.json();
    } catch (e) {
      last = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw last;
}

// ---------- Ruta ----------
async function route(a, b) {
  const url = `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`;
  const j = await get(url);
  if (j.code !== "Ok") throw new Error("OSRM: " + j.code);
  const r = j.routes[0];
  return { coords: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]), km: r.distance / 1000 };
}

// ---------- Geometría ----------
const RAD = Math.PI / 180;
function projector(lat0) {
  const kx = 6371000 * Math.cos(lat0 * RAD) * RAD, ky = 6371000 * RAD;
  return ([lat, lng]) => [lng * kx, lat * ky];
}
function analyze(coords, P) {
  const pts = coords.map(P);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return { pts, cum };
}
function nearest(R, q) {
  let best = { d: Infinity };
  for (let i = 1; i < R.pts.length; i++) {
    const a = R.pts[i - 1], b = R.pts[i];
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
    let t = ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(q[0] - (a[0] + t * dx), q[1] - (a[1] + t * dy));
    if (d < best.d) {
      const cross = dx * (q[1] - a[1]) - dy * (q[0] - a[0]);
      best = { d, km: (R.cum[i - 1] + t * Math.sqrt(L2)) / 1000, side: cross < 0 ? "R" : "L" };
    }
  }
  return { d: Math.round(best.d), km: +best.km.toFixed(2), side: best.side };
}
// Douglas-Peucker para aligerar la ruta que se dibuja
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

// ---------- Facilito ----------
const ENT = { amp: "&", ntilde: "ñ", Ntilde: "Ñ", aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", uuml: "ü", deg: "°", ordm: "º", quot: '"', apos: "'", nbsp: " " };
// Códigos 128–159 son de Windows-1252 (p. ej. &#150; = "–"), como manda el estándar HTML.
// Tabla explícita: el TextDecoder("windows-1252") de Node los deja como controles de Latin-1.
const CP1252 = "€\x81‚ƒ„…†‡ˆ‰Š‹Œ\x8dŽ\x8f\x90‘’“”•–—˜™š›œ\x9džŸ";
const fromCode = (c) => (c >= 0x80 && c <= 0x9f ? CP1252[c - 0x80] : String.fromCodePoint(c));
function decodeEntities(s) {
  let prev;
  do {
    prev = s;
    s = s.replace(/&#x([0-9a-f]+);/gi, (m, h) => fromCode(parseInt(h, 16)))
         .replace(/&#(\d+);/g, (m, d) => fromCode(+d))
         .replace(/&([a-z]+);/gi, (m, n) => ENT[n] ?? ENT[n.toLowerCase()] ?? (n.toUpperCase() === n ? (ENT[n[0] + n.slice(1).toLowerCase()] ?? m) : m));
  } while (s !== prev);
  return s.replace(/[\x80-\x9f]/g, (c) => fromCode(c.codePointAt(0))).replace(/\s+/g, " ").trim();
}
async function facilito(dep, prov, prod) {
  const url = `https://www.facilito.gob.pe/facilito/actions/MapaAction.do?departamento=${dep}&provincia=${prov}&distrito=9999999&producto=${prod}&method=mostrarMapa&subtitulocabecera=1&tipo=LIQ`;
  const html = new TextDecoder("windows-1252").decode(await get(url, { binary: true }));
  const m = html.match(/var listaPuntos = eval \('\(' \+ '(.*?)' \+ '\)'\);/s);
  if (!m) throw new Error(`Facilito cambió su formato (provincia ${prov})`);
  return JSON.parse(m[1].replace(/\\'/g, "'"));
}

// ---------- Principal ----------
const { origin, destination } = cfg.route;
console.log("Calculando ruta de ida y vuelta…");
const S = await route(origin, destination);
await sleep(1000);
const N = await route(destination, origin);
const P = projector((origin.lat + destination.lat) / 2);
const RS = analyze(S.coords, P), RN = analyze(N.coords, P);

console.log("Descargando grifos de Facilito…");
const all = new Map();
let ok = 0;
for (const p of cfg.provinces) {
  for (const [code, key] of Object.entries(cfg.products)) {
    try {
      const list = await facilito(p.departamento, p.provincia, code);
      ok++;
      for (const s of list) {
        const id = s.codigoOsinergmin;
        const cur = all.get(id) ?? { id, name: decodeEntities(s.unidad), addr: decodeEntities(s.direccion), lat: s.latitud, lng: s.longitud, prices: {} };
        for (const pr of s.productos || []) {
          const k = /PREMIUM/i.test(pr.producto) ? "P" : /REGULAR/i.test(pr.producto) ? "R" : /DIESEL|DB5/i.test(pr.producto) ? "D" : null;
          if (k && pr.precioVenta) cur.prices[k] = pr.precioVenta;
        }
        all.set(id, cur);
      }
      console.log(`  ${p.name} ${key}: ${list.length}`);
    } catch (e) {
      console.warn(`  ${p.name} ${key}: ERROR ${e.message}`);
    }
    await sleep(700);
  }
}
if (!ok || all.size === 0) {
  console.error("No se pudo descargar nada de Facilito. Se conservan los datos anteriores.");
  process.exit(1);
}

const stations = [];
for (const s of all.values()) {
  if (s.lat == null || s.lng == null) continue;
  const q = P([s.lat, s.lng]);
  const a = nearest(RS, q), b = nearest(RN, q);
  if (Math.min(a.d, b.d) > cfg.maxDistanceMeters) continue;
  const A = s.addr.toUpperCase();
  const hint = /NORTE A SUR/.test(A) ? "S" : /SUR A NORTE/.test(A) ? "N" : undefined;
  stations.push({ ...s, S: a, N: b, ...(hint ? { hint } : {}) });
}
stations.sort((x, y) => x.S.km - y.S.km);

const round = (c) => c.map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)]);
await mkdir(new URL("data/", ROOT), { recursive: true });
await writeFile(new URL("data/stations.json", ROOT), JSON.stringify(stations));
await writeFile(new URL("data/route.json", ROOT), JSON.stringify({
  S: { km: +S.km.toFixed(1), coords: round(simplify(S.coords, 0.00005)) },
  N: { km: +N.km.toFixed(1), coords: round(simplify(N.coords, 0.00005)) }
}));
await writeFile(new URL("data/meta.json", ROOT), JSON.stringify({
  updatedAt: new Date().toISOString(), source: "facilito", stations: stations.length, route: cfg.route.name
}, null, 2));
console.log(`Listo: ${stations.length} grifos cerca de la ruta (${S.km.toFixed(0)} km ida, ${N.km.toFixed(0)} km vuelta).`);
