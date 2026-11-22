// Pannello "Navigator" per Home Assistant: mappa, ricerca di destinazioni e itinerari
// con servizi gratuiti basati su OpenStreetMap (Valhalla / OSRM per i percorsi, Photon / Nominatim per la ricerca).

import * as L from "./leaflet/leaflet-src.esm.js";

// deve coincidere con VERSION in const.py: se il backend ne riporta un'altra manca un riavvio
const PANEL_VERSION = "1.13.54";

const LEAFLET_CSS = new URL("./leaflet/leaflet.css", import.meta.url).href;
// vista 3D: MapLibre GL JS (BSD-3-Clause), incluso in frontend/maplibre e caricato solo quando serve
const MAPLIBRE_JS = new URL("./maplibre/maplibre-gl.js", import.meta.url).href;
const MAPLIBRE_CSS = new URL("./maplibre/maplibre-gl.css", import.meta.url).href;
// modello 3D del mezzo (carrozzeria + targa in un unico blocco): Three.js (MIT), incluso e caricato solo quando serve
const THREE_JS = new URL("./three/three.module.min.js", import.meta.url).href;
let threeLoading = null;
function loadThree() {
  if (window.__naviTHREE) return Promise.resolve(window.__naviTHREE);
  if (!threeLoading) threeLoading = import(THREE_JS).then((m) => { window.__naviTHREE = m; return m; }).catch((e) => { threeLoading = null; throw e; });
  return threeLoading;
}
const ICON = new URL("./icon.png", import.meta.url).href;
const STORE_KEY = "navigator-panel-state";
// larghezza della riga del percorso in 3D: parte dallo spessore base (w) e cresce con lo zoom, così da vicino copre la carreggiata.
// Sotto zoom 15 resta lo spessore base; sopra 20 arriva a 9 volte (fermo lì). La crescita (esponenziale) segue circa la strada.
const LINE_WIDTH_3D = ["interpolate", ["exponential", 1.75], ["zoom"], 14, ["get", "w"], 20, ["*", ["get", "w"], 11]];

// Fonti delle mappe gratuite e senza chiave. I server di OpenStreetMap bloccano le richieste che arrivano da un
// Home Assistant in rete locale ("Access blocked", 403) e CARTO risponde con "API KEY REQUIRED": come in MeshCore BBS
// si usano le mappe Esri (anch'esse basate in parte su OpenStreetMap).
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const OSM_C = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
const LAYERS = {
  strade: ["Stradale (Esri)", `${ESRI}/World_Street_Map/MapServer/tile/{z}/{y}/{x}`, 19,
    `Mappa &copy; Esri — Esri, HERE, Garmin, ${OSM_C} e GIS User Community`],
  topo: ["Topografica (Esri)", `${ESRI}/World_Topo_Map/MapServer/tile/{z}/{y}/{x}`, 19,
    `Mappa &copy; Esri — Esri, HERE, Garmin, FAO, NOAA, USGS, ${OSM_C}`],
  scura: ["Scura (Esri)", `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, 16,
    "Mappa &copy; Esri — Esri, HERE, Garmin"],
  sat: ["Satellite (Esri)", `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, 19,
    "Immagini &copy; Esri, Maxar, Earthstar Geographics"],
  // le stesse foto del satellite ricolorate color sabbia: prati e boschi diventano deserto, le montagne dune
  deserto: ["Deserto (satellite)", `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, 19,
    "Immagini &copy; Esri, Maxar, Earthstar Geographics (ricolorate)"],
  otm: ["Escursionistica (OpenTopoMap)", "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", 17,
    `${OSM_C}, SRTM | &copy; <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a>`],
};

// vista 3D, fonti gratuite e senza chiave:
// - quote del terreno: dati aperti Mapzen/Tilezen in formato Terrarium, ospitati su Amazon (AWS Open Data)
// - edifici: mappe vettoriali OpenFreeMap (dati OpenStreetMap, schema OpenMapTiles) con l'altezza degli edifici
const DEM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const DEM_ATTR = 'Rilievo <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">Mapzen/Tilezen</a>';
const OFM_URL = "https://tiles.openfreemap.org/planet";
const OFM_ATTR = 'Edifici <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> &copy; OpenMapTiles';
// stile degli edifici 3D
const BLD_STYLES = [["colorati", "Colorati (secondo l'altezza)"], ["finestre", "Con finestre"], ["semplici", "Semplici"]];
const TERRAIN_EX = [["1", "Reale"], ["1.5", "Accentuato"], ["2", "Molto accentuato"]];

// ----------------------------------------------------------------- memoria delle mappe sul telefono
// Ogni riquadro di mappa caricato (sfondo 2D/3D e rilievo) si salva nel database del browser (IndexedDB: funziona anche
// con Home Assistant in http). Quando serve di nuovo si usa quello salvato: senza rete (gallerie, valli, montagna) la
// mappa del percorso resta visibile. Massimo TILE_MAX riquadri: oltre si tolgono i più vecchi.
const TILE_MAX = 12000;
const TILE_AGE = 30 * 86400000; // dopo 30 giorni, con la rete, si riscarica
let tileDbP = null;
function tileDb() {
  if (!tileDbP) {
    tileDbP = new Promise((ok, ko) => {
      try {
        const r = indexedDB.open("navigator-tiles", 1);
        r.onupgradeneeded = () => { const st = r.result.createObjectStore("t"); st.createIndex("at", "at"); };
        r.onsuccess = () => ok(r.result);
        r.onerror = () => ko(r.error);
      } catch (e) { ko(e); }
    }).catch(() => null);
  }
  return tileDbP;
}
const tileKey = (url) => url.replace(/\/\/[abc]\.tile\./, "//tile."); // stesso riquadro da sottodomini diversi
async function tileGet(url) {
  const db = await tileDb();
  if (!db) return null;
  return new Promise((ok) => {
    try {
      const q = db.transaction("t").objectStore("t").get(tileKey(url));
      q.onsuccess = () => ok(q.result || null);
      q.onerror = () => ok(null);
    } catch (e) { ok(null); }
  });
}
let tilePuts = 0;
async function tilePut(url, buf) {
  const db = await tileDb();
  if (!db) return;
  try { db.transaction("t", "readwrite").objectStore("t").put({ b: buf, at: Date.now() }, tileKey(url)); } catch (e) { return; }
  if (++tilePuts % 200 === 0) tilePrune();
}
async function tilePrune() {
  const db = await tileDb();
  if (!db) return;
  try {
    const st = db.transaction("t", "readwrite").objectStore("t");
    const cq = st.count();
    cq.onsuccess = () => {
      let extra = cq.result - TILE_MAX;
      if (extra <= 0) return;
      st.index("at").openCursor().onsuccess = (e) => { const c = e.target.result; if (c && extra-- > 0) { c.delete(); c.continue(); } };
    };
  } catch (e) { /* database occupato: alla prossima */ }
}
async function tileClear() {
  const db = await tileDb();
  if (!db) return;
  try { db.transaction("t", "readwrite").objectStore("t").clear(); } catch (e) { /* niente */ }
}
// riquadro: prima quello salvato (se recente o se manca la rete), altrimenti dalla rete e si salva
async function tileFetch(url, signal) {
  const hit = await tileGet(url);
  const online = window.navigator.onLine !== false;
  if (hit && (!online || Date.now() - hit.at < TILE_AGE)) return hit.b;
  try {
    const r = await fetch(url, { signal, mode: "cors" });
    if (!r.ok) return hit?.b || null;
    const buf = await r.arrayBuffer();
    tilePut(url, buf);
    return buf;
  } catch (e) {
    return hit?.b || null; // rete assente: quello salvato, anche se vecchio
  }
}
// numero di riquadro (Web Mercatore) di un punto
function tileXY(lat, lon, z) {
  const n = 2 ** z;
  return [Math.floor(((lon + 180) / 360) * n), Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n)];
}
const tileUrl = (tpl, z, x, y) => tpl.replace("{s}", "abc"[(x + y) % 3]).replace("{z}", z).replace("{x}", x).replace("{y}", y);

// Leaflet: riquadri dalla memoria del telefono (o dalla rete, salvandoli)
let CachedTiles = null;
function cachedTileLayer(url, opts) {
  if (!CachedTiles) {
    CachedTiles = L.TileLayer.extend({
      createTile(coords, done) {
        const img = document.createElement("img");
        img.alt = "";
        img.setAttribute("role", "presentation");
        tileFetch(this.getTileUrl(coords)).then((buf) => {
          if (!buf) { done(new Error("riquadro non disponibile"), img); return; }
          const u = URL.createObjectURL(new Blob([buf]));
          img.onload = () => { URL.revokeObjectURL(u); done(null, img); };
          img.onerror = () => { URL.revokeObjectURL(u); done(new Error("riquadro non valido"), img); };
          img.src = u;
        });
        return img;
      },
    });
  }
  return new CachedTiles(url, opts);
}

// indirizzo dei riquadri di OpenFreeMap (cambia a ogni aggiornamento dei dati): dalla rete, ricordato sul telefono per
// poterli cercare nella memoria anche partendo senza rete
let ofmTplP = null;
function ofmTemplate() {
  if (!ofmTplP) {
    ofmTplP = (async () => {
      try {
        const tj = await (await fetch(OFM_URL)).json();
        const t = (tj.tiles || [])[0];
        if (t) { try { localStorage.setItem("navigator-ofm-tpl", t); } catch (e) { /* storage pieno */ } return t; }
      } catch (e) { /* senza rete */ }
      ofmTplP = null; // la prossima volta si riprova la rete
      try { return localStorage.getItem("navigator-ofm-tpl"); } catch (e) { return null; }
    })();
  }
  return ofmTplP;
}
function ofmTemplateNow() {
  try { return localStorage.getItem("navigator-ofm-tpl"); } catch (e) { return null; }
}

let maplibreLoading = null;
function loadMaplibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (!maplibreLoading) {
    maplibreLoading = new Promise((ok, ko) => {
      const sc = document.createElement("script");
      sc.src = MAPLIBRE_JS;
      sc.onload = () => {
        if (!window.maplibregl) { ko(new Error("libreria 3D non caricata")); return; }
        // 3D: i riquadri "navc://…" passano dalla memoria delle mappe del telefono
        try {
          window.maplibregl.addProtocol("navc", async (params, abort) => {
            const buf = await tileFetch(params.url.replace(/^navc:\/\//, "https://"), abort?.signal);
            if (!buf) throw new Error("riquadro non disponibile");
            return { data: buf };
          });
        } catch (e) { /* versione senza protocolli: si usa la rete come prima */ }
        ok(window.maplibregl);
      };
      sc.onerror = () => { maplibreLoading = null; ko(new Error("libreria 3D non caricata")); };
      document.head.appendChild(sc);
    });
  }
  return maplibreLoading;
}

const MODES = [
  ["auto", "🚗", "Auto"],
  ["moto", "🏍️", "Moto"],
  ["bici", "🚲", "Bici"],
  ["piedi", "🚶", "A piedi"],
];

const ROUTE_COLORS = ["#1a73e8", "#7b1fa2", "#00897b"];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtTime(sec) {
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h >= 24) return `${Math.floor(h / 24)} g ${h % 24} h`;
  return `${h} h ${String(m).padStart(2, "0")} min`;
}

function fmtKm(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toLocaleString("it-IT", { maximumFractionDigits: km < 10 ? 1 : 0 })} km`;
}

function arrival(sec) {
  const d = new Date(Date.now() + sec * 1000);
  const days = Math.floor((d - new Date().setHours(0, 0, 0, 0)) / 86400000);
  const t = d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
  return days > 0 ? `${t} (+${days} g)` : t;
}

// icona per tipo di manovra Valhalla
// frecce delle manovre disegnate (tratto spesso): si leggono anche grandi, a differenza dei caratteri ↱ ↰
const mvSvg = (d, flip = false) => `<svg class="rbx" viewBox="0 0 40 40"><g ${flip ? 'transform="matrix(-1 0 0 1 40 0)"' : ""} fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round">${d}</g></svg>`;
const MV_D = {
  turn: '<path d="M13 36V20a7 7 0 0 1 7-7h13"/><path d="M26 5.5 33.5 13 26 20.5"/>',
  slight: '<path d="M15 36V24l14-14"/><path d="M18 9h11.5v11.5"/>',
  straight: '<path d="M20 36V6"/><path d="M11.5 14 20 5.5l8.5 8.5"/>',
  uturn: '<path d="M27 36V17a7.5 7.5 0 0 0-15 0v8"/><path d="M5 18.5l7 7 7-7"/>',
  round: '<circle cx="20" cy="25" r="9.5"/><path d="M20 15.5V4M14.5 9.5 20 4l5.5 5.5"/>',
};
const MV_ARROW = { right: mvSvg(MV_D.turn), left: mvSvg(MV_D.turn, true), sright: mvSvg(MV_D.slight), sleft: mvSvg(MV_D.slight, true),
  straight: mvSvg(MV_D.straight), uturn: mvSvg(MV_D.uturn), round: mvSvg(MV_D.round) };

function maneuverIcon(m) {
  if (m.ferry) return "⛴️";
  const t = m.type;
  // rotonda: il numero dell'uscita ben visibile
  if (m.exit && (t === 26 || t === 0 || (m.text || "").toLowerCase().includes("rotonda"))) {
    // anello della rotonda (con la freccia del senso di giro, antiorario) e uscita verso l'alto; dentro il numero dell'uscita
    return `<svg class="rbx" viewBox="0 0 40 40" title="${m.exit}ª uscita"><circle cx="20" cy="25" r="10.5" fill="none" stroke="currentColor" stroke-width="3"/>
      <path d="M20 14.5V3M15.5 7.5 20 3l4.5 4.5M7.5 21.5l2 4.5 4-2.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="20" y="30.5" text-anchor="middle" font-size="14" font-weight="800" font-family="sans-serif" fill="currentColor">${m.exit}</text></svg>`;
  }
  if ([1, 2, 3].includes(t)) return "🟢";
  if ([4, 5, 6].includes(t)) return "🏁";
  if ([9, 10, 11].includes(t)) return MV_ARROW.right;
  if ([14, 15, 16].includes(t)) return MV_ARROW.left;
  if ([12, 13].includes(t)) return MV_ARROW.uturn;
  if ([26, 27].includes(t)) return MV_ARROW.round;
  if ([18, 20, 23].includes(t)) return MV_ARROW.sright;
  if ([19, 21, 24].includes(t)) return MV_ARROW.sleft;
  if ([17, 22, 25, 8, 7].includes(t)) return MV_ARROW.straight;
  const txt = (m.text || "").toLowerCase();
  if (txt.includes("rotonda")) return MV_ARROW.round;
  if (txt.includes("destra")) return MV_ARROW.right;
  if (txt.includes("sinistra")) return MV_ARROW.left;
  return MV_ARROW.straight;
}

// frecce di una corsia (come sui cartelli): una o più indicazioni sovrapposte, la punta in alto è "dritto"
// tutte partono dallo stesso fusto in basso al centro, così più frecce insieme formano un'unica figura
const LANE_PATHS = {
  straight: "M12 21V4M7.5 8.5 12 4l4.5 4.5",
  none: "M12 21V4M7.5 8.5 12 4l4.5 4.5",
  right: "M12 21v-8q0-4 4-4h3.5M16 5.5l3.5 3.5-3.5 3.5",
  left: "M12 21v-8q0-4-4-4H4.5M8 5.5 4.5 9 8 12.5",
  "slight right": "M12 21v-7l6-6M13 7.5h5.5V13",
  "slight left": "M12 21v-7L6 8M11 7.5H5.5V13",
  "sharp right": "M12 21v-9l6 6M18 12.5V18h-5.5",
  "sharp left": "M12 21v-9l-6 6M6 12.5V18h5.5",
  uturn: "M14 21V9a4 4 0 0 0-8 0v7M3 13l3 3 3-3",
};
function laneSvg(dirs) {
  const ds = dirs.filter((d) => LANE_PATHS[d]);
  return `<svg viewBox="0 0 24 24">${(ds.length ? ds : ["none"]).map((d) => `<path d="${LANE_PATHS[d]}"/>`).join("")}</svg>`;
}

// colore più scuro (f < 0) o più chiaro (f > 0) di un colore #rrggbb
function shade(hex, f) {
  const n = parseInt(String(hex).slice(1), 16) || 0;
  const t = f < 0 ? 0 : 255, p = Math.abs(f);
  const ch = (v) => Math.round(v + (t - v) * p);
  return `#${((1 << 24) | (ch(n >> 16) << 16) | (ch((n >> 8) & 255) << 8) | ch(n & 255)).toString(16).slice(1)}`;
}
const okColor = (c) => /^#[0-9a-f]{6}$/i.test(c || "");
// pezzi comuni dei veicoli visti dall'alto (il muso è in alto, la direzione di marcia)
const svgOpen = (vw, vh, w) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw} ${vh}" width="${w}" height="${Math.round(w * vh / vw)}">`;
const wheels = (ys, h = 13, x1 = 1, x2 = 38, w = 5) => ys.map((y) => `<rect x="${x1}" y="${y}" width="${w}" height="${h}" rx="2" fill="#151515"/><rect x="${x2}" y="${y}" width="${w}" height="${h}" rx="2" fill="#151515"/>`).join("");
const lights = (yb, x1 = 7, x2 = 30) => `<rect x="${x1}" y="3.2" width="7" height="2.6" rx="1.2" fill="#ffe28a"/><rect x="${x2}" y="3.2" width="7" height="2.6" rx="1.2" fill="#ffe28a"/>
  <rect x="${x1}" y="${yb}" width="6" height="2.4" rx="1" fill="#e53935"/><rect x="${x2 + 1}" y="${yb}" width="6" height="2.4" rx="1" fill="#e53935"/>`;
const bodyGrad = (id, c) => `<linearGradient id="${id}" x1="0" x2="1"><stop offset="0" stop-color="${shade(c, -0.4)}"/><stop offset=".5" stop-color="${c}"/><stop offset="1" stop-color="${shade(c, -0.4)}"/></linearGradient>`;
const GLASS = `<linearGradient id="nvgl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6d8fbf"/><stop offset="1" stop-color="#1b2c45"/></linearGradient>`;
const mirrors = (y, c) => `<ellipse cx="3" cy="${y}" rx="3" ry="1.8" fill="${shade(c, -0.3)}" stroke="#fff" stroke-width=".8"/><ellipse cx="41" cy="${y}" rx="3" ry="1.8" fill="${shade(c, -0.3)}" stroke="#fff" stroke-width=".8"/>`;
// contorno: bianco fuori e grigio dentro, si vede sia sui colori chiari sia su quelli scuri
const outline = (x, y, w, h, rx) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="none" stroke="#5f6368" stroke-width=".7"/>`;

// SUV (il disegno originale): cambia solo il blu della carrozzeria, il tetto grigio resta
function suvSvg(c = "#173a7a") {
  const id = c.slice(1);
  return `${svgOpen(44, 80, 26)}
  <defs>${bodyGrad(`nvb${id}`, c)}
    <linearGradient id="nvg" x1="0" x2="1"><stop offset="0" stop-color="#7d8792"/><stop offset=".5" stop-color="#aeb6bf"/><stop offset="1" stop-color="#7d8792"/></linearGradient>
    <linearGradient id="nvv" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5c7fb8"/><stop offset="1" stop-color="#1c355f"/></linearGradient>
  </defs>
  ${wheels([12, 54])}
  <rect x="4" y="2" width="36" height="76" rx="8" fill="url(#nvb${id})" stroke="#fff" stroke-width="1.6"/>
  ${outline(4, 2, 36, 76, 8)}
  ${lights(74.4)}
  <path d="M15 6 L15 18 M29 6 L29 18" stroke="${shade(c, 0.25)}" stroke-width="1.2" stroke-linecap="round"/>
  ${mirrors(27, c)}
  <path d="M8 29 Q22 20 36 29 L34 33 Q22 27 10 33 Z" fill="url(#nvv)"/>
  <rect x="10" y="33.5" width="11.3" height="14" rx="2" fill="#123372" stroke="#06142f" stroke-width=".8"/>
  <rect x="22.7" y="33.5" width="11.3" height="14" rx="2" fill="#123372" stroke="#06142f" stroke-width=".8"/>
  <rect x="9" y="48.5" width="26" height="22" rx="2.5" fill="url(#nvg)" stroke="#5a636c" stroke-width=".8"/>
  <path d="M15 51 L15 68 M19.7 51 L19.7 68 M24.3 51 L24.3 68 M29 51 L29 68" stroke="#6c757e" stroke-width="1" stroke-linecap="round"/>
  <rect x="11" y="70.8" width="22" height="2.6" rx="1" fill="#1c355f"/>
</svg>`;
}

// berlina: cofano lungo, tetto, lunotto e bagagliaio
function berlinaSvg(c = "#b71c1c") {
  const id = c.slice(1);
  return `${svgOpen(44, 86, 26)}<defs>${bodyGrad(`nvb${id}`, c)}${GLASS}</defs>
  ${wheels([13, 61])}
  <rect x="4" y="2" width="36" height="82" rx="11" fill="url(#nvb${id})" stroke="#fff" stroke-width="1.6"/>${outline(4, 2, 36, 82, 11)}
  ${lights(80.4)}
  <path d="M14 8 Q22 6 30 8 M12 14 L12 26 M32 14 L32 26" stroke="${shade(c, -0.3)}" stroke-width="1" fill="none" stroke-linecap="round"/>
  ${mirrors(31, c)}
  <path d="M8 34 Q22 23 36 34 L34 38.5 Q22 32 10 38.5 Z" fill="url(#nvgl)"/>
  <rect x="10" y="39" width="24" height="23" rx="3" fill="${shade(c, 0.1)}" stroke="${shade(c, -0.45)}" stroke-width=".8"/>
  <path d="M10 62.5 Q22 66 34 62.5 L35 68 Q22 72 9 68 Z" fill="url(#nvgl)"/>
  <path d="M12 75 Q22 77 32 75" stroke="${shade(c, -0.3)}" stroke-width="1" fill="none"/>
</svg>`;
}

// utilitaria: corta e tonda
function utilitariaSvg(c = "#f9a825") {
  const id = c.slice(1);
  return `${svgOpen(44, 66, 24)}<defs>${bodyGrad(`nvb${id}`, c)}${GLASS}</defs>
  ${wheels([8, 44], 12)}
  <rect x="4" y="2" width="36" height="62" rx="14" fill="url(#nvb${id})" stroke="#fff" stroke-width="1.6"/>${outline(4, 2, 36, 62, 14)}
  ${lights(60.4)}
  ${mirrors(20, c)}
  <path d="M8 22 Q22 12 36 22 L34 26.5 Q22 20 10 26.5 Z" fill="url(#nvgl)"/>
  <rect x="10" y="27" width="24" height="21" rx="4" fill="${shade(c, 0.12)}" stroke="${shade(c, -0.45)}" stroke-width=".8"/>
  <path d="M10 48.5 Q22 52 34 48.5 L34.5 54 Q22 57.5 9.5 54 Z" fill="url(#nvgl)"/>
</svg>`;
}

// station wagon: tetto lungo fino in fondo, con le barre portapacchi
function stationSvg(c = "#546e7a") {
  const id = c.slice(1);
  return `${svgOpen(44, 86, 26)}<defs>${bodyGrad(`nvb${id}`, c)}${GLASS}</defs>
  ${wheels([13, 61])}
  <rect x="4" y="2" width="36" height="82" rx="10" fill="url(#nvb${id})" stroke="#fff" stroke-width="1.6"/>${outline(4, 2, 36, 82, 10)}
  ${lights(80.4)}
  <path d="M12 12 L12 24 M32 12 L32 24" stroke="${shade(c, -0.3)}" stroke-width="1" stroke-linecap="round"/>
  ${mirrors(29, c)}
  <path d="M8 32 Q22 21 36 32 L34 36.5 Q22 30 10 36.5 Z" fill="url(#nvgl)"/>
  <rect x="10" y="37" width="24" height="37" rx="3" fill="${shade(c, 0.1)}" stroke="${shade(c, -0.45)}" stroke-width=".8"/>
  <path d="M12.5 39 L12.5 72 M31.5 39 L31.5 72" stroke="#cfd8dc" stroke-width="1.6" stroke-linecap="round"/>
  <path d="M10 74.5 Q22 77 34 74.5 L34.5 79 Q22 81 9.5 79 Z" fill="url(#nvgl)"/>
</svg>`;
}

// sportiva: muso affusolato, abitacolo basso, due strisce bianche e alettone
function sportivaSvg(c = "#d32f2f") {
  const id = c.slice(1);
  return `${svgOpen(44, 84, 26)}<defs>${bodyGrad(`nvb${id}`, c)}${GLASS}</defs>
  ${wheels([12, 58], 15, 0.5, 37.5, 6)}
  <path d="M11 3 Q22 0 33 3 L40 22 L40 76 Q40 82 34 82 L10 82 Q4 82 4 76 L4 22 Z" fill="url(#nvb${id})" stroke="#fff" stroke-width="1.6"/>
  <path d="M11 3 Q22 0 33 3 L40 22 L40 76 Q40 82 34 82 L10 82 Q4 82 4 76 L4 22 Z" fill="none" stroke="#5f6368" stroke-width=".7"/>
  <rect x="11" y="4" width="6" height="2.2" rx="1" fill="#ffe28a"/><rect x="27" y="4" width="6" height="2.2" rx="1" fill="#ffe28a"/>
  <rect x="17.8" y="1.5" width="2.6" height="79" fill="#fff" opacity=".85"/><rect x="23.6" y="1.5" width="2.6" height="79" fill="#fff" opacity=".85"/>
  ${mirrors(34, c)}
  <path d="M9 37 Q22 27 35 37 L33.5 42 Q22 36 10.5 42 Z" fill="url(#nvgl)"/>
  <rect x="11" y="42.5" width="22" height="13" rx="3" fill="${shade(c, -0.15)}" stroke="${shade(c, -0.5)}" stroke-width=".8"/>
  <path d="M12 59 H32 M12 63 H32 M12 67 H32" stroke="${shade(c, -0.5)}" stroke-width="1.2" stroke-linecap="round"/>
  <rect x="5" y="77.5" width="34" height="3.4" rx="1.2" fill="#202020"/>
  <rect x="8" y="80.8" width="6" height="1.6" rx=".8" fill="#e53935"/><rect x="30" y="80.8" width="6" height="1.6" rx=".8" fill="#e53935"/>
</svg>`;
}

// fuoristrada: squadrato, ruota di scorta dietro
function jeepSvg(c = "#5f6b52") {
  const id = c.slice(1);
  return `${svgOpen(44, 84, 26)}<defs>${bodyGrad(`nvb${id}`, c)}${GLASS}</defs>
  ${wheels([12, 54])}
  <rect x="15" y="76" width="14" height="6.5" rx="2.5" fill="#151515" stroke="#fff" stroke-width=".8"/>
  <rect x="4" y="2" width="36" height="76" rx="5" fill="url(#nvb${id})" stroke="#fff" stroke-width="1.6"/>${outline(4, 2, 36, 76, 5)}
  ${lights(74.4)}
  <path d="M13 8 H31 M13 12 H31 M13 16 H31" stroke="${shade(c, -0.35)}" stroke-width="1.1" stroke-linecap="round"/>
  ${mirrors(26, c)}
  <path d="M8 27 L36 27 L34.5 32 L9.5 32 Z" fill="url(#nvgl)"/>
  <rect x="10" y="33" width="24" height="34" rx="2" fill="${shade(c, -0.15)}" stroke="${shade(c, -0.5)}" stroke-width=".8"/>
  <path d="M12 38 H32 M12 62 H32" stroke="${shade(c, -0.5)}" stroke-width="1.4" stroke-linecap="round"/>
  <path d="M10 68 L34 68 L33 72.5 L11 72.5 Z" fill="url(#nvgl)"/>
</svg>`;
}

// pick-up: cabina e cassone aperto
function pickupSvg(c = "#37474f") {
  const id = c.slice(1);
  return `${svgOpen(44, 88, 26)}<defs>${bodyGrad(`nvb${id}`, c)}${GLASS}</defs>
  ${wheels([13, 63])}
  <rect x="4" y="2" width="36" height="84" rx="7" fill="url(#nvb${id})" stroke="#fff" stroke-width="1.6"/>${outline(4, 2, 36, 84, 7)}
  ${lights(82.4)}
  <path d="M13 9 H31 M12 14 L12 24 M32 14 L32 24" stroke="${shade(c, -0.35)}" stroke-width="1" stroke-linecap="round"/>
  ${mirrors(29, c)}
  <path d="M8 31 Q22 23 36 31 L34.5 35.5 Q22 30 9.5 35.5 Z" fill="url(#nvgl)"/>
  <rect x="10" y="36" width="24" height="12" rx="2.5" fill="${shade(c, 0.1)}" stroke="${shade(c, -0.45)}" stroke-width=".8"/>
  <rect x="11" y="48.5" width="22" height="2.4" rx="1" fill="url(#nvgl)"/>
  <rect x="8" y="53" width="28" height="29" rx="1.5" fill="${shade(c, -0.45)}" stroke="${shade(c, 0.2)}" stroke-width="1"/>
  <path d="M14 55 V80 M20 55 V80 M26 55 V80 M32 55 V80" stroke="${shade(c, -0.25)}" stroke-width="1"/>
</svg>`;
}

// furgone: cabina col parabrezza e nervature sul tetto
function furgoneSvg(c = "#f5f5f5") {
  return `${svgOpen(44, 84, 25)}<defs>${GLASS}</defs>
  ${wheels([12, 60], 12)}
  <rect x="4" y="2" width="36" height="80" rx="7" fill="${c}" stroke="#fff" stroke-width="1.6"/>${outline(4, 2, 36, 80, 7)}
  ${lights(78.6)}
  <path d="M8 9 Q22 4 36 9 L34.5 18 Q22 14 9.5 18 Z" fill="url(#nvgl)"/>
  <rect x="9" y="22" width="26" height="56" rx="2.5" fill="${shade(c, -0.06)}" stroke="${shade(c, -0.22)}" stroke-width=".8"/>
  <path d="M9 30 H35 M9 38 H35 M9 46 H35 M9 54 H35 M9 62 H35 M9 70 H35" stroke="${shade(c, -0.17)}" stroke-width="1.1"/>
</svg>`;
}

// camper: lungo, cabina col parabrezza, oblò e pannello solare sul tetto, riga rossa sui fianchi
function camperSvg(c = "#f3f2ec") {
  return `${svgOpen(44, 92, 25)}<defs>${GLASS}</defs>
  ${wheels([12, 66], 12)}
  <rect x="4" y="2" width="36" height="88" rx="6" fill="${c}" stroke="#fff" stroke-width="1.6"/>${outline(4, 2, 36, 88, 6)}
  ${lights(86.6)}
  <path d="M8 8 Q22 4 36 8 L34.5 15 Q22 12 9.5 15 Z" fill="url(#nvgl)"/>
  <rect x="4.2" y="20" width="2" height="62" fill="#c62828"/><rect x="37.8" y="20" width="2" height="62" fill="#c62828"/>
  <rect x="8.5" y="19" width="27" height="66" rx="3" fill="${shade(c, -0.04)}" stroke="${shade(c, -0.2)}" stroke-width=".8"/>
  <rect x="14" y="24" width="16" height="9" rx="2" fill="#a9bcd2" stroke="#7d8fa6" stroke-width=".8"/>
  <rect x="11" y="39" width="22" height="14" rx="1.2" fill="#24365c" stroke="#101a30" stroke-width=".8"/>
  <path d="M16.5 39 V53 M22 39 V53 M27.5 39 V53 M11 46 H33" stroke="#4b6596" stroke-width=".7"/>
  <rect x="16" y="60" width="12" height="9" rx="2" fill="#a9bcd2" stroke="#7d8fa6" stroke-width=".8"/>
  <rect x="13" y="74" width="18" height="6" rx="1.5" fill="${shade(c, -0.12)}"/>
</svg>`;
}

// moto: ruote, manubrio con specchietti, serbatoio e motociclista col casco
function motoSvg(c = "#173a7a") {
  const d = shade(c, -0.25), h = shade(c, -0.45);
  return `${svgOpen(30, 80, 18)}
  <rect x="12" y="1.5" width="6" height="17" rx="3" fill="#151515"/>
  <rect x="11.5" y="60" width="7" height="18.5" rx="3.5" fill="#151515"/>
  <path d="M9 14 Q15 8 21 14 L20 24 L10 24 Z" fill="${c}" stroke="#fff" stroke-width="1.2"/>
  <rect x="12.5" y="9.5" width="5" height="2.4" rx="1.2" fill="#ffe28a"/>
  <rect x="2" y="21" width="26" height="2.6" rx="1.3" fill="#222" stroke="#fff" stroke-width=".7"/>
  <ellipse cx="3.5" cy="18.5" rx="2.6" ry="1.6" fill="${h}" stroke="#fff" stroke-width=".7"/>
  <ellipse cx="26.5" cy="18.5" rx="2.6" ry="1.6" fill="${h}" stroke="#fff" stroke-width=".7"/>
  <ellipse cx="15" cy="31" rx="7" ry="8" fill="${c}" stroke="#fff" stroke-width="1.2"/>
  <rect x="10.5" y="45" width="9" height="14" rx="3.5" fill="#9aa3ad" stroke="#5a636c" stroke-width=".8"/>
  <rect x="12" y="58.6" width="6" height="2" rx="1" fill="#e53935"/>
  <path d="M7 41 L4.5 23.5 M23 41 L25.5 23.5" stroke="${d}" stroke-width="3.2" stroke-linecap="round"/>
  <ellipse cx="15" cy="42" rx="10.5" ry="6" fill="${d}" stroke="#fff" stroke-width="1.2"/>
  <circle cx="15" cy="38" r="6.2" fill="${h}" stroke="#fff" stroke-width="1.2"/>
  <path d="M10.3 35.5 Q15 30.6 19.7 35.5 Q15 33.4 10.3 35.5 Z" fill="#5c7fb8"/>
</svg>`;
}

// scooter: ruote piccole, scudo davanti, pedana e sella
function scooterSvg(c = "#26a69a") {
  const d = shade(c, -0.3);
  return `${svgOpen(30, 74, 17)}
  <rect x="12.2" y="1.5" width="5.6" height="12" rx="2.8" fill="#151515"/>
  <rect x="12" y="60" width="6" height="12.5" rx="3" fill="#151515"/>
  <rect x="3" y="12" width="24" height="2.4" rx="1.2" fill="#222" stroke="#fff" stroke-width=".7"/>
  <ellipse cx="4" cy="10" rx="2.4" ry="1.5" fill="${d}" stroke="#fff" stroke-width=".7"/><ellipse cx="26" cy="10" rx="2.4" ry="1.5" fill="${d}" stroke="#fff" stroke-width=".7"/>
  <path d="M6 18 Q15 10 24 18 L22 26 Q15 23 8 26 Z" fill="${c}" stroke="#fff" stroke-width="1.2"/>
  <rect x="12.5" y="14.5" width="5" height="2.2" rx="1.1" fill="#ffe28a"/>
  <rect x="9.5" y="26" width="11" height="14" rx="2" fill="#3a3a3a" stroke="#fff" stroke-width=".8"/>
  <path d="M8 40 Q15 37 22 40 L22.5 60 Q15 64 7.5 60 Z" fill="${c}" stroke="#fff" stroke-width="1.2"/>
  <rect x="11" y="45" width="8" height="12" rx="3" fill="#2b2b2b"/>
  <rect x="12" y="61" width="6" height="1.8" rx=".9" fill="#e53935"/>
  <path d="M7.5 41 L6 15 M22.5 41 L24 15" stroke="${shade(c, -0.45)}" stroke-width="3" stroke-linecap="round"/>
  <ellipse cx="15" cy="42" rx="9.5" ry="5.6" fill="${shade(c, -0.45)}" stroke="#fff" stroke-width="1.2"/>
  <circle cx="15" cy="38.5" r="5.8" fill="#eceff1" stroke="#fff" stroke-width="1.2"/>
  <path d="M10.6 36 Q15 31.5 19.4 36 Q15 34 10.6 36 Z" fill="#37474f"/>
</svg>`;
}

// bicicletta: ruote sottili, telaio, manubrio e ciclista col caschetto
function biciSvg(c = "#173a7a") {
  const h = shade(c, -0.4);
  return `${svgOpen(30, 80, 18)}
  <rect x="13.4" y="1" width="3.2" height="22" rx="1.6" fill="#151515"/>
  <rect x="13.4" y="57" width="3.2" height="22" rx="1.6" fill="#151515"/>
  <path d="M15 21 L15 60" stroke="#8a939c" stroke-width="2.2" stroke-linecap="round"/>
  <rect x="4" y="18.5" width="22" height="2.2" rx="1.1" fill="#333" stroke="#fff" stroke-width=".6"/>
  <ellipse cx="15" cy="52" rx="2.8" ry="4.2" fill="#222"/>
  <path d="M7.5 40 L5.5 20.5 M22.5 40 L24.5 20.5" stroke="${c}" stroke-width="3" stroke-linecap="round"/>
  <ellipse cx="15" cy="41" rx="10" ry="5.6" fill="${c}" stroke="#fff" stroke-width="1.2"/>
  <ellipse cx="15" cy="37" rx="5" ry="6.6" fill="${h}" stroke="#fff" stroke-width="1.2"/>
  <path d="M13 32.5 L13 41.5 M17 32.5 L17 41.5" stroke="#9aa3ad" stroke-width="1" stroke-linecap="round"/>
</svg>`;
}

// disegni scelti nel garage: [nome, disegno(colore), colore predefinito, mezzo]
const VEH_ICONS = {
  suv: ["SUV (blu e grigio)", suvSvg, "#173a7a", "auto"],
  berlina: ["Berlina", berlinaSvg, "#b71c1c", "auto"],
  utilitaria: ["Utilitaria", utilitariaSvg, "#f9a825", "auto"],
  station: ["Station wagon", stationSvg, "#546e7a", "auto"],
  sportiva: ["Sportiva", sportivaSvg, "#d32f2f", "auto"],
  jeep: ["Fuoristrada", jeepSvg, "#5f6b52", "auto"],
  pickup: ["Pick-up", pickupSvg, "#37474f", "auto"],
  furgone: ["Furgone", furgoneSvg, "#f5f5f5", "auto"],
  camper: ["Camper", camperSvg, "#f3f2ec", "auto"],
  moto: ["Moto", motoSvg, "#173a7a", "moto"],
  scooter: ["Scooter", scooterSvg, "#26a69a", "moto"],
  bici: ["Bici", biciSvg, "#173a7a", "bici"],
};
// disegno predefinito per tipo di veicolo
const VEH_TYPE_ICON = { auto: "suv", furgone: "furgone", camper: "camper", altro: "jeep", moto: "moto", scooter: "scooter", bici: "bici" };
// mezzo del percorso per tipo di veicolo
const VEH_TYPE_MODE = { auto: "auto", furgone: "auto", camper: "auto", altro: "auto", moto: "moto", scooter: "moto", bici: "bici" };
// disegni adatti al tipo (auto e affini: tutte le auto; moto e scooter: moto e scooter; bici: bici)
const vehIconsFor = (type) => Object.keys(VEH_ICONS).filter((k) => VEH_ICONS[k][3] === (VEH_TYPE_MODE[type] || "auto"));
// id dei gradienti unici per ogni disegno: se lo stesso id c'è anche in un disegno nascosto (es. l'anteprima nelle
// impostazioni chiuse) il browser non colora quello visibile
let svgSeq = 0;
function uniqSvg(svg) {
  const n = ++svgSeq;
  return svg.replace(/id="([\w-]+)"/g, `id="$1_${n}"`).replace(/url\(#([\w-]+)\)/g, `url(#$1_${n})`);
}
// disegno di un veicolo del garage col suo colore
function vehicleSvg(v) {
  const k = vehIconsFor(v.type).includes(v.icon) ? v.icon : VEH_TYPE_ICON[v.type] || "suv";
  const [, fn, def] = VEH_ICONS[k];
  return uniqSvg(fn(okColor(v.color) ? v.color.toLowerCase() : def));
}
const CAR_SVG = suvSvg();

// ----------------------------------------------------------------- mezzo in 3D
// Modellino "a blocchi" (volumi come gli edifici della vista 3D): misure vere in metri, x verso destra e y verso il muso;
// ogni pezzo è un poligono con quota di base e di cima e un colore. Il pannello lo ingrandisce e lo gira nella direzione di marcia.
function veh3dParts(kind, color) {
  const c = color, dk = shade(c, -0.35), lt = shade(c, 0.18);
  const GLASS = "#2a3a55", TYRE = "#161616", LIGHT = "#ffe28a", TAIL = "#e53935", GREY = "#aeb6bf";
  const P = [];
  // scatola con gli angoli smussati (ch = smusso in metri)
  const box = (x1, y1, x2, y2, b, h, col, ch = 0) => P.push({ pts: ch
    ? [[x1 + ch, y1], [x2 - ch, y1], [x2, y1 + ch], [x2, y2 - ch], [x2 - ch, y2], [x1 + ch, y2], [x1, y2 - ch], [x1, y1 + ch]]
    : [[x1, y1], [x2, y1], [x2, y2], [x1, y2]], b, h, c: col });
  const cyl = (cx, cy, r, b, h, col, n = 10) => P.push({ pts: Array.from({ length: n }, (_, k) =>
    [cx + r * Math.cos((k / n) * 2 * Math.PI), cy + r * Math.sin((k / n) * 2 * Math.PI)]), b, h, c: col });
  const wheels = (w, yf, yr, r = 0.33, t = 0.24) => {
    for (const y of [yf, yr]) for (const s of [-1, 1]) box(s * w - t / 2, y - r, s * w + t / 2, y + r, 0, r * 2, TYRE);
  };
  const lights = (w, yF, yR, hb = 0.55) => {
    box(-w + 0.12, yF - 0.06, -w + 0.42, yF + 0.02, hb, hb + 0.16, LIGHT); box(w - 0.42, yF - 0.06, w - 0.12, yF + 0.02, hb, hb + 0.16, LIGHT);
    box(-w + 0.12, yR - 0.02, -w + 0.38, yR + 0.06, hb + 0.1, hb + 0.26, TAIL); box(w - 0.38, yR - 0.02, w - 0.12, yR + 0.06, hb + 0.1, hb + 0.26, TAIL);
  };
  // auto: scafo, abitacolo di vetro, tetto del colore della carrozzeria (cy1..cy2 = abitacolo), cofano e baule
  const car = ({ L = 4.4, W = 0.9, hb = 0.95, ht = 1.45, cy1 = -1.3, cy2 = 0.7, roof = c, low = 0.28 }) => {
    wheels(W - 0.08, L / 2 - 0.95, -L / 2 + 0.9);
    box(-W, -L / 2, W, L / 2, low, hb, c, 0.32);
    box(-W + 0.12, cy1, W - 0.12, cy2, hb, ht - 0.06, GLASS, 0.12);
    box(-W + 0.16, cy1 + 0.12, W - 0.16, cy2 - 0.1, ht - 0.06, ht, roof, 0.1);
    lights(W, L / 2, -L / 2, low + 0.3);
  };
  const rider = (y, col) => {
    box(-0.26, y - 0.2, 0.26, y + 0.18, 0.75, 1.45, col, 0.08); // busto
    cyl(0, y + 0.02, 0.16, 1.45, 1.75, shade(col, -0.45), 8); // casco
    box(-0.4, y + 0.05, -0.28, y + 0.55, 1.05, 1.2, col); box(0.28, y + 0.05, 0.4, y + 0.55, 1.05, 1.2, col); // braccia
  };
  switch (kind) {
    case "berlina": car({ L: 4.7, cy1: -1.1, cy2: 0.65, ht: 1.42 }); break;
    case "utilitaria": car({ L: 3.6, W: 0.82, cy1: -1.25, cy2: 0.55, ht: 1.5 }); break;
    case "station": car({ L: 4.7, cy1: -2.0, cy2: 0.6, ht: 1.48 }); box(-0.62, -1.85, -0.56, 0.45, 1.48, 1.56, "#cfd8dc"); box(0.56, -1.85, 0.62, 0.45, 1.48, 1.56, "#cfd8dc"); break;
    case "sportiva":
      car({ L: 4.5, W: 0.95, hb: 0.75, ht: 1.15, cy1: -0.9, cy2: 0.55, low: 0.18 });
      box(-0.25, -2.25, -0.12, 2.25, 0.75, 0.77, "#ffffff"); box(0.12, -2.25, 0.25, 2.25, 0.75, 0.77, "#ffffff");
      box(-0.9, -2.3, 0.9, -2.0, 1.05, 1.12, "#202020"); break; // alettone
    case "jeep":
      car({ L: 4.3, W: 0.92, hb: 1.1, ht: 1.85, cy1: -1.6, cy2: 0.65, low: 0.42 });
      cyl(0, -2.3, 0.36, 0.7, 1.2, TYRE, 10); break; // ruota di scorta
    case "pickup":
      car({ L: 5.2, W: 0.95, hb: 1.05, ht: 1.8, cy1: -0.35, cy2: 1.0, low: 0.42 });
      box(-0.85, -2.5, 0.85, -0.55, 1.05, 1.07, dk); // fondo del cassone (più scuro)
      for (const s of [-1, 1]) box(s * 0.95 - 0.06, -2.55, s * 0.95 + 0.06, -0.5, 1.05, 1.4, c);
      box(-0.95, -2.6, 0.95, -2.5, 1.05, 1.4, c); break;
    case "furgone":
      wheels(0.9, 1.6, -1.7, 0.34);
      box(-0.98, -2.5, 0.98, 2.5, 0.3, 2.35, c, 0.25);
      box(-0.9, 1.75, 0.9, 2.42, 1.15, 1.95, GLASS, 0.15); // parabrezza
      box(-0.85, -2.3, 0.85, 1.6, 2.35, 2.42, shade(c, -0.08));
      lights(0.98, 2.5, -2.5, 0.6); break;
    case "camper":
      wheels(0.95, 2.1, -1.8, 0.36);
      box(-1.05, -3.3, 1.05, 3.3, 0.35, 2.9, c, 0.3);
      box(-1.06, -3.0, 1.06, 2.2, 1.05, 1.25, "#c62828"); // riga sui fianchi
      box(-0.95, 2.6, 0.95, 3.25, 1.2, 2.0, GLASS, 0.15);
      box(-0.5, -0.6, 0.5, 0.6, 2.9, 3.0, "#24365c"); // pannello solare
      box(-0.35, 1.4, 0.35, 2.0, 2.9, 3.05, "#a9bcd2"); // oblò
      lights(1.05, 3.3, -3.3, 0.6); break;
    case "moto": case "scooter": {
      const sc = kind === "scooter";
      box(-0.1, 0.55, 0.1, sc ? 1.05 : 1.15, 0, sc ? 0.48 : 0.62, TYRE); box(-0.11, sc ? -1.0 : -1.15, 0.11, -0.45, 0, sc ? 0.48 : 0.64, TYRE);
      box(-0.24, -0.9, 0.24, 0.95, 0.35, sc ? 0.65 : 0.8, c, 0.12); // telaio, serbatoio o pedana
      if (sc) box(-0.3, 0.7, 0.3, 0.95, 0.3, 1.15, c, 0.08); // scudo
      box(-0.5, 0.75, 0.5, 0.82, 1.05, 1.1, "#222"); // manubrio
      box(-0.18, -0.6, 0.18, -0.1, 0.8, 0.9, "#2b2b2b"); // sella
      box(-0.08, 1.0, 0.08, 1.06, 0.7, 0.85, LIGHT);
      rider(-0.25, dk); break;
    }
    case "bici":
      box(-0.03, 0.4, 0.03, 1.05, 0, 0.66, TYRE); box(-0.03, -1.05, 0.03, -0.4, 0, 0.66, TYRE);
      box(-0.04, -0.75, 0.04, 0.75, 0.55, 0.62, "#8a939c");
      box(-0.32, 0.68, 0.32, 0.74, 0.98, 1.02, "#333");
      rider(-0.2, c); break;
    case "piedi":
      cyl(-0.12, 0.12, 0.08, 0, 0.85, "#2a2a2a", 6); cyl(0.12, -0.12, 0.08, 0, 0.85, "#2a2a2a", 6); // gambe
      box(-0.24, -0.13, 0.24, 0.13, 0.85, 1.45, c, 0.06); // busto
      box(-0.34, -0.08, -0.25, 0.1, 0.95, 1.4, c); box(0.25, -0.08, 0.34, 0.1, 0.95, 1.4, c);
      cyl(0, 0, 0.13, 1.45, 1.72, "#4e342e", 8); break;
    default: // SUV blu e grigio (il disegno originale)
      car({ L: 4.5, W: 0.92, hb: 1.05, ht: 1.78, cy1: -1.75, cy2: 0.55, roof: GREY, low: 0.38 });
      box(-0.55, -1.6, -0.48, 0.4, 1.78, 1.85, lt); box(0.48, -1.6, 0.55, 0.4, 1.78, 1.85, lt);
  }
  return P;
}
// il modellino per il veicolo: quello del garage col suo colore, altrimenti quello del mezzo (Base)
function veh3dFor(v, mode) {
  if (v?.type) {
    const k = vehIconsFor(v.type).includes(v.icon) ? v.icon : VEH_TYPE_ICON[v.type] || "suv";
    return [k, okColor(v.color) ? v.color.toLowerCase() : VEH_ICONS[k][2]];
  }
  return { moto: ["moto", "#173a7a"], bici: ["bici", "#173a7a"], piedi: ["piedi", "#173a7a"] }[mode] || ["suv", "#173a7a"];
}


// persona a piedi vista dall'alto: piedi nel passo, braccia, spalle, testa col cappellino rivolto in avanti
const PIEDI_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="30" height="30">
  <ellipse cx="14.5" cy="8.5" rx="2.6" ry="4.2" fill="#2a2a2a" stroke="#fff" stroke-width=".7"/>
  <ellipse cx="25.5" cy="31.5" rx="2.6" ry="4.2" fill="#2a2a2a" stroke="#fff" stroke-width=".7"/>
  <ellipse cx="5.5" cy="23" rx="2.8" ry="6" fill="#173a7a" stroke="#fff" stroke-width=".8" transform="rotate(12 5.5 23)"/>
  <ellipse cx="34.5" cy="18" rx="2.8" ry="6" fill="#173a7a" stroke="#fff" stroke-width=".8" transform="rotate(12 34.5 18)"/>
  <ellipse cx="20" cy="21" rx="13.5" ry="7" fill="#173a7a" stroke="#fff" stroke-width="1.3"/>
  <circle cx="20" cy="20.5" r="6" fill="#4e342e" stroke="#fff" stroke-width="1.1"/>
  <path d="M15.6 16.8 Q20 11 24.4 16.8 Q20 15.2 15.6 16.8 Z" fill="#0a2150" stroke="#fff" stroke-width=".6"/>
</svg>`;

const VEHICLE_SVG = { auto: CAR_SVG, moto: motoSvg(), bici: biciSvg(), piedi: PIEDI_SVG };

// impostazioni salvate su questo dispositivo
const SETTINGS_KEY = "navigator-panel-settings";
const DEFAULT_SETTINGS = { voice: false, lang: "it", voiceSel: "f", out: "auto", autoZoom: true, beep: false,
  fuelBrands: [], fuelKind: "", camAlert: true, view3d: false, b3d: true, clouds3d: true, veh3d: true, terrainEx: "1.5", pitch3d: 60, tunnelFx: true, zoom3dOff: 0,
  voiceStyle: "normale", voiceRate: 1, voicePitch: 1, bldStyle: "colorati",
  poiKinds: ["farmacia", "ospedale", "supermercato"], arrEntities: [], arrHomeOnly: true, nightMode: "auto", wxAlert: true, muteGuide: false, trafficSensor: "", autoDest: true, wx3d: true, arrDist: 500, tileAhead: 100, clickSnd: true, names3d: true };
// marche dei distributori (come nell'anagrafica del MIMIT)
const FUEL_BRANDS = ["Agip Eni", "Api-Ip", "Q8", "Esso", "Tamoil", "Shell", "Retitalia", "Beyfin", "Costantin", "Europam", "Pompe bianche"];
const BRAND_COLORS = { "agip eni": "#f7c600", "eni": "#f7c600", "api-ip": "#0057a8", "ip": "#0057a8", "q8": "#0a3a7a", "esso": "#d71920",
  "tamoil": "#f28c00", "shell": "#fbce07", "retitalia": "#00843d", "beyfin": "#1d71b8", "pompe bianche": "#9e9e9e" };
const brandColor = (b) => BRAND_COLORS[(b || "").toLowerCase()] || "#607d8b";
// tipi di carburante (come li raggruppa il backend dai nomi commerciali comunicati al MIMIT)
const FUEL_KINDS = [["benzina", "Benzina"], ["gasolio", "Gasolio"], ["benzina_plus", "Benzina speciale"], ["benzina100", "100 ottani"],
  ["gasolio_plus", "Gasolio speciale"], ["gpl", "GPL"], ["metano", "Metano"], ["gnl", "GNL"]];
// "Benzina speciale" comprende anche le 100 ottani
const fuelMatch = (f, kind) => f.k === kind || (kind === "benzina_plus" && f.k === "benzina100");
const fuelPrice = (f) => f.s ?? f.v ?? null;
const fmtPrice = (p) => p.toLocaleString("it-IT", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
// video nero di 2 secondi, muto e in loop: dove il browser non ha il blocco dello standby (es. app Companion)
// un video in riproduzione tiene acceso lo schermo
const NOSLEEP_MP4 = "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMrbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAB9AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAlV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAB9AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAfQAAAAAAABAAAAAAHNbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAgABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABeG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAThzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2MC4zMS4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAK/+EAFmdCwArZHsBEAAADAAQAAAMACDxImSABAAVoy4PLIAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAApAAAAKQAAAABhzdHRzAAAAAAAAAAEAAAACAABAAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAACAAAAAQAAABxzdHN6AAAAAAAAAAAAAAACAAAChgAAAAoAAAAUc3RjbwAAAAAAAAABAAADWwAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWlsc3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNjAuMTYuMTAwAAAACGZyZWUAAAKYbWRhdAAAAnAGBf//bNxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjQgcjMxMDggMzFlMTlmOSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjMgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDE6MHgxMTEgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTI1MCBrZXlpbnRfbWluPTEgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAOZYiEBb///w9FAAFPf4AAAAAGQZo4CvqA";
// icone dello schermo intero (i simboli ⛶ e 🗗 mancano nei caratteri di molti telefoni)
const FS_ON = `<svg class="fsico" viewBox="0 0 24 24"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>`;
const FS_OFF = `<svg class="fsico" viewBox="0 0 24 24"><path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"/></svg>`;
// stili della voce del browser: velocità e tono (1 = come la voce originale)
const VOICE_STYLES = { normale: ["Normale", 1, 1], calma: ["Calma", 0.9, 0.95], morbida: ["Morbida (calda, lenta e più bassa)", 0.82, 0.8],
  energica: ["Energica", 1.15, 1.1], pers: ["Personalizzata", null, null] };
// punti di interesse sulla mappa (OpenStreetMap): chiave -> nome, icona, colore
const POI_KINDS = {
  farmacia: ["Farmacie", "💊", "#2e7d32"], ospedale: ["Ospedali e cliniche", "🏥", "#c62828"],
  supermercato: ["Supermercati", "🛒", "#6a1b9a"], ristorante: ["Ristoranti", "🍽️", "#ef6c00"],
  bar: ["Bar e caffè", "☕", "#8d6e63"], banca: ["Bancomat e banche", "🏧", "#1565c0"],
  hotel: ["Hotel e B&B", "🛏️", "#00838f"], ricarica: ["Colonnine di ricarica", "🔌", "#00a152"],
  carburante: ["Distributori", "⛽", "#f9a825"], polizia: ["Polizia e carabinieri", "🚓", "#283593"],
  posta: ["Uffici postali", "📮", "#d84315"], officina: ["Officine e gommisti", "🔧", "#455a64"],
  scuola: ["Scuole", "🏫", "#5d4037"], chiesa: ["Chiese", "⛪", "#757575"],
  tabacchi: ["Tabaccherie", "🚬", "#37474f"], autovelox: ["Autovelox fissi", "📷", "#e53935"],
};
const POI_TILE = 0.02; // come nel backend
// punti di interesse dalle mappe vettoriali OpenFreeMap (livello "poi", schema OpenMapTiles): la sottoclasse è il valore OSM
const OFM_POI = { pharmacy: "farmacia", hospital: "ospedale", clinic: "ospedale", supermarket: "supermercato",
  restaurant: "ristorante", fast_food: "ristorante", cafe: "bar", bar: "bar", pub: "bar", bank: "banca", atm: "banca",
  hotel: "hotel", motel: "hotel", guest_house: "hotel", hostel: "hotel", charging_station: "ricarica", fuel: "carburante",
  police: "polizia", post_office: "posta", car_repair: "officina", tyres: "officina", school: "scuola", place_of_worship: "chiesa",
  tobacco: "tabacchi" };
// pulsanti all'arrivo: domini ammessi e servizio da chiamare
const ARR_DOMAINS = ["cover", "lock", "switch", "light", "button", "input_button", "script", "scene", "input_boolean", "fan"];
// icone disegnate dei tasti all'arrivo (i caratteri come ⏻ su molti telefoni mancano e diventano un riquadro)
const ARR_SVG = {
  lampadina: ["Lampadina", '<path d="M9 17.5h6M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2v.5h5V16c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/><path d="M10 20.5h4"/>'],
  cancello: ["Cancello", '<path d="M3 21V4M21 21V4M3 8h18M3 18h18M7.5 8v10M12 8v10M16.5 8v10"/>'],
  porta: ["Porta", '<path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M3.5 21h17"/><path d="M14.5 12.5h.01" stroke-width="3"/>'],
  ingranaggio: ["Ingranaggio", '<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>'],
  garage: ["Garage", '<path d="M3 21V10l9-6 9 6v11M7 21v-8h10v8M7 16.5h10"/>'],
  accendi: ["Accensione", '<path d="M12 3v8"/><path d="M7.4 6.5a7 7 0 1 0 9.2 0"/>'],
};
const arrSvg = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${(ARR_SVG[k] || ARR_SVG.accendi)[1]}</svg>`;
// nella scelta delle entità per i tasti all'arrivo: solo quelle acceso/spento
const ARR_PICK = ["switch", "light", "input_boolean", "fan"];
const ARR_ICONS = { cover: "🚪", lock: "🔒", switch: "⏻", light: "💡", button: "🔘", input_button: "🔘", script: "📜", scene: "🎬", input_boolean: "⏻", fan: "🌀" };
// tipi di veicolo del garage
const VEHICLE_TYPES = [["auto", "🚗", "Auto"], ["moto", "🏍️", "Moto"], ["scooter", "🛵", "Scooter"], ["furgone", "🚐", "Furgone"],
  ["camper", "🚌", "Camper"], ["bici", "🚲", "Bici"], ["altro", "🚙", "Altro"]];
const vehIcon = (t) => (VEHICLE_TYPES.find((v) => v[0] === t) || VEHICLE_TYPES[0])[1];
// altezza degli edifici 3D: quella vera se in OpenStreetMap c'è (altezza o piani). Senza dati OpenFreeMap mette 5 m
// a tutti e il paese sembrava "piatto": lì si sceglie un'altezza da 1 a 3 piani, fissa per ogni edificio (dal suo
// identificativo), così le case non sono tutte uguali. Non è un'altezza vera, è solo più verosimile.
const BLD_VAR = [5.5, 6.5, 7, 7.5, 8.5, 9.5, 6, 10.5, 7, 8];
const BLD_H = ["case", [">", ["coalesce", ["get", "render_height"], 0], 5], ["get", "render_height"],
  ["match", ["%", ["to-number", ["id"], 3], 10], ...BLD_VAR.flatMap((v, i) => [i, v]), 7]];
function bldHeight(f) {
  const h = Number(f?.properties?.render_height) || 0;
  if (h > 5) return h;
  const id = Number(f?.id);
  return Number.isFinite(id) ? BLD_VAR[((id % 10) + 10) % 10] : 7;
}
// zoom della vista 3D rispetto alla mappa 2D (fuori dalla guida): a scala uguale sarebbe −1 (riquadri da 512 px contro
// 256), ma con la vista inclinata la 3D sembrava lontanissima; con 0 è il doppio più vicina e appare come la 2D
const Z3D = 0;
const NIGHT_MODES = [["auto", "Automatica (al tramonto)"], ["on", "Sempre"], ["off", "Mai"]];
const POI_MIN_ZOOM = 13;
const NEAR_CATS = { fuel: ["⛽", "Distributori"], parking: ["🅿️", "Parcheggi"], cameras: ["📷", "Autovelox"] };
const LANG_NAMES = { it: "Italiano", en: "English", de: "Deutsch", fr: "Français", es: "Español" };
const LANG_BCP = { it: "it-IT", en: "en-US", de: "de-DE", fr: "fr-FR", es: "es-ES" };
// frasi della voce nelle lingue delle indicazioni
const PHRASES = {
  it: { in: (d) => `Tra ${d}`, m: "metri", km: "chilometri", reroute: "Ricalcolo del percorso", newroute: "Nuovo percorso calcolato",
    camera: (d) => `Autovelox tra ${d}`, limit: (n) => `limite ${n}`,
    arrived: "Sei arrivato a destinazione", test: "Questa è la voce di Navigator. Tra 200 metri, svolta a destra." },
  en: { in: (d) => `In ${d}`, m: "meters", km: "kilometers", reroute: "Recalculating route", newroute: "New route calculated",
    camera: (d) => `Speed camera in ${d}`, limit: (n) => `limit ${n}`,
    arrived: "You have arrived at your destination", test: "This is the Navigator voice. In 200 meters, turn right." },
  de: { in: (d) => `In ${d}`, m: "Metern", km: "Kilometern", reroute: "Route wird neu berechnet", newroute: "Neue Route berechnet",
    camera: (d) => `Blitzer in ${d}`, limit: (n) => `Tempolimit ${n}`,
    arrived: "Sie haben Ihr Ziel erreicht", test: "Das ist die Stimme von Navigator. In 200 Metern rechts abbiegen." },
  fr: { in: (d) => `Dans ${d}`, m: "mètres", km: "kilomètres", reroute: "Recalcul de l'itinéraire", newroute: "Nouvel itinéraire calculé",
    camera: (d) => `Radar dans ${d}`, limit: (n) => `limite ${n}`,
    arrived: "Vous êtes arrivé à destination", test: "Voici la voix de Navigator. Dans 200 mètres, tournez à droite." },
  es: { in: (d) => `En ${d}`, m: "metros", km: "kilómetros", reroute: "Recalculando la ruta", newroute: "Nueva ruta calculada",
    camera: (d) => `Radar en ${d}`, limit: (n) => `límite ${n}`,
    arrived: "Has llegado a tu destino", test: "Esta es la voz de Navigator. En 200 metros, gira a la derecha." },
};

function spokenDist(m, lang) {
  const P = PHRASES[lang] || PHRASES.it;
  if (m < 1000) return `${m < 300 ? Math.max(50, Math.round(m / 50) * 50) : Math.round(m / 100) * 100} ${P.m}`;
  return `${(Math.round(m / 100) / 10).toLocaleString(LANG_BCP[lang], { maximumFractionDigits: 1 })} ${P.km}`;
}

// le voci del browser non dicono se sono maschili o femminili: si riconoscono dal nome
const FEMALE = /female|donna|woman|frau|femme|mujer|alice|elsa|isabella|federica|paola|carla|giorgia|chiara|emma|anna|samantha|victoria|karen|moira|tessa|susan|zira|hazel|katja|hedda|amelie|julie|hortense|denise|helena|laura|monica|paulina|sabina|elvira|sofia|francesca|serena|aria|jenny|sonia|libby|clara|marie|petra|helene|ines|lucia|paloma|ximena|dalia|seraphina|eloise|vivienne|giulia|valeria|martina/i;
const MALE = /\bmale\b|\buomo\b|\bman\b|\bmann\b|homme|hombre|luca|cosimo|diego|giuseppe|benigno|calogero|rinaldo|giorgio|daniel|alex|fred|\btom\b|david|mark|\bguy\b|george|stefan|conrad|killian|henri|paul|jorge|pablo|alvaro|juan|ryan|eric|andrew|brian|christopher|roger|thomas|florian|remy|claude|gerardo|raul|alessio|marcello|ezio|lorenzo|matteo/i;
function voiceGender(name) {
  if (FEMALE.test(name) && !MALE.test(name)) return "f";
  if (MALE.test(name) && !FEMALE.test(name)) return "m";
  return "";
}

// zoom in guida secondo la velocità (km/h): più largo quando si va veloci
function zoomForSpeed(kmh) {
  if (kmh < 25) return 17.5;
  if (kmh < 45) return 17;
  if (kmh < 70) return 16.25;
  if (kmh < 100) return 15.5;
  return 14.75;
}

// fuori percorso per almeno questo tempo (e due posizioni) prima di ricalcolare
const OFF_ROUTE_MS = 6000;

// distanza in metri fra due punti [lat, lon]
// metri con il punto delle migliaia (1.240 m)
function fmtM(v) {
  return `${Math.round(v || 0).toLocaleString("it-IT")} m`;
}

// dislivello di un percorso: totale (salite + discese), salite, discese, arrivo − partenza e quota massima
function elevLine(e) {
  if (!e || e.total == null) return "";
  const diff = e.diff ? ` · arrivo ${e.diff > 0 ? "+" : "−"}${fmtM(Math.abs(e.diff))}` : "";
  return `<div class="elev" title="Salite e discese sommate (variazioni sotto i 6 m non contano); quote da ${e.min} a ${e.max} m">⛰ ${
    fmtM(e.total)} di dislivello (↗ ${fmtM(e.up)} · ↘ ${fmtM(e.down)})${diff} · max ${fmtM(e.max)}</div>`;
}

// due cifre a 7 segmenti come gli orologi a cristalli liquidi: dritte, segmenti grossi a trapezio con gli angoli
// tagliati a 45°, stacchi sottili e netti tra un segmento e l'altro, segmenti spenti appena percettibili
const SEG7 = (() => {
  // proporzioni prese dall'orologio LCD: cifra larga ~metà dell'altezza, segmento ~1/8 dell'altezza, stacchi netti
  const W = 10.4, H = 20, T = 2.2, g = 0.68, m = H / 2;
  const P = (pts) => pts.map(([x, y]) => `${+x.toFixed(2)},${+y.toFixed(2)}`).join(" ");
  const mx = (pts) => pts.map(([x, y]) => [W - x, y]); // specchio orizzontale
  const f = [[0, g * 1.4], [T, T + g], [T, m - T / 2 - g], [T / 2, m - g], [0, m - g * 1.4]];
  const e = [[0, m + g * 1.4], [T / 2, m + g], [T, m + T / 2 + g], [T, H - T - g], [0, H - g * 1.4]];
  return {
    a: P([[g * 1.4, 0], [W - g * 1.4, 0], [W - T - g, T], [T + g, T]]),
    d: P([[T + g, H - T], [W - T - g, H - T], [W - g * 1.4, H], [g * 1.4, H]]),
    g: P([[T / 2 + g, m], [T + g, m - T / 2], [W - T - g, m - T / 2], [W - T / 2 - g, m], [W - T - g, m + T / 2], [T + g, m + T / 2]]),
    f: P(f), e: P(e), b: P(mx(f)), c: P(mx(e)),
  };
})();
const SEG7_ON = ["abcdef", "bc", "abged", "abgcd", "fgbc", "afgcd", "afgedc", "abc", "abcdefg", "abcdfg"];
function seg7Svg(text, slots = 2) {
  const digits = String(text).padStart(slots, " ").slice(-slots).split("");
  const body = digits.map((ch, i) => {
    const on = ch === " " ? "" : SEG7_ON[+ch] || ""; // posto vuoto: solo i segmenti spenti
    // segmenti spenti appena percettibili, come sui display veri
    return `<g transform="translate(${i * 13.6} 0)">${Object.entries(SEG7)
      .map(([k, pts]) => `<polygon points="${pts}"${on.includes(k) ? "" : ' opacity=".13"'}/>`).join("")}</g>`;
  }).join("");
  return `<svg class="seg7" viewBox="-0.5 -0.5 ${(slots * 13.6 - 2.2).toFixed(1)} 21" preserveAspectRatio="xMidYMid meet"><g fill="currentColor">${body}</g></svg>`;
}

function distM(a, b) {
  const kx = 111320 * Math.cos((a[0] * Math.PI) / 180);
  const dx = (b[1] - a[1]) * kx;
  const dy = (b[0] - a[0]) * 110540;
  return Math.sqrt(dx * dx + dy * dy);
}

// distanza (m) del punto pos {lat, lon} dal segmento a-b e posizione t (0..1) del punto più vicino
function segDist(pos, a, b) {
  const kx = 111320 * Math.cos((pos.lat * Math.PI) / 180);
  const ax = (a[1] - pos.lon) * kx, ay = (a[0] - pos.lat) * 110540;
  const bx = (b[1] - pos.lon) * kx, by = (b[0] - pos.lat) * 110540;
  const vx = bx - ax, vy = by - ay;
  const l2 = vx * vx + vy * vy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / l2)) : 0;
  const x = ax + t * vx, y = ay + t * vy;
  return { dist: Math.sqrt(x * x + y * y), t };
}

// direzione di marcia in gradi (0 = nord)
function bearing(a, b) {
  const kx = Math.cos((a[0] * Math.PI) / 180);
  return ((Math.atan2((b[1] - a[1]) * kx, b[0] - a[0]) * 180) / Math.PI + 360) % 360;
}

// da quanto tempo: "ora", "5 min fa", "3 h fa", "2 g fa"
function fmtAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "ora";
  if (min < 60) return `${min} min fa`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h fa` : `${Math.floor(h / 24)} g fa`;
}

const STALE_MS = 10 * 60000; // posizione di una persona più vecchia di così: si avvisa prima di partire

// periodo dell'anno per le sorprese in galleria: Natale (20 giorni prima, 10 dopo) e Halloween (idem)
function tunnelSeason(d = new Date()) {
  if (window.__naviSeason) return window.__naviSeason; // solo per le prove
  const y = d.getFullYear(), t = d.getTime();
  const at = (yy, m, dd) => new Date(yy, m, dd).getTime();
  if ((t >= at(y, 11, 5)) || (t < at(y, 0, 5))) return "natale"; // 5 dicembre → 4 gennaio
  if (t >= at(y, 9, 11) && t < at(y, 10, 11)) return "halloween"; // 11 ottobre → 10 novembre
  return null;
}

// disegni dei "visitatori" della galleria (SVG: si vedono uguali su ogni telefono)
const TF_BAT = `<svg viewBox="0 0 100 50"><path d="M50 17c-3 0-5 2-6 5-6-8-16-12-28-10 6 3 9 7 9 12-5-2-11-1-16 3 8 1 14 5 17 11 3-4 8-6 13-6 2 4 6 7 11 7s9-3 11-7c5 0 10 2 13 6 3-6 9-10 17-11-5-4-11-5-16-3 0-5 3-9 9-12-12-2-22 2-28 10-1-3-3-5-6-5z" fill="#221c17" stroke="#7a6650" stroke-width="1.3"/><path d="M46 19l-2-7 4 4M54 19l2-7-4 4" fill="#221c17" stroke="#7a6650" stroke-width="1"/><circle cx="46.8" cy="23.5" r="1.7" fill="#ffcc33"/><circle cx="53.2" cy="23.5" r="1.7" fill="#ffcc33"/></svg>`;
const TF_SANTA = `<svg viewBox="0 0 120 90"><path d="M38 30h44l-4 14H42z" fill="#c62828" stroke="#7f1010" stroke-width="1.2"/><path d="M36 44c2 4 6 5 10 5h28c4 0 8-1 10-5" fill="none" stroke="#ffcf3f" stroke-width="2.6" stroke-linecap="round"/><path d="M39 30h42" stroke="#ffcf3f" stroke-width="2"/><ellipse cx="60" cy="27" rx="11" ry="9" fill="#d32f2f"/><circle cx="60" cy="15" r="6" fill="#f6c9a8"/><path d="M54 16c0 7 3 10 6 10s6-3 6-10c-2 2-4 3-6 3s-4-1-6-3z" fill="#fff"/><circle cx="58" cy="14" r=".9" fill="#222"/><circle cx="62" cy="14" r=".9" fill="#222"/><path d="M53 12c1-6 6-9 12-7l3 8z" fill="#d32f2f"/><circle cx="68.5" cy="13" r="2.3" fill="#fff"/><rect x="53" y="10.5" width="14" height="2.6" rx="1.3" fill="#fff"/><path d="M52 30L33 46M68 30L87 46" stroke="#5d3a1a" stroke-width="1.1"/><g fill="#8d5a30" stroke="#4e2f14" stroke-width="1"><ellipse cx="33" cy="67" rx="10" ry="12"/><ellipse cx="87" cy="67" rx="10" ry="12"/><ellipse cx="33" cy="49" rx="6" ry="7"/><ellipse cx="87" cy="49" rx="6" ry="7"/></g><g stroke="#6d4520" stroke-width="1.7" fill="none" stroke-linecap="round"><path d="M29 44l-4-8m2 4l-5-1M37 44l4-8m-2 4l5-1M83 44l-4-8m2 4l-5-1M91 44l4-8m-2 4l5-1"/></g><circle cx="33" cy="54" r="5" fill="#ff2a2a" opacity=".35"/><circle cx="33" cy="54" r="2.5" fill="#ff2a2a"/><circle cx="87" cy="54" r="2" fill="#3b2412"/><g fill="#111"><circle cx="31" cy="48" r="1"/><circle cx="35" cy="48" r="1"/><circle cx="85" cy="48" r="1"/><circle cx="89" cy="48" r="1"/></g></svg>`;
const TF_PUMPKIN = `<svg viewBox="0 0 60 56"><path d="M30 10c-2-5-1-8 3-9" stroke="#4e7a1e" stroke-width="3" fill="none" stroke-linecap="round"/><ellipse cx="30" cy="32" rx="27" ry="22" fill="#f57c00" stroke="#a84300" stroke-width="1.5"/><path d="M30 10c-9 0-12 10-12 22s3 22 12 22M30 10c9 0 12 10 12 22s-3 22-12 22" fill="none" stroke="#c75c00" stroke-width="1.4"/><path d="M16 27l6-7 6 7zM32 27l6-7 6 7z" fill="#ffe066"/><path d="M14 36c4 9 28 9 32 0l-4 2-3-3-3 3-3-3-3 3-3-3-3 3-3-3-3 3z" fill="#ffe066"/></svg>`;
const TF_GHOST = `<svg viewBox="0 0 50 60"><path d="M25 3C12 3 5 13 5 26v30l6-5 6 5 8-5 8 5 6-5 6 5V26C45 13 38 3 25 3z" fill="#f4f6f8" fill-opacity=".92" stroke="#c9d1d8" stroke-width="1"/><ellipse cx="18" cy="25" rx="3.6" ry="5" fill="#222"/><ellipse cx="32" cy="25" rx="3.6" ry="5" fill="#222"/><ellipse cx="25" cy="38" rx="4" ry="5.5" fill="#222"/></svg>`;

// icone meteo DISEGNATE (SVG): sempre uguali su ogni dispositivo, al posto delle emoji (che a volte diventano un quadrato)
// ---------------------------------------------------------------- lettura di un file .zip (per gli add-on)
// Legge l'indice in fondo al file e scompatta ogni voce (salvata così com'è o compressa "deflate", come fanno tutti i
// programmi di compressione) con il DecompressionStream del browser: niente librerie. Restituisce {nome: Uint8Array}.
async function readZip(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("non è un file .zip valido");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = {}, dec = new TextDecoder();
  for (let n = 0; n < count && n < 200; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("file .zip rovinato");
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const loc = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/") || name.startsWith("__MACOSX/")) continue;
    if (csize > 4_000_000) throw new Error(`"${name}" è troppo grande`);
    const start = loc + 30 + dv.getUint16(loc + 26, true) + dv.getUint16(loc + 28, true);
    const data = u8.slice(start, start + csize);
    if (method === 0) out[name] = data;
    else if (method === 8) out[name] = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    else throw new Error(`"${name}" è compresso in un modo non supportato`);
  }
  return out;
}

function wxIcon(kind) {
  const cloud = '<path d="M7.3 17.3a3.5 3.5 0 0 1-.3-7 5 5 0 0 1 9.6-1.2 3.3 3.3 0 0 1-.3 6.6z" fill="#e6ebf0" stroke="#95a2af" stroke-width="1"/>';
  const wrap = (inner) => `<svg class="wxs" viewBox="0 0 24 24">${inner}</svg>`;
  const cl = (inner) => wrap(cloud + inner);
  switch (kind) {
    case "storm": return cl('<path d="M12.2 13.5l-3 4.5h2.3l-1.1 4 3.9-5.6h-2.5l1.6-2.9z" fill="#ffcf2e" stroke="#d9a400" stroke-width=".5"/>');
    case "snow": return cl('<g fill="#74c0ff"><circle cx="8.5" cy="20" r="1.2"/><circle cx="12" cy="22.2" r="1.2"/><circle cx="15.5" cy="20" r="1.2"/></g>');
    case "rain": return cl('<g stroke="#2e9cff" stroke-width="2" stroke-linecap="round"><line x1="8" y1="18.5" x2="7" y2="22.5"/><line x1="12" y1="18.5" x2="11" y2="23"/><line x1="16" y1="18.5" x2="15" y2="22.5"/></g>');
    case "fog": return cl('<g stroke="#b6c0ca" stroke-width="2" stroke-linecap="round"><line x1="5.5" y1="20" x2="16" y2="20"/><line x1="8" y1="23" x2="18.5" y2="23"/></g>');
    case "wind": return wrap('<g fill="none" stroke="#8fa0b0" stroke-width="2" stroke-linecap="round"><path d="M3 9h11a2.6 2.6 0 1 0-2.6-2.6"/><path d="M3 14h15a2.6 2.6 0 1 1-2.6 2.6"/></g>');
    case "ice": return wrap('<g stroke="#49c7ff" stroke-width="2" stroke-linecap="round"><line x1="12" y1="3" x2="12" y2="21"/><line x1="4" y1="7.5" x2="20" y2="16.5"/><line x1="20" y1="7.5" x2="4" y2="16.5"/></g>');
    case "cold": return wrap('<path d="M12 4a1 1 0 0 1 1 1v9.3a3.2 3.2 0 1 1-2 0V5a1 1 0 0 1 1-1z" fill="#8fd0ff" stroke="#4a7fb0" stroke-width="1"/>');
    default: return cl('');
  }
}

// avvisi del meteo in un punto (Open-Meteo: mm/h, cm/h, °C, km/h, codici WMO)
function wxWarnings(w) {
  const out = [];
  const c = w.code ?? -1;
  if (c >= 95) out.push({ ico: "⛈️", kind: "storm", txt: "Temporale" });
  if ((w.snow || 0) >= 0.1 || [71, 73, 75, 77, 85, 86].includes(c)) out.push({ ico: "🌨️", kind: "snow", txt: (w.snow || 0) >= 1 ? "Neve forte" : "Neve" });
  else if ((w.prec || 0) >= 0.3 || (c >= 51 && c <= 67) || (c >= 80 && c <= 82)) {
    out.push({ ico: "🌧️", kind: "rain", txt: (w.prec || 0) >= 4 ? "Pioggia forte" : "Pioggia" });
  }
  if (w.temp != null && w.temp <= 1 && ((w.prec || 0) > 0 || [56, 57, 66, 67].includes(c))) out.push({ ico: "🧊", kind: "ice", txt: "Rischio ghiaccio" });
  else if (w.temp != null && w.temp <= 0) out.push({ ico: "🥶", kind: "cold", txt: "Gelo" });
  if ((w.gust || 0) >= 60) out.push({ ico: "💨", kind: "wind", txt: "Vento forte" });
  if (c === 45 || c === 48) out.push({ ico: "🌫️", kind: "fog", txt: "Nebbia" });
  return out;
}

// ----------------------------------------------------------------- orari di apertura (opening_hours di OpenStreetMap)
// Si leggono i casi comuni ("Mo-Fr 07:00-20:00; Sa 08:00-13:00; Su off", "24/7", più fasce, oltre la mezzanotte);
// con regole più complesse (mesi, festivi con orari, date) si mostra il testo così com'è.
const OH_DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const OH_IT = ["Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato", "Domenica"];
function parseOpeningHours(src) {
  const txt = String(src || "").trim();
  if (!txt) return null;
  const week = Array.from({ length: 7 }, () => []);
  if (/^24\/7$/.test(txt)) return week.map(() => [[0, 1440]]);
  const hm = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t); return m ? +m[1] * 60 + +m[2] : null; };
  for (let rule of txt.split(/;|\|\|/)) {
    rule = rule.trim().replace(/\s*,\s*/g, ",").replace(/\s*-\s*/g, "-");
    if (!rule) continue;
    const parts = rule.split(/\s+/);
    let days = null;
    if (/^(Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)/.test(parts[0])) {
      days = new Set();
      let onlyHoliday = true;
      for (const d of parts.shift().split(",")) {
        if (d === "PH" || d === "SH") continue;
        const m = /^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/.exec(d);
        if (!m) return null;
        onlyHoliday = false;
        const a = OH_DAYS.indexOf(m[1]), b = OH_DAYS.indexOf(m[2] || m[1]);
        for (let k = a; ; k = (k + 1) % 7) { days.add(k); if (k === b) break; }
      }
      if (onlyHoliday) continue; // regola solo per i festivi: ignorata
    }
    const rest = parts.join(" ").trim();
    let ranges = [];
    if (/^(off|closed)$/i.test(rest)) ranges = [];
    else if (!rest) ranges = [[0, 1440]];
    else {
      for (const r of rest.split(",")) {
        const m = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})\+?$/.exec(r);
        if (!m) return null;
        const a = hm(m[1]); let b = hm(m[2]);
        if (a == null || b == null) return null;
        if (b <= a) b += 1440; // oltre la mezzanotte
        ranges.push([a, b]);
      }
    }
    for (const k of days || [0, 1, 2, 3, 4, 5, 6]) week[k] = ranges.map((x) => [...x]);
  }
  return week;
}
const ohClock = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
// giorni consecutivi con lo stesso orario insieme: [[primo, ultimo, "06:30–20:00"], ...]
function ohGroups(week) {
  const txt = (r) => (r.length ? r.map(([a, b]) => `${ohClock(a)}–${ohClock(b)}`).join(", ") : "chiuso");
  const out = [];
  week.forEach((r, k) => {
    const t = txt(r), last = out[out.length - 1];
    if (last && last[2] === t) last[1] = k; else out.push([k, k, t]);
  });
  return out;
}
// aperto adesso? e quando cambia: { open, text }
function ohStatus(week, now = new Date()) {
  const d = (now.getDay() + 6) % 7, t = now.getHours() * 60 + now.getMinutes();
  const prev = (d + 6) % 7;
  for (const [a, b] of week[d]) {
    if (t < a || t >= b) continue;
    if (a === 0 && b === 1440) return { open: true, text: "aperto 24 ore" };
    return { open: true, text: `chiude alle ${ohClock(b)}` }; // oltre la mezzanotte: l'ora del giorno dopo
  }
  for (const [, b] of week[prev]) if (b > 1440 && t < b - 1440) return { open: true, text: `chiude alle ${ohClock(b - 1440)}` };
  for (let k = 0; k < 7; k++) {
    const day = (d + k) % 7;
    const next = week[day].map((r) => r[0]).filter((a) => k > 0 || a > t).sort((x, y) => x - y)[0];
    if (next != null) return { open: false, text: `apre ${k === 0 ? "" : k === 1 ? "domani " : `${OH_IT[day].toLowerCase()} `}alle ${ohClock(next)}` };
  }
  return { open: false, text: "chiuso" };
}

const fmtClock = (t) => new Date(t * 1000).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });

// Lettore minimo dei riquadri vettoriali (formato Mapbox Vector Tile, protobuf): solo i punti di un livello, con le proprietà.
// Basta per il livello "poi" di OpenFreeMap; nessuna libreria esterna.
function mvtPoints(buf, layerName, z, tx, ty) {
  const b = new Uint8Array(buf);
  let pos = 0;
  const varint = () => {
    let r = 0;
    let s = 0;
    let c;
    do { c = b[pos++]; r += (c & 0x7f) * 2 ** s; s += 7; } while (c & 0x80);
    return r;
  };
  // fine di un campo a lunghezza: prima si legge la lunghezza (che fa avanzare pos), poi si somma
  const end = () => { const len = varint(); return pos + len; };
  const skip = (wt) => {
    if (wt === 0) varint();
    else if (wt === 1) pos += 8;
    else if (wt === 2) pos = end();
    else if (wt === 5) pos += 4;
  };
  const str = (end) => new TextDecoder().decode(b.subarray(pos, end));
  const out = [];
  while (pos < b.length) {
    const tag = varint();
    if ((tag >> 3) !== 3 || (tag & 7) !== 2) { skip(tag & 7); continue; }
    const lend = end();
    let name = "";
    let extent = 4096;
    const keys = [];
    const values = [];
    const feats = [];
    while (pos < lend) {
      const t = varint();
      const f = t >> 3;
      if (f === 1) { const e = end(); name = str(e); pos = e; }
      else if (f === 3) { const e = end(); keys.push(str(e)); pos = e; }
      else if (f === 5) extent = varint();
      else if (f === 4) {
        const e = end();
        let v = null;
        while (pos < e) {
          const vt = varint();
          const vf = vt >> 3;
          if (vf === 1) { const se = end(); v = str(se); pos = se; }
          else if (vf === 2) { v = new DataView(b.buffer, b.byteOffset + pos, 4).getFloat32(0, true); pos += 4; }
          else if (vf === 3) { v = new DataView(b.buffer, b.byteOffset + pos, 8).getFloat64(0, true); pos += 8; }
          else if (vf === 4 || vf === 5) v = varint();
          else if (vf === 6) { const n = varint(); v = n % 2 ? -(n + 1) / 2 : n / 2; }
          else if (vf === 7) v = !!varint();
          else skip(vt & 7);
        }
        values.push(v);
      } else if (f === 2) {
        const fe = end();
        const feat = { id: null, tags: [], type: 0, geom: [] };
        while (pos < fe) {
          const ft = varint();
          const ff = ft >> 3;
          if (ff === 1) feat.id = varint();
          else if (ff === 3) feat.type = varint();
          else if (ff === 2 || ff === 4) {
            const pe = end();
            const arr = ff === 2 ? feat.tags : feat.geom;
            while (pos < pe) arr.push(varint());
          } else skip(ft & 7);
        }
        feats.push(feat);
      } else skip(t & 7);
    }
    pos = lend;
    if (name !== layerName) continue;
    const n = 2 ** z;
    for (const ft of feats) {
      if (ft.type !== 1 || ft.geom.length < 3) continue; // solo punti
      const zz = (v) => (v >>> 1) ^ -(v & 1);
      const px = zz(ft.geom[1]);
      const py = zz(ft.geom[2]);
      const lon = ((tx + px / extent) / n) * 360 - 180;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + py / extent)) / n))) * 180) / Math.PI;
      const props = {};
      for (let i = 0; i + 1 < ft.tags.length; i += 2) props[keys[ft.tags[i]]] = values[ft.tags[i + 1]];
      out.push({ id: ft.id, lat, lon, props });
    }
  }
  return out;
}

// punto dentro un anello di coordinate [lon, lat] (regola del raggio)
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function fmtDist(m) {
  if (m < 1000) return `${m < 100 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50} m`;
  return `${(m / 1000).toLocaleString("it-IT", { maximumFractionDigits: m < 10000 ? 1 : 0 })} km`;
}

const STYLE = `
  :host { display: flex; flex-direction: column; height: 100vh; height: 100dvh; overflow: hidden; background: var(--primary-background-color); color: var(--primary-text-color);
    font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif); }
  * { box-sizing: border-box; }
  .toolbar { flex: none; display: flex; align-items: center; height: var(--header-height, 56px); padding: 0 12px 0 4px;
    background: var(--app-header-background-color, var(--primary-color)); color: var(--app-header-text-color, #fff);
    border-bottom: var(--app-header-border-bottom, none); }
  .toolbar .title { font-size: 20px; margin-left: 8px; display: flex; align-items: baseline; gap: 10px; flex: 1; min-width: 0; }
  .toolbar .ver { font-size: 12px; opacity: .7; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; }
  .toolbar .brand { display: inline-flex; align-items: center; gap: 8px; }
  .toolbar .brand img { width: 30px; height: 30px; align-self: center; background: #fff; border-radius: 50%; padding: 1px; }
  /* altezza presa dalla finestra: dentro Home Assistant il 100% del pannello può risultare nullo e la mappa sparire */
  .main { flex: 1; min-height: 0; display: flex; }
  #verwarn { flex: none; }
  .footver { margin-top: 10px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; }
  .footver img { width: 18px; height: 18px; background: #fff; border-radius: 50%; }
  .footver a { color: var(--primary-color); }
  .side { width: 390px; flex: none; overflow-y: auto; border-right: 1px solid var(--divider-color);
    background: var(--card-background-color, #fff); }
  .mapwrap { flex: 1; position: relative; min-width: 0; min-height: 300px; }
  /* !important: se la mappa nasce prima che il pannello sia in pagina Leaflet scrive position: relative e l'altezza va a 0 */
  #map { position: absolute !important; inset: 0; background: #ddd; }
  /* i gesti (trascinamento, zoom, rotazione a due dita) li gestiamo noi e Leaflet: il browser non deve prendersi
     il gesto a due dita come zoom della pagina, altrimenti la rotazione della mappa 2D non parte */
  #map, #map * { touch-action: none !important; }
  #map, #map3d { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; } /* tocco prolungato: niente selezione */
  @media (max-width: 800px) {
    :host { display: block; overflow-y: auto; }
    .main { flex-direction: column-reverse; }
    .mapwrap { flex: none; height: 52vh; }
    .side { width: 100%; border-right: none; overflow: visible; }
  }
  .sec { padding: 12px 14px; border-bottom: 1px solid var(--divider-color); }
  .sec h3 { margin: 0 0 8px; font-size: 13px; font-weight: 500; text-transform: uppercase; letter-spacing: .04em;
    color: var(--secondary-text-color); display: flex; justify-content: space-between; align-items: center; }
  .field { position: relative; display: flex; align-items: center; gap: 6px; }
  input[type=text] { flex: 1; min-width: 0; font: inherit; font-size: 15px; padding: 9px 10px; border-radius: 8px;
    border: 1px solid var(--divider-color); background: var(--secondary-background-color, #f5f5f5);
    color: var(--primary-text-color); outline: none; }
  input[type=text]:focus { border-color: var(--primary-color); background: var(--card-background-color, #fff); }
  .search input { padding-left: 34px; }
  .search::before { content: "🔍"; position: absolute; left: 10px; font-size: 14px; opacity: .6; pointer-events: none; }
  button { font: inherit; cursor: pointer; border-radius: 8px; border: 1px solid var(--divider-color);
    background: var(--card-background-color, #fff); color: var(--primary-text-color); padding: 7px 10px; }
  button:hover { border-color: var(--primary-color); }
  button:disabled { opacity: .5; cursor: default; }
  button.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
  button.icon { padding: 4px 7px; border: none; background: none; font-size: 16px; color: var(--secondary-text-color); }
  button.icon:hover { color: var(--primary-color); }
  button.link { border: none; background: none; color: var(--primary-color); padding: 2px 4px; font-size: 13px; }
  .suggest { position: absolute; left: 0; right: 0; top: 100%; margin-top: 4px; z-index: 50; max-height: 330px; overflow-y: auto;
    background: var(--card-background-color, #fff); border: 1px solid var(--divider-color); border-radius: 8px;
    box-shadow: 0 6px 18px rgba(0,0,0,.18); }
  .suggest .item { padding: 8px 10px; cursor: pointer; display: flex; gap: 8px; align-items: flex-start; }
  .suggest .item:hover, .suggest .item.active { background: var(--secondary-background-color, #f0f0f0); }
  .suggest .item .ico { width: 20px; text-align: center; flex: none; }
  .suggest .item .t { font-size: 14px; }
  .suggest .item .a { font-size: 12px; color: var(--secondary-text-color); }
  .suggest .head { padding: 6px 10px 2px; font-size: 11px; text-transform: uppercase; color: var(--secondary-text-color); }
  .suggest .empty { padding: 10px; font-size: 13px; color: var(--secondary-text-color); }
  .badge { width: 24px; height: 24px; flex: none; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
    font-size: 12px; font-weight: 700; color: #fff; background: #607d8b; }
  .badge.start { background: #2e7d32; } .badge.end { background: #c62828; }
  .pts .field { margin-bottom: 6px; }
  .row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .modes { display: flex; gap: 4px; margin: 8px 0; }
  .modes button { flex: 1; padding: 6px 4px; font-size: 13px; }
  .modes button.on { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
  label.chk { display: inline-flex; align-items: center; gap: 5px; font-size: 14px; margin-right: 12px; cursor: pointer; }
  .placecard { margin-top: 10px; padding: 10px; border-radius: 10px; background: var(--secondary-background-color, #f5f5f5); }
  .pinfo { margin: 2px 0 10px; font-size: 13px; }
  .pinfo .ohst { font-weight: 600; } .pinfo .ohst.on { color: #2e7d32; } .pinfo .ohst.off { color: #c62828; }
  .pinfo .ohst span { font-weight: 400; color: var(--primary-text-color); }
  .pinfo table.oh { border-collapse: collapse; margin: 4px 0 2px; font-size: 12px; }
  .pinfo table.oh td { padding: 1px 10px 1px 0; color: var(--secondary-text-color); }
  .pinfo table.oh tr.today td { color: var(--primary-text-color); font-weight: 600; }
  .pinfo .pchips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
  .pinfo .pchips span { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: rgba(127,127,127,.15); }
  .pinfo .plinks { display: flex; flex-direction: column; gap: 3px; margin-top: 6px; }
  .pinfo a { color: var(--primary-color); text-decoration: none; word-break: break-all; }
  .placecard .n { font-weight: 500; } .placecard .a { font-size: 13px; color: var(--secondary-text-color); margin: 2px 0 8px; }
  .alts { display: flex; flex-direction: column; gap: 6px; }
  .alt { padding: 9px 10px; border-radius: 10px; border: 2px solid var(--divider-color); cursor: pointer; }
  .alt.on { border-color: var(--primary-color); background: rgba(26,115,232,.06); }
  .alt .tm { font-size: 18px; font-weight: 500; } .alt .km { color: var(--secondary-text-color); margin-left: 6px; }
  .alt .arr { float: right; font-size: 12px; color: var(--secondary-text-color); margin-top: 4px; }
  .tags { margin-top: 4px; display: flex; gap: 4px; flex-wrap: wrap; }
  .tag { font-size: 11px; padding: 2px 7px; border-radius: 10px; background: var(--secondary-background-color, #eee); }
  .tag.toll { background: #fff3e0; color: #e65100; } .tag.free { background: #e8f5e9; color: #2e7d32; }
  .box { padding: 10px; border-radius: 10px; margin-top: 10px; font-size: 14px; }
  .box.toll { background: #fff3e0; color: #5d3a00; border: 1px solid #ffb74d; }
  .box.ok { background: #e8f5e9; color: #1b5e20; border: 1px solid #81c784; }
  .box.warn { background: #fffde7; color: #5d4800; border: 1px solid #fdd835; }
  .box.err { background: #ffebee; color: #b71c1c; border: 1px solid #e57373; }
  .box.ex { background: var(--secondary-background-color, #f5f5f5); }
  .seg { display: flex; align-items: center; gap: 6px; padding: 6px 0; border-top: 1px dashed rgba(0,0,0,.15); }
  .seg:first-of-type { border-top: none; }
  .seg .nm { flex: 1; min-width: 0; }
  .seg .nm small { display: block; opacity: .75; }
  .seg button { font-size: 12px; padding: 4px 8px; background: rgba(255,255,255,.7); color: inherit; }
  .steps { list-style: none; margin: 0; padding: 0; }
  .steps li { display: flex; gap: 10px; padding: 8px 4px; border-bottom: 1px solid var(--divider-color); cursor: pointer; font-size: 14px; }
  .steps li:hover { background: var(--secondary-background-color, #f5f5f5); }
  .steps li .ic { width: 22px; text-align: center; flex: none; font-size: 16px; }
  .steps li .tx { flex: 1; } .steps li .d { font-size: 12px; color: var(--secondary-text-color); white-space: nowrap; }
  .steps li.toll .tx::after { content: " 💶"; }
  .steps li.legsep { background: var(--secondary-background-color, #f5f5f5); font-weight: 500; cursor: default; }
  /* intestazioni di sezione richiudibili (freccia a sinistra; chiuse di default) */
  h3.cbh { cursor: pointer; user-select: none; display: flex; align-items: center; gap: 6px; font-weight: 700;
    color: var(--primary-text-color); } /* sezioni che si aprono e chiudono: titolo in grassetto */
  h3.cbh .muted { font-weight: 400; }
  h3.cbh .cbcar { display: inline-block; transition: transform .15s; font-size: 12px; opacity: .65; }
  h3.cbh.open .cbcar { transform: rotate(90deg); }
  h3.cbh:not(.open) + .cbbody { display: none; }
  /* ricerca, veicolo e itinerario: dopo "Calcola percorso" si richiudono in una riga col riassunto del viaggio */
  h3.cbh.planh { margin: 0; padding: 12px 14px; border-bottom: 1px solid var(--divider-color); font-size: 14px; font-weight: 700;
    text-transform: none; letter-spacing: 0; color: var(--primary-text-color); background: var(--secondary-background-color, rgba(127,127,127,.08)); }
  h3.cbh.planh[hidden] { display: none; }
  h3.cbh.planh .cbcar { font-size: 14px; opacity: .8; }
  h3.cbh.planh .plansum { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  h3.cbh.planh .planedit { font-size: 12px; color: var(--primary-color); flex: none; }
  h3.cbh.planh.open .planedit { display: none; }
  .fav { display: flex; align-items: center; gap: 6px; padding: 5px 0; }
  .popup .imgdate { font-size: 12px; color: var(--secondary-text-color, #666); margin: 2px 0 6px; }
  .fav .nm { flex: 1; min-width: 0; cursor: pointer; } .fav .nm small { display: block; color: var(--secondary-text-color); }
  .fav .nm:hover { color: var(--primary-color); }
  .muted { color: var(--secondary-text-color); font-size: 13px; }
  .loading { display: inline-block; width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent;
    border-radius: 50%; animation: spin .8s linear infinite; vertical-align: -2px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .ctl { position: absolute; z-index: 1000; display: flex; flex-direction: column; gap: 6px; }
  .ctl.tr { top: 10px; right: 10px; } .ctl.br { bottom: 24px; right: 10px; }
  /* tipo di mappa (fuori dalla navigazione): riquadro scuro come la croce, solo l'icona dei livelli */
  .ctl .layerbox { width: 48px; height: 44px; padding: 0; border: none; border-radius: 12px; background: rgba(32,33,36,.85); color: #fff;
    box-shadow: 0 1px 5px rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .ctl .layerbox svg { width: 26px; height: 26px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linejoin: round; }
  #layer[hidden] { display: none; }
  .ctl select, .ctl button { box-shadow: 0 1px 5px rgba(0,0,0,.3); border: none; font-size: 13px; }
  .ctl select { padding: 6px; border-radius: 8px; background: #fff; color: #222; }
  .ctl button { background: #fff; color: #222; width: 38px; height: 38px; padding: 0; font-size: 18px; }
  .pin { width: 30px; height: 30px; border-radius: 50% 50% 50% 0; transform: rotate(-45deg); display: flex; align-items: center;
    justify-content: center; border: 2px solid #fff; box-shadow: 0 2px 6px rgba(0,0,0,.4); }
  .pin span { transform: rotate(45deg); color: #fff; font: 700 12px sans-serif; }
  .xmark { width: 22px; height: 22px; border-radius: 50%; background: #c62828; color: #fff; border: 2px solid #fff;
    display: flex; align-items: center; justify-content: center; font: 700 13px sans-serif; box-shadow: 0 1px 4px rgba(0,0,0,.4); }
  .me { width: 16px; height: 16px; border-radius: 50%; background: #1a73e8; border: 3px solid #fff; box-shadow: 0 0 0 6px rgba(26,115,232,.25); }
  .me.dev { background: #607d8b; box-shadow: 0 0 0 6px rgba(96,125,139,.25); }
  .popup .n { font-weight: 600; font-size: 14px; } .popup .a { font-size: 12px; color: #666; margin: 2px 0 8px; }
  .popup .row button { font-size: 12px; padding: 5px 7px; background: #fff; color: #222; border: 1px solid #ccc; }
  .verwarn { background: var(--error-color, #db4437); color: #fff; padding: 8px 14px; font-size: 14px; }
  /* navigazione */
  select.inp { width: 100%; font: inherit; font-size: 14px; padding: 8px; border-radius: 8px; border: 1px solid var(--divider-color);
    background: var(--secondary-background-color, #f5f5f5); color: var(--primary-text-color); }
  .navtop { position: absolute; z-index: 1001; top: 10px; left: 10px; right: 10px; display: flex; align-items: center; gap: 10px;
    background: #0b6e3a; color: #fff; border-radius: 12px; padding: 7px 12px; box-shadow: 0 2px 10px rgba(0,0,0,.35);
    cursor: grab; touch-action: none; } /* tieni premuto per spostarlo */
  /* icona della manovra grande quanto tutta la barra verde */
  .navtop .ic { font-size: 40px; width: 56px; height: 56px; margin: -5px 0 -5px -4px; flex: none; display: flex;
    align-items: center; justify-content: center; line-height: 1; }
  .navtop .ic .rbx { width: 56px; height: 56px; }
  .navtop .d { font-size: 23px; font-weight: 700; white-space: nowrap; }
  .navtop .t { font-size: 15px; line-height: 1.2; }
  /* in guida distanza e indicazione sulla stessa riga: banner più basso */
  .navtop .nmain { min-width: 0; flex: 1; }
  .navtop .nmain .d { display: inline; font-size: 20px; margin-right: 8px; }
  .navtop .nmain .t { display: inline; }
  .navtop.wait { background: #37474f; }
  /* spostata a mano (tieni premuto): solo in alto/basso, sempre a tutta larghezza */
  .navtop.moved { top: var(--nty); }
  .navtop.dragging { cursor: grabbing; opacity: .92; box-shadow: 0 6px 20px rgba(0,0,0,.5); user-select: none; transition: none; }
  .navtop { flex-wrap: wrap; }
  .navtop .navright { margin-left: auto; display: flex; align-items: center; gap: 10px; flex: none; }
  .navtop .navmute { background: rgba(255,255,255,.18); color: #fff; border: none; border-radius: 10px;
    width: 42px; height: 42px; font-size: 20px; flex: none; cursor: pointer; }
  .navtop .lim { width: 40px; height: 40px; border-radius: 50%; border: 5px solid #d32f2f; background: #fff; color: #111;
    display: inline-flex; align-items: center; justify-content: center; font: 700 16px sans-serif; flex: none; box-sizing: border-box; }
  .navtop .camrow { flex: 1 0 100%; display: flex; align-items: center; gap: 8px; background: #fff; color: #b71c1c; border-radius: 8px;
    padding: 4px 8px; font-weight: 700; font-size: 16px; position: relative; overflow: hidden; }
  .navtop .camrow .cico { font-size: 20px; }
  .navtop .camrow .ctx { flex: 1; }
  .navtop .camrow .clim { width: 30px; height: 30px; border-radius: 50%; border: 4px solid #d32f2f; color: #111; display: flex;
    align-items: center; justify-content: center; font-size: 13px; background: #fff; box-sizing: border-box; }
  .navtop .camrow .cd { font-size: 20px; min-width: 64px; text-align: right; }
  .navtop .camrow .cbar { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(211,47,47,.2); }
  .navtop .camrow .cbar i { display: block; height: 100%; background: #d32f2f; transition: width .5s linear; }
  .navtop.preview { background: #1f4e79; gap: 8px; padding: 8px 8px 8px 10px; }
  .navtop .pv { background: rgba(255,255,255,.15); color: #fff; border: none; border-radius: 8px; min-width: 34px; height: 40px; font-size: 22px;
    padding: 0 6px; flex: none; cursor: pointer; }
  .navtop .pv:disabled { opacity: .3; cursor: default; }
  .navtop .pv.x { font-size: 16px; }
  .navtop .pvn { font-size: 12px; opacity: .8; margin-top: 2px; }
  .steps li.sel { background: rgba(3,169,244,.15); }
  .steppin { position: relative; width: 36px; height: 48px; filter: drop-shadow(0 2px 3px rgba(0,0,0,.45)); }
  .steppin svg { width: 36px; height: 48px; display: block; }
  .steppin img { position: absolute; left: 9.5px; top: 8.5px; width: 17px; height: 17px; border-radius: 50%; }
  .navbot { position: absolute; z-index: 1001; bottom: 20px; left: 10px; right: 10px; display: flex; align-items: center; gap: 8px 12px;
    flex-wrap: wrap; background: var(--card-background-color, #fff); color: var(--primary-text-color); border-radius: 12px;
    padding: 8px 10px; box-shadow: 0 2px 10px rgba(0,0,0,.3); font-size: 14px; }
  .navbot .info { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; flex: 1 1 auto; min-width: 150px; }
  .navbot .rem { font-size: 18px; font-weight: 600; }
  .navbot .tools { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-left: auto; }
  .navbot button { padding: 0 10px; height: 36px; min-width: 36px; font-size: 15px; }
  /* tipo di mappa: solo l'icona dei livelli (il nome compare per un attimo quando si cambia) */
  .navbot .layerbtn svg { width: 22px; height: 22px; display: block; fill: none; stroke: currentColor; stroke-width: 2; stroke-linejoin: round; }
  .navbot button.attn { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
  .navbot button.stop { background: #c62828; color: #fff; border-color: #c62828; font-size: 14px; }
  .navbot select { height: 36px; font: inherit; font-size: 13px; padding: 0 6px; border-radius: 8px; border: 1px solid var(--divider-color);
    background: var(--card-background-color, #fff); color: var(--primary-text-color); max-width: 150px; }
  .main.guida .ctl.br { display: none; }
  @media (max-width: 800px) {
    .navbot .tools { width: 100%; margin-left: 0; flex-wrap: nowrap; }
    .navbot select { flex: 1; min-width: 0; max-width: none; }
  }
  /* "Dove vai?": partito senza percorso, mete probabili (preferiti, viaggi in archivio) */
  .adpop { position: absolute; z-index: 1003; left: 10px; right: 10px; top: 10px; max-width: 420px; margin: 0 auto;
    background: var(--card-background-color, #fff); color: var(--primary-text-color, #212121); border-radius: 12px;
    box-shadow: 0 4px 18px rgba(0,0,0,.4); padding: 8px 10px; }
  .adpop[hidden] { display: none; }
  /* schermo dell'auto: più grande, da toccare col dito */
  .adpop.big { max-width: 560px; top: 50%; transform: translateY(-50%); padding: 12px 14px; }
  .adpop.big .adh { font-size: 22px; }
  .adpop.big .adh button { width: 60px; height: 52px; font-size: 24px; }
  .adpop.big .adl { max-height: 300px; }
  .adpop.big .adi { font-size: 20px; padding: 12px 10px; }
  .adpop.big .adi .vs { width: 44px; height: 44px; flex: none; }
  .adpop.big .adi .vs svg { width: 44px; height: 44px; }
  .adpop .adh { display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 15px; }
  .adpop .adh span { flex: 1; }
  .adpop .adh button { border: none; background: var(--secondary-background-color, #eee); color: var(--primary-text-color, #212121); width: 36px; height: 32px;
    border-radius: 8px; font-size: 16px; padding: 0; }
  .adpop .adl { max-height: 168px; overflow-y: auto; margin-top: 6px; scroll-behavior: smooth; }
  .adpop .adi { display: flex; align-items: center; gap: 8px; padding: 8px 6px; border-radius: 8px; cursor: pointer; font-size: 14px; }
  .adpop .adi.sel { background: rgba(3,169,244,.15); outline: 2px solid var(--primary-color); }
  .adpop .adi .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .adpop .adi small { color: var(--secondary-text-color, #727272); white-space: nowrap; }
  .navpop { position: absolute; z-index: 1002; left: 50%; top: 38%; transform: translate(-50%, -50%); min-width: 230px; max-width: 85%;
    background: rgba(33,33,33,.94); color: #fff; padding: 16px 20px; border-radius: 14px; text-align: center; font-size: 16px;
    box-shadow: 0 4px 18px rgba(0,0,0,.4); }
  .navpop.warn { background: rgba(230,81,0,.95); } .navpop.ok { background: rgba(11,110,58,.95); }
  .navpop .big { font-size: 30px; margin-bottom: 4px; }
  /* l'aiuto sta al centro dello schermo intero (su telefono la mappa è solo metà pagina) */
  .navpop.help { position: fixed; z-index: 2000; top: 50%; width: min(440px, 92vw); max-width: 92vw; text-align: left; font-size: 14px;
    line-height: 1.4; max-height: 86vh; max-height: 86dvh; overflow-y: auto; background: rgba(33,33,33,.97); }
  .navpop.help .big { text-align: center; }
  .navpop.help h4 { margin: 0 0 6px; font-size: 17px; text-align: center; }
  .navpop.help ol { margin: 8px 0; padding-left: 20px; } .navpop.help li { margin: 3px 0; }
  .navpop.help .acts { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
  .navpop.help .acts a, .navpop.help .acts button { display: block; text-align: center; padding: 9px 10px; border-radius: 8px;
    font: inherit; font-size: 14px; font-weight: 600; text-decoration: none; border: none; cursor: pointer;
    background: #fff; color: #222; }
  .navpop.help .acts .pri { background: var(--primary-color, #03a9f4); color: #fff; }
  .navpop.help .acts .close { background: transparent; color: #fff; border: 1px solid rgba(255,255,255,.5); }
  .navpop.help .note { font-size: 12px; opacity: .8; margin-top: 6px; }
  /* modalità guida: mappa a tutto schermo che ruota con la direzione di marcia */
  .mapwrap { overflow: hidden; }
  .main.guida .side { display: none; }
  /* schermo intero: solo la mappa, sopra la barra laterale e l'intestazione di Home Assistant */
  .nosleep { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .main.guida .mapwrap { flex: 1; height: auto; }
  .main.guida .leaflet-control-container { display: none; }
  .pop3d .maplibregl-popup-content { border-radius: 12px; padding: 12px 14px; box-shadow: 0 3px 14px rgba(0,0,0,.4);
    background: var(--card-background-color, #fff); color: var(--primary-text-color, #222); }
  .pop3d.maplibregl-popup-anchor-bottom .maplibregl-popup-tip { border-top-color: var(--card-background-color, #fff); }
  .pop3d.maplibregl-popup-anchor-top .maplibregl-popup-tip { border-bottom-color: var(--card-background-color, #fff); }
  .pop3d .maplibregl-popup-close-button { display: none; }
  #map.rot { transition: transform .8s ease-out; }
  #map.rot.free { transition: none; }
  .northbtn svg { width: 22px; height: 22px; transition: transform .2s; }
  #map.rot.moving { transition: none; }
  .main.guida #map { touch-action: none; cursor: grab; }
  /* mappa 2D girata a mano: i gesti li gestisce il pannello. Senza questo, spenti i gesti di Leaflet, il browser si prendeva
     trascinamento e zoom con le dita (e la mappa restava ferma) */
  #map.rot.free { touch-action: none; cursor: grab; }
  /* mappa ruotata: i popup girano al contrario intorno alla punta, così restano dritti e la punta resta sul punto toccato */
  #map.rot .leaflet-popup-content-wrapper { transform: rotate(var(--maprot, 0deg)); transform-origin: 50% calc(100% + 19px); }
  #map.rot .leaflet-popup-tip-container { transform: rotate(var(--maprot, 0deg)); transform-origin: 50% 100%; }
  #map.rot .leaflet-popup-close-button { display: none; }
  .main.guida #map.moving { cursor: grabbing; }
  .ctl button.mode { width: auto; height: 42px; padding: 0 12px; font-size: 14px; font-weight: 600; white-space: nowrap; }
  .ctl button.mode.go { background: #0b6e3a; color: #fff; }
  .ctl button.attn { background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); }
  .gattr { position: absolute; z-index: 1000; bottom: 2px; right: 6px; font-size: 10px; color: #333; padding: 0 4px;
    background: rgba(255,255,255,.75); border-radius: 3px; max-width: 70%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .gattr a { color: inherit; }
  @media (max-width: 800px) {
    .main.guida .mapwrap { flex: none; height: calc(100vh - var(--header-height, 56px)); height: calc(100dvh - var(--header-height, 56px)); }
  }
  .nav-car { width: 47px; height: 47px; display: flex; align-items: center; justify-content: center;
    filter: drop-shadow(0 2px 3px rgba(0,0,0,.45)); }
  .nav-car svg { display: block; transition: transform .6s ease-out; }
  .nav-me { width: 22px; height: 22px; border-radius: 50%; background: #1a73e8; border: 3px solid #fff;
    box-shadow: 0 0 0 7px rgba(26,115,232,.25), 0 1px 4px rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; }
  .nav-me span { color: #fff; font: 700 11px sans-serif; display: block; }
  [hidden] { display: none !important; }
  /* tasto impostazioni nella barra in alto e finestra delle impostazioni */
  .tbtn { background: none; border: none; color: inherit; font-size: 22px; width: 44px; height: 44px; padding: 0; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; }
  .tbtn:hover { background: rgba(255,255,255,.15); }
  .setwrap { position: fixed; inset: 0; z-index: 3000; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; }
  .setdlg { width: min(480px, 94vw); max-height: 90vh; max-height: 90dvh; overflow-y: auto; background: var(--card-background-color, #fff);
    color: var(--primary-text-color); border-radius: 14px; box-shadow: 0 8px 30px rgba(0,0,0,.35); }
  .setdlg .hd { display: flex; align-items: center; gap: 8px; padding: 14px 16px; border-bottom: 1px solid var(--divider-color);
    position: sticky; top: 0; background: inherit; z-index: 1; }
  .setdlg .hd h2 { margin: 0; font-size: 19px; font-weight: 500; flex: 1; }
  .setdlg .grp { padding: 12px 16px; border-bottom: 1px solid var(--divider-color); }
  .setdlg .grp:last-child { border-bottom: none; }
  /* a sezioni: elenco a sinistra, opzioni a destra */
  .setdlg.sect { width: min(780px, 96vw); height: 90vh; height: 90dvh; overflow: hidden; display: flex; flex-direction: column; }
  .setdlg .setbody { flex: 1; min-height: 0; display: grid; grid-template-columns: 170px 1fr; }
  .setdlg .setnav { border-right: 1px solid var(--divider-color); overflow-y: auto; padding: 6px 0; }
  .setdlg .setnav button { display: flex; align-items: center; gap: 10px; width: 100%; padding: 12px 14px; border: none; border-radius: 0;
    background: transparent; color: inherit; text-align: left; font-size: 14px; border-left: 3px solid transparent; }
  .setdlg .setnav button .ico { font-size: 20px; }
  .setdlg .setnav button.on { background: rgba(3,169,244,.12); border-left-color: var(--primary-color); font-weight: 600; }
  .setdlg .setcontent { overflow-y: auto; min-width: 0; }
  .setdlg .grp[hidden] { display: none; }
  @media (max-width: 600px) {
    .setdlg .setbody { grid-template-columns: 84px 1fr; }
    .setdlg .setnav button { flex-direction: column; gap: 3px; padding: 10px 4px; text-align: center; font-size: 11px; }
    .setdlg .setnav button .ico { font-size: 22px; }
  }
  .setdlg h3 { margin: 0 0 8px; font-size: 13px; font-weight: 500; text-transform: uppercase; letter-spacing: .04em; color: var(--secondary-text-color); }
  .setdlg .line { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
  .setdlg .line > span:first-child { flex: 1; font-size: 14px; }
  .setdlg select { font: inherit; font-size: 14px; padding: 7px; border-radius: 8px; border: 1px solid var(--divider-color);
    background: var(--secondary-background-color, #f5f5f5); color: var(--primary-text-color); max-width: 60%; }
  .setdlg .note { font-size: 12px; color: var(--secondary-text-color); margin: 4px 0 6px; }
  .garv { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; padding: 6px; border-radius: 10px;
    background: rgba(127,127,127,.08); }
  .garv .gf { flex: 1; min-width: 0; }
  .gprev { width: 46px; height: 60px; flex: none; display: flex; align-items: center; justify-content: center; border-radius: 8px;
    background: #9e9e9e; }
  .gprev svg { max-height: 54px; width: auto; filter: drop-shadow(0 1px 2px rgba(0,0,0,.4)); }
  .garv input[type=color] { width: 38px; height: 32px; padding: 0 2px; border: 1px solid var(--divider-color); border-radius: 6px;
    background: none; flex: none; cursor: pointer; }
  #vehsec h3 { display: flex; align-items: center; gap: 8px; }
  #vehsec h3 .vprev svg { height: 28px; width: auto; display: block; filter: drop-shadow(0 1px 1px rgba(0,0,0,.4)); }
  .sw { position: relative; width: 42px; height: 24px; flex: none; }
  .sw input { opacity: 0; width: 0; height: 0; }
  .sw i { position: absolute; inset: 0; border-radius: 12px; background: #9e9e9e; transition: background .2s; cursor: pointer; }
  .sw i::after { content: ""; position: absolute; width: 18px; height: 18px; left: 3px; top: 3px; border-radius: 50%; background: #fff; transition: left .2s; }
  .sw input:checked + i { background: var(--primary-color); }
  .sw input:checked + i::after { left: 21px; }
  .sw input:disabled + i { opacity: .5; }
  /* velocità e limite nella barra della guida */
  .navbot .spd { font-weight: 600; padding: 2px 8px; border-radius: 10px; background: var(--secondary-background-color, #eee); white-space: nowrap; }
  .navbot .spd.over { background: #c62828; color: #fff; }
  .navbot .cam { font-weight: 600; padding: 2px 8px; border-radius: 10px; background: #263238; color: #fff; white-space: nowrap; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0; }
  .chip { font-size: 13px; padding: 5px 10px; border-radius: 16px; border: 1px solid var(--divider-color); cursor: pointer;
    background: var(--card-background-color, #fff); color: var(--primary-text-color); }
  .chip.on { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
  .tabs { display: flex; gap: 4px; padding: 8px 16px 0; }
  .tabs button { flex: 1; border-radius: 8px 8px 0 0; border-bottom: none; font-size: 14px; }
  .tabs button.on { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
  .plist { list-style: none; margin: 0; padding: 0; }
  .plist li { display: flex; gap: 10px; align-items: center; padding: 9px 16px; border-bottom: 1px solid var(--divider-color); }
  .plist .bd { min-width: 44px; max-width: 70px; text-align: center; font: 700 11px sans-serif; color: #fff; padding: 4px 5px; border-radius: 6px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: none; }
  .plist .tx { flex: 1; min-width: 0; font-size: 14px; } .plist .tx small { display: block; color: var(--secondary-text-color); font-size: 12px; }
  .plist .dd { font-size: 13px; font-weight: 600; white-space: nowrap; text-align: right; }
  .plist .dd small { display: block; font-weight: 400; color: var(--secondary-text-color); font-size: 11px; }
  .plist button { font-size: 12px; padding: 6px 8px; white-space: nowrap; }
  /* distributori: marca, nome e indirizzo in alto, distanza e Tappa a destra, carburanti sotto a tutta larghezza */
  .plist li.fu { flex-wrap: wrap; align-items: flex-start; row-gap: 6px; }
  .plist li.fu .bd { margin-top: 2px; }
  .plist li.fu .nm { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-weight: 600; }
  .plist li.fu .tx small { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .plist li.fu .tx { flex: 1 1 0; }
  .plist li.fu .fs { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex: none; }
  .plist .fl { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 4px; font-size: 12px; }
  .plist .fl .fp { white-space: nowrap; padding: 2px 7px; border-radius: 10px; background: rgba(127,127,127,.15); }
  .plist .fl .fp.hi { background: var(--primary-color); color: var(--text-primary-color, #fff); font-weight: 600; }
  .plist .fl .old { white-space: nowrap; color: #e65100; padding: 2px 0; }
  .plist .fl .muted { color: var(--secondary-text-color); }
  .pmark { width: 26px; height: 26px; border-radius: 50%; border: 2px solid #fff; display: flex; align-items: center; justify-content: center;
    font-size: 14px; box-shadow: 0 1px 4px rgba(0,0,0,.45); }
  .box.traffic { background: rgba(2,136,209,.12); border-left: 3px solid #0288d1; }
  .rwpop .rwinfo { font-size: 13px; margin: 6px 0; display: grid; gap: 2px; }
  .rwpop .rwlinks { font-size: 13px; }
  .alt .elev { font-size: 12px; color: var(--secondary-text-color); margin-top: 4px; }
  .garv .gextra { gap: 6px; align-items: center; margin-top: 6px; font-size: 13px; flex-wrap: wrap; }
  .garv .gextra select { width: auto; }
  /* scelta dell'immagine: tocco diretto sul pulsante (aprire la scelta file da un menu a tendina alcuni telefoni lo bloccano) */
  .garv .gfile { display: inline-flex; align-items: center; padding: 4px 10px; border: 1px solid var(--divider-color, #ccc); border-radius: 8px;
    cursor: pointer; color: var(--primary-color); }
  .garv .gfile input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .garv .gsplash { width: 40px; height: 40px; object-fit: contain; border-radius: 6px; background: #0d1b2a; }
  .rwlist { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; margin-top: 4px; }
  .rwlist .link { text-align: left; }
  .rwm { cursor: pointer; font-size: 20px; line-height: 1; filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); text-align: center; }
  .navbot .lim { width: 30px; height: 30px; border-radius: 50%; border: 4px solid #d32f2f; background: #fff; color: #111;
    display: inline-flex; align-items: center; justify-content: center; font: 700 13px sans-serif; flex: none; box-sizing: border-box; }
  /* schermo intero: solo la mappa, sopra la barra laterale e l'intestazione di Home Assistant.
     Alla fine, così vale anche sul telefono in verticale; niente altezze in vh, che nel WebView a schermo intero sono sbagliate */
  :host(.full) { position: fixed; inset: 0; z-index: 2000; width: auto; height: auto; display: flex; flex-direction: column; overflow: hidden; }
  :host(.full) .toolbar, :host(.full) #verwarn, :host(.full) .main .side { display: none; }
  :host(.full) .main { flex: 1 1 auto; min-height: 0; height: auto; display: flex; }
  :host(.full) .main .mapwrap, :host(.full) .main.guida .mapwrap { flex: 1 1 auto; height: auto; min-height: 0; }
  /* schermo dell'auto: il pannello di sinistra si apre sopra la mappa solo col tasto ☰ (e mai in guida) */
  :host(.full.sideopen) .main { position: relative; }
  :host(.full.sideopen) .main .side { display: block; position: absolute; left: 0; top: 0; bottom: 0; width: 400px; max-width: 70%;
    z-index: 1005; background: var(--card-background-color, #1c1c1c); box-shadow: 4px 0 18px rgba(0,0,0,.5); }
  .ctl .sidebtn { font-size: 22px; }
  .fsico { width: 18px; height: 18px; display: block; margin: auto; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
  /* vista 3D: la mappa MapLibre copre quella di Leaflet, che resta sotto (nascosta) e guida tutto il resto */
  #map3d { position: absolute; inset: 0; z-index: 450; }
  #map3d[hidden] { display: none; }
  #map.under3d { visibility: hidden; }
  #map3d .maplibregl-ctrl-attrib { font-size: 10px; }
  .main.guida #map3d .maplibregl-ctrl-bottom-right { bottom: 96px; }
  button.b3d { font-weight: 700; font-size: 13px; }
  /* inclinazione della vista 3D: dall'alto fino a quasi la telecamera dell'auto */
  /* comando a croce: ▲▼ inclinazione (su/giù) e −/+ zoom (sinistra/destra) attorno ai gradi; in 2D solo −/+ */
  .pitchctl { position: absolute; z-index: 1002; right: 10px; top: 56px; display: grid;
    grid-template-columns: 40px 40px 40px; grid-template-rows: 36px 36px 36px; place-items: center;
    background: rgba(32,33,36,.85); border-radius: 12px; padding: 2px; box-shadow: 0 1px 5px rgba(0,0,0,.35); color: #fff; }
  .pitchctl[hidden] { display: none; }
  .pitchctl { touch-action: none; } /* il gesto di spostamento non deve diventare uno scorrimento (lo interrompeva) */
  .pitchctl .up { grid-area: 1 / 2; } .pitchctl .left { grid-area: 2 / 1; }
  .pitchctl .mid { grid-area: 2 / 2; } .pitchctl .right { grid-area: 2 / 3; }
  .pitchctl .down { grid-area: 3 / 2; }
  /* angoli della croce (3D, in guida): ora attuale in alto (ore | minuti), ora d'arrivo in basso (verde) */
  .pitchctl .clk { color: #fff; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
  .pitchctl .clk:empty { display: none; }
  .pitchctl .clk svg.seg7 { width: 94% !important; height: 86% !important; display: block; stroke: none !important; }
  .pitchctl .clk svg.seg7 * { stroke: none !important; } /* niente contorno delle icone della croce: ingrossava le cifre e chiudeva gli stacchi */
  /* − + e frecce color bordò */
  .pitchctl button[data-z], .pitchctl button[data-p] { color: #9b1b30 !important; }
  /* velocità attuale in cifre LCD, "km/h" piccolo dopo; oltre il limite rossa e lampeggiante */
  .spdbox { position: absolute; z-index: 1002; left: 10px; top: 56px; display: flex; align-items: flex-end; gap: 4px; height: 58px;
    padding: 4px 9px 5px; background: rgba(32,33,36,.85); border-radius: 12px; box-shadow: 0 1px 5px rgba(0,0,0,.35); color: #fff;
    touch-action: none; user-select: none; -webkit-user-select: none; }
  .spdbox[hidden] { display: none; }
  .spdbox .v { height: 100%; }
  .spdbox .v svg { height: 100%; width: auto; display: block; }
  .spdbox .u { font: 700 12px sans-serif; opacity: .85; margin-bottom: 2px; }
  /* connessione: verde se ci sono i dati e Home Assistant risponde, rossa (lampeggiante) se manca */
  .spdbox .spdside { align-self: stretch; display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; margin-left: 4px; }
  .spdbox .net { width: 18px; height: 18px; color: #43d17a; }
  /* fonti del GPS: verdi se mandano posizioni, rosse se no (auto solo con Android Auto collegato) */
  .spdbox .gps { font-size: 9px; line-height: 1; display: flex; align-items: center; gap: 1px; color: #43d17a; white-space: nowrap; }
  .spdbox .gps b { font: 800 8px sans-serif; }
  .spdbox .gps.off { color: #ff5252; }
  .spdbox .gps.idle { color: #9aa0a6; }
  .spdbox .gps[hidden] { display: none; }
  .spdbox.big .gps { font-size: 15px; } .spdbox.big .gps b { font-size: 12px; }
  .spdbox .net svg { width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; }
  .spdbox .net svg circle { fill: currentColor; stroke: none; }
  .spdbox .net.off { color: #ff5252; animation: netblink 1s ease-in-out infinite; }
  @keyframes netblink { 50% { opacity: .35; } }
  .spdbox.big .net { width: 30px; height: 30px; }
  /* senza percorso: cartello col limite della strada attuale */
  .spdbox .lim { align-self: center; width: 34px; height: 34px; border-radius: 50%; border: 4px solid #d32f2f; background: #fff; color: #111;
    display: flex; align-items: center; justify-content: center; font: 800 14px sans-serif; box-sizing: border-box; margin-right: 4px; }
  .spdbox .lim[hidden] { display: none; }
  .spdbox.big .lim { width: 64px; height: 64px; border-width: 7px; font-size: 26px; }
  .spdbox.over { background: #c62828; animation: spdpulse 1.1s ease-in-out infinite; } /* pulsazione morbida */
  @keyframes spdpulse { 0%, 100% { background: #d32f2f; box-shadow: 0 0 0 0 rgba(211,47,47,.55); }
    50% { background: #7a1212; box-shadow: 0 0 14px 4px rgba(211,47,47,.45); } }
  .spdbox.big { height: 110px; padding: 6px 14px 8px; border-radius: 18px; }
  .spdbox.big .u { font-size: 20px; }
  /* tasti all'arrivo: quadrati scuri come il riquadro velocità, icona grande e nome sotto; spostabili */
  .arrsq { position: absolute; z-index: 1006; width: 78px; height: 78px; padding: 4px; border: none; border-radius: 14px;
    background: rgba(32,33,36,.88); color: #fff; box-shadow: 0 1px 6px rgba(0,0,0,.4); display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 2px; touch-action: none; user-select: none; -webkit-user-select: none; cursor: pointer; }
  .arrsq .i { font-size: 30px; line-height: 1; display: flex; }
  .arrsq .i svg { width: 36px; height: 36px; }
  .arrsq.big .i svg { width: 60px; height: 60px; }
  .arrrow { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
  .arrrow .arrico { width: 28px; height: 28px; flex: none; color: var(--primary-text-color); }
  .arrrow .arrico svg { width: 100%; height: 100%; }
  .arrrow .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .arrrow select { width: auto; }
  .arrsq .n { font: 600 11px sans-serif; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* acceso: come se dietro ci fosse una lampadina accesa sotto un vetro smerigliato (luce calda al centro, grana del vetro) */
  .arrsq.on { color: #3a2500; box-shadow: 0 0 18px 2px rgba(255,190,80,.55), 0 1px 6px rgba(0,0,0,.4);
    background:
      url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 .38 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>"),
      radial-gradient(circle at 50% 40%, #fff6d8 0, #ffd77a 22%, #f5a83a 48%, #8a5a1c 78%, #3c2a12 100%); }
  .arrsq.on .n { color: #2b1b00; text-shadow: 0 1px 0 rgba(255,240,200,.6); }
  .arrsq.big { width: 128px; height: 128px; border-radius: 20px; } .arrsq.big .i { font-size: 52px; } .arrsq.big .n { font-size: 17px; }
  .arrask { position: absolute; z-index: 1020; left: 50%; top: 40%; transform: translate(-50%, -50%); background: var(--card-background-color, #fff);
    color: var(--primary-text-color, #212121); border-radius: 14px; padding: 14px; box-shadow: 0 6px 24px rgba(0,0,0,.45); min-width: 240px; text-align: center; }
  .arrask .acts { display: flex; gap: 8px; margin-top: 12px; justify-content: center; }
  .arrask button { padding: 10px 14px; font-size: 15px; border-radius: 10px; }
  .arrask .go { background: #0b6e3a; color: #fff; border-color: #0b6e3a; }
  /* riquadri spostati a mano (guida): posizione salvata */
  .pitchctl.moved, .spdbox.moved { right: auto; }
  .arrsq.dragging-src { opacity: 0 !important; }
  /* durante lo spostamento: solo una sagoma semitrasparente (leggera), il riquadro vero è nascosto */
  .dragghost { position: absolute; z-index: 1010; pointer-events: none; border-radius: 12px; will-change: transform;
    background: rgba(255,255,255,.22); border: 2px dashed rgba(255,255,255,.85); box-shadow: 0 6px 20px rgba(0,0,0,.35); }
  .dragging-src { opacity: 0 !important; }
  .pitchctl.dragging, .spdbox.dragging { opacity: .9; box-shadow: 0 6px 20px rgba(0,0,0,.5); }
  .pitchctl .tl { grid-area: 1 / 1; } .pitchctl .tr { grid-area: 1 / 3; }
  .pitchctl .bl { grid-area: 3 / 1; color: #7ee08a; } .pitchctl .br { grid-area: 3 / 3; color: #7ee08a; }
  .pitchctl button { width: 40px; height: 36px; padding: 0; border: none; background: transparent; color: #fff; font: 700 22px sans-serif; }
  .pitchctl button:disabled { opacity: .35; }
  .pitchctl svg { width: 22px; height: 22px; display: block; margin: auto; fill: none; stroke: currentColor; stroke-width: 2.6;
    stroke-linecap: round; stroke-linejoin: round; }
  .pitchctl .mid svg { width: 24px; height: 24px; stroke-width: 1.8; }
  .pitchctl .mid.day svg { fill: #ffd54f; stroke: #ffd54f; }
  .pitchctl .mid.day svg .base { fill: none; stroke: #fff; }
  .pitchctl .mid.night svg { stroke: #9aa0a6; }
  /* mappa piatta (2D): niente inclinazione, − lampadina + in fila */
  /* 2D: la stessa croce del 3D con l'orologio negli angoli, senza le frecce dell'inclinazione (anche fuori dalla guida) */
  .pitchctl.twod .up, .pitchctl.twod .down { visibility: hidden; }
  /* fuori dalla guida: in alto a sinistra, al posto dello zoom di Leaflet */
  .pitchctl.plan { right: auto; left: 10px; top: 10px; }
  /* galleria: animazione stilizzata di un tunnel che si percorre (archi che vengono incontro, luci, strada) */
  /* colore di fondo pieno (mai trasparente) e livello unico per la scheda grafica: sul WebView un velo grande e animato
     a volte non veniva disegnato tutto in tempo e lasciava vedere a tratti la mappa sotto */
  .tunfx { position: absolute; inset: 0; z-index: 1500; pointer-events: none; overflow: hidden; opacity: 0; transition: opacity .3s;
    background: #060606 radial-gradient(ellipse at 50% 45%, #4a3f2e 0%, #1d1913 40%, #060606 100%); --tfd: 2.4s;
    will-change: opacity; transform: translateZ(0); contain: strict; }
  /* durante la galleria la mappa sotto non si disegna (meno lavoro per il telefono, niente pezzi di mappa che compaiono) */
  .mapwrap.tunon #map, .mapwrap.tunon #map3d { visibility: hidden; }
  .tunfx.on { opacity: 1; }
  .tunfx[hidden] { display: none; }
  /* strada e archi disegnati in un solo canvas: con tanti livelli grandi animati in CSS il WebView di Android
     a tratti non ne disegnava dei pezzi (blocchi di strada e di volta che sparivano e ricomparivano) */
  .pl3cv { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 3; } /* nomi dei paesi in 3D */
  /* finestre degli add-on sulla mappa (spostabili tenendo premuto, come gli altri riquadri) */
  .addwin { position: absolute; z-index: 1002; right: 70px; top: 120px; background: rgba(24,24,24,.88); border-radius: 12px;
    padding: 4px; box-shadow: 0 2px 10px rgba(0,0,0,.45); touch-action: none; user-select: none; -webkit-user-select: none; cursor: pointer; }
  .addwin.moved { right: auto; } /* spostata: solo left/top (prima con right restava tirata per tutta la larghezza) */
  /* blocco della guida: barra verde in alto, sotto gli add-on (scorrono) con la croce a fianco */
  .navtop.docked { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
  .navbot.docked { }

  .addock { position: absolute; z-index: 1001; display: flex; gap: 8px; align-items: flex-start; padding: 8px;
    background: rgba(24,24,24,.92); border-radius: 0 0 14px 14px; box-sizing: border-box; box-shadow: 0 4px 12px rgba(0,0,0,.35); }
  /* in orizzontale: attaccato sopra la barra in basso, a sinistra */
  .addock.bot { border-radius: 14px; box-shadow: 0 2px 12px rgba(0,0,0,.4); align-items: center; padding: 4px; z-index: 1002; }
  .addock.bot .alist { flex: none; }
  .addock.bot { overflow: hidden; }
  .addock.bot .addwin img { max-width: none; }
  .addock.bot .aimg { display: flex; justify-content: center; } /* immagine rimpicciolita al centro della cornice */
  .addock .addwin.botmode { padding: 0; background: none; }
  .addwin.botmode .at, .addwin.botmode .abtns { display: none; }
  .addwin.botmode .aimg img { border-radius: 10px; }
  .addwin .acap { position: absolute; left: 0; right: 0; top: 0; padding: 4px 8px; color: #fff; font: 600 12px sans-serif;
    background: linear-gradient(rgba(0,0,0,.7), transparent); border-radius: 8px 8px 0 0; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; pointer-events: none; }
  .addwin .abar { position: absolute; left: 50%; bottom: 6px; transform: translateX(-50%); display: flex; gap: 6px; }
  .addwin .abar button { border: none; border-radius: 10px; background: rgba(0,0,0,.6); color: #fff; font-size: 18px;
    min-width: 40px; height: 36px; padding: 0 8px; cursor: pointer; }
  .addwin .alp { position: absolute; inset: 0; background: rgba(18,18,18,.96); border-radius: 8px; display: flex;
    flex-direction: column; z-index: 2; }
  .addwin .alh { display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; color: #fff; font: 600 13px sans-serif; }
  .addwin .alh button { border: none; background: rgba(255,255,255,.14); color: #fff; border-radius: 8px; width: 32px; height: 28px; cursor: pointer; }
  .addwin .all { flex: 1; overflow-y: auto; padding: 0 6px 6px; color: #ccc; font: 12px sans-serif; touch-action: pan-y;
    -webkit-overflow-scrolling: touch; }
  .addwin .all button { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; border: none;
    background: rgba(255,255,255,.07); color: #fff; border-radius: 8px; padding: 6px; margin-bottom: 4px; font: 13px sans-serif; cursor: pointer; }
  .addwin .all img { width: 32px; height: 32px; border-radius: 4px; object-fit: cover; flex: none; position: static; }
  .addwin .all i { width: 32px; text-align: center; font-style: normal; flex: none; }
  .addwin .aov button { position: absolute; border: none; border-radius: 8px; background: rgba(0,0,0,.55); color: #fff;
    font: 600 13px sans-serif; padding: 4px 8px; cursor: pointer; line-height: 1.2; }
  .addwin .aov .fmt { left: 4px; top: 4px; font-size: 15px; }
  .addwin .aov .fmt small { font-size: 11px; opacity: .85; }
  .addwin .aov .up { right: 4px; top: 4px; }
  .addwin .aov .dn { right: 4px; bottom: 4px; }
  .addwin .aov .cnt { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); color: #fff; font: 600 11px sans-serif;
    background: rgba(0,0,0,.55); border-radius: 6px; padding: 2px 5px; }
  .addwin .dkover button { position: absolute; left: 50%; transform: translateX(-50%); border: none; border-radius: 8px;
    background: rgba(0,0,0,.55); color: #fff; font: 600 14px sans-serif; padding: 3px 14px; cursor: pointer; pointer-events: auto; }
  .addwin .dkover .up { top: 4px; }
  .addwin .dkover .dn { bottom: 4px; }
  .addwin .dkover small { font-size: 11px; opacity: .8; }
  .addock .alist { flex: 1; min-width: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px;
    -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
  .addock .addwin { position: static; right: auto; left: auto; top: auto; box-shadow: none; background: rgba(255,255,255,.06);
    touch-action: none; } /* la strisciata su/giù passa all'add-on successivo */
  .addock .addwin img { max-width: 100%; height: auto !important; }
  .addock .across { flex: none; display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .addock .dknav { display: flex; align-items: center; gap: 8px; color: #ddd; font: 600 12px sans-serif; }
  .addock .dknav button { border: none; border-radius: 8px; background: rgba(255,255,255,.14); color: #fff; font-size: 16px;
    width: 40px; height: 34px; cursor: pointer; }
  .addock .pitchctl { position: static !important; left: auto !important; top: auto !important; right: auto !important; }
  .addwin .at { color: #fff; font: 600 12px sans-serif; padding: 2px 6px 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .addwin img { display: block; border-radius: 8px; object-fit: cover; background: #333; pointer-events: none; }
  .addwin .aimg { position: relative; }
  .addwin .ame { position: absolute; left: 50%; top: 50%; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%;
    background: #e53935; border: 2px solid #fff; box-shadow: 0 0 0 2px rgba(229,57,53,.35); pointer-events: none; }
  .addwin .abtns { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 2px 0; }
  .addwin .abtns button { flex: 1 0 auto; border: none; border-radius: 6px; padding: 5px 7px; font: 600 11px sans-serif;
    background: rgba(255,255,255,.12); color: #ddd; cursor: pointer; }
  .addwin .abtns button.on { background: #1a73e8; color: #fff; }
  .addwin .aerr { display: flex; align-items: center; justify-content: center; color: #bbb; font: 12px sans-serif; text-align: center; }
  .addrow { display: flex; align-items: flex-start; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--divider-color, #333); }
  .addrow .ai { flex: 1; min-width: 0; }
  .addrow button { padding: 4px 10px; }
  .addmenu { position: absolute; z-index: 1008; width: 220px; background: rgba(24,24,24,.95); border-radius: 12px; padding: 6px;
    box-shadow: 0 4px 16px rgba(0,0,0,.5); display: flex; flex-direction: column; gap: 4px; }
  .addmenu .mt { color: #ddd; font: 600 12px sans-serif; padding: 4px 6px; }
  .addmenu button { text-align: left; background: rgba(255,255,255,.08); color: #fff; border: none; border-radius: 8px;
    padding: 10px; font: 14px sans-serif; cursor: pointer; }
  .addmenu small { opacity: .6; }
  .addinfo { margin-top: 12px; }
  .addinfo summary { cursor: pointer; font-weight: 600; }
  .addinfo ol { margin: 6px 0; padding-left: 20px; }
  .addinfo pre { background: rgba(127,127,127,.15); border-radius: 8px; padding: 8px; font-size: 11px; overflow-x: auto; white-space: pre; }
  .addinfo code { background: rgba(127,127,127,.15); border-radius: 4px; padding: 0 3px; font-size: 11px; }
  .addfile { display: inline-flex; align-items: center; padding: 6px 12px; border: 1px solid var(--divider-color, #ccc); border-radius: 8px;
    cursor: pointer; position: relative; margin-top: 8px; }
  .addfile input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .tf-cv { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .tf-label { position: absolute; left: 50%; top: 64%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center;
    gap: 2px; background: rgba(0, 0, 0, .6); color: #fff; padding: 8px 18px; border-radius: 18px; font: 600 16px sans-serif; white-space: nowrap; }
  .tf-label small { font-weight: 400; font-size: 13px; opacity: .85; }
  /* "visitatori" della galleria: arrivano dal fondo del tunnel verso di noi (pipistrelli, e a Natale/Halloween sorprese) */
  .tf-vis { position: absolute; inset: 0; }
  .tf-v { position: absolute; left: 50%; top: 45%; width: 12vmin; height: 12vmin; margin: -6vmin 0 0 -6vmin; opacity: 0;
    transform: scale(0); will-change: transform, opacity; }
  .tf-v svg { width: 100%; height: 100%; display: block; overflow: visible; }
  .tf-bat { width: 10vmin; height: 5vmin; margin: -2.5vmin 0 0 -5vmin; }
  .tf-bat svg { transform-origin: 50% 45%; animation: tf-flap .19s ease-in-out infinite alternate; }
  .tf-santa { width: 17vmin; height: 13vmin; margin: -6.5vmin 0 0 -8.5vmin; }
  .tf-santa svg { animation: tf-bob .45s ease-in-out infinite alternate; filter: drop-shadow(0 0 3px rgba(255,220,150,.5)); }
  .tf-pump svg { animation: tf-bob .32s ease-in-out infinite alternate; filter: drop-shadow(0 0 5px #ffb300); }
  .tf-ghost svg { animation: tf-sway .9s ease-in-out infinite alternate; filter: drop-shadow(0 0 6px rgba(220,235,255,.6)); }
  @keyframes tf-flap { from { transform: scaleY(1); } to { transform: scaleY(.35); } }
  @keyframes tf-bob { from { transform: translateY(0); } to { transform: translateY(-9%); } }
  @keyframes tf-sway { from { transform: translateX(-9%) rotate(-7deg); } to { transform: translateX(9%) rotate(7deg); } }
  /* frecce del verso di marcia sul percorso (2D) */
  .rarrow { width: 16px; height: 16px; background: no-repeat center / 16px 16px
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3 11 8 5l5 6' fill='none' stroke='%23263238' stroke-width='4.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M3 11 8 5l5 6' fill='none' stroke='%23fff' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); }
  /* rotonda con il numero dell'uscita */
  .rbx { width: 1.15em; height: 1.15em; vertical-align: middle; color: inherit; }
  /* corsie sotto l'indicazione: chiare quelle da tenere */
  .lanes { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
  .lanes .ln { width: 30px; height: 34px; border-radius: 5px; background: rgba(0,0,0,.25); display: flex; align-items: center; justify-content: center; }
  .lanes .ln svg { width: 24px; height: 24px; fill: none; stroke: rgba(255,255,255,.35); stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round; }
  .lanes .ln.on { background: rgba(255,255,255,.18); box-shadow: inset 0 0 0 2px #fff; }
  .lanes .ln.on svg { stroke: #fff; }
  /* punti di interesse: icona colorata in 2D, icona che fluttua sopra l'edificio in 3D */
  .poim { width: 26px; height: 26px; border-radius: 50%; border: 2px solid #fff; display: flex; align-items: center; justify-content: center;
    font-size: 14px; box-shadow: 0 1px 4px rgba(0,0,0,.45); }
  /* l'animazione sta nell'elemento interno: su quello esterno MapLibre usa transform per posizionare l'icona */
  .poi3d { cursor: pointer; }
  .poi3d .pi { display: flex; flex-direction: column; align-items: center; animation: poi-float 2.6s ease-in-out infinite; }
  .poi3d .pb { width: 32px; height: 32px; border-radius: 50%; border: 2px solid #fff; display: flex; align-items: center; justify-content: center;
    font-size: 17px; box-shadow: 0 2px 6px rgba(0,0,0,.5); }
  .poi3d .ps { width: 2px; height: 30px; background: linear-gradient(rgba(255,255,255,.95), rgba(255,255,255,0)); }
  @keyframes poi-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
  @media (prefers-reduced-motion: reduce) { .poi3d .pi { animation: none; } }
  /* pulsanti all'arrivo, in cima alla barra della guida */
  .navbot .arr { flex-basis: 100%; display: flex; gap: 8px; flex-wrap: wrap; }
  .navbot .arr[hidden] { display: none; }
  .navbot .arr button { flex: 1 1 140px; height: 48px; font-size: 16px; font-weight: 600; background: #0b6e3a; color: #fff; border-color: #0b6e3a; }
  /* meteo lungo il percorso */
  .wxm { width: 26px; height: 26px; filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); }
  .wx3d .wxm { width: 34px; height: 34px; }
  .wxm .wxs { width: 100%; height: 100%; display: block; }
  .wxi { display: inline-block; width: 18px; height: 18px; vertical-align: -3px; }
  .wxi .wxs { width: 100%; height: 100%; display: block; }
  .clouds3d { position: absolute; left: 0; top: 0; pointer-events: none; }
  #map3d.g3busy .poi3d { display: none; } /* punti di interesse nascosti durante un gesto con le dita */
  .wxlist { margin: 4px 0 0; padding: 0; list-style: none; font-size: 13px; }
  .wxlist li { padding: 3px 0; }
  /* diario dei viaggi */
  .plate3d { display: flex; align-items: stretch; height: 1.5em; background: #fbfbf8; border: 1px solid #333; border-radius: 2px;
    box-shadow: 0 1px 2px rgba(0,0,0,.5); overflow: hidden; pointer-events: none; font-family: "Arial Narrow", Arial, sans-serif; }
  .plate3d .eu { width: 0.9em; background: #1f3fa8; color: #fff; font-size: 0.55em; display: flex; align-items: flex-end; justify-content: center;
    padding-bottom: 0.1em; flex: none; }
  .plate3d b { flex: 1; text-align: center; color: #111; letter-spacing: 0.04em; line-height: 1.5em; white-space: nowrap; overflow: hidden; }
  .livecar { display: flex; flex-direction: column; align-items: center; width: 60px; }
  .livecar .lc { width: 40px; height: 44px; display: flex; align-items: center; justify-content: center; }
  .livecar .lc svg { max-height: 40px; width: auto; filter: drop-shadow(0 1px 3px rgba(0,0,0,.55)); }
  .livecar .ln { color: #fff; font: 600 11px sans-serif; padding: 1px 6px; border-radius: 8px; white-space: nowrap; margin-top: -2px;
    box-shadow: 0 1px 3px rgba(0,0,0,.4); max-width: 90px; overflow: hidden; text-overflow: ellipsis; }
  .livedest { width: 22px; height: 22px; border-radius: 50%; background: #fff; border: 3px solid; display: flex; align-items: center;
    justify-content: center; font-size: 11px; box-shadow: 0 1px 3px rgba(0,0,0,.4); }
  .trip.live .nm div { font-size: 13px; }
  .trip { display: flex; gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--divider-color); font-size: 13px; }
  .trip .nm { flex: 1; min-width: 0; cursor: pointer; } .trip .nm small { display: block; color: var(--secondary-text-color); }
  /* notte: satellite ed escursionistica più scuri */
  #map.night .leaflet-tile-pane { filter: brightness(.6) contrast(1.1) saturate(.8); }
  /* deserto (2D): foto del satellite color sabbia */
  /* come in 3D: prima bianco e nero (niente più verde), poi tutto color sabbia; contrasto basso e ombre schiarite,
     così boschi e alberi scuri diventano roccia/sassi invece che macchie quasi nere */
  #map.desert .leaflet-tile-pane { filter: grayscale(1) contrast(.75) brightness(1.2) sepia(1) saturate(1.35) hue-rotate(-12deg); }
  #map.desert.night .leaflet-tile-pane { filter: grayscale(1) contrast(.8) brightness(.75) sepia(1) saturate(1.3) hue-rotate(-12deg); }
  /* schede del pannello laterale: Viaggio e Archivio */
  .sidetabs.solo { display: none; } /* app NaviHA: solo Viaggio, niente barra delle schede */
  .sidetabs { display: flex; gap: 0; position: sticky; top: 0; z-index: 5; background: var(--card-background-color, var(--primary-background-color));
    border-bottom: 1px solid var(--divider-color); }
  .sidetabs button { flex: 1; border: none; border-radius: 0; background: transparent; padding: 12px 8px; font-size: 15px; font-weight: 600;
    color: var(--secondary-text-color); border-bottom: 3px solid transparent; }
  .sidetabs button.on { color: var(--primary-color); border-bottom-color: var(--primary-color); }
  .trip input[type=checkbox] { width: 18px; height: 18px; flex: none; accent-color: var(--tc, var(--primary-color)); }
  .trip .sw { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .tyear, .month { display: flex; justify-content: space-between; align-items: baseline; cursor: pointer; user-select: none; }
  .tyear { margin: 14px 0 4px; padding: 6px 2px; font-size: 16px; border-bottom: 1px solid var(--divider-color, #ddd); }
  .month { margin: 8px 0 2px 10px; font-size: 13px; }
  .tyear span, .month span { font-weight: 400; font-size: 12px; color: var(--secondary-text-color); }
  .tyear .car, .month .car { display: inline-block; transition: transform .15s; color: var(--secondary-text-color); }
  .tyear.open .car, .month.open .car { transform: rotate(90deg); }
  /* stato dei punti di interesse, in basso a sinistra sulla mappa */
  .poistat { position: absolute; z-index: 1000; left: 10px; bottom: 26px; max-width: calc(100% - 80px); display: flex; gap: 8px; align-items: center;
    white-space: nowrap;
    background: rgba(32,33,36,.88); color: #fff; font-size: 13px; padding: 6px 12px; border-radius: 16px; box-shadow: 0 1px 4px rgba(0,0,0,.4); }
  .poistat[hidden] { display: none; }
  .poistat span { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .poistat button { font-size: 12px; padding: 2px 10px; height: auto; background: #fff; color: #222; border: none; flex: none; }
  .main.guida .poistat { bottom: auto; top: 50%; }
`;

class NavigatorPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._points = [null, null];
    this._mode = "auto";
    this._avoid = { tolls: false, highways: false, ferries: false };
    this._excluded = []; // [{name, length_km, points:[{lat,lon}]}]
    this._blocked = []; // chiusure/lavori sul percorso da evitare (punti {lat,lon})
    this._roadworks = []; // lavori e chiusure vicino al percorso (per i marcatori)
    this._result = null;
    this._sel = 0;
    this._place = null; // luogo selezionato dalla ricerca o dalla mappa
    this._info = null;
    this._reqId = 0;
    this._loadState();
    this._settings = { ...DEFAULT_SETTINGS };
    try { Object.assign(this._settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")); } catch (e) { /* storage non disponibile */ }
    if (this._settings.autoZoom3d == null) this._settings.autoZoom3d = this._settings.autoZoom !== false; // prima c'era un solo interruttore
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (this._menuBtn) this._menuBtn.hass = hass;
    if (this._nav && this._nav.source !== "gps") this._entityFix();
    if (this._addons?.length) this._addonHass();
    const sun = hass.states?.["sun.sun"]?.state;
    if (sun !== this._sunState) { this._sunState = sun; if (this._map) this._applyNight(); }
    // tasti all'arrivo visibili (prova o dopo il Ferma automatico): mostrano lo stato vero delle entità
    if (this.$ && this.$("arrbox")?.childElementCount) this._arrivalButtons(); // (prima che il pannello sia pronto this.$ non c'è)
    // punto blu legato a una persona o a un dispositivo: segue le sue posizioni nuove
    const ms = this._me?.src && this._me.src !== "gps" ? hass.states?.[this._me.src] : null;
    if (ms && ms.last_updated !== this._me.upd && ms.attributes.latitude != null && this._markerLayer) {
      this._meTurn(ms.attributes.latitude, ms.attributes.longitude);
      this._me = { lat: ms.attributes.latitude, lon: ms.attributes.longitude, src: this._me.src, upd: ms.last_updated };
      this._drawMarkers();
      this._autoDestCheck(this._me);
    }
    // Home Assistant passa hass prima di inserire il pannello nella pagina: la mappa va creata solo quando è visibile
    if (first && this.isConnected) this._init();
  }

  connectedCallback() {
    if (this._hass && !this._started) this._init();
    else if (this._map) {
      this._ro?.observe(this.$("mapwrap"));
      setTimeout(() => this._map.invalidateSize(), 50);
    }
  }

  set narrow(v) {
    this._narrow = v;
    if (this._menuBtn) this._menuBtn.narrow = v;
  }

  set panel(p) { this._panel = p; }

  disconnectedCallback() {
    this._ro?.disconnect();
  }

  // ----------------------------------------------------------------- stato salvato nel browser

  _loadState() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
      if (Array.isArray(s.points) && s.points.length >= 2) this._points = s.points;
      if (s.mode) this._mode = s.mode;
      if (s.avoid) this._avoid = { ...this._avoid, ...s.avoid };
      if (Array.isArray(s.excluded)) this._excluded = s.excluded;
      this._layer = s.layer;
    } catch (e) { /* storage non disponibile */ }
  }

  _saveState() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        points: this._points, mode: this._mode, avoid: this._avoid, excluded: this._excluded, layer: this._layer,
      }));
    } catch (e) { /* storage non disponibile */ }
  }

  // ----------------------------------------------------------------- costruzione

  async _init() {
    if (this._started) return;
    this._started = true;
    const root = this.shadowRoot;
    root.innerHTML = `
      <link rel="stylesheet" href="${LEAFLET_CSS}">
      <style>${STYLE}</style>
      <div class="toolbar"><ha-menu-button></ha-menu-button>
        <div class="title"><span class="brand" id="brand"><img src="${ICON}" alt=""> Navigator</span><span class="ver" id="verlbl">versione ${PANEL_VERSION}</span></div>
        <button class="tbtn" id="settingsbtn" title="Impostazioni">⚙</button></div>
      <div class="setwrap" id="setwrap" hidden></div>
      <div class="setwrap" id="nearwrap" hidden></div>
      <div id="verwarn"></div>
      <div class="main" id="mainbox">
        <div class="side">
          <div class="sidetabs" id="sidetabs">
            <button data-tab="viaggio" class="on">🧭 Viaggio</button><button data-tab="live">📡 Live</button><button data-tab="archivio">🗂️ Archivio</button></div>
          <div id="tabViaggio">
          <h3 class="cbh open planh" id="planh" hidden title="Tocca per riaprire ricerca, veicolo e itinerario"><span class="cbcar">▸</span><span class="plansum" id="plansum">Ricerca e itinerario</span><span class="planedit">Modifica</span></h3>
          <div class="cbbody" id="planbody">
          <div class="sec">
            <h3>Cerca un luogo</h3>
            <div class="field search"><input type="text" id="q" placeholder="Indirizzo, città, attività…" autocomplete="off"></div>
            <div id="placecard"></div>
          </div>
          <div class="sec" id="vehsec"></div>
          <div class="sec">
            <h3>Itinerario <span><button class="link" id="swap" title="Inverti partenza e arrivo">⇅ Inverti</button>
              <button class="link" id="clear" title="Svuota l'itinerario">✕ Svuota</button></span></h3>
            <div class="pts" id="pts"></div>
            <button class="link" id="addstop">＋ Aggiungi tappa</button>
            <div class="modes" id="modes"></div>
            <div>
              <label class="chk"><input type="checkbox" id="av_tolls"> Evita pedaggi</label>
              <label class="chk"><input type="checkbox" id="av_highways"> Evita autostrade</label>
              <label class="chk"><input type="checkbox" id="av_ferries"> Evita traghetti</label>
            </div>
            <div id="srcbox" style="margin-top:10px"></div>
            <div class="row" style="margin-top:10px"><button class="primary" id="go" style="flex:1">Calcola percorso</button></div>
          </div>
          </div>
          <div id="results"></div>
          <div class="sec" id="favsec"></div>
          <div class="sec muted" style="font-size:12px">Percorsi: Valhalla (FOSSGIS) · OSRM — Ricerca: Photon (komoot) · Nominatim — Mappe Esri e OpenTopoMap, dati © OpenStreetMap e collaboratori.
            Servizi gratuiti con limiti d'uso: le richieste passano da Home Assistant.
            <div class="footver"><img src="${ICON}" alt=""> Navigator versione ${PANEL_VERSION} ·
              <a href="https://github.com/LabirintoDigitale/ha-navigator" target="_blank" rel="noopener">LabirintoDigitale/ha-navigator</a></div></div>
          </div>
          <div id="tabLive" hidden><div class="sec" id="livesec"></div></div>
          <div id="tabArchivio" hidden><div class="sec" id="tripsec"></div></div>
        </div>
        <div class="mapwrap" id="mapwrap">
          <div id="map"></div>
          <div id="map3d" hidden></div>
          <div class="poistat" id="poistat" hidden></div>
          <div class="tunfx" id="tunfx" hidden><canvas class="tf-cv" id="tfcv"></canvas>
            <div class="tf-vis" id="tfvis"></div>
            <div class="tf-label"><span>🚇 In galleria</span><small id="tunrem"></small></div></div>
          <div id="arrbox"></div>
          <div class="spdbox" id="spdbox" hidden title="Velocità (tieni premuto per spostarlo)"><span class="lim" id="spdlim" hidden></span><div class="v" id="spdv"></div><span class="u">km/h</span><span class="spdside"><span class="net" id="spdnet" title="Connessione dati e Home Assistant"><svg viewBox="0 0 24 24"><path d="M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0"/><circle cx="12" cy="19.5" r="1.6"/></svg></span>
            <span class="gps" id="gpscar" hidden title="GPS dell'auto (Android Auto)">🚗<b>GPS</b></span><span class="gps" id="gpsphone" title="GPS del telefono">📱<b>GPS</b></span></span></div>
          <div class="pitchctl" id="pitchctl" hidden>
            <button class="up" data-p="-15" title="Più dall'alto"><svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg></button>
            <button class="left" data-z="-1" title="Riduci">−</button>
            <button class="mid" id="nightbtn" title="Giorno / notte"></button>
            <button class="right" data-z="1" title="Ingrandisci">+</button>
            <button class="down" data-p="15" title="Più bassa, come dall'auto"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
            <span class="clk tl" id="clkh" title="Ora attuale"></span><span class="clk tr" id="clkm"></span>
            <span class="clk bl" id="arrh" title="Arrivo"></span><span class="clk br" id="arrm"></span>
          </div>
          <div class="ctl tr" id="ctltr"><select id="layer" hidden></select>
            <button id="layerbox" class="layerbox" title="Cambia tipo di mappa"><svg viewBox="0 0 24 24"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12.5l9 5 9-5"/><path d="M3 16.5l9 5 9-5"/></svg></button></div>
          <div class="navtop" id="navtop" hidden></div>
          <div class="navbot" id="navbot" hidden></div>
          <div class="navpop" id="navpop" hidden></div>
          <div class="adpop" id="adpop" hidden></div>
          <div class="adpop big" id="vehpop" hidden></div>
          <div class="gattr" id="gattr" hidden></div>
          <div class="ctl br">
            <button id="sidebtn" class="sidebtn" title="Ricerca, itinerario e impostazioni del percorso" hidden>☰</button>
            <button id="modebtn" class="mode go" hidden>▶ Parti</button>
            <button id="northbtn" class="northbtn" title="Nord in alto" hidden><svg viewBox="0 0 24 24"><path d="M12 2l4 10h-8z" fill="#e53935"/><path d="M12 22l-4-10h8z" fill="#9e9e9e"/></svg></button>
            <button id="locate" title="La mia posizione">◎</button>
            <button id="fit" title="Mostra tutto il percorso">⤢</button>
            <button id="b3dbtn" class="b3d" title="Vista 3D con rilievo ed edifici">3D</button>
            <button id="fullbtn" title="Schermo intero">${FS_ON}</button>
          </div>
        </div>
      </div>`;
    const $ = (id) => root.getElementById(id);
    this.$ = $;
    // "tic" dolce alla pressione dei pulsanti (anche sullo schermo dell'auto); la mappa e i campi di testo no
    root.addEventListener("click", (e) => {
      if (this._settings.clickSnd === false) return;
      const t = e.target.closest?.('button, [role="button"], select, a, input[type="checkbox"], input[type="radio"], .arrsq');
      if (t && !t.disabled) this._tick();
    }, true);
    this._menuBtn = root.querySelector("ha-menu-button");
    this._menuBtn.hass = this._hass;
    this._menuBtn.narrow = this._narrow;

    // mappa
    const home = [this._hass.config.latitude, this._hass.config.longitude];
    this._map = L.map($("map"), { zoomControl: false, attributionControl: true }).setView(home, 12);
    const dark = this._hass.themes?.darkMode;
    if (!this._layer || !LAYERS[this._layer]) this._layer = dark ? "scura" : "strade";
    for (const [k, v] of Object.entries(LAYERS)) $("layer").insertAdjacentHTML("beforeend", `<option value="${k}">${v[0]}</option>`);
    $("layer").value = this._layer;
    $("layer").addEventListener("change", (e) => { this._setLayer(e.target.value); this._saveState(); });
    this._setLayer(this._layer);
    this._placePitchCtl();
    window.__navihaCar = () => this._carAutoSelect(); // NaviHA: auto riconosciuta adesso
    this._navClock(null); // ora attuale nella croce anche senza guida
    this._carSide(false); // auto: tasto ☰ per il pannello di sinistra
    setTimeout(() => this._idleWatchSync(), 3000); // "Dove vai?": GPS anche senza guida (sul telefono)
    this._routeLayer = L.layerGroup().addTo(this._map);
    this._markerLayer = L.layerGroup().addTo(this._map);
    this._poiLayer = L.layerGroup().addTo(this._map);
    this._arrowLayer = L.layerGroup().addTo(this._map); // frecce del verso di marcia (solo 2D: in 3D le disegna MapLibre)
    this._map.on("moveend zoomend", () => this._scheduleArrows());
    this._poiMapLayer = L.layerGroup().addTo(this._map); // punti di interesse scelti in ⚙ (in 3D li disegna MapLibre)
    this._wxLayer = L.layerGroup().addTo(this._map);     // meteo lungo il percorso
    this._tripLayer = L.layerGroup().addTo(this._map);   // traccia di un viaggio del diario
    this._liveLayer = L.layerGroup().addTo(this._map);   // guide in corso degli utenti (scheda Live)
    this._rwLayer = L.layerGroup().addTo(this._map);     // lavori e strade chiuse sul percorso
    this._applyNight();
    this._loadTrips();
    this._loadGarage();
    this._loadAddons();
    this._renderPlanSel();
    // nell'app NaviHA restano solo Viaggio: Live e Archivio sono nascosti
    if (this._isNaviHA()) {
      for (const t of ["live", "archivio"]) $("sidetabs").querySelector(`[data-tab="${t}"]`)?.remove();
      $("sidetabs").classList.add("solo");
    }
    $("sidetabs").querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => this._showTab(b.dataset.tab)));
    this._poiTiles = new Map();
    this._map.on("moveend zoomend", () => this._schedulePois());
    setTimeout(() => this._schedulePois(), 1500); // anche all'apertura, senza aspettare che la mappa si muova
    // tocco breve: il punto di interesse sotto il dito; tocco prolungato (o tasto destro): Parti da qui / Tappa / Arriva qui / ★
    this._map.on("click", (e) => {
      if (Date.now() - (this._gestEnd || 0) < 350) return; // fine di un trascinamento, non un tocco
      if (Date.now() - (this._longAt || 0) < 900) return; // fine di un tocco prolungato
      this._mapTap(e.originalEvent);
    });
    this._map.on("contextmenu", (e) => {
      e.originalEvent?.preventDefault?.();
      if (Date.now() - (this._longAt || 0) < 900) return; // già aperto dal tocco prolungato
      this._longAt = Date.now();
      this._mapClick(this._rotated() && e.originalEvent ? this._unrotLatLng(e.originalEvent) : e.latlng);
    });
    this._bindLongPress(this.$("map"), (ev) => (this._rotated() ? this._unrotLatLng(ev) : this._map.mouseEventToLatLng(ev)));
    this._map.on("dragstart", () => this._userMoved());
    this._bindGuidaGestures();
    // logo in alto a sinistra: nell'app NaviHA chiede se uscire e chiude l'app; in Home Assistant (browser) non fa nulla
    const brand = $("brand");
    if (brand && this._isNaviHA()) {
      brand.style.cursor = "pointer";
      brand.addEventListener("click", () => {
        try {
          // app recente: dialogo nativo col titolo "Navigator" (il confirm del WebView mostrava l'URL)
          if (window.NaviHAApp?.confirmExit) { window.NaviHAApp.confirmExit(); return; }
          // app più vecchia: confirm del WebView come ripiego
          if (window.NaviHAApp?.exit && window.confirm("Vuoi uscire da NaviHA?")) window.NaviHAApp.exit();
        } catch (e) { /* ponte non disponibile */ }
      });
    }
    this._bindNavTopDrag();
    // tasto mute nella barra delle indicazioni (delega: la barra viene ridisegnata a ogni posizione)
    this.$("navtop").addEventListener("click", (e) => {
      if (e.target.closest('[data-a="mute"]')) { e.stopPropagation(); this._toggleMuteGuide(); }
    });
    this._ro = new ResizeObserver(() => this._relayout());
    this._ro.observe($("mapwrap"));
    setTimeout(() => this._map.invalidateSize(), 300);

    // schermo intero e schermo sempre acceso
    $("fullbtn").addEventListener("click", () => this._toggleFull());
    $("layerbox").addEventListener("click", () => this._cycleLayer());
    // debug: 20 tocchi di fila sulla versione (meno di 3 s tra uno e l'altro); vale fino alla prossima apertura del pannello
    let verTaps = 0, verAt = 0;
    $("verlbl").addEventListener("click", () => {
      const now = Date.now();
      verTaps = now - verAt < 3000 ? verTaps + 1 : 1;
      verAt = now;
      if (this._debug) return;
      if (verTaps >= 20) {
        this._debug = true;
        this._msg("🐞 Debug attivo fino al riavvio: Impostazioni → Debug");
      } else if (verTaps >= 15) this._msg(`Ancora ${20 - verTaps} tocchi per il debug`);
    });
    $("layerbox").title = `Mappa: ${LAYERS[this._layer]?.[0] || ""} (tocca per cambiare)`;
    $("sidebtn").addEventListener("click", () => this._carSide(!this.classList.contains("sideopen")));
    $("b3dbtn").addEventListener("click", () => this._toggle3d());
    const tapOk = () => Date.now() - (this._longAt || 0) > 500; // subito dopo uno spostamento il tocco non vale
    $("pitchctl").querySelectorAll("[data-p]").forEach((b) => b.addEventListener("click", () => { if (tapOk()) this._setPitch3d(+b.dataset.p); }));
    $("nightbtn").addEventListener("click", () => { if (tapOk()) this._toggleNight(); });
    $("pitchctl").querySelectorAll("[data-z]").forEach((b) => b.addEventListener("click", () => { if (tapOk()) this._zoomStep(+b.dataset.z); }));
    this._bindFloatDrag("pitchctl");
    this._bindFloatDrag("spdbox");
    // tocco sul riquadro della velocità: elenco degli add-on che non sono sulla mappa, per farli comparire
    $("spdbox").addEventListener("click", () => { if (tapOk()) this._addonMenu(); });
    $("spdbox").style.cursor = "pointer";
    this._netWatch();
    this._loadLayout();
    this._map.on("moveend zoomend", () => this._sync3d());
    if (this._settings.view3d) setTimeout(() => this._toggle3d(true), 0);
    document.addEventListener("fullscreenchange", () => {
      if (document.fullscreenElement === this) { this._fsReal = true; return; }
      if (this._fsReal) { this._fsReal = false; if (this._full) this._toggleFull(false); } // uscita con il tasto Indietro
    });
    document.addEventListener("visibilitychange", () => {
      this._updateAwake();
      if (document.visibilityState === "hidden") this._tripFlush(); // app chiusa o in secondo piano: i punti partono subito
    });

    // controlli
    $("northbtn").addEventListener("click", () => this._resetNorth());
    $("locate").addEventListener("click", () => {
      if (!this._nav) { this._locate(true); return; }
      this._recenter(); // in navigazione: torna a seguire la posizione
    });
    $("modebtn").addEventListener("click", () => this._toggleView());
    $("settingsbtn").addEventListener("click", () => this._openSettings());
    try { window.speechSynthesis?.addEventListener?.("voiceschanged", () => { if (!this.$("setwrap").hidden) this._openSettings(); }); } catch (e) { /* nessuna voce */ }
    $("fit").addEventListener("click", () => this._fit());
    $("go").addEventListener("click", async () => {
      await this._compute();
      if (this._result) this.$("planh").classList.remove("open"); // calcolato: ricerca e itinerario si richiudono
      this._planSync();
    });
    $("planh").addEventListener("click", () => $("planh").classList.toggle("open"));
    $("addstop").addEventListener("click", () => { this._points.splice(this._points.length - 1, 0, null); this._renderPoints(true); });
    $("swap").addEventListener("click", () => { this._points.reverse(); this._afterPointsChange(); });
    $("clear").addEventListener("click", () => {
      this._points = [this._homePoint(), null];
      this._excluded = [];
      this._blocked = [];
      this._result = null;
      this._afterPointsChange(false);
      this._renderResults();
      this.$("planh").classList.add("open");
      this._planSync();
    });
    for (const k of ["tolls", "highways", "ferries"]) {
      const cb = $(`av_${k}`);
      cb.checked = !!this._avoid[k];
      cb.addEventListener("change", () => { this._avoid[k] = cb.checked; this._saveState(); this._autoCompute(); });
    }
    this._renderModes();
    this._bindSuggest($("q"), (p) => this._showPlace(p, true));

    try {
      this._info = await this._hass.callWS({ type: "navigator/info" });
      if (this._info.version !== PANEL_VERSION) {
        // il pannello caricato è più vecchio del backend: la pagina (o la WebView dell'app) ha in cache il file vecchio.
        // Si ricarica una volta sola per ogni versione del backend, così riprende il pannello aggiornato senza intervento.
        let tried = null;
        try { tried = sessionStorage.getItem("navigator-reload"); } catch (e) { /* storage non disponibile */ }
        if (tried !== this._info.version) {
          try { sessionStorage.setItem("navigator-reload", this._info.version); } catch (e) { /* storage non disponibile */ }
          $("verwarn").innerHTML = `<div class="verwarn">Aggiorno il pannello alla versione ${esc(this._info.version)}…</div>`;
          console.debug("[Navigator] pannello", PANEL_VERSION, "→ backend", this._info.version, ": ricarico");
          setTimeout(() => { try { window.location.reload(); } catch (e) { /* ricarica non riuscita */ } }, 400);
          return;
        }
        // già ricaricato ma la versione non cambia: la cache resiste, si avvisa soltanto
        $("verwarn").innerHTML = `<div class="verwarn">Aggiornamento non completato: il pannello è la versione ${PANEL_VERSION} ma l'integrazione è la ${esc(this._info.version)}.
          Riavvia Home Assistant (Impostazioni → Sistema → Riavvia); nell'app NaviHA chiudila e riaprila, oppure svuota la cache.</div>`;
      } else {
        try { sessionStorage.removeItem("navigator-reload"); } catch (e) { /* storage non disponibile */ }
      }
    } catch (err) {
      $("verwarn").innerHTML = `<div class="verwarn">Navigator non risponde: ${esc(err.message || err)}. Riavvia Home Assistant dopo l'installazione.</div>`;
      this._info = { favorites: [], recent: [], entities: [], home: { lat: home[0], lon: home[1], name: "Casa" } };
    }
    if (!this._points[0]) this._points[0] = this._homePoint();
    this._renderPoints();
    this._renderFavs();
    this._drawMarkers();
    // app NaviHA in Android Auto: un percorso avviato con Parti sul telefono arriva qui e parte da solo
    window.__navihaHandoff = () => this._takeHandoff();
    if (await this._takeHandoff()) return;
    if (this._points.every((p) => p)) this._compute(true);
  }

  _setLayer(key) {
    const [, url, maxZoom, attribution] = LAYERS[this._effLayer(key)];
    if (this._tiles) this._map.removeLayer(this._tiles);
    this._tiles = cachedTileLayer(url, { maxZoom, attribution, subdomains: "abc" }); // con la memoria delle mappe
    if (!this._3d) this._tiles.addTo(this._map); // in 3D le mappe le scarica solo MapLibre
    this._layer = key;
    this.$("map")?.classList.toggle("desert", key === "deserto");
    if (this._3d) this._set3dBase();
  }

  _homePoint() {
    const h = this._info?.home || { lat: this._hass.config.latitude, lon: this._hass.config.longitude };
    return { name: `🏠 ${this._hass.config.location_name || "Casa"}`, address: "Casa (Home Assistant)", lat: h.lat, lon: h.lon };
  }

  _msg(text) {
    const t = document.createElement("div");
    t.textContent = text;
    Object.assign(t.style, { position: "fixed", bottom: "20px", left: "50%", transform: "translateX(-50%)", zIndex: 2000,
      background: "#323232", color: "#fff", padding: "10px 16px", borderRadius: "8px", fontSize: "14px", maxWidth: "90vw" });
    this.shadowRoot.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  // ----------------------------------------------------------------- ricerca con suggerimenti

  _quickItems() {
    const items = [{ ico: "◎", name: "La mia posizione", address: "Posizione del dispositivo (GPS)", _geo: true }];
    // Casa: le coordinate di Home Assistant. Niente persone e telefoni (persone/dispositivi): restano le altre zone
    items.push({ ...this._homePoint(), ico: "🏡", name: "Casa" });
    for (const e of this._info?.entities || []) {
      if (e.entity_id === "zone.home" || e.kind !== "zone") continue;
      items.push({ ico: "📍", name: e.name, address: e.entity_id, lat: e.lat, lon: e.lon });
    }
    const out = [{ head: "Rapidi" }, ...items];
    if (this._info?.favorites?.length) out.push({ head: "Preferiti" }, ...this._info.favorites.map((f) => ({ ico: f.icon || "★", ...f })));
    if (this._info?.recent?.length) out.push({ head: "Recenti" }, ...this._info.recent.map((f) => ({ ico: "🕘", ...f })));
    return out;
  }

  _bindSuggest(input, onPick) {
    const wrap = input.parentElement;
    let box = null;
    let items = [];
    let active = -1;
    let timer = null;
    let seq = 0;
    const close = () => { box?.remove(); box = null; active = -1; };
    const render = (list, empty) => {
      items = list.filter((i) => !i.head);
      if (!box) { box = document.createElement("div"); box.className = "suggest"; wrap.appendChild(box); }
      if (!list.length) { box.innerHTML = `<div class="empty">${esc(empty || "Nessun risultato")}</div>`; return; }
      let n = 0;
      box.innerHTML = list.map((i) => i.head ? `<div class="head">${esc(i.head)}</div>`
        : `<div class="item" data-i="${n++}"><span class="ico">${esc(i.ico || "📍")}</span><div><div class="t">${esc(i.name)}</div>
           ${i.address ? `<div class="a">${esc(i.address)}</div>` : ""}</div></div>`).join("");
      box.querySelectorAll(".item").forEach((el) => {
        el.addEventListener("mousedown", (ev) => { ev.preventDefault(); pick(items[+el.dataset.i]); });
      });
    };
    const pick = async (item) => {
      close();
      if (!item) return;
      if (item._geo) {
        const pos = await this._locate(false);
        if (!pos) return;
        item = { name: "◎ La mia posizione", address: "", lat: pos.lat, lon: pos.lon };
      }
      const { ico, _geo, head, kind, source, id, time, ...p } = item;
      input.value = p.name;
      input.blur();
      onPick(p);
    };
    const search = async () => {
      const q = input.value.trim();
      if (q.length < 2) { render(this._quickItems()); return; }
      const my = ++seq;
      if (!box) render([], "");
      box.innerHTML = `<div class="empty"><span class="loading"></span> Cerco…</div>`;
      try {
        const c = this._map.getCenter();
        const r = await this._hass.callWS({ type: "navigator/search", query: q, lat: c.lat, lon: c.lng });
        if (my !== seq || this.shadowRoot.activeElement !== input) return;
        render(r.results.map((x) => ({ ...x, ico: "📍" })), "Nessun risultato: prova a scrivere anche la città");
      } catch (err) {
        if (my === seq) render([], `Errore: ${err.message || err}`);
      }
    };
    input.addEventListener("focus", () => { input.select(); if (input.value.trim().length < 2 || input.dataset.fixed) render(this._quickItems()); else search(); });
    input.addEventListener("input", () => { delete input.dataset.fixed; clearTimeout(timer); timer = setTimeout(search, 300); });
    input.addEventListener("blur", () => setTimeout(close, 150));
    input.addEventListener("keydown", async (ev) => {
      const els = box ? [...box.querySelectorAll(".item")] : [];
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        if (!els.length) return;
        active = (active + (ev.key === "ArrowDown" ? 1 : -1) + els.length) % els.length;
        els.forEach((el, i) => el.classList.toggle("active", i === active));
        els[active].scrollIntoView({ block: "nearest" });
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        if (active >= 0) { pick(items[active]); return; }
        clearTimeout(timer);
        await search();
        const first = items[0];
        if (first && input.value.trim().length >= 2) pick(first);
      } else if (ev.key === "Escape") {
        close();
        input.blur();
      }
    });
  }

  // ----------------------------------------------------------------- luogo selezionato

  _showPlace(p, fly) {
    this._place = p;
    const box = this.$("placecard");
    box.innerHTML = `<div class="placecard"><div class="n">${esc(p.name)}</div><div class="a">${esc(p.address || `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`)}</div>
      ${p.poi ? `<div class="pinfo"><div class="muted"><span class="loading"></span> Orari e contatti…</div></div>` : ""}
      <div class="row">
        <button class="primary" data-a="dest">➜ Portami qui</button>
        <button data-a="stop">＋ Tappa</button>
        <button data-a="start">Parti da qui</button>
        <button data-a="fav" title="Salva nei preferiti">★</button>
        <button class="icon" data-a="close" title="Chiudi">✕</button>
      </div></div>`;
    box.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => this._placeAction(b.dataset.a, p)));
    if (p.poi) this._loadPoiInfo(p);
    this._drawMarkers();
    if (fly) this._flyTo(p.lat, p.lon, Math.max(this._map.getZoom(), 15));
  }

  // scheda del punto di interesse: orari (aperto ora?), telefono, sito, indirizzo, servizi — da OpenStreetMap
  async _loadPoiInfo(p) {
    const box = () => (this._place === p ? this.$("placecard")?.querySelector(".pinfo") : null);
    let d;
    try {
      d = await this._hass.callWS({ type: "navigator/poi_info", lat: p.lat, lon: p.lon, name: p.poi.name, osm: p.poi.osm });
    } catch (e) {
      const el = box();
      if (el) el.innerHTML = `<div class="muted">${esc(String(e.message || e).includes("Unknown command")
        ? "Scheda non disponibile: aggiorna l'integrazione e riavvia Home Assistant." : e.message || e)}</div>`;
      return;
    }
    const el = box();
    if (!el) return;
    if (!d.found) { el.innerHTML = `<div class="muted">Nessun dettaglio su OpenStreetMap per questo luogo.</div>`; return; }
    let html = "";
    if (d.address) {
      const a = this.$("placecard").querySelector(".a");
      if (a) a.textContent = `${p.address ? `${p.address} · ` : ""}${d.address}`;
    }
    if (d.opening_hours) {
      const week = parseOpeningHours(d.opening_hours);
      if (week) {
        const st = ohStatus(week);
        const today = (new Date().getDay() + 6) % 7;
        html += `<div class="ohst ${st.open ? "on" : "off"}">${st.open ? "● Aperto" : "● Chiuso"} <span>· ${esc(st.text)}</span></div>
          <table class="oh">${ohGroups(week).map(([d1, d2, txt]) => `<tr class="${today >= d1 && today <= d2 ? "today" : ""}"><td>${
            d1 === d2 ? OH_IT[d1] : `${OH_IT[d1].slice(0, 3)}–${OH_IT[d2].slice(0, 3)}`}</td><td>${txt}</td></tr>`).join("")}</table>`;
      } else {
        html += `<div class="ohraw">🕒 ${esc(d.opening_hours)}</div>`;
      }
    } else {
      html += `<div class="muted">Orari non indicati su OpenStreetMap.</div>`;
    }
    const chips = [];
    if (d.cuisine) chips.push(`🍽 ${esc(d.cuisine.split(";").map((c) => c.replace(/_/g, " ")).join(", "))}`);
    if (d.outdoor_seating === "yes") chips.push("☀️ Tavoli all'aperto");
    if (d.takeaway === "yes" || d.takeaway === "only") chips.push("🥡 Da asporto");
    if (["yes", "wlan", "wifi"].includes(d.internet_access)) chips.push("📶 Wi-Fi");
    if (d.wheelchair === "yes") chips.push("♿ Accessibile");
    else if (d.wheelchair === "limited") chips.push("♿ In parte accessibile");
    if (chips.length) html += `<div class="pchips">${chips.map((c) => `<span>${c}</span>`).join("")}</div>`;
    const links = [];
    if (d.phone) {
      const ph = d.phone.split(";")[0].trim();
      links.push(`<a href="tel:${esc(ph.replace(/[^\d+]/g, ""))}">📞 ${esc(ph)}</a>`);
    }
    if (d.website) {
      const url = /^https?:\/\//i.test(d.website) ? d.website : `https://${d.website}`;
      links.push(`<a href="${esc(url)}" target="_blank" rel="noopener">🌐 ${esc(url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, ""))}</a>`);
    }
    if (d.email) links.push(`<a href="mailto:${esc(d.email)}">✉️ ${esc(d.email)}</a>`);
    if (links.length) html += `<div class="plinks">${links.join("")}</div>`;
    const osm = /^([nwr])(\d+)$/.exec(d.osm || "");
    if (osm) {
      html += `<div class="muted" style="font-size:11px;margin-top:4px">Dati OpenStreetMap · <a href="https://www.openstreetmap.org/${
        { n: "node", w: "way", r: "relation" }[osm[1]]}/${osm[2]}" target="_blank" rel="noopener">correggi o aggiungi orari</a></div>`;
    }
    el.innerHTML = html;
  }

  // ----------------------------------------------------------------- "Dove vai?": partito senza percorso
  // Senza percorso impostato, dopo 400 m dalla posizione di partenza compare un riquadro con le mete probabili:
  // preferiti, destinazioni recenti e arrivi dei viaggi in archivio verso cui ti stai davvero avvicinando (confronto con
  // la posizione di ~1,5 km fa). Le mete che la strada smette di avvicinare spariscono; senza mete il riquadro si nasconde.
  // Frecce su/giù per scegliere, tocco o "Vai" per partire, ✕ per chiuderlo fino alla prossima sosta.

  // GPS di questo dispositivo anche senza guida (solo sul telefono: NaviHA o app Companion), per accorgersi della partenza
  _idleWatchSync() {
    // (serve alla proposta della destinazione e al riquadro della velocità senza percorso)
    const want = !this._nav && this._meSource() === "gps" && !!this._companion()
      && window.isSecureContext && !!window.navigator.geolocation;
    if (want && this._idleWatch == null) {
      this._idleWatch = window.navigator.geolocation.watchPosition((pos) => {
        if (this._nav) return;
        const lat = pos.coords.latitude, lon = pos.coords.longitude;
        this._meTurn(lat, lon);
        this._me = { lat, lon, src: "gps" };
        this._drawMarkers();
        this._autoDestCheck(this._me);
        this._idleSpeed(lat, lon, pos.coords.speed, pos.coords.heading);
        this._fixAt = Date.now();
      }, () => { /* GPS non disponibile: niente proposte */ }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 60000 });
    } else if (!want && this._idleWatch != null) {
      window.navigator.geolocation.clearWatch(this._idleWatch);
      this._idleWatch = null;
    }
  }

  // senza guida: velocità dal GPS e limite della strada attuale (chiesto ogni tanto: >150 m o 20 s)
  async _idleSpeed(lat, lon, speed, heading) {
    if (this._nav) return;
    const kmh = typeof speed === "number" && speed >= 0 ? Math.round(speed * 3.6) : null;
    const L = (this._idleLim ||= { at: 0, ll: null, limit: null });
    if (kmh != null && kmh >= 5 && (!L.ll || distM(L.ll, [lat, lon]) > 150 || Date.now() - L.at > 20000) && !L.busy) {
      L.busy = true; L.at = Date.now(); L.ll = [lat, lon];
      try {
        const r = await this._hass.callWS({ type: "navigator/speed_limit", lat, lon,
          ...(typeof heading === "number" && heading >= 0 ? { heading } : {}) });
        L.limit = r.limit ?? null;
      } catch (e) { L.limit = null; } finally { L.busy = false; }
    }
    if (this._nav) return;
    const lim = L.limit;
    this._spdBox(kmh, lim != null && kmh != null && kmh > lim + Math.max(3, lim * 0.05), lim);
  }

  async _autoDestCheck(pos) {
    if (!pos || this._settings.autoDest === false) return;
    const now = Date.now();
    const ad = (this._ad ||= { hist: [], closed: false });
    // solo fuori dalla guida (un percorso calcolato ma non avviato, es. quello rimasto dall'ultima volta, non conta)
    if (this._nav) { this._autoDestHide(); ad.hist = []; ad.start = null; return; }
    const here = [pos.lat, pos.lon];
    const last = ad.hist[ad.hist.length - 1];
    // fermo da 5 minuti: nuova partenza (si ricomincia da qui, il riquadro chiuso può tornare)
    if (last && distM(last.p, here) < 30) {
      if (now - last.t > 300000) { ad.hist = []; ad.start = null; ad.closed = false; this._autoDestHide(); }
      else return;
    }
    if (!ad.start) ad.start = here;
    ad.hist.push({ p: here, t: now });
    // percorso fatto: si tiene la storia fino a ~1,5 km indietro
    let along = 0;
    for (let i = ad.hist.length - 1; i > 0; i--) {
      along += distM(ad.hist[i].p, ad.hist[i - 1].p);
      if (along > 1500) { ad.hist = ad.hist.slice(i - 1); break; }
    }
    if (ad.closed || distM(ad.start, here) < 400) return;
    const ref = ad.hist[0].p;
    const moved = distM(ref, here);
    if (moved < 250) return;
    const cands = await this._autoDestCands();
    const list = [];
    for (const c of cands) {
      const dNow = distM(here, [c.lat, c.lon]);
      if (dNow < 300) continue; // già arrivato (o quasi)
      // avvicinamento rispetto a ~1,5 km fa: almeno il 35% di quanto hai percorso (strade che girano comprese)
      const gain = distM(ref, [c.lat, c.lon]) - dNow;
      if (gain >= moved * 0.35) list.push({ ...c, d: dNow, r: gain / moved });
    }
    list.sort((a, b) => b.r - a.r || a.d - b.d);
    this._autoDestShow(list.slice(0, 8));
  }

  // mete possibili: preferiti, destinazioni recenti e arrivi dei viaggi in archivio (vicine fra loro = una sola)
  async _autoDestCands() {
    if (!this._trips && !this._adTripsAsked) {
      this._adTripsAsked = true;
      try { this._trips = (await this._hass.callWS({ type: "navigator/trips" })).trips; } catch (e) { /* archivio non disponibile */ }
    }
    const out = [];
    const add = (name, lat, lon, ico, kind) => {
      if (lat == null || lon == null || !name) return;
      if (out.some((o) => distM([o.lat, o.lon], [lat, lon]) < 200)) return;
      out.push({ name, lat, lon, ico, kind });
    };
    for (const f of this._info?.favorites || []) add(f.name, f.lat, f.lon, f.icon || "★", "Preferito");
    for (const r of this._info?.recent || []) add(r.name, r.lat, r.lon, "🕘", "Recente");
    for (const t of this._trips || []) if (t.dest) add(t.to || "Meta di un viaggio", t.dest[0], t.dest[1], "🗂️", "Già fatto");
    return out;
  }

  _autoDestHide() {
    const el = this.$("adpop");
    if (el) el.hidden = true;
  }

  _autoDestShow(list) {
    const el = this.$("adpop");
    if (!el) return;
    const ad = this._ad;
    if (!list.length) { el.hidden = true; return; }
    // la meta scelta con le frecce resta scelta finché c'è
    const keep = ad.selKey && list.findIndex((x) => `${x.lat},${x.lon}` === ad.selKey);
    ad.sel = keep >= 0 ? keep : 0;
    ad.list = list;
    const draw = () => {
      el.innerHTML = `<div class="adh">📍 <span>Seleziona destinazione</span>
          <button data-ad="up" title="Su">▲</button><button data-ad="down" title="Giù">▼</button><button data-ad="x" title="Chiudi">✕</button></div>
        <div class="adl">${ad.list.map((x, i) => `<div class="adi${i === ad.sel ? " sel" : ""}" data-i="${i}"><span>${esc(x.ico)}</span>
          <span class="nm">${esc(x.name)}</span><small>${esc(x.kind)} · ${fmtKm(x.d / 1000)}</small></div>`).join("")}</div>`;
      el.querySelector('[data-ad="x"]').onclick = () => { ad.closed = true; el.hidden = true; };
      el.querySelector('[data-ad="up"]').onclick = () => move(-1);
      el.querySelector('[data-ad="down"]').onclick = () => move(1);
      el.querySelectorAll(".adi").forEach((it) => { it.onclick = () => this._autoDestGo(ad.list[+it.dataset.i]); });
      el.querySelector(".adi.sel")?.scrollIntoView({ block: "nearest" });
    };
    const move = (d) => {
      ad.sel = (ad.sel + d + ad.list.length) % ad.list.length;
      ad.selKey = `${ad.list[ad.sel].lat},${ad.list[ad.sel].lon}`;
      draw();
    };
    draw();
    el.hidden = false;
  }

  // meta scelta: partenza da qui, percorso e guida subito (stai già guidando)
  async _autoDestGo(c) {
    this._autoDestHide();
    this._ad = { hist: [], closed: false };
    const me = this._me;
    if (!me) return;
    this._points = [{ name: "◎ La mia posizione", address: "", lat: me.lat, lon: me.lon },
      { name: c.name, address: c.kind === "Già fatto" ? "Meta di un viaggio in archivio" : "", lat: c.lat, lon: c.lon }];
    this._excluded = []; this._blocked = [];
    this._afterPointsChange(false);
    await this._compute(true);
    if (this._result && !this._nav) this._startNav(this._meSource() || "gps");
  }

  _placeAction(action, p) {
    const pt = { name: p.name, address: p.address || "", lat: p.lat, lon: p.lon };
    if (action === "dest") {
      this._points[this._points.length - 1] = pt;
      if (!this._points[0]) this._points[0] = this._homePoint();
    } else if (action === "start") {
      this._points[0] = pt;
    } else if (action === "stop") {
      const empty = this._points.findIndex((x) => !x);
      if (empty >= 0) this._points[empty] = pt;
      else this._points.splice(this._points.length - 1, 0, pt);
    } else if (action === "fav") {
      this._saveFav(pt);
      return;
    }
    this._map.closePopup();
    this._popup3d?.remove();
    this._popup3d = null;
    this._place = null;
    this.$("placecard").innerHTML = "";
    this.$("q").value = "";
    if (action === "close") { this._drawMarkers(); return; }
    if (action === "dest") { this._excluded = []; this._blocked = []; } // nuova destinazione: tratte tolte e chiusure evitate non valgono più
    this._afterPointsChange();
  }

  // ----------------------------------------------------------------- anteprima di un'indicazione dell'itinerario

  _stepPreview(k) {
    if (this._nav || !this._result) return;
    const rt = this._geom(this._result.routes[this._sel]);
    const ms = rt.maneuvers;
    k = Math.max(0, Math.min(ms.length - 1, k));
    const m = ms[k];
    const sh = rt.shape;
    const at = sh[Math.min(m.begin, sh.length - 1)];
    const already = this._stepK != null; // si sta già scorrendo: la vista scelta a mano (distanza, inclinazione) resta
    this._stepK = k;
    this._stepRt = this._result.routes[this._sel];
    // barra in alto come in guida: distanza dall'indicazione di prima, freccia, testo, corsie
    const top = this.$("navtop");
    const prevD = k > 0 ? rt._cum[m.begin] - rt._cum[ms[k - 1].begin] : 0;
    const lanes = m.lanes ? `<div class="lanes">${m.lanes.map((l) => `<span class="ln ${l.v ? "on" : ""}">${laneSvg(l.d)}</span>`).join("")}</div>` : "";
    top.className = "navtop preview";
    top.hidden = false;
    this._applyNavTopPos();
    top.innerHTML = `<button class="pv" data-pv="-1" title="Indicazione precedente" ${k === 0 ? "disabled" : ""}>‹</button>
      <span class="ic">${maneuverIcon(m)}</span>
      <div style="flex:1;min-width:0"><div class="d">${k === 0 ? "Partenza" : fmtDist(prevD)}</div><div class="t">${esc(m.text)}</div>${lanes}
        <div class="pvn">${k + 1} di ${ms.length} · km ${(rt._cum[m.begin] / 1000).toFixed(1).replace(".", ",")} dalla partenza</div></div>
      <button class="pv" data-pv="1" title="Indicazione successiva" ${k === ms.length - 1 ? "disabled" : ""}>›</button>
      <button class="pv x" data-pv="0" title="Chiudi">✕</button>`;
    top.querySelectorAll("[data-pv]").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      const d = +b.dataset.pv;
      if (d) this._stepPreview(k + d); else this._stepClose();
    }));
    this.$("results")?.querySelectorAll(".steps li[data-k]").forEach((li) => li.classList.toggle("sel", +li.dataset.k === k));
    // segnaposto sulla manovra
    this._stepLayer ??= L.layerGroup().addTo(this._map);
    this._stepLayer.clearLayers();
    L.marker(at, { interactive: false, zIndexOffset: 1500, icon: L.divIcon({ className: "", iconSize: [36, 48], iconAnchor: [18, 47],
      html: `<div class="steppin"><svg viewBox="0 0 36 48"><path d="M18 47C14 37 3 29 3 17a15 15 0 0 1 30 0c0 12-11 20-15 30z" fill="#1f2a37" stroke="#fff" stroke-width="2"/>
        <circle cx="18" cy="17" r="10.5" fill="#fff"/></svg><img src="${ICON}" alt=""></div>` }) }).addTo(this._stepLayer);
    // verso di marcia: la direzione della strada DAVANTI al punto della manovra (come in guida: la strada davanti è in alto),
    // mediata sui ~30 m successivi così in rotatoria non punta sulla tangente della curva
    let dir = null;
    { let x = 0, y = 0, d = 0;
      for (let i = m.begin; i + 1 < sh.length && d < 30; i++) {
        const b = bearing(sh[i], sh[i + 1]); const seg = distM(sh[i], sh[i + 1]); d += seg;
        x += Math.cos((b * Math.PI) / 180) * seg; y += Math.sin((b * Math.PI) / 180) * seg;
      }
      if (x || y) dir = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    }
    // manovra in fondo al percorso (niente strada davanti): si usa la direzione di arrivo
    if (dir == null) for (let i = m.begin; i > 0 && dir == null; i--) if (distM(sh[i - 1], at) > 3) dir = bearing(sh[i - 1], at);
    if (this._3d && this._g3) {
      this._schedule3d();
      // come in guida: l'inclinazione e la distanza scelte dall'utente (non valori fissi), girata nel verso di marcia
      const g = this._g3;
      const cam = this._clearCamera({ center: [at[1], at[0]], zoom: already ? g.getZoom() : 16 + this._zoom3dOff(), bearing: dir ?? g.getBearing(),
        pitch: already ? g.getPitch() : this._pitch3d(), padding: { top: 0, bottom: 0, left: 0, right: 0 } });
      this._stepAnim = true; // durante il movimento la mappa 2D non deve riportare indietro la vista
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
      g.easeTo({ ...cam, duration: reduce ? 0 : 800 });
      if (reduce) requestAnimationFrame(() => g.fire("moveend")); // senza animazione il moveend potrebbe non arrivare
      // finito il movimento la mappa 2D (nascosta) va nello stesso punto: altrimenti al primo aggiornamento riportava indietro la vista
      g.once("moveend", () => {
        this._stepAnim = false;
        const cc = g.getCenter();
        this._from3d = true;
        try { this._map.setView([cc.lat, cc.lng], g.getZoom() - Z3D, { animate: false }); } finally { this._from3d = false; }
      });
    } else {
      if (dir != null && !this._isGuida()) {
        this._freeRot = true;
        this._rot = dir;
      }
      this._map.setView(at, already ? this._map.getZoom() : Math.max(this._map.getZoom(), 17), { animate: false });
      this._relayout();
      this._applyInteract();
    }
  }

  _stepClose() {
    this._stepK = null;
    this._stepLayer?.clearLayers();
    if (!this._nav) this.$("navtop").hidden = true;
    this.$("results")?.querySelectorAll(".steps li.sel").forEach((li) => li.classList.remove("sel"));
    this._schedule3d();
  }

  _openPoi(it) {
    this._showPlace({ name: it.name || POI_KINDS[it.k][0], address: POI_KINDS[it.k][0], lat: it.lat, lon: it.lon,
      poi: { name: it.name || "", osm: /^[nwr]\d+$/.test(it.id || "") ? it.id : "" } }, false);
  }

  // tocco breve sulla mappa: apre il punto di interesse più vicino al dito (entro ~32 px: col dito non si centra l'icona)
  _mapTap(ev) {
    if (this._isGuida() || !ev) return;
    const items = this._poiShown || [];
    let best = null, bd = 32;
    for (const it of items) {
      let pt;
      if (this._3d && this._g3) {
        const r = this._g3.getCanvas().getBoundingClientRect();
        const q = this._g3.project([it.lon, it.lat]);
        pt = { x: q.x + r.left, y: q.y + r.top - 46 }; // in 3D l'icona fluttua sopra il punto
      } else {
        // sullo schermo, anche con la mappa ruotata: dal punto della mappa alla posizione del marcatore
        const el = this._poiMarkerEl?.get(it.id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        pt = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      const d = Math.hypot(pt.x - ev.clientX, pt.y - ev.clientY);
      if (d < bd) { bd = d; best = it; }
    }
    if (best) this._openPoi(best);
    else { this._map.closePopup(); this._popup3d?.remove(); this._popup3d = null; }
  }

  // tocco prolungato (circa mezzo secondo, fermo) su una mappa: come il clic di prima, con una piccola vibrazione
  _bindLongPress(el, toLatLng) {
    if (!el) return;
    let t = null, start = null, n = 0;
    const cancel = () => { clearTimeout(t); t = null; };
    el.addEventListener("pointerdown", (e) => {
      n++;
      cancel();
      if (n > 1 || e.button > 0 || this._isGuida()) return;
      start = { x: e.clientX, y: e.clientY };
      const ev = { clientX: e.clientX, clientY: e.clientY };
      t = setTimeout(() => {
        t = null;
        if (Date.now() - (this._longAt || 0) < 900) return; // già aperto (menu del tasto destro / tocco lungo del telefono)
        this._longAt = Date.now();
        try { window.navigator.vibrate?.(25); } catch (err) { /* niente vibrazione */ }
        this._mapClick(toLatLng(ev));
      }, 550);
    });
    el.addEventListener("pointermove", (e) => { if (t && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel(); });
    for (const k of ["pointerup", "pointercancel", "pointerleave"]) el.addEventListener(k, () => { n = Math.max(0, n - 1); cancel(); });
  }

  async _mapClick(latlng) {
    if (this._isGuida()) return;
    const el = document.createElement("div");
    el.className = "popup";
    el.innerHTML = `<div class="n"><span class="loading"></span> Cerco l'indirizzo…</div><div class="a">${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}</div>
      <div class="imgdate" hidden></div>
      <div class="row"><button data-a="start">Parti da qui</button><button data-a="stop">＋ Tappa</button>
      <button data-a="dest">Arriva qui</button><button data-a="fav">★</button></div>`;
    // i popup di Leaflet vivono nello shadow DOM: servono gli stili del pannello; in 3D il popup va sulla vista 3D
    // (la mappa 2D sotto è nascosta: il popup c'era ma non si vedeva)
    this._popup3d?.remove();
    this._popup3d = null;
    let popup = null;
    if (this._3d && this._g3 && window.maplibregl) {
      this._popup3d = new window.maplibregl.Popup({ maxWidth: "300px", className: "pop3d", focusAfterOpen: false })
        .setLngLat([latlng.lng, latlng.lat]).setDOMContent(el).addTo(this._g3);
    } else {
      popup = L.popup({ maxWidth: 300 }).setLatLng(latlng).setContent(el).openOn(this._map);
    }
    let place = { name: `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`, address: "", lat: latlng.lat, lon: latlng.lng };
    el.querySelectorAll("button").forEach((b) => b.addEventListener("click", (ev) => {
      L.DomEvent.stopPropagation(ev);
      if (popup) this._map.closePopup(popup);
      this._placeAction(b.dataset.a, place);
    }));
    this._mapInfoLine(el.querySelector(".imgdate"), latlng);
    try {
      const r = await this._hass.callWS({ type: "navigator/reverse", lat: latlng.lat, lon: latlng.lng });
      place = { ...place, name: r.name, address: r.address };
      el.querySelector(".n").textContent = r.name;
      el.querySelector(".a").textContent = r.address || el.querySelector(".a").textContent;
    } catch (err) {
      el.querySelector(".n").textContent = "Punto sulla mappa";
    }
  }

  // riga sulla mappa nel popup: con il satellite la data dello scatto della foto in quel punto (metadati Esri),
  // con le altre mappe il nome e che sono disegnate da dati aggiornati di continuo
  async _mapInfoLine(box, latlng) {
    if (!box) return;
    const key = this._effLayer(this._layer);
    const name = LAYERS[key]?.[0] || "";
    if (key !== "sat" && key !== "deserto") {
      box.textContent = `Mappa ${name}: dati aggiornati di continuo`;
      box.hidden = false;
      return;
    }
    box.textContent = "Foto satellitare: cerco la data…";
    box.hidden = false;
    const zoom = this._3d && this._g3 ? this._g3.getZoom() + 1 : this._map.getZoom();
    try {
      const r = await this._hass.callWS({ type: "navigator/imagery", lat: latlng.lat, lon: latlng.lng, zoom });
      if (!r?.found) { box.textContent = "Foto satellitare: data non disponibile qui"; return; }
      const mesi = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
      const quando = r.month ? `${mesi[r.month - 1]} ${r.year}` : String(r.year);
      const res = r.res ? (r.res < 1 ? `${Math.round(r.res * 100)} cm` : `${String(Math.round(r.res * 10) / 10).replace(".", ",")} m`) : "";
      const chi = [r.source, r.sensor].filter(Boolean).join(" · ");
      box.textContent = `Foto satellitare di ${quando}${res ? ` · dettaglio ${res}` : ""}${chi ? ` · ${chi}` : ""}`;
    } catch (e) {
      box.textContent = "Foto satellitare: data non disponibile";
    }
  }

  // ----------------------------------------------------------------- itinerario

  _renderModes() {
    const box = this.$("modes");
    box.innerHTML = MODES.map(([k, ico, name]) => `<button data-m="${k}" class="${k === this._mode ? "on" : ""}">${ico} ${name}</button>`).join("");
    box.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      this._mode = b.dataset.m;
      this._renderModes();
      this._drawMarkers(); // il veicolo della posizione cambia col mezzo
      this._saveState();
      this._autoCompute();
    }));
    const car = this._mode === "auto" || this._mode === "moto";
    for (const k of ["tolls", "highways"]) this.$(`av_${k}`).parentElement.style.display = car ? "" : "none";
  }

  _renderPoints(focusNew) {
    const box = this.$("pts");
    const n = this._points.length;
    box.innerHTML = "";
    this._points.forEach((p, i) => {
      const label = i === 0 ? "A" : i === n - 1 ? "B" : String(i);
      const cls = i === 0 ? "start" : i === n - 1 ? "end" : "";
      const ph = i === 0 ? "Partenza" : i === n - 1 ? "Destinazione" : `Tappa ${i}`;
      const row = document.createElement("div");
      row.className = "field";
      row.innerHTML = `<span class="badge ${cls}">${label}</span><input type="text" placeholder="${ph}" autocomplete="off">
        ${n > 2 ? `<button class="icon" data-a="up" title="Sposta su" ${i === 0 ? "disabled" : ""}>↑</button>
        <button class="icon" data-a="down" title="Sposta giù" ${i === n - 1 ? "disabled" : ""}>↓</button>` : ""}
        <button class="icon" data-a="del" title="${n > 2 ? "Rimuovi" : "Svuota"}">✕</button>`;
      const input = row.querySelector("input");
      if (p) { input.value = p.name; input.dataset.fixed = "1"; input.title = p.address || ""; }
      box.appendChild(row);
      this._bindSuggest(input, (pt) => { this._points[i] = pt; this._afterPointsChange(); });
      row.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
        const a = b.dataset.a;
        if (a === "del") { if (n > 2) this._points.splice(i, 1); else this._points[i] = null; }
        if (a === "up" && i > 0) [this._points[i - 1], this._points[i]] = [this._points[i], this._points[i - 1]];
        if (a === "down" && i < n - 1) [this._points[i + 1], this._points[i]] = [this._points[i], this._points[i + 1]];
        this._afterPointsChange();
      }));
      if (focusNew && !p && i === n - 2) setTimeout(() => input.focus(), 0);
    });
  }

  _afterPointsChange(compute = true) {
    this._saveState();
    this._renderPoints();
    this._drawMarkers();
    if (compute) this._autoCompute(true);
  }

  _autoCompute(fit) {
    if (this._points.length >= 2 && this._points.every((p) => p)) this._compute(fit !== false);
    else { this._result = null; this._drawRoute(); this._renderResults(); }
  }

  _pinIcon(label, color) {
    return L.divIcon({ className: "", html: `<div class="pin" style="background:${color}"><span>${esc(label)}</span></div>`,
      iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28] });
  }

  _drawMarkers() {
    if (!this._markerLayer) return;
    this._markerLayer.clearLayers();
    this._schedule3d();
    const n = this._points.length;
    this._points.forEach((p, i) => {
      if (!p || (this._nav && i === 0)) return; // in navigazione la partenza è il pallino della posizione
      const label = i === 0 ? "A" : i === n - 1 ? "B" : String(i);
      const color = i === 0 ? "#2e7d32" : i === n - 1 ? "#c62828" : "#607d8b";
      const m = L.marker([p.lat, p.lon], { icon: this._pinIcon(label, color), draggable: true, title: p.name }).addTo(this._markerLayer);
      m.on("dragend", async () => {
        const ll = m.getLatLng();
        this._points[i] = { name: `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`, address: "", lat: ll.lat, lon: ll.lng };
        this._afterPointsChange();
        try {
          const r = await this._hass.callWS({ type: "navigator/reverse", lat: ll.lat, lon: ll.lng });
          if (this._points[i] && this._points[i].lat === ll.lat) {
            this._points[i] = { ...this._points[i], name: r.name, address: r.address };
            this._saveState();
            this._renderPoints();
          }
        } catch (e) { /* resta con le coordinate */ }
      });
    });
    if (this._place) {
      L.marker([this._place.lat, this._place.lon], { icon: this._pinIcon("★", "#f57c00"), title: this._place.name })
        .addTo(this._markerLayer);
    }
    for (const ex of this._excluded) {
      for (const pt of ex.points) {
        L.marker([pt.lat, pt.lon], { icon: L.divIcon({ className: "", html: '<div class="xmark">✕</div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
          title: `Esclusa: ${ex.name}` }).addTo(this._markerLayer);
      }
    }
    // "La mia posizione" (punto blu, il GPS o la stima del browser di questo dispositivo): non in guida, dove la posizione
    // è quella seguita (il veicolo) e un secondo punto confonderebbe (es. la stima del PC accanto alla persona seguita)
    if (this._dev && !this._nav) {
      L.marker([this._dev.lat, this._dev.lon], { title: "Questo dispositivo (GPS o posizione stimata dal browser)",
        icon: L.divIcon({ className: "", html: '<div class="me dev"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }) }).addTo(this._markerLayer);
    }
    // la posizione seguita ("Segui la posizione di") è il veicolo del mezzo scelto, come in guida (dove c'è già il suo)
    if (this._me && !this._nav) {
      const src = this._me.src && this._me.src !== "gps" ? this._hass?.states?.[this._me.src]?.attributes?.friendly_name : "";
      L.marker([this._me.lat, this._me.lon], { title: src ? `${src} (posizione da Home Assistant)` : "Questo dispositivo",
        icon: L.divIcon({ className: "", html: `<div class="nav-car">${this._vehSvg()}</div>`,
          iconSize: [47, 47], iconAnchor: [23.5, 23.5] }), zIndexOffset: 900, isMe: true }).addTo(this._markerLayer);
    }
  }

  // centra la mappa su un punto (zoom alla Leaflet). In 3D si sposta la vista 3D: la mappa 2D è nascosta e il suo
  // spostamento non arrivava alla 3D ("Centra" non faceva niente); a fine movimento la 2D la segue da sola
  _flyTo(lat, lon, z = 15, behind = false) {
    const g = this._g3;
    if (this._3d && g && this._g3ok) {
      // durante il volo la sincronizzazione con la 2D (ancora sul punto di prima) non deve riportarla indietro
      this._g3flying = true;
      g.once("moveend", () => {
        this._g3flying = false;
        const cc = g.getCenter(); // anche la 2D sul punto: tornando al 2D si è già lì
        this._from3d = true;
        try { this._map.setView([cc.lat, cc.lng], g.getZoom() - Z3D, { animate: false }); } finally { setTimeout(() => { this._from3d = false; }, 0); }
      });
      setTimeout(() => { this._g3flying = false; }, 2500); // sicurezza
      // "Centra" sulla propria posizione: quasi dietro l'auto come in guida (distanza, inclinazione e direzione di marcia)
      const cam = behind
        ? { zoom: 16 + this._zoom3dOff(), pitch: this._pitch3d(), bearing: this._meDir ?? g.getBearing() }
        : { zoom: z + Z3D };
      g.flyTo({ center: [lon, lat], ...cam, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 900, essential: true });
      return;
    }
    this._map.flyTo([lat, lon], z, { duration: 0.8 });
  }

  // fonte della posizione scelta in "Segui la posizione di" (anche prima di partire)
  _meSource() {
    const list = this._navSources();
    const v = this.shadowRoot.getElementById("navsrc")?.value;
    return list.some((x) => x.id === v && x.ok) ? v : this._defaultNavSource(list);
  }

  // "La mia posizione" (punto blu): quella della fonte scelta in "Segui la posizione di", cioè persona o dispositivo di
  // Home Assistant (si aggiorna da solo) oppure il GPS di questo dispositivo
  _locate(fly, src = this._meSource()) {
    if (src && src !== "gps") {
      const st = this._hass?.states?.[src];
      if (st?.attributes?.latitude != null) {
        this._meTurn(st.attributes.latitude, st.attributes.longitude);
        this._me = { lat: st.attributes.latitude, lon: st.attributes.longitude, src, upd: st.last_updated };
        this._drawMarkers();
        if (fly) this._flyTo(this._me.lat, this._me.lon, 15, true);
        return Promise.resolve(this._me);
      }
    }
    return this._locateDevice(fly, "me");
  }

  // GPS (o stima del browser) di questo dispositivo: nel punto blu ("me") o nel segnaposto grigio ("dev")
  _locateDevice(fly, target = "me") {
    const put = (lat, lon) => {
      const p = { lat, lon, src: "gps" };
      if (target === "dev") this._dev = p; else this._me = p;
      this._drawMarkers();
      if (fly) this._flyTo(lat, lon, 15, target === "me");
      return p;
    };
    return new Promise((resolve) => {
      const android = this._companion() === "android";
      // app Android: se il GPS della pagina non risponde si ripiega sulla propria persona
      const fromPerson = () => {
        const me = this._myPerson();
        const st = me && this._hass.states[me.id];
        if (!st) return false;
        resolve(put(st.attributes.latitude, st.attributes.longitude));
        return true;
      };
      if (android && !(window.isSecureContext && window.navigator.geolocation)) {
        if (!fromPerson()) { this._gpsHelp(true); resolve(null); }
        return;
      }
      if (!window.navigator.geolocation) { this._msg("Questo browser non fornisce la posizione"); resolve(null); return; }
      if (!window.isSecureContext) {
        this._msg("La posizione del dispositivo richiede Home Assistant in HTTPS (o l'app Companion)");
        resolve(null);
        return;
      }
      window.navigator.geolocation.getCurrentPosition((pos) => {
        resolve(put(pos.coords.latitude, pos.coords.longitude));
      }, (err) => {
        if (android && fromPerson()) return;
        if (err.code === 1) this._gpsHelp();
        else this._msg(`Posizione non disponibile: ${err.message}`);
        resolve(null);
      }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
    });
  }

  // ----------------------------------------------------------------- navigazione con ricalcolo automatico

  // fonti della posizione: GPS del browser (solo in HTTPS) o entità di Home Assistant aggiornate dall'app Companion
  _navSources() {
    const secure = window.isSecureContext && !!window.navigator.geolocation;
    const out = [{ id: "gps", name: secure ? "📱 GPS di questo dispositivo" : "📱 GPS di questo dispositivo (serve HTTPS)", ok: secure }];
    // casa: le coordinate impostate in Home Assistant (zona "Casa"), sempre disponibili e senza attese
    const home = this._hass?.states?.["zone.home"];
    if (home?.attributes?.latitude != null && home.attributes.longitude != null) {
      out.push({ id: "zone.home", name: `🏠 ${home.attributes.friendly_name || "Casa"} (posizione di Home Assistant)`, ok: true });
    }
    for (const [id, st] of Object.entries(this._hass?.states || {})) {
      if (!id.startsWith("person.") && !id.startsWith("device_tracker.")) continue;
      if (st.attributes.latitude == null || st.attributes.longitude == null) continue;
      const age = Date.now() - Date.parse(st.last_updated);
      out.push({ id, name: `${id.startsWith("person.") ? "👤" : "📡"} ${st.attributes.friendly_name || id}`, ok: true,
        age, ageText: fmtAge(age) });
    }
    return out;
  }

  _myPerson(list = this._navSources()) {
    const uid = this._hass?.user?.id;
    return list.find((s) => s.id.startsWith("person.") && s.ok && this._hass.states[s.id].attributes.user_id === uid)
      || list.find((s) => s.id.startsWith("person.") && s.ok) || list.find((s) => s.id !== "gps" && s.ok) || null;
  }

  _defaultNavSource(list) {
    let saved = null;
    try { saved = localStorage.getItem(`${STORE_KEY}-navsrc`); } catch (e) { /* storage non disponibile */ }
    // Home Assistant aperto dal browser (PC, non le app): il GPS del computer non risponde o è solo una stima e la
    // posizione di una persona può essere vecchia (si chiedeva al telefono e si restava ad aspettare). Si parte da casa,
    // a meno che sia stata scelta una persona/dispositivo con una posizione recente.
    if (!this._companion() && list.some((s) => s.id === "zone.home")) {
      const sv = saved && list.find((s) => s.id === saved && s.ok && s.id !== "gps");
      return sv && !(sv.age > STALE_MS) ? saved : "zone.home";
    }
    if (saved && list.some((s) => s.id === saved && s.ok)) return saved;
    // nell'app Android il GPS si può scegliere, ma di norma si parte dalla propria persona, che funziona sempre
    // (non in NaviHA, che passa il GPS del telefono alla pagina anche in http)
    if (this._companion() === "android" && !this._isNaviHA()) { const me = this._myPerson(list); if (me) return me.id; }
    if (list[0]?.ok) return "gps";
    const uid = this._hass?.user?.id;
    const mine = list.find((s) => s.id.startsWith("person.") && this._hass.states[s.id].attributes.user_id === uid);
    return (mine || list.find((s) => s.ok) || list[0])?.id;
  }

  // Veicolo (sopra l'itinerario) e "Segui la posizione di" (sopra Calcola percorso): sempre visibili, anche senza percorso
  _renderPlanSel() {
    const vb = this.$("vehsec");
    const sb = this.$("srcbox");
    if (!vb || !sb) return;
    const curV = this._vehicleId();
    vb.innerHTML = `<h3>Veicolo <span class="vprev"></span></h3><select class="inp" id="navveh">${this._vehicles().map((v) => `<option value="${esc(v.id)}" ${v.id === curV ? "selected" : ""}>${
      v.type ? vehIcon(v.type) : "🧭"} ${esc(v.name || "Veicolo")}${v.plate ? ` · ${esc(v.plate)}` : ""}</option>`).join("")}</select>`;
    const list = this._navSources();
    const curS = sb.querySelector("#navsrc")?.value;
    // finché non la sceglie l'utente, la fonte segue quella predefinita (es. la zona Casa arriva dopo il primo disegno)
    const def = this._srcPicked && list.some((x) => x.id === curS && x.ok) ? curS : this._defaultNavSource(list);
    // accanto a persone e dispositivi: da quanto è aggiornata la loro posizione (⚠ se vecchia)
    sb.innerHTML = `<label class="muted" style="display:block;margin-bottom:4px">Segui la posizione di</label>
      <select class="inp" id="navsrc">${list.map((x) => `<option value="${esc(x.id)}" ${x.id === def ? "selected" : ""} ${x.ok ? "" : "disabled"}>${esc(x.name)}${
        x.ageText ? ` · ${x.age > STALE_MS ? "⚠ " : ""}${esc(x.ageText)}` : ""}</option>`).join("")}</select>`;
    vb.querySelector("#navveh").addEventListener("change", (e) => {
      try { localStorage.setItem(`${STORE_KEY}-veh`, e.target.value); } catch (err) { /* storage non disponibile */ }
      this._vehSel = e.target.value;
      this._hass.callWS({ type: "navigator/garage_select", vehicle_id: e.target.value }).catch(() => { /* integrazione vecchia */ });
      this._applyVehicle(true);
      if (this._result) this._renderResults();
      this._syncSplashes();
      this._carReassign(e.target.value);
    });
    this._applyVehicle(false);
    sb.querySelector("#navsrc").addEventListener("change", (e) => {
      try { localStorage.setItem(`${STORE_KEY}-navsrc`, e.target.value); } catch (err) { /* storage non disponibile */ }
      this._srcPicked = true;
      this._idleWatchSync();
      if (this._me) this._locate(false, e.target.value);
      if (this._result) this._renderResults();
    });
  }

  // tempo con traffico dal sensore scelto (Waze Travel Time o simili): { sec, name } oppure null
  _trafficEta() {
    const id = this._settings.trafficSensor;
    const st = id && this._hass?.states?.[id];
    if (!st) return null;
    const v = parseFloat(st.state);
    if (!isFinite(v) || v <= 0) return null;
    const u = (st.attributes.unit_of_measurement || "min").toLowerCase();
    const sec = u === "s" ? v : u === "h" ? v * 3600 : v * 60; // di norma i minuti
    return { sec, name: st.attributes.friendly_name || id };
  }

  _navSectionHtml() {
    if (this._nav) {
      const src = this._navSources().find((s) => s.id === this._nav.source);
      return `<div class="sec"><h3>Navigazione attiva</h3>
        <div class="row"><button class="primary" data-a="navstop" style="flex:1;background:#c62828;border-color:#c62828">■ Ferma navigazione</button></div>
        <div class="muted" style="margin-top:6px">Posizione da: ${esc(src?.name || this._nav.source)}. Se esci dal percorso per qualche secondo,
          Navigator ricalcola la strada da dove sei.</div></div>`;
    }
    const list = this._navSources();
    const hint = this._companion() === "android" && !this._isNaviHA()
      ? `<div class="muted" style="margin-top:6px">Nell'app Android puoi provare il GPS del dispositivo; se l'app non lo passa alla pagina
         scegli la tua persona. Per seguirti bene in auto con la persona attiva
         nell'app la posizione ad alta precisione (Impostazioni → App Companion → Gestisci sensori → Posizione in background →
         Modalità alta precisione).</div>`
      : window.isSecureContext ? ""
      : `<div class="muted" style="margin-top:6px">Home Assistant è aperto in http: il browser non concede il GPS. Usa la posizione che l'app
         Companion invia a Home Assistant; per aggiornamenti ogni pochi secondi attiva nell'app la posizione ad alta precisione
         (Impostazioni → App Companion → Gestisci sensori → Posizione in background → Modalità alta precisione).</div>`;
    const src = list.find((x) => x.id === this._meSource());
    const veh = this._curVehicle();
    const md = MODES.find((m) => m[0] === this._mode) || MODES[0];
    return `<div class="sec"><h3>Navigazione</h3>
      <div class="muted">${veh.type ? `${vehIcon(veh.type)} ${esc(veh.name || "Veicolo")}${veh.plate ? ` · ${esc(veh.plate)}` : ""}` : `${md[1]} ${md[2]}`} · posizione da ${esc(src?.name || "—")}</div>
      <div class="row" style="margin-top:8px"><button class="primary" data-a="navstart" style="flex:1">▶ Parti</button></div>${hint}
      <button class="link" data-a="devpos" style="margin-top:6px;padding-left:0;display:block">📱 Mostra la posizione di questo dispositivo</button>
      <button class="link" data-a="gpshelp" style="margin-top:2px;padding-left:0">📡 Problemi con il GPS? Posizione negata?</button></div>`;
  }

  async _startNav(source, force = false) {
    if (this._stepK != null) this._stepClose(); // in guida la barra in alto è della guida
    if (!this._result) return;
    // app NaviHA con Android Auto collegato: il percorso (partenza, tappe, arrivo, mezzo, opzioni) va all'auto,
    // dove parte la guida; il telefono non naviga in parallelo
    if (window.NaviHAApp?.carConnected?.()) {
      const spec = { points: this._points, mode: this._mode, avoid: this._avoid, excluded: this._excluded, source: "gps" };
      let sent = false;
      try { sent = window.NaviHAApp.sendToCar(JSON.stringify(spec)); } catch (e) { /* app vecchia */ }
      if (sent) { this._msg("Percorso inviato ad Android Auto: la guida parte sullo schermo dell'auto"); return; }
    }
    // persona o dispositivo con una posizione vecchia: la guida partirebbe da lì (es. app Companion chiusa)
    if (source !== "gps" && !source.startsWith("zone.") && !force) { // casa: posizione fissa, mai "vecchia"
      const st = this._hass?.states?.[source];
      const age = st ? Date.now() - Date.parse(st.last_updated) : 0;
      if (age > STALE_MS) {
        // telefono con l'app Companion: prima gli si chiede la posizione (arriva in pochi secondi se l'app è installata)
        if (this._phoneOf(source)) { this._askPhoneThenStart(source, age); return; }
        this._staleHelp(source, age);
        return;
      }
    }
    if (source === "gps" && !(window.isSecureContext && window.navigator.geolocation)) {
      this._msg("Il GPS del browser richiede Home Assistant in HTTPS: scegli la posizione dell'app Companion");
      return;
    }
    try { localStorage.setItem(`${STORE_KEY}-navsrc`, source); } catch (e) { /* storage non disponibile */ }
    this._sel = 0;
    this._tripFrom = this._points[0]?.name || "";
    const tv = this._curVehicle();
    this._tripVehicle = tv.type ? tv : { id: "base", name: "Base", plate: "", type: { piedi: "altro" }[this._mode] || this._mode };
    this._nav = { source, follow: true, idx: 0, passed: 0, offSince: null, offCount: 0, rerouting: false, lastReroute: 0,
      lastKey: null, fix: null, arrived: false, view: "guida", dir: null };
    this._idleWatchSync(); // in guida il GPS lo segue la guida
    this._autoDestHide();
    this._tripBegin();
    this.$("ctltr").hidden = true;
    this._unlockAudio();
    this._drawRoute();
    this._drawMarkers();
    this._renderResults();
    this._buildNavBar();
    this._applyView();
    this._renderNav();
    this._updateAwake(); // schermo acceso durante la guida
    if (!this._full) this._toggleFull(true); // schermo intero automatico alla partenza (il tasto Parti è un gesto dell'utente)
    this._carSide(false); // in auto il pannello di sinistra si chiude e il tasto ☰ sparisce
    if (source !== "gps") this._phoneGuida(true);
    if (source === "gps") {
      this._nav.watch = window.navigator.geolocation.watchPosition(
        (pos) => (this._fixAt = Date.now(), this._onFix({ lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy || 0,
          heading: pos.coords.heading, speed: pos.coords.speed })),
        (err) => {
          if (err.code === 1) { this._stopNav(); this._gpsHelp(); return; } // permesso negato
          this._navPopup("warn", "📡", `GPS non disponibile: ${esc(err.message)}`, 4000);
        },
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
    } else {
      this._entityFix();
    }
  }

  // app NaviHA sullo schermo dell'auto: prende il percorso mandato dal telefono (se c'è), lo calcola e parte
  async _takeHandoff() {
    let raw = "";
    try { raw = window.NaviHAApp?.takeHandoff?.() || ""; } catch (e) { /* app vecchia */ }
    if (!raw) return false;
    let h;
    try { h = JSON.parse(raw); } catch (e) { return false; }
    if (!Array.isArray(h.points) || h.points.length < 2 || !h.points.every((p) => p && p.lat != null && p.lon != null)) return false;
    if (this._nav) this._stopNav();
    this._points = h.points;
    if (h.mode) this._mode = h.mode;
    if (h.avoid) this._avoid = { ...this._avoid, ...h.avoid };
    if (Array.isArray(h.excluded)) this._excluded = h.excluded;
    this._saveState();
    this._renderModes();
    this._renderPoints();
    this._drawMarkers();
    await this._compute(true);
    if (!this._result) return true; // percorso non calcolabile: resta l'errore a schermo
    this._startNav(h.source || "gps", true);
    return true;
  }

  _stopNav() {
    const nav = this._nav;
    if (!nav) return;
    this._tunnelExit();
    clearInterval(this._tunWatchT); this._tunWatchT = null;
    clearTimeout(this._rotUserT); this._rotUser = 0;
    this._tripEnd(nav);
    this._hass.callWS({ type: "navigator/live", active: false }).catch(() => { /* sensori non aggiornati */ });
    if (nav.watch != null) window.navigator.geolocation.clearWatch(nav.watch);
    this._phoneGuida(false, nav);
    clearTimeout(nav.popTimer);
    this._nav = null;
    this._spdBox(null, false); // via il riquadro della velocità
    this._navClock(null); // la croce torna a mostrare solo l'ora attuale
    this._idleWatchSync();
    this._updateAwake();
    this._meMarker?.remove();
    this._accCircle?.remove();
    this._meMarker = this._accCircle = null;
    this._me3d?.remove();
    this._me3d = null;
    this._g3?.getSource("veh3d")?.setData({ type: "FeatureCollection", features: [] });
    this._plate3dAt = null;
    this._placePlate3d();
    this._carRot = null;
    cancelAnimationFrame(this._carRaf); // ferma lo scorrimento del mezzo 3D
    this._carAnim = null;
    this._carDisp = null;
    this._closeNearby();
    if (this._full && !this._isCarScreen()) this._toggleFull(false); // esce dallo schermo intero al Ferma (non in auto)
    this._carSide(false);
    for (const id of ["navtop", "navbot", "navpop"]) this.$(id).hidden = true;
    this._placePitchCtl();
    this.$("ctltr").hidden = false;
    this._applyView();
    this._drawRoute();
    this._drawMarkers();
    this._renderResults();
  }

  // nuova posizione dell'entità seguita (arriva con ogni aggiornamento di hass)
  _entityFix() {
    const st = this._hass?.states?.[this._nav.source];
    if (!st) return;
    const { latitude: lat, longitude: lon, gps_accuracy: acc } = st.attributes;
    if (lat == null || lon == null) return;
    const key = `${lat},${lon},${st.last_updated}`;
    if (key === this._nav.lastKey) return;
    this._nav.lastKey = key;
    // la persona non ha velocità e direzione: si leggono dal dispositivo che le fornisce la posizione
    const tr = this._hass.states[st.attributes.source] || st;
    const num = (v) => (typeof v === "number" && v >= 0 ? v : null);
    this._onFix({ lat, lon, acc: acc || 0, speed: num(tr.attributes.speed), heading: num(tr.attributes.course) });
  }

  // geometria del percorso: distanze progressive (m) e inizio di ogni tappa
  _geom(rt) {
    if (rt._cum) return rt;
    const cum = [0];
    for (let i = 1; i < rt.shape.length; i++) cum.push(cum[i - 1] + distM(rt.shape[i - 1], rt.shape[i]));
    rt._cum = cum;
    rt._legStart = [];
    for (const m of rt.maneuvers) if (rt._legStart[m.leg] == null) rt._legStart[m.leg] = m.begin;
    return rt;
  }

  // punto del percorso più vicino alla posizione: prima vicino all'ultimo, poi su tutto il percorso
  _snap(rt, pos, from) {
    const sh = rt.shape;
    const best = { dist: Infinity, idx: 0, t: 0 };
    const scan = (a, b) => {
      for (let i = Math.max(0, a); i < Math.min(sh.length - 1, b); i++) {
        const r = segDist(pos, sh[i], sh[i + 1]);
        if (r.dist < best.dist) Object.assign(best, r, { idx: i });
      }
    };
    scan(from - 30, from + 1500);
    if (best.dist > 60) scan(0, sh.length);
    if (sh.length === 1) best.dist = distM([pos.lat, pos.lon], sh[0]);
    const c = rt._cum;
    best.along = c[best.idx] + best.t * ((c[best.idx + 1] ?? c[best.idx]) - c[best.idx]);
    return best;
  }

  _onFix(fix) {
    const nav = this._nav;
    if (!nav || !this._result) return;
    const now = Date.now();
    if (nav.tun && this._tunnelGate(fix, now)) return; // in galleria: posizione stimata, il GPS non sposta la guida
    const prev = nav.fix;
    if (prev && !prev.est) { const gap = now - prev.time; if (gap > 0 && gap < 60000) nav.gapAvg = nav.gapAvg ? nav.gapAvg * 0.7 + gap * 0.3 : gap; }
    if (prev && distM([prev.lat, prev.lon], [fix.lat, fix.lon]) > 3) {
      nav.heading = bearing([prev.lat, prev.lon], [fix.lat, fix.lon]);
    }
    // velocità (m/s): quella del GPS o dell'app, altrimenti dallo spostamento fra due posizioni
    let speed = typeof fix.speed === "number" && !Number.isNaN(fix.speed) && fix.speed >= 0 ? fix.speed : null;
    if (speed == null && prev && now - prev.time > 800) speed = distM([prev.lat, prev.lon], [fix.lat, fix.lon]) / ((now - prev.time) / 1000);
    if (speed != null) nav.speed = nav.speed == null ? speed : nav.speed * 0.4 + speed * 0.6;
    nav.fix = { ...fix, time: now };
    this._tripPoint(fix);

    const rt = this._geom(this._result.routes[this._sel]);
    const snap = this._snap(rt, fix, nav.idx);
    const slow = this._mode === "piedi" || this._mode === "bici";
    // tolleranza: strada + imprecisione del GPS
    const limit = (slow ? 30 : 45) + Math.min(fix.acc || 0, 80);
    nav.snap = snap;
    this._routeProgress();
    nav.dir = this._direction(rt, snap, fix, limit);
    // posizione mostrata (mezzo e telecamera): all'avvio, finché non ci si muove davvero, sta sull'inizio della linea del
    // percorso; appena ti muovi davvero (oltre ~12 m o >2,5 m/s) passa alla posizione GPS reale
    nav.startPos = nav.startPos || [fix.lat, fix.lon];
    // "ti stai muovendo davvero": soprattutto dalla velocità (il rumore del GPS da fermo sposta la posizione di decine di metri,
    // quindi la sola distanza non basta); in alternativa uno spostamento ampio dal punto di partenza
    if (!nav.started && ((nav.speed || 0) > 2.5 || distM(nav.startPos, [fix.lat, fix.lon]) > 40)) nav.started = true;
    if (!nav.started && rt.shape.length > 1) {
      nav.disp = { lat: rt.shape[0][0], lon: rt.shape[0][1] };
      let j = 1;
      while (j < rt.shape.length - 1 && rt._cum[j] < 20) j++;
      nav.dir = bearing(rt.shape[0], rt.shape[j]); // muso e mappa allineati all'inizio della linea
    } else {
      nav.disp = { lat: fix.lat, lon: fix.lon };
    }
    this._carGlide(prev, nav.disp, nav.dir ?? nav.heading ?? 0, now); // mezzo 3D fluido, sempre rivolto nel verso di marcia
    this._tileAhead(rt, snap.along);
    this._drawMe();
    this._applyRotation();
    if (nav.follow) this._followView();

    const total = rt._cum[rt._cum.length - 1];
    const dest = this._points[this._points.length - 1];
    const toDest = distM([fix.lat, fix.lon], [dest.lat, dest.lon]);
    if (nav.arrived && toDest > 150) nav.arrived = false; // ripartito: si continua a guidare
    // Ferma automatico: a meno di 10 m dalla destinazione (o dalla fine del percorso sulla strada) la guida si ferma da sola
    if (toDest < 10 || (snap.dist < limit && total - snap.along < 10)) {
      if (!nav.arrived && !this._settings.muteGuide) this._speak(PHRASES[this._settings.lang].arrived, true);
      this._autoStop(dest);
      return;
    }
    if (!nav.arrived && (toDest < 35 || (snap.dist < limit && total - snap.along < 25))) {
      nav.arrived = true;
      this._renderNav();
      this._navPopup("ok", "🏁", `Sei arrivato a ${esc(dest.name)}`, 8000);
      if (!this._settings.muteGuide) this._speak(PHRASES[this._settings.lang].arrived, true);
      return;
    }
    if (nav.arrived) { this._renderNav(); return; }

    if (snap.dist > limit) {
      // fuori percorso: si aspetta qualche secondo (e almeno due posizioni) prima di ricalcolare
      if (nav.offSince == null) nav.offSince = now;
      nav.offCount += 1;
      const offline = window.navigator.onLine === false || this._netOk === false;
      if (offline && now - nav.offSince >= OFF_ROUTE_MS && !nav.offlineWarned) {
        // senza rete il percorso non si può ricalcolare: un avviso solo, poi si continua sul percorso di prima
        nav.offlineWarned = true;
        this._navPopup("warn", "📵", "Fuori percorso, senza rete<br><b>Ricalcolo appena torna la connessione</b>", 6000);
      }
      if (!offline && !nav.rerouting && now - nav.offSince >= OFF_ROUTE_MS && nav.offCount >= 2 && (now - nav.lastReroute > 12000 || nav.offlineWarned)) {
        nav.offlineWarned = false; // rete tornata: si ricalcola subito
        this._reroute(fix);
      }
    } else {
      nav.offSince = null;
      nav.offCount = 0;
      nav.offlineWarned = false; // tornati sul percorso: un'altra uscita senza rete avviserà di nuovo
      nav.idx = snap.idx;
      for (let leg = 1; leg < rt._legStart.length; leg++) if (snap.idx >= rt._legStart[leg]) nav.passed = Math.max(nav.passed, leg);
      if (!nav.rerouting) this._voiceGuide(rt, snap.along);
      // galleria: entrando nel tratto la si "arma" (60 m prima dell'imbocco), ma l'animazione e la posizione stimata
      // partono SOLO se il GPS si perde davvero (niente posizioni per un po' o precisione pessima). Sui ponti o dove il
      // segnale resta buono si continua col GPS vero: niente animazione per sbaglio.
      // Gallerie lunghe (≥ 200 m): si entra SUBITO all'imbocco, senza aspettare che il GPS si perda (in galleria il
      // telefono continua a mandare posizioni stimate e imprecise, che prima ritardavano l'animazione di 10-20 s).
      // Gallerie corte: solo se il GPS buono (precisione ≤ 25 m) manca davvero da un po'. Una galleria appena uscita
      // non riparte (prima entrava e usciva di continuo: animazione e mappa sfarfallavano).
      const r = this._tunnelRanges(rt).find(([a, b]) => snap.along >= a - 60 && snap.along < b - 40 && b !== nav.tunDone);
      if (r && !nav.tun) {
        const good = (fix.acc || 99) <= 25;
        if (r[1] - r[0] >= 200 && snap.along >= r[0] - 5) { nav.tunArm = null; this._tunnelEnter(rt, r, snap.along, now); }
        else {
          nav.tunArm = { rt, r, along: good || !nav.tunArm ? snap.along : nav.tunArm.along, t: good || !nav.tunArm ? now : nav.tunArm.t };
          if ((fix.acc || 0) > 60) { nav.tunArm = null; this._tunnelEnter(rt, r, snap.along, now); } else this._tunnelWatch();
        }
      } else if (!r) nav.tunArm = null;
    }
    this._speedCheck(rt, snap.dist <= limit ? snap.idx : null);
    if (snap.dist <= limit) this._cameraCheck(rt, snap.along);
    this._renderNav();
  }

  // ----------------------------------------------------------------- gallerie
  // Riconosciute dalle strade in galleria di OpenStreetMap (mappe vettoriali OpenFreeMap, scaricate dalla vista 3D man mano
  // che la zona si carica): i tratti del percorso che le seguono diventano "in galleria". In guida, dentro la galleria,
  // il GPS si perde o salta (spesso sulla strada sopra la collina): la posizione avanza sul percorso alla velocità
  // d'ingresso, compare l'animazione del tunnel e non si ricalcola, finché il GPS non ritrova l'uscita.

  _scheduleTunnels() {
    clearTimeout(this._tunTimer);
    this._tunTimer = setTimeout(() => this._collectTunnels(), 400);
  }

  _collectTunnels() {
    const g = this._g3;
    if (!g || !this._g3ok || !g.getSource("ofm")) return;
    let feats = [];
    try {
      feats = g.querySourceFeatures("ofm", { sourceLayer: "transportation", filter: ["==", ["get", "brunnel"], "tunnel"] });
    } catch (e) { return; }
    const roads = new Set(["motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service"]);
    this._tunGeoms ??= new Map();
    let added = 0;
    for (const f of feats) {
      if (!roads.has(String(f.properties?.class || "").replace(/_construction$/, ""))) continue;
      const geom = f.geometry;
      const lines = geom.type === "LineString" ? [geom.coordinates] : geom.type === "MultiLineString" ? geom.coordinates : [];
      for (const ln of lines) {
        if (ln.length < 2) continue;
        const key = ln.map((c) => `${c[0].toFixed(5)},${c[1].toFixed(5)}`).join(";");
        if (this._tunGeoms.has(key)) continue;
        const pts = ln.map((c) => [c[1], c[0]]);
        const lats = pts.map((p) => p[0]);
        const lons = pts.map((p) => p[1]);
        this._tunGeoms.set(key, { pts, box: [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)] });
        added++;
      }
    }
    if (!added) return;
    this._tunVer = (this._tunVer || 0) + 1;
    const rt = this._result?.routes[this._sel];
    if (!rt) return;
    const before = JSON.stringify(rt._tun?.list || []);
    if (JSON.stringify(this._tunnelRanges(rt)) !== before) this._drawRoute();
  }

  // tratti del percorso in galleria, in metri dall'inizio: [[da, a], ...]
  _tunnelRanges(rt) {
    if (!rt || !this._tunGeoms?.size) return [];
    if (rt._tun && rt._tun.ver === this._tunVer) return rt._tun.list;
    this._geom(rt);
    const sh = rt.shape;
    const c = rt._cum;
    const pad = 0.00025; // ~25 m
    const mark = new Uint8Array(Math.max(0, sh.length - 1));
    for (const { pts, box } of this._tunGeoms.values()) {
      for (let i = 0; i < sh.length - 1; i++) {
        const m = [(sh[i][0] + sh[i + 1][0]) / 2, (sh[i][1] + sh[i + 1][1]) / 2];
        if (m[0] < box[0] - pad || m[0] > box[2] + pad || m[1] < box[1] - pad || m[1] > box[3] + pad) continue;
        const pos = { lat: m[0], lon: m[1] };
        for (let k = 0; k < pts.length - 1; k++) {
          if (segDist(pos, pts[k], pts[k + 1]).dist < 8) { mark[i] = 1; break; } // stretto: un ponte sopra un tunnel non conta
        }
      }
    }
    const list = [];
    for (let i = 0; i < mark.length; i++) {
      if (!mark[i]) continue;
      let j = i;
      while (j + 1 < mark.length && (mark[j + 1] || (mark[j + 2] && c[j + 2] - c[j + 1] < 30))) j++;
      if (c[j + 1] - c[i] >= 60) list.push([Math.round(c[i]), Math.round(c[j + 1])]);
      i = j;
    }
    rt._tun = { ver: this._tunVer, list };
    return list;
  }

  // punti del percorso fra due distanze dall'inizio
  _sliceAlong(rt, a, b) {
    const out = [this._pointAt(rt, a).ll];
    const c = rt._cum;
    for (let i = 0; i < rt.shape.length; i++) if (c[i] > a && c[i] < b) out.push(rt.shape[i]);
    out.push(this._pointAt(rt, b).ll);
    return out;
  }

  // posizione sul percorso a una certa distanza dall'inizio, con la direzione della strada
  _pointAt(rt, along) {
    const sh = rt.shape;
    const c = rt._cum;
    let lo = 0;
    let hi = c.length - 1;
    while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (c[mid] <= along) lo = mid; else hi = mid; }
    const i = Math.min(lo, sh.length - 2);
    const len = c[i + 1] - c[i];
    const t = len > 0 ? Math.max(0, Math.min(1, (along - c[i]) / len)) : 0;
    const ll = [sh[i][0] + t * (sh[i + 1][0] - sh[i][0]), sh[i][1] + t * (sh[i + 1][1] - sh[i][1])];
    return { ll, idx: i, t, dir: bearing(sh[i], sh[i + 1]) };
  }

  // galleria "armata": se le posizioni smettono di arrivare (più a lungo del solito) il GPS si è perso → si entra
  _tunnelWatch() {
    if (this._tunWatchT) return;
    this._tunWatchT = setInterval(() => {
      const nav = this._nav;
      const arm = nav?.tunArm;
      if (!nav || !arm || nav.tun) { clearInterval(this._tunWatchT); this._tunWatchT = null; return; }
      const gap = Date.now() - arm.t;
      const wait = Math.max(2500, Math.min(6000, (nav.gapAvg || 1000) * 2.5));
      if (gap > wait) { nav.tunArm = null; this._tunnelEnter(arm.rt, arm.r, arm.along, arm.t); }
    }, 1000);
  }

  _tunnelEnter(rt, [a, b], along, t0 = Date.now()) {
    const nav = this._nav;
    const v = Math.max(0, nav.speed || 0);
    // la stima parte dall'ultima posizione buona (e dal suo momento): il mezzo è già andato avanti nel frattempo.
    // Durata massima: il tempo per attraversarla con un buon margine (prima era almeno 90 s e la vista restava ferma)
    nav.tun = { rt, start: a, end: b, along0: along, t0, since: Date.now(), speed: v,
      maxMs: Math.max(25000, ((b - along) / Math.max(v, 3)) * 1500 + 20000) };
    clearInterval(this._tunTick);
    this._tunTick = setInterval(() => this._tunnelStep(), 1000);
    this._tunnelStep();
  }

  _tunnelExit() {
    clearInterval(this._tunTick);
    this._tunTick = null;
    if (this._nav) {
      this._nav.tunDone = this._nav.tun?.end ?? this._nav.tunDone; // questa galleria non riparte
      this._nav.tun = null;
      this._nav.userFrame = false; // all'uscita si ricentra sul mezzo
    }
    this._g3key = null;
    this._tunnelFx();
  }

  // posizione GPS durante la galleria: vale solo se è sul percorso, precisa e più avanti; all'uscita si torna al GPS
  _tunnelGate(fix, now) {
    const nav = this._nav;
    const t = nav.tun;
    const rt = this._geom(this._result.routes[this._sel]);
    if (t.rt !== rt) { this._tunnelExit(); return false; } // percorso cambiato
    const snap = this._snap(rt, fix, nav.idx);
    const limit = 45 + Math.min(fix.acc || 0, 80);
    // si esce solo con un GPS preciso oltre lo sbocco (le posizioni stimate del telefono in galleria non bastano)
    const good = (fix.acc || 99) <= 25;
    if ((good && snap.dist <= limit && snap.along >= t.end - 30) || now - t.since > t.maxMs) {
      this._tunnelExit();
      return false; // uscita (o stima scaduta): la posizione si usa normalmente
    }
    const cur = t.along0 + (t.speed * (now - t.t0)) / 1000;
    if (snap.dist <= 20 && (fix.acc || 99) <= 25 && snap.along > cur - 30 && snap.along < t.end) {
      t.along0 = snap.along; // GPS buono dentro la galleria (gallerie corte o con ripetitori): si riparte da lì
      t.t0 = now;
      this._tunnelStep();
    }
    return true;
  }

  _tunnelStep() {
    const nav = this._nav;
    const t = nav?.tun;
    if (!t) return;
    const now = Date.now();
    const rt = t.rt;
    const along = Math.min(t.end - 1, t.along0 + (t.speed * (now - t.t0)) / 1000);
    // arrivata all'uscita senza GPS: dopo qualche secondo si esce dalla modalità galleria (non si resta "incagliati")
    if (along >= t.end - 1) {
      t.atEnd = t.atEnd || now;
      if (now - t.atEnd > 5000 || now - t.since > t.maxMs) { this._tunnelExit(); return; }
    }
    const p = this._pointAt(rt, along);
    const prevFix = nav.fix;
    nav.fix = { lat: p.ll[0], lon: p.ll[1], acc: 0, speed: t.speed, heading: p.dir, time: now, est: true };
    // la posizione mostrata (camera) e il mezzo 3D avanzano con la stima, non restano all'imbocco
    nav.disp = { lat: p.ll[0], lon: p.ll[1] };
    this._carGlide(prevFix, nav.disp, p.dir, now);
    nav.snap = { dist: 0, idx: p.idx, t: p.t, along };
    this._routeProgress();
    nav.idx = p.idx;
    nav.dir = p.dir;
    nav.offSince = null;
    nav.offCount = 0;
    this._drawMe();
    this._applyRotation();
    if (nav.follow) this._followView();
    // anche la telecamera 3D segue la posizione stimata: così, quando l'animazione si toglie
    // all'uscita, la vista è già sul mezzo e non "perde" il centro
    if (nav.follow && this._3d && this._g3 && this._g3ok) this._sync3d();
    if (!nav.rerouting) this._voiceGuide(rt, along);
    this._renderNav();
  }

  // animazione della galleria: in guida, mentre si è dentro
  _tunnelFx() {
    const el = this.$("tunfx");
    if (!el) return;
    const t = this._nav?.tun;
    if (this._dbgTun) return; // prova in corso (debug): la guida non la tocca
    const show = !!t && this._isGuida() && this._settings.tunnelFx !== false && (this._nav.snap?.along ?? 0) >= t.start - 10;
    if (!show) {
      el.classList.remove("on");
      if (!el.hidden) setTimeout(() => { if (!el.classList.contains("on")) { el.hidden = true; this.$("mapwrap")?.classList.remove("tunon"); } }, 350);
      this._tunnelVisitors(false);
      return;
    }
    if (el.hidden) {
      el.hidden = false;
      requestAnimationFrame(() => { el.classList.add("on"); setTimeout(() => { if (el.classList.contains("on")) this.$("mapwrap")?.classList.add("tunon"); }, 320); });
    }
    this._tunnelVisitors(true);
    const v = t.speed || 0;
    el.style.setProperty("--tfd", `${Math.max(0.8, Math.min(3.5, 3.5 - v * 0.09)).toFixed(2)}s`);
    const left = Math.max(0, t.end - (this._nav.snap?.along ?? t.start));
    this.$("tunrem").textContent = v > 0.5 ? `uscita tra circa ${fmtDist(left)}` : `galleria di ${fmtDist(t.end - t.start)}`;
  }

  // debug: animazione della galleria per una data scelta (stagione dei visitatori), 40 s o fino a "Ferma"
  _debugTunnel(dateStr) {
    const el = this.$("tunfx");
    clearTimeout(this._dbgTunT);
    if (!el) return;
    if (!dateStr) {
      this._dbgTun = false;
      this.$("mapwrap")?.classList.remove("tunon");
      el.classList.remove("on");
      setTimeout(() => { if (!el.classList.contains("on")) el.hidden = true; }, 350);
      this._tunnelVisitors(false);
      delete window.__naviSeason;
      this._tfFast = false;
      if (this._dbgTap) { window.removeEventListener("pointerdown", this._dbgTap, true); this._dbgTap = null; }
      return;
    }
    this._dbgTun = true;
    delete window.__naviSeason;
    const d = new Date(`${dateStr}T12:00:00`);
    window.__naviSeason = tunnelSeason(d) || "nessuna"; // stagione della data scelta (anche "nessuna": pipistrelli)
    this._tfFast = true;
    this._tunnelVisitors(false);
    el.style.setProperty("--tfd", "1.6s");
    el.hidden = false;
    requestAnimationFrame(() => { el.classList.add("on"); setTimeout(() => { if (this._dbgTun) this.$("mapwrap")?.classList.add("tunon"); }, 320); });
    this._tunnelVisitors(true);
    // la prova finisce al primo tocco sullo schermo (dopo un attimo, così non la chiude il tocco che l'ha avviata)
    if (this._dbgTap) window.removeEventListener("pointerdown", this._dbgTap, true);
    this._dbgTap = () => this._debugTunnel(null);
    setTimeout(() => { if (this._dbgTun && this._dbgTap) window.addEventListener("pointerdown", this._dbgTap, true); }, 600);
    const lab = { natale: "Natale", halloween: "Halloween", nessuna: "giorno normale" }[window.__naviSeason];
    this.$("tunrem").textContent = `Prova · ${d.toLocaleDateString("it-IT")} · ${lab}`;
    this._msg("Prova della galleria: tocca lo schermo per finire");
    this._dbgTunT = setTimeout(() => this._debugTunnel(null), 40000);
  }

  // "visitatori" della galleria: dopo un po' ogni tanto uno stormo di pipistrelli che ci vola incontro;
  // a Natale Babbo Natale sulla slitta nella carreggiata opposta, a Halloween zucche e fantasmi
  /* disegno della galleria: archi che vengono incontro in prospettiva (grandezza = 1/distanza) e strada con la riga
     tratteggiata. Un solo canvas, ridisegnato a ogni fotogramma solo mentre la galleria è visibile. */
  _tunnelDraw(on) {
    if (!on) { cancelAnimationFrame(this._tdRaf); this._tdRaf = 0; return; }
    if (this._tdRaf) return;
    const cv = this.$("tfcv");
    if (!cv) return;
    const ctx = cv.getContext("2d");
    const slow = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 3 : 1;
    const T = 2.4 * slow;                 // secondi per un tratto di strada (come prima --tfd)
    const RING_T = T * 10 / 6, NR = 10;   // durata della corsa di un arco, numero di archi
    const sc = (q) => 0.0716 / (1.0225 - q); // grandezza in funzione dell'avanzamento 0..1
    let bg = null, W = 0, H = 0, dpr = 1;
    const t0 = performance.now();
    const frame = (now) => {
      this._tdRaf = requestAnimationFrame(frame);
      const w = cv.clientWidth, h = cv.clientHeight;
      if (!w || !h) return;
      const d = Math.min(2, window.devicePixelRatio || 1);
      if (w !== W || h !== H || d !== dpr) {
        W = w; H = h; dpr = d;
        cv.width = Math.round(w * d); cv.height = Math.round(h * d);
        bg = null;
      }
      const vm = Math.min(W, H) / 100;   // 1vmin
      const cx = W / 2, vy = H * 0.45;   // punto di fuga
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!bg) { // sfondo e strada non cambiano: preparati una volta sola
        bg = document.createElement("canvas"); bg.width = cv.width; bg.height = cv.height;
        const b = bg.getContext("2d"); b.setTransform(dpr, 0, 0, dpr, 0, 0);
        b.fillStyle = "#060606"; b.fillRect(0, 0, W, H);
        const rr = Math.hypot(W, H) * 0.6;
        const g = b.createRadialGradient(cx, vy, 0, cx, vy, rr);
        g.addColorStop(0, "#4a3f2e"); g.addColorStop(0.4, "#1d1913"); g.addColorStop(1, "#060606");
        b.fillStyle = g; b.fillRect(0, 0, W, H);
        const half = 85 * vm, top = 1.2 * vm;
        const rg = b.createLinearGradient(0, vy, 0, H);
        rg.addColorStop(0, "#262626"); rg.addColorStop(1, "#3a3a3a");
        b.fillStyle = rg;
        b.beginPath(); b.moveTo(cx - top, vy); b.lineTo(cx + top, vy); b.lineTo(cx + half, H); b.lineTo(cx - half, H); b.closePath(); b.fill();
      }
      ctx.drawImage(bg, 0, 0, W, H);
      const t = (now - t0) / 1000;
      // riga tratteggiata: tratti alla stessa distanza fra loro, che scorrono verso di noi
      const yAt = (q) => vy + (H - vy) * (0.0225 / (1.0225 - q));
      const halfW = (y) => (0.15 + 1.35 * (y - vy) / (H - vy)) * vm;
      ctx.fillStyle = "#f2f2f2";
      const ND = 7, ph = (t / T) % 1;
      for (let i = 0; i < ND; i++) {
        const q0 = (i + ph) / ND, q1 = Math.min(1, q0 + 0.45 / ND);
        const y0 = yAt(q0), y1 = Math.min(H, yAt(q1));
        if (y1 - y0 < 0.4) continue;
        const a = halfW(y0), c = halfW(y1);
        ctx.beginPath(); ctx.moveTo(cx - a, y0); ctx.lineTo(cx + a, y0); ctx.lineTo(cx + c, y1); ctx.lineTo(cx - c, y1); ctx.closePath(); ctx.fill();
      }
      // archi: dal più lontano al più vicino
      const rings = [];
      for (let i = 0; i < NR; i++) rings.push(((t / RING_T) + i / NR) % 1);
      rings.sort((a, b) => a - b);
      ctx.lineCap = "round";
      for (const q of rings) {
        let op = q < 0.1 ? q / 0.1 * 0.95 : 0.95;
        if (q > 0.975) op = 0.95 * (1 - (q - 0.975) / 0.025);
        if (op <= 0.01) continue;
        const s = Math.min(3, sc(q));
        const rx = 40 * vm * s, ryTop = 40.26 * vm * s, yb = vy + 25.74 * vm * s; // forma come prima: volta + pareti dritte
        const ys = vy - ryTop + 49.5 * vm * s;   // dove finisce la curva e iniziano le pareti
        const ry = 49.5 * vm * s;
        ctx.globalAlpha = op;
        ctx.beginPath();
        ctx.moveTo(cx - rx, yb); ctx.lineTo(cx - rx, ys);
        ctx.ellipse(cx, ys, rx, ry, 0, Math.PI, 2 * Math.PI);
        ctx.lineTo(cx + rx, yb);
        ctx.strokeStyle = "rgba(255,170,80,.18)"; ctx.lineWidth = Math.max(2, 14 * s); ctx.stroke(); // alone
        ctx.strokeStyle = "rgba(255,196,120,.6)"; ctx.lineWidth = Math.max(1, 4 * s); ctx.stroke();
        // lampada in cima
        const ly = vy - ryTop, lw = 17 * s, lh = 3 * s;
        const gl = ctx.createRadialGradient(cx, ly, 0, cx, ly, Math.max(4, 30 * s));
        gl.addColorStop(0, "rgba(255,205,130,.65)"); gl.addColorStop(1, "rgba(255,205,130,0)");
        ctx.fillStyle = gl; ctx.fillRect(cx - 30 * s - 4, ly - 30 * s - 4, 60 * s + 8, 60 * s + 8);
        ctx.fillStyle = "#ffe2b0"; ctx.fillRect(cx - lw, ly - lh, lw * 2, lh * 2);
      }
      ctx.globalAlpha = 1;
    };
    this._tdRaf = requestAnimationFrame(frame);
  }

  _tunnelVisitors(on) {
    this._tunnelDraw(on);
    if (!on) {
      clearTimeout(this._tunVisT);
      cancelAnimationFrame(this._tfRaf); this._tfRaf = 0; this._tfList = [];
      this._tunVisOn = false;
      const box = this.$("tfvis");
      if (box) box.innerHTML = "";
      return;
    }
    if (this._tunVisOn) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    this._tunVisOn = true;
    const spawn = () => {
      if (!this._tunVisOn) return;
      const season = tunnelSeason();
      const r = Math.random();
      if (season === "natale" && r < 0.45) this._tfSanta();
      else if (season === "halloween" && r < 0.5) { if (Math.random() < 0.55) this._tfPumpkin(); else this._tfGhost(); }
      else this._tfBats();
      this._tunVisT = setTimeout(spawn, this._tfFast ? 2500 + Math.random() * 2000 : 8000 + Math.random() * 12000);
    };
    this._tunVisT = setTimeout(spawn, this._tfFast ? 1200 : 5000 + Math.random() * 4000); // "dopo un po'" (in prova subito)
  }

  // un visitatore si avvicina a velocità costante; sullo schermo, come in prospettiva vera, dimensione e distanza dal
  // punto di fuga valgono 1/distanza: da lontano cresce pochissimo, negli ultimi metri si ingrandisce di colpo e ci passa
  // accanto. (dx, dy, s1) = posizione e scala quando ci è addosso
  _tfSpawn(svg, cls, o, delay = 0) {
    const box = this.$("tfvis");
    if (!box) return;
    const el = document.createElement("div");
    el.className = `tf-v ${cls}`;
    el.innerHTML = svg;
    box.appendChild(el);
    (this._tfList ||= []).push({ el, dx: o.dx, dy: o.dy, s1: o.s1, dur: o.dur * 1000, t0: performance.now() + delay, z0: o.z0 || 30 });
    if (this._tfRaf) return;
    const step = (now) => {
      this._tfRaf = 0;
      const list = this._tfList || [];
      for (let i = list.length - 1; i >= 0; i--) {
        const v = list[i];
        const t = (now - v.t0) / v.dur;
        if (t < 0) continue;
        if (t >= 1 || !v.el.isConnected) { v.el.remove(); list.splice(i, 1); continue; }
        const z = v.z0 + (1 - v.z0) * t; // distanza: da z0 fino a 1 ("addosso")
        const k = 1 / z;
        v.el.style.transform = `translate(${(v.dx * k).toFixed(2)}vmin, ${(v.dy * k).toFixed(2)}vmin) scale(${(v.s1 * k).toFixed(3)})`;
        v.el.style.opacity = Math.max(0, Math.min(1, t / 0.08, (1 - k) / 0.2)).toFixed(2); // compare piano, sparisce solo quando ci è addosso
      }
      if (list.length) this._tfRaf = requestAnimationFrame(step);
    };
    this._tfRaf = requestAnimationFrame(step);
  }

  _tfBats() {
    const rnd = (a, b) => a + Math.random() * (b - a);
    const n = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      // dentro la volta (pareti a ±40, soffitto a -40 alla stessa scala degli archi): verso il centro, sopra le corsie
      this._tfSpawn(TF_BAT, "tf-bat", { dx: side * rnd(3, 15), dy: rnd(-26, -10), s1: rnd(2, 2.6), dur: rnd(3.8, 5), z0: 26 },
        i * rnd(250, 650));
    }
  }

  // le sorprese passano sopra la corsia opposta (a sinistra, centro a -20): dentro la galleria, non nel muro
  _tfSanta() { // la slitta vola a mezz'altezza
    this._tfSpawn(TF_SANTA, "tf-santa", { dx: -20, dy: 0, s1: 2.3, dur: 4.6, z0: 32 });
  }

  _tfPumpkin() {
    this._tfSpawn(TF_PUMPKIN, "tf-pump", { dx: -20, dy: 12, s1: 2.4, dur: 4, z0: 30 });
  }

  _tfGhost() {
    const rnd = (a, b) => a + Math.random() * (b - a);
    this._tfSpawn(TF_GHOST, "tf-ghost", { dx: -20 + rnd(-6, 6), dy: -12, s1: 2.4, dur: 4.2, z0: 30 });
  }

  // indicazioni vocali: un avviso in anticipo ("Tra 300 metri, …") e uno al momento della manovra
  _voiceGuide(rt, along) {
    const nav = this._nav;
    if (!this._settings.voice || this._settings.muteGuide) return; // mute: zittita solo la voce delle indicazioni
    if (nav.spokenRoute !== rt) { nav.spokenRoute = rt; nav.spoken = new Set(); }
    const ms = rt.maneuvers;
    const lang = this._settings.lang;
    if (!nav.spoken.has("start") && ms[0]) {
      nav.spoken.add("start");
      if (!nav.startSpoken) this._speak(ms[0].verbal || ms[0].text); // al primo avvio, non dopo un ricalcolo
      nav.startSpoken = true;
    }
    const k = this._curManeuver(rt);
    const next = ms[k + 1];
    if (!next) return;
    const to = rt._cum[next.begin] - along;
    const v = nav.speed || 0;
    const far = v > 22 ? 1500 : v > 14 ? 700 : 300;
    const near = Math.max(30, v * 5);
    const key = String(k + 1);
    const low = (t) => (lang === "de" ? t : t.charAt(0).toLowerCase() + t.slice(1));
    if (to <= near) {
      if (!nav.spoken.has(key + "n")) {
        nav.spoken.add(key + "n");
        nav.spoken.add(key + "f");
        this._speak(next.verbal || next.text);
      }
    } else if (to <= far && to > near + 80 && !nav.spoken.has(key + "f")) {
      nav.spoken.add(key + "f");
      this._speak(`${PHRASES[lang].in(spokenDist(to, lang))}, ${low(next.alert || next.verbal || next.text)}`);
    }
  }

  // limite di velocità del tratto e beep quando lo superi
  _speedCheck(rt, idx) {
    const nav = this._nav;
    nav.limit = null;
    if (idx != null) {
      for (const [a, b, l] of rt.speed_limits || []) {
        if (idx >= a && idx < b) { nav.limit = l; break; }
      }
    }
    const kmh = nav.speed != null ? nav.speed * 3.6 : null;
    nav.over = nav.limit != null && kmh != null && kmh > nav.limit + Math.max(3, nav.limit * 0.05);
    if (nav.over && this._settings.beep && Date.now() - (nav.lastBeep || 0) > 5000) {
      nav.lastBeep = Date.now();
      this._beep();
    }
  }

  // nuovo percorso dalla posizione attuale verso le tappe non ancora raggiunte
  async _reroute(fix) {
    const nav = this._nav;
    nav.rerouting = true;
    nav.lastReroute = Date.now();
    this._navPopup("warn", "↻", "Fuori percorso<br><b>Ricalcolo del percorso…</b>", 0);
    if (!this._settings.muteGuide) this._speak(PHRASES[this._settings.lang].reroute, true);
    this._renderNav();
    const before = this._points;
    // direzione di marcia: quella del GPS se ci si muove, altrimenti l'ultima nota (serve a Valhalla per partire
    // dalla strada che stai percorrendo, nel tuo verso)
    const hd = fix.heading != null && !Number.isNaN(fix.heading) && (fix.speed || 0) > 2 ? fix.heading : nav.heading;
    this._points = [{ name: "📍 Posizione attuale", address: "", lat: fix.lat, lon: fix.lon,
      ...(Number.isFinite(hd) ? { heading: hd } : {}) }, ...this._points.slice(1 + nav.passed)];
    try {
      await this._compute(false, true);
      if (!this._nav) return;
      Object.assign(nav, { passed: 0, idx: 0, offSince: null, offCount: 0 });
      // aggancia subito la posizione al nuovo percorso
      const fresh = this._geom(this._result.routes[0]);
      nav.snap = this._snap(fresh, nav.fix || fix, 0);
      nav.idx = nav.snap.idx;
      this._saveState();
      this._renderPoints();
      this._drawMarkers();
      const s = this._result.routes[0].summary;
      this._navPopup("ok", "✓", `Nuovo percorso<br><b>${fmtTime(s.time)} · ${fmtKm(s.length_km)}</b>`, 3500);
    } catch (err) {
      this._points = before;
      if (this._nav) this._navPopup("warn", "⚠", `Ricalcolo non riuscito: ${esc(err.message || err)}<br>Riprovo tra poco.`, 4000);
    } finally {
      nav.rerouting = false;
      if (this._nav) this._renderNav();
    }
  }

  // posizione mostrata in guida: quella sull'inizio della linea all'avvio, altrimenti il GPS reale
  _navPos() {
    const nav = this._nav;
    return nav?.disp || (nav?.fix ? { lat: nav.fix.lat, lon: nav.fix.lon } : null);
  }

  _drawMe() {
    const f = this._nav.fix;
    const p = this._navPos() || f;
    const ll = [p.lat, p.lon];
    // il veicolo (auto, moto, bici o persona, secondo il mezzo scelto) ruota con la direzione di marcia;
    // in guida la mappa ruota al contrario, così resta col muso in alto
    const h = this._nav.dir ?? 0;
    if (!this._meMarker) {
      const icon = L.divIcon({ className: "", iconSize: [47, 47], iconAnchor: [23.5, 23.5], html: `<div class="nav-car">${this._vehSvg()}</div>` });
      this._accCircle = L.circle(ll, { radius: f.acc || 0, color: "#1a73e8", weight: 1, fillOpacity: 0.1, interactive: false }).addTo(this._map);
      this._meMarker = L.marker(ll, { icon, interactive: false, zIndexOffset: 1000 }).addTo(this._map);
      this._carRot = h;
    } else {
      this._meMarker.setLatLng(ll);
      this._accCircle.setLatLng(ll).setRadius(f.acc || 0);
      // giro più corto, come la mappa
      this._carRot = (this._carRot ?? h) + ((((h - (this._carRot ?? h)) % 360) + 540) % 360) - 180;
    }
    const svg = this._meMarker.getElement()?.querySelector("svg");
    if (svg) svg.style.transform = `rotate(${this._carRot}deg)`;
    this._drawMe3d();
  }

  _isGuida() {
    return !!this._nav && this._nav.view === "guida";
  }

  // direzione di marcia: quella della strada davanti a te quando sei sul percorso, altrimenti quella del movimento
  _direction(rt, snap, fix, limit) {
    const sh = rt.shape;
    if (snap.dist <= limit && sh.length > 1) {
      const i = Math.min(snap.idx, sh.length - 2);
      const here = [sh[i][0] + snap.t * (sh[i + 1][0] - sh[i][0]), sh[i][1] + snap.t * (sh[i + 1][1] - sh[i][1])];
      let j = i + 1;
      while (j < sh.length - 1 && rt._cum[j] - snap.along < 25) j++;
      if (distM(here, sh[j]) > 1) return bearing(here, sh[j]);
    }
    if (fix.heading != null && !Number.isNaN(fix.heading) && (fix.speed || 0) > 1) return fix.heading;
    return this._nav.heading ?? this._nav.dir;
  }

  // icona sulla mappa: con un percorso avvia la guida; in guida torna alla mappa ed esce dalla navigazione
  _toggleView() {
    if (!this._nav) {
      if (!this._result) return;
      const list = this._navSources();
      const chosen = this.shadowRoot.getElementById("navsrc")?.value || this._defaultNavSource(list);
      this._startNav(chosen);
      return;
    }
    this._stopNav();
  }

  // "Parti" compare con un percorso calcolato; durante la navigazione i comandi sono nella barra in basso
  _updateModeBtn() {
    const b = this.$("modebtn");
    if (!b) return;
    b.hidden = !this._result || !!this._nav;
    b.title = "Parti: guida con indicazioni";
  }

  _applyView() {
    const g = this._isGuida();
    this.$("mainbox").classList.toggle("guida", g);
    if (g) this._freeRot = false; // in guida la rotazione segue la direzione di marcia
    else if (!this._freeRot) this._rot = 0; // uscendo dalla guida torna il nord in alto
    this._layoutRot();
    this._applyInteract();
    this.$("gattr").hidden = !g || !!this._3d; // in 3D le fonti le mostra la vista 3D
    if (g) this.$("gattr").innerHTML = LAYERS[this._layer][3];
    this._updateModeBtn();
    this._relayout();
    requestAnimationFrame(() => this._relayout());
    if (this._nav) this._renderNav();
  }

  // schermo intero: prima quello vero del browser (nasconde anche le barre di Android), altrimenti
  // il pannello copre tutta la finestra di Home Assistant (barra laterale e intestazione comprese)
  // schermo dell'auto (app NaviHA con Android Auto)
  _isCarScreen() {
    try { return !!window.NaviHAApp?.isCar?.(); } catch (e) { return false; }
  }

  // in auto: pannello di sinistra sopra la mappa, solo fuori dalla guida; il tasto ☰ compare solo lì
  _carSide(open) {
    const car = this._isCarScreen();
    this.classList.toggle("sideopen", !!(car && open && !this._nav));
    const b = this.$("sidebtn");
    if (b) { b.hidden = !car || !!this._nav; b.classList.toggle("attn", this.classList.contains("sideopen")); }
    const fb = this.$("fullbtn");
    if (fb && car) fb.hidden = true; // in auto lo schermo intero è fisso
    setTimeout(() => this._relayout(), 150);
  }

  async _toggleFull(on = !this._full) {
    if (!on && this._isCarScreen()) on = true; // in auto si resta sempre a schermo intero
    this._full = on;
    this.classList.toggle("full", on);
    if (on) {
      const req = this.requestFullscreen || this.webkitRequestFullscreen;
      try { if (req && !document.fullscreenElement) await req.call(this, { navigationUI: "hide" }); } catch (e) { /* resta lo schermo intero nella pagina */ }
    } else if (document.fullscreenElement === this) {
      try { await document.exitFullscreen(); } catch (e) { /* già uscito */ }
    }
    this._syncFullBtns();
    this._updateAwake();
    setTimeout(() => this._relayout(), 150);
  }

  _syncFullBtns() {
    for (const b of [this.$("fullbtn"), this.$("navbot")?.querySelector('[data-n="full"]')]) {
      if (!b) continue;
      b.innerHTML = this._full ? FS_OFF : FS_ON;
      b.title = this._full ? "Esci dallo schermo intero" : "Schermo intero";
      b.classList.toggle("attn", !!this._full);
    }
  }

  // schermo sempre acceso in guida e a schermo intero: blocco dello standby del browser o, se manca, video muto in loop
  async _updateAwake() {
    const want = !!(this._full || this._nav) && document.visibilityState === "visible";
    if (!want) {
      try { this._wake?.release(); } catch (e) { /* già rilasciato */ }
      this._wake = null;
      this._noSleep?.pause();
      return;
    }
    if (this._wake && !this._wake.released) return;
    try {
      this._wake = await window.navigator.wakeLock.request("screen");
      this._noSleep?.pause();
      return;
    } catch (e) { /* non disponibile (es. app Companion): video */ }
    if (!this._noSleep) {
      const v = document.createElement("video");
      v.className = "nosleep";
      v.muted = true;
      v.loop = true;
      v.setAttribute("playsinline", "");
      v.setAttribute("muted", "");
      v.src = NOSLEEP_MP4;
      this.shadowRoot.appendChild(v);
      this._noSleep = v;
    }
    try { await this._noSleep.play(); } catch (e) { /* il browser non lo permette: lo schermo può spegnersi */ }
  }

  // ----------------------------------------------------------------- vista 3D (MapLibre): rilievo ed edifici
  // Leaflet resta la mappa "vera" (percorso, guida, ricalcolo, gesti in 2D): la vista 3D la ricopia e le rimanda
  // i movimenti fatti a mano. In guida la telecamera segue la posizione, inclinata e girata nella direzione di marcia.

  _webgl() {
    try {
      const c = document.createElement("canvas");
      return !!(c.getContext("webgl2") || c.getContext("webgl"));
    } catch (e) { return false; }
  }

  async _toggle3d(on = !this._3d) {
    if (on && !this._webgl()) { this._msg("Questo dispositivo non supporta la grafica 3D (WebGL)"); return; }
    this._3d = on;
    this._sync3dBtns();
    if (on) {
      // se la vista 3D va in errore (anche dentro MapLibre) la si butta e la si ricrea da zero, una volta
      let ok = false;
      for (let tries = 0; tries < 2 && !ok; tries++) {
        try {
          await this._init3d();
          if (!this._3d) return; // spenta mentre si caricava
          this.$("map3d").hidden = false;
          this.$("map").classList.add("under3d");
          this._g3.resize();
          this._update3d();
          this._sync3d();
          ok = true;
        } catch (e) {
          console.warn("Navigator 3D:", e);
          this._destroy3d();
          if (tries === 1) {
            this._3d = false;
            this._sync3dBtns();
            this.$("map").classList.remove("under3d");
            this.$("map3d").hidden = true;
            this._msg(`Vista 3D non disponibile: ${e.message || e}`);
            this._settings.view3d = false;
            this._saveSettings();
            return;
          }
        }
      }
      if (this._tiles && this._map.hasLayer(this._tiles)) this._map.removeLayer(this._tiles);
      this.$("gattr").hidden = true;
      this._arrowLayer?.clearLayers();
      this._poiKey = null;
      this._renderPois();
      this._placePitchCtl();
    } else {
      this.$("map3d").hidden = true;
      this.$("map").classList.remove("under3d");
      this._scheduleArrows();
      this._poiKey = null;
      this._renderPois();
      this.$("gattr").hidden = !this._isGuida();
      this._placePitchCtl();
      if (this._tiles && !this._map.hasLayer(this._tiles)) this._tiles.addTo(this._map);
    }
    this._settings.view3d = this._3d;
    this._saveSettings();
    this._renderAddons();
  }

  // errore nella vista 3D mentre la si usa: la si ricrea da zero, così non resta rotta
  _recover3d(err) {
    console.warn("Navigator 3D, la vista viene ricreata:", err);
    if (this._recovering) return;
    this._recovering = true;
    this._destroy3d();
    setTimeout(async () => {
      this._recovering = false;
      if (!this._3d) return;
      this._3d = false;
      await this._toggle3d(true);
    }, 500);
  }

  // butta la vista 3D (la prossima pressione di 3D la ricrea da zero)
  _destroy3d() {
    try { this._g3?.remove(); } catch (e) { /* già rotta */ }
    this._g3 = null;
    this._g3ok = false;
    this._g3ready = null;
    this._g3key = null;
    this._g3markers = [];
    this._me3d = null;
    this._cloudCanvas = null;
    this._cloudHooked = false;
    this._g3interacting = false;
    this._g3heavyOn = undefined; // vista 3D ricreata: edifici di nuovo visibili
    this._g3downs = 0;
    this._g3ptrs?.clear();
    cancelAnimationFrame(this._cloudRaf); this._cloudRaf = 0;
    cancelAnimationFrame(this._plateRaf); this._plateRaf = 0;
    this._plate3d = null;
    // modello 3D del mezzo: la vista è stata ricreata, va reinizializzato sul nuovo contesto
    if (this._car3d?.mesh) this._disposeMesh(this._car3d.mesh);
    this._car3dReady = false; this._car3dInit = false; this._car3dMeshKey = null;
    this._carScene = null; this._carCam = null; this._carRenderer = null; this._car3d = null;
    const el = this.$("map3d");
    if (el) el.innerHTML = "";
  }

  // zoom automatico in base alla velocità: un interruttore per la mappa piatta e uno per la vista 3D
  _autoZoomOn() {
    return this._3d ? this._settings.autoZoom3d !== false : this._settings.autoZoom !== false;
  }

  // zoom di partenza della vista 3D in guida (zoom MapLibre): quello automatico secondo la velocità, o fisso se è spento
  _base3dZoom() {
    return (this._autoZoomOn() ? this._map.getZoom() : 17) - 1;
  }

  // distanza della vista 3D in guida: scostamento (in livelli di zoom) dallo zoom automatico, memorizzato
  _zoom3dOff() {
    return Math.max(-6, Math.min(6, Number(this._settings.zoom3dOff) || 0));
  }

  _setZoom3dOff(v) {
    this._settings.zoom3dOff = Math.max(-6, Math.min(6, Math.round(v * 4) / 4));
    this._saveSettings();
  }

  _pitch3d() {
    return Math.max(0, Math.min(80, Number(this._settings.pitch3d) || 60));
  }

  // ▲ più dall'alto (0° = vista da sopra), ▼ più bassa fino a 80°, quasi come una telecamera sul cruscotto
  // (oltre, la vista quasi orizzontale arriva più lontano di quanto MapLibre disegna: fascia nera fra terreno e cielo)
  _setPitch3d(delta) {
    const g = this._g3;
    if (!g) return;
    const cur = this._nav?.follow && this._isGuida() ? this._pitch3d() : Math.round(g.getPitch());
    const next = Math.max(0, Math.min(80, Math.round((cur + delta) / 5) * 5));
    this._settings.pitch3d = next;
    this._saveSettings();
    if (this._nav?.fix && this._nav.follow) this._sync3d();
    else g.easeTo({ ...this._clearCamera({ center: g.getCenter(), zoom: g.getZoom(), bearing: g.getBearing(), pitch: next, padding: g.getPadding() }), duration: 400 });
    this._placePitchCtl(next);
  }

  // in alto a destra, sotto l'indicazione della guida (o sotto la scelta della mappa)
  _placePitchCtl(pitch) {
    const el = this.$("pitchctl");
    if (!el || this._dragging) return; // durante uno spostamento non si tocca niente
    this._syncDock();
    // sempre visibile: zoom −/+ con la lampadina giorno/notte in mezzo; in 3D anche l'inclinazione (croce)
    const guida = !!(this._isGuida() && this._nav);
    el.hidden = false;
    el.classList.toggle("twod", !this._3d);
    el.classList.toggle("plan", !guida);
    this._syncNightBtn();
    const top = this.$("navtop");
    if (!this.$("addock")?.contains(el)) { // nel blocco della guida (con gli add-on) la croce sta lì dentro
      el.style.top = !guida ? "" : top && !top.hidden ? `${top.offsetTop + top.offsetHeight + 8}px` : "56px";
      el.style.left = "";
      el.classList.remove("moved");
      this._applyFloat("pitchctl"); // spostata a mano: lì (in guida e fuori)
    }
    if (!this._3d || !this._g3) return;
    const p = Math.round(pitch ?? this._g3.getPitch());
    el.querySelector('[data-p="-15"]').disabled = p <= 0;
    el.querySelector('[data-p="15"]').disabled = p >= 80;
  }

  // lampadina: accesa (gialla) di giorno, spenta di notte; il tocco passa all'altra modalità e la fissa
  // ore e minuti attuali e d'arrivo negli angoli della croce (solo in guida); senza guida restano vuoti
  _navClock(remTime) {
    if (this._dragging) return;
    // cifre a 7 segmenti (SVG) grandi quanto l'angolo della croce; il testo resta per l'accessibilità
    const set = (id, v) => {
      const el = this.$(id);
      if (!el || el.dataset.v === v) return;
      el.dataset.v = v;
      el.innerHTML = v ? seg7Svg(v) : "";
      el.setAttribute("aria-label", v);
    };
    const two = (n) => String(n).padStart(2, "0");
    const now = new Date();
    if (!this._nav || remTime == null) {
      // senza guida: ora attuale in alto; in basso l'arrivo previsto se c'è un percorso calcolato (partendo adesso)
      set("clkh", two(now.getHours())); set("clkm", two(now.getMinutes()));
      const t = this._result?.routes?.[this._sel]?.summary?.time;
      const arr = !this._nav && t ? new Date(now.getTime() + t * 1000) : null;
      set("arrh", arr ? two(arr.getHours()) : ""); set("arrm", arr ? two(arr.getMinutes()) : "");
      clearTimeout(this._clkT);
      this._clkT = setTimeout(() => { if (!this._nav) this._navClock(null); }, (60 - now.getSeconds()) * 1000 + 200);
      return;
    }
    const arr = new Date(Date.now() + remTime * 1000);
    set("clkh", two(now.getHours())); set("clkm", two(now.getMinutes()));
    set("arrh", two(arr.getHours())); set("arrm", two(arr.getMinutes()));
    this._clkRem = { rem: remTime, at: Date.now() };
    clearTimeout(this._clkT); // anche senza posizioni nuove l'ora corrente avanza
    this._clkT = setTimeout(() => { const c = this._clkRem; if (this._nav && c) this._navClock(Math.max(0, c.rem - (Date.now() - c.at) / 1000)); }, 20000);
  }

  _syncNightBtn() {
    const b = this.$("nightbtn");
    if (!b) return;
    const n = this._isNight();
    if (b.dataset.n === String(n)) return;
    b.dataset.n = String(n);
    b.className = `mid ${n ? "night" : "day"}`;
    b.title = n ? "Notte: tocca per il giorno (fino al prossimo tramonto/alba)" : "Giorno: tocca per la notte (fino al prossimo tramonto/alba)";
    b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 17.5h6M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2v.5h5V16c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/><path class="base" d="M10 20.5h4"/></svg>';
  }

  // la lampadina cambia giorno/notte solo fino al prossimo tramonto o alba (da sun.sun), poi torna l'automatico
  _toggleNight() {
    const a = this._hass?.states?.["sun.sun"]?.attributes || {};
    const next = [a.next_rising, a.next_setting].map((t) => Date.parse(t)).filter((t) => t > Date.now());
    const until = next.length ? Math.min(...next) : Date.now() + 12 * 3600e3;
    this._settings.nightOverride = { on: !this._isNight(), until };
    this._saveSettings();
    clearTimeout(this._nightOvT); // allo scadere si ricontrolla (anche se il sole non cambia stato nello stesso istante)
    this._nightOvT = setTimeout(() => { this._applyNight(); this._syncNightBtn(); }, Math.min(until - Date.now() + 2000, 2 ** 31 - 1));
    this._applyNight();
    this._syncNightBtn();
  }

  _sync3dBtns() {
    for (const b of [this.$("b3dbtn"), this.$("navbot")?.querySelector('[data-n="3d"]')]) {
      if (!b) continue;
      b.classList.toggle("attn", !!this._3d);
      b.title = this._3d ? "Torna alla mappa piatta" : "Vista 3D con rilievo ed edifici";
    }
    this._northBtn(); // la bussola della mappa 2D girata non serve in 3D
  }

  _baseSource() {
    const [, url, maxZoom, attribution] = LAYERS[this._effLayer(this._layer)] || LAYERS.strade;
    const tiles = (url.includes("{s}") ? ["a", "b", "c"].map((x) => url.replace("{s}", x)) : [url])
      .map((u) => (window.maplibregl?.addProtocol ? u.replace(/^https:\/\//, "navc://") : u)); // memoria delle mappe
    return { type: "raster", tiles, tileSize: 256, maxzoom: maxZoom, attribution };
  }

  async _init3d() {
    if (this._g3) { await this._g3ready; this._apply3dSettings(); this._set3dBase(); return; }
    const ml = await loadMaplibre();
    if (!this.shadowRoot.querySelector("link[data-ml]")) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = MAPLIBRE_CSS;
      link.dataset.ml = "1";
      this.shadowRoot.prepend(link);
    }
    const el = this.$("map3d");
    el.hidden = false; // MapLibre misura il contenitore alla creazione
    const c = this._map.getCenter();
    const dem = { type: "raster-dem", tiles: [ml.addProtocol ? DEM_URL.replace(/^https:\/\//, "navc://") : DEM_URL], tileSize: 256, maxzoom: 15, encoding: "terrarium" };
    const g = new ml.Map({
      container: el, center: [c.lng, c.lat], zoom: this._map.getZoom() + Z3D, pitch: this._pitch3d(), maxPitch: 80,
      attributionControl: { compact: true },
      style: {
        version: 8,
        sources: {
          base: this._baseSource(),
          dem: { ...dem, attribution: DEM_ATTR },
          hs: dem,
          lines: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
        },
        layers: [
          { id: "base", type: "raster", source: "base", paint: this._basePaint() },
          { id: "hs", type: "hillshade", source: "hs", paint: { "hillshade-exaggeration": 0.3, "hillshade-shadow-color": "#3e3a36" } },
          { id: "lines", type: "line", source: "lines", filter: ["!=", ["get", "d"], 1],
            layout: { "line-join": "round", "line-cap": "round", "line-sort-key": ["get", "i"] },
            paint: { "line-color": ["get", "c"], "line-width": LINE_WIDTH_3D, "line-opacity": ["get", "o"] } },
          { id: "lines-d", type: "line", source: "lines", filter: ["==", ["get", "d"], 1], layout: { "line-join": "round" },
            paint: { "line-color": ["get", "c"], "line-width": LINE_WIDTH_3D, "line-opacity": ["get", "o"], "line-dasharray": [1.4, 1.4] } },
        ],
        terrain: { source: "dem", exaggeration: +this._settings.terrainEx || 1.5 },
        sky: this._skySpec(),
      },
    });
    this._g3 = g;
    this._g3markers = [];
    // pronta appena c'è lo stile, senza aspettare i primi riquadri (con rete lenta il "load" arriva tardi)
    this._g3ready = new Promise((ok) => { g.once("style.load", ok); g.once("load", ok); }).then(() => { this._g3ok = true; try { this._desertVeil(); } catch (e) { /* stile non pronto */ } });
    g.on("error", (e) => console.debug("Navigator 3D:", e?.error?.message || e)); // riquadri mancanti: la vista va avanti
    // movimenti fatti a mano nella vista 3D: la guida smette di seguire, Leaflet si sposta nello stesso punto
    // In guida il mezzo resta SEMPRE centrato: zoom, rotazione, inclinazione e anche il trascinamento con le dita
    // non fermano il tracciamento. Sono momentanei (mentre le dita sono sullo schermo la vista è libera) e, appena
    // si molla o al GPS successivo, la vista torna sul mezzo. Zoom e inclinazione restano memorizzati come distanza.
    this._g3gest = new Set();
    const followGuida = () => !!(this._nav?.fix && this._nav.follow && this._isGuida());
    for (const ev of ["dragstart", "zoomstart", "rotatestart", "pitchstart"]) {
      g.on(ev, (e) => {
        if (!e.originalEvent) return;
        if (followGuida()) {
          // il trascinamento è solo un'occhiata momentanea: non toglie il tracciamento (nessun userFrame).
          // zoom/rotazione/inclinazione memorizzano la distanza; si ricentra appena si mollano le dita.
          if (ev !== "dragstart") { clearTimeout(this._g3dragT); this._g3gest.add(ev.replace("start", "")); this._g3gestT = Date.now(); }
          return;
        }
        if (ev === "zoomstart" && this._nav) this._nav.manualZoomUntil = Date.now() + 20000;
        if (ev !== "pitchstart") this._userMoved();
      });
    }
    for (const kind of ["zoom", "rotate", "pitch"]) {
      g.on(`${kind}end`, () => {
        if (!this._g3gest.has(kind)) return;
        this._g3gest.delete(kind);
        if (kind === "zoom") this._setZoom3dOff(g.getZoom() - this._base3dZoom());
        if (kind === "pitch") { this._settings.pitch3d = Math.max(0, Math.min(80, Math.round(g.getPitch()))); this._saveSettings(); }
        if (!this._g3gest.size) { this._g3key = null; this._sync3d(); }
      });
    }
    // MapLibre "congela" la quota del centro durante easeTo e la sblocca solo a fine animazione: la guida ne avvia una
    // nuova a ogni GPS interrompendo la precedente e il congelamento restava per sempre (sbloccato solo da un gesto con
    // le dita). Con la quota vecchia la vista e il mezzo erano spostati, in montagna anche fuori dallo schermo.
    this._g3thaw = () => {
      if (g._elevationFreeze && !g.isMoving()) { g._elevationFreeze = false; g.triggerRepaint(); }
    };
    g.on("moveend", () => setTimeout(() => this._g3thaw?.(), 0));
    g.on("moveend", () => this._schedulePois()); // i punti di interesse della zona ora visibile
    g.on("moveend", () => this._scheduleClouds()); // nuvole della zona ora visibile
    g.on("moveend", (e) => {
      if (!e.originalEvent || (this._nav?.follow)) return;
      const cc = g.getCenter();
      // il 3D muove la mappa 2D (nascosta), ma la sincronizzazione inversa non deve rimettere la telecamera dove stava:
      // _from3d resta attivo oltre il moveend asincrono della mappa 2D, così la vista resta dove l'hai lasciata
      this._from3d = true;
      try { this._map.setView([cc.lat, cc.lng], g.getZoom() - Z3D, { animate: false }); } finally { setTimeout(() => { this._from3d = false; }, 0); }
    });
    g.on("click", (e) => { if (Date.now() - (this._longAt || 0) >= 900) this._mapTap(e.originalEvent); });
    g.on("contextmenu", (e) => {
      e.originalEvent?.preventDefault?.();
      if (Date.now() - (this._longAt || 0) < 900) return;
      this._longAt = Date.now();
      this._mapClick(L.latLng(e.lngLat.lat, e.lngLat.lng));
    });
    this._bindLongPress(this.$("map3d"), (ev) => {
      const r = g.getCanvas().getBoundingClientRect();
      const ll = g.unproject([ev.clientX - r.left, ev.clientY - r.top]);
      return L.latLng(ll.lat, ll.lng);
    });
    g.on("pitchend", () => this._placePitchCtl());
    g.on("sourcedata", (e) => {
      if (e.sourceId !== "ofm" || !e.isSourceLoaded) return;
      this._scheduleTunnels();
      clearTimeout(this._poiBldT);
      this._poiBldT = setTimeout(() => { // punti (e loro edifici) appena arrivati con le mappe
        if (this._poiKindsOn().size) { this._poiKey = null; this._renderPois(); this._poiStatus(""); } else this._poiBuildings();
      }, 500);
    });
    // quando le quote del terreno sono arrivate si ricontrolla: se la telecamera è finita sotto una collina ci si allontana
    // (solo misura, nessun movimento se è tutto a posto: così "idle" non si ripete all'infinito)
    g.on("idle", () => {
      if (!this._3d || this._g3 !== g) return;
      // in guida l'inclinazione è stata ridotta (da MapLibre, con le quote ancora in arrivo): si riallinea, al massimo ogni 3 s
      const nav = this._nav;
      // (si confronta con l'inclinazione possibile lì, non con quella scelta: nelle valli strette è più bassa apposta)
      const want = nav?.fix && nav.follow && this._isGuida()
        ? this._clearCamera({ center: [nav.fix.lon, nav.fix.lat], zoom: g.getZoom(), bearing: g.getBearing(), pitch: this._pitch3d(), padding: g.getPadding() }).pitch
        : null;
      if (want != null && Math.abs(g.getPitch() - want) > 2 && Date.now() - (this._g3realign || 0) > 3000) {
        this._g3realign = Date.now();
        this._g3key = null;
        this._sync3d();
        return;
      }
      try {
        const cl = this._camClearance(g.transform, 5);
        if (cl == null || cl >= 0) return; // solo se la telecamera è davvero quasi dentro il terreno
        const cam = this._clearCamera({ center: g.getCenter(), zoom: g.getZoom(), bearing: g.getBearing(), pitch: g.getPitch(), padding: g.getPadding() });
        if (cam.zoom < g.getZoom() - 0.05) g.easeTo({ ...cam, duration: 500 });
      } catch (e) { this._recover3d(e); }
    });
    // fonti delle mappe: chiuse (tasto ⓘ), altrimenti in guida coprono il fondo della mappa
    const shut = () => el.querySelectorAll(".maplibregl-compact-show").forEach((x) => x.classList.remove("maplibregl-compact-show"));
    g.once("load", shut);
    g.once("idle", shut);
    await this._g3ready;
    this._apply3dSettings();
  }

  // impostazioni della vista 3D: rilievo ed edifici
  _apply3dSettings() {
    const g = this._g3;
    if (!g || !this._g3ok) return;
    const ex = +this._settings.terrainEx || 1.5;
    if (g.getTerrain()?.exaggeration !== ex) g.setTerrain({ source: "dem", exaggeration: ex });
    const want = this._settings.b3d !== false;
    if (!g.getSource("ofm")) {
      // con l'indirizzo dei riquadri già noto: dalla memoria del telefono (funziona anche senza rete); altrimenti come prima
      const tpl = ofmTemplateNow();
      g.addSource("ofm", tpl && window.maplibregl?.addProtocol
        ? { type: "vector", tiles: [tpl.replace(/^https:\/\//, "navc://")], minzoom: 0, maxzoom: 14, attribution: OFM_ATTR }
        : { type: "vector", url: OFM_URL, attribution: OFM_ATTR });
      ofmTemplate(); // aggiorna l'indirizzo per la prossima volta
    }
    // strade in galleria (OpenStreetMap): livello invisibile, serve solo a far scaricare i dati per riconoscerle sul percorso
    // frecce del verso di marcia sul percorso scelto, appoggiate sul terreno
    if (!g.hasImage("nav-arrow")) {
      const c = document.createElement("canvas");
      c.width = c.height = 48;
      const x = c.getContext("2d");
      x.lineCap = x.lineJoin = "round";
      for (const [col, w] of [["#263238", 13], ["#ffffff", 6.5]]) {
        x.strokeStyle = col;
        x.lineWidth = w;
        x.beginPath();
        x.moveTo(17, 9); x.lineTo(33, 24); x.lineTo(17, 39); // punta verso destra = verso della linea
        x.stroke();
      }
      g.addImage("nav-arrow", x.getImageData(0, 0, 48, 48), { pixelRatio: 3 });
    }
    if (!g.getLayer("arrows")) {
      g.addLayer({ id: "arrows", type: "symbol", source: "lines", filter: ["==", ["get", "a"], 1],
        layout: { "symbol-placement": "line", "symbol-spacing": 90, "icon-image": "nav-arrow", "icon-allow-overlap": true,
          "icon-ignore-placement": true, "icon-rotation-alignment": "map", "icon-pitch-alignment": "map" } });
    }
    // edifici dei punti di interesse: ricolorati con il colore della categoria (poco più alti, così coprono quelli normali)
    if (!g.getSource("poi-bld")) g.addSource("poi-bld", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    if (!g.getLayer("poi-bld")) {
      g.addLayer({ id: "poi-bld", type: "fill-extrusion", source: "poi-bld", minzoom: 14,
        paint: { "fill-extrusion-color": ["get", "c"], "fill-extrusion-opacity": 0.95, "fill-extrusion-base": 0,
          "fill-extrusion-height": ["+", ["get", "h"], 0.8], "fill-extrusion-vertical-gradient": true } }, "lines");
    } else if (g.getLayer("bld")) {
      g.moveLayer("poi-bld", "lines");
    }
    if (!g.getLayer("poi-src")) { // invisibile: fa scaricare il livello dei punti di interesse insieme agli edifici
      g.addLayer({ id: "poi-src", type: "circle", source: "ofm", "source-layer": "poi", minzoom: 13, paint: { "circle-opacity": 0, "circle-radius": 1 } });
    }
    if (!g.getLayer("place-src")) { // invisibile: fa scaricare i nomi dei paesi (per le scritte in 3D)
      g.addLayer({ id: "place-src", type: "circle", source: "ofm", "source-layer": "place", paint: { "circle-opacity": 0, "circle-radius": 1 } });
    }
    if (this._settings.names3d !== false) this._initPlaces3d();
    if (!g.getLayer("tun")) {
      g.addLayer({ id: "tun", type: "line", source: "ofm", "source-layer": "transportation", minzoom: 12,
        filter: ["==", ["get", "brunnel"], "tunnel"], paint: { "line-opacity": 0 } });
    }
    const style = this._settings.bldStyle || "colorati";
    if (g.getLayer("bld") && (!want || this._bldApplied !== style)) {
      g.removeLayer("bld");
      if (g.getLayer("bld-roof")) g.removeLayer("bld-roof");
    }
    if (want && !g.getLayer("bld")) {
      g.addLayer({ id: "bld", type: "fill-extrusion", source: "ofm", "source-layer": "building", minzoom: 14,
        paint: this._bldPaint(style) }, "lines");
      // il disegno delle finestre finirebbe anche sui tetti (MapLibre usa lo stesso per pareti e tetto):
      // una lastra sottile di colore pieno sopra ogni edificio copre il tetto
      if (style === "finestre") {
        g.addLayer({ id: "bld-roof", type: "fill-extrusion", source: "ofm", "source-layer": "building", minzoom: 14,
          paint: this._roofPaint() }, "lines");
      }
      this._bldApplied = style;
    }
    // luce: più radente e un po' più forte con gli stili colorati, così le facciate hanno chiari e scuri come nei navigatori
    g.setLight(this._nightOn ? { anchor: "viewport", color: "#9fb4ff", intensity: 0.25, position: [1.3, 230, 45] }
      : style === "semplici" ? { anchor: "viewport", color: "#ffffff", intensity: 0.5, position: [1.15, 210, 30] }
      : { anchor: "viewport", color: "#fff8ee", intensity: 0.45, position: [1.3, 230, 45] });
    try { g.setSky(this._skySpec()); } catch (e) { /* cielo non supportato */ }
    // mezzo 3D: sopra edifici e percorso
    if (!g.getSource("veh3d")) g.addSource("veh3d", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    if (!g.getLayer("veh3d")) {
      g.addLayer({ id: "veh3d", type: "fill-extrusion", source: "veh3d",
        paint: { "fill-extrusion-color": ["get", "c"], "fill-extrusion-base": ["get", "b"], "fill-extrusion-height": ["get", "h"],
          "fill-extrusion-opacity": 1, "fill-extrusion-vertical-gradient": true } });
      g.on("zoom", () => { if (this._settings.veh3d !== false && this._veh3dPos()) this._drawVeh3d(); });
      // la targa è agganciata al mezzo per coordinate: la ri-misura solo quando il mezzo si ridimensiona (zoom) o la mappa si ferma
      // la targa sta sul retro del mezzo e la prospettiva cambia a ogni fotogramma: la si riposiziona a ogni "move",
      // ma al massimo una volta per fotogramma (requestAnimationFrame)
      g.on("move", () => this._schedulePlate3d());
    } else {
      g.moveLayer("veh3d");
    }
    this._veh3dKey = null;
    // nuvole in cielo: disegnate su un foglio sopra la mappa, in prospettiva con la telecamera
    if (!this._cloudHooked) {
      this._cloudHooked = true;
      // durante un gesto dell'utente (trascinamento/zoom/rotazione/inclinazione) il ridisegno delle nuvole si ferma: si
      // riprende quando la mappa smette di muoversi, così il gesto resta fluido
      // edifici/POI nascosti mentre le DITA sono sullo schermo (non in base al movimento della telecamera: "moveend" scatta
      // anche se tieni il dito fermo un attimo, e faceva ricomparire gli edifici mentre stavi ancora toccando)
      const m3 = this.$("map3d");
      this._g3downs = 0;
      this._g3ptrs ||= new Set(); // dita appoggiate sulla mappa 3D (per identificativo)
      if (!this._g3ptrHooked) {
        this._g3ptrHooked = true;
        m3.addEventListener("pointerdown", (e) => {
          this._g3ptrs.add(e.pointerId); this._g3downs = this._g3ptrs.size;
          this._g3lastPtr = Date.now(); this._g3interacting = true; this._g3Heavy(false);
        }, { passive: true });
        m3.addEventListener("pointermove", () => { if (this._g3downs) this._g3lastPtr = Date.now(); }, { passive: true });
        const release = (e) => {
          if (e) { if (!this._g3ptrs.delete(e.pointerId)) return; } else this._g3ptrs.clear();
          this._g3downs = this._g3ptrs.size;
          if (this._g3downs === 0 && this._g3interacting) {
            this._g3interacting = false;
            this._g3Heavy(true);
            // appena si mollano le dita, in guida la vista torna subito sul mezzo (sempre centrato)
            if (this._nav?.fix && this._nav.follow && this._isGuida() && this._3d && this._g3ok) { this._g3key = null; this._sync3d(); }
          }
        };
        // il dito può staccarsi sopra un altro elemento (croce dei comandi, barre): il rilascio si ascolta su TUTTA la
        // finestra. Prima solo sulla mappa 3D: il rilascio si perdeva, risultava "dito appoggiato" e la camera non seguiva più
        for (const ev of ["pointerup", "pointercancel"]) window.addEventListener(ev, release, { capture: true, passive: true });
        window.addEventListener("blur", () => release(null));
        document.addEventListener("visibilitychange", () => { if (document.hidden) release(null); });
      }
      // sicurezza: se un rilascio sfugge (dito fuori dallo schermo), a telecamera ferma e senza dita giù si rimettono
      g.on("moveend", () => { if (!this._g3downs) { this._g3interacting = false; this._g3Heavy(true); } });
      g.on("render", () => { if (!this._g3interacting) this._scheduleCloudDraw(); });
      g.on("resize", () => this._drawClouds());
    }
    this._cloudKey = null; // ricolora (giorno/notte) e ridisegna
    this._scheduleClouds(true);
  }

  // ----------------------------------------------------------------- nuvole in 3D
  // Nuvolosità prevista (Open-Meteo, dal backend) su una griglia 3×3 intorno al centro della vista; le nuvole stanno su un
  // reticolo fisso di ~1,5 km con posizione e forma "casuali" ma sempre uguali per ogni casella, così non saltano muovendo la mappa.

  _scheduleClouds(now = false) {
    clearTimeout(this._cloudTimer);
    this._cloudTimer = setTimeout(() => this._updateClouds(), now ? 50 : 800);
  }

  async _updateClouds() {
    // nuvole volumetriche 3D disattivate: pesanti sulla WebView e rese non sempre bene. Gli avvisi meteo lungo il
    // percorso restano come icone. (Si possono riattivare in futuro.)
    this._clouds = [];
    this._updateRainHere(); // la pioggia invece c'è: non dipende più dalle nuvole
    this._drawClouds();
    return; // eslint-disable-line no-unreachable
    const g = this._g3;
    if (!this._3d || !g || !this._g3ok) return;
    if (this._settings.clouds3d === false) {
      this._clouds = [];
      this._cloudKey = "off";
      this._drawClouds();
      return;
    }
    const c = g.getCenter();
    // meteo della zona: di nuovo se ci si sposta di oltre ~8 km o dopo mezz'ora
    const az = this._cloudWx;
    if (!az || Math.abs(az.lat - c.lat) > 0.08 || Math.abs(az.lon - c.lng) > 0.08 || Date.now() - az.at > 1800000) {
      if (!this._cloudLoading) {
        this._cloudLoading = true;
        const lat = +c.lat.toFixed(2), lon = +c.lng.toFixed(2), t = Date.now() / 1000;
        const pts = [];
        for (const dy of [-0.12, 0, 0.12]) for (const dx of [-0.16, 0, 0.16]) pts.push([+(lat + dy).toFixed(2), +(lon + dx).toFixed(2), t]);
        try {
          const r = await this._hass.callWS({ type: "navigator/weather", points: pts });
          this._cloudWx = { lat, lon, at: Date.now(), pts: r.points.map((w) => ({ lat: w.lat, lon: w.lon, cloud: w.cloud,
            rain: (w.prec || 0) >= 0.3 || (w.code ?? 0) >= 51 }) ) };
          console.debug("[Navigator nuvole] meteo della zona", this._cloudWx.pts.map((p) => p.cloud));
        } catch (e) {
          // meteo non disponibile: nuvole "medie", si riprova tra 5 minuti
          this._cloudWx = { lat, lon, at: Date.now() - 1500000, pts: [{ lat, lon, cloud: 45, rain: false }] };
          console.debug("[Navigator nuvole] meteo non disponibile", e?.message || e);
        }
        this._cloudLoading = false;
        this._cloudKey = null;
      }
    }
    if (!this._cloudWx) return;
    const key = `${this._nightOn ? 1 : 0}|${this._cloudWx.at}|${Math.round(c.lat / 0.03)}|${Math.round(c.lng / 0.04)}`;
    if (key === this._cloudKey) return;
    this._cloudKey = key;
    this._clouds = this._cloudList(c.lat, c.lng);
    this._drawClouds();
  }

  // pioggia nella zona inquadrata in 3D: adesso (Open-Meteo, al centro della vista; di nuovo dopo ~8 km o 20 min)
  // oppure prevista dal meteo del percorso entro ~8 km. Intensità 0..1 per le gocce animate.
  async _updateRainHere() {
    const g = this._g3;
    if (!this._3d || !g || !this._g3ok) { this._rainHere = 0; return; }
    const c = g.getCenter();
    const R = (this._rainWx ||= { at: 0, lat: 0, lon: 0, v: 0 });
    if (!R.busy && (Date.now() - R.at > 1200000 || Math.abs(R.lat - c.lat) > 0.08 || Math.abs(R.lon - c.lng) > 0.08)) {
      R.busy = true;
      try {
        const r = await this._hass.callWS({ type: "navigator/weather", points: [[+c.lat.toFixed(2), +c.lng.toFixed(2), Date.now() / 1000]] });
        const w = r.points?.[0] || {};
        const code = w.code ?? 0;
        const snow = (code >= 71 && code <= 77) || code === 85 || code === 86; // neve (codici WMO)
        const wet = (w.prec || 0) >= 0.3 || (code >= 51 && code < 100);
        R.v = wet && !snow ? Math.min(1, 0.45 + (w.prec || 0) / 4) : 0;
        R.snow = snow ? Math.min(1, 0.5 + (w.prec || 0) / 3) : 0;
        R.fog = w.code === 45 || w.code === 48 ? 0.75 : 0; // nebbia adesso
      } catch (e) { R.v = 0; R.fog = 0; R.snow = 0; }
      R.at = Date.now(); R.lat = c.lat; R.lon = c.lng; R.busy = false;
    }
    // previsioni lungo il percorso: conta solo il punto del percorso PIÙ VICINO (lungo la strada in guida, in linea
    // d'aria fuori), entro 3 km. Se c'è, decide lui che tempo fa (pioggia, neve, nebbia): è la stessa icona che vedi
    // sulla mappa lì sopra. Altrimenti vale il meteo di adesso nel punto che stai guardando.
    let best = null, bestD;
    const along = this._nav?.snap && this._wx?.rt === this._geom?.(this._result?.routes?.[this._sel]) ? this._nav.snap.along : null;
    bestD = 3000;
    for (const p of this._wx?.done ? this._wx.items : []) {
      const dd = along != null ? Math.abs(p.along - along) : distM(p.ll, [c.lat, c.lng]);
      if (dd < bestD) { bestD = dd; best = p; }
    }
    let snow, fog, rainV;
    if (best?.warn?.length) {
      const has = (re) => best.warn.some((w) => re.test(w.txt));
      snow = has(/Neve/) ? 0.6 : 0;
      rainV = !snow && has(/Pioggia|Temporale/) ? 0.55 : 0;
      fog = best.warn.some((w) => w.kind === "fog") ? 0.65 : (R.fog || 0);
    } else {
      snow = R.snow || 0; rainV = R.v || 0; fog = R.fog || 0;
    }
    const v = snow > 0 ? 0 : rainV; // con la neve niente pioggia insieme
    if (v !== this._rainHere || fog !== this._fogHere || snow !== this._snowHere) {
      this._rainHere = v; this._fogHere = fog; this._snowHere = snow; this._scheduleCloudDraw?.();
    }
  }

  // nuvole della zona: [{x, y (Mercatore), alt (m), rain, puffs: [{dx, dy, dz, r} in metri]}]
  _cloudList(lat0, lon0) {
    const wx = this._cloudWx.pts;
    // lungo il percorso vale il meteo all'ora di passaggio (pioggia compresa)
    const route = (this._wx?.done ? this._wx.items : []).map((p) => ({ lat: p.ll[0], lon: p.ll[1], cloud: p.cloud,
      rain: !!p.warn?.some((w) => /Pioggia|Temporale|Neve/.test(w.txt)) }));
    const all = [...route, ...wx];
    const near = (la, lo) => {
      let best = null, bd = Infinity;
      for (const p of all) {
        const d = (p.lat - la) ** 2 + ((p.lon - lo) * 0.7) ** 2;
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    };
    const rnd = (a, b, k) => { // numero pseudo-casuale fisso per casella
      const x = Math.sin(a * 127.1 + b * 311.7 + k * 74.7) * 43758.5453;
      return x - Math.floor(x);
    };
    const MC = window.maplibregl.MercatorCoordinate;
    const dist2 = (la, lo) => (la - lat0) ** 2 + ((lo - lon0) * 0.7) ** 2;
    let ground = 0; // quota del terreno al centro (già col rilievo accentuato): le nuvole stanno sopra
    try { ground = this._g3.queryTerrainElevation([lon0, lat0]) || 0; } catch (e) { /* senza rilievo */ }
    const STEP = 0.012; // ~1,3 km
    const out = [];
    const ci = Math.round(lat0 / STEP), cj = Math.round(lon0 / STEP);
    const R = 15; // caselle per lato: ~18 km intorno al centro
    for (let i = ci - R; i <= ci + R; i++) {
      for (let j = cj - R; j <= cj + R; j++) {
        const la = i * STEP, lo = j * STEP;
        const w = near(la, lo);
        const cover = w?.cloud ?? 45;
        // fino a tre nuvole per casella: con cielo coperto tante e grandi, con sereno qualche nuvoletta
        for (let n = 0; n < 3; n++) {
          if (rnd(i, j, n) > Math.min(0.97, 0.05 + (cover / 100) * 0.95) * [1, 0.8, 0.5][n]) continue;
          const clat = la + (rnd(i, j, n + 10) - 0.5) * STEP, clon = lo + (rnd(i, j, n + 20) - 0.5) * STEP * 1.4;
          const size = 200 + rnd(i, j, n + 30) * 420 * (0.6 + cover / 200); // metri
          const m = MC.fromLngLat([clon, clat], 0);
          const puffs = [];
          const np = 4 + Math.floor(rnd(i, j, n + 50) * 4);
          for (let k = 0; k < np; k++) {
            const ang = rnd(i, j, n * 11 + k + 60) * Math.PI * 2;
            const off = k ? size * (0.3 + rnd(i, j, n * 11 + k + 70) * 0.7) : 0;
            puffs.push({ dx: Math.cos(ang) * off, dy: Math.sin(ang) * off * 0.6, dz: (k ? rnd(i, j, n * 11 + k + 90) * 0.5 : 0.3) * size * 0.6,
              r: size * (k ? 0.3 + rnd(i, j, n * 11 + k + 80) * 0.3 : 0.55) });
            if (puffs.length > 1 && dist2(clat, clon) > 0.008) break; // lontane: bastano due sbuffi, si vedono piccole
          }
          // quota: 500–1400 m sopra il terreno (quello del punto, se già caricato, o quello al centro), così le nuvole
          // galleggiano sopra il paesaggio e si vedono anche con poco cielo sullo schermo
          let gl = ground;
          try { gl = Math.max(ground, this._g3.queryTerrainElevation([clon, clat]) || 0); } catch (e) { /* fuori dai dati del rilievo */ }
          out.push({ x: m.x, y: m.y, alt: gl + 500 + rnd(i, j, n + 40) * 900, rain: !!w?.rain, puffs });
        }
      }
    }
    return out;
  }

  // sbuffo di nuvola: macchia bianca sfumata (e una grigia per la parte in ombra)
  _cloudSprite(col) {
    this._cloudSprites ??= {};
    if (this._cloudSprites[col]) return this._cloudSprites[col];
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const x = c.getContext("2d");
    const gr = x.createRadialGradient(64, 58, 4, 64, 64, 64);
    gr.addColorStop(0, `rgba(${col},1)`);
    gr.addColorStop(0.55, `rgba(${col},.85)`);
    gr.addColorStop(1, `rgba(${col},0)`);
    x.fillStyle = gr;
    x.fillRect(0, 0, 128, 128);
    return (this._cloudSprites[col] = c);
  }

  // disegna le nuvole a ogni fotogramma della vista 3D: proiezione prospettica fatta qui, con posizione e orientamento
  // della telecamera di MapLibre (che non sa mettere oggetti in quota)
  _drawClouds() {
    const g = this._g3;
    if (!g) return;
    let cv = this._cloudCanvas;
    if (!cv || !cv.isConnected) {
      cv = this._cloudCanvas = document.createElement("canvas");
      cv.className = "clouds3d";
      g.getCanvas().after(cv); // subito sopra la mappa, sotto i segnaposto
    }
    const W = g.getCanvas().clientWidth, H = g.getCanvas().clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      cv.style.width = `${W}px`;
      cv.style.height = `${H}px`;
    }
    const x = cv.getContext("2d");
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, W, H);
    if (!this._3d) return;
    if (!this._clouds?.length) { // senza nuvole 3D: pioggia e nebbia, se nella zona ci sono
      const tilt = g.getPitch() > 25 && this._settings.wx3d !== false; // spente dalle impostazioni: niente animazioni
      if ((this._fogHere || 0) > 0 && tilt) this._drawFog(x, W, H, this._fogHere);
      if ((this._rainHere || 0) > 0 && tilt) this._drawRain(x, W, H, this._rainHere);
      else this._rainDrops = null;
      if ((this._snowHere || 0) > 0 && tilt) this._drawSnow(x, W, H, this._snowHere);
      else this._snowFlakes = null;
      if (tilt && ((this._fogHere || 0) > 0 || (this._rainHere || 0) > 0 || (this._snowHere || 0) > 0)) g.triggerRepaint(); // animazione viva
      return;
    }
    let cam;
    try { // posizione della telecamera (MapLibre 5: dalla trasformazione della vista)
      const t = g.transform;
      cam = window.maplibregl.MercatorCoordinate.fromLngLat(t.getCameraLngLat(), t.getCameraAltitude());
    } catch (e) { return; }
    if (!cam) return;
    const MC = window.maplibregl.MercatorCoordinate;
    const u = MC.fromLngLat(g.getCenter(), 0).meterInMercatorCoordinateUnits();
    const b = (g.getBearing() * Math.PI) / 180, p = (g.getPitch() * Math.PI) / 180;
    const fov = ((g.transform?.fov || 36.87) * Math.PI) / 180;
    const F = H / 2 / Math.tan(fov / 2);
    // assi della telecamera nel Mercatore (x verso est, y verso sud, z in alto)
    const hx = Math.sin(b), hy = -Math.cos(b);
    const f = [hx * Math.sin(p), hy * Math.sin(p), -Math.cos(p)];
    const r = [Math.cos(b), Math.sin(b), 0];
    const up = [hx * Math.cos(p), hy * Math.cos(p), Math.sin(p)];
    const night = this._nightOn;
    const light = this._cloudSprite(night ? "120,130,150" : "255,255,255");
    const shadow = this._cloudSprite(night ? "70,78,95" : "196,203,212");
    const rainL = this._cloudSprite(night ? "85,92,108" : "170,177,187");
    const rainS = this._cloudSprite(night ? "55,60,72" : "128,135,146");
    const items = [];
    for (const c of this._clouds) {
      for (const pf of c.puffs) {
        const vx = c.x + pf.dx * u - cam.x, vy = c.y + pf.dy * u - cam.y, vz = (c.alt + pf.dz) * u - cam.z;
        const z = vx * f[0] + vy * f[1] + vz * f[2];
        if (z <= 50 * u) continue; // dietro o troppo vicino alla telecamera
        const sx = W / 2 + ((vx * r[0] + vy * r[1]) / z) * F;
        const sy = H / 2 - ((vx * up[0] + vy * up[1] + vz * up[2]) / z) * F;
        const rad = ((pf.r * u) / z) * F;
        if (rad < 1 || sx + rad < 0 || sx - rad > W || sy + rad < 0 || sy - rad > H) continue;
        const dist = Math.hypot(vx, vy, vz) / u;
        // sfumano lontano (oltre ~15 km), vicino alla telecamera e nella parte bassa dello schermo (la strada resta libera)
        const a = Math.min(1, Math.max(0, (22000 - dist) / 7000)) * Math.min(1, Math.max(0, (dist - 1200) / 1600))
          * Math.min(1, Math.max(0, (H * 0.62 - sy) / (H * 0.3)));
        if (a <= 0.02) continue;
        items.push([z, sx, sy, rad, a, c.rain]);
      }
    }
    items.sort((m, n) => n[0] - m[0]); // prima le lontane
    // vista dall'alto o poco inclinata: niente nuvole, coprirebbero la mappa (compaiono da ~33° a ~50°)
    const top = Math.min(1, Math.max(0, (g.getPitch() - 33) / 16));
    if (top > 0) for (const [, sx, sy, rad, a, rain] of items) {
      x.globalAlpha = a * top * 0.7;
      x.drawImage(rain ? rainS : shadow, sx - rad, sy - rad * 0.8, rad * 2, rad * 2); // ombra sotto
      x.globalAlpha = Math.min(1, a * top * 1.25);
      x.drawImage(rain ? rainL : light, sx - rad, sy - rad * 1.1, rad * 2, rad * 2);
    }
    x.globalAlpha = 1;
    // pioggia: se nella zona ci sono nuvole con pioggia, gocce che cadono sopra la vista (solo in 3D)
    const rainN = this._clouds.filter((c) => c.rain).length;
    const intensity = Math.min(1, rainN / Math.max(1, this._clouds.length));
    if (intensity > 0.12 && g.getPitch() > 25) {
      this._drawRain(x, W, H, intensity);
      g.triggerRepaint(); // mantiene viva l'animazione anche da fermi
    } else {
      this._rainDrops = null;
    }
  }

  // pioggia animata su un foglio sopra la mappa (2D): tante gocce-striscia che cadono con un po' di vento
  // nebbia: velo biancastro più fitto verso l'orizzonte e banchi che scorrono lenti di lato (la strada in basso resta leggibile)
  _drawFog(x, W, H, v) {
    const t = performance.now() / 1000;
    const night = this._nightOn;
    const col = night ? "150,160,175" : "226,230,234";
    const veil = x.createLinearGradient(0, 0, 0, H);
    veil.addColorStop(0, `rgba(${col},${0.85 * v})`);
    veil.addColorStop(0.45, `rgba(${col},${0.5 * v})`);
    veil.addColorStop(0.8, `rgba(${col},${0.12 * v})`);
    veil.addColorStop(1, `rgba(${col},0)`);
    x.fillStyle = veil;
    x.fillRect(0, 0, W, H);
    for (let i = 0; i < 7; i++) {
      const sp = 9 + (i % 3) * 7; // px al secondo, diversi per banco
      const span = W * 1.8;
      const cx = ((i * W * 0.41 + t * sp) % span) - W * 0.4;
      const cy = H * (0.18 + ((i * 0.13) % 0.5));
      const r = W * (0.35 + (i % 4) * 0.08);
      const gr = x.createRadialGradient(cx, cy, 0, cx, cy, r);
      gr.addColorStop(0, `rgba(${col},${0.32 * v})`);
      gr.addColorStop(1, `rgba(${col},0)`);
      x.fillStyle = gr;
      x.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
  }

  // neve: fiocchi bianchi che scendono lenti ondeggiando, i più vicini più grandi e veloci; più fitti con nevicata forte
  _drawSnow(x, W, H, intensity) {
    const now = performance.now();
    const dt = Math.min(60, now - (this._snowT || now)) / 1000;
    this._snowT = now;
    const n = Math.round(70 + 230 * intensity);
    let fl = this._snowFlakes;
    if (!fl || fl.length !== n || fl.W !== W || fl.H !== H) {
      fl = this._snowFlakes = Array.from({ length: n }, () => {
        const z = Math.random(); // 0 lontano, 1 vicino
        return { x: Math.random() * W, y: Math.random() * H, z, ph: Math.random() * 6.28, r: 1 + z * 3.2, v: 25 + z * 70 };
      });
      fl.W = W; fl.H = H;
    }
    x.fillStyle = "#fff";
    for (const f of fl) {
      f.y += f.v * dt;
      f.ph += dt * (0.8 + f.z);
      f.x += Math.sin(f.ph) * (8 + f.z * 18) * dt + 6 * dt; // ondeggia e un filo di vento
      if (f.y > H + 6) { f.y = -6; f.x = Math.random() * W; }
      if (f.x > W + 6) f.x = -6; else if (f.x < -6) f.x = W + 6;
      x.globalAlpha = 0.55 + f.z * 0.4;
      x.beginPath(); x.arc(f.x, f.y, f.r, 0, 6.283); x.fill();
    }
    x.globalAlpha = 1;
  }

  _drawRain(x, W, H, intensity) {
    const now = performance.now();
    let dt = now - (this._rainT || now); this._rainT = now;
    dt = Math.min(60, dt);
    const night = this._nightOn;
    const n = Math.round(90 + 320 * intensity); // più fitta con pioggia forte
    const wind = 0.12; // inclinazione/vento (px per px di caduta)
    if (!this._rainDrops || this._rainDrops.length !== n) {
      this._rainDrops = Array.from({ length: n }, () => ({
        x: Math.random() * (W + 120) - 60, y: Math.random() * H,
        len: 14 + Math.random() * 20, spd: 1.1 + Math.random() * 1.0, a: 0.45 + Math.random() * 0.45,
      }));
    }
    x.lineWidth = 2;
    x.lineCap = "round";
    // colore completo (prima era scritto a metà, "rgba(…," : il browser lo scartava e le gocce uscivano nere)
    x.strokeStyle = night ? "rgb(170,190,225)" : "rgb(225,238,255)";
    for (const d of this._rainDrops) {
      d.y += d.spd * dt;
      d.x += d.spd * dt * wind;
      if (d.y > H + 20) { d.y = -20; d.x = Math.random() * (W + 120) - 60; }
      if (d.x > W + 30) d.x -= W + 120;
      // un filo più trasparente in cima (lascia leggibile il pannello)
      const fade = Math.min(1, Math.max(0.35, (d.y / H) * 1.3));
      x.globalAlpha = Math.min(1, d.a * fade * (0.7 + 0.3 * intensity));
      x.beginPath();
      x.moveTo(d.x, d.y);
      x.lineTo(d.x - d.len * wind, d.y - d.len);
      x.stroke();
    }
    x.globalAlpha = 1;
  }

  // aspetto degli edifici: semplici (grigio chiaro), colorati secondo l'altezza (bassi chiari, alti azzurri) o con finestre
  _bldPaint(style) {
    const g = this._g3;
    const h = BLD_H;
    const base = { "fill-extrusion-height": h, "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
      "fill-extrusion-vertical-gradient": true };
    const night = this._nightOn;
    if (style === "semplici") return { ...base, "fill-extrusion-color": night ? "#4d535c" : "#d9d4cb", "fill-extrusion-opacity": 0.85 };
    if (style === "finestre") {
      if (g.hasImage("bld-win")) g.removeImage("bld-win");
      g.addImage("bld-win", this._windowPattern(night), { pixelRatio: 1 });
      return { ...base, "fill-extrusion-pattern": "bld-win", "fill-extrusion-opacity": 0.95 };
    }
    return { ...base, "fill-extrusion-opacity": 0.92, "fill-extrusion-color": night
      ? ["interpolate", ["linear"], h, 0, "#3a4250", 25, "#334866", 100, "#2c4f80", 200, "#2a5a9a"]
      : ["interpolate", ["linear"], h, 0, "#eef1f4", 10, "#dfe7ef", 25, "#c7d7ea", 50, "#a9c3e3", 100, "#86a9d6", 200, "#6e93c8"] };
  }

  // tetto pieno per lo stile con finestre: lastra di 30 cm sopra l'edificio
  _roofPaint() {
    const h = BLD_H;
    return { "fill-extrusion-color": this._nightOn ? "#30363f" : "#d3d9e0", "fill-extrusion-opacity": 0.95, "fill-extrusion-vertical-gradient": false,
      "fill-extrusion-base": h, "fill-extrusion-height": ["+", h, 0.3] };
  }

  // facciata chiara con finestre azzurre (si ripete sui lati degli edifici): poche, distanziate, non un retino fitto
  _windowPattern(night = false) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const x = c.getContext("2d");
    x.fillStyle = night ? "#2a313b" : "#e8edf3";
    x.fillRect(0, 0, 64, 64);
    // una finestra per riquadro, con tanto muro intorno: poche e distanziate; di notte accese (gialle)
    x.fillStyle = night ? "#ffcf6e" : "#7d9cc4";
    x.fillRect(23, 22, 18, 16);
    x.fillStyle = night ? "#fff0c2" : "#b9cde6"; // riflesso
    x.fillRect(23, 22, 18, 4);
    return x.getImageData(0, 0, 64, 64);
  }

  _set3dBase() {
    const g = this._g3;
    if (!g || !this._g3ok) return;
    g.removeLayer("base");
    g.removeSource("base");
    g.addSource("base", this._baseSource());
    g.addLayer({ id: "base", type: "raster", source: "base", paint: this._basePaint() }, "hs");
    this._desertVeil();
  }

  // deserto in 3D: velo color sabbia sopra la foto in bianco e nero (le zone scure diventano dune in ombra)
  _desertVeil() {
    const g = this._g3;
    if (!g) return;
    const on = this._layer === "deserto";
    if (!on) { if (g.getLayer("desert")) g.removeLayer("desert"); return; }
    if (!g.getSource("desert")) {
      g.addSource("desert", { type: "geojson", data: { type: "Feature", properties: {},
        geometry: { type: "Polygon", coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] } } });
    }
    const paint = { "fill-color": this._nightOn ? "#8a6a3c" : "#e0a95e", "fill-opacity": this._nightOn ? 0.4 : 0.55 };
    if (g.getLayer("desert")) g.removeLayer("desert");
    g.addLayer({ id: "desert", type: "fill", source: "desert", paint }, "hs");
  }

  // percorso e segnaposto ricopiati da Leaflet (una volta per fotogramma, anche se cambiano più cose insieme)
  _schedule3d() {
    if (!this._3d || this._g3pending) return;
    this._g3pending = true;
    requestAnimationFrame(() => { this._g3pending = false; this._update3d(); });
  }

  _update3d() {
    try { this._update3dData(); } catch (e) { this._recover3d(e); }
  }

  _update3dData() {
    const g = this._g3;
    if (!this._3d || !g || !this._g3ok) return;
    const feats = [];
    let i = 0;
    const lines = [];
    this._routeLayer.eachLayer((l) => lines.push(l));
    this._tripLayer?.eachLayer((l) => lines.push(l));
    this._liveLayer?.eachLayer((l) => lines.push(l));
    lines.forEach((l) => {
      if (!(l instanceof L.Polyline)) return;
      const o = l.options;
      feats.push({ type: "Feature", properties: { c: o.color, w: o.weight, o: o.opacity ?? 1, i: i++, d: o.dashArray ? 1 : 0, a: o.arrows ? 1 : 0 },
        geometry: { type: "LineString", coordinates: l.getLatLngs().map((p) => [p.lng, p.lat]) } });
    });
    g.getSource("lines").setData({ type: "FeatureCollection", features: feats });
    for (const m of this._g3markers) m.remove();
    this._g3markers = [];
    for (const grp of [this._markerLayer, this._poiLayer, this._wxLayer, this._liveLayer, this._stepLayer, this._rwLayer].filter(Boolean)) {
      grp.eachLayer((l) => {
        const ic = l.options?.icon?.options;
        if (!(l instanceof L.Marker) || !ic?.html) return;
        if (l.options.isMe && this._settings.veh3d !== false) return; // in 3D c'è il modellino
        const el = document.createElement("div");
        el.innerHTML = ic.html;
        const a = ic.iconAnchor || [0, 0];
        const ll = l.getLatLng();
        const up = grp === this._wxLayer ? 120 : 0; // meteo: sospeso in cielo
        if (up) el.classList.add("wx3d");
        this._g3markers.push(new window.maplibregl.Marker({ element: el, anchor: "top-left", offset: [-a[0], -a[1] - up] })
          .setLngLat([ll.lng, ll.lat]).addTo(g));
      });
    }
    this._drawMe3d();
  }

  // il veicolo: disegnato sul piano della mappa, così si inclina con la vista e gira con la direzione di marcia
  // direzione della posizione seguita prima di partire: dallo spostamento rispetto alla posizione di prima (oltre 15 m)
  _meTurn(lat, lon) {
    if (this._me && lat != null && lon != null && distM([this._me.lat, this._me.lon], [lat, lon]) > 15) {
      this._meDir = bearing([this._me.lat, this._me.lon], [lat, lon]);
    }
  }

  // posizione del mezzo 3D: quella della guida, altrimenti quella seguita ("La mia posizione", prima di partire)
  _veh3dPos() {
    if (this._nav?.fix) return this._carDisp ? { ...this._carDisp } : { lat: this._nav.fix.lat, lon: this._nav.fix.lon, dir: this._nav.dir ?? 0 };
    if (this._me && !this._nav) return { lat: this._me.lat, lon: this._me.lon, dir: this._meDir ?? 0 };
    return null;
  }

  // movimento fluido del mezzo 3D: scorre dalla posizione mostrata a quella nuova nel tempo tra due posizioni (rAF),
  // invece di saltare a ogni aggiornamento del GPS. La direzione la prende dal proprio movimento, così punta sempre
  // nel verso in cui va (anche fuori percorso): niente movimento "a granchio".
  _carGlide(prev, fix, dir, now) {
    const from = this._carDisp
      || (prev ? { lat: prev.lat, lon: prev.lon, dir: this._nav?.heading ?? dir } : { lat: fix.lat, lon: fix.lon, dir });
    cancelAnimationFrame(this._carRaf);
    // primo punto, salto grande (ricalcolo/teletrasporto) o fermo: niente scorrimento
    if (!prev || distM([from.lat, from.lon], [fix.lat, fix.lon]) > 120) {
      this._carAnim = null;
      this._carDisp = { lat: fix.lat, lon: fix.lon, dir };
      return;
    }
    // il muso segue lo spostamento reale (se significativo), altrimenti resta com'è: così va sempre avanti
    const moveDir = distM([from.lat, from.lon], [fix.lat, fix.lon]) > 4 ? bearing([from.lat, from.lon], [fix.lat, fix.lon]) : from.dir;
    const dd = ((((moveDir - from.dir) % 360) + 540) % 360) - 180; // giro più corto per la direzione
    const dur = Math.max(300, Math.min(1400, prev.time ? now - prev.time : 700));
    this._carAnim = { t0: performance.now(), dur, from, to: { lat: fix.lat, lon: fix.lon }, dir0: from.dir, dd };
    const step = () => {
      const a = this._carAnim;
      if (!a || !this._nav) return;
      const t = Math.min(1, (performance.now() - a.t0) / a.dur);
      const e = t * (2 - t); // partenza e arrivo morbidi
      this._carDisp = { lat: a.from.lat + (a.to.lat - a.from.lat) * e, lon: a.from.lon + (a.to.lon - a.from.lon) * e, dir: a.dir0 + a.dd * e };
      if (this._3d && this._g3 && this._g3ok && this._settings.veh3d !== false) { try { this._drawVeh3d(); } catch (err) { /* vista 3D ricreata */ } }
      if (t < 1) this._carRaf = requestAnimationFrame(step);
    };
    this._carRaf = requestAnimationFrame(step);
  }

  _drawMe3d() {
    const g = this._g3;
    const f = this._nav?.fix;
    if (this._3d && g && !this._nav && this._settings.veh3d !== false && g.getSource("veh3d")) { this._drawVeh3d(); return; }
    if (!this._3d || !g || !f) return;
    try { // un errore nella vista 3D non deve fermare la guida (chiamata a ogni posizione)
      if (this._settings.veh3d !== false && g.getSource("veh3d")) {
        this._me3d?.remove();
        this._me3d = null;
        this._drawVeh3d();
        this._sync3d();
        return;
      }
      g.getSource("veh3d")?.setData({ type: "FeatureCollection", features: [] });
      this._plate3dAt = null;
      this._placePlate3d();
      if (!this._me3d) {
        const el = document.createElement("div");
        el.innerHTML = `<div class="nav-car">${this._vehSvg()}</div>`;
        this._me3d = new window.maplibregl.Marker({ element: el, rotationAlignment: "map", pitchAlignment: "map" })
          .setLngLat([f.lon, f.lat]).addTo(g);
      }
      this._me3d.setLngLat([f.lon, f.lat]).setRotation(this._nav.dir ?? 0);
    } catch (e) { this._recover3d(e); return; }
    this._sync3d();
  }

  // mezzo 3D: modellino ingrandito (più si è lontani più è grande, così sullo schermo resta di misura simile, ~50 px)
  // e girato nella direzione di marcia
  _drawVeh3d() {
    const g = this._g3;
    const src = g?.getSource("veh3d");
    const f = this._veh3dPos();
    if (!src) return;
    // modello 3D vero (Three.js): auto + targa in un unico blocco. Si carica alla prima occasione;
    // finché non è pronto (o se non disponibile) resta il mezzo a estrusioni qui sotto.
    if (!this._car3dReady && !this._car3dInit && this._settings.veh3d !== false) this._initCar3d();
    const kind3d = f ? veh3dFor(this._curVehicle(), this._mode)[0] : null;
    const carLike = !["moto", "scooter", "bici", "piedi"].includes(kind3d);
    if (this._car3dReady && carLike) {
      src.setData({ type: "FeatureCollection", features: [] }); // niente estrusione del mezzo
      if (this._plate3dAt) { this._plate3dAt = null; this._placePlate3d(); } // niente targa HTML
      this._updateCar3d();
      return;
    }
    if (this._car3d) { this._car3d.visible = false; this._g3?.triggerRepaint?.(); } // moto/bici/piedi: via il modello auto
    if (!f || this._settings.veh3d === false) {
      src.setData({ type: "FeatureCollection", features: [] });
      this._plate3dAt = null;
      this._placePlate3d();
      return;
    }
    const v = this._curVehicle();
    const [kind, color] = veh3dFor(v, this._mode);
    const key = `${kind}|${color}|${this._nightOn ? 1 : 0}`;
    if (this._veh3dKey !== key) { this._veh3dKey = key; this._veh3dParts = veh3dParts(kind, this._nightOn ? shade(color, -0.25) : color); }
    const S = this._veh3dScale(kind);
    const th = (f.dir * Math.PI) / 180, cs = Math.cos(th), sn = Math.sin(th);
    const mLat = 1 / 111320, mLon = 1 / (111320 * Math.cos((f.lat * Math.PI) / 180));
    const toLL = (x, y) => [f.lon + (x * cs + y * sn) * S * mLon, f.lat + (-x * sn + y * cs) * S * mLat];
    const feats = this._veh3dParts.map((pt) => {
      const ring = pt.pts.map(([x, y]) => toLL(x, y));
      ring.push(ring[0]);
      return { type: "Feature", properties: { b: pt.b * S, h: pt.h * S, c: pt.c }, geometry: { type: "Polygon", coordinates: [ring] } };
    });
    // targa: placchetta bianca sul retro (geometria) e il testo in un'etichetta attaccata lì sopra
    const plate = v.type && v.plate ? v.plate : "";
    if (plate) {
      const rear = Math.min(...this._veh3dParts.flatMap((pt) => pt.pts.map((q) => q[1])));
      const two = ["moto", "scooter", "bici"].includes(kind);
      const pw = two ? 0.22 : 0.42, zb = two || kind === "camper" ? 0.62 : 0.45, zt = zb + 0.2;
      const ring = [[-pw, rear - 0.04], [pw, rear - 0.04], [pw, rear + 0.02], [-pw, rear + 0.02]].map(([x, y]) => toLL(x, y));
      ring.push(ring[0]);
      feats.push({ type: "Feature", properties: { b: zb * S, h: zt * S, c: "#f4f4f4" }, geometry: { type: "Polygon", coordinates: [ring] } });
      // in misure del modellino (non ingrandite): l'etichetta si ricalcola con lo zoom del momento
      this._plate3dAt = { kind, rear, z: (zb + zt) / 2, w: pw * 2, text: plate };
    } else {
      this._plate3dAt = null;
    }
    src.setData({ type: "FeatureCollection", features: feats });
    this._schedulePlate3d();
  }

  // ---------------------------------------------------------------- modello 3D del mezzo (Three.js)
  // L'auto è un unico oggetto solido (carrozzeria, abitacolo, vetri, ruote, fari) con la TARGA come
  // faccia verticale texturata sul retro: tutto un blocco che si muove insieme. Caricato solo quando
  // serve; se Three.js non è disponibile, resta il mezzo a estrusioni.
  async _initCar3d() {
    if (this._car3dReady || this._car3dInit) return;
    this._car3dInit = true;
    let THREE;
    try { THREE = await loadThree(); } catch (e) { this._car3dInit = false; return; }
    const g = this._g3;
    if (!g || !this._g3ok) { this._car3dInit = false; return; }
    this._THREE = THREE;
    this._car3d = { visible: false, lon: 0, lat: 0, dirRad: 0, elev: 0, meters: 2, mesh: null };
    const self = this;
    const layer = {
      id: "car3d", type: "custom", renderingMode: "2d",
      onAdd(map, gl) {
        const sc = new THREE.Scene();
        sc.add(new THREE.AmbientLight(0xffffff, 1.55));
        const d1 = new THREE.DirectionalLight(0xffffff, 1.5); d1.position.set(0.5, 1.0, 0.7); sc.add(d1);
        const d2 = new THREE.DirectionalLight(0xcad8ff, 0.5); d2.position.set(-0.6, 0.4, -0.5); sc.add(d2);
        self._carScene = sc;
        self._carCam = new THREE.Camera();
        self._carRenderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
        self._carRenderer.autoClear = false;
      },
      render(gl, args) {
        const c = self._car3d;
        if (!c || !c.mesh || !c.visible || !self._carRenderer) return;
        // MapLibre v5 passa un oggetto (matrice in defaultProjectionData.mainMatrix); versioni vecchie un array
        const mtx = Array.isArray(args) ? args : (args?.defaultProjectionData?.mainMatrix || args?.modelViewProjectionMatrix);
        if (!mtx) return;
        const tr = self._g3.transform;
        const ml = window.maplibregl;
        // quota: la matrice mercatore mette a terra il punto al CENTRO della vista (quota tr.elevation); il mezzo non
        // è mai proprio al centro (in guida sta più in basso) e, appena partiti, il centro può avere ancora la quota
        // vecchia: si usa la quota del terreno sotto il mezzo meno quella del centro, ricalcolata a ogni fotogramma.
        // Prima era 0 fisso: in montagna il mezzo appariva spostato finché un pizzico non aggiornava la vista.
        let elev = 0;
        try {
          const q = self._g3.terrain ? self._g3.queryTerrainElevation([c.lon, c.lat]) : null;
          if (q != null && Number.isFinite(q) && Number.isFinite(tr.elevation)) elev = q - tr.elevation;
        } catch (e) { elev = 0; }
        c.meters = self._car3dMeters(self._g3.getZoom()); // misura secondo lo zoom di questo fotogramma
        const mc = ml.MercatorCoordinate.fromLngLat([c.lon, c.lat], elev);
        const s = mc.meterInMercatorCoordinateUnits() * c.meters; // metri → unità mercatore (× ingrandimento)
        // ricetta classica: base mercatore→schermo × [posizione · scala(Y ribaltato) · 90°X (Y-su→Z-su) · direzione]
        const base = tr.mercatorMatrix ? new THREE.Matrix4().fromArray(Array.from(tr.mercatorMatrix)) : new THREE.Matrix4().fromArray(mtx);
        const l = new THREE.Matrix4()
          .makeTranslation(mc.x, mc.y, mc.z)
          .scale(new THREE.Vector3(s, -s, s))
          .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
          .multiply(new THREE.Matrix4().makeRotationY(c.dirRad));
        self._carCam.projectionMatrix = base.multiply(l);
        const r = self._carRenderer;
        r.resetState();
        // buffer di profondità pulito solo per il mezzo: le sue parti si occludono fra loro (niente trasparenze)
        // ma resta sopra la mappa senza il "clipping" che a certi zoom lo faceva sparire
        gl.depthMask(true); gl.clearDepth(1.0); gl.clear(gl.DEPTH_BUFFER_BIT);
        r.render(self._carScene, self._carCam);
        // mantiene il disegno vivo mentre si guida (e ancora un attimo dopo l'ultimo movimento); da fermi si spegne
        if (self._g3.isMoving?.() || Date.now() - (c.lastMove || 0) < 2500) self._g3.triggerRepaint();
      },
    };
    try {
      g.addLayer(layer);
      this._car3dReady = true;
      this._car3dMeshKey = null;
      this._drawVeh3d();
    } catch (e) { this._car3dInit = false; }
  }

  // ---------------------------------------------------------------- nomi dei paesi in 3D
  // Sopra ogni città, paese o frazione visibile il nome a grandi lettere bianche in rilievo, piantate nel paesaggio
  // e girate sempre verso di te. Il rilievo sono tante copie della scritta una dietro l'altra, sempre più scure
  // (niente caratteri 3D da scaricare). Grandezza fissa in metri secondo l'importanza del luogo.
  async _initPlaces3d() {
    if (this._pl3Ready || this._pl3Init) return;
    this._pl3Init = true;
    let THREE;
    try { THREE = await loadThree(); } catch (e) { this._pl3Init = false; return; }
    const g = this._g3;
    if (!g || !this._g3ok) { this._pl3Init = false; return; }
    this._pl3 = new Map(); // nome → { mesh, scene, lon, lat, h }
    const self = this;
    const layer = {
      id: "places3d", type: "custom", renderingMode: "2d",
      onAdd(map) {
        // le scritte si disegnano su una tela trasparente SOPRA la mappa e sopra i segnaposto (che sono elementi della
        // pagina e starebbero sempre davanti a qualsiasi cosa disegnata dentro la mappa 3D)
        const cv = document.createElement("canvas");
        cv.className = "pl3cv";
        map.getContainer().appendChild(cv);
        self._pl3Canvas = cv;
        self._pl3Cam = new THREE.Camera();
        self._pl3Renderer = new THREE.WebGLRenderer({ canvas: cv, alpha: true, antialias: true, premultipliedAlpha: true });
        self._pl3Renderer.setClearColor(0x000000, 0);
        self._pl3Renderer.autoClear = false;
      },
      onRemove() { self._pl3Canvas?.remove(); },
      render(gl, args) {
        const r = self._pl3Renderer;
        if (!r) return;
        const g3 = self._g3, tr = g3.transform, ml = window.maplibregl;
        { // la tela segue la grandezza della mappa
          const mcv = g3.getCanvas(), w = mcv.clientWidth, h = mcv.clientHeight, pr = Math.min(2, window.devicePixelRatio || 1);
          if (self._pl3Size !== `${w}x${h}x${pr}`) { self._pl3Size = `${w}x${h}x${pr}`; r.setPixelRatio(pr); r.setSize(w, h, false); }
        }
        r.clear();
        if (self._settings.names3d === false || !self._pl3.size) return;
        if (g3.getPitch() < 10) return; // proprio dall'alto le scritte in piedi non si leggono: restano le etichette della mappa
        const mtx = Array.isArray(args) ? args : (args?.defaultProjectionData?.mainMatrix || args?.modelViewProjectionMatrix);
        const baseArr = tr.mercatorMatrix ? Array.from(tr.mercatorMatrix) : mtx && Array.from(mtx);
        if (!baseArr) return;
        let cam;
        try { cam = ml.MercatorCoordinate.fromLngLat(tr.getCameraLngLat(), tr.getCameraAltitude()); } catch (e) { return; }
        const list = [];
        for (const p of self._pl3.values()) {
          const mc = ml.MercatorCoordinate.fromLngLat([p.lon, p.lat], 0);
          const u = mc.meterInMercatorCoordinateUnits();
          const dx = (mc.x - cam.x) / u, dy = (mc.y - cam.y) / u;
          const d = Math.hypot(dx, dy);
          // proprio sopra il paese non si mostra; troppo lontano neanche; ai bordi sfuma
          const far = p.far || 30000;
          const zf = (g3.getZoom() - (p.minz - 0.5)) / 0.5; // compare sfumando man mano che si avvicina lo zoom giusto
          const a = Math.max(0, Math.min(1, (d - 60) / 60, (far - d) / (far * 0.25), zf));
          if (a <= 0.02) continue;
          list.push({ p, d, a, dx, dy });
        }
        const cw = g3.getCanvas().clientWidth || 400, chh = g3.getCanvas().clientHeight || 600;
        // grandezza e quota scelte SULLO SCHERMO: lettere alte qualche decina di pixel (più grandi per i luoghi importanti)
        // e base della scritta poco sopra il paese (~90 px da vicino, ~50 da lontano), sopra i suoi segnaposto
        for (const it of list) {
          const { p, d, dx, dy } = it;
          let elev = 0;
          try {
            const q = g3.terrain ? g3.queryTerrainElevation([p.lon, p.lat]) : null;
            if (q != null && Number.isFinite(q) && Number.isFinite(tr.elevation)) elev = q - tr.elevation;
          } catch (e) { elev = 0; }
          const g0 = ml.MercatorCoordinate.fromLngLat([p.lon, p.lat], elev);
          const ndcY = (z) => {
            const m = baseArr, x = g0.x, y = g0.y;
            const cy = m[1] * x + m[5] * y + m[9] * z + m[13], cw2 = m[3] * x + m[7] * y + m[11] * z + m[15];
            return cw2 > 0 ? cy / cw2 : null;
          };
          const u0 = g0.meterInMercatorCoordinateUnits();
          const y0 = ndcY(g0.z), y1 = ndcY(g0.z + 100 * u0);
          const pxPerM = y0 != null && y1 != null ? ((y1 - y0) * chh) / 2 / 100 : 0; // pixel per metro in verticale
          if (!(pxPerM > 0)) continue;
          // la scritta si inclina all'indietro verso la telecamera: con la mappa dritta (inclinazione 90°) resta in
          // piedi, vista dall'alto (0°) si sdraia; così è sempre di fronte a chi guarda e non si schiaccia
          const tilt = ((90 - Math.min(85, g3.getPitch())) * Math.PI) / 180;
          // pixel per metro lungo la scritta inclinata: si proietta un tratto di 100 m nella sua direzione "su"
          const ndc = (x, y, z) => {
            const m = baseArr;
            const w = m[3] * x + m[7] * y + m[11] * z + m[15];
            return w > 0 ? [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w] : null;
          };
          const hx = d > 0 ? dx / d : 0, hy = d > 0 ? dy / d : 0; // orizzontale, dalla telecamera verso il paese
          const q0 = ndc(g0.x, g0.y, g0.z);
          const q1 = ndc(g0.x + hx * Math.sin(tilt) * 100 * u0, g0.y + hy * Math.sin(tilt) * 100 * u0, g0.z + Math.cos(tilt) * 100 * u0);
          const pxAlong = q0 && q1 ? Math.hypot((q1[0] - q0[0]) * cw, (q1[1] - q0[1]) * chh) / 2 / 100 : pxPerM;
          if (!(pxAlong > 0)) continue;
          const upPx = Math.max(30, Math.min(60, (60 * 1500) / Math.max(d, 1))); // poco sopra il paese
          const k = (p.px || 40) / pxAlong / p.h; // scala del modello (alto p.h metri) per avere p.px pixel sullo schermo
          const lift = upPx / pxPerM;
          const mc = ml.MercatorCoordinate.fromLngLat([p.lon, p.lat], elev + lift);
          const sc = mc.meterInMercatorCoordinateUnits() * k;
          const toCam = Math.atan2(-dx, dy); // verso la telecamera (dx verso est, dy verso sud nel Mercatore)
          const l = new THREE.Matrix4()
            .makeTranslation(mc.x, mc.y, mc.z)
            .scale(new THREE.Vector3(sc, -sc, sc))
            .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
            // girata un po' di sbieco (~17°): come nelle riprese, si vede lo spessore sul fianco delle lettere
            .multiply(new THREE.Matrix4().makeRotationY(Math.PI - toCam + 0.3))
            .multiply(new THREE.Matrix4().makeRotationX(-tilt));
          it.P = new THREE.Matrix4().fromArray(baseArr).multiply(l);
          // rettangolo sullo schermo, per non sovrapporre i nomi
          const e = it.P.elements;
          let x0 = Infinity, x1 = -Infinity, ya = Infinity, yb = -Infinity;
          for (const [lx, ly] of [[-p.wM / 2, 0], [p.wM / 2, 0], [-p.wM / 2, p.hM], [p.wM / 2, p.hM]]) {
            const w = e[3] * lx + e[7] * ly + e[15];
            if (w <= 0) { it.P = null; break; }
            const sx = ((e[0] * lx + e[4] * ly + e[12]) / w + 1) / 2 * cw, sy = (1 - (e[1] * lx + e[5] * ly + e[13]) / w) / 2 * chh;
            x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); ya = Math.min(ya, sy); yb = Math.max(yb, sy);
          }
          it.rect = [x0, ya, x1, yb];
        }
        // nomi che si sovrappongono: resta il più importante (capoluogo, poi luogo più grande, poi più vicino)
        const pick = list.filter((it) => it.P).sort((x, y) => (y.p.cap ? 1 : 0) - (x.p.cap ? 1 : 0) || y.p.h - x.p.h || x.d - y.d);
        const shown = [];
        for (const it of pick) {
          const [x0, ya, x1, yb] = it.rect;
          if (x1 < 0 || x0 > cw || yb < 0 || ya > chh) continue; // fuori dallo schermo
          if (shown.some(({ rect: [a0, b0, a1, b1] }) => x0 < a1 + 8 && x1 > a0 - 8 && ya < b1 + 4 && yb > b0 - 4)) continue;
          shown.push(it);
        }
        shown.sort((x, y) => y.d - x.d); // dal più lontano al più vicino
        for (const { p, a, P } of shown) {
          self._pl3Cam.projectionMatrix = P;
          for (const m of p.mats) m.opacity = a * m.userData.op;
          r.clearDepth();
          r.render(p.scene, self._pl3Cam);
        }
      },
    };
    try {
      g.addLayer(layer, g.getLayer("car3d") ? "car3d" : undefined); // sotto al mezzo
      this._pl3Ready = true;
      this._THREE = this._THREE || THREE;
      g.on("moveend", () => this._schedulePlaces3d());
      g.on("idle", () => this._schedulePlaces3d());
      this._schedulePlaces3d();
    } catch (e) { this._pl3Init = false; }
  }

  _schedulePlaces3d() {
    if (this._pl3T) return;
    this._pl3T = setTimeout(() => { this._pl3T = null; this._scanPlaces3d(); }, 400);
  }

  // i luoghi con nome nelle zone caricate della mappa: si tengono i più importanti e vicini (al massimo 14)
  _scanPlaces3d() {
    const g = this._g3, THREE = this._THREE;
    if (!g || !THREE || !this._pl3) return;
    let feats = [];
    try { feats = g.querySourceFeatures("ofm", { sourceLayer: "place" }); } catch (e) { return; }
    const SIZE = { city: 260, town: 170, village: 110, hamlet: 70, suburb: 80 };
    // da che zoom compaiono (sfumando nel mezzo zoom prima): capoluoghi sempre, città presto, frazioni solo da vicino
    const MINZ = { capital: 0, city: 7, town: 9, village: 11, suburb: 13, hamlet: 13.5 };
    const zoom = g.getZoom();
    const c = g.getCenter();
    const seen = new Map();
    for (const f of feats) {
      const cls = f.properties?.class;
      if (!SIZE[cls] || f.geometry?.type !== "Point") continue;
      const cap = f.properties.capital != null && +f.properties.capital <= 6; // capitale, capoluogo di regione o provincia
      const minz = cap ? MINZ.capital : MINZ[cls];
      if (zoom < minz - 0.5) continue;
      const name = f.properties["name:it"] || f.properties.name || f.properties["name:latin"];
      if (!name || seen.has(name)) continue;
      const [lon, lat] = f.geometry.coordinates;
      const d = distM([c.lat, c.lng], [lat, lon]);
      if (d > (cap ? 150000 : 45000)) continue; // i capoluoghi si vedono da molto lontano
      const h = cap ? 340 : SIZE[cls];
      const px = cap ? 64 : { city: 56, town: 48, village: 40, suburb: 34, hamlet: 32 }[cls];
      seen.set(name, { name, lon, lat, h, d, minz, cap, px, far: cap ? 150000 : 45000, w: (cap ? 4 : 1) * h / Math.max(d, 500) });
    }
    const keep = [...seen.values()].sort((a, b) => b.w - a.w).slice(0, 20);
    const want = new Set(keep.map((k) => k.name));
    for (const [n, p] of this._pl3) if (!want.has(n)) { p.dispose(); this._pl3.delete(n); }
    for (const k of keep) if (!this._pl3.has(k.name)) this._pl3.set(k.name, this._buildPlace3d(k));
    g.triggerRepaint();
  }

  _buildPlace3d(k) {
    const THREE = this._THREE;
    // scritta su tela: maiuscolo, carattere bastoni molto pesante e largo, faccia color metallo (chiara in alto, più
    // scura in basso) con bordo smussato scuro e riflesso in alto; i nomi lunghi vanno su due righe
    const px = 150, pad = 26, lh = px * 0.98;
    const txt = k.name.toLocaleUpperCase("it-IT");
    let lines = [txt];
    if (txt.length > 11 && txt.includes(" ")) { // a capo allo spazio più vicino al centro
      const mid = txt.length / 2;
      let best = -1;
      for (let i = 0; i < txt.length; i++) if (txt[i] === " " && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
      lines = [txt.slice(0, best), txt.slice(best + 1)];
    }
    const c = document.createElement("canvas");
    const x = c.getContext("2d");
    const font = `700 ${px}px "Helvetica Neue", Helvetica, Arial, sans-serif`; // bastoni in grassetto, non troppo pesante
    x.font = font;
    try { x.letterSpacing = `${Math.round(px * 0.03)}px`; } catch (e) { /* non supportato */ }
    const tw = Math.ceil(Math.max(...lines.map((l) => x.measureText(l).width))) + pad * 2;
    c.width = Math.min(4096, tw); c.height = Math.round(lh * lines.length + pad * 2);
    x.font = font; try { x.letterSpacing = `${Math.round(px * 0.03)}px`; } catch (e) { /* non supportato */ }
    x.textAlign = "center"; x.textBaseline = "middle"; x.lineJoin = "round";
    const maxW = c.width - pad * 2;
    lines.forEach((l, i) => {
      const y = pad + lh * (i + 0.5) + px * 0.04, cx = c.width / 2;
      const top = y - px * 0.42, bot = y + px * 0.42;
      // grigio cemento/metallo opaco: chiaro in alto, più scuro in basso
      x.lineWidth = px * 0.035; x.strokeStyle = "#5a6066"; // contorno sottile
      x.strokeText(l, cx, y, maxW);
      const gr = x.createLinearGradient(0, top, 0, bot);
      gr.addColorStop(0, "#e3e6e9"); gr.addColorStop(0.55, "#c5cacf"); gr.addColorStop(1, "#959ca3");
      x.fillStyle = gr; x.fillText(l, cx, y, maxW);
      // smussatura: ombra morbida lungo i bordi in basso e luce lungo quelli in alto, solo dentro le lettere
      x.save();
      x.globalCompositeOperation = "source-atop";
      x.filter = `blur(${Math.round(px * 0.025)}px)`;
      x.lineWidth = px * 0.07;
      x.strokeStyle = "rgba(35,40,46,.55)"; x.strokeText(l, cx, y + px * 0.035, maxW);
      x.strokeStyle = "rgba(255,255,255,.45)"; x.strokeText(l, cx, y - px * 0.04, maxW);
      x.restore();
    });
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4; tex.needsUpdate = true;
    const hM = k.h * lines.length * 0.9, wM = hM * (c.width / c.height);
    const geo = new THREE.PlaneGeometry(wM, hM);
    const scene = new THREE.Scene();
    const mats = [];
    const N = 14, depth = hM * 0.3; // spessore delle lettere
    for (let i = N; i >= 0; i--) { // dal fondo (scuro) al davanti (bianco)
      const t = i / N;
      const col = i === 0 ? 0xffffff : new THREE.Color().setScalar(0.55 - 0.3 * t).getHex(); // fianchi in ombra
      const m = new THREE.MeshBasicMaterial({ map: tex, color: col, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide, depthWrite: true });
      m.userData.op = i === 0 ? 0.88 : 1; // davanti un filo trasparente: si intravede il paesaggio, come nelle riprese
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(0, hM / 2, -depth * t);
      scene.add(mesh);
      mats.push(m);
    }
    return { ...k, wM, hM, scene, mats, dispose() { geo.dispose(); tex.dispose(); mats.forEach((m) => m.dispose()); } };
  }

  // texture della targa (placca bianca + banda UE blu + numero) disegnata su tela
  _plateTexture(text) {
    const THREE = this._THREE;
    const W = 512, H = Math.round(W * 0.2);
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const x = c.getContext("2d");
    const r = Math.round(H * 0.12), euW = Math.round(H * 0.5), bd = Math.round(H * 0.05);
    const rr = (xx, yy, ww, hh, rad) => { x.beginPath(); x.moveTo(xx + rad, yy); x.arcTo(xx + ww, yy, xx + ww, yy + hh, rad); x.arcTo(xx + ww, yy + hh, xx, yy + hh, rad); x.arcTo(xx, yy + hh, xx, yy, rad); x.arcTo(xx, yy, xx + ww, yy, rad); x.closePath(); };
    x.fillStyle = "#2b2b2b"; rr(0, 0, W, H, r + bd); x.fill();
    x.fillStyle = "#fbfbf8"; rr(bd, bd, W - 2 * bd, H - 2 * bd, r); x.fill();
    x.save(); rr(bd, bd, euW, H - 2 * bd, r); x.clip(); x.fillStyle = "#1f3fa8"; x.fillRect(bd, bd, euW, H); x.restore();
    x.fillStyle = "#fff"; x.font = `bold ${Math.round(H * 0.3)}px Arial`; x.textAlign = "center"; x.textBaseline = "alphabetic";
    x.fillText("I", bd + euW / 2, H - Math.round(H * 0.22));
    x.fillStyle = "#111"; x.font = `bold ${Math.round(H * 0.62)}px "Arial Narrow", Arial, sans-serif`; x.textAlign = "center"; x.textBaseline = "middle";
    x.fillText(text, euW + (W - euW) / 2, H / 2 + Math.round(H * 0.03));
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 8; tex.needsUpdate = true;
    return tex;
  }

  // fuoristrada/SUV a tre porte sul modello della Daihatsu Feroza: due colori (sopra il colore del mezzo, sotto grigio
  // argento), cofano corto e abitacolo alto squadrato, parafanghi neri sporgenti, paraurti e bull bar neri, fari quadrati,
  // ruota di scorta sul portellone, fanali verticali agli angoli, gomme grosse. Misure in metri; avanti = +Z
  _buildFeroza(color, plate) {
    const THREE = this._THREE;
    const night = this._nightOn;
    const grp = new THREE.Group();
    const L = 3.75, W = 1.62, H = 1.74, zf = L / 2, zr = -L / 2;
    const lam = (c) => new THREE.MeshLambertMaterial({ color: new THREE.Color(c), side: THREE.DoubleSide });
    const upper = lam(color || "#1b1f27"), silver = lam("#b4b9c0"), black = lam("#17191c");
    const glassM = lam(night ? "#162235" : "#2d405a"), lightM = lam(night ? "#fff1b0" : "#eef0e2");
    const amber = lam("#f29b1d"), red = lam("#c4161c"), rim = lam("#5b3a28"), grey = lam("#8a9099");
    const box = (w, h, l, m, x, y, z) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), m); b.position.set(x, y, z); grp.add(b); return b; };
    const cyl = (r, len, m, x, y, z, axis) => {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 20), m);
      if (axis === "x") c.rotation.z = Math.PI / 2; else if (axis === "z") c.rotation.x = Math.PI / 2;
      c.position.set(x, y, z); grp.add(c); return c;
    };
    // fascia bassa argento
    box(W, 0.48, L - 0.04, silver, 0, 0.68, 0);
    // scocca superiore: profilo laterale (cofano corto, parabrezza inclinato, tetto piatto) estruso sulla larghezza
    const Wu = W * 0.97;
    const sh = new THREE.Shape();
    sh.moveTo(zf - 0.04, 0.9); sh.lineTo(zf - 0.04, 1.03); sh.lineTo(zf - 1.1, 1.07); sh.lineTo(zf - 1.42, H - 0.03);
    sh.lineTo(zr + 0.06, H); sh.lineTo(zr + 0.02, H - 0.06); sh.lineTo(zr + 0.02, 0.9); sh.lineTo(zf - 0.04, 0.9);
    const eg = new THREE.ExtrudeGeometry(sh, { depth: Wu, bevelEnabled: false });
    eg.rotateY(-Math.PI / 2); eg.translate(Wu / 2, 0, 0);
    grp.add(new THREE.Mesh(eg, upper));
    // vetri: fascia laterale, montante centrale, parabrezza inclinato e lunotto
    const zA = zf - 1.47, zB = zr + 0.15;
    box(Wu + 0.014, 0.46, zA - zB, glassM, 0, 1.39, (zA + zB) / 2);
    box(Wu + 0.03, 0.5, 0.1, upper, 0, 1.39, zf - 2.15);
    const z1 = zf - 1.1, y1 = 1.07, z2 = zf - 1.42, y2 = H - 0.03, len = Math.hypot(z2 - z1, y2 - y1), a = Math.atan2(z2 - z1, y2 - y1);
    const ws = new THREE.Mesh(new THREE.PlaneGeometry(Wu * 0.86, len * 0.84), glassM);
    ws.rotation.x = a;
    ws.position.set(0, (y1 + y2) / 2 - Math.sin(a) * 0.012, (z1 + z2) / 2 + Math.cos(a) * 0.012);
    grp.add(ws);
    const rw = new THREE.Mesh(new THREE.PlaneGeometry(Wu * 0.8, 0.44), glassM);
    rw.rotation.y = Math.PI; rw.position.set(0, 1.4, zr + 0.008); grp.add(rw);
    // parafanghi neri sporgenti sulle ruote
    const zW = [zf - 0.71, zr + 0.76];
    for (const zw of zW) box(W + 0.1, 0.32, 0.98, black, 0, 0.73, zw);
    // ruote: gomme tassellate nere, cerchi color ruggine
    for (const zw of zW) for (const sx of [-1, 1]) {
      cyl(0.37, 0.27, black, sx * (W / 2 - 0.09), 0.37, zw, "x");
      cyl(0.21, 0.285, rim, sx * (W / 2 - 0.09), 0.37, zw, "x");
      cyl(0.06, 0.3, grey, sx * (W / 2 - 0.09), 0.37, zw, "x");
    }
    // davanti: paraurti, griglia, fari quadrati, frecce, bull bar
    box(W + 0.06, 0.2, 0.18, black, 0, 0.5, zf + 0.02);
    box(0.62, 0.2, 0.03, black, 0, 0.8, zf + 0.0);
    for (const sx of [-1, 1]) {
      box(0.25, 0.2, 0.03, lightM, sx * 0.5, 0.8, zf + 0.0);
      box(0.16, 0.07, 0.03, amber, sx * 0.53, 0.64, zf + 0.0);
      cyl(0.035, 0.6, black, sx * 0.42, 0.74, zf + 0.2);
    }
    cyl(0.035, 0.9, black, 0, 1.04, zf + 0.2, "x");
    cyl(0.03, 0.84, black, 0, 0.74, zf + 0.2, "x");
    // dietro: paraurti, fanali verticali agli angoli, ruota di scorta sul portellone
    box(W + 0.06, 0.2, 0.18, black, 0, 0.5, zr - 0.02);
    for (const sx of [-1, 1]) {
      box(0.13, 0.13, 0.03, amber, sx * (W / 2 - 0.09), 1.0, zr - 0.005);
      box(0.13, 0.2, 0.03, red, sx * (W / 2 - 0.09), 0.82, zr - 0.005);
    }
    cyl(0.35, 0.22, black, 0, 1.08, zr - 0.13, "z");
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.31, 0.022, 8, 32), grey);
    ring.position.set(0, 1.08, zr - 0.245); grp.add(ring);
    // targa sul paraurti posteriore, spostata di lato come sull'originale (più grande del vero per leggerla)
    if (plate) {
      const tex = this._plateTexture(plate);
      const pw = 0.95, ph = pw * 0.22;
      const pm = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false });
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), pm);
      pl.position.set(0.24, 0.6, zr - 0.116);
      pl.rotation.y = Math.PI; grp.add(pl);
      grp.userData.plateTex = tex;
    }
    return grp;
  }

  // utilitaria tonda (tipo city car cabrio): carrozzeria del colore del veicolo, capote del colore del tetto,
  // fari tondi, baffo cromato, fanali verticali dietro. Forme estruse con gli spigoli arrotondati (bevel).
  _buildCitycar(color, roofColor, plate, sunroof = true) {
    const THREE = this._THREE;
    const night = this._nightOn;
    const grp = new THREE.Group();
    const L = 3.57, W = 1.63, zf = L / 2, zr = -L / 2;
    const lam = (c) => new THREE.MeshLambertMaterial({ color: new THREE.Color(c), side: THREE.DoubleSide });
    const body = lam(color || "#f2efe6"), roof = lam(roofColor || color || "#b3263a");
    const black = lam("#17191c"), chrome = lam("#c9ced4"), glassM = lam(night ? "#162235" : "#2b3d55");
    const lightM = lam(night ? "#fff1b0" : "#f1f3ee"), red = lam("#c4161c"), tyre = lam("#141414"), rimM = lam("#b9bec5");
    // profilo laterale (z avanti, y alto) estruso sulla larghezza, centrato, con bordi arrotondati
    const extrude = (shape, width, m, bevel = 0.07) => {
      const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.01, width - 2 * bevel), bevelEnabled: true, bevelSize: bevel,
        bevelThickness: bevel, bevelSegments: 4, curveSegments: 14 });
      g.rotateY(-Math.PI / 2); g.translate((width - 2 * bevel) / 2, 0, 0);
      const mesh = new THREE.Mesh(g, m); grp.add(mesh); return mesh;
    };
    const box = (w, h, l, m, x, y, z) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), m); b.position.set(x, y, z); grp.add(b); return b; };
    const cyl = (r, len, m, x, y, z, axis) => {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 22), m);
      if (axis === "x") c.rotation.z = Math.PI / 2; else if (axis === "z") c.rotation.x = Math.PI / 2;
      c.position.set(x, y, z); grp.add(c); return c;
    };
    // carrozzeria bassa: muso tondo e corto, cofano bombato, coda arrotondata (fino alla linea di cintura)
    const lo = new THREE.Shape();
    lo.moveTo(zf - 0.12, 0.3);
    lo.quadraticCurveTo(zf + 0.02, 0.32, zf, 0.62);
    lo.quadraticCurveTo(zf - 0.08, 0.93, zf - 0.85, 0.99);
    lo.lineTo(zr + 0.35, 0.99);
    lo.quadraticCurveTo(zr - 0.02, 0.96, zr, 0.66);
    lo.quadraticCurveTo(zr + 0.02, 0.32, zr + 0.14, 0.3);
    lo.lineTo(zf - 0.12, 0.3);
    extrude(lo, W, body, 0.09);
    // abitacolo vetrato (cupola tonda) un po' più stretto
    const Wg = W * 0.86;
    const gh = new THREE.Shape();
    gh.moveTo(zf - 0.85, 0.99);
    gh.quadraticCurveTo(zf - 1.2, 1.3, zf - 1.42, 1.4);
    gh.quadraticCurveTo(-0.3, 1.44, zr + 0.48, 1.38);
    gh.quadraticCurveTo(zr + 0.2, 1.26, zr + 0.24, 0.99);
    gh.lineTo(zf - 0.85, 0.99);
    extrude(gh, Wg, glassM, 0.06);
    // capote (tetto in tela) dal sopra del parabrezza fino alla coda, col lunotto piccolo
    const rf = new THREE.Shape();
    rf.moveTo(zf - 1.45, 1.47);
    rf.quadraticCurveTo(-0.3, 1.62, zr + 0.44, 1.5);
    rf.quadraticCurveTo(zr + 0.12, 1.32, zr + 0.17, 1.0);
    rf.lineTo(zr + 0.34, 1.0);
    rf.quadraticCurveTo(zr + 0.3, 1.25, zr + 0.52, 1.36);
    rf.quadraticCurveTo(-0.3, 1.43, zf - 1.42, 1.37);
    rf.lineTo(zf - 1.45, 1.47);
    extrude(rf, Wg + 0.08, roof, 0.035);
    // tettuccio in vetro scuro: grande pannello sulla parte davanti del tetto, che segue la curva
    if (sunroof) {
      const q = (t) => { // punto della curva esterna del tetto (z, y)
        const a = [zf - 1.45, 1.47], c = [-0.3, 1.62], b = [zr + 0.44, 1.5], u = 1 - t;
        return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]];
      };
      const sr = new THREE.Shape();
      const n = 10, t0 = 0.03, t1 = 0.6;
      for (let i = 0; i <= n; i++) { const [z, y] = q(t0 + (t1 - t0) * i / n); if (i === 0) sr.moveTo(z, y + 0.045); else sr.lineTo(z, y + 0.045); }
      for (let i = n; i >= 0; i--) { const [z, y] = q(t0 + (t1 - t0) * i / n); sr.lineTo(z, y + 0.005); }
      const sg = new THREE.ExtrudeGeometry(sr, { depth: Wg * 0.9, bevelEnabled: false });
      sg.rotateY(-Math.PI / 2); sg.translate(Wg * 0.45, 0, 0);
      // vetro azzurrato e un po' lucido (scuro e opaco sembrava un pannello solare)
      grp.add(new THREE.Mesh(sg, new THREE.MeshPhongMaterial({ color: new THREE.Color(night ? "#27507a" : "#4f8ec4"),
        specular: new THREE.Color("#ffffff"), shininess: 90, side: THREE.DoubleSide })));
    }
    // lunotto piccolo nella capote
    const rw = new THREE.Mesh(new THREE.PlaneGeometry(Wg * 0.55, 0.2), glassM);
    rw.rotation.y = Math.PI; rw.rotation.x = -0.35; rw.position.set(0, 1.24, zr + 0.2); grp.add(rw);
    // montanti del parabrezza e centrali nel colore della carrozzeria
    for (const sx of [-1, 1]) {
      const p = box(0.06, 0.52, 0.07, body, sx * (Wg / 2 + 0.005), 1.21, zf - 1.12); p.rotation.x = -0.62;
      box(0.05, 0.42, 0.12, body, sx * (Wg / 2 + 0.01), 1.2, -0.12);
      box(0.1, 0.08, 0.16, body, sx * (W / 2 + 0.04), 1.04, zf - 0.95); // specchietti
    }
    // ruote con cerchi chiari
    const zW = [zf - 0.7, zr + 0.62];
    for (const zw of zW) for (const sx of [-1, 1]) {
      cyl(0.3, 0.2, tyre, sx * (W / 2 - 0.08), 0.3, zw, "x");
      cyl(0.2, 0.215, rimM, sx * (W / 2 - 0.08), 0.3, zw, "x");
      cyl(0.06, 0.225, black, sx * (W / 2 - 0.08), 0.3, zw, "x");
    }
    // davanti: fari tondi grandi, luci tonde sotto, baffo cromato, griglia scura nel paraurti
    for (const sx of [-1, 1]) {
      // (gli spigoli arrotondati fanno sporgere muso e coda di ~9 cm: i dettagli stanno sulla superficie vera)
      cyl(0.135, 0.06, chrome, sx * 0.52, 0.8, zf - 0.01, "z");
      cyl(0.11, 0.075, lightM, sx * 0.52, 0.8, zf - 0.0, "z");
      cyl(0.075, 0.05, lightM, sx * 0.58, 0.57, zf + 0.08, "z");
    }
    box(0.7, 0.025, 0.04, chrome, 0, 0.72, zf + 0.06);
    box(0.95, 0.15, 0.05, black, 0, 0.42, zf + 0.08);
    // dietro: fanali verticali tondeggianti, fascia cromata, paraurti
    for (const sx of [-1, 1]) {
      box(0.17, 0.28, 0.05, red, sx * (W / 2 - 0.16), 0.84, zr - 0.06);
      box(0.09, 0.14, 0.055, lightM, sx * (W / 2 - 0.16), 0.84, zr - 0.07);
    }
    box(0.62, 0.03, 0.04, chrome, 0, 0.76, zr - 0.085);
    box(W - 0.2, 0.05, 0.04, chrome, 0, 0.42, zr - 0.07);
    if (plate) {
      const tex = this._plateTexture(plate);
      const pw = 0.9, ph = pw * 0.22;
      const pm = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false });
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), pm);
      pl.position.set(0, 0.6, zr - 0.115);
      pl.rotation.y = Math.PI; grp.add(pl);
      grp.userData.plateTex = tex;
    }
    return grp;
  }

  // costruisce il mezzo come un unico gruppo di forme solide, con la targa sul retro
  _buildCar3dMesh(kind, color) {
    if (kind === "suv" || kind === "jeep") {
      const v0 = this._curVehicle();
      return this._buildFeroza(color, v0?.type && v0?.plate ? v0.plate : "");
    }
    if (kind === "utilitaria") {
      const v0 = this._curVehicle();
      // tetto nel colore della carrozzeria e tettuccio in vetro (salvo "Tetto pieno")
      return this._buildCitycar(color, "", v0?.type && v0?.plate ? v0.plate : "", v0?.sunroof !== "no");
    }
    const THREE = this._THREE;
    const night = this._nightOn;
    const grp = new THREE.Group();
    const dim = { suv: [4.7, 2.0, 1.78], jeep: [4.4, 1.95, 1.9], camper: [6.0, 2.25, 2.75], furgone: [5.2, 2.05, 2.4],
      auto: [4.4, 1.82, 1.5], car: [4.4, 1.82, 1.5] }[kind] || [4.5, 1.85, 1.6];
    const [L, W, H] = dim;
    // depth attivo per l'occlusione tra le parti del mezzo (niente trasparenze); il buffer si azzera prima di disegnarlo
    const lam = (c, o = {}) => new THREE.MeshLambertMaterial({ color: new THREE.Color(c), side: THREE.DoubleSide, ...o });
    const body = lam(color || "#173a7a");
    const addBox = (w, h, l, m, y, z = 0) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), m); b.position.set(0, y, z); grp.add(b); return b; };
    const wheelR = Math.min(0.38, H * 0.25), floor = wheelR * 0.95;
    // corpo basso e abitacolo (asse Z = avanti, Y = alto, X = larghezza)
    addBox(W, H * 0.46, L * 0.98, body, floor + H * 0.23);
    const cabH = H * 0.44, cabL = L * 0.52;
    addBox(W * 0.9, cabH, cabL, body, floor + H * 0.46 + cabH / 2, -L * 0.03);
    // vetri
    const glass = lam(night ? "#0f1d33" : "#20314d");
    addBox(W * 0.92, cabH * 0.6, cabL * 0.99, glass, floor + H * 0.46 + cabH * 0.62, -L * 0.03);
    // ruote
    const wgeo = new THREE.CylinderGeometry(wheelR, wheelR, W * 0.12, 18); const wmat = lam("#141414");
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const wm = new THREE.Mesh(wgeo, wmat); wm.rotation.z = Math.PI / 2;
      wm.position.set(sx * (W / 2 - W * 0.05), wheelR, sz * L * 0.31); grp.add(wm);
    }
    // fari: bianchi davanti, rossi dietro
    for (const sx of [-1, 1]) {
      addBox(W * 0.16, H * 0.1, 0.08, lam(night ? "#fff6c8" : "#eef2f5"), floor + H * 0.28, L * 0.485 + sx * 0 + 0);
      addBox(W * 0.16, H * 0.1, 0.06, lam("#c21a1a"), floor + H * 0.3, -L * 0.49);
    }
    // targa: faccia verticale texturata sul retro (un pezzo solo col mezzo)
    const v = this._curVehicle();
    const plate = v?.type && v?.plate ? v.plate : "";
    if (plate && !["moto", "scooter", "bici", "piedi"].includes(kind)) {
      const tex = this._plateTexture(plate);
      const pw = W * 0.9, ph = pw * 0.22; // targa larga quasi quanto l'auto
      const pm = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false });
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), pm);
      pl.position.set(0, floor + H * 0.26, -L * 0.5 - 0.02);
      pl.rotation.y = Math.PI; grp.add(pl);
      grp.userData.plateTex = tex;
    }
    return grp;
  }

  // aggiorna posizione/direzione del modello 3D e lo ricostruisce quando cambia tipo/colore/targa
  _updateCar3d() {
    const c = this._car3d;
    const f = this._veh3dPos();
    if (!c || !this._carScene) return;
    if (!f || this._settings.veh3d === false) { if (c.visible) { c.visible = false; this._g3?.triggerRepaint?.(); } return; }
    const v = this._curVehicle();
    const [kind, color] = veh3dFor(v, this._mode);
    const plate = v?.type && v?.plate ? v.plate : "";
    const key = `${kind}|${color}|${v?.roof || ""}|${v?.sunroof || ""}|${this._nightOn ? 1 : 0}|${plate}`;
    if (this._car3dMeshKey !== key) {
      this._car3dMeshKey = key;
      if (c.mesh) { this._carScene.remove(c.mesh); this._disposeMesh(c.mesh); }
      c.mesh = this._buildCar3dMesh(kind, color);
      this._carScene.add(c.mesh);
    }
    c.lon = f.lon; c.lat = f.lat;
    c.dirRad = Math.PI - ((f.dir || 0) * Math.PI) / 180; // verso di marcia (modello girato di 180°: si vede il retro con la targa)
    // dimensione ~costante sullo schermo: a zoom più basso (guida) il modello si ingrandisce, altrimenti sparirebbe
    const z = this._g3.getZoom();
    // da vicino (zoom ≥ 18,5) dimensione costante sullo schermo; allontanandosi rimpicciolisce anche sullo schermo,
    // ma più piano della mappa (si vede sempre) e con un tetto: prima restava grande uguale e diventava un gigante
    c.meters = this._car3dMeters(z);
    c.visible = true;
    c.lastMove = Date.now();
    this._g3?.triggerRepaint?.();
  }

  _car3dMeters(z) {
    return z >= 18.5 ? Math.max(1, 4 * Math.pow(2, 18.5 - z)) : Math.min(9, 4 * Math.pow(2, (18.5 - z) * 0.45));
  }

  _disposeMesh(obj) {
    obj?.traverse?.((o) => {
      if (o.geometry) o.geometry.dispose?.();
      if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.map?.dispose?.(); m.dispose?.(); }); }
    });
  }

  // ingrandimento del modellino: più si è lontani più è grande, così sullo schermo resta di misura simile;
  // due ruote e pedone sono piccoli davvero: un po' più ingranditi
  _veh3dScale(kind) {
    const z = this._g3.getZoom();
    // misura ~costante sullo schermo; da lontano (mappa piccola) un po' più piccola, così non sembra troppo grande
    const shrink = Math.max(0.6, Math.min(1, (z - 12) / 3));
    return Math.max(1.2, Math.min(50, 6.5 * 2 ** (17 - z))) * shrink * (["moto", "scooter", "bici", "piedi"].includes(kind) ? 1.7 : 1);
  }

  // nuvole e targa: al massimo una volta per fotogramma (più eventi "render"/"move" nello stesso frame non le ridisegnano più volte)
  _scheduleCloudDraw() {
    if (this._cloudRaf) return;
    this._cloudRaf = requestAnimationFrame(() => { this._cloudRaf = 0; this._drawClouds(); });
  }

  _schedulePlate3d() {
    if (this._plateRaf) return;
    this._plateRaf = requestAnimationFrame(() => { this._plateRaf = 0; this._placePlate3d(); });
  }

  // durante un gesto con le dita in 3D: nasconde edifici e punti di interesse (pesanti da ridisegnare a ogni fotogramma);
  // li rimette appena si molla, così la rotazione/lo spostamento resta fluido
  _g3Heavy(on) {
    if (this._g3heavyOn === on) return; // già in questo stato: non ritoccare lo stile (ripeterlo durante un gesto lo blocca)
    this._g3heavyOn = on;
    const g = this._g3;
    if (g && this._g3ok) {
      for (const id of ["bld", "bld-roof", "poi-bld"]) {
        if (g.getLayer(id)) { try { g.setLayoutProperty(id, "visibility", on ? "visible" : "none"); } catch (e) { /* vista ricreata */ } }
      }
    }
    this.$("map3d")?.classList.toggle("g3busy", !on);
  }

  // etichetta della targa sul retro del mezzo 3D, ricalcolata a ogni movimento con lo zoom e l'inclinazione del momento;
  // nascosta quando il retro non guarda verso la telecamera
  _placePlate3d() {
    const g = this._g3;
    const at = this._plate3dAt;
    const f = this._veh3dPos();
    const show = !!(g && at && f && this._3d && this._settings.veh3d !== false);
    if (!show) { this._plate3d?.remove(); this._plate3d = null; return; }
    if (!this._plate3d) {
      const el = document.createElement("div");
      el.className = "plate3d";
      // viewport: la targa resta sempre dritta verso lo schermo e NON ruota/inclina con la mappa
      this._plate3d = new window.maplibregl.Marker({ element: el, anchor: "center", rotationAlignment: "viewport", pitchAlignment: "viewport" }).setLngLat([f.lon, f.lat]).addTo(g);
    }
    const el = this._plate3d.getElement();
    if (el.dataset.t !== at.text) { el.dataset.t = at.text; el.innerHTML = `<span class="eu">I</span><b>${esc(at.text)}</b><span class="eu"></span>`; }
    // sul retro verticale del mezzo: posizione geografica del retro, misura dalla larghezza del retro proiettata (prospettiva),
    // alzata sulla targa secondo l'inclinazione; tenuta vicino al mezzo anche in primissimo piano
    const S = this._veh3dScale(at.kind);
    const th = (f.dir * Math.PI) / 180;
    const lat = f.lat + (at.rear * Math.cos(th) * S) / 111320;
    const lon = f.lon + (at.rear * Math.sin(th) * S) / (111320 * Math.cos((f.lat * Math.PI) / 180));
    const mpp = (40075016.686 * Math.cos((f.lat * Math.PI) / 180)) / (512 * 2 ** g.getZoom());
    // dimensione e alzata in base alla SCALA del mezzo (dipende SOLO dallo zoom, non dalla rotazione):
    // così la targa non cambia e non "balla" quando ruoti la mappa a mezzo fermo. Larghezza automatica:
    // mostra sempre tutto il numero, grande quanto il retro.
    // scala LOCALE in pixel vicino al mezzo (corretta in prospettiva): quanto misura in pixel 1 unità del modellino
    // proprio lì dove sta l'auto. Così dimensione e alzata crescono bene anche da molto vicino, e la targa sale sul retro.
    const mLon = 1 / (111320 * Math.cos((f.lat * Math.PI) / 180));
    const pos = g.project([lon, lat]);
    const sideP = g.project([lon + Math.cos(th) * S * mLon, lat - (Math.sin(th) * S) / 111320]);
    const pxPerUnit = Math.hypot(sideP.x - pos.x, sideP.y - pos.y) || (S / mpp);
    const targetW = Math.max(30, Math.min(160, at.w * pxPerUnit));
    const ems = 1.9 + (at.text ? at.text.length : 7) * 0.52; // 2 bandiere UE + cifre (font stretto)
    el.style.width = "";
    el.style.fontSize = `${Math.max(6, Math.min(22, targetW / ems)).toFixed(2)}px`;
    const away = Math.abs(((((f.dir - g.getBearing()) % 360) + 540) % 360) - 180) > 100;
    const offscreen = pos.x < -60 || pos.y < -60 || pos.x > g.getCanvas().clientWidth + 60 || pos.y > g.getCanvas().clientHeight + 60;
    el.style.visibility = away || offscreen ? "hidden" : "";
    const pitch = (g.getPitch() * Math.PI) / 180;
    this._plate3d.setLngLat([lon, lat]).setRotation(0).setOffset([0, -at.z * pxPerUnit * Math.sin(pitch)]);
  }

  // la telecamera non deve finire sotto il terreno: inclinata sta dietro e più in basso del punto guardato, e le colline
  // vicine (accentuate dal rilievo) la coprono, con la mappa "stirata" e il nero sotto. Si prova la posizione e, se serve,
  // ci si allontana (zoom indietro a piccoli passi) finché la telecamera resta almeno 15 m sopra il terreno che ha davanti.
  // Margine piccolo apposta: con uno più largo la vista restava troppo alta e lo zoom con le dita veniva annullato.
  _clearCamera(opts, min = 35) {
    const g = this._g3;
    const ml = window.maplibregl;
    // la prova si fa su una copia della telecamera: spostare la vista vera interromperebbe l'animazione in corso
    // (zoom e inclinazione restavano a metà strada, e Ricentra sembrava non avvicinare)
    if (!g || !ml || !g.getTerrain() || typeof g.transform?.clone !== "function") return opts;
    // Prima si abbassa l'inclinazione (5° alla volta, fino a 20°): la telecamera sale e si avvicina, la distanza scelta resta.
    // Allontanarsi (zoom indietro) in una valle stretta la portava sopra le montagne dietro, sempre più lontano.
    const baseBearing = opts.bearing != null ? opts.bearing : g.getBearing();
    let z = opts.zoom;
    let pitch = opts.pitch ?? g.getPitch();
    let bearing = baseBearing;
    try {
      const center = ml.LngLat.convert(opts.center);
      let elev = null;
      try { elev = g.queryTerrainElevation(center); } catch (e) { /* quota del centro non pronta */ }
      const clr = (p, zz, br) => {
        const tr = g.transform.clone();
        if (opts.padding) tr.setPadding(opts.padding);
        tr.setBearing(br);
        tr.setPitch(p);
        tr.setZoom(zz);
        tr.setCenter(center);
        if (elev != null && Number.isFinite(elev)) tr.setElevation(elev);
        return this._camClearance(tr, min);
      };
      // cerca l'angolo più piccolo (fra i due lati, quello con più margine) che libera la vista a una data inclinazione
      const tryRotate = (p) => {
        for (const off of [25, 45, 65, 90]) {
          let best = null;
          for (const s of [1, -1]) {
            const c = clr(p, z, baseBearing + s * off);
            if (c != null && c >= 0 && (best == null || c > best.cl)) best = { br: baseBearing + s * off, cl: c };
          }
          if (best) return best;
        }
        return null;
      };
      // 1) dritto (verso di marcia) se è libero con margine. Se prima avevamo girato, per tornare dritti serve un
      //    margine più ampio: così non si va avanti e indietro a ogni posizione GPS.
      const keep = !!opts.keepSide; // solo la camera che segue in guida ricorda il lato scelto
      const prevOff = keep ? (this._camRotOff || 0) : 0;
      let cl = clr(pitch, z, baseBearing);
      const needBack = prevOff ? 45 : 0;
      if (cl != null && cl >= needBack) {
        if (keep) this._camRotOff = 0;
      } else if (prevOff && (() => { const c = clr(pitch, z, baseBearing + prevOff); if (c != null && c >= 0) { cl = c; return true; } return false; })()) {
        // 2) già girati e da quel lato è ancora libero: si resta lì
        bearing = baseBearing + prevOff;
      } else if (cl != null && cl < 0) {
        // 3) la camera entrerebbe nella montagna: si GIRA SUBITO dal lato libero (la valle), senza prima appiattire
        //    la vista; fra i due lati quello con più margine. Al tornante successivo si rivaluta e si gira dall'altra parte.
        const r = tryRotate(pitch);
        if (r) { bearing = r.br; cl = r.cl; if (keep) this._camRotOff = r.br - baseBearing; }
        // 4) se nessun lato basta (gola stretta): si abbassa l'inclinazione (fino a 20°) riprovando a girare
        while (cl != null && cl < 0 && pitch > 20) {
          pitch = Math.max(20, pitch - 5);
          cl = clr(pitch, z, bearing);
          if (cl != null && cl < 0) { const r2 = tryRotate(pitch); if (r2) { bearing = r2.br; cl = r2.cl; if (keep) this._camRotOff = r2.br - baseBearing; } }
        }
      }
      // 4) gole strettissime: ultima risorsa, ci si allontana
      for (let k = 0; k < 16 && cl != null && cl < 0; k++) { z -= 0.25; cl = clr(pitch, z, bearing); }
    } catch (e) {
      z = opts.zoom; // controllo non riuscito: si va dove richiesto
      pitch = opts.pitch ?? g.getPitch();
      bearing = baseBearing;
    }
    const out = { ...opts, zoom: z, pitch, bearing };
    delete out.keepSide;
    return out;
  }

  // margine (metri) fra la telecamera e il terreno, già tolto il minimo richiesto: negativo = troppo bassa.
  // Due controlli: il terreno sotto la telecamera (altrimenti MapLibre abbassa da solo l'inclinazione) e quello che
  // ha davanti, sullo schermo, fino al centro della vista (altrimenti una collina la attraversa: mappa a strisce).
  // MapLibre, interrogato su un punto senza quote pronte, a volte va in errore: quel punto si salta.
  _camClearance(tr = this._g3?.transform, min = 15) {
    const g = this._g3;
    if (!g || !tr || !g.getTerrain() || typeof tr.getCameraAltitude !== "function") return null;
    let cam;
    let c;
    let alt;
    try {
      cam = tr.getCameraLngLat();
      c = tr.center;
      alt = tr.getCameraAltitude();
    } catch (e) { return null; }
    const q = (ll) => {
      try {
        const e = g.queryTerrainElevation(ll);
        return e != null && Number.isFinite(e) ? e : null;
      } catch (e) { return null; }
    };
    let worst = null;
    const under = q([cam.lng, cam.lat]);
    if (under != null) worst = alt - under - 3;
    const cv = g.getCanvas();
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    for (let t = 0.25; t <= 1.001; t += 0.075) {
      const ll = [cam.lng + (c.lng - cam.lng) * t, cam.lat + (c.lat - cam.lat) * t];
      try {
        const px = tr.locationToScreenPoint(window.maplibregl.LngLat.convert(ll));
        if (!(px.x >= 0 && px.x <= w && px.y >= 0 && px.y <= h)) continue;
      } catch (e) { continue; }
      const e = q(ll);
      if (e == null) continue;
      const m = alt - e - min;
      if (worst == null || m < worst) worst = m;
    }
    return worst;
  }

  // telecamera 3D: in guida segue la posizione (nel terzo basso, girata nella direzione di marcia), altrimenti ricopia Leaflet
  _sync3d() {
    try { this._sync3dCam(); } catch (e) { this._recover3d(e); }
  }

  // in guida la posizione sta nel terzo basso dello schermo, ma mai sotto la barra in basso:
  // il veicolo (centro della vista) resta sempre un po' sopra la barra della guida.
  // Si usa sia il margine in alto sia quello in basso, così anche con una barra alta il veicolo si solleva quanto basta.
  _guidaPad() {
    const H = this.$("mapwrap")?.clientHeight || 0;
    const bot = this.$("navbot");
    const barZone = bot && !bot.hidden ? bot.offsetHeight + 20 + 14 : 0; // altezza della barra (bottom:20px) + margine
    const wantY = Math.min(H * 0.62, H - barZone); // posizione del veicolo sullo schermo (62%: più centrato, con strada davanti)
    const delta = 2 * wantY - H;                    // centro Y = (top + H − bottom) / 2 = wantY
    return { top: Math.max(0, delta), bottom: Math.max(0, -delta), left: 0, right: 0 };
  }

  _sync3dCam() {
    const g = this._g3;
    // con le dita sullo schermo (_g3interacting) non si riposiziona la telecamera: il ricentro a ogni GPS bloccava il gesto da vicino
    // sicurezza: un "dito appoggiato" fermo da troppo o un gesto mai chiuso non devono bloccare per sempre la camera
    const now = Date.now();
    if (this._g3interacting && now - (this._g3lastPtr || 0) > 8000) {
      this._g3ptrs?.clear(); this._g3downs = 0; this._g3interacting = false; this._g3Heavy(true);
    }
    if (this._g3gest?.size && !this._g3interacting && now - (this._g3gestT || 0) > 2500) this._g3gest.clear();
    if (!this._3d || !g || this._from3d || this._g3interacting || this._g3gest?.size || this._stepAnim || this._stepK != null) return;
    this._g3thaw?.();
    const nav = this._nav;
    // MapLibre misura lo zoom con riquadri da 512 pixel, Leaflet da 256; in guida si aggiunge la distanza scelta dall'utente
    const z = nav?.fix && nav.follow && this._isGuida() ? this._base3dZoom() + this._zoom3dOff() : this._map.getZoom() + Z3D;
    const none = { top: 0, bottom: 0, left: 0, right: 0 };
    if (nav?.fix && nav.follow) {
      const guida = this._isGuida();
      const pad = guida ? this._guidaPad() : null;
      const pos = this._navPos(); // all'avvio l'inizio della linea, poi il GPS reale
      const key = `${pos.lat},${pos.lon},${z},${nav.dir},${guida},${this._pitch3d()},${pad ? Math.round(pad.top) + "/" + Math.round(pad.bottom) : ""}`;
      if (key === this._g3key) return;
      this._g3key = key;
      const cam = this._clearCamera({ keepSide: guida, center: [pos.lon, pos.lat], zoom: z,
        bearing: guida && nav.dir != null ? nav.dir : g.getBearing(), pitch: guida ? this._pitch3d() : g.getPitch(),
        padding: pad || none });
      g.easeTo({ ...cam, duration: 700, easing: (t) => t });
    } else {
      this._g3key = null;
      if (this._g3flying) return; // "Centra" in 3D: la vista sta volando sul punto
      const c = this._map.getCenter();
      g.jumpTo(this._clearCamera({ center: [c.lng, c.lat], zoom: z, bearing: g.getBearing(), pitch: g.getPitch(), padding: none }));
    }
  }

  // dopo un cambio di dimensioni: mappa sulla posizione seguita, altrimenti sul centro di prima
  _relayout() {
    const m = this._map;
    if (!m) return;
    this._applyNavTopPos();
    this._applyFloat("pitchctl"); this._applyFloat("spdbox");
    const c = m.getCenter();
    this._layoutRot();
    m.invalidateSize({ pan: false });
    if (this._3d) this._g3?.resize();
    if (this._nav?.fix && this._nav.follow) this._followView(false);
    else m.setView(c, m.getZoom(), { animate: false });
  }

  // in guida la mappa è un quadrato grande quanto la diagonale, così ruotando copre sempre tutto lo schermo
  _layoutRot() {
    const wrap = this.$("mapwrap");
    const el = this.$("map");
    if (!wrap || !el) return;
    if (this._rotated()) {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      const d = Math.ceil(Math.hypot(w, h));
      Object.assign(el.style, { width: `${d}px`, height: `${d}px`, left: `${(w - d) / 2}px`, top: `${(h - d) / 2}px`, right: "auto", bottom: "auto" });
      el.classList.add("rot");
      el.classList.toggle("free", !this._isGuida());
      el.style.transform = `rotate(${-(this._rot || 0)}deg)`;
      el.style.setProperty("--maprot", `${this._rot || 0}deg`); // per raddrizzare i popup
    } else {
      for (const k of ["width", "height", "left", "top", "right", "bottom", "transform"]) el.style[k] = "";
      el.style.removeProperty("--maprot");
      el.classList.remove("rot", "free");
      this._rot = 0;
    }
    this._northBtn();
  }

  // mappa 2D ruotata: in guida (segue la direzione di marcia) o girata a mano con due dita
  _rotated() {
    return this._isGuida() || (!!this._freeRot && !!(this._rot % 360));
  }

  // bussola: compare quando la mappa 2D è girata a mano; toccandola torna il nord in alto
  _northBtn() {
    const b = this.$("northbtn");
    if (!b) return;
    const show = !this._isGuida() && !this._3d && this._rotated();
    b.hidden = !show;
    if (show) b.querySelector("svg").style.transform = `rotate(${-(this._rot || 0)}deg)`;
  }

  _resetNorth() {
    this._freeRot = false;
    this._rot = 0;
    this._relayout();
    this._applyInteract();
  }

  // con la mappa ruotata trascinamento e zoom con le dita li gestisce il pannello (Leaflet non sa della rotazione)
  _applyInteract() {
    const m = this._map;
    if (!m) return;
    const own = this._rotated();
    if (own && m.touchZoom._zooming) m.touchZoom._zooming = false; // pinch di Leaflet già iniziato: da qui lo zoom lo fa il pannello
    for (const h of ["dragging", "touchZoom", "doubleClickZoom"]) m[h][own ? "disable" : "enable"]();
    m.options.scrollWheelZoom = own ? "center" : true; // lo zoom resta sul centro: con la mappa ruotata il punto del mouse non torna
    // zoom con le dita senza scatti sulla mappa ruotata; dritta torna a livelli interi
    const snap = own ? 0.25 : 1;
    if (m.options.zoomSnap !== snap) {
      m.options.zoomSnap = snap;
      if (snap === 1) m.setZoom(Math.round(m.getZoom()), { animate: false });
    }
  }

  // punto della mappa sotto il dito/mouse con la mappa ruotata (Leaflet lo calcolerebbe come se non lo fosse)
  _unrotLatLng(ev) {
    const el = this.$("map");
    const rc = el.getBoundingClientRect();
    const vx = ev.clientX - (rc.left + rc.width / 2), vy = ev.clientY - (rc.top + rc.height / 2);
    const r = ((this._rot || 0) * Math.PI) / 180;
    const mx = vx * Math.cos(r) - vy * Math.sin(r), my = vx * Math.sin(r) + vy * Math.cos(r);
    return this._map.containerPointToLatLng([el.offsetWidth / 2 + mx, el.offsetHeight / 2 + my]);
  }

  _applyRotation() {
    if (!this._isGuida() || this._nav.dir == null) return;
    const cur = this._rot || 0;
    // in guida la mappa segue la direzione di marcia; con due dita la si può girare per un momento (_rotUser)
    const target = this._nav.dir + (this._rotUser || 0);
    const delta = ((((target - cur) % 360) + 540) % 360) - 180; // giro più corto
    this._rot = cur + delta;
    this.$("map").style.transform = `rotate(${-this._rot}deg)`;
    this.$("map").style.setProperty("--maprot", `${this._rot}deg`);
  }

  // centra la mappa sulla posizione; in guida la posizione sta nel terzo basso dello schermo, con la strada davanti
  _followView(animate = true) {
    const nav = this._nav;
    const f = this._navPos() || nav.fix;
    // al primo aggancio almeno zoom 16, poi resta quello scelto con + e −
    let z = nav.zoomed ? this._map.getZoom() : Math.max(this._map.getZoom(), 16);
    // zoom secondo la velocità, salvo per 20 secondi dopo uno zoom fatto a mano
    if (this._autoZoomOn() && this._isGuida() && nav.speed != null && Date.now() > (nav.manualZoomUntil || 0)) {
      const target = zoomForSpeed(nav.speed * 3.6);
      if (Math.abs(target - z) >= 0.5) z = target;
    }
    if (!nav.zoomed) animate = false; // il primo aggancio è immediato: con l'animazione lo zoom letto dopo sarebbe quello vecchio
    nav.zoomed = true;
    let ll = L.latLng(f.lat, f.lon);
    if (this._isGuida() && nav.dir != null) {
      const d = this.$("mapwrap").clientHeight * 0.25;
      const rad = (nav.dir * Math.PI) / 180;
      ll = this._map.unproject(this._map.project(ll, z).add(L.point(Math.sin(rad) * d, -Math.cos(rad) * d)), z);
    }
    this._map.setView(ll, z, { animate });
  }

  // Ricentra: torna a seguire la posizione e annulla lo zoom fatto a mano (+, −, pinch): di nuovo lo zoom automatico
  // secondo la velocità, o quello iniziale della guida
  _recenter() {
    const nav = this._nav;
    if (!nav) return;
    // in 3D la distanza scelta resta; premuto due volte di seguito torna quella predefinita
    let far3d = false;
    if (this._3d && Date.now() - (this._lastCenter || 0) < 1500 && this._zoom3dOff() !== 0) {
      this._setZoom3dOff(0);
      this._msg("Vista 3D: distanza predefinita");
      far3d = true;
    }
    this._lastCenter = Date.now();
    nav.follow = true;
    nav.userFrame = false; // ◎: riprende a seguire e ricentra, anche se avevi tenuto una tua inquadratura
    nav.manualZoomUntil = 0;
    const z = this._autoZoomOn() && nav.speed ? zoomForSpeed(nav.speed * 3.6) : 17;
    this._map.setZoom(z, { animate: false });
    this._g3key = null;
    if (nav.fix) this._followView();
    // in 3D ricentra DIRETTAMENTE la telecamera sul mezzo, vicino e inclinato di 40°
    if (this._3d && this._g3 && this._g3ok && nav.fix) this._recenter3d(far3d);
    this._renderNav();
  }

  // ◎ in 3D: porta la telecamera vicino al mezzo (~2 metri) con 40° di inclinazione.
  // Agisce direttamente, senza affidarsi alla sincronizzazione con la mappa 2D (che restava
  // distante) e azzerando eventuali stati di gesto rimasti "aperti" sul telefono, che
  // altrimenti facevano uscire subito la sincronizzazione e il ricentro non partiva.
  _recenter3d(far = false) {
    const g = this._g3;
    const nav = this._nav;
    if (!g || !nav?.fix) return;
    // sblocca gesti eventualmente rimasti attivi (il tocco a volte non si "chiude" sul telefono)
    this._g3interacting = false;
    this._g3downs = 0;
    this._g3ptrs?.clear();
    this._g3gest?.clear?.();
    this._g3Heavy(true);
    // inclinazione a 40° come richiesto; la vista ravvicinata si memorizza così la guida la mantiene
    this._settings.pitch3d = 40;
    if (far) this._saveSettings(); else this._setZoom3dOff(2);
    // La prima volta (appena entrati in 3D) il terreno non è ancora caricato: senza la quota del
    // centro la telecamera resta altissima e il ricentro "non parte". Si riapplica un paio di volte
    // dopo un attimo, così appena il terreno è pronto la vista scende sul mezzo.
    this._apply3dRecenter();
    clearTimeout(this._rc3dT1); clearTimeout(this._rc3dT2);
    const re = () => { if (this._3d && this._nav?.follow && !this._g3interacting && !this._g3downs) this._apply3dRecenter(); };
    this._rc3dT1 = setTimeout(re, 500);
    this._rc3dT2 = setTimeout(re, 1300);
  }

  // Sposta davvero la telecamera 3D sul mezzo, vicino e a 40°. Richiamata più volte dal ricentro,
  // perché il risultato di _clearCamera dipende dal terreno, che può non essere pronto al primo giro.
  _apply3dRecenter() {
    const g = this._g3;
    const nav = this._nav;
    if (!g || !nav?.fix) return;
    this._g3key = null;
    const guida = this._isGuida();
    const pos = this._navPos() || { lat: nav.fix.lat, lon: nav.fix.lon };
    const z = this._base3dZoom() + this._zoom3dOff();
    const cam = this._clearCamera({
      center: [pos.lon, pos.lat], zoom: z,
      bearing: guida && nav.dir != null ? nav.dir : g.getBearing(),
      pitch: 40,
      padding: guida ? this._guidaPad() : { top: 0, bottom: 0, left: 0, right: 0 },
    });
    g.easeTo({ ...cam, duration: 400, easing: (t) => t, essential: true });
  }

  // l'utente ha spostato la mappa: smette di seguire la posizione finché non preme Ricentra
  _userMoved() {
    if (this._nav && this._nav.follow) {
      this._nav.follow = false;
      this._renderNav();
    }
  }

  // trascinamento (mouse o un dito) e zoom con due dita sulla mappa ruotata (guida o girata a mano);
  // fuori guida, due dita che ruotano girano la mappa 2D (Leaflet da solo non sa ruotare)
  _bindGuidaGestures() {
    const el = this.$("map");
    const pts = new Map();
    let prev = null;
    let moved = false;
    let pinch0 = null; // distanza e zoom all'inizio del pinch: lo zoom si calcola da lì, non a piccoli passi
    let twist0 = null; // angolo fra le due dita all'inizio: la rotazione parte solo oltre una soglia
    const mine = () => this._rotated(); // gesti gestiti qui (non da Leaflet)
    const canTwist = () => !this._isGuida() && !this._3d;
    // in guida (2D): due dita che ruotano girano la mappa per guardarsi intorno; mollate, dopo un attimo torna nel verso di marcia
    const guidaTwist = () => this._isGuida() && !this._3d && !!this._nav;
    let twisting = false;
    let rotBase = 0;
    const state = () => {
      const a = [...pts.values()];
      const c = a.length >= 2 ? { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 } : { x: a[0].x, y: a[0].y };
      const d = a.length >= 2 ? Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) : 0;
      const ang = a.length >= 2 ? (Math.atan2(a[1].y - a[0].y, a[1].x - a[0].x) * 180) / Math.PI : 0;
      return { c, d, ang, n: a.length, zoom: this._map.getZoom() };
    };
    const angDiff = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;
    el.addEventListener("pointerdown", (e) => {
      if (e.button > 0 || (!mine() && !canTwist())) return;
      if (mine()) { try { el.setPointerCapture(e.pointerId); } catch (err) { /* puntatore simulato */ } }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      prev = state();
      if (pts.size === 1) moved = false;
      pinch0 = pts.size >= 2 ? { d: prev.d, zoom: prev.zoom } : null;
      twist0 = pts.size >= 2 ? prev.ang : null;
      twisting = false;
    });
    el.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const now = state();
      if (now.n !== prev.n) { prev = now; pinch0 = now.n >= 2 ? { d: now.d, zoom: now.zoom } : null; twist0 = now.n >= 2 ? now.ang : null; return; }
      // mappa dritta: si guarda solo se le due dita ruotano abbastanza (15°), poi la mappa diventa "girata a mano"
      if (!mine()) {
        if (!canTwist() || now.n < 2 || twist0 == null || Math.abs(angDiff(now.ang, twist0)) < 15) { prev = now; return; }
        this._freeRot = true;
        this._rot = (this._rot || 0) - angDiff(now.ang, twist0);
        this._map.stop?.();
        this._relayout();
        this._applyInteract();
        el.classList.add("moving");
        try { for (const id of pts.keys()) el.setPointerCapture(id); } catch (err) { /* puntatore simulato */ }
        moved = true;
        pinch0 = { d: now.d, zoom: this._map.getZoom() };
        prev = { ...now, zoom: this._map.getZoom() };
        return;
      }
      const dx = now.c.x - prev.c.x;
      const dy = now.c.y - prev.c.y;
      const pinch = now.n >= 2 && pinch0 && pinch0.d > 0;
      if (now.n >= 2 && guidaTwist() && twist0 != null) { // guida: rotazione momentanea, solo oltre 10° (lo zoom non gira)
        const tot = angDiff(now.ang, twist0);
        if (!twisting && Math.abs(tot) >= 10) { twisting = true; rotBase = this._rotUser || 0; clearTimeout(this._rotUserT); }
        if (twisting) { this._rotUser = rotBase - tot; this._applyRotation(); }
      }
      if (now.n >= 2 && canTwist()) { // rotazione con due dita
        const da = angDiff(now.ang, prev.ang);
        if (da) {
          this._rot = (this._rot || 0) - da;
          el.style.transform = `rotate(${-this._rot}deg)`;
          el.style.setProperty("--maprot", `${this._rot}deg`);
          this._northBtn();
        }
      }
      if (!moved) {
        if (Math.hypot(dx, dy) < 4 && !(pinch && Math.abs(now.d - pinch0.d) > 4)) return;
        moved = true;
        el.classList.add("moving");
        this._userMoved();
      }
      if (pinch) {
        const m = this._map;
        const z = Math.max(m.getMinZoom(), Math.min(m.getMaxZoom(), pinch0.zoom + Math.log2(now.d / pinch0.d)));
        m.setZoom(z, { animate: false });
        if (this._nav) this._nav.manualZoomUntil = Date.now() + 20000;
        now.zoom = m.getZoom();
      }
      // dallo schermo alla mappa: la mappa è ruotata di -rot, il movimento del dito va ruotato di +rot
      const r = ((this._rot || 0) * Math.PI) / 180;
      const mx = dx * Math.cos(r) - dy * Math.sin(r);
      const my = dx * Math.sin(r) + dy * Math.cos(r);
      if (mx || my) this._map.panBy([-mx, -my], { animate: false });
      prev = now;
    });
    const end = (e) => {
      if (!pts.delete(e.pointerId)) return;
      if (pts.size) { prev = state(); pinch0 = pts.size >= 2 ? { d: prev.d, zoom: prev.zoom } : null; twist0 = pts.size >= 2 ? prev.ang : null; }
      else {
        el.classList.remove("moving");
        pinch0 = twist0 = null;
        if (twisting) {
          twisting = false;
          clearTimeout(this._rotUserT);
          this._rotUserT = setTimeout(() => { this._rotUser = 0; if (this._nav) this._applyRotation(); }, 1500);
        }
        if (moved) this._gestEnd = Date.now();
        // girata fino quasi al nord: si raddrizza da sola
        if (this._freeRot && !this._isGuida()) {
          const r = ((((this._rot || 0) % 360) + 540) % 360) - 180;
          if (Math.abs(r) < 6) this._resetNorth();
        }
      }
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  _afterZoom() {
    if (this._nav) this._nav.manualZoomUntil = Date.now() + 20000;
    if (this._nav?.fix && this._nav.follow) setTimeout(() => this._followView(), 300);
  }

  // app Companion: Android espone window.externalApp, iPhone window.webkit.messageHandlers.externalBus
  // app NaviHA (quella del repo naviha): user agent "NaviHA/…" o i suoi ponti JavaScript
  _isNaviHA() {
    return /NaviHA\//i.test(window.navigator.userAgent || "") || !!window.NaviHAGeo || !!window.NaviHATTS;
  }

  _companion() {
    if (this._isNaviHA()) return "android";
    if (window.externalApp?.externalBus) return "android";
    if (window.webkit?.messageHandlers?.externalBus) return "ios";
    const ua = window.navigator.userAgent || "";
    if (/Home ?Assistant/i.test(ua)) return /android/i.test(ua) ? "android" : "ios";
    return null;
  }

  // apre le impostazioni dell'app Companion, con lo stesso messaggio che usa Home Assistant
  _openCompanionSettings() {
    const msg = { id: 90000 + Math.floor(Math.random() * 9999), type: "config_screen/show" };
    try {
      if (window.externalApp?.externalBus) { window.externalApp.externalBus(JSON.stringify(msg)); return true; }
      if (window.webkit?.messageHandlers?.externalBus) { window.webkit.messageHandlers.externalBus.postMessage(msg); return true; }
    } catch (e) { /* app senza questo comando */ }
    return false;
  }

  // permesso della posizione negato: come riattivarlo, con scorciatoie dove possibile
  async _gpsHelp(asked = false) {
    const app = this._companion();
    let state = "";
    try { state = (await window.navigator.permissions?.query({ name: "geolocation" }))?.state || ""; } catch (e) { /* non supportato */ }
    const secure = window.isSecureContext;
    let steps;
    let links = "";
    if (app === "android") {
      this._androidHelp();
      return;
    }
    if (app === "ios") {
      steps = `<li>Apri <b>Impostazioni</b> dell'iPhone → <b>Home Assistant</b> → <b>Posizione</b>.</li>
        <li>Scegli <b>Mentre usi l'app</b> (o <b>Sempre</b>) e attiva <b>Posizione esatta</b>.</li>
        <li>Chiudi del tutto l'app Home Assistant e riaprila.</li>`;
      links = `<a class="pri" href="app-settings:">⚙ Apri le Impostazioni dell'iPhone</a>`;
    } else {
      steps = `<li>Clicca il <b>lucchetto</b> (o l'icona delle impostazioni del sito) a sinistra dell'indirizzo, in alto.</li>
        <li>Alla voce <b>Posizione</b> scegli <b>Consenti</b>.</li>
        <li>Ricarica la pagina.</li>`;
    }
    if (app) links += `<button data-h="app">📱 Impostazioni dell'app Companion</button>`;
    const person = this._navSources().find((x) => x.id !== "gps" && x.ok);
    if (person && this._result) links += `<button data-h="person">👤 Usa invece la posizione di ${esc(person.name.replace(/^\S+\s/, ""))}</button>`;
    links += `<button class="close" data-h="close">Chiudi</button>`;
    const title = state === "denied" || !asked ? "Posizione negata" : "Posizione del dispositivo";
    const intro = !secure
      ? "Home Assistant è aperto in <b>http</b>: in questo caso il browser non concede mai il GPS. Aprilo in HTTPS oppure usa la posizione di una persona di Home Assistant (aggiornata dall'app Companion)."
      : state === "denied" || !asked
        ? "Il permesso della posizione è stato rifiutato per Home Assistant, e finché non lo riattivi non viene più chiesto. Per riattivarlo:"
        : `Stato attuale del permesso: <b>${{ granted: "consentito", prompt: "da chiedere", denied: "negato" }[state] || "sconosciuto"}</b>. Se è negato, per riattivarlo:`;
    const el = this.$("navpop");
    clearTimeout(this._nav?.popTimer);
    el.className = "navpop help";
    el.innerHTML = `<div class="big">📡</div><h4>${title}</h4><div>${intro}</div>${secure ? `<ol>${steps}</ol>` : ""}
      <div class="acts">${links}</div>
      ${app ? `<div class="note">Se un tasto non apre nulla, segui i passi a mano: alcune versioni dell'app non permettono di aprire le impostazioni da qui.</div>` : ""}`;
    el.hidden = false;
    el.querySelector('[data-h="close"]').addEventListener("click", () => { el.hidden = true; });
    el.querySelector('[data-h="app"]')?.addEventListener("click", () => {
      if (!this._openCompanionSettings()) this._msg("Questa versione dell'app non permette di aprire le impostazioni da qui");
    });
    el.querySelector('[data-h="person"]')?.addEventListener("click", () => {
      el.hidden = true;
      this._startNav(person.id);
    });
  }

  // ----------------------------------------------------------------- telefono con l'app Companion
  // Home Assistant può mandare comandi all'app con il servizio di notifica (notify.mobile_app_…):
  // "request_location_update" (manda subito la posizione) e, solo Android, "command_high_accuracy_mode" (posizione ogni
  // pochi secondi). Così la guida riceve posizioni fresche senza dover cambiare impostazioni sul telefono.

  // servizio di notifica del telefono di una persona o di un dispositivo: { svc, ios, name } oppure null
  _phoneOf(source) {
    const h = this._hass;
    const st = h?.states?.[source];
    if (!st) return null;
    let tracker = source;
    if (source.startsWith("person.")) {
      const list = [st.attributes.source, ...(st.attributes.device_trackers || [])].filter((x) => x?.startsWith?.("device_tracker."));
      tracker = list.find((t) => this._phoneOf(t)) || list[0];
    }
    if (!tracker?.startsWith("device_tracker.")) return null;
    const svcs = Object.keys(h.services?.notify || {});
    const dev = h.devices?.[h.entities?.[tracker]?.device_id];
    const slug = (x) => String(x || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const cands = [`mobile_app_${tracker.split(".")[1]}`, dev && `mobile_app_${slug(dev.name_by_user || dev.name)}`, dev && `mobile_app_${slug(dev.name)}`];
    const svc = cands.find((c) => c && svcs.includes(c));
    if (!svc) return null;
    return { svc, tracker, ios: /apple/i.test(dev?.manufacturer || "") || /iphone|ipad/i.test(dev?.model || ""),
      name: h.states[tracker]?.attributes?.friendly_name || dev?.name || tracker };
  }

  _phoneCmd(ph, message, data) {
    return this._hass.callService("notify", ph.svc, data ? { message, data } : { message })
      .catch((e) => console.debug("[Navigator GPS] comando al telefono non riuscito:", message, e?.message || e));
  }

  // posizione vecchia: si chiede al telefono e si aspetta fino a 25 s che ne arrivi una nuova, poi si parte
  async _askPhoneThenStart(source, age) {
    const ph = this._phoneOf(source);
    const st0 = this._hass.states[source];
    const el = this.$("navpop");
    el.className = "navpop";
    el.innerHTML = `<div class="big"><span class="loading"></span></div>Chiedo la posizione a <b>${esc(ph.name)}</b>…
      <div style="font-size:13px;opacity:.8;margin-top:6px">L'app Companion la manda in pochi secondi</div>
      <div class="acts" style="margin-top:10px"><button class="close" data-h="close">Annulla</button></div>`;
    el.hidden = false;
    let cancelled = false;
    el.querySelector('[data-h="close"]').addEventListener("click", () => { cancelled = true; el.hidden = true; });
    this._phoneCmd(ph, "request_location_update");
    if (!ph.ios) this._phoneCmd(ph, "command_high_accuracy_mode", { command: "turn_on" }); // il GPS si accende già adesso
    const t0 = Date.now();
    while (!cancelled && Date.now() - t0 < 25000) {
      await new Promise((ok) => setTimeout(ok, 1000));
      const st = this._hass.states[source];
      if (st && st.last_updated !== st0?.last_updated && Date.now() - Date.parse(st.last_updated) < 60000) {
        el.hidden = true;
        console.debug("[Navigator GPS] posizione nuova dal telefono in", Math.round((Date.now() - t0) / 1000), "s");
        this._startNav(source, true);
        return;
      }
    }
    if (cancelled) return;
    if (!ph.ios) this._phoneCmd(ph, "command_high_accuracy_mode", { command: "turn_off" });
    this._staleHelp(source, Date.now() - Date.parse(this._hass.states[source]?.last_updated || 0), true);
  }

  // in guida: alta precisione accesa (Android) e, se le posizioni smettono di arrivare per 40 s, se ne chiede una
  _phoneGuida(on, nav = this._nav) {
    if (!nav) return;
    clearInterval(nav.phoneTimer);
    const ph = nav.phone || (on ? this._phoneOf(nav.source) : null);
    if (!ph) return;
    if (!on) {
      if (!ph.ios) this._phoneCmd(ph, "command_high_accuracy_mode", { command: "turn_off" });
      return;
    }
    nav.phone = ph;
    if (!ph.ios) this._phoneCmd(ph, "command_high_accuracy_mode", { command: "turn_on" });
    nav.phoneTimer = setInterval(() => {
      if (this._nav !== nav) { clearInterval(nav.phoneTimer); return; }
      const st = this._hass.states[nav.source];
      const age = st ? Date.now() - Date.parse(st.last_updated) : Infinity;
      if (age > 40000 && Date.now() - (nav.phoneAsk || 0) > 60000) {
        nav.phoneAsk = Date.now();
        this._phoneCmd(ph, "request_location_update");
      }
    }, 10000);
  }

  // app Companion Android: spesso la sua WebView non passa il GPS alle pagine, anche con tutte le autorizzazioni concesse.
  // La posizione arriva a Home Assistant dal sensore dell'app, nella propria persona.
  _staleHelp(source, age, asked = false) {
    const st = this._hass.states[source];
    const name = st?.attributes?.friendly_name || source;
    const gps = window.isSecureContext && !!window.navigator.geolocation;
    const el = this.$("navpop");
    clearTimeout(this._nav?.popTimer);
    el.className = "navpop help";
    el.innerHTML = `<div class="big">🕘</div><h4>Posizione vecchia</h4>
      <div>L'ultima posizione di <b>${esc(name)}</b> è arrivata <b>${esc(fmtAge(age))}</b>${asked
        ? " e il telefono non ha risposto alla richiesta di una posizione nuova (25 s)" : ": Home Assistant non ne riceve di nuove"}
        (di solito l'app Companion non ha il permesso di posizione <b>Consenti sempre</b>, o il risparmio energetico la blocca).
        La guida partirebbe da lì e si muoverebbe solo quando arriva una posizione nuova.</div>
      <ol>
        <li>Apri l'app Companion sul telefono (manda subito la posizione) o riattiva la <b>Posizione in background</b>.</li>
        <li>Oppure usa il <b>GPS di questo dispositivo</b> (nel browser serve Home Assistant in HTTPS).</li>
      </ol>
      <div class="acts">
        ${gps ? `<button class="pri" data-h="gps">📱 Usa il GPS di questo dispositivo</button>` : ""}
        <button data-h="go">▶ Parti lo stesso</button>
        <button class="close" data-h="close">Annulla</button>
      </div>`;
    el.hidden = false;
    el.querySelector('[data-h="close"]').addEventListener("click", () => { el.hidden = true; });
    el.querySelector('[data-h="go"]').addEventListener("click", () => { el.hidden = true; this._startNav(source, true); });
    el.querySelector('[data-h="gps"]')?.addEventListener("click", () => { el.hidden = true; this._startNav("gps"); });
  }

  _androidHelp() {
    const person = this._myPerson();
    const el = this.$("navpop");
    clearTimeout(this._nav?.popTimer);
    el.className = "navpop help";
    el.innerHTML = `<div class="big">📡</div><h4>GPS nell'app Android</h4>
      <div>Il GPS di questa pagina non risponde: su molti telefoni l'app Companion per Android <b>non passa il GPS alle pagine</b> che
        mostra, anche con tutte le autorizzazioni concesse. La posizione arriva però a Home Assistant dal sensore dell'app: Navigator usa quella,
        tramite la tua <b>persona</b>.</div>
      <ol>
        <li>Nella sezione <i>Navigazione</i> scegli la tua persona${person ? ` (<b>${esc(person.name.replace(/^\S+\s/, ""))}</b>)` : ""}.</li>
        <li>Per aggiornamenti ogni pochi secondi, nell'app apri <b>Impostazioni</b> → <b>App Companion</b> → <b>Gestisci sensori</b> →
          <b>Posizione in background</b> e attiva la <b>Modalità alta precisione</b> (anche solo quando sei in auto o collegato al Bluetooth dell'auto).</li>
      </ol>
      <div class="acts">
        ${person && this._result ? `<button class="pri" data-h="person">👤 Parti con la posizione di ${esc(person.name.replace(/^\S+\s/, ""))}</button>` : ""}
        <button data-h="app">📱 Apri le impostazioni dell'app Companion</button>
        <button class="close" data-h="close">Chiudi</button>
      </div>
      ${person ? "" : `<div class="note">Non trovo una persona con posizione: nell'app attiva i sensori di posizione e collega il dispositivo a una persona (Impostazioni → Persone).</div>`}`;
    el.hidden = false;
    el.querySelector('[data-h="close"]').addEventListener("click", () => { el.hidden = true; });
    el.querySelector('[data-h="app"]').addEventListener("click", () => {
      if (!this._openCompanionSettings()) this._msg("Questa versione dell'app non permette di aprire le impostazioni da qui");
    });
    el.querySelector('[data-h="person"]')?.addEventListener("click", () => {
      el.hidden = true;
      try { localStorage.setItem(`${STORE_KEY}-navsrc`, person.id); } catch (e) { /* storage non disponibile */ }
      this._startNav(person.id);
    });
  }

  // ----------------------------------------------------------------- luoghi nelle vicinanze

  // linea del percorso da cercare: in navigazione il tratto davanti (max km), altrimenti tutto il percorso
  _routeLine(maxKm) {
    const rt = this._geom(this._result.routes[this._sel]);
    const from = this._nav ? Math.max(0, this._nav.idx) : 0;
    const start = this._nav?.snap?.along ?? 0;
    const out = [];
    for (let i = from; i < rt.shape.length; i++) {
      if (maxKm && rt._cum[i] - start > maxKm * 1000) break;
      out.push([Math.round(rt.shape[i][0] * 1e5) / 1e5, Math.round(rt.shape[i][1] * 1e5) / 1e5]);
    }
    const step = Math.ceil(out.length / 7500);
    return step > 1 ? out.filter((_, k) => k % step === 0 || k === out.length - 1) : out;
  }

  // posizione di un luogo lungo il percorso (m dall'inizio) e distanza dalla strada
  _alongRoute(rt, it) {
    const sn = this._snap(rt, { lat: it.lat, lon: it.lon }, this._nav?.idx || 0);
    return { along: sn.along, idx: sn.idx };
  }

  async _fetchNearby(cat) {
    const rt = this._geom(this._result.routes[this._sel]);
    const msg = { type: "navigator/nearby", category: cat };
    if (cat === "parking") {
      const near = this._nearWhere === "me" && this._nav?.fix ? this._nav.fix : this._points[this._points.length - 1];
      Object.assign(msg, { center: { lat: near.lat, lon: near.lon }, radius: 700 });
    } else {
      Object.assign(msg, { line: this._routeLine(this._nav ? (cat === "fuel" ? 40 : 0) : 0), radius: cat === "fuel" ? 500 : 35 });
    }
    const r = await this._hass.callWS(msg);
    if (cat !== "parking") {
      const here = this._nav?.snap?.along ?? 0;
      r.items = r.items.map((it) => ({ ...it, ...this._alongRoute(rt, it) }))
        .filter((it) => !this._nav || it.along >= here - 30)
        .map((it) => ({ ...it, to: it.along - here }))
        .sort((a, b) => a.along - b.along);
    }
    return r;
  }

  _closeNearby() {
    const w = this.$("nearwrap");
    if (w) w.hidden = true;
    this._poiLayer?.clearLayers();
  }

  async _openNearby(cat) {
    if (!this._result) return;
    this._nearCat = cat;
    const wrap = this.$("nearwrap");
    const tabs = Object.entries(NEAR_CATS).map(([k, [ic, n]]) => `<button data-c="${k}" class="${k === cat ? "on" : ""}">${ic} ${n}</button>`).join("");
    wrap.innerHTML = `<div class="setdlg" role="dialog" aria-label="Nelle vicinanze">
      <div class="hd"><h2>🔎 Nelle vicinanze</h2><button class="icon" data-x="close" title="Chiudi">✕</button></div>
      <div class="tabs">${tabs}</div><div id="nearbody"><div class="grp"><span class="loading"></span> Cerco…</div></div></div>`;
    wrap.hidden = false;
    wrap.onclick = (e) => { if (e.target === wrap) this._closeNearby(); };
    wrap.querySelector('[data-x="close"]').addEventListener("click", () => this._closeNearby());
    wrap.querySelectorAll("[data-c]").forEach((b) => b.addEventListener("click", () => this._openNearby(b.dataset.c)));
    let res;
    const slow = setTimeout(() => {
      const b = wrap.querySelector("#nearbody .grp");
      if (b && this._nearCat === cat && b.querySelector(".loading")) {
        b.innerHTML = `<span class="loading"></span> Cerco… ${cat === "fuel" ? "la prima volta scarico l'elenco dei distributori"
          : "i server di OpenStreetMap a volte sono lenti, attendi qualche secondo"}`;
      }
    }, 4000);
    try {
      res = await this._fetchNearby(cat);
    } catch (err) {
      clearTimeout(slow);
      if (this._nearCat !== cat) return;
      wrap.querySelector("#nearbody").innerHTML = `<div class="grp"><div class="box err" style="margin:0">${esc(err.message || err)}</div></div>`;
      return;
    }
    clearTimeout(slow);
    if (this._nearCat !== cat || wrap.hidden) return;
    this._nearRes = res;
    this._renderNearby();
  }

  _renderNearby() {
    const cat = this._nearCat;
    const res = this._nearRes;
    const body = this.$("nearbody");
    const s = this._settings;
    let items = res.items;
    let filt = "";
    if (cat === "fuel") {
      const present = [...new Set(items.map((i) => i.brand).filter(Boolean))].sort();
      const mode = this._fuelFilter || (s.fuelBrands.length ? "pref" : "all");
      if (mode === "pref") items = items.filter((i) => s.fuelBrands.includes(i.brand));
      else if (mode !== "all") items = items.filter((i) => i.brand === mode);
      // carburante: scelta del momento o preferenza nelle impostazioni; solo i tipi presenti nei risultati
      const kinds = FUEL_KINDS.filter(([k]) => res.items.some((i) => (i.fuels || []).some((f) => fuelMatch(f, k))));
      let kind = this._fuelKind ?? s.fuelKind ?? "";
      if (kind && !kinds.some(([k]) => k === kind)) kind = "";
      if (kind) items = items.filter((i) => (i.fuels || []).some((f) => fuelMatch(f, kind)));
      const best = (i) => Math.min(...(i.fuels || []).filter((f) => fuelMatch(f, kind) && fuelPrice(f) != null).map(fuelPrice));
      const byPrice = kind && this._fuelSort === "price";
      if (byPrice) items = [...items].sort((a, b) => best(a) - best(b));
      this._fuelShowKind = kind;
      filt = `<div class="chips" style="padding:8px 16px 0">
        <span class="chip ${mode === "all" ? "on" : ""}" data-f="all">Tutte</span>
        ${s.fuelBrands.length ? `<span class="chip ${mode === "pref" ? "on" : ""}" data-f="pref">★ Preferite</span>` : ""}
        ${present.map((b) => `<span class="chip ${mode === b ? "on" : ""}" data-f="${esc(b)}">${esc(b)}</span>`).join("")}</div>
        ${kinds.length ? `<div class="chips" style="padding:6px 16px 0">
        <span class="chip ${kind ? "" : "on"}" data-fk="">Tutti i carburanti</span>
        ${kinds.map(([k, n]) => `<span class="chip ${kind === k ? "on" : ""}" data-fk="${k}">${esc(n)}</span>`).join("")}</div>` : ""}
        ${kind ? `<div class="chips" style="padding:6px 16px 0">
        <span class="chip ${byPrice ? "" : "on"}" data-o="along">Lungo il percorso</span>
        <span class="chip ${byPrice ? "on" : ""}" data-o="price">€ Prezzo più basso</span></div>` : ""}`;
    } else if (cat === "parking") {
      const where = this._nearWhere || "dest";
      filt = `<div class="chips" style="padding:8px 16px 0">
        <span class="chip ${where === "dest" ? "on" : ""}" data-w="dest">All'arrivo</span>
        ${this._nav?.fix ? `<span class="chip ${where === "me" ? "on" : ""}" data-w="me">Vicino a me</span>` : ""}</div>`;
    }
    const nav = !!this._nav;
    const rows = items.slice(0, 60).map((it, k) => {
      let bd;
      let tx;
      let dd;
      let act;
      if (cat === "fuel") {
        bd = `<span class="bd" style="background:${brandColor(it.brand)}">${esc(it.brand || "?")}</span>`;
        tx = `<span class="nm">${esc(it.name || it.brand)}</span><small>${esc([it.addr, it.town].filter(Boolean).join(", "))}${it.motorway ? " · autostrada" : ""}</small>`;
        dd = `${nav ? `tra ${fmtDist(it.to)}` : fmtDist(it.along)}<small>${it.off} m dalla strada</small>`;
        act = `<button data-go="${k}">➕ Tappa</button>`;
      } else if (cat === "parking") {
        bd = `<span class="bd" style="background:#1565c0">P</span>`;
        const info = [it.covered ? "coperto" : "", it.fee === "yes" ? "a pagamento" : it.fee === "no" ? "gratuito" : "",
          it.capacity ? `${it.capacity} posti` : "", it.hours].filter(Boolean).join(" · ");
        tx = `${esc(it.name || ({ underground: "Parcheggio sotterraneo", "multi-storey": "Parcheggio multipiano", street_side: "Parcheggio lungo strada", lane: "Parcheggio lungo strada" }[it.kind] || "Parcheggio"))}<small>${esc(info)}</small>`;
        dd = `${fmtDist(it.off)}<small>${this._nearWhere === "me" ? "da te" : "dall'arrivo"}</small>`;
        act = `<button data-go="${k}">🅿️ Vai qui</button>`;
      } else {
        bd = `<span class="bd" style="background:#263238">${it.maxspeed ? it.maxspeed : "📷"}</span>`;
        tx = `Autovelox fisso${it.maxspeed ? ` · limite ${it.maxspeed} km/h` : ""}<small>${esc(it.name || "")}</small>`;
        dd = nav ? `tra ${fmtDist(it.to)}` : fmtDist(it.along);
        act = "";
      }
      if (cat === "fuel") {
        return `<li data-k="${k}" class="fu">${bd}<div class="tx">${tx}</div><div class="fs"><div class="dd">${dd}</div>${act}</div>${this._fuelLine(it)}</li>`;
      }
      return `<li data-k="${k}">${bd}<div class="tx">${tx}</div><div class="dd">${dd}</div>${act}</li>`;
    }).join("");
    const empty = { fuel: "Nessun distributore entro 500 m dal percorso", parking: "Nessun parcheggio pubblico trovato entro 700 m",
      cameras: "Nessun autovelox fisso sul percorso" }[cat];
    body.innerHTML = `${filt}<ul class="plist">${rows || `<li><div class="tx muted">${empty}${cat === "fuel" && items.length !== res.items.length ? " con questo filtro" : ""}</div></li>`}</ul>
      <div class="grp note">Fonte: ${esc(res.source)}${res.updated ? ` · aggiornato ${new Date(res.updated * 1000).toLocaleDateString("it-IT")}` : ""}${cat === "fuel" && res.prices ? ` · prezzi scaricati ${new Date(res.prices * 1000).toLocaleString("it-IT", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}; prezzo self, o servito se c'è solo quello` : ""}${cat === "cameras" ? " · solo autovelox fissi mappati" : ""}</div>`;
    body.querySelectorAll("[data-f]").forEach((c) => c.addEventListener("click", () => { this._fuelFilter = c.dataset.f; this._renderNearby(); }));
    body.querySelectorAll("[data-fk]").forEach((c) => c.addEventListener("click", () => { this._fuelKind = c.dataset.fk; this._renderNearby(); }));
    body.querySelectorAll("[data-o]").forEach((c) => c.addEventListener("click", () => { this._fuelSort = c.dataset.o; this._renderNearby(); }));
    body.querySelectorAll("[data-w]").forEach((c) => c.addEventListener("click", () => { this._nearWhere = c.dataset.w; this._openNearby("parking"); }));
    const shown = items.slice(0, 60);
    body.querySelectorAll("li[data-k]").forEach((li) => li.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      const it = shown[+li.dataset.k];
      if (this._nav) this._userMoved();
      this._map.setView([it.lat, it.lon], Math.max(this._map.getZoom(), 16));
      this.$("nearwrap").hidden = true; // i segnaposto restano sulla mappa
    }));
    body.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => this._nearGo(cat, shown[+b.dataset.go])));
    // segnaposto sulla mappa
    this._poiLayer.clearLayers();
    this._schedule3d();
    for (const it of shown) {
      const ic = cat === "fuel" ? "⛽" : cat === "parking" ? "🅿️" : "📷";
      const col = cat === "fuel" ? brandColor(it.brand) : cat === "parking" ? "#1565c0" : "#263238";
      L.marker([it.lat, it.lon], { icon: L.divIcon({ className: "", html: `<div class="pmark" style="background:${col}">${ic}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
        title: it.name || it.brand || "" }).addTo(this._poiLayer);
    }
  }

  // carburanti venduti dall'impianto, con il prezzo; in evidenza quello scelto nel filtro
  _fuelLine(it) {
    const fuels = (it.fuels || []).filter((f) => f.k !== "altro" || fuelPrice(f) != null);
    if (!fuels.length) return `<div class="fl"><span class="muted">Carburanti non comunicati</span></div>`;
    const kind = this._fuelShowKind;
    const parts = fuels.map((f) => {
      const p = fuelPrice(f);
      const txt = `${esc(f.n)}${p != null ? ` ${fmtPrice(p)}${f.s == null ? " serv." : ""}` : ""}`;
      return `<span class="fp${kind && fuelMatch(f, kind) ? " hi" : ""}">${txt}</span>`;
    });
    const t = Math.max(...fuels.map((f) => f.t || 0));
    const old = t && Date.now() / 1000 - t > 7 * 86400
      ? `<span class="old">prezzi del ${new Date(t * 1000).toLocaleDateString("it-IT")}</span>` : "";
    return `<div class="fl">${parts.join("")}${old}</div>`;
  }

  // ⛽ diventa una tappa prima dell'arrivo, 🅿️ diventa l'arrivo
  _nearGo(cat, it) {
    const pt = cat === "fuel"
      ? { name: `⛽ ${it.brand ? `${it.brand} ` : ""}${it.town || it.name || ""}`.trim(), address: [it.addr, it.town].filter(Boolean).join(", "), lat: it.lat, lon: it.lon }
      : { name: `🅿️ ${it.name || "Parcheggio"}`, address: "", lat: it.lat, lon: it.lon };
    this._closeNearby();
    if (this._nav) {
      const nav = this._nav;
      const here = nav.fix ? { name: "📍 Posizione attuale", address: "", lat: nav.fix.lat, lon: nav.fix.lon } : this._points[0];
      const rest = this._points.slice(1 + nav.passed);
      this._points = cat === "fuel" ? [here, pt, ...rest] : [here, ...rest.slice(0, -1), pt];
      nav.passed = 0;
      this._afterNavPointsChange(cat === "fuel" ? "Tappa aggiunta" : "Nuovo arrivo");
    } else {
      if (cat === "fuel") this._points.splice(this._points.length - 1, 0, pt);
      else this._points[this._points.length - 1] = pt;
      this._afterPointsChange();
    }
  }

  async _afterNavPointsChange(label) {
    const nav = this._nav;
    this._navPopup("ok", "↻", `${label}<br><b>Calcolo il percorso…</b>`, 0);
    try {
      await this._compute(false, true);
      if (!this._nav) return;
      Object.assign(nav, { idx: 0, offSince: null, offCount: 0 });
      if (nav.fix) { nav.snap = this._snap(this._geom(this._result.routes[0]), nav.fix, 0); nav.idx = nav.snap.idx; }
      this._saveState();
      this._renderPoints();
      this._drawMarkers();
      const sm = this._result.routes[0].summary;
      this._navPopup("ok", "✓", `${label}<br><b>${fmtTime(sm.time)} · ${fmtKm(sm.length_km)}</b>`, 3500);
    } catch (err) {
      this._navPopup("warn", "⚠", `Percorso non calcolato: ${esc(err.message || err)}`, 5000);
    }
    this._renderNav();
  }

  // autovelox fissi sul percorso: scaricati una volta per ogni percorso, poi avviso quando ti avvicini
  _cameraCheck(rt, along) {
    const nav = this._nav;
    nav.cam = null;
    if (!this._settings.camAlert || !(this._mode === "auto" || this._mode === "moto")) return;
    if (rt._cams === undefined) {
      rt._cams = null; // richiesta in corso
      const line = rt.shape.map((p) => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5]);
      const step = Math.ceil(line.length / 7500);
      this._hass.callWS({ type: "navigator/nearby", category: "cameras", radius: 35,
        line: step > 1 ? line.filter((_, k) => k % step === 0 || k === line.length - 1) : line })
        .then((r) => {
          rt._cams = r.items.map((it) => {
            const a = this._alongRoute(rt, it);
            const i = Math.min(a.idx, rt.shape.length - 2);
            const dir = parseFloat(it.direction);
            // autovelox orientato al contrario rispetto alla marcia: controlla l'altra carreggiata
            if (!Number.isNaN(dir) && i >= 0) {
              const diff = Math.abs(((bearing(rt.shape[i], rt.shape[i + 1]) - dir + 540) % 360) - 180);
              if (diff > 100) return null;
            }
            return { ...it, along: a.along };
          }).filter(Boolean).sort((x, y) => x.along - y.along);
        })
        .catch(() => { rt._cams = []; setTimeout(() => { if (rt._cams?.length === 0) rt._cams = undefined; }, 900000); });
      return;
    }
    if (!rt._cams) return;
    const next = rt._cams.find((c) => c.along > along - 10);
    if (!next) return;
    const to = next.along - along;
    const warn = (nav.speed || 0) > 25 ? 1000 : 600;
    if (to > warn) return;
    nav.cam = { to: Math.max(0, to), maxspeed: next.maxspeed, warn };
    nav.camsDone = nav.camsDone || new Set();
    if (!nav.camsDone.has(next.id) && to > 40) {
      nav.camsDone.add(next.id);
      const P = PHRASES[this._settings.lang];
      if (this._settings.voice) this._speak(`${P.camera(spokenDist(to, this._settings.lang))}${next.maxspeed ? `, ${P.limit(next.maxspeed)}` : ""}`, true);
      if (this._settings.beep) { this._beep(); setTimeout(() => this._beep(), 600); }
    }
  }

  // ----------------------------------------------------------------- barra delle indicazioni spostabile (solo in alto/basso)
  // Tieni premuta la barra verde per spostarla più in alto o più in basso sulla mappa; resta sempre a tutta larghezza.
  // L'altezza scelta resta per il tuo utente di Home Assistant (salvata come frazione, così vale a ogni dimensione dello schermo).
  // Trascinala fin quasi in cima per rimetterla al suo posto predefinito.

  // ----------------------------------------------------------------- riquadri spostabili (guida)
  // Croce e riquadro della velocità si spostano tenendoli premuti ~0,5 s e trascinandoli, come la barra verde.
  // Posizioni in frazioni della mappa (valgono anche su schermi di misure diverse). Sul telefono o nel browser restano
  // su quel dispositivo; sullo schermo dell'auto (Android Auto) si salvano in Home Assistant: uguali da qualunque telefono.

  async _loadLayout() {
    let lay = null;
    if (this._isCarScreen()) {
      try { lay = (await this._hass.callWS({ type: "navigator/layout", profile: "auto" })).data; } catch (e) { /* integrazione vecchia */ }
    } else {
      try { lay = JSON.parse(localStorage.getItem(`${STORE_KEY}-layout`) || "null"); } catch (e) { /* storage non disponibile */ }
    }
    this._layout = lay && typeof lay === "object" ? lay : {};
    this._applyNavTopPos(); this._placePitchCtl(); this._applyFloat("spdbox"); this._placeAddons();
  }

  _saveLayout() {
    const lay = this._layout || {};
    if (this._isCarScreen()) {
      this._hass.callWS({ type: "navigator/layout", profile: "auto", data: lay }).catch(() => { /* integrazione vecchia */ });
    } else {
      try { localStorage.setItem(`${STORE_KEY}-layout`, JSON.stringify(lay)); } catch (e) { /* storage non disponibile */ }
    }
  }

  // mette il riquadro dove l'ha lasciato l'utente (solo in guida); senza posizione salvata resta al posto predefinito
  _applyFloat(id, key = id) {
    const el = this.$(id);
    const wrap = this.$("mapwrap");
    if (!el || !wrap || el.hidden) return;
    const pos = this._layout?.[key];
    if (!pos) {
      if (id === "spdbox") { el.classList.remove("moved"); el.style.left = ""; el.style.top = this._floatDefTop(); }
      return;
    }
    el.classList.add("moved");
    const x = Math.max(4, Math.min(wrap.clientWidth - el.offsetWidth - 4, pos.x * wrap.clientWidth));
    const y = Math.max(4, Math.min(wrap.clientHeight - el.offsetHeight - 4, pos.y * wrap.clientHeight));
    el.style.left = `${x}px`; el.style.top = `${y}px`;
  }

  // posto predefinito del riquadro velocità: a sinistra, sotto la barra verde
  _floatDefTop() {
    // fuori dalla guida la croce sta in alto a sinistra (se non spostata): il riquadro va sotto, non sopra
    const pc = this.$("pitchctl");
    if (pc && !pc.hidden && !pc.classList.contains("moved") && pc.offsetLeft < 120) return `${pc.offsetTop + pc.offsetHeight + 8}px`;
    const top = this.$("navtop");
    return top && !top.hidden ? `${top.offsetTop + top.offsetHeight + 8}px` : "56px";
  }

  // sagoma al posto del riquadro trascinato: si muove con transform (niente ridisegno del riquadro vero)
  _ghostStart(el) {
    const wrap = this.$("mapwrap");
    const r = el.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    const g = document.createElement("div");
    g.className = "dragghost";
    Object.assign(g.style, { left: `${r.left - wr.left}px`, top: `${r.top - wr.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    wrap.appendChild(g);
    el.classList.add("dragging-src");
    return { g, x0: r.left - wr.left, y0: r.top - wr.top };
  }

  _ghostEnd(el, gh) {
    gh?.g?.remove();
    el.classList.remove("dragging-src");
  }

  _bindFloatDrag(id, key = id) {
    const el = this.$(id);
    const wrap = this.$("mapwrap");
    if (!el || !wrap) return;
    let timer = null, drag = false, sx = 0, sy = 0, ox = 0, oy = 0, gh = null, nx = 0, ny = 0;
    el.addEventListener("pointerdown", (e) => {
      if (e.button > 0) return;
      if (el.closest(".addock")) return; // nel blocco della guida non si sposta (si scorre)
      sx = e.clientX; sy = e.clientY; drag = false;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null; drag = true;
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* puntatore simulato */ }
        const r = el.getBoundingClientRect();
        ox = e.clientX - r.left; oy = e.clientY - r.top;
        gh = this._ghostStart(el);
        nx = gh.x0; ny = gh.y0;
        this._dragging = true;
        try { window.navigator.vibrate?.(20); } catch (err) { /* niente vibrazione */ }
      }, 450);
    });
    el.addEventListener("pointermove", (e) => {
      if (timer && !drag && Math.hypot(e.clientX - sx, e.clientY - sy) > 8) { clearTimeout(timer); timer = null; }
      if (!drag || !gh) return;
      e.preventDefault();
      const wr = wrap.getBoundingClientRect();
      nx = Math.max(4, Math.min(wrap.clientWidth - el.offsetWidth - 4, e.clientX - wr.left - ox));
      ny = Math.max(4, Math.min(wrap.clientHeight - el.offsetHeight - 4, e.clientY - wr.top - oy));
      gh.g.style.transform = `translate(${nx - gh.x0}px, ${ny - gh.y0}px)`;
    });
    const end = () => {
      clearTimeout(timer); timer = null;
      if (!drag) return;
      drag = false;
      // il riquadro vero ricompare (una volta sola) dove è stata lasciata la sagoma
      el.classList.add("moved");
      el.style.left = `${nx}px`; el.style.top = `${ny}px`;
      this._ghostEnd(el, gh); gh = null;
      this._dragging = false;
      this._longAt = Date.now();
      (this._layout ||= {})[key] = { x: (parseFloat(el.style.left) || 0) / wrap.clientWidth, y: (parseFloat(el.style.top) || 0) / wrap.clientHeight };
      this._saveLayout();
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  // velocità attuale (cifre LCD, "km/h" piccolo dopo): rossa e lampeggiante sopra il limite (come il beep); solo in guida
  // buffer della mappa: in guida carica (e salva sul telefono) i riquadri del percorso dei prossimi km, allo zoom in uso
  // (2D: zoom della mappa; 3D: sfondo allo zoom della vista e uno sotto, più il rilievo). Al più 3 alla volta, con calma.
  _tileAhead(rt, along) {
    const km = +(this._settings.tileAhead ?? 100);
    if (!km || window.navigator.onLine === false || this._aheadBusy) return;
    const now = Date.now();
    if (this._aheadAt && now - this._aheadAt < 20000 && Math.abs(along - (this._aheadAlong || 0)) < 1500) return;
    this._aheadAt = now; this._aheadAlong = along;
    const tpl = (LAYERS[this._effLayer(this._layer)] || LAYERS.strade)[1];
    const zs = this._3d && this._g3
      ? [Math.round(this._g3.getZoom()) + 1, Math.round(this._g3.getZoom())].map((z) => [tpl, Math.min(19, z)])
        .concat([[DEM_URL, Math.min(15, Math.max(10, Math.round(this._g3.getZoom()) - 2))]])
      : [[tpl, Math.min(19, Math.round(this._map.getZoom()))]];
    const ofm = ofmTemplateNow(); // edifici, nomi, punti di interesse e gallerie (z14, ~1,7 km per riquadro)
    if (ofm) zs.push([ofm, 14]);
    const g = this._geom(rt);
    const end = Math.min(g._cum[g._cum.length - 1], along + km * 1000);
    this._aheadDone ??= new Set();
    const urls = [];
    for (const [t, z] of zs) {
      const stepM = 40075000 * Math.cos((g.shape[0][0] * Math.PI) / 180) / 2 ** z / 2; // mezzo riquadro
      const near = z >= 15 ? 1 : 0; // da vicino anche i riquadri a fianco (la vista è più larga della strada)
      for (let a = along; a <= end; a += stepM) {
        const p = this._pointAt(g, a).ll;
        const [x, y] = tileXY(p[0], p[1], z);
        for (let dx = -near; dx <= near; dx++) for (let dy = -near; dy <= near; dy++) {
          const u = tileUrl(t, z, x + dx, y + dy);
          if (!this._aheadDone.has(u)) { this._aheadDone.add(u); urls.push(u); }
        }
      }
    }
    if (!urls.length) return;
    this._aheadBusy = true;
    let i = 0;
    const worker = async () => {
      while (i < urls.length && this._nav && window.navigator.onLine !== false) {
        const u = urls[i++];
        const hit = await tileGet(u);
        if (!hit) { await tileFetch(u); await new Promise((r) => setTimeout(r, 120)); } // con calma
      }
    };
    Promise.all([worker(), worker(), worker()]).finally(() => {
      this._aheadBusy = false;
      console.debug("[Navigator mappe] buffer:", urls.length, "riquadri del percorso");
    });
  }

  // connessione dati e collegamento con Home Assistant: icona verde/rossa nel riquadro della velocità
  _netWatch() {
    if (this._netT) return;
    const upd = () => {
      const conn = this._hass?.connection;
      const ok = window.navigator.onLine !== false && conn?.connected !== false;
      if (ok === this._netOk) return;
      this._netOk = ok;
      const el = this.$("spdnet");
      if (el) { el.classList.toggle("off", !ok); el.title = ok ? "Connesso: dati e Home Assistant" : "Senza connessione dati o Home Assistant non raggiungibile"; }
    };
    window.addEventListener("online", upd);
    window.addEventListener("offline", upd);
    // fonti del GPS: dall'app NaviHA (auto e telefono) o, nel browser, dalle posizioni ricevute
    const gps = () => {
      const now = Date.now();
      const nh = window.__navihaGps;
      const phoneAt = nh ? nh.phone : this._fixAt || 0;
      let carOn = false;
      try { carOn = !!(window.NaviHAApp?.isCar?.() || window.NaviHAApp?.carConnected?.()); } catch (e) { carOn = false; }
      const c = this.$("gpscar"), ph = this.$("gpsphone");
      if (c) { c.hidden = !carOn; c.classList.toggle("off", !(nh && now - nh.car < 5000)); }
      if (ph) {
        const idle = !!nh?.phoneOff; // spento dall'app perché arriva il GPS dell'auto: grigio, non è un guasto
        ph.classList.toggle("idle", idle);
        ph.classList.toggle("off", !idle && !(now - phoneAt < 5000));
        ph.title = idle ? "GPS del telefono in pausa: si usa quello dell'auto" : "GPS del telefono";
      }
    };
    this._netT = setInterval(() => { upd(); gps(); }, 1500);
    upd(); gps();
  }

  _spdBox(kmh, over, lim = null) {
    const el = this.$("spdbox");
    if (!el || this._dragging) return;
    // in guida e anche senza percorso (velocità dal GPS del telefono, limite della strada attuale)
    const show = kmh != null && (!this._nav || this._isGuida());
    if (el.hidden === show) { el.hidden = !show; if (show) { el.classList.toggle("big", this._isCarScreen()); this._applyFloat("spdbox"); } }
    if (!show) return;
    el.classList.toggle("over", over);
    const le = this.$("spdlim"); // in guida il cartello c'è già nella barra verde
    if (le) { const t = !this._nav && lim ? String(lim) : ""; le.hidden = !t; if (le.textContent !== t) le.textContent = t; }
    const v = String(Math.min(999, Math.max(0, kmh)));
    if (el.dataset.v !== v) { el.dataset.v = v; this.$("spdv").innerHTML = seg7Svg(v, 3); el.setAttribute("aria-label", `${v} km/h`); }
  }

  _navTopKey() {
    return `${STORE_KEY}-navtop-${this._hass?.user?.id || "def"}`;
  }

  // altezza memorizzata (frazione 0..1), con compatibilità col vecchio formato {x,y}
  _navTopY() {
    if (typeof this._layout?.navtop?.y === "number") return this._layout.navtop.y;
    try {
      const p = JSON.parse(localStorage.getItem(this._navTopKey()) || "null");
      if (p && typeof p.y === "number") return p.y;
    } catch (e) { /* storage non disponibile */ }
    return null;
  }

  // mette la barra all'altezza scelta dall'utente (larghezza sempre piena), tenendola dentro la mappa
  _applyNavTopPos() {
    const top = this.$("navtop");
    const wrap = this.$("mapwrap");
    if (!top || !wrap || top.hidden) return;
    const fy = this._navTopY();
    if (fy == null) { top.classList.remove("moved"); top.style.removeProperty("--nty"); return; }
    top.classList.add("moved");
    requestAnimationFrame(() => {
      const y = Math.max(4, Math.min(Math.max(4, wrap.clientHeight - top.offsetHeight - 4), fy * wrap.clientHeight));
      top.style.setProperty("--nty", `${y}px`);
    });
  }

  _bindNavTopDrag() {
    const top = this.$("navtop");
    const wrap = this.$("mapwrap");
    if (!top || !wrap) return;
    let timer = null, drag = false, sy = 0, oy = 0, gh = null, ny = 0;
    top.addEventListener("pointerdown", (e) => {
      if (e.button > 0 || top.hidden) return;
      sy = e.clientY; drag = false;
      clearTimeout(timer);
      timer = setTimeout(() => { // tieni premuto ~0,45 s: inizia lo spostamento (solo verticale)
        timer = null; drag = true;
        try { top.setPointerCapture(e.pointerId); } catch (err) { /* puntatore simulato */ }
        const r = top.getBoundingClientRect();
        oy = e.clientY - r.top;
        gh = this._ghostStart(top); // sagoma leggera al posto della barra
        ny = gh.y0;
        this._dragging = true;
        try { window.navigator.vibrate?.(20); } catch (err) { /* niente vibrazione */ }
      }, 450);
    });
    top.addEventListener("pointermove", (e) => {
      if (timer && !drag && Math.abs(e.clientY - sy) > 8) { clearTimeout(timer); timer = null; }
      if (!drag || !gh) return;
      e.preventDefault();
      const wr = wrap.getBoundingClientRect();
      ny = Math.max(4, Math.min(wrap.clientHeight - top.offsetHeight - 4, e.clientY - wr.top - oy));
      gh.g.style.transform = `translateY(${ny - gh.y0}px)`;
    });
    const end = () => {
      clearTimeout(timer); timer = null;
      if (!drag) return;
      drag = false;
      top.classList.add("moved");
      top.style.setProperty("--nty", `${ny}px`);
      this._ghostEnd(top, gh); gh = null;
      this._dragging = false;
      this._longAt = Date.now(); // evita che parta un clic sui bottoni subito dopo
      const y = ny;
      // rilasciata quasi in cima: torna al posto predefinito
      if (y < 24) {
        try { localStorage.removeItem(this._navTopKey()); } catch (err) { /* storage non disponibile */ }
        if (this._layout?.navtop) { delete this._layout.navtop; this._saveLayout(); }
        top.classList.remove("moved");
        top.style.removeProperty("--nty");
        this._msg("Indicazioni rimesse in alto");
        return;
      }
      try { localStorage.setItem(this._navTopKey(), JSON.stringify({ y: y / wrap.clientHeight })); } catch (err) { /* storage non disponibile */ }
      (this._layout ||= {}).navtop = { y: y / wrap.clientHeight };
      this._saveLayout();
      this._placePitchCtl(); this._applyFloat("spdbox");
    };
    top.addEventListener("pointerup", end);
    top.addEventListener("pointercancel", end);
  }

  // ----------------------------------------------------------------- impostazioni, voce e beep

  _saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this._settings)); } catch (e) { /* storage non disponibile */ }
  }

  // zittisce o riattiva SOLO la voce delle indicazioni di marcia; gli avvisi di velocità, autovelox e meteo restano
  _toggleMuteGuide() {
    this._settings.muteGuide = !this._settings.muteGuide;
    this._saveSettings();
    if (this._nav) this._renderNav();
    this._msg(this._settings.muteGuide ? "🔇 Voce delle indicazioni disattivata (gli avvisi restano)" : "🔊 Voce delle indicazioni attivata");
  }

  // servizi notify dell'app Companion (mobile_app_…): prima quello del telefono della propria persona
  _notifyServices() {
    const list = Object.keys(this._hass?.services?.notify || {}).filter((n) => n.startsWith("mobile_app_"));
    const me = this._myPerson();
    const src = me && this._hass.states[me.id]?.attributes.source;
    const mine = src && `mobile_app_${src.split(".")[1]}`;
    return list.sort((a, b) => (b === mine) - (a === mine));
  }

  // voce del browser: no nell'app Companion Android (la pagina non sa parlare), sì in NaviHA che fornisce
  // speechSynthesis con la sintesi vocale di Android
  _browserVoiceOk() {
    return !!window.speechSynthesis && (this._isNaviHA() || this._companion() !== "android");
  }

  // dove si sente la voce: browser (computer, iPhone) o app Companion (Android, la cui pagina non sa parlare)
  _voiceOut() {
    const sel = this._settings.out;
    const browserOk = this._browserVoiceOk();
    if (sel.startsWith("notify.")) return { kind: "notify", service: sel.slice(7) };
    if (sel === "browser") return { kind: browserOk ? "browser" : "none" };
    if (browserOk) return { kind: "browser" };
    const svc = this._notifyServices()[0];
    return svc ? { kind: "notify", service: svc } : { kind: "none" };
  }

  // velocità e tono della voce del browser, secondo lo stile scelto
  _voiceTone() {
    const s = this._settings;
    const st = VOICE_STYLES[s.voiceStyle] || VOICE_STYLES.normale;
    const rate = st[1] ?? Number(s.voiceRate);
    const pitch = st[2] ?? Number(s.voicePitch);
    return [Math.max(0.5, Math.min(2, rate || 1)), Math.max(0, Math.min(2, Number.isFinite(pitch) ? pitch : 1))];
  }

  _voices() {
    try { return (window.speechSynthesis?.getVoices() || []).filter((v) => (v.lang || "").toLowerCase().startsWith(this._settings.lang)); } catch (e) { return []; }
  }

  _pickVoice() {
    const vs = this._voices();
    const sel = this._settings.voiceSel;
    if (sel !== "f" && sel !== "m") {
      const v = vs.find((x) => x.voiceURI === sel);
      if (v) return v;
    }
    const g = sel === "m" ? "m" : "f";
    const same = vs.filter((v) => voiceGender(v.name) === g);
    return same.find((v) => v.localService) || same[0] || vs.find((v) => !voiceGender(v.name)) || vs[0] || null;
  }

  _speak(text, urgent = false, force = false) {
    if ((!this._settings.voice && !force) || !text) return;
    const out = this._voiceOut();
    if (out.kind === "notify") {
      this._hass.callService("notify", out.service, { message: "TTS", data: { tts_text: text } }).catch(() => { /* telefono non raggiungibile */ });
    } else if (out.kind === "browser") {
      try {
        const u = new SpeechSynthesisUtterance(text);
        const v = this._pickVoice();
        if (v) u.voice = v;
        u.lang = LANG_BCP[this._settings.lang];
        const [rate, pitch] = this._voiceTone();
        u.rate = rate;
        u.pitch = pitch;
        if (urgent) window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
      } catch (e) { /* sintesi vocale non disponibile */ }
    }
  }

  // il browser fa suonare l'audio solo dopo un tocco: si prepara quando premi Parti
  _unlockAudio() {
    try {
      const C = window.AudioContext || window.webkitAudioContext;
      if (C && !this._ac) this._ac = new C();
      this._ac?.resume?.();
      if (this._settings.voice && this._voiceOut().kind === "browser") window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
    } catch (e) { /* audio non disponibile */ }
  }

  // suono breve e morbido per i tocchi: sinusoide che scende appena di tono, attacco e coda dolci, volume basso
  _tick() {
    try {
      this._unlockAudio();
      const ac = this._ac;
      if (!ac) return;
      const t = ac.currentTime;
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(1050, t);
      o.frequency.exponentialRampToValueAtTime(820, t + 0.08);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.13, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
      o.connect(g).connect(ac.destination);
      o.start(t);
      o.stop(t + 0.13);
    } catch (e) { /* audio non disponibile */ }
  }

  _beep() {
    try {
      this._unlockAudio();
      const ac = this._ac;
      if (!ac) return;
      const t = ac.currentTime;
      for (const dt of [0, 0.22]) {
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.type = "sine";
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, t + dt);
        g.gain.exponentialRampToValueAtTime(0.5, t + dt + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.17);
        o.connect(g).connect(ac.destination);
        o.start(t + dt);
        o.stop(t + dt + 0.2);
      }
    } catch (e) { /* audio non disponibile */ }
  }

  // impostazioni a sezioni: a sinistra icona e nome della sezione, a destra le sue opzioni (i gruppi con quel titolo)
  _settingsSections(wrap) {
    const dlg = wrap.querySelector(".setdlg");
    if (!dlg) return;
    const SECTIONS = [
      ["generale", "⚙️", "Generale", ["Mappa", "Velocità", "Traffico"]], // ("Mappa senza rete" inizia con "Mappa")
      ["voce", "🔊", "Voce", ["Indicazioni vocali"]],
      ["3d", "🏔️", "3D", ["Vista 3D"]],
      ["garage", "🚗", "Garage", ["Garage"]],
      ["auto", "🏠", "Automazioni", ["Pulsanti all'arrivo"]],
      ["poi", "📍", "Punti di interesse", ["Punti di interesse", "Distributori"]],
      ["addon", "🧩", "Add-on", ["Add-on"]],
      ["debug", "🐞", "Debug", ["Debug"]],
    ];
    const groups = [...dlg.querySelectorAll(":scope > .grp")];
    const secOf = (g) => {
      if (g.classList.contains("note")) return "generale";
      const t = g.querySelector("h3")?.textContent || "";
      return (SECTIONS.find(([, , , titles]) => titles.some((x) => t.startsWith(x))) || SECTIONS[0])[0];
    };
    const used = SECTIONS.filter(([k]) => groups.some((g) => secOf(g) === k));
    if (!used.some(([k]) => k === this._setSec)) this._setSec = used[0]?.[0];
    const body = document.createElement("div");
    body.className = "setbody";
    const navEl = document.createElement("div");
    navEl.className = "setnav";
    navEl.innerHTML = used.map(([k, ico, name]) => `<button data-sec="${k}" class="${k === this._setSec ? "on" : ""}"><span class="ico">${ico}</span><span>${name}</span></button>`).join("");
    const content = document.createElement("div");
    content.className = "setcontent";
    for (const g of groups) { g.dataset.sec = secOf(g); g.hidden = g.dataset.sec !== this._setSec; content.appendChild(g); }
    body.append(navEl, content);
    dlg.appendChild(body);
    dlg.classList.add("sect");
    navEl.querySelectorAll("[data-sec]").forEach((b) => b.addEventListener("click", () => {
      this._setSec = b.dataset.sec;
      navEl.querySelectorAll("[data-sec]").forEach((x) => x.classList.toggle("on", x === b));
      for (const g of groups) g.hidden = g.dataset.sec !== this._setSec;
      content.scrollTop = 0;
    }));
  }

  _openSettings() {
    // garage condiviso: si rilegge, così non si sovrascrivono le modifiche fatte da un altro utente nel frattempo
    if (!this._garageFresh) {
      this._garageFresh = true;
      const before = JSON.stringify(this._garage || []);
      this._loadGarage().then(() => {
        if (JSON.stringify(this._garage || []) !== before && !this.$("setwrap").hidden) this._openSettings();
      }).finally(() => setTimeout(() => { this._garageFresh = false; }, 1500));
    }
    const s = this._settings;
    const wrap = this.$("setwrap");
    const sw = (key, label, note = "") => `<label class="line"><span>${label}${note ? `<div class="note">${note}</div>` : ""}</span>
      <span class="sw"><input type="checkbox" data-s="${key}" ${s[key] ? "checked" : ""}><i></i></span></label>`;
    const langs = Object.entries(LANG_NAMES).map(([k, n]) => `<option value="${k}" ${k === s.lang ? "selected" : ""}>${n}</option>`).join("");
    const voices = this._voices();
    const vopts = [`<option value="f" ${s.voiceSel === "f" ? "selected" : ""}>Donna</option>`,
      `<option value="m" ${s.voiceSel === "m" ? "selected" : ""}>Uomo</option>`,
      ...voices.map((v) => `<option value="${esc(v.voiceURI)}" ${s.voiceSel === v.voiceURI ? "selected" : ""}>${esc(v.name)}</option>`)].join("");
    const browserOk = this._browserVoiceOk();
    const outs = [`<option value="auto" ${s.out === "auto" ? "selected" : ""}>Automatico</option>`,
      `<option value="browser" ${s.out === "browser" ? "selected" : ""} ${browserOk ? "" : "disabled"}>Questo dispositivo (browser)${browserOk ? "" : " – non disponibile"}</option>`,
      ...this._notifyServices().map((n) => `<option value="notify.${n}" ${s.out === `notify.${n}` ? "selected" : ""}>App Companion: ${esc(n.slice(11).replace(/_/g, " "))}</option>`)].join("");
    const out = this._voiceOut();
    const outNote = out.kind === "notify"
      ? "La voce la legge il telefono con l'app Companion: lingua e voce (donna o uomo) sono quelle della sintesi vocale di Android (Impostazioni → Sistema → Lingue → Output sintesi vocale). Scrivi le indicazioni nella stessa lingua."
      : out.kind === "browser" ? (voices.length ? "" : "Il browser non ha voci per questa lingua: verrà usata quella predefinita.")
      : "Nessuna voce disponibile qui: nell'app Android serve il servizio notify dell'app Companion.";
    wrap.innerHTML = `<div class="setdlg" role="dialog" aria-label="Impostazioni">
      <div class="hd"><h2>⚙ Impostazioni</h2><button class="icon" data-s="close" title="Chiudi">✕</button></div>
      <div class="grp"><h3>Indicazioni vocali</h3>
        ${sw("voice", "Indicazioni vocali", "Avvisi in anticipo e al momento della manovra, ricalcolo e arrivo")}
        <label class="line"><span>Lingua delle indicazioni e della voce</span><select data-s="lang">${langs}</select></label>
        <label class="line"><span>Voce</span><select data-s="voiceSel" ${out.kind === "browser" ? "" : "disabled"}>${vopts}</select></label>
        <label class="line"><span>Stile della voce</span><select data-s="voiceStyle" ${out.kind === "browser" ? "" : "disabled"}>${
          Object.entries(VOICE_STYLES).map(([k, v]) => `<option value="${k}" ${s.voiceStyle === k ? "selected" : ""}>${esc(v[0])}</option>`).join("")}</select></label>
        ${s.voiceStyle === "pers" && out.kind === "browser" ? `
        <label class="line"><span>Velocità <b data-rv="voiceRate">${Number(s.voiceRate).toFixed(2)}×</b></span>
          <input type="range" data-r="voiceRate" min="0.6" max="1.5" step="0.05" value="${s.voiceRate}"></label>
        <label class="line"><span>Tono <b data-rv="voicePitch">${Number(s.voicePitch).toFixed(2)}</b></span>
          <input type="range" data-r="voicePitch" min="0.5" max="1.5" step="0.05" value="${s.voicePitch}"></label>` : ""}
        <label class="line"><span>Riproduci su</span><select data-s="out">${outs}</select></label>
        ${outNote ? `<div class="note">${outNote}</div>` : ""}
        ${out.kind === "notify" ? `<div class="note">Stile, velocità e tono valgono per la voce del browser: nell'app Android si regolano in Impostazioni di Android →
          Sintesi vocale (velocità e tono), e con il motore Google si possono scaricare altre voci italiane.</div>` : ""}
        <div class="row" style="margin-top:6px"><button data-s="testvoice">▶ Prova la voce</button></div>
      </div>
      <div class="grp"><h3>Mappa</h3>
        ${sw("clickSnd", "Suono alla pressione dei pulsanti", "Un \"tic\" leggero a ogni tasto premuto, anche sullo schermo dell'auto")}
        ${sw("autoZoom", "Zoom automatico in base alla velocità (mappa 2D)", "In guida: più vicino in città, più largo in autostrada. Dopo + o − resta il tuo zoom per 20 secondi")}
        ${sw("autoZoom3d", "Zoom automatico in base alla velocità (vista 3D)", "In guida la distanza dalla macchina cambia con la velocità, partendo da quella che hai scelto. Spento: la distanza resta sempre quella scelta")}
        <label class="line"><span>Modalità notte</span><select data-s="nightMode">${NIGHT_MODES.map(([v, n]) => `<option value="${v}" ${(s.nightMode || "auto") === v ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        ${sw("autoDest", "Proponi la destinazione quando parti senza percorso", "Dopo 400 m senza un percorso impostato: i preferiti e le mete dei viaggi in archivio verso cui stai andando")}
        ${sw("wxAlert", "Avvisi meteo in guida", "Pioggia, neve, gelo, vento o nebbia a meno di 10 km davanti (meteo lungo il percorso, Open-Meteo)")}
        ${sw("tunnelFx", "Animazione in galleria", "In guida, dentro le gallerie riconosciute (con la vista 3D attiva), al posto della mappa un tunnel stilizzato che scorre")}
      </div>
      <div class="grp"><h3>Vista 3D</h3>
        <div class="note">Tasto <b>3D</b> sulla mappa e nella barra della guida: mappa inclinata con il rilievo del terreno. Usa la grafica del
          telefono e scarica anche le quote del terreno: consuma più batteria e dati della mappa piatta.</div>
        <label class="line"><span>Rilievo</span><select data-s="terrainEx">${TERRAIN_EX.map(([v, n]) => `<option value="${v}" ${String(s.terrainEx) === v ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        ${sw("veh3d", "Veicolo in 3D", "Il tuo mezzo come modellino 3D (forma e colore del veicolo del garage); spento: il disegno piatto")}
        ${sw("b3d", "Edifici in 3D", "Da vicino, con l'altezza degli edifici dove è nota (OpenFreeMap, dati OpenStreetMap)")}
        ${s.b3d !== false ? `<label class="line"><span>Stile degli edifici</span><select data-s="bldStyle">${
          BLD_STYLES.map(([v, n]) => `<option value="${v}" ${(s.bldStyle || "colorati") === v ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>` : ""}
        ${sw("wx3d", "Pioggia, neve e nebbia in 3D", "Animazioni sulla vista 3D quando nella zona piove, nevica o c'è nebbia (adesso o prevista sul percorso). Spegnile se la guida rallenta")}
        ${sw("names3d", "Nomi dei paesi in 3D", "Il nome di città, paesi e frazioni a grandi lettere bianche in rilievo, sopra il paese e sempre girate verso di te")}
        ${sw("clouds3d", "Nuvole in 3D", "In cielo, a 1–2 km di quota, tante quante la nuvolosità prevista nella zona (Open-Meteo); grigie dove piove")}
      </div>
      <div class="grp"><h3>Mappa senza rete</h3>
        <div class="note">Le mappe caricate si tengono sul telefono: senza rete (gallerie, valli, montagna) restano visibili. In guida si
          caricano in anticipo quelle del percorso che stai per fare, allo zoom che stai usando (come il buffer di un video).</div>
        <label class="line"><span>Mappa in anticipo durante la guida</span><select data-s="tileAhead">${[0, 25, 50, 100, 200].map((k) =>
          `<option value="${k}" ${(+(s.tileAhead ?? 100)) === k ? "selected" : ""}>${k ? `${k} km` : "No"}</option>`).join("")}</select></label>
        <button data-tileclear>🗑 Svuota la memoria delle mappe</button>
      </div>
      <div class="grp"><h3>Velocità</h3>
        ${sw("camAlert", "Avviso autovelox fissi", "Cartello nella barra della guida e, con le indicazioni vocali o il beep attivi, avviso a 600 metri (da 1 km in autostrada)")}
        ${sw("beep", "Beep quando superi il limite", "Limiti da OpenStreetMap, per auto e moto; tolleranza di 3 km/h (5% sopra i 60)")}
        <div class="row" style="margin-top:6px"><button data-s="testbeep">▶ Prova il beep</button></div>
      </div>
      <div class="grp"><h3>Traffico</h3>
        <div class="note">Navigator non ha dati di traffico propri: i servizi liberi e senza chiave non li offrono. Puoi però mostrare il
          <b>tempo con traffico</b> da un sensore di Home Assistant (es. l'integrazione gratuita <i>Waze Travel Time</i>). Vale per il
          percorso fisso impostato in quel sensore (es. casa↔lavoro): se la destinazione è un'altra, il valore non corrisponde.</div>
        <label class="line"><span>Sensore tempo con traffico</span><select data-s="trafficSensor"><option value="">Nessuno</option>${
          Object.values(this._hass.states).filter((st) => {
            const [d] = st.entity_id.split(".");
            if (d !== "sensor") return false;
            const u = (st.attributes.unit_of_measurement || "").toLowerCase();
            return st.attributes.device_class === "duration" || ["min", "h", "s"].includes(u)
              || /travel|traffic|traffico|duration|tempo/i.test(st.entity_id);
          }).sort((a, b) => (a.attributes.friendly_name || a.entity_id).localeCompare(b.attributes.friendly_name || b.entity_id))
            .map((st) => `<option value="${esc(st.entity_id)}" ${s.trafficSensor === st.entity_id ? "selected" : ""}>${esc(st.attributes.friendly_name || st.entity_id)}</option>`).join("")}</select></label>
      </div>
      ${this._garageHtml()}
      <div class="grp"><h3>Pulsanti all'arrivo</h3>
        <div class="note">In guida, vicino alla destinazione (distanza qui sotto), tasti quadrati sulla mappa per azionare queste entità
          (solo acceso/spento: cancello, garage, luci…). Si spostano tenendoli premuti; "Visualizza" li mostra subito per provarli
          e metterli dove vuoi. Accesi, si illuminano come una lampadina dietro un vetro smerigliato.</div>
        ${(s.arrEntities || []).map((id) => { const ic = this._arrIcon(id); return `<div class="arrrow"><span class="arrico">${arrSvg(ic)}</span>
          <span class="nm">${esc(this._hass.states[id]?.attributes?.friendly_name || id)}</span>
          <select data-arricon="${esc(id)}" title="Icona del tasto">${Object.entries(ARR_SVG).map(([k, [n]]) => `<option value="${k}" ${k === ic ? "selected" : ""}>${n}</option>`).join("")}</select>
          <button class="icon" data-arrdel="${esc(id)}" title="Togli">✕</button></div>`; }).join("")}
        <div class="row" style="margin:6px 0"><select data-arradd style="flex:1"><option value="">＋ Aggiungi un'entità…</option>${
          Object.values(this._hass.states).filter((st) => ARR_PICK.includes(st.entity_id.split(".")[0]) && !(s.arrEntities || []).includes(st.entity_id))
            .sort((a, b) => (a.attributes.friendly_name || a.entity_id).localeCompare(b.attributes.friendly_name || b.entity_id))
            .map((st) => `<option value="${esc(st.entity_id)}">${ARR_ICONS[st.entity_id.split(".")[0]] || ""} ${esc(st.attributes.friendly_name || st.entity_id)}</option>`).join("")}</select></div>
        ${sw("arrHomeOnly", "Solo arrivando a Casa", "Spento: i tasti compaiono arrivando a qualsiasi destinazione")}
        <label class="line"><span>Compaiono a</span><select data-s="arrDist">${[200, 300, 500, 1000, 2000].map((m) =>
          `<option value="${m}" ${(+s.arrDist || 500) === m ? "selected" : ""}>${m < 1000 ? `${m} m` : `${m / 1000} km`} dall'arrivo</option>`).join("")}</select></label>
        ${(s.arrEntities || []).length ? '<button data-arrtest>👁 Visualizza i tasti sulla mappa</button>' : ""}
      </div>
      <div class="grp"><h3>Punti di interesse sulla mappa</h3>
        <div class="note">Da OpenStreetMap, visibili da vicino. In 3D l'edificio prende il colore della categoria e sopra fluttua l'icona.
          Tocca un punto per andarci.</div>
        <div class="chips">${Object.entries(POI_KINDS).map(([k, [n, ico]]) => `<span class="chip ${(s.poiKinds || []).includes(k) ? "on" : ""}" data-poi="${k}">${ico} ${esc(n)}</span>`).join("")}</div>
      </div>
      <div class="grp"><h3>Distributori: marche preferite</h3>
        <div class="note">Nell'elenco dei distributori il filtro "Preferite" mostra solo queste. Nessuna scelta = tutte.</div>
        <div class="chips">${FUEL_BRANDS.map((b) => `<span class="chip ${s.fuelBrands.includes(b) ? "on" : ""}" data-brand="${esc(b)}">${esc(b)}</span>`).join("")}</div>
      </div>
      <div class="grp"><h3>Distributori: il tuo carburante</h3>
        <div class="note">L'elenco dei distributori mostra solo quelli che lo vendono, con il prezzo in evidenza. "100 ottani" si basa sul nome
          del prodotto comunicato dal gestore; "Benzina speciale" comprende le benzine premium e le 100 ottani.</div>
        <div class="chips"><span class="chip ${s.fuelKind ? "" : "on"}" data-fkind="">Tutti</span>
          ${FUEL_KINDS.map(([k, n]) => `<span class="chip ${s.fuelKind === k ? "on" : ""}" data-fkind="${k}">${esc(n)}</span>`).join("")}</div>
      </div>
      ${this._addonsHtml()}
      ${this._debug ? `<div class="grp"><h3>Debug</h3>
        <div class="note">Prove per verificare i vari casi senza aspettare che succedano davvero.</div>
        <label class="line"><span>Prova animazione galleria<div class="note">I visitatori dipendono dalla data: Natale (5 dic → 4 gen),
          Halloween (11 ott → 10 nov), altrimenti pipistrelli</div></span><input type="date" data-dbgdate value="${new Date().toISOString().slice(0, 10)}"></label>
        <div class="row" style="gap:8px"><button data-dbg="tunnel">▶ Avvia prova galleria</button><button data-dbg="tunnelstop">■ Ferma</button></div>
      </div>` : ""}
      <div class="grp note">Le impostazioni valgono per questo dispositivo.</div>
    </div>`;
    wrap.hidden = false;
    this._settingsSections(wrap);
    wrap.onclick = (e) => { if (e.target === wrap) wrap.hidden = true; };
    wrap.querySelector('[data-s="close"]').addEventListener("click", () => { wrap.hidden = true; });
    wrap.querySelectorAll("input[data-s]").forEach((el) => el.addEventListener("change", () => {
      s[el.dataset.s] = el.checked;
      this._saveSettings();
      if (el.dataset.s === "veh3d") { this._me3d?.remove(); this._me3d = null; this._drawVeh3d(); this._drawMe3d(); this._schedule3d(); }
      if (el.dataset.s === "autoDest") { this._idleWatchSync(); if (!el.checked) this._autoDestHide(); }
      if (el.dataset.s === "clouds3d") { this._cloudKey = null; this._scheduleClouds(true); }
      if (el.dataset.s === "wx3d") { this._rainDrops = null; this._snowFlakes = null; this._scheduleCloudDraw?.(); }
      if (el.dataset.s === "names3d") { this._apply3dSettings(); this._g3?.triggerRepaint(); }
      if (el.dataset.s === "b3d") { this._apply3dSettings(); this._openSettings(); } // compare o sparisce lo stile degli edifici
      if (el.dataset.s === "autoZoom3d") { this._g3key = null; this._sync3d(); }
      if (el.dataset.s === "voice" && el.checked) this._unlockAudio();
    }));
    wrap.querySelectorAll("select[data-s]").forEach((el) => el.addEventListener("change", () => {
      const k = el.dataset.s;
      if (k === "voiceStyle" && el.value === "pers") [s.voiceRate, s.voicePitch] = this._voiceTone(); // si parte dallo stile di prima
      s[k] = el.value;
      if (k === "lang") s.voiceSel = s.voiceSel === "m" ? "m" : "f"; // le voci cambiano con la lingua
      this._saveSettings();
      if (k === "voiceStyle") { this._unlockAudio(); this._speak(PHRASES[s.lang].test, true, true); }
      if (k === "terrainEx" || k === "bldStyle") this._apply3dSettings();
      if (k === "nightMode") { delete s.nightOverride; this._saveSettings(); this._applyNight(); this._syncNightBtn(); }
      if (k === "lang" && this._result && !this._nav) this._compute(false); // indicazioni nella nuova lingua
      this._openSettings();
    }));
    wrap.querySelectorAll("input[data-r]").forEach((el) => el.addEventListener("input", () => {
      s[el.dataset.r] = Number(el.value);
      const lab = wrap.querySelector(`[data-rv="${el.dataset.r}"]`);
      if (lab) lab.textContent = el.dataset.r === "voiceRate" ? `${Number(el.value).toFixed(2)}×` : Number(el.value).toFixed(2);
      this._saveSettings();
    }));
    wrap.querySelectorAll("input[data-r]").forEach((el) => el.addEventListener("change", () => this._speak(PHRASES[s.lang].test, true, true)));
    wrap.querySelector('[data-s="testvoice"]').addEventListener("click", () => {
      this._unlockAudio();
      if (this._voiceOut().kind === "none") { this._msg("Nessuna voce disponibile su questo dispositivo"); return; }
      this._speak(PHRASES[s.lang].test, true, true);
    });
    wrap.querySelector('[data-s="testbeep"]').addEventListener("click", () => this._beep());
    this._bindGarage(wrap);
    wrap.querySelector("[data-arradd]")?.addEventListener("change", (e) => {
      if (!e.target.value) return;
      s.arrEntities = [...(s.arrEntities || []), e.target.value];
      this._saveSettings();
      this._openSettings();
    });
    wrap.querySelector('[data-dbg="tunnel"]')?.addEventListener("click", () => {
      const d = wrap.querySelector("[data-dbgdate]")?.value;
      wrap.hidden = true; // si chiudono le impostazioni: la prova si vede sulla mappa
      this._debugTunnel(d);
    });
    wrap.querySelector('[data-dbg="tunnelstop"]')?.addEventListener("click", () => this._debugTunnel(null));
    this._bindAddonSettings(wrap);
    wrap.querySelector("[data-tileclear]")?.addEventListener("click", async () => {
      await tileClear();
      this._aheadDone = new Set();
      this._msg("Memoria delle mappe svuotata");
    });
    wrap.querySelector("[data-arrtest]")?.addEventListener("click", () => {
      this._arrTest = true; // prova: tasti visibili subito, da provare e spostare
      this.$("setwrap").hidden = true; // si chiudono le impostazioni: i tasti compaiono sulla mappa
      this._arrivalButtons();
      this._msg("Tieni premuto un tasto per spostarlo, toccalo per provarlo");
    });
    wrap.querySelectorAll("[data-arricon]").forEach((el) => el.addEventListener("change", () => {
      s.arrIcons = { ...(s.arrIcons || {}), [el.dataset.arricon]: el.value };
      this._saveSettings();
      const bx = this.$("arrbox"); if (bx) bx.dataset.k = ""; // tasti ridisegnati con l'icona nuova
      this._arrivalButtons();
      this._openSettings();
    }));
    wrap.querySelectorAll("[data-arrdel]").forEach((el) => el.addEventListener("click", () => {
      s.arrEntities = (s.arrEntities || []).filter((x) => x !== el.dataset.arrdel);
      this._saveSettings();
      this._openSettings();
    }));
    wrap.querySelectorAll("[data-poi]").forEach((el) => el.addEventListener("click", () => {
      const k = el.dataset.poi;
      const cur = s.poiKinds || [];
      s.poiKinds = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
      this._saveSettings();
      el.classList.toggle("on");
      this._poiKey = null;
      this._loadPois();
    }));
    wrap.querySelectorAll("[data-brand]").forEach((el) => el.addEventListener("click", () => {
      const b = el.dataset.brand;
      s.fuelBrands = s.fuelBrands.includes(b) ? s.fuelBrands.filter((x) => x !== b) : [...s.fuelBrands, b];
      this._saveSettings();
      el.classList.toggle("on");
    }));
    wrap.querySelectorAll("[data-fkind]").forEach((el) => el.addEventListener("click", () => {
      s.fuelKind = el.dataset.fkind;
      this._fuelKind = undefined; // nell'elenco vale di nuovo la preferenza
      this._saveSettings();
      wrap.querySelectorAll("[data-fkind]").forEach((x) => x.classList.toggle("on", x === el));
    }));
  }

  _navPopup(kind, big, html, ms) {
    const el = this.$("navpop");
    clearTimeout(this._nav?.popTimer);
    el.className = `navpop ${kind}`;
    el.innerHTML = `<div class="big">${big}</div><div>${html}</div>`;
    el.hidden = false;
    if (ms && this._nav) this._nav.popTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // manovra in corso: l'ultima iniziata prima del punto raggiunto
  _curManeuver(rt) {
    const ms = rt.maneuvers;
    let k = 0;
    while (k + 1 < ms.length && ms[k + 1].begin <= this._nav.idx) k++;
    return k;
  }

  _renderNav() {
    const nav = this._nav;
    if (!nav) return;
    const top = this.$("navtop");
    const bot = this.$("navbot");
    top.hidden = bot.hidden = false;
    this._tunnelFx();
    requestAnimationFrame(() => this._placePitchCtl(this._nav?.follow && this._isGuida() ? this._pitch3d() : undefined));
    const rt = this._geom(this._result.routes[this._sel]);
    const total = rt._cum[rt._cum.length - 1];
    const ms = rt.maneuvers;
    const k = this._curManeuver(rt);
    const along = nav.snap?.along ?? 0;
    if (!nav.fix) {
      top.className = "navtop wait";
      top.innerHTML = `<span class="ic"><span class="loading"></span></span><div class="t">In attesa della posizione…</div>`;
    } else if (nav.arrived) {
      top.className = "navtop";
      top.innerHTML = `<span class="ic">🏁</span><div class="t">Sei arrivato a destinazione</div>`;
    } else if (nav.offSince != null) {
      top.className = "navtop wait";
      top.innerHTML = `<span class="ic">↻</span><div class="t">${nav.rerouting ? "Ricalcolo del percorso…" : "Fuori dal percorso: se non torni sulla strada evidenziata ricalcolo tra pochi secondi"}</div>`;
    } else {
      const next = ms[k + 1] || ms[k];
      const toNext = Math.max(0, rt._cum[next.begin] - along);
      top.className = "navtop";
      // corsie da tenere (dove sono mappate), entro 2 km dalla manovra
      const lanes = next.lanes && toNext < 2000
        ? `<div class="lanes" title="Corsie: quelle chiare sono quelle da tenere">${next.lanes.map((l) => `<span class="ln ${l.v ? "on" : ""}">${laneSvg(l.d)}</span>`).join("")}</div>` : "";
      top.innerHTML = `<span class="ic">${maneuverIcon(next)}</span><div class="nmain"><span class="d">${toNext < 15 ? "Ora" : fmtDist(toNext)}</span><span class="t">${esc(next.text)}</span>${lanes}</div>`;
    }
    // a destra della barra: il cartello del limite di velocità e il tasto per zittire SOLO la voce delle indicazioni
    let right = "";
    if (nav.limit) right += `<span class="lim" title="Limite di velocità">${nav.limit}</span>`;
    if (this._settings.voice) {
      const muted = !!this._settings.muteGuide;
      right += `<button class="navmute" data-a="mute"
        title="${muted ? "Voce indicazioni disattivata — tocca per riattivarla (gli avvisi restano)" : "Zittisci la voce delle indicazioni (gli avvisi restano)"}">${muted ? "🔇" : "🔊"}</button>`;
    }
    if (right) top.insertAdjacentHTML("beforeend", `<div class="navright">${right}</div>`);
    // autovelox: striscia sotto l'indicazione (la svolta resta sempre visibile), distanza che scende fino a 0
    if (nav.cam && nav.fix && !nav.arrived) {
      const c = nav.cam;
      const pct = Math.max(0, Math.min(100, (c.to / (c.warn || 1000)) * 100));
      top.insertAdjacentHTML("beforeend", `<div class="camrow"><span class="cico">📷</span><span class="ctx">Autovelox</span>
        ${c.maxspeed ? `<span class="clim">${c.maxspeed}</span>` : ""}<span class="cd">${c.to < 15 ? "ora" : fmtDist(c.to)}</span>
        <span class="cbar"><i style="width:${pct.toFixed(0)}%"></i></span></div>`);
    }
    // tempo e distanza rimanenti
    let remTime = rt.summary.time;
    let remM = total;
    if (nav.fix && nav.snap && nav.offSince == null) {
      remM = Math.max(0, total - along);
      const cur = ms[k];
      const len = rt._cum[cur.end] - rt._cum[cur.begin];
      remTime = (len > 0 ? cur.time * Math.max(0, rt._cum[cur.end] - along) / len : 0) + ms.slice(k + 1).reduce((a, m) => a + m.time, 0);
    }
    if (!bot.querySelector(".info")) this._buildNavBar();
    this._liveSend(remTime, remM);
    this._arrivalButtons();
    this._wxAhead(along);
    const kmh = nav.speed != null && nav.fix ? Math.round(nav.speed * 3.6) : null;
    this._spdBox(kmh, !!nav.over); // rosso con la stessa soglia del beep (3 km/h, 5% sopra i 60)
    const modeIco = (MODES.find((m) => m[0] === this._mode) || MODES[0])[1];
    this._navClock(remTime);
    bot.querySelector(".info").innerHTML = `<span title="Mezzo del percorso">${modeIco}</span><span class="rem">${fmtTime(remTime)}</span><span>${fmtKm(remM / 1000)} · arrivo ${arrival(remTime)}</span>
`;
    const c = bot.querySelector('[data-n="center"]');
    c.classList.toggle("attn", !nav.follow);
    c.title = nav.follow ? "La mappa segue la tua posizione" : "Torna sulla tua posizione";
    this._applyNavTopPos(); // dopo i cambi di className: rimette il pannello dove l'utente l'ha spostato
  }

  // barra in basso della guida: tempi e, sotto, zoom, centra, tipo di mappa ed Esci
  _buildNavBar() {
    const bot = this.$("navbot");
    bot.innerHTML = `<div class="arr" hidden></div><div class="info"></div>
      <div class="tools">
        <button data-n="center" title="Centra sulla tua posizione">◎</button>
        <button data-n="near" title="Distributori, parcheggi e autovelox">🔎</button>
        <button data-n="3d" class="b3d" title="Vista 3D con rilievo ed edifici">3D</button>
        <button data-n="layer" class="layerbtn" title="Cambia tipo di mappa"><svg viewBox="0 0 24 24"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12.5l9 5 9-5"/><path d="M3 16.5l9 5 9-5"/></svg></button>
        <button class="stop" data-n="stop" title="Ferma la navigazione">■ Ferma</button>
      </div>`;
    bot.querySelector('[data-n="center"]').addEventListener("click", () => this._recenter());
    bot.querySelector('[data-n="layer"]').addEventListener("click", () => this._cycleLayer());
    bot.querySelector('[data-n="near"]').addEventListener("click", () => this._openNearby(this._nearCat || "fuel"));
    bot.querySelector('[data-n="stop"]').addEventListener("click", () => this._stopNav());
    bot.querySelector('[data-n="3d"]').addEventListener("click", () => this._toggle3d());
    this._sync3dBtns();
  }

  // zoom con i tasti −/+ del comando a croce: in 3D (vista che segue) cambia la distanza memorizzata, altrimenti lo zoom
  _zoomStep(d) {
    if (this._3d && this._nav?.follow && this._isGuida()) {
      this._setZoom3dOff(this._zoom3dOff() + d * 0.5);
      this._g3key = null;
      this._sync3d();
      return;
    }
    if (this._3d && this._g3) { if (d > 0) this._g3.zoomIn(); else this._g3.zoomOut(); this._afterZoom(); return; }
    if (d > 0) this._map.zoomIn(); else this._map.zoomOut();
    this._afterZoom();
  }

  // un solo pulsante che cicla i tipi di mappa (niente più elenco a tendina)
  _cycleLayer() {
    const keys = Object.keys(LAYERS);
    const next = keys[(keys.indexOf(this._layer) + 1) % keys.length];
    this._setLayer(next);
    const sel = this.$("layer"); if (sel) sel.value = next;
    for (const btn of [this.$("navbot")?.querySelector('[data-n="layer"]'), this.$("layerbox")]) {
      if (btn) btn.title = `Mappa: ${LAYERS[next][0]} (tocca per cambiare)`;
    }
    if (this.$("gattr")) this.$("gattr").innerHTML = LAYERS[next][3];
    this._msg(LAYERS[next][0]);
    this._saveState();
  }

  // ----------------------------------------------------------------- calcolo del percorso

  async _compute(fit = true, reroute = false) {
    if (!this._points.every((p) => p)) { this._msg("Inserisci partenza e destinazione"); return; }
    const my = ++this._reqId;
    const btn = this.$("go");
    btn.disabled = true;
    btn.innerHTML = `<span class="loading"></span> Calcolo…`;
    this._error = null;
    try {
      const r = await this._hass.callWS({
        type: "navigator/route",
        points: this._points.map((p, i) => ({ lat: p.lat, lon: p.lon, name: p.name, address: p.address || "",
          ...(reroute && i === 0 && Number.isFinite(p.heading) ? { heading: ((p.heading % 360) + 360) % 360 } : {}) })),
        mode: this._mode,
        avoid_tolls: this._avoid.tolls,
        avoid_highways: this._avoid.highways,
        avoid_ferries: this._avoid.ferries,
        exclude: [...this._excluded.flatMap((e) => e.points), ...(this._blocked || [])].slice(0, 40),
        alternatives: !reroute && !this._nav,
        language: this._settings.lang,
      });
      if (my !== this._reqId) return;
      this._result = r;
      this._sel = 0;
      if (this._info && r.recent) this._info.recent = r.recent;
      this._drawRoute();
      this._loadWeather();
      if (fit) this._fit();
    } catch (err) {
      if (my !== this._reqId) return;
      if (reroute) throw err;
      this._result = null;
      this._error = err.message || String(err);
      this._drawRoute();
    } finally {
      if (my === this._reqId) { btn.disabled = false; btn.textContent = "Calcola percorso"; }
    }
    this._renderResults();
    if (!reroute && !this._nav && this._result) this._checkRoadworks();
  }

  // lavori e strade chiuse lungo il percorso: marcatori sulla mappa e, se una chiusura è proprio sul percorso, ricalcolo intorno
  async _checkRoadworks() {
    const r = this._result;
    if (!r) return;
    const rt = this._geom(r.routes[this._sel]);
    const line = rt.shape.map((p) => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5]);
    const step = Math.ceil(line.length / 7000);
    let items = [];
    try {
      const res = await this._hass.callWS({ type: "navigator/nearby", category: "roadworks", radius: 30,
        line: step > 1 ? line.filter((_, k) => k % step === 0 || k === line.length - 1) : line });
      items = res.items || [];
    } catch (e) { return; } // Overpass non risponde: si lascia il percorso com'è
    if (this._result !== r || this._nav) return;
    this._roadworks = items;
    this._drawRoadworks();
    // solo segnalazione, niente ricalcolo: Valhalla usa già gli stessi dati di OpenStreetMap e non fa passare su strade
    // in costruzione o chiuse. Prima si escludeva il punto di una strada chiusa VICINA al percorso: l'esclusione finiva
    // sulla strada giusta e il percorso diventava assurdo ("lavori" che non c'erano)
    this._blocked = [];
    this._renderResults();
  }

  // tocco su lavori/strada chiusa: cosa dice OpenStreetMap, dove si trova (indirizzo e km del percorso) e il link per
  // controllarlo (o correggerlo, se non c'è più) direttamente su openstreetmap.org
  async _roadworkPopup(it) {
    const [ico, label] = it.kind === "lavori" ? ["🚧", "Lavori in corso"] : ["⛔", "Strada chiusa al traffico"];
    const inf = it.info || {};
    const NAMES = { construction: "Tipo di strada in costruzione", ref: "Strada", opening_date: "Apertura prevista",
      start_date: "Inizio", "construction:start_date": "Inizio lavori", check_date: "Ultima verifica su OSM", note: "Nota",
      description: "Descrizione", fixme: "Da verificare" };
    const rows = Object.entries(NAMES).filter(([k]) => inf[k]).map(([k, n]) => `<div><span class="muted">${n}:</span> ${esc(inf[k])}</div>`);
    const lim = [inf.access && `accesso ${inf.access}`, inf.motor_vehicle && `veicoli a motore ${inf.motor_vehicle}`,
      inf.motorcar && `auto ${inf.motorcar}`].filter(Boolean);
    if (lim.length) rows.push(`<div><span class="muted">Divieto:</span> ${esc(lim.join(", ").replace(/\bno\b/g, "vietato"))}</div>`);
    // km dall'inizio del percorso (vertice più vicino) e distanza dalla linea
    let where = "";
    const rt = this._result?.routes?.[this._sel];
    if (rt) {
      const g = this._geom(rt);
      let best = 0, bd = Infinity;
      g.shape.forEach((p, k) => { const d = distM(p, [it.lat, it.lon]); if (d < bd) { bd = d; best = k; } });
      where = `km ${(g._cum[best] / 1000).toFixed(1).replace(".", ",")} del percorso · a ${Math.round(it.off ?? bd)} m dalla strada che fai`;
    }
    const m = /^([nwr])(\d+)$/.exec(it.id || "");
    const type = m ? { n: "node", w: "way", r: "relation" }[m[1]] : null;
    const el = document.createElement("div");
    el.className = "popup rwpop";
    el.innerHTML = `<div class="n">${ico} ${label}${it.name ? ` · ${esc(it.name)}` : ""}</div>
      <div class="a addr">Cerco dove si trova…</div>${where ? `<div class="a">${where}</div>` : ""}
      <div class="rwinfo">${rows.join("") || '<div class="muted">Nessun dettaglio (date, note) su OpenStreetMap.</div>'}</div>
      ${type ? `<div class="rwlinks"><a href="https://www.openstreetmap.org/${type}/${m[2]}" target="_blank" rel="noopener">Verifica su OpenStreetMap</a>
        · <a href="https://www.openstreetmap.org/edit?${type}=${m[2]}" target="_blank" rel="noopener">Non c'è più? Correggi</a></div>` : ""}
      <div class="muted" style="font-size:11px;margin-top:4px">Dati OpenStreetMap: possono non essere aggiornati. Il percorso non viene deviato.</div>`;
    L.popup({ maxWidth: 300 }).setLatLng([it.lat, it.lon]).setContent(el).openOn(this._map);
    try {
      const r = await this._hass.callWS({ type: "navigator/reverse", lat: it.lat, lon: it.lon });
      el.querySelector(".addr").textContent = [r.name, r.address].filter(Boolean).join(", ");
    } catch (e) { el.querySelector(".addr").textContent = `${it.lat.toFixed(5)}, ${it.lon.toFixed(5)}`; }
  }

  _drawRoadworks() {
    const lay = this._rwLayer;
    if (!lay) return;
    lay.clearLayers();
    if (this._nav && !this._isGuida()) return;
    for (const it of this._roadworks || []) {
      const [ico, label] = it.kind === "lavori" ? ["🚧", "Lavori in corso"] : ["⛔", "Strada chiusa"];
      L.marker([it.lat, it.lon], { title: `${label}${it.name ? ` · ${it.name}` : ""}`, zIndexOffset: 800,
        icon: L.divIcon({ className: "", html: `<div class="rwm">${ico}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) })
        .on("click", () => this._roadworkPopup(it)).addTo(lay);
    }
    this._schedule3d();
  }

  _drawRoute() {
    this._rwLayer?.clearLayers();
    if (this._roadworks?.length && (!this._nav || this._isGuida())) this._drawRoadworks();

    this._routeLayer.clearLayers();
    this._schedule3d();
    this._scheduleArrows();
    const r = this._result;
    if (!r) return;
    // alternative (sotto, grigie e cliccabili), poi il percorso scelto
    r.routes.forEach((rt, i) => {
      if (i === this._sel || this._nav) return;
      const line = L.polyline(rt.shape, { color: "#78909c", weight: 6, opacity: 0.7 }).addTo(this._routeLayer);
      line.bindTooltip(`${fmtTime(rt.summary.time)} · ${fmtKm(rt.summary.length_km)}`, { sticky: true });
      line.on("click", (ev) => { L.DomEvent.stopPropagation(ev); this._select(i); });
    });
    const rt = this._geom(r.routes[this._sel]);
    const color = ROUTE_COLORS[this._sel % ROUTE_COLORS.length];
    // in guida la parte già percorsa è grigia e chiara, senza frecce; davanti resta del colore del percorso
    const total = rt._cum[rt._cum.length - 1];
    const done = this._nav?.fix && this._nav.snap ? Math.max(0, Math.min(total, this._nav.snap.along || 0)) : 0;
    const ahead = done > 0 ? this._sliceAlong(rt, done, total) : rt.shape;
    if (done > 0) {
      L.polyline(this._sliceAlong(rt, 0, done), { color: "#90a4ae", weight: 6, opacity: 0.55, interactive: false }).addTo(this._routeLayer);
    }
    L.polyline(ahead, { color: "#fff", weight: 13, opacity: 0.9, interactive: false }).addTo(this._routeLayer);
    L.polyline(ahead, { color, weight: 9, opacity: 1, interactive: false, arrows: true }).addTo(this._routeLayer);
    // tratti da un indice all'altro del percorso, solo per la parte ancora da fare
    const part = (i0, i1) => {
      const a = Math.max(done, rt._cum[i0]);
      const b = rt._cum[Math.min(i1, rt._cum.length - 1)];
      return b > a ? this._sliceAlong(rt, a, b) : null;
    };
    // gallerie: grigio a trattini, la strada passa sotto la collina (in 3D la linea segue comunque il terreno)
    for (const [ta, b] of this._tunnelRanges(rt)) {
      if (b <= done) continue;
      const a = Math.max(ta, done);
      const pts = this._sliceAlong(rt, a, b);
      L.polyline(pts, { color: "#cfd8dc", weight: 7, opacity: 1, interactive: false }).addTo(this._routeLayer);
      L.polyline(pts, { color: "#37474f", weight: 7, opacity: 1, dashArray: "8 8", interactive: false })
        .bindTooltip(`🚇 Galleria · ${fmtDist(b - a)}`, { sticky: true }).addTo(this._routeLayer);
    }
    for (const seg of rt.toll_segments) {
      const pts = part(seg.begin, seg.end);
      if (!pts) continue;
      L.polyline(pts, { color: "#f57c00", weight: 6, opacity: 1 })
        .bindTooltip(`💶 ${seg.name} · ${fmtKm(seg.length_km)} a pagamento`, { sticky: true })
        .addTo(this._routeLayer);
    }
    for (const m of rt.maneuvers) {
      const pts = m.ferry ? part(m.begin, m.end) : null;
      if (pts) L.polyline(pts, { color: "#0288d1", weight: 5, dashArray: "8 8" }).addTo(this._routeLayer);
    }
  }

  // guida: il percorso si ridisegna ogni 15 m di strada fatta (parte percorsa grigia)
  _routeProgress() {
    const nav = this._nav;
    const a = nav?.snap?.along;
    if (a == null) return;
    if (nav.drawnAlong == null || Math.abs(a - nav.drawnAlong) >= 15) {
      nav.drawnAlong = a;
      this._drawRoute();
    }
  }

  // ----------------------------------------------------------------- sensori di Home Assistant (arrivo, tempo, distanza)

  // stato della guida per i sensori dell'utente collegato: a ogni cambio di minuto, o almeno ogni 30 secondi
  _liveSend(remTime, remM) {
    const nav = this._nav;
    if (!nav || !this._hass) return;
    const min = Math.round(remTime / 60);
    const now = Date.now();
    if (nav.liveMin === min && nav.liveArr === !!nav.arrived && now - (nav.liveAt || 0) < 10000) return; // Live: ogni ~10 s
    Object.assign(nav, { liveMin: min, liveArr: !!nav.arrived, liveAt: now });
    const dest = this._points[this._points.length - 1] || {};
    this._hass.callWS({ type: "navigator/live", active: true, eta: (now + remTime * 1000) / 1000, minutes: min,
      km: Math.round(remM / 100) / 10, dest: dest.name || "", address: dest.address || "", mode: this._mode,
      lat: dest.lat, lon: dest.lon, arrived: !!nav.arrived,
      ...(nav.fix && !nav.fix.est ? { plat: nav.fix.lat, plon: nav.fix.lon } : {}),
      ...(nav.dir != null ? { dir: nav.dir } : {}),
      ...(typeof nav.fix?.speed === "number" && nav.fix.speed >= 0 ? { speed: nav.fix.speed * 3.6 } : {}),
      from: this._tripFrom || "", trip_id: nav.trip?.id || "",
      vehicle: this._tripVehicle && this._tripVehicle.id !== "base" ? { name: this._tripVehicle.name || "", plate: this._tripVehicle.plate || "", type: this._tripVehicle.type || "",
        icon: this._tripVehicle.icon || "", color: this._tripVehicle.color || "" } : {},
    }).catch(() => {
      // integrazione vecchia (senza i campi della scheda Live): si manda lo stato di base
      this._hass.callWS({ type: "navigator/live", active: true, eta: (now + remTime * 1000) / 1000, minutes: min,
        km: Math.round(remM / 100) / 10, dest: dest.name || "", address: dest.address || "", mode: this._mode,
        lat: dest.lat, lon: dest.lon, arrived: !!nav.arrived }).catch(() => { /* versione dell'integrazione vecchia */ });
    });
  }

  // ----------------------------------------------------------------- pulsanti all'arrivo
  // entità scelte in ⚙ (cancello, garage, serratura, luci…): grandi tasti nella barra della guida a meno di 500 m dall'arrivo

  _arrivalButtons() {
    const box = this.$("arrbox");
    const wrap = this.$("mapwrap");
    if (!box || !wrap) return;
    const old = this.$("navbot")?.querySelector(".arr"); // la vecchia fila nella barra in basso non si usa più
    if (old) old.hidden = true;
    const nav = this._nav;
    const s = this._settings;
    const keep = !nav && this._arrKeep && Date.now() < this._arrKeep.until ? this._arrKeep : null; // dopo il Ferma automatico
    const dest = keep ? keep.dest : this._points[this._points.length - 1];
    const ids = (s.arrEntities || []).filter((id) => this._hass.states[id]);
    let near = !!(ids.length && dest) && (keep ? true : !!nav?.fix && distM([nav.fix.lat, nav.fix.lon], [dest.lat, dest.lon]) < (+s.arrDist || 500));
    if (near && s.arrHomeOnly) {
      const h = this._homePoint();
      near = distM([dest.lat, dest.lon], [h.lat, h.lon]) < 250;
    }
    // "Nascondi": restano nascosti finché non si arriva di nuovo vicino (dopo essersi allontanati)
    if (!near) this._arrHidden = false;
    const show = ids.length && ((near && !this._arrHidden) || this._arrTest);
    const key = show ? `${ids.join(",")}|${this._arrTest ? 1 : 0}|${ids.map((id) => this._hass.states[id]?.state).join(",")}` : "";
    if (box.dataset.k === key) return;
    box.dataset.k = key;
    box.innerHTML = "";
    if (!show) return;
    const big = this._isCarScreen();
    const size = big ? 128 : 78, gap = 10;
    const bot = this.$("navbot");
    const baseY = wrap.clientHeight - (bot && !bot.hidden ? bot.offsetHeight + 34 : 30) - size;
    ids.forEach((id, i) => {
      const st = this._hass.states[id];
      const b = document.createElement("button");
      b.id = `arrsq${i}`;
      b.className = `arrsq${big ? " big" : ""}${st.state === "on" || st.state === "open" ? " on" : ""}`;
      b.title = `${st.attributes.friendly_name || id} (tieni premuto per spostarlo)`;
      b.innerHTML = `<span class="i">${arrSvg(this._arrIcon(id))}</span><span class="n">${esc(st.attributes.friendly_name || id)}</span>`;
      // posto predefinito: in fila in basso a sinistra; poi quello scelto (tenendo premuto e trascinando)
      b.style.left = `${10 + i * (size + gap)}px`;
      b.style.top = `${Math.max(60, baseY)}px`;
      box.appendChild(b);
      this._applyFloat(b.id, `arr:${id}`);
      this._bindFloatDrag(b.id, `arr:${id}`);
      b.addEventListener("click", () => {
        if (Date.now() - (this._longAt || 0) < 500) return; // appena spostato: non è un tocco
        if (this._arrTest) this._arrAsk(id); else this._pressEntity(id);
      });
    });
  }

  // arrivati (entro 10 m): Ferma automatico; i tasti all'arrivo restano ancora 2 minuti (cancello, garage…)
  _autoStop(dest) {
    this._arrKeep = { until: Date.now() + 120000, dest };
    this._stopNav();
    this._msg(`🏁 Arrivato${dest?.name ? ` a ${dest.name}` : ""}: guida fermata`);
    this._arrivalButtons();
    clearTimeout(this._arrKeepT);
    this._arrKeepT = setTimeout(() => { this._arrKeep = null; this._arrivalButtons(); }, 120500);
  }

  // icona scelta per il tasto; senza scelta: lampadina per le luci, accensione per il resto
  _arrIcon(id) {
    const k = this._settings.arrIcons?.[id];
    if (ARR_SVG[k]) return k;
    return id.startsWith("light.") ? "lampadina" : id.startsWith("cover.") ? "garage" : id.startsWith("lock.") ? "porta" : "accendi";
  }

  // prova dei tasti: "Eseguo il test?" Esegui manda il comando, Nascondi toglie i tasti fino al prossimo arrivo, Esci niente
  _arrAsk(id) {
    this.shadowRoot.querySelector(".arrask")?.remove();
    const st = this._hass.states[id];
    const el = document.createElement("div");
    el.className = "arrask";
    el.innerHTML = `<div><b>${esc(st?.attributes?.friendly_name || id)}</b></div>
      <div style="margin-top:6px">Eseguo il test?</div>
      <div class="acts"><button class="go" data-a="run">Esegui</button><button data-a="hide">Nascondi</button><button data-a="out">Esci</button></div>`;
    this.$("mapwrap").appendChild(el);
    el.querySelector('[data-a="run"]').onclick = () => { el.remove(); this._pressEntity(id); };
    el.querySelector('[data-a="hide"]').onclick = () => { el.remove(); this._arrTest = false; this._arrHidden = true; this._arrivalButtons(); };
    el.querySelector('[data-a="out"]').onclick = () => el.remove();
  }

  async _pressEntity(id) {
    const [domain] = id.split(".");
    const st = this._hass.states[id];
    let call;
    if (domain === "cover") call = ["cover", "toggle"];
    else if (domain === "lock") call = ["lock", st?.state === "locked" ? "unlock" : "lock"];
    else if (domain === "button" || domain === "input_button") call = [domain, "press"];
    else if (domain === "script" || domain === "scene") call = [domain, "turn_on"];
    else call = ["homeassistant", "toggle"];
    try {
      await this._hass.callService(call[0], call[1], { entity_id: id });
      this._msg(`✓ ${st?.attributes?.friendly_name || id}`);
      // a voce, sempre (anche con le indicazioni vocali spente): "Attivo cancello est"
      const word = { it: "Attivo", en: "Activating", de: "Aktiviere", fr: "J'active", es: "Activo" }[this._settings.lang] || "Attivo";
      this._unlockAudio?.();
      this._speak(`${word} ${String(st?.attributes?.friendly_name || id).toLowerCase()}`, true, true);
    } catch (e) {
      this._msg(`Comando non riuscito: ${e.message || e}`);
    }
  }

  // ----------------------------------------------------------------- meteo lungo il percorso (Open-Meteo)
  // punti ogni ~10 km (al massimo 30), ognuno con l'ora in cui ci passerai; avvisi per neve, pioggia, gelo, vento e nebbia

  async _loadWeather() {
    const r = this._result;
    this._wx = null;
    this._wxLayer?.clearLayers();
    if (!r) return;
    const rt = this._geom(r.routes[this._sel]);
    const total = rt._cum[rt._cum.length - 1];
    if (total < 1000) return;
    const step = Math.max(10000, total / 30);
    const pts = [];
    for (let a = Math.min(step / 2, total); a <= total; a += step) pts.push(a);
    if (total - pts[pts.length - 1] > step / 3) pts.push(total);
    const start = Date.now() / 1000;
    const items = pts.map((a) => ({ along: a, ll: this._pointAt(rt, a).ll, t: start + rt.summary.time * (a / total) }));
    this._wx = { rt, items, loading: true };
    this._renderResults();
    try {
      const res = await this._hass.callWS({ type: "navigator/weather", points: items.map((p) => [p.ll[0], p.ll[1], p.t]) });
      if (!this._wx || this._wx.rt !== rt) return;
      res.points.forEach((w, k) => Object.assign(items[k], w, { warn: wxWarnings(w) }));
      this._wx = { rt, items, done: true };
    } catch (e) {
      if (!this._wx || this._wx.rt !== rt) return;
      this._wx = { rt, items, error: e.message || String(e) };
    }
    this._drawWeather();
    this._renderResults();
  }

  _drawWeather() {
    const lay = this._wxLayer;
    if (!lay) return;
    lay.clearLayers();
    // un'icona ogni ~1,5 km su tutto il tratto di ogni punto con un avviso (fino a metà strada dai punti vicini):
    // si vede dove comincia e dove finisce la pioggia, non solo un'icona isolata
    const items = this._wx?.items || [];
    const rt = this._wx?.rt ? this._geom(this._wx.rt) : null;
    const total = rt ? rt._cum[rt._cum.length - 1] : 0;
    items.forEach((p, k) => {
      if (!p.warn?.length) return;
      const w = p.warn[0];
      const title = `${w.txt} · ${fmtClock(p.t)}${p.temp != null ? ` · ${Math.round(p.temp)} °C` : ""}`;
      const icon = L.divIcon({ className: "", html: `<div class="wxm">${wxIcon(w.kind)}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
      const spots = [p.ll];
      if (rt && p.along != null) {
        const a0 = k > 0 ? (items[k - 1].along + p.along) / 2 : Math.max(0, p.along - 2000);
        const a1 = k < items.length - 1 ? (p.along + items[k + 1].along) / 2 : Math.min(total, p.along + 2000);
        for (let a = p.along - 1500; a > a0; a -= 1500) spots.push(this._pointAt(rt, a).ll);
        for (let a = p.along + 1500; a < a1; a += 1500) spots.push(this._pointAt(rt, a).ll);
      }
      for (const ll of spots) L.marker(ll, { title, icon }).addTo(lay);
    });
    if (this._3d) this._updateRainHere(); // pioggia prevista sul percorso: gocce in 3D anche lì
    this._schedule3d();
  }

  // elenco delle indicazioni del percorso scelto (sezione che si chiude)
  _stepsHtml(r) {
    const rt = r.routes[this._sel];
    let h = `<div class="sec">${this._secHead("indicazioni", `Indicazioni <span class="muted" style="text-transform:none">${rt.maneuvers.length} passi</span>`)}<div class="cbbody"><ul class="steps">`;
    let leg = 0;
    rt.maneuvers.forEach((m, k) => {
      if (m.leg !== leg) {
        leg = m.leg;
        const p = this._points[leg];
        h += `<li class="legsep"><span class="ic">📍</span><span class="tx">Tappa ${leg}: ${esc(p?.name || "")}</span></li>`;
      }
      h += `<li data-k="${k}" class="${m.toll ? "toll" : ""}"><span class="ic">${maneuverIcon(m)}</span><span class="tx">${esc(m.text)}</span>
        <span class="d">${m.length_km > 0 ? fmtKm(m.length_km) : ""}</span></li>`;
    });
    h += `</ul></div></div>`;
    return h;
  }

  _wxHtml() {
    const wx = this._wx;
    if (!wx || !this._result || wx.rt !== this._result.routes[this._sel]) return "";
    if (wx.loading) return `<div class="sec"><h3>Meteo lungo il percorso</h3><div class="muted"><span class="loading"></span> Previsioni…</div></div>`;
    if (wx.error) return `<div class="sec"><h3>Meteo lungo il percorso</h3><div class="muted">${esc(wx.error)}</div></div>`;
    const temps = wx.items.map((p) => p.temp).filter((t) => t != null);
    const warns = wx.items.flatMap((p) => (p.warn || []).map((w) => ({ ...w, p })));
    const range = temps.length ? `${Math.round(Math.min(...temps))}–${Math.round(Math.max(...temps))} °C` : "";
    const list = warns.slice(0, 8).map(({ kind, txt, p }) => `<li><span class="wxi">${wxIcon(kind)}</span> <b>${esc(txt)}</b> · km ${Math.round(p.along / 1000)} · ${fmtClock(p.t)}${
      p.temp != null ? ` · ${Math.round(p.temp)} °C` : ""}</li>`).join("");
    return `<div class="sec"><h3>Meteo lungo il percorso <span class="muted" style="text-transform:none">Open-Meteo</span></h3>
      <div>${warns.length ? `⚠ ${warns.length} ${warns.length === 1 ? "avviso" : "avvisi"}` : "☀️ Nessun problema previsto"}${range ? ` · ${range}` : ""}</div>
      ${list ? `<ul class="wxlist">${list}</ul>` : ""}
      <div class="muted" style="font-size:11px;margin-top:4px">All'ora in cui passerai, partendo adesso.</div></div>`;
  }

  // guida: avviso quando un punto con meteo brutto è a meno di 10 km davanti
  _wxAhead(along) {
    const nav = this._nav;
    if (!nav?.fix || !this._wx?.done || this._settings.wxAlert === false) return;
    nav.wxSaid ??= new Set();
    for (const p of this._wx.items) {
      const to = p.along - along;
      if (!p.warn?.length || to < 0 || to > 10000 || nav.wxSaid.has(p.along)) continue;
      nav.wxSaid.add(p.along);
      const w = p.warn[0];
      this._navPopup("warn", `<span class="wxi" style="width:40px;height:40px">${wxIcon(w.kind)}</span>`, `${esc(w.txt)} tra ${fmtDist(to)}${p.temp != null ? `<br><b>${Math.round(p.temp)} °C</b>` : ""}`, 6000);
      this._speak(`Attenzione: ${w.txt.toLowerCase()} tra ${fmtDist(to).replace("km", "chilometri").replace(" m", " metri")}`);
      break;
    }
  }

  // ----------------------------------------------------------------- diario dei viaggi

  _tripPoint(f) {
    const nav = this._nav;
    if (!nav || f.est) return;
    nav.trip ??= { start: Date.now(), track: [], km: 0, max: 0, pending: [] };
    const t = nav.trip;
    const last = t.track[t.track.length - 1];
    const here = [+f.lat.toFixed(5), +f.lon.toFixed(5)];
    if (!last || distM(last, here) >= 25) {
      if (last) t.km += distM(last, here) / 1000;
      t.track.push(here);
      t.pending.push(here);
    }
    if (typeof f.speed === "number" && f.speed >= 0 && (f.acc || 0) < 50) t.max = Math.max(t.max, f.speed * 3.6);
  }

  // viaggio salvato man mano: creato alla partenza, punti e totali ogni 30 s (e quando l'app va in secondo piano),
  // concluso con Esci; senza Esci resta in archivio con i punti arrivati fino a quel momento
  async _tripBegin() {
    const nav = this._nav;
    nav.trip = { start: Date.now(), track: [], km: 0, max: 0, pending: [] };
    const dest = this._points[this._points.length - 1] || {};
    try {
      const r = await this._hass.callWS({ type: "navigator/trip_start", trip: { start: nav.trip.start / 1000, from: this._tripFrom || "",
        to: dest.name || "", mode: this._mode, vehicle: this._tripVehicle || {} } });
      if (this._nav === nav) nav.trip.id = r.id;
    } catch (e) { /* integrazione vecchia: il viaggio si salva tutto alla fine */ }
    clearInterval(this._tripTimer);
    this._tripTimer = setInterval(() => this._tripFlush(), 30000);
  }

  _tripStats(t) {
    const now = Date.now();
    const duration = Math.round((now - t.start) / 1000);
    const dest = this._points[this._points.length - 1] || {};
    return { km: Math.round(t.km * 100) / 100, duration, end: now / 1000, max: Math.round(t.max), to: dest.name || "",
      avg: duration > 60 ? Math.round((t.km / (duration / 3600)) * 10) / 10 : 0 };
  }

  async _tripFlush(nav = this._nav) {
    const t = nav?.trip;
    if (!t?.id || t.flushing || (!t.pending.length && Date.now() - (t.flushedAt || 0) < 60000)) return;
    const points = t.pending.splice(0);
    t.flushing = true;
    try {
      await this._hass.callWS({ type: "navigator/trip_append", trip_id: t.id, points, stats: this._tripStats(t) });
      t.flushedAt = Date.now();
    } catch (e) {
      t.pending.unshift(...points); // si riprova al prossimo giro
    } finally {
      t.flushing = false;
    }
  }

  async _tripEnd(nav) {
    clearInterval(this._tripTimer);
    const t = nav.trip;
    if (!t) return;
    if (!t.id) { this._tripSave(nav); return; } // integrazione vecchia
    t.flushedAt = 0;
    await this._tripFlush(nav);
    try { await this._hass.callWS({ type: "navigator/trip_finish", trip_id: t.id }); } catch (e) { /* resta "interrotto" */ }
    this._loadTrips();
  }

  async _tripSave(nav) {
    const t = nav.trip;
    if (!t || t.km < 0.3 || t.track.length < 2) return;
    const end = Date.now();
    const duration = Math.round((end - t.start) / 1000);
    const dest = this._points[this._points.length - 1] || {};
    try {
      await this._hass.callWS({ type: "navigator/trip_save", trip: { start: t.start / 1000, end: end / 1000, from: this._tripFrom || "",
        to: dest.name || "", mode: this._mode, km: Math.round(t.km * 10) / 10, duration,
        avg: duration > 0 ? Math.round((t.km / (duration / 3600)) * 10) / 10 : 0, max: Math.round(t.max), track: t.track,
        vehicle: this._tripVehicle || {} } });
      this._loadTrips();
    } catch (e) { /* integrazione vecchia: viaggio non salvato */ }
  }

  async _loadTrips() {
    try {
      this._trips = (await this._hass.callWS({ type: "navigator/trips" })).trips || [];
    } catch (e) {
      this._trips = null;
    }
    this._renderTrips();
  }

  _showTab(tab) {
    this.$("sidetabs").querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    this.$("tabViaggio").hidden = tab !== "viaggio";
    this.$("tabArchivio").hidden = tab !== "archivio";
    this.$("tabLive").hidden = tab !== "live";
    if (tab === "archivio") this._loadTrips();
    // Live: aggiornata ogni 10 secondi finché la scheda è aperta
    clearInterval(this._liveTimer);
    this._liveTimer = null;
    if (tab === "live") {
      this._loadLive(true);
      this._liveTimer = setInterval(() => this._loadLive(), 10000);
    }
  }

  // ----------------------------------------------------------------- Live: le guide in corso di tutti gli utenti
  // ognuna selezionabile sulla mappa (traccia fatta finora, veicolo, arrivo); a guida finita sparisce

  async _loadLive(first = false) {
    const box = this.$("livesec");
    if (!box) return;
    if (first && !this._live) box.innerHTML = `<h3>Live</h3><div class="muted"><span class="loading"></span> Guide in corso…</div>`;
    try {
      this._live = (await this._hass.callWS({ type: "navigator/live_all" })).live || [];
      this._liveErr = null;
    } catch (e) {
      this._liveErr = String(e.message || e).includes("Unknown command")
        ? "Live non disponibile: aggiorna l'integrazione Navigator e riavvia Home Assistant." : e.message || String(e);
    }
    this._renderLive();
    this._drawLive();
  }

  _renderLive() {
    const box = this.$("livesec");
    if (!box) return;
    if (this._liveErr) { box.innerHTML = `<h3>Live</h3><div class="muted">${esc(this._liveErr)}</div>`; return; }
    const list = this._live || [];
    const colors = ["#e53935", "#1e88e5", "#43a047", "#fb8c00", "#8e24aa", "#00897b", "#6d4c41", "#d81b60"];
    this._liveCol ??= new Map(); // utente -> colore, fisso finché la guida dura
    this._liveOff ??= new Set(); // guide tolte dalla mappa (le altre si vedono)
    const ids = new Set(list.map((x) => x.user_id));
    for (const id of [...this._liveCol.keys()]) if (!ids.has(id)) { this._liveCol.delete(id); this._liveOff.delete(id); }
    for (const x of list) {
      if (!this._liveCol.has(x.user_id)) {
        const used = [...this._liveCol.values()];
        this._liveCol.set(x.user_id, colors.find((c) => !used.includes(c)) || colors[this._liveCol.size % colors.length]);
      }
    }
    let html = `<h3>Live <span class="muted" style="text-transform:none">aggiornata ogni 10 s</span></h3>`;
    if (!list.length) {
      html += `<div class="muted">Nessuno sta guidando adesso. Qui compaiono le guide in corso di tutti gli utenti di Home Assistant
        (da quando premono Parti a quando escono), con la posizione sulla mappa.</div>`;
    }
    const now = Date.now() / 1000;
    list.forEach((x, k) => {
      const col = this._liveCol.get(x.user_id);
      const on = !this._liveOff.has(x.user_id);
      const v = x.vehicle || {};
      const vico = v.type ? vehIcon(v.type) : (MODES.find((m) => m[0] === x.mode) || MODES[0])[1];
      const ago = Math.max(0, Math.round(now - (x.updated || now)));
      const agoTxt = ago < 60 ? `${ago} s fa` : `${Math.round(ago / 60)} min fa`;
      const eta = x.arrived ? "✅ arrivato" : x.eta ? `arrivo ${fmtClock(x.eta)} · ${fmtTime((x.minutes || 0) * 60)} · ${fmtKm(x.km || 0)}` : "";
      html += `<div class="trip live"><input type="checkbox" data-lc="${k}" ${on ? "checked" : ""} title="Mostra sulla mappa">
        <span class="sw" style="background:${col}"></span>
        <div class="nm" data-lv="${k}"><b>${esc(x.name || "Utente")}${x.me ? " (tu)" : ""}</b> · ${vico} ${esc(v.name || "")}${v.plate ? ` ${esc(v.plate)}` : ""}
          <div>${x.from ? `${esc(x.from)} → ` : "→ "}${esc(x.dest || "?")}</div>
          <small>${eta}${x.speed != null && !x.arrived ? ` · ${Math.round(x.speed)} km/h` : ""} · aggiornato ${agoTxt}${ago > 120 ? " ⚠" : ""}</small></div></div>`;
    });
    box.innerHTML = html;
    box.querySelectorAll("[data-lc]").forEach((el) => el.addEventListener("change", () => {
      const x = list[+el.dataset.lc];
      if (el.checked) this._liveOff.delete(x.user_id); else this._liveOff.add(x.user_id);
      this._drawLive();
    }));
    // toccando il nome la mappa va su quella persona (e la mostra, se era nascosta)
    box.querySelectorAll("[data-lv]").forEach((el) => el.addEventListener("click", () => {
      const x = list[+el.dataset.lv];
      this._liveOff.delete(x.user_id);
      this._renderLive();
      this._drawLive();
      const p = x.track?.[x.track.length - 1];
      if (p) this._map.setView(p, Math.max(this._map.getZoom(), 15));
    }));
  }

  _drawLive() {
    const lay = this._liveLayer;
    if (!lay) return;
    lay.clearLayers();
    for (const x of this._live || []) {
      if (this._liveOff?.has(x.user_id)) continue;
      const col = this._liveCol?.get(x.user_id) || "#e53935";
      const tr = x.track || [];
      if (tr.length > 1) {
        L.polyline(tr, { color: "#fff", weight: 8, opacity: 0.85, interactive: false }).addTo(lay);
        L.polyline(tr, { color: col, weight: 5, opacity: 1, interactive: false }).addTo(lay);
      }
      if (x.lat != null && x.lon != null && !x.arrived) { // arrivo
        L.marker([x.lat, x.lon], { interactive: false, icon: L.divIcon({ className: "", iconSize: [22, 22], iconAnchor: [11, 11],
          html: `<div class="livedest" style="border-color:${col}">🏁</div>` }) }).addTo(lay);
      }
      const p = tr[tr.length - 1];
      if (p) { // veicolo nella direzione di marcia, col nome
        const v = x.vehicle || {};
        const svg = v.type ? vehicleSvg(v) : uniqSvg(VEHICLE_SVG[x.mode] || CAR_SVG);
        L.marker(p, { title: `${x.name || ""}${x.dest ? ` → ${x.dest}` : ""}`, zIndexOffset: 900, icon: L.divIcon({ className: "", iconSize: [60, 70], iconAnchor: [30, 26],
          html: `<div class="livecar"><div class="lc" style="transform:rotate(${Math.round(x.dir || 0)}deg)">${svg}</div>
            <div class="ln" style="background:${col}">${esc(x.name || "")}</div></div>` }) }).addTo(lay);
      }
    }
    this._schedule3d();
  }

  // Archivio: tutti i viaggi per mese, con i totali; la casella mostra la traccia sulla mappa (più viaggi insieme, colori diversi)
  _renderTrips() {
    const box = this.$("tripsec");
    if (!box) return;
    const trips = this._trips;
    if (!trips) { box.innerHTML = `<div class="muted">Archivio non disponibile: aggiorna l'integrazione Navigator e riavvia Home Assistant.</div>`; return; }
    this._tripSel ??= new Map(); // id -> colore
    const kmAll = trips.reduce((a, t) => a + (t.km || 0), 0);
    let html = `<h3>Archivio viaggi ${this._tripSel.size ? `<button class="link" data-t="none">Nascondi tutte</button>` : ""}</h3>`;
    if (!trips.length) {
      html += `<div class="muted">Ogni guida finita con Esci viene salvata qui: data, veicolo, km, tempo, velocità e traccia.</div>`;
    } else {
      html += `<div class="muted">${trips.length} ${trips.length === 1 ? "viaggio" : "viaggi"} · ${fmtKm(kmAll)} in tutto. Spunta un viaggio per vederlo sulla mappa.</div>`;
      // raggruppati per anno e mese, che si aprono e chiudono; all'inizio aperti solo l'anno e il mese più recenti
      const yOf = (t) => String(new Date(t.start * 1000).getFullYear());
      const mOf = (t) => { const d = new Date(t.start * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
      if (!this._tripOpen) this._tripOpen = new Set(trips.length ? [yOf(trips[0]), mOf(trips[0])] : []);
      const tot = (list) => `${list.length} · ${fmtKm(list.reduce((a, x) => a + (x.km || 0), 0))} · ${fmtTime(list.reduce((a, x) => a + (x.duration || 0), 0))}`;
      let year = "", month = "";
      trips.forEach((t, k) => {
        const d = new Date(t.start * 1000);
        const y = yOf(t), m = mOf(t);
        if (y !== year) {
          year = y; month = "";
          const open = this._tripOpen.has(y);
          html += `<div class="tyear${open ? " open" : ""}" data-tg="${y}"><b><span class="car">▸</span> ${y}</b><span>${tot(trips.filter((x) => yOf(x) === y))}</span></div>`;
        }
        if (!this._tripOpen.has(y)) return;
        if (m !== month) {
          month = m;
          const open = this._tripOpen.has(m);
          const nm = d.toLocaleDateString("it-IT", { month: "long" });
          html += `<div class="month${open ? " open" : ""}" data-tg="${m}"><b><span class="car">▸</span> ${nm.charAt(0).toUpperCase() + nm.slice(1)}</b><span>${tot(trips.filter((x) => mOf(x) === m))}</span></div>`;
        }
        if (!this._tripOpen.has(m)) return;
        const when = `${d.toLocaleDateString("it-IT", { weekday: "short", day: "numeric" })} ${d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`;
        const v = t.vehicle || {};
        const veh = v.type ? ` · ${vehIcon(v.type)} ${esc(v.name || "")}${v.plate ? ` ${esc(v.plate)}` : ""}` : "";
        const col = this._tripSel.get(t.id);
        html += `<div class="trip"><input type="checkbox" data-tc="${k}" ${col ? "checked" : ""} style="--tc:${col || ""}" title="Mostra sulla mappa">
          ${col ? `<span class="sw" style="background:${col}"></span>` : ""}
          <div class="nm" data-tv="${k}">${esc(t.from || "?")} → ${esc(t.to || "?")}
          <small>${t.status === "in_corso" ? "🔴 in corso · " : t.status === "interrotto" ? "⚠ interrotto (senza Esci) · " : ""}${when}${veh} · ${fmtKm(t.km || 0)} · ${fmtTime(t.duration || 0)} · media ${Math.round(t.avg || 0)} · max ${Math.round(t.max || 0)} km/h${
            t.elev?.total != null ? ` · ⛰ ${fmtM(t.elev.total)} (↗ ${fmtM(t.elev.up)} · ↘ ${fmtM(t.elev.down)})` : ""}</small></div>
          <button class="icon" data-td="${k}" title="Elimina">🗑</button></div>`;
      });
    }
    box.innerHTML = html;
    box.querySelector('[data-t="none"]')?.addEventListener("click", () => { this._tripSel.clear(); this._drawTrips(); this._renderTrips(); });
    box.querySelectorAll("[data-tg]").forEach((el) => el.addEventListener("click", () => {
      const g = el.dataset.tg;
      if (this._tripOpen.has(g)) this._tripOpen.delete(g); else this._tripOpen.add(g);
      this._renderTrips();
    }));
    box.querySelectorAll("[data-tc]").forEach((el) => el.addEventListener("change", () => this._toggleTrip(trips[+el.dataset.tc], el.checked)));
    box.querySelectorAll("[data-tv]").forEach((el) => el.addEventListener("click", () => this._toggleTrip(trips[+el.dataset.tv], true, true)));
    box.querySelectorAll("[data-td]").forEach((el) => el.addEventListener("click", async () => {
      const t = trips[+el.dataset.td];
      if (!window.confirm(`Eliminare il viaggio ${t.from || ""} → ${t.to || ""}?`)) return;
      this._tripSel.delete(t.id);
      this._trips = (await this._hass.callWS({ type: "navigator/trip_delete", trip_id: t.id })).trips;
      this._drawTrips();
      this._renderTrips();
    }));
  }

  // mostra o nasconde la traccia di un viaggio; toccando il nome la mappa si centra sul viaggio
  async _toggleTrip(t, on, fit = false) {
    const colors = ["#8e24aa", "#e65100", "#00897b", "#3949ab", "#c2185b", "#6d4c41", "#7cb342", "#5e35b1"];
    this._tripTracks ??= new Map();
    if (!on) {
      this._tripSel.delete(t.id);
    } else {
      if (!this._tripTracks.has(t.id)) {
        try {
          const full = await this._hass.callWS({ type: "navigator/trip", trip_id: t.id });
          this._tripTracks.set(t.id, full.track || []);
          if (full.elev) t.elev = full.elev; // dislivello calcolato adesso (viaggi salvati prima)
        } catch (e) { this._msg(e.message || String(e)); return; }
      }
      if (!this._tripSel.has(t.id)) {
        const used = [...this._tripSel.values()];
        this._tripSel.set(t.id, colors.find((c) => !used.includes(c)) || colors[this._tripSel.size % colors.length]);
      }
    }
    this._drawTrips();
    const tr = this._tripTracks.get(t.id);
    if (on && tr?.length > 1 && (fit || this._tripSel.size === 1)) this._map.fitBounds(L.latLngBounds(tr), { padding: [30, 30] });
    this._renderTrips();
  }

  _drawTrips() {
    this._tripLayer.clearLayers();
    for (const [id, col] of this._tripSel || []) {
      const tr = this._tripTracks?.get(id);
      if (tr?.length > 1) L.polyline(tr, { color: col, weight: 5, opacity: 0.9, interactive: false }).addTo(this._tripLayer);
    }
    this._schedule3d();
  }

  // ----------------------------------------------------------------- add-on
  // Un add-on è un file .zip con dentro addon.json (e, se servono, immagini): descrive una finestra da mettere sulla
  // mappa (2D, 3D o entrambe) con un'immagine da internet (aggiornata ogni tanto) o dello zip, e cosa fa al tocco.
  // Nessun codice viene eseguito. Salvati in Home Assistant: valgono per tutti i dispositivi, auto compresa.

  async _loadAddons() {
    try { this._addons = (await this._hass.callWS({ type: "navigator/addons" })).addons || []; }
    catch (e) { this._addons = []; } // integrazione vecchia
    this._renderAddons();
  }

  async _addonCall(msg) {
    const r = await this._hass.callWS({ type: "navigator/addons", ...msg });
    this._addons = r.addons || [];
    this._renderAddons();
  }

  _addonsHtml() {
    const list = this._addons || [];
    return `<div class="grp"><h3>Add-on</h3>
      <div class="note">Aggiungono finestre alla mappa (per esempio un'immagine del meteo dal satellite). Si caricano da un file
        .zip con dentro <b>addon.json</b>; valgono per tutti i dispositivi. Tieni premuta una finestra per spostarla.</div>
      ${list.length ? list.map((a) => `<div class="addrow">
        <div class="ai"><b>${esc(a.name)}</b>${a.version ? ` <span class="note">v${esc(a.version)}</span>` : ""}
          ${a.description ? `<div class="note">${esc(a.description)}</div>` : ""}
          <div class="note">Mappa ${a.window.views.map((v) => v.toUpperCase()).join(" e ")}${a.author ? ` · di ${esc(a.author)}` : ""}</div>
          ${(a.settings || []).map((st) => {
            const val = a.values?.[st.key] || "";
            if (st.type === "entity") {
              const ents = Object.keys(this._hass?.states || {}).filter((e) => !st.domain || e.startsWith(`${st.domain}.`)).sort();
              return `<label class="note" style="display:block;margin-top:4px">${esc(st.label)}<select data-addon-set="${esc(a.id)}" data-k="${esc(st.key)}" style="display:block;max-width:100%">
                <option value="">— scegli —</option>${ents.map((e) => `<option value="${esc(e)}" ${e === val ? "selected" : ""}>${esc(this._hass.states[e].attributes.friendly_name || e)}</option>`).join("")}</select></label>`;
            }
            return `<label class="note" style="display:block;margin-top:4px">${esc(st.label)}<input data-addon-set="${esc(a.id)}" data-k="${esc(st.key)}" value="${esc(val)}" style="display:block;max-width:100%"></label>`;
          }).join("")}
          <select data-addon-where="${esc(a.id)}" style="margin-top:4px;max-width:100%">${[["both", "In guida e in pianificazione"],
            ["guida", "Solo in guida"], ["plan", "Solo in pianificazione"]].map(([v, t]) =>
            `<option value="${v}" ${(a.where || "both") === v ? "selected" : ""}>${t}</option>`).join("")}</select>
          ${this._addonClosed?.has(a.id) && a.enabled ? `<button data-addon-show="${esc(a.id)}" style="margin-top:4px">Mostra di nuovo</button>` : ""}</div>
        <span class="sw" title="Attivo"><input type="checkbox" data-addon-on="${esc(a.id)}" ${a.enabled ? "checked" : ""}><i></i></span>
        <button data-addon-del="${esc(a.id)}" title="Togli">🗑</button></div>`).join("") : `<div class="note" style="margin-top:6px">Nessun add-on installato.</div>`}
      <label class="addfile">➕ Aggiungi add-on (.zip)<input type="file" accept=".zip,application/zip" data-addon-file></label>
      <div class="note" style="margin-top:10px">Oppure da un indirizzo (lo scarica Home Assistant: utile nell'app Companion, che
        ricarica la pagina quando scegli un file):</div>
      <div class="row" style="gap:6px;margin-top:4px"><input type="url" data-addon-url placeholder="https://…/add-on.zip" style="flex:1;min-width:0">
        <button data-addon-urlgo>Installa</button></div>
      <div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">
        <button data-addon-example="meteo-satellite">🛰️ Esempio: meteo dal satellite</button>
        <button data-addon-example="satellite-zona">📍 Esempio: satellite sulla tua zona</button>
        <button data-addon-example="music-assistant">🎵 Esempio: Music Assistant</button></div>
      <details class="addinfo"><summary>ℹ️ Come si crea un add-on</summary>
        <ol>
          <li>Crea una cartella e dentro scrivi il file <b>addon.json</b> (esempio qui sotto).</li>
          <li>Se l'immagine è un file tuo (png, jpg, gif, webp o svg, al massimo ~1 MB) mettilo nella cartella e scrivi il suo
            nome in <code>"image"</code>; altrimenti metti l'indirizzo <code>https://…</code> dell'immagine.</li>
          <li>Comprimi la cartella in un <b>.zip</b> e caricalo con <i>Aggiungi add-on</i>. Con lo stesso <code>id</code> sostituisce
            quello installato (aggiornamento).</li>
        </ol>
        <pre>${esc(`{
  "id": "meteo-satellite",
  "name": "Meteo dal satellite",
  "version": "1.0",
  "description": "Meteosat sull'Europa, ogni 15 min",
  "window": {
    "title": "🛰️ Satellite",
    "image": "https://…/immagine.jpg",
    "refresh": 900,
    "width": 240, "height": 170,
    "views": ["2d", "3d"],
    "click": "close"
  }
}`)}</pre>
        <div class="note"><b>refresh</b>: ogni quanti secondi ricaricare l'immagine (0 = mai) · <b>views</b>: "2d", "3d" o entrambe ·
          <b>images</b> (facoltativo): immagini alternative con un tasto ciascuna, <code>[{"label": "IR", "image": "https://…"}, …]</code> ·
          <b>click</b>: <code>"close"</code> chiude, <code>"refresh"</code> ricarica, <code>"none"</code> niente,
          <code>{"open": "https://…"}</code> apre un indirizzo,
          <code>{"service": "light.toggle", "data": {"entity_id": "light.cortile"}}</code> chiama un servizio di Home Assistant.</div>
        <div class="note"><b>Posizione e percorso</b>: negli indirizzi si possono scrivere <code>{lat}</code> <code>{lon}</code>
          (la tua posizione), <code>{bbox}</code> (zona intorno a te di <b>area_km</b> km, per i servizi WMS), <code>{zoom}</code>,
          <code>{speed}</code>, <code>{dest_lat}</code> <code>{dest_lon}</code>, <code>{left_km}</code>…: l'immagine si ricarica quando ti
          sposti (con <code>"follow": false</code> solo al ricaricamento); <code>"marker": true</code> mette un pallino al centro (tu sei qui).</div>
        <div class="note"><b>Tasti</b> sull'immagine: <code>"buttons": [{"icon": "⏭", "service": "media_player.media_next_track",
          "data": {"entity_id": "{player}"}}, {"icon": "📃", "list": {"browse": "{player}", "path": ["Playlists"]}}]</code> (servizio di
          Home Assistant, oppure elenco dei contenuti di un lettore da cui scegliere) · <b>settings</b>: scelte fatte qui (es. il lettore,
          poi usato come <code>{player}</code>) · <code>"image": "entity:{player}"</code> mostra la copertina del brano,
          <code>"caption": "media"</code> titolo e artista.</div>
        <div class="note">Nessun codice viene eseguito: un add-on è solo questa descrizione.</div>
        <div class="row" style="gap:8px;margin-top:6px;flex-wrap:wrap">
          <a href="https://github.com/LabirintoDigitale/ha-navigator/raw/main/addons/meteo-satellite.zip" target="_blank" rel="noopener">⬇ Scarica l'esempio (meteo dal satellite)</a>
          <a href="https://github.com/LabirintoDigitale/ha-navigator/tree/main/addons" target="_blank" rel="noopener">📖 Guida completa</a></div>
      </details>
    </div>`;
  }

  async _addonInstallUrl(url) {
    try {
      this._msg("Scarico l'add-on…");
      const before = new Set((this._addons || []).map((a) => a.id));
      await this._addonCall({ url });
      const a = (this._addons || []).find((x) => !before.has(x.id)) || (this._addons || []).at(-1);
      if (a) this._addonClosed?.delete(a.id);
      this._renderAddons();
      this._msg(a ? `Add-on «${a.name}» installato` : "Add-on installato");
    } catch (err) {
      this._msg(`Add-on non installato: ${err.message || err}`);
    }
    this._openSettings();
  }

  _bindAddonSettings(wrap) {
    wrap.querySelector("[data-addon-urlgo]")?.addEventListener("click", () => {
      const url = wrap.querySelector("[data-addon-url]")?.value.trim();
      if (url) this._addonInstallUrl(url);
    });
    wrap.querySelectorAll("[data-addon-example]").forEach((b) => b.addEventListener("click", () =>
      this._addonInstallUrl(`https://raw.githubusercontent.com/LabirintoDigitale/ha-navigator/main/addons/${b.dataset.addonExample}.zip`)));
    wrap.querySelector("[data-addon-file]")?.addEventListener("change", async (e) => {
      const f = e.target.files?.[0];
      e.target.value = "";
      if (!f) return;
      try {
        const a = await this._addonFromZip(f);
        await this._addonCall({ add: a });
        this._addonClosed?.delete(a.id);
        this._renderAddons();
        this._msg(`Add-on «${a.name}» installato`);
      } catch (err) {
        this._msg(`Add-on non installato: ${err.message || err}`);
      }
      this._openSettings();
    });
    wrap.querySelectorAll("[data-addon-on]").forEach((el) => el.addEventListener("change", async () => {
      try { await this._addonCall({ enable: el.dataset.addonOn, on: el.checked }); } catch (err) { this._msg(err.message || String(err)); }
      this._openSettings();
    }));
    wrap.querySelectorAll("[data-addon-set]").forEach((el) => el.addEventListener("change", async () => {
      try { await this._addonCall({ where_id: el.dataset.addonSet, values: { [el.dataset.k]: el.value } }); }
      catch (err) { this._msg(err.message || String(err)); }
    }));
    wrap.querySelectorAll("[data-addon-where]").forEach((el) => el.addEventListener("change", async () => {
      try { await this._addonCall({ where_id: el.dataset.addonWhere, where: el.value }); } catch (err) { this._msg(err.message || String(err)); }
    }));
    wrap.querySelectorAll("[data-addon-del]").forEach((el) => el.addEventListener("click", async () => {
      const a = (this._addons || []).find((x) => x.id === el.dataset.addonDel);
      if (!a || !confirm(`Togliere l'add-on «${a.name}»?`)) return;
      try { await this._addonCall({ remove: a.id }); } catch (err) { this._msg(err.message || String(err)); }
      this._openSettings();
    }));
    wrap.querySelectorAll("[data-addon-show]").forEach((el) => el.addEventListener("click", () => {
      this._addonClosed?.delete(el.dataset.addonShow);
      this._renderAddons();
      this._openSettings();
    }));
  }

  // dal file .zip: addon.json (anche dentro una cartella) e le immagini che usa, come data URL
  async _addonFromZip(file) {
    if (file.size > 6_000_000) throw new Error("il file è troppo grande");
    const files = await readZip(await file.arrayBuffer());
    const key = Object.keys(files).find((n) => n === "addon.json" || n.endsWith("/addon.json"));
    if (!key) throw new Error("nello zip manca addon.json");
    const base = key.slice(0, -"addon.json".length);
    let a;
    try { a = JSON.parse(new TextDecoder().decode(files[key])); } catch (e) { throw new Error(`addon.json non è valido (${e.message})`); }
    const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
    const imgs = {};
    for (const [n, data] of Object.entries(files)) {
      if (!n.startsWith(base)) continue;
      const rel = n.slice(base.length), mime = MIME[rel.split(".").pop().toLowerCase()];
      if (!mime) continue;
      let bin = "";
      for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
      imgs[rel] = `data:${mime};base64,${btoa(bin)}`;
    }
    a.files = {};
    const all = [a.window?.image, ...(Array.isArray(a.window?.images) ? a.window.images.map((i) => i?.image) : [])];
    for (const img of all) {
      if (!img || /^(https?|entity):/.test(img)) continue;
      if (!imgs[img]) throw new Error(`l'immagine "${img}" non è nello zip`);
      a.files[img] = imgs[img];
    }
    return a;
  }

  // finestre sulla mappa: quelle degli add-on attivi, per la vista in uso (2D o 3D), non chiuse col tocco
  _renderAddons() {
    const wrap = this.$?.("mapwrap");
    if (!wrap) return;
    this._addonClosed ||= new Set();
    const view = this._3d ? "3d" : "2d";
    this._addonGuida = !!(this._nav && this._isGuida());
    const want = (this._addons || []).filter((a) => a.enabled && a.window.views.includes(view) && !this._addonClosed.has(a.id)
      && this._addonHere(a));
    const ids = new Set(want.map((a) => `addon-${a.id}`));
    wrap.querySelectorAll(".addwin").forEach((el) => {
      if (!ids.has(el.id)) { clearInterval(el._timer); el.remove(); }
    });
    want.forEach((a, i) => {
      const id = `addon-${a.id}`, w = a.window;
      const sig = JSON.stringify(w) + (a.files?.[w.image] ? "f" : "");
      let el = this.$(id);
      if (el && el._sig === sig) return;
      if (el) { clearInterval(el._timer); el.remove(); }
      el = document.createElement("div");
      el.className = "addwin"; el.id = id; el._sig = sig;
      el.title = `${a.name} (tieni premuto per spostarla)`;
      el.style.top = `${120 + i * 30}px`;
      const alts = Array.isArray(w.images) && w.images.length > 1 ? w.images : null;
      const selKey = `${STORE_KEY}-addon-${a.id}`;
      let sel = 0;
      try { sel = Math.max(0, Math.min((alts?.length || 1) - 1, +localStorage.getItem(selKey) || 0)); } catch (e) { /* niente */ }
      el.innerHTML = `${w.title ? `<div class="at">${esc(w.title)}</div>` : ""}<div class="aimg"><img alt="" style="width:${w.width}px;height:${w.height}px">${
        w.marker ? `<i class="ame" title="Tu sei qui"></i>` : ""}${w.caption ? `<div class="acap"></div>` : ""}${
        w.buttons?.length ? `<div class="abar">${w.buttons.map((b, i) => `<button data-b="${i}" title="${esc(b.label || "")}">${esc(b.icon || b.label)}</button>`).join("")}</div>` : ""}</div>${
        alts ? `<div class="abtns" style="max-width:${w.width}px">${alts.map((it, k) => `<button data-k="${k}" class="${k === sel ? "on" : ""}">${esc(it.label)}</button>`).join("")}</div>` : ""}`;
      const img = el.querySelector("img");
      const cur = () => (alts ? alts[sel].image : w.image);
      let at = null; // posizione usata per l'ultima immagine (per i segnaposto {lat}, {bbox}…)
      const load = () => {
        const u0 = cur(), local = a.files?.[u0];
        if (local) { img.src = local; return; }
        if (u0.startsWith("entity:")) { // copertina (e titolo) presi da un'entità, es. il lettore della musica
          const st = this._hass?.states?.[this._addonFill(u0.slice(7), this._addonVarsA(a))];
          const pic = st?.attributes?.entity_picture || "";
          if (pic && img.dataset.pic !== pic) { img.dataset.pic = pic; img.src = pic; img.style.display = ""; el.querySelector(".aerr")?.remove(); }
          if (!pic) { img.dataset.pic = ""; img.removeAttribute("src"); img.style.visibility = "hidden"; } else img.style.visibility = "";
          const cap = el.querySelector(".acap");
          if (cap) {
            const t = [st?.attributes?.media_title, st?.attributes?.media_artist].filter(Boolean).join(" — ");
            cap.textContent = st ? (t || (st.state === "off" ? "Spento" : st.state === "idle" ? "In attesa" : "")) : "Scegli il lettore nelle impostazioni dell'add-on";
            cap.hidden = !cap.textContent;
          }
          return;
        }
        const v = this._addonVarsA(a);
        at = v._pos;
        // immagine con area fissa: il pallino va dove sei (fuori dall'area: nascosto)
        const me = el.querySelector(".ame"), bb = w.marker_bbox;
        if (me && bb && v._pos) {
          me.dataset.fx = (v._pos[1] - bb[1]) / (bb[3] - bb[1]); me.dataset.fy = (bb[2] - v._pos[0]) / (bb[2] - bb[0]);
          this._addonMarker(el, w.width / w.height);
        }
        const u = this._addonFill(u0, v);
        img.src = w.refresh ? `${u}${u.includes("?") ? "&" : "?"}_t=${Math.floor(Date.now() / (w.refresh * 1000))}` : u;
      };
      const pick = (k) => {
        sel = k;
        try { localStorage.setItem(selKey, String(sel)); } catch (err) { /* niente */ }
        el.querySelectorAll(".abtns button").forEach((x) => x.classList.toggle("on", +x.dataset.k === k));
        el.querySelector(".aerr")?.remove(); img.style.display = "";
        load();
        el._onFmt?.();
      };
      el._fmtLabel = () => (alts ? alts[sel].label : "");
      el._entityTick = cur().startsWith("entity:") ? load : null; // aggiornata quando cambia lo stato di Home Assistant
      el.querySelectorAll(".abar button").forEach((b) => b.addEventListener("click", (e) => {
        e.stopPropagation(); // il tasto fa la sua azione, non è un tocco sulla finestra
        if (Date.now() - (this._longAt || 0) < 500) return;
        this._addonButton(a, el, w.buttons[+b.dataset.b]);
      }));
      el._fmtNext = () => { if (alts) pick((sel + 1) % alts.length); };
      el._title = w.title || a.name;
      el.querySelectorAll(".abtns button").forEach((b) => b.addEventListener("click", (e) => {
        e.stopPropagation(); // il tasto cambia immagine, non è un tocco sulla finestra
        if (Date.now() - (this._longAt || 0) < 500) return;
        pick(+b.dataset.k);
      }));
      img.onerror = () => {
        // errore momentaneo del server: si riprova fra un minuto (non solo al prossimo aggiornamento)
        clearTimeout(el._retry);
        el._retry = setTimeout(() => { if (el.isConnected) load(); }, 60000);
        if (el.querySelector(".aerr")) return;
        img.insertAdjacentHTML("afterend", `<div class="aerr" style="width:${w.width}px;height:${w.height}px">Immagine non disponibile</div>`);
        img.style.display = "none";
      };
      img.onload = () => { el.querySelector(".aerr")?.remove(); img.style.display = ""; };
      load();
      if (w.refresh) el._timer = setInterval(() => { if (!a.files?.[cur()]) load(); }, w.refresh * 1000);
      // indirizzi con la posizione: nuova immagine quando ti sei spostato di un buon tratto (controllo ogni 10 s)
      if (w.follow !== false && [w.image, ...(w.images || []).map((i) => i.image)].some((u) => /\{(lat|lon|bbox|lat_min|lat_max|lon_min|lon_max|bbox_xy|zoom)\}/.test(u))) {
        const chk = setInterval(() => {
          if (!el.isConnected) { clearInterval(chk); return; }
          const p = this._addonVars(w)._pos;
          if (at && p && distM(at, p) > Math.max(300, (w.area_km || 100) * 1000 * 0.15)) load();
        }, 10000);
      }
      el.addEventListener("click", () => {
        if (Date.now() - (this._longAt || 0) < 500) return; // fine di uno spostamento: non è un tocco
        this._addonClick(a, el, load);
      });
      wrap.appendChild(el);
      this._bindFloatDrag(id, `addon:${a.id}`);
      this._applyFloat(id, `addon:${a.id}`);
    });
    this._syncDock();
    if (this._nav) this._placePitchCtl();
  }

  // l'add-on è previsto qui? "where": in guida e in pianificazione (both), solo in guida, solo in pianificazione
  _addonHere(a) {
    const g = !!(this._nav && this._isGuida());
    return (a.where || "both") === "both" || (a.where === "guida") === g;
  }

  // elenco sotto il riquadro della velocità: add-on attivi ma chiusi, o spenti, che si possono mostrare in questa vista
  _addonMenu() {
    const wrap = this.$("mapwrap"), box = this.$("spdbox");
    let menu = this.$("addmenu");
    if (menu) { menu.remove(); return; } // secondo tocco: si chiude
    this._addonClosed ||= new Set();
    const view = this._3d ? "3d" : "2d";
    const list = (this._addons || []).filter((a) => a.window.views.includes(view) && this._addonHere(a)
      && (!a.enabled || this._addonClosed.has(a.id)));
    menu = document.createElement("div");
    menu.id = "addmenu"; menu.className = "addmenu";
    menu.innerHTML = list.length
      ? `<div class="mt">🧩 Mostra sulla mappa</div>${list.map((a) => `<button data-a="${esc(a.id)}">${esc(a.window.title || a.name)}${a.enabled ? "" : " <small>(spento)</small>"}</button>`).join("")}`
      : `<div class="mt">🧩 ${(this._addons || []).length ? "Tutti gli add-on sono già sulla mappa" : "Nessun add-on: aggiungili da ⚙ → Add-on"}</div>`;
    const wr = wrap.getBoundingClientRect(), br = box.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(wrap.clientWidth - 230, br.left - wr.left))}px`;
    menu.style.top = `${br.bottom - wr.top + 6}px`;
    wrap.appendChild(menu);
    menu.querySelectorAll("[data-a]").forEach((b) => b.addEventListener("click", async (e) => {
      e.stopPropagation();
      const a = (this._addons || []).find((x) => x.id === b.dataset.a);
      menu.remove();
      if (!a) return;
      this._addonClosed.delete(a.id);
      if (!a.enabled) {
        try { await this._addonCall({ enable: a.id, on: true }); } catch (err) { this._msg(err.message || String(err)); }
      } else this._renderAddons();
    }));
    // tocco altrove: si chiude
    const off = (e) => {
      if (e.composedPath().includes(menu) || e.composedPath().includes(box)) return;
      menu.remove(); this.shadowRoot.removeEventListener("pointerdown", off, true);
    };
    setTimeout(() => this.shadowRoot.addEventListener("pointerdown", off, true), 0);
    setTimeout(() => menu.isConnected || this.shadowRoot.removeEventListener("pointerdown", off, true), 15000);
  }

  // In guida, con almeno un add-on aperto, gli add-on si attaccano alle barre della guida e se ne vede uno alla volta
  // (▲▼ o strisciata su/giù per passare al successivo, in giro):
  // - in verticale: blocco unico con la barra verde in alto, gli add-on sotto e la croce a fianco;
  // - in orizzontale: attaccati sopra la barra in basso, a sinistra (la croce resta al suo posto).
  // Chiusi tutti gli add-on, barre e croce tornano come prima.
  _syncDock() {
    const wrap = this.$?.("mapwrap"), top = this.$?.("navtop"), bot = this.$?.("navbot"), pc = this.$?.("pitchctl");
    if (!wrap || !top || !pc) return;
    // entrando o uscendo dalla guida cambiano gli add-on previsti (solo in guida / solo in pianificazione)
    if (this._addonGuida !== undefined && this._addonGuida !== !!(this._nav && this._isGuida())) { this._renderAddons(); return; }
    let dock = this.$("addock");
    const wins = [...wrap.querySelectorAll(".addwin")];
    const guida = !!(this._nav && this._isGuida() && !top.hidden && wins.length);
    const mode = !guida ? null : window.innerHeight > window.innerWidth ? "top" : bot && !bot.hidden ? "bot" : null;
    if (dock && dock.dataset.mode !== mode) { // via il blocco (o cambia tipo, ruotando il telefono)
      for (const w of wins) {
        w.style.display = ""; wrap.appendChild(w);
        const im = w.querySelector(".aimg img");
        this._addonSize(w);
        w.querySelector(".dkover")?.remove();
      }
      const h = this._pcHome;
      if (h?.parent && pc.parentNode !== h.parent) h.parent.insertBefore(pc, h.next && h.next.parentNode === h.parent ? h.next : null);
      dock.remove(); dock = null;
      top.classList.remove("docked"); bot?.classList.remove("docked");
      if (bot) bot.style.paddingLeft = "";
      this._placeAddons();
    }
    if (!mode) return;
    if (!dock) {
      dock = document.createElement("div");
      dock.id = "addock"; dock.className = `addock ${mode}`; dock.dataset.mode = mode;
      dock.innerHTML = `<div class="alist"></div><div class="across"></div>`;
      wrap.appendChild(dock);
      this._pcHome = { parent: pc.parentNode, next: pc.nextSibling };
      const go = (d) => { this._dockIdx = (this._dockIdx || 0) + d; this._syncDock(); };
      const list0 = dock.querySelector(".alist");
      let y0 = null;
      list0.addEventListener("pointerdown", (e) => { y0 = e.target.closest?.(".alp") ? null : e.clientY; }); // nell'elenco si scorre
      list0.addEventListener("pointerup", (e) => {
        if (y0 != null && Math.abs(e.clientY - y0) > 40) { this._dockSwiped = Date.now(); go(e.clientY < y0 ? 1 : -1); }
        y0 = null;
      });
      list0.addEventListener("click", (e) => { if (Date.now() - (this._dockSwiped || 0) < 400) e.stopPropagation(); }, true);
      dock.addEventListener("click", (e) => { // in cattura: la freccia dentro l'immagine non deve chiudere l'add-on
        const b = e.target.closest?.("[data-dk]");
        if (b) { e.stopPropagation(); go(+b.dataset.dk); }
      }, true);
    }
    const list = dock.querySelector(".alist"), cr = dock.querySelector(".across");
    for (const w of wins) if (w.parentNode !== list) list.appendChild(w);
    if (mode === "top" && pc.parentNode !== cr) cr.insertBefore(pc, cr.firstChild);
    const n = wins.length, k = (((this._dockIdx || 0) % n) + n) % n;
    wins.forEach((w, i) => { w.style.display = i === k ? "" : "none"; });
    let nav = cr.querySelector(".dknav");
    nav?.remove(); // le frecce ora stanno sopra l'immagine, in verticale e in orizzontale
    cr.hidden = mode === "bot";
    // in orizzontale: tasti piccoli SOPRA l'immagine, sul suo bordo: in alto a sinistra l'icona che cicla i formati (col
    // nome del formato, piccolo), a destra ▲▼ per passare all'add-on successivo
    for (const [i, w] of wins.entries()) {
      w.querySelector(".dkover")?.remove();
      if (i !== k) { if (w.classList.contains("botmode")) this._addonSize(w); continue; }
      w.classList.add("botmode");
      const box = w.querySelector(".aimg");
      let ov = box?.querySelector(".aov");
      if (box && !ov) { ov = document.createElement("div"); ov.className = "aov"; box.appendChild(ov); }
      if (!ov) continue;
      const fmt = w._fmtLabel?.();
      const html = `${fmt ? `<button class="fmt" title="Cambia formato">⟳<small></small></button>` : ""}${n > 1
        ? `<button class="up" data-dk="-1" title="Add-on precedente">▲</button><span class="cnt">${k + 1}/${n}</span><button class="dn" data-dk="1" title="Add-on successivo">▼</button>` : ""}`;
      if (ov.dataset.h !== html) {
        ov.dataset.h = html; ov.innerHTML = html;
        ov.querySelector(".fmt")?.addEventListener("click", (e) => { e.stopPropagation(); w._fmtNext?.(); });
      }
      w._onFmt = () => { const sm = ov.querySelector(".fmt small"); if (sm) sm.textContent = ` ${w._fmtLabel?.() || ""}`; };
      w._onFmt();
    }
    if (mode === "top") {
      top.classList.add("docked");
      const y = top.offsetTop + top.offsetHeight;
      Object.assign(dock.style, { top: `${y}px`, bottom: "", left: `${top.offsetLeft}px`, width: `${top.offsetWidth}px`, height: "" });
      const lim = (bot && !bot.hidden ? bot.offsetTop : wrap.clientHeight) - 8;
      const maxH = Math.max(140, Math.round((lim - y) * 0.75) - 16);
      list.style.maxHeight = `${maxH}px`;
      // l'immagine riempie tutta la larghezza dell'add-on (accanto alla croce), con le sue proporzioni; se sarebbe troppo
      // alta si taglia sopra e sotto
      const w = wins[k], im = w?.querySelector(".aimg img");
      if (im) {
        if (!im.dataset.w) { im.dataset.w = parseFloat(im.style.width) || 240; im.dataset.h = parseFloat(im.style.height) || 160; }
        const W0 = +im.dataset.w, H0 = +im.dataset.h;
        w.style.width = "";
        const iw = Math.max(120, list.clientWidth), ih = Math.min((iw * H0) / W0, maxH);
        im.style.setProperty("width", `${Math.round(iw)}px`, "important"); im.style.setProperty("height", `${Math.round(ih)}px`, "important");
        im.style.setProperty("max-width", "100%", "important");
        this._addonMarker(w, W0 / H0);
      }
    } else {
      bot.classList.add("docked");
      // tutta l'altezza a sinistra: da sotto la barra verde fino al fondo della barra in basso; le scritte della barra
      // in basso cominciano a destra dell'add-on
      const y0 = top.offsetTop + top.offsetHeight + 8, y1 = bot.offsetTop + bot.offsetHeight;
      Object.assign(dock.style, { top: `${y0}px`, bottom: "", left: `${bot.offsetLeft}px`, width: "", maxHeight: "" });
      list.style.maxHeight = "";
      const H = Math.max(80, y1 - y0 - 8); // altezza dell'immagine (dentro i bordi del riquadro)
      const w = wins[k], im = w?.querySelector(".aimg img");
      if (im) {
        if (!im.dataset.w) { im.dataset.w = parseFloat(im.style.width) || 240; im.dataset.h = parseFloat(im.style.height) || 160; }
        const W0 = +im.dataset.w, H0 = +im.dataset.h;
        w.style.width = "";
        // l'immagine riempie tutto il riquadro: alta quanto lo spazio, larga in proporzione ma al massimo il 55% dello
        // schermo (oltre si taglia ai lati, al centro resta quello che conta)
        const iw = Math.min((H * W0) / H0, wrap.clientWidth * 0.55);
        im.style.setProperty("height", `${Math.round(H)}px`, "important"); im.style.setProperty("width", `${Math.round(iw)}px`, "important");
        this._addonMarker(w, W0 / H0);
      }
      dock.style.height = `${H + 8}px`;
      bot.style.paddingLeft = `${dock.offsetWidth + 14}px`;
    }
  }

  // l'add-on torna alla sua grandezza (dopo essere stato rimpicciolito in orizzontale nel blocco della guida)
  // pallino "sei qui" su un'immagine con area fissa: tiene conto del ritaglio quando l'immagine riempie un riquadro di
  // forma diversa (in orizzontale nel blocco della guida)
  _addonMarker(el, ar) {
    const me = el.querySelector(".ame"), img = el.querySelector(".aimg img");
    if (!me || !img || me.dataset.fx == null) return;
    const bw = img.clientWidth, bh = img.clientHeight, fx = +me.dataset.fx, fy = +me.dataset.fy;
    if (!bw || !bh) return;
    let rw = bw, rh = bw / ar;
    if (rh < bh) { rh = bh; rw = bh * ar; }
    const x = (bw - rw) / 2 + fx * rw, y = (bh - rh) / 2 + fy * rh;
    me.style.display = x >= 0 && x <= bw && y >= 0 && y <= bh ? "" : "none";
    me.style.left = `${x.toFixed(1)}px`; me.style.top = `${y.toFixed(1)}px`;
  }

  _addonSize(w) {
    if (w.classList.contains("botmode")) {
      w.classList.remove("botmode");
      w.querySelector(".aov")?.remove();
      w._onFmt = null;
    }
    const im = w.querySelector(".aimg img"), bt = w.querySelector(".abtns");
    if (im?.dataset.w) {
      im.style.removeProperty("width"); im.style.removeProperty("height"); im.style.removeProperty("max-width");
      im.style.width = `${im.dataset.w}px`; im.style.height = `${im.dataset.h}px`;
      if (bt) bt.style.maxWidth = `${im.dataset.w}px`;
      const ar = +im.dataset.w / +im.dataset.h;
      requestAnimationFrame(() => this._addonMarker(w, ar));
      delete im.dataset.w; delete im.dataset.h;
    }
    w.style.width = "";
  }

  _placeAddons() {
    for (const a of this._addons || []) {
      const el = this.$(`addon-${a.id}`);
      if (el && !el.closest(".addock")) this._applyFloat(`addon-${a.id}`, `addon:${a.id}`);
    }
  }

  // dati che un add-on può usare negli indirizzi, scritti fra graffe: {lat} {lon} (la tua posizione in guida, altrimenti
  // il centro della mappa), {bbox} {bbox_xy} {lat_min} {lat_max} {lon_min} {lon_max} (zona intorno, metà altezza
  // window.area_km, larghezza secondo la forma dell'immagine), {zoom}, {speed} (km/h), {heading} (gradi),
  // {dest_lat} {dest_lon} {dest_name} (arrivo del percorso), {left_km} {left_min} (quanto manca, in guida)
  _addonVars(w) {
    const f = this._nav?.fix;
    let lat, lon, zoom;
    if (f) { lat = f.lat; lon = f.lon; }
    else if (this._3d && this._g3) { const c = this._g3.getCenter(); lat = c.lat; lon = c.lng; }
    else if (this._map) { const c = this._map.getCenter(); lat = c.lat; lon = c.lng; }
    zoom = Math.round(this._3d && this._g3 ? this._g3.getZoom() : this._map?.getZoom() || 10);
    const v = { zoom };
    if (lat != null) {
      const hl = (w.area_km || 100) / 111.32;
      const hw = (hl * ((w.width || 240) / (w.height || 160))) / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
      const r = (x) => (+x).toFixed(4);
      Object.assign(v, { lat: r(lat), lon: r(lon), lat_min: r(lat - hl), lat_max: r(lat + hl), lon_min: r(lon - hw), lon_max: r(lon + hw) });
      v.bbox = `${v.lat_min},${v.lon_min},${v.lat_max},${v.lon_max}`;
      v.bbox_xy = `${v.lon_min},${v.lat_min},${v.lon_max},${v.lat_max}`;
      v._pos = [lat, lon];
    }
    v.speed = f?.speed != null ? Math.round(f.speed * 3.6) : "";
    v.heading = this._nav?.dir != null ? Math.round(this._nav.dir) : "";
    const dest = this._points?.length > 1 ? this._points[this._points.length - 1] : null;
    v.dest_lat = dest ? (+dest.lat).toFixed(4) : ""; v.dest_lon = dest ? (+dest.lon).toFixed(4) : "";
    v.dest_name = dest?.name || "";
    const rt = this._result?.routes?.[this._sel];
    if (this._nav?.snap && rt) {
      const g = this._geom(rt), tot = g._cum[g._cum.length - 1], left = Math.max(0, tot - this._nav.snap.along);
      v.left_km = (left / 1000).toFixed(1);
      v.left_min = Math.round((rt.summary.time * left) / Math.max(1, tot) / 60);
    } else { v.left_km = ""; v.left_min = ""; }
    return v;
  }

  // dati per i segnaposto: posizione e percorso più le impostazioni scelte per l'add-on (es. {player})
  _addonVarsA(a) {
    return { ...this._addonVars(a.window), ...(a.values || {}) };
  }

  _addonFillDeep(obj, v) {
    return JSON.parse(JSON.stringify(obj || {}), (k, x) => (typeof x === "string" ? this._addonFill(x, v) : x));
  }

  async _addonButton(a, el, b) {
    if (!b) return;
    const v = this._addonVarsA(a);
    if (b.list) { this._addonList(a, el, b); return; }
    if (b.service) {
      const [dom, svc] = b.service.split(".");
      try { await this._hass.callService(dom, svc, this._addonFillDeep(b.data, v)); }
      catch (err) { this._msg(`${a.name}: ${err.message || err}`); }
    }
  }

  // elenco dentro l'add-on: contenuti di un lettore sfogliati come nel pannello Media di Home Assistant (es. le
  // playlist di Music Assistant); una voce che si può riprodurre parte sul lettore, una cartella si apre
  async _addonList(a, el, b, at = null) {
    const box = el.querySelector(".aimg");
    if (!box) return;
    const v = this._addonVarsA(a);
    const ent = this._addonFill(b.list.browse, v);
    let pane = box.querySelector(".alp");
    if (!pane) { pane = document.createElement("div"); pane.className = "alp"; box.appendChild(pane); }
    pane.innerHTML = `<div class="alh"><span>${esc(b.label || "Elenco")}</span><button data-x title="Chiudi">✕</button></div><div class="all">Carico…</div>`;
    pane.addEventListener("click", (e) => e.stopPropagation()); // dentro l'elenco il tocco non chiude l'add-on
    pane.querySelector("[data-x]").addEventListener("click", () => pane.remove());
    const list = pane.querySelector(".all");
    try {
      if (!this._hass.states?.[ent]) throw new Error("scegli il lettore nelle impostazioni dell'add-on (⚙ → Add-on)");
      const browse = (node) => this._hass.callWS({ type: "media_player/browse_media", entity_id: ent,
        ...(node ? { media_content_id: node.media_content_id, media_content_type: node.media_content_type } : {}) });
      let node = await browse(at);
      if (!at) {
        for (const want of b.list.path || []) { // es. ["Playlists"]: si entra nelle cartelle con quel nome
          const w = want.toLowerCase();
          const next = (node.children || []).find((c) => (c.title || "").toLowerCase() === w)
            || (node.children || []).find((c) => (c.title || "").toLowerCase().includes(w));
          if (!next) throw new Error(`"${want}" non trovato nel lettore`);
          node = await browse(next);
        }
      }
      const items = node.children || [];
      if (!items.length) { list.textContent = "Vuoto"; return; }
      list.innerHTML = items.map((c, i) => `<button data-i="${i}">${c.thumbnail ? `<img src="${esc(c.thumbnail)}" alt="">` : "<i>🎵</i>"}<span>${esc(c.title || "")}</span></button>`).join("");
      list.querySelectorAll("[data-i]").forEach((btn) => btn.addEventListener("click", async () => {
        const c = items[+btn.dataset.i];
        if (c.can_play) {
          try {
            await this._hass.callService("media_player", "play_media", { entity_id: ent, media_content_id: c.media_content_id, media_content_type: c.media_content_type });
            pane.remove();
          } catch (err) { this._msg(`${a.name}: ${err.message || err}`); }
        } else if (c.can_expand) {
          this._addonList(a, el, { ...b, label: c.title }, c);
        }
      }));
    } catch (err) {
      list.textContent = `Non disponibile: ${err.message || err}`;
    }
  }

  // stato di Home Assistant cambiato: aggiorna gli add-on che mostrano un'entità (copertina e titolo del brano)
  _addonHass() {
    if (this._addonHassT) return;
    this._addonHassT = setTimeout(() => {
      this._addonHassT = null;
      this.$?.("mapwrap")?.querySelectorAll(".addwin").forEach((el) => el._entityTick?.());
    }, 400);
  }

  _addonFill(u, v) {
    return u.replace(/\{(\w+)\}/g, (m, k) => (k in v && k[0] !== "_" ? (k === "dest_name" ? encodeURIComponent(v[k]) : String(v[k])) : m));
  }

  async _addonClick(a, el, reload) {
    const c = a.window.click;
    if (c === "none") return;
    if (c === "refresh") { reload(); return; }
    if (c?.open) { window.open(this._addonFill(c.open, this._addonVars(a.window)), "_blank", "noopener"); return; }
    if (c?.service) {
      const [dom, svc] = c.service.split(".");
      try { await this._hass.callService(dom, svc, c.data || {}); this._msg(`${a.name}: fatto`); }
      catch (err) { this._msg(`${a.name}: ${err.message || err}`); }
      return;
    }
    // "close": si chiude fino al prossimo avvio (o a "Mostra di nuovo" nelle impostazioni)
    this._addonClosed.add(a.id);
    clearInterval(el._timer);
    el.remove();
    this._syncDock(); // ultimo add-on chiuso in guida: barra e croce tornano separate
    if (this._nav) this._placePitchCtl();
  }

  // ----------------------------------------------------------------- garage

  async _loadGarage() {
    try {
      const r = await this._hass.callWS({ type: "navigator/garage" });
      this._garage = r.vehicles || [];
      // il veicolo scelto l'ultima volta da questo utente di Home Assistant (anche su un altro dispositivo)
      if (r.selected && this._vehicles().some((v) => v.id === r.selected)) {
        try { localStorage.setItem(`${STORE_KEY}-veh`, r.selected); } catch (e) { /* storage non disponibile */ }
        this._vehSel = r.selected;
      }
    } catch (e) { this._garage = []; }
    this._renderPlanSel();
    if (this._result) this._renderResults();
    this._carAutoSelect();
    this._syncSplashes();
    // schermo dell'auto: qualche secondo per riconoscere l'auto (Bluetooth), poi eventualmente la scelta del veicolo
    if (window.NaviHAApp?.isCar?.() && !this._vehAsked) setTimeout(() => this._carVehiclePick(), 3000);
  }

  // Solo sullo schermo dell'auto, all'avvio: se nel garage ci sono veicoli e nessuno è associato a quest'auto,
  // elenco dei veicoli (frecce per scegliere, tocco per confermare: il veicolo resta associato a quest'auto).
  // ✕: si va con "Base". Non compare senza veicoli, se l'auto è già associata o se il riquadro è già stato usato.
  _carVehiclePick(force = false) {
    if (this._vehAsked || this._nav) return;
    const list = (this._garage || []).filter((v) => v.type);
    const car = this._carInfo();
    // auto non ancora riconosciuta (il Bluetooth può arrivare dopo): si aspetta, al più 35 s, poi si chiede comunque
    if (!car?.key && !force) {
      if (!this._vehPickT) this._vehPickT = setTimeout(() => this._carVehiclePick(true), 35000);
      return;
    }
    clearTimeout(this._vehPickT);
    if (!list.length || (car?.key && list.some((v) => v.car === car.key))) return;
    this._vehAsked = true;
    const el = this.$("vehpop");
    if (!el) return;
    let sel = Math.max(0, list.findIndex((v) => v.id === this._vehicleId()));
    const pick = (id) => {
      el.hidden = true;
      const box = this.$("navveh");
      if (box) box.value = id;
      this._vehSel = id;
      try { localStorage.setItem(`${STORE_KEY}-veh`, id); } catch (e) { /* storage non disponibile */ }
      this._hass.callWS({ type: "navigator/garage_select", vehicle_id: id }).catch(() => { /* integrazione vecchia */ });
      this._renderPlanSel();
      this._applyVehicle(true);
      if (this._result) this._renderResults();
      this._syncSplashes();
      if (id !== "base") this._carReassign(id);
    };
    const draw = () => {
      el.innerHTML = `<div class="adh">🚗 <span>Con che veicolo sei?</span>
          <button data-v="up" title="Su">▲</button><button data-v="down" title="Giù">▼</button><button data-v="x" title="Chiudi: Base">✕</button></div>
        <div class="adl">${list.map((v, i) => `<div class="adi${i === sel ? " sel" : ""}" data-i="${i}"><span class="vs">${vehicleSvg(v)}</span>
          <span class="nm">${esc(v.name || "Veicolo")}</span><small>${esc(v.plate || "")}</small></div>`).join("")}</div>`;
      el.querySelector('[data-v="x"]').onclick = () => pick("base");
      el.querySelector('[data-v="up"]').onclick = () => { sel = (sel - 1 + list.length) % list.length; draw(); };
      el.querySelector('[data-v="down"]').onclick = () => { sel = (sel + 1) % list.length; draw(); };
      el.querySelectorAll(".adi").forEach((it) => { it.onclick = () => pick(list[+it.dataset.i].id); });
      el.querySelector(".adi.sel")?.scrollIntoView({ block: "nearest" });
    };
    draw();
    el.hidden = false;
  }

  // veicoli: "Base" (il mezzo si sceglie con i bottoni Auto/Moto/Bici/A piedi) e poi quelli del garage
  _vehicles() {
    return [{ id: "base", name: "Base", plate: "", type: "" }, ...(this._garage || [])];
  }

  _curVehicle() {
    return this._vehicles().find((v) => v.id === this._vehicleId()) || this._vehicles()[0];
  }

  // disegno del veicolo sulla mappa: quello del veicolo del garage, altrimenti quello del mezzo
  _vehSvg() {
    const v = this._curVehicle();
    return v.type ? vehicleSvg(v) : uniqSvg(VEHICLE_SVG[this._mode] || CAR_SVG);
  }

  // veicolo scelto: con uno del garage i bottoni del mezzo spariscono e il mezzo viene dal tipo di veicolo
  _applyVehicle(recompute = false) {
    const v = this._curVehicle();
    const modes = this.$("modes");
    if (modes) modes.hidden = !!v.type;
    const prev = this.$("vehsec")?.querySelector(".vprev");
    if (prev) prev.innerHTML = v.type ? vehicleSvg(v) : "";
    if (v.type) {
      const mode = VEH_TYPE_MODE[v.type] || "auto";
      if (mode !== this._mode) {
        this._mode = mode;
        this._renderModes();
        this._saveState();
        if (recompute) this._autoCompute();
      }
    }
    this._drawMarkers();
  }

  _vehicleId() {
    let id = this._vehSel || null;
    try { id = id || localStorage.getItem(`${STORE_KEY}-veh`); } catch (e) { /* storage non disponibile */ }
    const list = this._vehicles();
    return list.some((v) => v.id === id) ? id : list[0].id;
  }

  // auto collegata secondo l'app NaviHA ({key, label}) o null
  _carInfo() {
    try { const s = window.NaviHAApp?.carInfo?.(); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }

  // collegandosi a un'auto associata a un veicolo del garage, quel veicolo diventa quello scelto
  _carAutoSelect() {
    const c = this._carInfo();
    if (c?.key && (this._garage || []).some((x) => x.car === c.key)) { const vp = this.$("vehpop"); if (vp) vp.hidden = true; }
    else if (c?.key && this._vehPickT && !this._vehAsked) this._carVehiclePick(); // riconosciuta adesso: si chiede subito
    if (!c?.key || this._carSelKey === c.key || !this._garage) return;
    this._carSelKey = c.key;
    const v = this._garage.find((x) => x.car === c.key);
    if (!v || this._vehicleId() === v.id) return;
    this._vehSel = v.id;
    try { localStorage.setItem(`${STORE_KEY}-veh`, v.id); } catch (e) { /* storage non disponibile */ }
    this._hass.callWS({ type: "navigator/garage_select", vehicle_id: v.id }).catch(() => { /* integrazione vecchia */ });
    this._renderPlanSel();
    this._applyVehicle(true);
    if (this._result) this._renderResults();
    this._syncSplashes();
    this._msg(`Veicolo: ${v.name || "dal garage"} (auto collegata)`);
  }

  // veicolo scelto a mano mentre si è collegati a un'auto: da ora è quello di quest'auto (l'abbinamento passa a lui).
  // "Base" non cambia l'abbinamento.
  async _carReassign(id) {
    const car = this._carInfo();
    const v = (this._garage || []).find((x) => x.id === id);
    if (!car?.key || !v || v.car === car.key) return;
    const l = this._garage.map((x) => ({ ...x }));
    for (const x of l) if (x.car === car.key) { delete x.car; delete x.carName; }
    const t = l.find((x) => x.id === id);
    t.car = car.key;
    t.carName = car.label || "";
    this._carSelKey = car.key;
    await this._saveGarage(l);
    this._msg(`${v.name || "Veicolo"} associato a quest'auto: la prossima volta si sceglie da solo`);
  }

  // loghi di avvio mandati all'app NaviHA, che li mostra sull'auto prima che il pannello sia pronto
  _syncSplashes() {
    if (!window.NaviHAApp?.setSplashes) return;
    const src = (v) => {
      if (!v?.type || !v.splash) return "";
      if (v.splash.startsWith("data:")) return v.splash;
      let svg = vehicleSvg(v);
      if (!/xmlns=/.test(svg)) svg = svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
      if (!/<svg[^>]*\swidth=/.test(svg)) svg = svg.replace("<svg", '<svg width="512" height="512"');
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    };
    const cars = {};
    for (const v of this._garage || []) if (v.car) cars[v.car] = src(v) || "navigator";
    try { window.NaviHAApp.setSplashes(JSON.stringify({ def: src(this._curVehicle()), cars })); } catch (e) { /* app vecchia */ }
  }

  // immagine scelta per il logo: ridotta (lato massimo 360 px) e salvata come dati nel garage
  async _splashImage(file) {
    if (!/^image\//.test(file.type) || file.size > 15e6) return null;
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ko; i.src = url; });
      const k = Math.min(1, 360 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      let data = c.toDataURL("image/png");
      if (data.length > 280000) data = c.toDataURL("image/jpeg", 0.85);
      return data.length <= 280000 ? data : null;
    } catch (e) { return null; } finally { URL.revokeObjectURL(url); }
  }

  async _saveGarage(list) {
    try {
      this._garage = (await this._hass.callWS({ type: "navigator/garage_save", vehicles: list })).vehicles;
    } catch (e) {
      this._msg(`Garage non salvato: ${e.message || e}`);
    }
    this._syncSplashes();
    this._renderPlanSel();
    if (this._result) this._renderResults();
  }

  _garageHtml() {
    const car = this._carInfo();
    const rows = (this._garage || []).map((v, k) => {
      const icons = vehIconsFor(v.type);
      const ic = icons.includes(v.icon) ? v.icon : VEH_TYPE_ICON[v.type] || "suv";
      const col = okColor(v.color) ? v.color : VEH_ICONS[ic][2];
      return `<div class="garv">
        <div class="gprev" data-gp="${k}" title="Anteprima sulla mappa">${vehicleSvg({ ...v, icon: ic, color: col })}</div>
        <div class="gf">
          <div class="row" style="gap:6px;align-items:center">
            <select data-g="type" data-k="${k}" style="width:auto">${VEHICLE_TYPES.map(([t, ico, n]) => `<option value="${t}" ${v.type === t ? "selected" : ""}>${ico} ${n}</option>`).join("")}</select>
            <select data-g="icon" data-k="${k}" style="flex:1;min-width:110px" title="Disegno sulla mappa">${icons.map((i) => `<option value="${i}" ${i === ic ? "selected" : ""}>${VEH_ICONS[i][0]}</option>`).join("")}</select>
            <input type="color" data-g="color" data-k="${k}" value="${col}" title="Colore${ic === "suv" ? " (cambia solo il blu)" : ""}">
            ${ic === "utilitaria" ? `<select data-g="sunroof" data-k="${k}" style="width:auto" title="Tetto nel modello 3D">
              <option value="" ${v.sunroof !== "no" ? "selected" : ""}>Tettuccio in vetro</option>
              <option value="no" ${v.sunroof === "no" ? "selected" : ""}>Tetto pieno</option></select>` : ""}
          </div>
          <div class="row" style="gap:6px;align-items:center;margin-top:6px">
            <input class="inp" data-g="name" data-k="${k}" placeholder="Nome (es. Panda)" value="${esc(v.name)}" style="flex:1;min-width:90px">
            <input class="inp" data-g="plate" data-k="${k}" placeholder="Targa" value="${esc(v.plate)}" style="width:100px;text-transform:uppercase">
            <button class="icon" data-g="del" data-k="${k}" title="Elimina">✕</button>
          </div>
          <div class="row gextra">
            <label>Logo all'avvio in auto <select data-g="splash" data-k="${k}">
              <option value="navigator" ${!v.splash ? "selected" : ""}>Navigator</option>
              <option value="veicolo" ${v.splash === "veicolo" ? "selected" : ""}>Disegno del veicolo</option>
              ${v.splash?.startsWith("data:") ? '<option value="custom" selected>Immagine scelta</option>' : ""}</select></label>
            ${v.splash?.startsWith("data:") ? `<img class="gsplash" src="${v.splash}" alt="">` : ""}
            <label class="gfile" title="Scegli un'immagine dal telefono">🖼 Immagine…<input type="file" accept="image/*" data-g="splashfile" data-k="${k}"></label>
          </div>
          <div class="row gextra">🚗 ${v.car ? `Auto: <b>${esc(v.carName || v.car)}</b>
            <button class="link" data-g="carunlink" data-k="${k}">Togli</button>` : "Nessuna auto associata"}
            ${car && car.key !== v.car ? `<button class="link" data-g="carlink" data-k="${k}">Associa all'auto collegata (${esc(car.label || "auto")})</button>` : ""}
          </div>
        </div></div>`;
    }).join("");
    return `<div class="grp"><h3>Garage</h3>
      <div class="note">Garage <b>condiviso</b> da tutti gli utenti di Home Assistant: chiunque può aggiungere o modificare i veicoli.
        Scegli disegno e colore che vedrai sulla mappa; alla partenza ognuno sceglie il suo nel menu Veicolo (la scelta resta per
        ogni utente) e il diario dei viaggi lo ricorda. Con "Base" il mezzo si sceglie con i bottoni.<br>
        Con l'app <b>NaviHA</b> e Android Auto: associando un veicolo all'auto (riconosciuta dal suo Bluetooth o da marca e modello)
        quel veicolo si sceglie da solo quando ti colleghi, e sullo schermo dell'auto all'avvio compare il suo logo.</div>
      ${rows}<button data-g="add">＋ Aggiungi veicolo</button></div>`;
  }

  _bindGarage(wrap) {
    const list = () => (this._garage || []).map((v) => ({ ...v }));
    wrap.querySelectorAll("[data-g]").forEach((el) => {
      const g = el.dataset.g;
      if (g === "add") {
        el.addEventListener("click", async () => {
          await this._saveGarage([...list(), { name: `Veicolo ${(this._garage || []).length + 1}`, plate: "", type: this._mode === "moto" ? "moto" : "auto" }]);
          this._openSettings();
        });
      } else if (g === "del") {
        el.addEventListener("click", async () => {
          const l = list();
          l.splice(+el.dataset.k, 1);
          await this._saveGarage(l);
          this._openSettings();
        });
      } else if (g === "carlink" || g === "carunlink") {
        el.addEventListener("click", async () => {
          const k = +el.dataset.k;
          const l = list();
          const car = this._carInfo();
          if (g === "carlink" && car) {
            for (const x of l) if (x.car === car.key) { delete x.car; delete x.carName; } // un'auto, un veicolo
            l[k].car = car.key;
            l[k].carName = car.label || "";
          } else { delete l[k].car; delete l[k].carName; }
          await this._saveGarage(l);
          this._openSettings();
        });
      } else if (g === "splashfile") {
        el.addEventListener("change", async () => {
          const f = el.files?.[0];
          if (!f) return;
          const data = await this._splashImage(f);
          if (!data) { this._msg("Immagine non valida o troppo grande"); return; }
          const l = list();
          l[+el.dataset.k].splash = data;
          await this._saveGarage(l);
          this._openSettings();
        });
      } else if (g === "splash") {
        el.addEventListener("change", async () => {
          const k = +el.dataset.k;
          if (el.value === "custom") return;
          const l = list();
          if (el.value === "veicolo") l[k].splash = "veicolo"; else delete l[k].splash;
          await this._saveGarage(l);
          this._openSettings();
        });
      } else {
        const k = +el.dataset.k;
        // anteprima colorata subito, mentre si sceglie il colore
        if (g === "color") el.addEventListener("input", () => {
          const prev = wrap.querySelector(`[data-gp="${k}"]`);
          const v = (this._garage || [])[k];
          if (prev && v) prev.innerHTML = vehicleSvg({ ...v, icon: wrap.querySelector(`[data-g="icon"][data-k="${k}"]`)?.value, color: el.value });
        });
        el.addEventListener("change", async () => {
          const l = list();
          l[k][g] = el.value;
          // cambiando tipo o disegno si riparte dal disegno e dal colore predefiniti
          if (g === "type") { delete l[k].icon; delete l[k].color; }
          if (g === "icon") l[k].color = VEH_ICONS[el.value]?.[2];
          await this._saveGarage(l);
          if (g === "type" || g === "icon") this._openSettings();
        });
      }
    });
  }

  // ----------------------------------------------------------------- modalità notte
  // automatica col sole di Home Assistant (sotto l'orizzonte), sempre o mai: mappa scura, satellite attenuato, 3D notturno

  _isNight() {
    // lampadina: scelta momentanea, vale fino al prossimo tramonto/alba, poi torna l'impostazione
    const o = this._settings.nightOverride;
    if (o && Date.now() < o.until) return !!o.on;
    const m = this._settings.nightMode || "auto";
    if (m === "on") return true;
    if (m === "off") return false;
    return this._hass?.states?.["sun.sun"]?.state === "below_horizon";
  }

  // mappa da mostrare: di notte stradale e topografica diventano la scura (la scelta salvata non cambia)
  _effLayer(key) {
    return this._nightOn && (key === "strade" || key === "topo") ? "scura" : key;
  }

  _basePaint() {
    // deserto: verde → sabbia (rotazione del colore), meno saturo e con le ombre schiarite, come dune
    // (in 3D: foto in bianco e nero, il colore sabbia lo dà il velo "desert" steso sopra)
    const desert = this._layer === "deserto"
      ? { "raster-saturation": -1, "raster-contrast": -0.15, "raster-brightness-min": 0.3 } : {}; // alberi scuri → roccia
    const dim = this._nightOn && ["sat", "deserto", "otm"].includes(this._layer) ? { "raster-brightness-max": 0.6, "raster-saturation": -0.2 } : {};
    return { ...desert, ...dim, ...(desert["raster-saturation"] ? { "raster-saturation": -1 } : {}) };
  }

  _skySpec() {
    return this._nightOn
      ? { "sky-color": "#0b1630", "horizon-color": "#1d2b4f", "fog-color": "#0e1526", "sky-horizon-blend": 0.6,
        "horizon-fog-blend": 0.5, "fog-ground-blend": 0.85, "atmosphere-blend": 0.4 }
      : { "sky-color": "#8cc3f0", "horizon-color": "#dcebf7", "fog-color": "#f2f2f2", "sky-horizon-blend": 0.6,
        "horizon-fog-blend": 0.5, "fog-ground-blend": 0.85, "atmosphere-blend": 0.6 };
  }

  _applyNight() {
    if (!this._map) return;
    const n = this._isNight();
    if (n === this._nightOn) return;
    this._nightOn = n;
    this._syncNightBtn();
    this.$("map").classList.toggle("night", n);
    if (this._layer) this._setLayer(this._layer);
    if (this._g3 && this._g3ok) {
      this._bldApplied = null; // edifici e finestre di nuovo, con i colori della notte
      this._apply3dSettings();
    }
  }

  // ----------------------------------------------------------------- punti di interesse sulla mappa
  // Da OpenStreetMap (Overpass, dal backend) a riquadri di 0,02°: si chiedono solo i riquadri della zona visibile, da vicino,
  // e restano in memoria. In 2D icone colorate; in 3D l'edificio del punto colorato e sopra l'icona che fluttua.

  _schedulePois() {
    clearTimeout(this._poiT);
    this._poiT = setTimeout(() => this._loadPois(), 700);
  }

  _poiKindsOn() {
    return new Set((this._settings.poiKinds || []).filter((k) => POI_KINDS[k]));
  }

  // autovelox della zona visibile (con margine): si richiedono solo uscendo dalla zona già scaricata
  async _loadCamPois() {
    const b = this._map.getBounds();
    const have = this._camBox;
    if (have && b.getSouth() >= have.s && b.getNorth() <= have.n && b.getWest() >= have.w && b.getEast() <= have.e) return;
    if (this._camLoading) return;
    this._camLoading = true;
    const dy = (b.getNorth() - b.getSouth()) * 0.75, dx = (b.getEast() - b.getWest()) * 0.75;
    const box = { s: b.getSouth() - dy, n: b.getNorth() + dy, w: b.getWest() - dx, e: b.getEast() + dx };
    try {
      const r = await this._hass.callWS({ type: "navigator/cameras_area", ...box });
      this._camPois = (r.items || []).map((x) => ({ id: x.id, lat: x.lat, lon: x.lon, k: "autovelox",
        name: `Autovelox${x.maxspeed ? ` ${x.maxspeed} km/h` : ""}${x.name ? ` · ${x.name}` : ""}` }));
      this._camBox = box;
      console.debug("[Navigator POI] autovelox nella zona:", this._camPois.length);
    } catch (e) {
      console.debug("[Navigator POI] autovelox non disponibili:", e?.message || e);
    }
    this._camLoading = false;
    this._poiKey = null;
    this._renderPois();
  }

  async _loadPois() {
    const m = this._map;
    if (!m || !this._poiTiles) return;
    if (!this._poiKindsOn().size) { this._poiStatus(""); this._renderPois(); return; }
    if (this._poiKindsOn().has("autovelox") && this._poiZoom() >= POI_MIN_ZOOM) this._loadCamPois();
    // in 2D: i riquadri z14 di OpenFreeMap (gli stessi del 3D) letti dal browser; Overpass solo se OpenFreeMap non risponde
    if (!this._3d && !this._ofmDown) {
      if (await this._loadOfmPois()) return;
    }
    // in 3D i punti arrivano con le mappe di OpenFreeMap (subito, dal browser): niente Overpass. Da lontano le mappe del 3D
    // sono meno dettagliate (pochi punti): si leggono anche i riquadri dettagliati (z14) della zona vicina, come in 2D
    if (this._3d && this._g3ok && this._g3?.getSource("ofm")) {
      const near = this._poiZoom() >= POI_MIN_ZOOM;
      if (near && !this._ofmDown) { try { await this._loadOfmPois(); } catch (e) { /* restano quelli delle mappe 3D */ } }
      this._poiStatus(near ? "" : "far");
      this._renderPois();
      console.debug("[Navigator POI] 3D: punti dalle mappe di OpenFreeMap", this._poiShown?.length || 0);
      return;
    }
    if (this._poiZoom() < POI_MIN_ZOOM) {
      this._poiStatus("far");
      this._renderPois();
      return;
    }
    const b = m.getBounds();
    const c = m.getCenter();
    const tiles = [];
    for (let x = Math.floor(b.getWest() / POI_TILE); x <= Math.floor(b.getEast() / POI_TILE); x++) {
      for (let y = Math.floor(b.getSouth() / POI_TILE); y <= Math.floor(b.getNorth() / POI_TILE); y++) {
        tiles.push({ x, y, d: Math.hypot((x + 0.5) * POI_TILE - c.lng, (y + 0.5) * POI_TILE - c.lat) });
      }
    }
    tiles.sort((a, z) => a.d - z.d);
    this._poiView = tiles.slice(0, 9).map((t) => `${t.x},${t.y}`);
    this._renderPois();
    const view = this._poiView;
    const fresh = (t) => t && ((t.items && !(t.partial && Date.now() - t.at > 120000)) || t.pending || Date.now() - (t.failed || 0) < 60000);
    const todo = view.filter((key) => !fresh(this._poiTiles.get(key)));
    if (todo.length) this._poiStatus("loading");
    else this._poiStatusAfter();
    if (todo.length) {
      // una sola richiesta per tutti i riquadri mancanti (il backend li divide e li tiene in memoria)
      for (const key of todo) this._poiTiles.set(key, { pending: true });
      this._poiReqStart = Date.now();
      const kindsReq = [...this._poiKindsOn()];
      console.info("[Navigator POI] richiesta", { zone: todo, categorie: kindsReq, zoom: this._map.getZoom(), "3d": !!this._3d });
      try {
        // al massimo 45 s: oltre, errore e Riprova (il backend si arrende prima, con la riserva di Photon)
        const r = await Promise.race([
          this._hass.callWS({ type: "navigator/poi_tiles", tiles: todo.map((k) => k.split(",").map(Number)), kinds: [...this._poiKindsOn()] }),
          new Promise((_, ko) => setTimeout(() => ko({ message: "nessuna risposta da Home Assistant in 45 s" }), 45000)),
        ]);
        for (const t of r.tiles || []) this._poiTiles.set(`${t.x},${t.y}`, { items: t.items || [], partial: !!t.partial, at: Date.now() });
        for (const key of todo) if (this._poiTiles.get(key)?.pending) this._poiTiles.set(key, { items: [], at: Date.now() }); // non restituita
        this._poiReason = r.partial ? r.reason : "";
        const per = {};
        for (const t of r.tiles || []) for (const it of t.items || []) per[it.k] = (per[it.k] || 0) + 1;
        console.info(`[Navigator POI] risposta in ${Date.now() - this._poiReqStart} ms`, { fonte: r.debug?.source, parziale: !!r.partial,
          motivo: r.reason || "", perCategoria: per, server: r.debug || "(integrazione senza dettagli)" });
      } catch (e) {
        console.warn(`[Navigator POI] errore dopo ${Date.now() - this._poiReqStart} ms`, e);
        for (const key of todo) this._poiTiles.set(key, { failed: Date.now(), error: e }); // si riprova fra un minuto
      }
      this._renderPois();
    }
    this._poiStatusAfter(); // sempre: prima, dopo un movimento della mappa, l'etichetta restava su "Carico…"
  }

  // dopo il caricamento: errore (con Riprova), "nessun punto" per qualche secondo, oppure niente
  _poiStatusAfter() {
    const tiles = (this._poiView || []).map((k) => this._poiTiles.get(k)).filter(Boolean);
    if (tiles.some((t) => t.pending)) { this._poiStatus("loading"); return; }
    if (tiles.some((t) => t.partial)) {
      this._poiStatus("partial", this._poiReason || "");
      return;
    }
    const failed = tiles.find((t) => t.failed);
    if (failed && !tiles.some((t) => t.items?.length)) {
      const e = failed.error || {};
      const unknown = /unknown command|unknown_command/i.test(`${e.code || ""} ${e.message || ""}`);
      this._poiStatus("error", unknown ? "aggiorna l'integrazione Navigator e riavvia Home Assistant" : (e.message || String(e)));
      return;
    }
    this._poiStatus(this._poiItems().length ? "" : "empty");
  }

  // etichetta fissa sulla mappa: cosa succede ai punti di interesse
  _poiStatus(state, detail = "") {
    const el = this.$("poistat");
    if (!el) return;
    clearTimeout(this._poiStatT);
    clearInterval(this._poiTick);
    if (state === "loading") { // i secondi che passano: si vede che sta lavorando
      this._poiTick = setInterval(() => {
        const sp = el.querySelector("span");
        if (sp && this._poiReqStart) sp.textContent = `📍 Carico i punti di interesse… ${Math.round((Date.now() - this._poiReqStart) / 1000)} s`;
      }, 1000);
    }
    const text = { far: "📍 Avvicina la mappa per vedere i punti di interesse", loading: "📍 Carico i punti di interesse…",
      empty: "📍 Nessun punto di interesse in questa zona", error: `⚠ Punti di interesse non caricati: ${esc(detail)}`,
      partial: "⚠ Punti parziali: Overpass non risponde" }[state];
    el.hidden = !text;
    if (!text) return;
    el.innerHTML = `<span title="${esc(detail)}">${text}</span>${state === "error" || state === "partial" ? `<button data-ps="retry">Riprova</button>` : ""}`;
    el.querySelector('[data-ps="retry"]')?.addEventListener("click", () => {
      for (const k of this._poiView || []) { const t = this._poiTiles.get(k); if (t?.failed || t?.partial) this._poiTiles.delete(k); }
      this._loadPois();
    });
    if (state === "empty") this._poiStatT = setTimeout(() => { el.hidden = true; }, 4000);
  }

  // 2D: riquadri z14 di OpenFreeMap della zona visibile (al massimo 12), letti e tenuti in memoria. false = OpenFreeMap non va
  // zoom "alla Leaflet" della vista attuale: in 3D quello della vista 3D (riquadri da 512 px: +1), non della 2D nascosta
  _poiZoom() {
    return this._3d && this._g3 && this._g3ok ? this._g3.getZoom() + 1 : this._map.getZoom();
  }

  async _loadOfmPois() {
    const m = this._map;
    const z = 14;
    const n = 2 ** z;
    // in 3D i limiti della vista 3D (la 2D è nascosta); solo la parte vicina (fino a ~metà altezza), non l'orizzonte
    const g3v = this._3d && this._g3 && this._g3ok;
    const b = g3v ? (() => {
      const cv = this._g3.getCanvas(), w = cv.clientWidth, h = cv.clientHeight;
      const pts = [[0, h * 0.45], [w, h * 0.45], [0, h], [w, h]].map(([x, y]) => this._g3.unproject([x, y]));
      const lo = pts.map((p) => p.lng), la = pts.map((p) => p.lat);
      return { getWest: () => Math.min(...lo), getEast: () => Math.max(...lo), getNorth: () => Math.max(...la), getSouth: () => Math.min(...la) };
    })() : m.getBounds();
    const tx = (lon) => Math.floor(((lon + 180) / 360) * n);
    const ty = (lat) => Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
    const c = g3v ? this._g3.getCenter() : m.getCenter();
    const cx = tx(c.lng);
    const cy = ty(c.lat);
    const tiles = [];
    for (let x = tx(b.getWest()); x <= tx(b.getEast()); x++) for (let y = ty(b.getNorth()); y <= ty(b.getSouth()); y++) tiles.push([x, y]);
    tiles.sort((a, q) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(q[0] - cx, q[1] - cy));
    const want = tiles.slice(0, 12).map(([x, y]) => `${z}/${x}/${y}`);
    this._ofmTiles ??= new Map();
    this._ofmView = want;
    const todo = want.filter((k) => !this._ofmTiles.has(k));
    if (!todo.length) { this._poiStatus(""); this._renderPois(); return true; }
    this._poiReqStart = Date.now();
    this._poiStatus("loading");
    try {
      if (!this._ofmTpl) {
        this._ofmTpl = await ofmTemplate(); // dalla rete o, senza rete, quello ricordato
        if (!this._ofmTpl) throw new Error("TileJSON senza riquadri");
      }
      for (const k of todo) this._ofmTiles.set(k, null); // in corso
      await Promise.all(todo.map(async (k) => {
        const [tz, x, y] = k.split("/").map(Number);
        // dalla memoria del telefono o dalla rete (e si salva)
        const buf = await tileFetch(this._ofmTpl.replace("{z}", tz).replace("{x}", x).replace("{y}", y));
        if (!buf) throw new Error("OpenFreeMap non disponibile");
        const items = [];
        for (const p of mvtPoints(buf, "poi", tz, x, y)) {
          const kind = OFM_POI[p.props.subclass] || OFM_POI[p.props.class];
          if (kind) items.push({ id: `o${p.id ?? `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`}`, lat: p.lat, lon: p.lon, k: kind, name: p.props.name || "" });
        }
        this._ofmTiles.set(k, items);
      }));
      console.info(`[Navigator POI] 2D: OpenFreeMap in ${Date.now() - this._poiReqStart} ms`, { riquadri: todo.length,
        punti: todo.reduce((a, k) => a + (this._ofmTiles.get(k)?.length || 0), 0) });
    } catch (e) {
      for (const k of todo) if (this._ofmTiles.get(k) === null) this._ofmTiles.delete(k);
      console.warn("[Navigator POI] 2D: OpenFreeMap non disponibile, uso Overpass", e);
      this._ofmDown = Date.now();
      setTimeout(() => { this._ofmDown = 0; }, 300000); // riprova OpenFreeMap fra 5 minuti
      return false;
    }
    this._poiKey = null;
    this._renderPois();
    this._poiStatus(this._poiItems().length ? "" : "empty");
    return true;
  }

  // punti da mostrare: categorie scelte, riquadri visibili, al massimo 150 (i più vicini al centro)
  _poiItems() {
    const kinds = this._poiKindsOn();
    if (!kinds.size || this._poiZoom() < POI_MIN_ZOOM) return [];
    const c = this._map.getCenter();
    const out = [];
    const seen = new Set(); // un edificio a cavallo di due riquadri arriva da tutti e due
    const g = this._g3;
    if (this._3d && this._g3ok && g?.getSource("ofm")) {
      let feats = [];
      try { feats = g.querySourceFeatures("ofm", { sourceLayer: "poi" }); } catch (e) { /* dati non pronti */ }
      const b = g.getBounds();
      for (const f of feats) {
        const p = f.properties || {};
        const k = OFM_POI[p.subclass] || OFM_POI[p.class];
        const [lon, lat] = f.geometry?.coordinates || [];
        if (!k || !kinds.has(k) || lat == null || !b.contains([lon, lat])) continue;
        const id = `o${f.id ?? `${lon.toFixed(5)},${lat.toFixed(5)}`}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, lat, lon, k, name: p.name || p["name:it"] || p.name_int || "" });
      }
    }
    if (this._ofmView) { // riquadri dettagliati (z14) letti dal browser: in 2D e, da lontano, anche in 3D
      const g3v = this._3d && this._g3 && this._g3ok;
      const b = g3v ? this._g3.getBounds() : this._map.getBounds().pad(0.1);
      for (const k of this._ofmView) {
        for (const it of this._ofmTiles?.get(k) || []) {
          if (kinds.has(it.k) && !seen.has(it.id) && b.contains(g3v ? [it.lon, it.lat] : [it.lat, it.lon])) { seen.add(it.id); out.push(it); }
        }
      }
    }
    for (const key of this._ofmDown || this._3d ? this._poiView || [] : []) {
      for (const it of this._poiTiles.get(key)?.items || []) {
        if (kinds.has(it.k) && !seen.has(it.id)) { seen.add(it.id); out.push(it); }
      }
    }
    // autovelox fissi: non sono nelle mappe di OpenFreeMap, arrivano dall'elenco del backend (lo stesso degli avvisi in guida)
    if (kinds.has("autovelox") && this._camPois) {
      const b = this._3d && this._g3 ? this._g3.getBounds() : this._map.getBounds().pad(0.1);
      for (const it of this._camPois) if (!seen.has(it.id) && b.contains(this._3d ? [it.lon, it.lat] : [it.lat, it.lon])) { seen.add(it.id); out.push(it); }
    }
    out.sort((a, z) => Math.hypot(a.lat - c.lat, a.lon - c.lng) - Math.hypot(z.lat - c.lat, z.lon - c.lng));
    return out.slice(0, 150);
  }

  _renderPois() {
    const items = this._poiItems();
    const key = `${this._3d ? 3 : 2}|${items.map((i) => i.id).join(",")}`;
    if (key === this._poiKey) return;
    this._poiKey = key;
    this._poiMapLayer.clearLayers();
    this._poi3dMarkers?.forEach((mk) => mk.remove());
    this._poi3dMarkers = [];
    this._poiShown = items;
    this._poiMarkerEl = new Map();
    const open = (it) => this._openPoi(it);
    if (this._3d && this._g3 && window.maplibregl) {
      for (const it of items) {
        const [label, ico, col] = POI_KINDS[it.k];
        const el = document.createElement("div");
        el.className = "poi3d";
        el.title = `${it.name || label} · ${label}`;
        el.innerHTML = `<div class="pi"><div class="pb" style="background:${col}">${ico}</div><div class="ps"></div></div>`;
        el.addEventListener("click", (e) => { e.stopPropagation(); open(it); });
        this._poi3dMarkers.push(new window.maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([it.lon, it.lat]).addTo(this._g3));
      }
      this._poiBuildings();
    } else {
      for (const it of items) {
        const [label, ico, col] = POI_KINDS[it.k];
        const mk = L.marker([it.lat, it.lon], { title: `${it.name || label} · ${label}`,
          icon: L.divIcon({ className: "", html: `<div class="poim" style="background:${col}">${ico}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) })
          .on("click", () => open(it)).addTo(this._poiMapLayer);
        this._poiMarkerEl.set(it.id, mk.getElement());
      }
    }
  }

  // 3D: l'edificio che contiene ciascun punto, ricolorato con il colore della categoria
  _poiBuildings() {
    const g = this._g3;
    if (!this._3d || !g || !this._g3ok || !g.getSource("poi-bld")) return;
    const feats = [];
    const items = this._poiShown || [];
    if (items.length && this._settings.b3d !== false && g.getSource("ofm")) {
      let blds = [];
      try { blds = g.querySourceFeatures("ofm", { sourceLayer: "building" }); } catch (e) { /* edifici non pronti */ }
      const seen = new Set();
      for (const it of items) {
        for (const f of blds) {
          const geom = f.geometry;
          const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
          const hit = polys.find((poly) => pointInRing(it.lon, it.lat, poly[0]));
          if (!hit) continue;
          const k = hit[0].slice(0, 3).map((p) => p.join(",")).join(";");
          if (seen.has(k)) break;
          seen.add(k);
          // un poco più largo (3%) dell'edificio normale: con le pareti coincidenti la scheda video mostrerebbe a caso l'uno o l'altro
          const ring = hit[0];
          const cx = ring.reduce((a, p) => a + p[0], 0) / ring.length;
          const cy = ring.reduce((a, p) => a + p[1], 0) / ring.length;
          const grow = (r) => r.map(([x, y]) => [cx + (x - cx) * 1.03, cy + (y - cy) * 1.03]);
          feats.push({ type: "Feature", properties: { c: POI_KINDS[it.k][2], h: bldHeight(f) },
            geometry: { type: "Polygon", coordinates: [grow(ring)] } });
          break;
        }
      }
    }
    try { g.getSource("poi-bld").setData({ type: "FeatureCollection", features: feats }); } catch (e) { /* vista 3D ricreata */ }
  }

  // frecce del verso di marcia in 2D: una ogni ~90 pixel, solo nella parte visibile (i percorsi lunghi restano leggeri)
  _scheduleArrows() {
    if (this._arrowPending) return;
    this._arrowPending = true;
    requestAnimationFrame(() => { this._arrowPending = false; this._drawArrows(); });
  }

  _drawArrows() {
    const lay = this._arrowLayer;
    if (!lay) return;
    lay.clearLayers();
    const r = this._result;
    if (!r || this._3d) return;
    const rt = this._geom(r.routes[this._sel]);
    const m = this._map;
    const total = rt._cum[rt._cum.length - 1];
    const mpp = (40075016.7 * Math.cos((m.getCenter().lat * Math.PI) / 180)) / (256 * 2 ** m.getZoom());
    const step = Math.max(10, 90 * mpp);
    const view = m.getBounds().pad(0.15);
    let n = 0;
    const from = this._nav?.fix && this._nav.snap ? this._nav.snap.along || 0 : 0; // in guida solo davanti a te
    for (let a = from + step / 2; a < total && n < 250; a += step) {
      const p = this._pointAt(rt, a);
      if (!view.contains(p.ll)) continue;
      n++;
      L.marker(p.ll, { interactive: false, keyboard: false,
        icon: L.divIcon({ className: "", html: `<div class="rarrow" style="transform:rotate(${p.dir.toFixed(0)}deg)"></div>`,
          iconSize: [16, 16], iconAnchor: [8, 8] }) }).addTo(lay);
    }
  }

  _select(i) {
    this._sel = i;
    setTimeout(() => this._loadWeather(), 0);
    this._drawRoute();
    this._renderResults();
  }

  _fit() {
    const pts = [];
    if (this._result) pts.push(...this._result.routes[this._sel].shape);
    else this._points.forEach((p) => p && pts.push([p.lat, p.lon]));
    if (pts.length === 1) this._map.setView(pts[0], 15);
    else if (pts.length) this._map.fitBounds(L.latLngBounds(pts), { padding: [30, 30] });
  }

  _excludeSegment(seg) {
    if (this._excluded.flatMap((e) => e.points).length + seg.exclude.length > 40) {
      this._msg("Troppe tratte escluse: ripristinane qualcuna");
      return;
    }
    this._excluded.push({ name: seg.name, length_km: seg.length_km, points: seg.exclude });
    this._saveState();
    this._drawMarkers();
    this._compute(false);
  }

  // intestazione richiudibile di ricerca/veicolo/itinerario: c'è solo con un percorso calcolato; riassume il viaggio
  _planSync() {
    const h = this.$("planh");
    if (!h) return;
    h.hidden = !this._result;
    if (!this._result) h.classList.add("open"); // senza percorso la parte resta sempre aperta
    const pts = this._points || [];
    const a = pts[0], z = pts[pts.length - 1];
    this.$("plansum").textContent = a && z ? `${a.name || "Partenza"} → ${z.name || "Arrivo"}` : "Ricerca e itinerario";
  }

  _renderResults() {
    this._planSync();
    if (!this._nav) this._navClock(null); // arrivo previsto nella croce (percorso nuovo o altra alternativa)
    // percorso cambiato (nuovo calcolo o altra alternativa): l'anteprima dell'indicazione non vale più
    if (this._stepK != null && this._stepRt !== this._result?.routes[this._sel]) this._stepClose();
    const box = this.$("results");
    const r = this._result;
    let html = "";
    if (this._error) {
      html += `<div class="sec"><div class="box err">${esc(this._error)}</div>
        ${this._excluded.length ? `<button class="link" data-a="unexall" style="margin-top:6px">Ripristina le tratte escluse e riprova</button>` : ""}</div>`;
    }
    if (r) {
      const rt = r.routes[this._sel];
      const s = rt.summary;
      html += `<div class="sec"><h3>Percorsi <span class="muted" style="text-transform:none">${r.engine === "osrm" ? "OSRM" : "Valhalla"}</span></h3>`;
      // a piedi e in bici i sensi unici delle auto non valgono: rotonde e strade si possono percorrere nei due sensi
      if (this._mode === "piedi" || this._mode === "bici") {
        html += `<div class="note" style="margin:0 0 8px">${this._mode === "piedi" ? "🚶 Percorso <b>a piedi</b>" : "🚲 Percorso <b>in bici</b>"}:
          sensi unici e rotonde delle auto non valgono, il percorso può farli nei due sensi. Per guidare scegli Auto o Moto.</div>`;
      }
      html += `<div class="alts">`;
      const fastest = Math.min(...r.routes.map((x) => x.summary.time));
      const shortest = Math.min(...r.routes.map((x) => x.summary.length_km));
      r.routes.forEach((x, i) => {
        const tags = [];
        if (x.toll_segments.length) tags.push(`<span class="tag toll">💶 Pedaggio ${fmtKm(x.toll_km)}</span>`);
        else if (this._mode === "auto" || this._mode === "moto") tags.push(`<span class="tag free">Senza pedaggi</span>`);
        if (x.summary.has_highway) tags.push(`<span class="tag">Autostrada</span>`);
        if (x.summary.has_ferry) tags.push(`<span class="tag">⛴️ Traghetto</span>`);
        if (r.routes.length > 1 && x.summary.time === fastest) tags.push(`<span class="tag">Più veloce</span>`);
        if (r.routes.length > 1 && x.summary.length_km === shortest && x.summary.time !== fastest) tags.push(`<span class="tag">Più breve</span>`);
        html += `<div class="alt ${i === this._sel ? "on" : ""}" data-i="${i}"><span class="arr">arrivo ≈ ${arrival(x.summary.time)}</span>
          <span class="tm" style="color:${ROUTE_COLORS[i % ROUTE_COLORS.length]}">${fmtTime(x.summary.time)}</span><span class="km">${fmtKm(x.summary.length_km)}</span>
          <div class="tags">${tags.join("")}</div>${elevLine(x.elev)}</div>`;
      });
      html += `</div>`;
      const tr = this._trafficEta();
      if (tr) {
        const base = r.routes[this._sel].summary.time;
        const delay = Math.round((tr.sec - base) / 60);
        html += `<div class="box traffic">🚗 <b>Senza traffico</b>: ${fmtTime(base)} · arrivo ${arrival(base)}<br>
          🚦 <b>Con traffico</b>: ${fmtTime(tr.sec)} · arrivo ${arrival(tr.sec)}${delay >= 1 ? ` · <b>+${delay} min di coda</b>`
            : delay <= -1 ? " · strada libera" : ""}<div class="muted" style="font-size:11px;margin-top:3px">da ${esc(tr.name)} · vale per il percorso impostato in quel sensore</div></div>`;
      }
      for (const w of r.warnings || []) html += `<div class="box warn">${esc(w)}</div>`;
      if (this._roadworks?.length) {
        const lav = this._roadworks.filter((x) => x.kind === "lavori").length, chi = this._roadworks.length - lav;
        const parti = [lav ? `🚧 ${lav} ${lav === 1 ? "lavoro" : "lavori"}` : "", chi ? `⛔ ${chi} ${chi === 1 ? "strada chiusa" : "strade chiuse"}` : ""].filter(Boolean);
        // elenco: dove sono (km del percorso); toccando la mappa ci va e apre i dettagli per verificarli
        const g = this._geom(rt);
        const kmOf = (it) => { let best = 0, bd = Infinity; g.shape.forEach((p, k) => { const d = distM(p, [it.lat, it.lon]); if (d < bd) { bd = d; best = k; } }); return g._cum[best] / 1000; };
        const list = this._roadworks.map((it, k) => ({ it, k, km: kmOf(it) })).sort((a, b) => a.km - b.km);
        html += `<div class="box warn">${parti.join(" · ")} vicino al percorso (segnalati su OpenStreetMap, non sempre aggiornati). Tocca per vedere dove e verificare:
          <div class="rwlist">${list.slice(0, 12).map(({ it, k, km }) => `<button class="link" data-a="rw" data-k="${k}">${it.kind === "lavori" ? "🚧" : "⛔"} ${
            esc(it.name || (it.kind === "lavori" ? "Lavori" : "Strada chiusa"))} · km ${km.toFixed(1).replace(".", ",")}</button>`).join("")}</div></div>`;
      }

      // tratte a pagamento
      if (rt.toll_segments.length) {
        html += `<div class="box toll"><b>💶 Questo percorso include ${rt.toll_segments.length === 1 ? "una tratta" : `${rt.toll_segments.length} tratte`} a pagamento
          (${fmtKm(rt.toll_km)})</b>
          <div class="row" style="margin:8px 0"><button class="primary" data-a="notolls">Ricalcola senza pedaggi</button></div>
          <div style="font-size:13px;margin-bottom:4px">Oppure togli solo le tratte che non vuoi pagare:</div>`;
        rt.toll_segments.forEach((seg, k) => {
          html += `<div class="seg"><div class="nm">${esc(seg.name)} · ${fmtKm(seg.length_km)}<small>${esc(seg.start_text)}</small></div>
            <button data-a="showseg" data-k="${k}">Mostra</button><button data-a="exseg" data-k="${k}">Togli</button></div>`;
        });
        html += `</div>`;
      } else if ((this._mode === "auto" || this._mode === "moto") && (this._avoid.tolls || this._excluded.length)) {
        html += `<div class="box ok">✓ Nessuna tratta a pagamento su questo percorso.</div>`;
      }
      html += `</div>`;
    }
    this._updateModeBtn();
    if (r) {
      html += this._navSectionHtml();
      html += this._stepsHtml(r); // indicazioni sopra il meteo
      html += this._wxHtml();
      html += `<div class="sec"><h3>Nelle vicinanze</h3><div class="row">
        <button data-a="near-fuel">⛽ Distributori sul percorso</button>
        <button data-a="near-parking">🅿️ Parcheggi all'arrivo</button>
        <button data-a="near-cameras">📷 Autovelox sul percorso</button></div></div>`;
    }
    // tratte escluse
    if (this._excluded.length) {
      html += `<div class="sec"><h3>Tratte tolte <button class="link" data-a="unexall">Ripristina tutte</button></h3><div class="box ex" style="margin-top:0">`;
      this._excluded.forEach((e, k) => {
        html += `<div class="seg"><div class="nm">✕ ${esc(e.name)} · ${fmtKm(e.length_km)}</div><button data-a="unex" data-k="${k}">Ripristina</button></div>`;
      });
      html += `</div></div>`;
    }
    if (r) {
      const dest = this._points[this._points.length - 1];
      // apri altrove / condividi
      const pts = this._points;
      const g = new URL("https://www.google.com/maps/dir/");
      g.searchParams.set("api", "1");
      g.searchParams.set("origin", `${pts[0].lat},${pts[0].lon}`);
      g.searchParams.set("destination", `${dest.lat},${dest.lon}`);
      if (pts.length > 2) g.searchParams.set("waypoints", pts.slice(1, -1).map((p) => `${p.lat},${p.lon}`).join("|"));
      g.searchParams.set("travelmode", { auto: "driving", moto: "driving", bici: "bicycling", piedi: "walking" }[this._mode]);
      const osmEngine = { auto: "fossgis_valhalla_car", moto: "fossgis_valhalla_car", bici: "fossgis_valhalla_bicycle", piedi: "fossgis_valhalla_foot" }[this._mode];
      const osm = `https://www.openstreetmap.org/directions?engine=${osmEngine}&route=${pts[0].lat}%2C${pts[0].lon}%3B${dest.lat}%2C${dest.lon}`;
      const waze = `https://waze.com/ul?ll=${dest.lat}%2C${dest.lon}&navigate=yes`;
      html += `<div class="sec"><h3>Apri o condividi</h3><div class="row">
        <a href="${esc(g.href)}" target="_blank" rel="noopener"><button>Google Maps</button></a>
        <a href="${esc(waze)}" target="_blank" rel="noopener"><button>Waze</button></a>
        <a href="${esc(osm)}" target="_blank" rel="noopener"><button>OpenStreetMap</button></a>
        <button data-a="copy">📋 Copia riepilogo</button></div>
        <div class="muted" style="margin-top:6px">Le app esterne ricalcolano il percorso: le tratte tolte qui non vengono trasmesse.</div></div>`;
    }
    box.innerHTML = html;
    this._wireCollapse(box);
    // cambiando la fonte in "Segui la posizione di", il punto blu passa subito alla nuova fonte
    this._renderPlanSel();
    box.querySelectorAll(".alt").forEach((el) => el.addEventListener("click", () => this._select(+el.dataset.i)));
    // toccando un'indicazione: anteprima come in guida (barra in alto, mappa sulla manovra nel verso di marcia, segnaposto)
    box.querySelectorAll(".steps li[data-k]").forEach((el) => el.addEventListener("click", () => this._stepPreview(+el.dataset.k)));
    box.querySelectorAll("button[data-a]").forEach((b) => b.addEventListener("click", () => {
      const a = b.dataset.a;
      const k = +b.dataset.k;
      const rt = r?.routes[this._sel];
      if (a === "notolls") {
        this._avoid.tolls = true;
        this.$("av_tolls").checked = true;
        this._saveState();
        this._compute(true);
      } else if (a === "showseg") {
        const seg = rt.toll_segments[k];
        this._map.fitBounds(L.latLngBounds(rt.shape.slice(seg.begin, seg.end + 1)), { padding: [40, 40] });
      } else if (a === "exseg") {
        this._excludeSegment(rt.toll_segments[k]);
      } else if (a === "unex") {
        this._excluded.splice(k, 1);
        this._saveState();
        this._drawMarkers();
        this._autoCompute(false);
      } else if (a === "unexall") {
        this._excluded = [];
        this._saveState();
        this._drawMarkers();
        this._autoCompute(false);
      } else if (a === "navstart") {
        this._startNav(this.$("navsrc")?.value || this._meSource() || "gps");
      } else if (a === "rw") {
        const it = this._roadworks?.[k];
        if (it) { this._map.setView([it.lat, it.lon], Math.max(this._map.getZoom(), 16)); this._roadworkPopup(it); }
      } else if (a.startsWith("near-")) {
        this._openNearby(a.slice(5));
      } else if (a === "gpshelp") {
        this._gpsHelp(true);
      } else if (a === "devpos") {
        this._locateDevice(true, "dev").then((p) => { if (p) this._msg("Segnaposto grigio: la posizione di questo dispositivo (su un PC è solo una stima)"); });
      } else if (a === "navstop") {
        this._stopNav();
      } else if (a === "copy") {
        this._copySummary();
      }
    }));
  }

  async _copySummary() {
    const rt = this._result.routes[this._sel];
    const lines = [
      `Itinerario (${MODES.find((m) => m[0] === this._mode)[2]}): ${this._points.map((p) => p.name).join(" → ")}`,
      `${fmtTime(rt.summary.time)} · ${fmtKm(rt.summary.length_km)}${rt.toll_segments.length ? ` · pedaggio su ${fmtKm(rt.toll_km)}` : " · senza pedaggi"}`,
      "",
      ...rt.maneuvers.map((m, i) => `${i + 1}. ${m.text}${m.length_km > 0 ? ` (${fmtKm(m.length_km)})` : ""}`),
    ];
    try {
      await window.navigator.clipboard.writeText(lines.join("\n"));
      this._msg("Riepilogo copiato negli appunti");
    } catch (e) {
      this._msg("Impossibile copiare negli appunti da questo browser");
    }
  }

  // ----------------------------------------------------------------- preferiti

  async _saveFav(pt) {
    const name = window.prompt("Nome del preferito", pt.name.replace(/^[^\p{L}\p{N}]+/u, ""));
    if (name === null) return;
    try {
      const r = await this._hass.callWS({ type: "navigator/place_save", name, address: pt.address || "", lat: pt.lat, lon: pt.lon });
      this._info.favorites = r.favorites;
      this._info.recent = r.recent;
      this._renderFavs();
      this._msg(`"${name}" salvato nei preferiti`);
    } catch (err) {
      this._msg(err.message || String(err));
    }
  }

  // intestazione di una sezione richiudibile: la freccia e il titolo; segue sempre un <div class="cbbody">…</div>.
  // chiuse di default (l'utente apre quelle che vuole; lo stato è salvato sul dispositivo)
  _secHead(key, title, extra = "") {
    const open = !!this._settings.secShow?.[key];
    return `<h3 class="cbh${open ? " open" : ""}" data-cb="${esc(key)}"><span class="cbcar">▸</span><span style="flex:1">${title}</span>${extra}</h3>`;
  }

  // attiva il mostra/nascondi sulle intestazioni richiudibili dentro un contenitore (dopo averlo ridisegnato)
  _wireCollapse(root) {
    root?.querySelectorAll("h3.cbh[data-cb]").forEach((h) => h.addEventListener("click", (e) => {
      if (e.target.closest("button, a, .link")) return; // i pulsanti nell'intestazione non aprono/chiudono
      const key = h.dataset.cb;
      this._settings.secShow = this._settings.secShow || {};
      const open = !this._settings.secShow[key];
      this._settings.secShow[key] = open;
      this._saveSettings();
      h.classList.toggle("open", open);
    }));
  }

  _renderFavs() {
    const box = this.$("favsec");
    const favs = this._info?.favorites || [];
    const rec = this._info?.recent || [];
    let html = this._secHead("preferiti", `Preferiti${favs.length ? ` <span class="muted" style="text-transform:none">${favs.length}</span>` : ""}`) + `<div class="cbbody">`;
    if (!favs.length) html += `<div class="muted">Nessun preferito: cerca un luogo o clicca sulla mappa e premi ★.</div>`;
    favs.forEach((f, k) => {
      html += `<div class="fav"><span>${esc(f.icon || "★")}</span><div class="nm" data-f="${k}">${esc(f.name)}<small>${esc(f.address || "")}</small></div>
        <button class="icon" data-go="${k}" title="Portami qui">➜</button><button class="icon" data-del="${k}" title="Elimina">🗑</button></div>`;
    });
    html += `</div>`;
    if (rec.length) {
      html += this._secHead("recenti", `Destinazioni recenti <span class="muted" style="text-transform:none">${rec.length}</span>`, `<button class="link" data-a="clearrec">Cancella</button>`) + `<div class="cbbody">`;
      rec.slice(0, 6).forEach((f, k) => {
        html += `<div class="fav"><span>🕘</span><div class="nm" data-r="${k}">${esc(f.name)}<small>${esc(f.address || "")}</small></div>
          <button class="icon" data-rgo="${k}" title="Portami qui">➜</button></div>`;
      });
      html += `</div>`;
    }
    box.innerHTML = html;
    this._wireCollapse(box);
    box.querySelectorAll("[data-f]").forEach((el) => el.addEventListener("click", () => this._showPlace(favs[+el.dataset.f], true)));
    box.querySelectorAll("[data-r]").forEach((el) => el.addEventListener("click", () => this._showPlace(rec[+el.dataset.r], true)));
    box.querySelectorAll("[data-go]").forEach((el) => el.addEventListener("click", () => this._placeAction("dest", favs[+el.dataset.go])));
    box.querySelectorAll("[data-rgo]").forEach((el) => el.addEventListener("click", () => this._placeAction("dest", rec[+el.dataset.rgo])));
    box.querySelectorAll("[data-del]").forEach((el) => el.addEventListener("click", async () => {
      const f = favs[+el.dataset.del];
      if (!window.confirm(`Eliminare "${f.name}" dai preferiti?`)) return;
      const r = await this._hass.callWS({ type: "navigator/place_delete", place_id: f.id });
      this._info.favorites = r.favorites;
      this._renderFavs();
    }));
    box.querySelector('[data-a="clearrec"]')?.addEventListener("click", async () => {
      const r = await this._hass.callWS({ type: "navigator/recent_clear" });
      this._info.recent = r.recent;
      this._renderFavs();
    });
  }
}

customElements.define("navigator-panel", NavigatorPanel);
