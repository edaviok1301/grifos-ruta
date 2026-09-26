// v2: descarga los grifos y precios de Facilito (Osinergmin) y los guarda en v2/data/precios.json.
// Uso (Node 20 o superior, sin dependencias):
//   node scripts/v2/precios.mjs                  → todo el Perú (196 provincias, ~10 min)
//   node scripts/v2/precios.mjs 150100,150500    → solo esas provincias (códigos INEI)
// También lee la variable PROVINCIAS (la usa la Action con el texto del formulario).
// Las provincias que no se piden, o que fallan, conservan sus datos anteriores.
import { readFile, writeFile } from "node:fs/promises";

const ROOT = new URL("../../", import.meta.url);
const OUT = new URL("v2/data/precios.json", ROOT);
const PROVS = JSON.parse(await readFile(new URL("v2/provincias.json", ROOT), "utf8"));
const PRODUCTS = { 127: "P", 126: "R", 40: "D" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = "grifos-ruta/2.0 (proyecto personal; GitHub Actions)";

async function get(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "es-PE,es" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      last = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw last;
}

// ---------- Texto de Facilito ----------
// Viene en Windows-1252 y con entidades HTML, a veces dobles (TRIVE&AMP;NTILDE&#X3B;O).
// Tabla explícita para 0x80–0x9F: el TextDecoder("windows-1252") de Node los deja como controles de Latin-1.
const CP1252 = "€\x81‚ƒ„…†‡ˆ‰Š‹Œ\x8dŽ\x8f\x90‘’“”•–—˜™š›œ\x9džŸ";
const fromCode = (c) => (c >= 0x80 && c <= 0x9f ? CP1252[c - 0x80] : String.fromCodePoint(c));
const ENT = { amp: "&", ntilde: "ñ", Ntilde: "Ñ", aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", uuml: "ü", deg: "°", ordm: "º", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s) {
  let prev;
  do {
    prev = s;
    s = s.replace(/&#x([0-9a-f]+);/gi, (m, h) => fromCode(Number.parseInt(h, 16)))
         .replace(/&#(\d+);/g, (m, d) => fromCode(+d))
         .replace(/&([a-z]+);/gi, (m, n) => ENT[n] ?? ENT[n.toLowerCase()] ?? (n.toUpperCase() === n ? (ENT[n[0] + n.slice(1).toLowerCase()] ?? m) : m));
  } while (s !== prev);
  return s.replace(/[\x80-\x9f]/g, (c) => fromCode(c.codePointAt(0))).replace(/\s+/g, " ").trim();
}
const latin1 = new TextDecoder("latin1");

// Vista de mapa de Facilito: no usa reCAPTCHA ni sesión. Exige provincia.
async function facilito(code, prod) {
  const dep = String(+code.slice(0, 2) * 10000), prov = String(+code);
  const url = `https://www.facilito.gob.pe/facilito/actions/MapaAction.do?departamento=${dep}&provincia=${prov}&distrito=9999999&producto=${prod}&method=mostrarMapa&subtitulocabecera=1&tipo=LIQ`;
  const html = latin1.decode(await get(url));
  const m = html.match(/var listaPuntos = eval \('\(' \+ '(.*?)' \+ '\)'\);/s);
  if (!m) throw new Error("Facilito cambió su formato");
  return JSON.parse(m[1].replace(/\\'/g, "'"));
}
const productKey = (name) => (/PREMIUM/i.test(name) ? "P" : /REGULAR/i.test(name) ? "R" : /DIESEL|DB5/i.test(name) ? "D" : null);

// ---------- Qué provincias ----------
const valid = new Map(PROVS.map((p) => [p.c, p]));
// Del formulario de GitHub se lee solo lo que va después del título "Provincias"
const asked = (process.argv[2] || process.env.PROVINCIAS || "").split(/###\s*Provincias/i).pop().match(/\d{6}/g);
const todo = asked ? [...new Set(asked)].filter((c) => valid.has(c)).map((c) => valid.get(c)) : PROVS;
if (!todo.length) { console.error("No hay provincias válidas para actualizar."); process.exit(1); }

let prev = { provinces: {}, stations: [] };
try { prev = JSON.parse(await readFile(OUT, "utf8")); } catch {}

// ---------- Descarga ----------
console.log(`Descargando ${todo.length} provincia(s) de Facilito…`);
const fresh = new Map(), done = new Set();
for (const p of todo) {
  let ok = 0, n = 0;
  for (const prod of Object.keys(PRODUCTS)) {
    try {
      const list = await facilito(p.c, prod);
      ok++;
      for (const s of list) {
        if (s.latitud == null || s.longitud == null) continue;
        const id = String(s.codigoOsinergmin);
        const cur = fresh.get(id) ?? { id, pv: p.c, name: decodeEntities(s.unidad), addr: decodeEntities(s.direccion), lat: s.latitud, lng: s.longitud, prices: {} };
        for (const pr of s.productos || []) {
          const k = productKey(pr.producto);
          if (k && pr.precioVenta) cur.prices[k] = pr.precioVenta;
        }
        if (!fresh.has(id)) n++;
        fresh.set(id, cur);
      }
    } catch (e) {
      console.warn(`  ${p.prov} (${p.c}) producto ${prod}: ERROR ${e.message}`);
    }
    await sleep(700);
  }
  if (ok) done.add(p.c);
  console.log(`  ${p.prov}, ${p.dep} (${p.c}): ${ok ? n + " grifos" : "sin respuesta, se conservan los datos anteriores"}`);
}
if (!done.size) { console.error("No se pudo descargar nada de Facilito. Se conservan los datos anteriores."); process.exit(1); }

// ---------- Guardar ----------
// Se reemplazan solo las provincias que respondieron. Un grifo por línea para que git guarde solo los cambios.
const now = new Date().toISOString();
const provinces = { ...prev.provinces };
for (const c of done) provinces[c] = now;
const stations = prev.stations.filter((s) => !done.has(s.pv) && !fresh.has(s.id))
  .concat([...fresh.values()].filter((s) => done.has(s.pv)))
  .sort((a, b) => a.pv.localeCompare(b.pv) || a.id.localeCompare(b.id, "en", { numeric: true }));
const sorted = Object.fromEntries(Object.entries(provinces).sort());
await writeFile(OUT, `{"updatedAt":${JSON.stringify(now)},\n"provinces":${JSON.stringify(sorted)},\n"stations":[\n${stations.map((s) => JSON.stringify(s)).join(",\n")}\n]}\n`);
console.log(`Listo: ${done.size}/${todo.length} provincias actualizadas, ${stations.length} grifos en total.`);
