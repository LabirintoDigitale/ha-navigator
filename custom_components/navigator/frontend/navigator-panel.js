// Pannello "Navigator" per Home Assistant: mappa, ricerca di destinazioni e itinerari
// con servizi gratuiti basati su OpenStreetMap (Valhalla / OSRM per i percorsi, Photon / Nominatim per la ricerca).

import * as L from "./leaflet/leaflet-src.esm.js";

// deve coincidere con VERSION in const.py: se il backend ne riporta un'altra manca un riavvio
const PANEL_VERSION = "1.9.16";

const LEAFLET_CSS = new URL("./leaflet/leaflet.css", import.meta.url).href;
// vista 3D: MapLibre GL JS (BSD-3-Clause), incluso in frontend/maplibre e caricato solo quando serve
const MAPLIBRE_JS = new URL("./maplibre/maplibre-gl.js", import.meta.url).href;
const MAPLIBRE_CSS = new URL("./maplibre/maplibre-gl.css", import.meta.url).href;
const ICON = new URL("./icon.png", import.meta.url).href;
const STORE_KEY = "navigator-panel-state";

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

let maplibreLoading = null;
function loadMaplibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (!maplibreLoading) {
    maplibreLoading = new Promise((ok, ko) => {
      const sc = document.createElement("script");
      sc.src = MAPLIBRE_JS;
      sc.onload = () => (window.maplibregl ? ok(window.maplibregl) : ko(new Error("libreria 3D non caricata")));
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
  if ([9, 10, 11].includes(t)) return "↱";
  if ([14, 15, 16].includes(t)) return "↰";
  if ([12, 13].includes(t)) return "⤺";
  if ([26, 27].includes(t)) return "⟳";
  if ([18, 20, 23].includes(t)) return "↗";
  if ([19, 21, 24].includes(t)) return "↖";
  if ([17, 22, 25, 8, 7].includes(t)) return "↑";
  const txt = (m.text || "").toLowerCase();
  if (txt.includes("rotonda")) return "⟳";
  if (txt.includes("destra")) return "↱";
  if (txt.includes("sinistra")) return "↰";
  return "↑";
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
  poiKinds: ["farmacia", "ospedale", "supermercato"], arrEntities: [], arrHomeOnly: true, nightMode: "auto", wxAlert: true };
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
};
const POI_TILE = 0.02; // come nel backend
// punti di interesse dalle mappe vettoriali OpenFreeMap (livello "poi", schema OpenMapTiles): la sottoclasse è il valore OSM
const OFM_POI = { pharmacy: "farmacia", hospital: "ospedale", clinic: "ospedale", supermarket: "supermercato",
  restaurant: "ristorante", fast_food: "ristorante", cafe: "bar", bar: "bar", pub: "bar", bank: "banca", atm: "banca",
  hotel: "hotel", motel: "hotel", guest_house: "hotel", hostel: "hotel", charging_station: "ricarica", fuel: "carburante",
  police: "polizia", post_office: "posta", car_repair: "officina", tyres: "officina", school: "scuola", place_of_worship: "chiesa" };
// pulsanti all'arrivo: domini ammessi e servizio da chiamare
const ARR_DOMAINS = ["cover", "lock", "switch", "light", "button", "input_button", "script", "scene", "input_boolean", "fan"];
const ARR_ICONS = { cover: "🚪", lock: "🔒", switch: "⏻", light: "💡", button: "🔘", input_button: "🔘", script: "📜", scene: "🎬", input_boolean: "⏻", fan: "🌀" };
// tipi di veicolo del garage
const VEHICLE_TYPES = [["auto", "🚗", "Auto"], ["moto", "🏍️", "Moto"], ["scooter", "🛵", "Scooter"], ["furgone", "🚐", "Furgone"],
  ["camper", "🚌", "Camper"], ["bici", "🚲", "Bici"], ["altro", "🚙", "Altro"]];
const vehIcon = (t) => (VEHICLE_TYPES.find((v) => v[0] === t) || VEHICLE_TYPES[0])[1];
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

// avvisi del meteo in un punto (Open-Meteo: mm/h, cm/h, °C, km/h, codici WMO)
function wxWarnings(w) {
  const out = [];
  const c = w.code ?? -1;
  if (c >= 95) out.push({ ico: "⛈️", txt: "Temporale" });
  if ((w.snow || 0) >= 0.1 || [71, 73, 75, 77, 85, 86].includes(c)) out.push({ ico: "🌨️", txt: (w.snow || 0) >= 1 ? "Neve forte" : "Neve" });
  else if ((w.prec || 0) >= 0.3 || (c >= 51 && c <= 67) || (c >= 80 && c <= 82)) {
    out.push({ ico: "🌧️", txt: (w.prec || 0) >= 4 ? "Pioggia forte" : "Pioggia" });
  }
  if (w.temp != null && w.temp <= 1 && ((w.prec || 0) > 0 || [56, 57, 66, 67].includes(c))) out.push({ ico: "🧊", txt: "Rischio ghiaccio" });
  else if (w.temp != null && w.temp <= 0) out.push({ ico: "🥶", txt: "Gelo" });
  if ((w.gust || 0) >= 60) out.push({ ico: "💨", txt: "Vento forte" });
  if (c === 45 || c === 48) out.push({ ico: "🌫️", txt: "Nebbia" });
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
  .toolbar .ver { font-size: 12px; opacity: .7; }
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
  .fav { display: flex; align-items: center; gap: 6px; padding: 5px 0; }
  .fav .nm { flex: 1; min-width: 0; cursor: pointer; } .fav .nm small { display: block; color: var(--secondary-text-color); }
  .fav .nm:hover { color: var(--primary-color); }
  .muted { color: var(--secondary-text-color); font-size: 13px; }
  .loading { display: inline-block; width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent;
    border-radius: 50%; animation: spin .8s linear infinite; vertical-align: -2px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .ctl { position: absolute; z-index: 1000; display: flex; flex-direction: column; gap: 6px; }
  .ctl.tr { top: 10px; right: 10px; } .ctl.br { bottom: 24px; right: 10px; }
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
  .navtop { position: absolute; z-index: 1001; top: 10px; left: 54px; right: 10px; display: flex; align-items: center; gap: 12px;
    background: #0b6e3a; color: #fff; border-radius: 12px; padding: 10px 14px; box-shadow: 0 2px 10px rgba(0,0,0,.35); }
  .navtop .ic { font-size: 34px; width: 40px; text-align: center; flex: none; }
  .navtop .d { font-size: 24px; font-weight: 700; white-space: nowrap; }
  .navtop .t { font-size: 15px; line-height: 1.25; }
  .navtop.wait { background: #37474f; }
  .navbot { position: absolute; z-index: 1001; bottom: 20px; left: 10px; right: 10px; display: flex; align-items: center; gap: 8px 12px;
    flex-wrap: wrap; background: var(--card-background-color, #fff); color: var(--primary-text-color); border-radius: 12px;
    padding: 8px 10px; box-shadow: 0 2px 10px rgba(0,0,0,.3); font-size: 14px; }
  .navbot .info { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; flex: 1 1 auto; min-width: 150px; }
  .navbot .rem { font-size: 18px; font-weight: 600; }
  .navbot .tools { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-left: auto; }
  .navbot button { padding: 0 10px; height: 36px; min-width: 36px; font-size: 15px; }
  .navbot button.attn { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
  .navbot button.stop { background: #c62828; color: #fff; border-color: #c62828; font-size: 14px; }
  .navbot select { height: 36px; font: inherit; font-size: 13px; padding: 0 6px; border-radius: 8px; border: 1px solid var(--divider-color);
    background: var(--card-background-color, #fff); color: var(--primary-text-color); max-width: 150px; }
  .main.guida .ctl.br { display: none; }
  @media (max-width: 800px) {
    .navbot .tools { width: 100%; margin-left: 0; flex-wrap: nowrap; }
    .navbot select { flex: 1; min-width: 0; max-width: none; }
  }
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
  .navbot .lim { width: 30px; height: 30px; border-radius: 50%; border: 4px solid #d32f2f; background: #fff; color: #111;
    display: inline-flex; align-items: center; justify-content: center; font: 700 13px sans-serif; flex: none; box-sizing: border-box; }
  /* schermo intero: solo la mappa, sopra la barra laterale e l'intestazione di Home Assistant.
     Alla fine, così vale anche sul telefono in verticale; niente altezze in vh, che nel WebView a schermo intero sono sbagliate */
  :host(.full) { position: fixed; inset: 0; z-index: 2000; width: auto; height: auto; display: flex; flex-direction: column; overflow: hidden; }
  :host(.full) .toolbar, :host(.full) #verwarn, :host(.full) .main .side { display: none; }
  :host(.full) .main { flex: 1 1 auto; min-height: 0; height: auto; display: flex; }
  :host(.full) .main .mapwrap, :host(.full) .main.guida .mapwrap { flex: 1 1 auto; height: auto; min-height: 0; }
  .fsico { width: 18px; height: 18px; display: block; margin: auto; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
  /* vista 3D: la mappa MapLibre copre quella di Leaflet, che resta sotto (nascosta) e guida tutto il resto */
  #map3d { position: absolute; inset: 0; z-index: 450; }
  #map3d[hidden] { display: none; }
  #map.under3d { visibility: hidden; }
  #map3d .maplibregl-ctrl-attrib { font-size: 10px; }
  .main.guida #map3d .maplibregl-ctrl-bottom-right { bottom: 96px; }
  button.b3d { font-weight: 700; font-size: 13px; }
  /* inclinazione della vista 3D: dall'alto fino a quasi la telecamera dell'auto */
  .pitchctl { position: absolute; z-index: 1002; right: 10px; top: 56px; display: flex; flex-direction: column; align-items: center;
    background: rgba(32,33,36,.85); border-radius: 10px; padding: 3px; box-shadow: 0 1px 5px rgba(0,0,0,.35); color: #fff; }
  .pitchctl[hidden] { display: none; }
  .pitchctl button { width: 40px; height: 36px; padding: 0; border: none; background: transparent; color: #fff; }
  .pitchctl button:disabled { opacity: .35; }
  .pitchctl svg { width: 22px; height: 22px; display: block; margin: auto; fill: none; stroke: currentColor; stroke-width: 2.6;
    stroke-linecap: round; stroke-linejoin: round; }
  .pitchctl span { font: 600 12px sans-serif; padding: 1px 0; }
  /* galleria: animazione stilizzata di un tunnel che si percorre (archi che vengono incontro, luci, strada) */
  .tunfx { position: absolute; inset: 0; z-index: 960; pointer-events: none; overflow: hidden; opacity: 0; transition: opacity .6s;
    background: radial-gradient(ellipse at 50% 45%, #4a3f2e 0%, #1d1913 40%, #060606 100%); --tfd: 2.4s; }
  .tunfx.on { opacity: 1; }
  .tunfx[hidden] { display: none; }
  .tf-ring { position: absolute; left: 50%; top: 45%; width: 80vmin; height: 66vmin; margin-left: -40vmin; margin-top: -40vmin;
    border: 4px solid rgba(255, 196, 120, .6); border-bottom: none; border-radius: 50% 50% 0 0 / 75% 75% 0 0;
    transform-origin: 50% 61%; transform: scale(.04); opacity: 0; animation: tf-ring var(--tfd) linear infinite;
    box-shadow: inset 0 6px 22px rgba(255, 170, 80, .25); }
  .tf-ring::after { content: ""; position: absolute; left: 50%; top: -5px; width: 34px; height: 6px; margin-left: -17px; border-radius: 3px;
    background: #ffe2b0; box-shadow: 0 0 14px 5px rgba(255, 205, 130, .65); }
  @keyframes tf-ring { 0% { transform: scale(.04); opacity: 0; } 18% { opacity: .95; } 100% { transform: scale(2.8); opacity: 0; } }
  .tf-road { position: absolute; left: 50%; top: 45%; bottom: 0; width: 170vmin; margin-left: -85vmin;
    background: linear-gradient(#262626, #3a3a3a); clip-path: polygon(49.3% 0, 50.7% 0, 100% 100%, 0 100%); }
  .tf-road::after { content: ""; position: absolute; left: 50%; top: 0; bottom: 0; width: 3vmin; margin-left: -1.5vmin;
    background: repeating-linear-gradient(to bottom, #f2f2f2 0 7%, transparent 7% 16%); background-size: 100% 32%;
    animation: tf-dash var(--tfd) linear infinite; clip-path: polygon(45% 0, 55% 0, 100% 100%, 0 100%); }
  @keyframes tf-dash { from { background-position: 0 0; } to { background-position: 0 100%; } }
  .tf-label { position: absolute; left: 50%; top: 64%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center;
    gap: 2px; background: rgba(0, 0, 0, .6); color: #fff; padding: 8px 18px; border-radius: 18px; font: 600 16px sans-serif; white-space: nowrap; }
  .tf-label small { font-weight: 400; font-size: 13px; opacity: .85; }
  @media (prefers-reduced-motion: reduce) { .tf-ring, .tf-road::after { animation-duration: calc(var(--tfd) * 3); } }
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
  .wxm { font-size: 20px; line-height: 1; filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); }
  .wx3d .wxm { font-size: 30px; }
  .clouds3d { position: absolute; left: 0; top: 0; pointer-events: none; }
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
  /* schede del pannello laterale: Viaggio e Archivio */
  .sidetabs { display: flex; gap: 0; position: sticky; top: 0; z-index: 5; background: var(--card-background-color, var(--primary-background-color));
    border-bottom: 1px solid var(--divider-color); }
  .sidetabs button { flex: 1; border: none; border-radius: 0; background: transparent; padding: 12px 8px; font-size: 15px; font-weight: 600;
    color: var(--secondary-text-color); border-bottom: 3px solid transparent; }
  .sidetabs button.on { color: var(--primary-color); border-bottom-color: var(--primary-color); }
  .trip input[type=checkbox] { width: 18px; height: 18px; flex: none; accent-color: var(--tc, var(--primary-color)); }
  .trip .sw { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .month { margin: 12px 0 2px; font-weight: 600; font-size: 13px; display: flex; justify-content: space-between; }
  .month span { font-weight: 400; color: var(--secondary-text-color); }
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
    const sun = hass.states?.["sun.sun"]?.state;
    if (sun !== this._sunState) { this._sunState = sun; if (this._map) this._applyNight(); }
    // punto blu legato a una persona o a un dispositivo: segue le sue posizioni nuove
    const ms = this._me?.src && this._me.src !== "gps" ? hass.states?.[this._me.src] : null;
    if (ms && ms.last_updated !== this._me.upd && ms.attributes.latitude != null && this._markerLayer) {
      this._meTurn(ms.attributes.latitude, ms.attributes.longitude);
      this._me = { lat: ms.attributes.latitude, lon: ms.attributes.longitude, src: this._me.src, upd: ms.last_updated };
      this._drawMarkers();
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
        <div class="title"><span class="brand"><img src="${ICON}" alt=""> Navigator</span><span class="ver">versione ${PANEL_VERSION}</span></div>
        <button class="tbtn" id="settingsbtn" title="Impostazioni">⚙</button></div>
      <div class="setwrap" id="setwrap" hidden></div>
      <div class="setwrap" id="nearwrap" hidden></div>
      <div id="verwarn"></div>
      <div class="main" id="mainbox">
        <div class="side">
          <div class="sidetabs" id="sidetabs">
            <button data-tab="viaggio" class="on">🧭 Viaggio</button><button data-tab="live">📡 Live</button><button data-tab="archivio">🗂️ Archivio</button></div>
          <div id="tabViaggio">
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
          <div class="tunfx" id="tunfx" hidden><div class="tf-road"></div><div class="tf-ring" style="animation-delay:calc(var(--tfd) * -0 / 6)"></div><div class="tf-ring" style="animation-delay:calc(var(--tfd) * -1 / 6)"></div><div class="tf-ring" style="animation-delay:calc(var(--tfd) * -2 / 6)"></div><div class="tf-ring" style="animation-delay:calc(var(--tfd) * -3 / 6)"></div><div class="tf-ring" style="animation-delay:calc(var(--tfd) * -4 / 6)"></div><div class="tf-ring" style="animation-delay:calc(var(--tfd) * -5 / 6)"></div>
            <div class="tf-label"><span>🚇 In galleria</span><small id="tunrem"></small></div></div>
          <div class="pitchctl" id="pitchctl" hidden>
            <button data-p="-15" title="Più dall'alto"><svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg></button>
            <span id="pitchval"></span>
            <button data-p="15" title="Più bassa, come dall'auto"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
          </div>
          <div class="ctl tr" id="ctltr"><select id="layer"></select></div>
          <div class="navtop" id="navtop" hidden></div>
          <div class="navbot" id="navbot" hidden></div>
          <div class="navpop" id="navpop" hidden></div>
          <div class="gattr" id="gattr" hidden></div>
          <div class="ctl br">
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
    this._menuBtn = root.querySelector("ha-menu-button");
    this._menuBtn.hass = this._hass;
    this._menuBtn.narrow = this._narrow;

    // mappa
    const home = [this._hass.config.latitude, this._hass.config.longitude];
    this._map = L.map($("map"), { zoomControl: true, attributionControl: true }).setView(home, 12);
    const dark = this._hass.themes?.darkMode;
    if (!this._layer || !LAYERS[this._layer]) this._layer = dark ? "scura" : "strade";
    for (const [k, v] of Object.entries(LAYERS)) $("layer").insertAdjacentHTML("beforeend", `<option value="${k}">${v[0]}</option>`);
    $("layer").value = this._layer;
    $("layer").addEventListener("change", (e) => { this._setLayer(e.target.value); this._saveState(); });
    this._setLayer(this._layer);
    this._routeLayer = L.layerGroup().addTo(this._map);
    this._markerLayer = L.layerGroup().addTo(this._map);
    this._poiLayer = L.layerGroup().addTo(this._map);
    this._arrowLayer = L.layerGroup().addTo(this._map); // frecce del verso di marcia (solo 2D: in 3D le disegna MapLibre)
    this._map.on("moveend zoomend", () => this._scheduleArrows());
    this._poiMapLayer = L.layerGroup().addTo(this._map); // punti di interesse scelti in ⚙ (in 3D li disegna MapLibre)
    this._wxLayer = L.layerGroup().addTo(this._map);     // meteo lungo il percorso
    this._tripLayer = L.layerGroup().addTo(this._map);   // traccia di un viaggio del diario
    this._liveLayer = L.layerGroup().addTo(this._map);   // guide in corso degli utenti (scheda Live)
    this._applyNight();
    this._loadTrips();
    this._loadGarage();
    this._renderPlanSel();
    $("sidetabs").querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => this._showTab(b.dataset.tab)));
    this._poiTiles = new Map();
    this._map.on("moveend zoomend", () => this._schedulePois());
    setTimeout(() => this._schedulePois(), 1500); // anche all'apertura, senza aspettare che la mappa si muova
    this._map.on("click", (e) => {
      if (Date.now() - (this._gestEnd || 0) < 350) return; // fine di un trascinamento, non un tocco
      this._mapClick(this._rotated() && e.originalEvent ? this._unrotLatLng(e.originalEvent) : e.latlng);
    });
    this._map.on("dragstart", () => this._userMoved());
    this._bindGuidaGestures();
    this._ro = new ResizeObserver(() => this._relayout());
    this._ro.observe($("mapwrap"));
    setTimeout(() => this._map.invalidateSize(), 300);

    // schermo intero e schermo sempre acceso
    $("fullbtn").addEventListener("click", () => this._toggleFull());
    $("b3dbtn").addEventListener("click", () => this._toggle3d());
    $("pitchctl").querySelectorAll("[data-p]").forEach((b) => b.addEventListener("click", () => this._setPitch3d(+b.dataset.p)));
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
    $("go").addEventListener("click", () => this._compute());
    $("addstop").addEventListener("click", () => { this._points.splice(this._points.length - 1, 0, null); this._renderPoints(true); });
    $("swap").addEventListener("click", () => { this._points.reverse(); this._afterPointsChange(); });
    $("clear").addEventListener("click", () => {
      this._points = [this._homePoint(), null];
      this._excluded = [];
      this._result = null;
      this._afterPointsChange(false);
      this._renderResults();
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
        $("verwarn").innerHTML = `<div class="verwarn">Aggiornamento non completato: il pannello è la versione ${PANEL_VERSION} ma l'integrazione è la ${esc(this._info.version)}.
          Riavvia Home Assistant (Impostazioni → Sistema → Riavvia), poi ricarica la pagina.</div>`;
      }
    } catch (err) {
      $("verwarn").innerHTML = `<div class="verwarn">Navigator non risponde: ${esc(err.message || err)}. Riavvia Home Assistant dopo l'installazione.</div>`;
      this._info = { favorites: [], recent: [], entities: [], home: { lat: home[0], lon: home[1], name: "Casa" } };
    }
    if (!this._points[0]) this._points[0] = this._homePoint();
    this._renderPoints();
    this._renderFavs();
    this._drawMarkers();
    if (this._points.every((p) => p)) this._compute(true);
  }

  _setLayer(key) {
    const [, url, maxZoom, attribution] = LAYERS[this._effLayer(key)];
    if (this._tiles) this._map.removeLayer(this._tiles);
    this._tiles = L.tileLayer(url, { maxZoom, attribution, subdomains: "abc" });
    if (!this._3d) this._tiles.addTo(this._map); // in 3D le mappe le scarica solo MapLibre
    this._layer = key;
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
    items.push({ ico: "🏠", ...this._homePoint() });
    for (const e of this._info?.entities || []) {
      if (e.entity_id === "zone.home") continue;
      items.push({ ico: e.kind === "zone" ? "📍" : "👤", name: e.name, address: e.entity_id, lat: e.lat, lon: e.lon });
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
    if (fly) this._map.flyTo([p.lat, p.lon], Math.max(this._map.getZoom(), 15), { duration: 0.8 });
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
    if (action === "dest") this._excluded = []; // nuova destinazione: le tratte tolte non valgono più
    this._afterPointsChange();
  }

  async _mapClick(latlng) {
    if (this._isGuida()) return;
    const el = document.createElement("div");
    el.className = "popup";
    el.innerHTML = `<div class="n"><span class="loading"></span> Cerco l'indirizzo…</div><div class="a">${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}</div>
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
    try {
      const r = await this._hass.callWS({ type: "navigator/reverse", lat: latlng.lat, lon: latlng.lng });
      place = { ...place, name: r.name, address: r.address };
      el.querySelector(".n").textContent = r.name;
      el.querySelector(".a").textContent = r.address || el.querySelector(".a").textContent;
    } catch (err) {
      el.querySelector(".n").textContent = "Punto sulla mappa";
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
        if (fly) this._map.flyTo([this._me.lat, this._me.lon], 15, { duration: 0.8 });
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
      if (fly) this._map.flyTo([lat, lon], 15, { duration: 0.8 });
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
    if (saved && list.some((s) => s.id === saved && s.ok)) return saved;
    // nell'app Android il GPS si può scegliere, ma di norma si parte dalla propria persona, che funziona sempre
    if (this._companion() === "android") { const me = this._myPerson(list); if (me) return me.id; }
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
    const def = list.some((x) => x.id === curS && x.ok) ? curS : this._defaultNavSource(list);
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
    });
    this._applyVehicle(false);
    sb.querySelector("#navsrc").addEventListener("change", (e) => {
      try { localStorage.setItem(`${STORE_KEY}-navsrc`, e.target.value); } catch (err) { /* storage non disponibile */ }
      if (this._me) this._locate(false, e.target.value);
      if (this._result) this._renderResults();
    });
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
    const hint = this._companion() === "android"
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
    if (!this._result) return;
    // persona o dispositivo con una posizione vecchia: la guida partirebbe da lì (es. app Companion chiusa)
    if (source !== "gps" && !force) {
      const st = this._hass?.states?.[source];
      const age = st ? Date.now() - Date.parse(st.last_updated) : 0;
      if (age > STALE_MS) { this._staleHelp(source, age); return; }
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
    if (source === "gps") {
      this._nav.watch = window.navigator.geolocation.watchPosition(
        (pos) => this._onFix({ lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy || 0,
          heading: pos.coords.heading, speed: pos.coords.speed }),
        (err) => {
          if (err.code === 1) { this._stopNav(); this._gpsHelp(); return; } // permesso negato
          this._navPopup("warn", "📡", `GPS non disponibile: ${esc(err.message)}`, 4000);
        },
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
    } else {
      this._entityFix();
    }
  }

  _stopNav() {
    const nav = this._nav;
    if (!nav) return;
    this._tunnelExit();
    this._tripEnd(nav);
    this._hass.callWS({ type: "navigator/live", active: false }).catch(() => { /* sensori non aggiornati */ });
    if (nav.watch != null) window.navigator.geolocation.clearWatch(nav.watch);
    clearTimeout(nav.popTimer);
    this._nav = null;
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
    this._closeNearby();
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
    this._drawMe();
    this._applyRotation();
    if (nav.follow) this._followView();

    const total = rt._cum[rt._cum.length - 1];
    const dest = this._points[this._points.length - 1];
    const toDest = distM([fix.lat, fix.lon], [dest.lat, dest.lon]);
    if (nav.arrived && toDest > 150) nav.arrived = false; // ripartito: si continua a guidare
    if (!nav.arrived && (toDest < 35 || (snap.dist < limit && total - snap.along < 25))) {
      nav.arrived = true;
      this._renderNav();
      this._navPopup("ok", "🏁", `Sei arrivato a ${esc(dest.name)}`, 8000);
      this._speak(PHRASES[this._settings.lang].arrived, true);
      return;
    }
    if (nav.arrived) { this._renderNav(); return; }

    if (snap.dist > limit) {
      // fuori percorso: si aspetta qualche secondo (e almeno due posizioni) prima di ricalcolare
      if (nav.offSince == null) nav.offSince = now;
      nav.offCount += 1;
      if (!nav.rerouting && now - nav.offSince >= OFF_ROUTE_MS && nav.offCount >= 2 && now - nav.lastReroute > 12000) {
        this._reroute(fix);
      }
    } else {
      nav.offSince = null;
      nav.offCount = 0;
      nav.idx = snap.idx;
      for (let leg = 1; leg < rt._legStart.length; leg++) if (snap.idx >= rt._legStart[leg]) nav.passed = Math.max(nav.passed, leg);
      if (!nav.rerouting) this._voiceGuide(rt, snap.along);
      // il GPS si perde spesso poco prima dell'imbocco: la stima parte già 60 m prima (le posizioni buone valgono ancora)
      const r = this._tunnelRanges(rt).find(([a, b]) => snap.along >= a - 60 && snap.along < b - 40);
      if (r && !nav.tun) this._tunnelEnter(rt, r, snap.along);
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
          if (segDist(pos, pts[k], pts[k + 1]).dist < 15) { mark[i] = 1; break; }
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

  _tunnelEnter(rt, [a, b], along) {
    const nav = this._nav;
    const v = Math.max(0, nav.speed || 0);
    nav.tun = { rt, start: a, end: b, along0: along, t0: Date.now(), since: Date.now(), speed: v,
      maxMs: Math.max(90000, ((b - along) / Math.max(v, 3)) * 3000) };
    clearInterval(this._tunTick);
    this._tunTick = setInterval(() => this._tunnelStep(), 1000);
    this._tunnelStep();
  }

  _tunnelExit() {
    clearInterval(this._tunTick);
    this._tunTick = null;
    if (this._nav) this._nav.tun = null;
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
    if ((snap.dist <= limit && snap.along >= t.end - 25) || now - t.since > t.maxMs) {
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
    const p = this._pointAt(rt, along);
    nav.fix = { lat: p.ll[0], lon: p.ll[1], acc: 0, speed: t.speed, heading: p.dir, time: now, est: true };
    nav.snap = { dist: 0, idx: p.idx, t: p.t, along };
    this._routeProgress();
    nav.idx = p.idx;
    nav.dir = p.dir;
    nav.offSince = null;
    nav.offCount = 0;
    this._drawMe();
    this._applyRotation();
    if (nav.follow) this._followView();
    if (!nav.rerouting) this._voiceGuide(rt, along);
    this._renderNav();
  }

  // animazione della galleria: in guida, mentre si è dentro
  _tunnelFx() {
    const el = this.$("tunfx");
    if (!el) return;
    const t = this._nav?.tun;
    const show = !!t && this._isGuida() && this._settings.tunnelFx !== false && (this._nav.snap?.along ?? 0) >= t.start - 10;
    if (!show) {
      el.classList.remove("on");
      if (!el.hidden) setTimeout(() => { if (!el.classList.contains("on")) el.hidden = true; }, 600);
      return;
    }
    if (el.hidden) { el.hidden = false; requestAnimationFrame(() => el.classList.add("on")); }
    const v = t.speed || 0;
    el.style.setProperty("--tfd", `${Math.max(0.8, Math.min(3.5, 3.5 - v * 0.09)).toFixed(2)}s`);
    const left = Math.max(0, t.end - (this._nav.snap?.along ?? t.start));
    this.$("tunrem").textContent = v > 0.5 ? `uscita tra circa ${fmtDist(left)}` : `galleria di ${fmtDist(t.end - t.start)}`;
  }

  // indicazioni vocali: un avviso in anticipo ("Tra 300 metri, …") e uno al momento della manovra
  _voiceGuide(rt, along) {
    const nav = this._nav;
    if (!this._settings.voice) return;
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
    this._speak(PHRASES[this._settings.lang].reroute, true);
    this._renderNav();
    const before = this._points;
    this._points = [{ name: "📍 Posizione attuale", address: "", lat: fix.lat, lon: fix.lon }, ...this._points.slice(1 + nav.passed)];
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

  _drawMe() {
    const f = this._nav.fix;
    const ll = [f.lat, f.lon];
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
  async _toggleFull(on = !this._full) {
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
    this._plate3d = null;
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
    if (!el) return;
    el.hidden = !this._3d || !this._g3;
    if (el.hidden) return;
    const top = this.$("navtop");
    el.style.top = top && !top.hidden ? `${top.offsetTop + top.offsetHeight + 8}px` : "56px";
    const p = Math.round(pitch ?? this._g3.getPitch());
    this.$("pitchval").textContent = `${p}°`;
    el.querySelector('[data-p="-15"]').disabled = p <= 0;
    el.querySelector('[data-p="15"]').disabled = p >= 80;
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
    const tiles = url.includes("{s}") ? ["a", "b", "c"].map((x) => url.replace("{s}", x)) : [url];
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
    const dem = { type: "raster-dem", tiles: [DEM_URL], tileSize: 256, maxzoom: 15, encoding: "terrarium" };
    const g = new ml.Map({
      container: el, center: [c.lng, c.lat], zoom: this._map.getZoom() - 1, pitch: this._pitch3d(), maxPitch: 80,
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
            paint: { "line-color": ["get", "c"], "line-width": ["get", "w"], "line-opacity": ["get", "o"] } },
          { id: "lines-d", type: "line", source: "lines", filter: ["==", ["get", "d"], 1], layout: { "line-join": "round" },
            paint: { "line-color": ["get", "c"], "line-width": ["get", "w"], "line-opacity": ["get", "o"], "line-dasharray": [1.4, 1.4] } },
        ],
        terrain: { source: "dem", exaggeration: +this._settings.terrainEx || 1.5 },
        sky: this._skySpec(),
      },
    });
    this._g3 = g;
    this._g3markers = [];
    // pronta appena c'è lo stile, senza aspettare i primi riquadri (con rete lenta il "load" arriva tardi)
    this._g3ready = new Promise((ok) => { g.once("style.load", ok); g.once("load", ok); }).then(() => { this._g3ok = true; });
    g.on("error", (e) => console.debug("Navigator 3D:", e?.error?.message || e)); // riquadri mancanti: la vista va avanti
    // movimenti fatti a mano nella vista 3D: la guida smette di seguire, Leaflet si sposta nello stesso punto
    // In guida, mentre la vista segue la posizione, zoom, rotazione e inclinazione con le dita non la fermano:
    // cambiano la distanza (e l'inclinazione), che resta memorizzata. Solo trascinare la mappa smette di seguire.
    this._g3gest = new Set();
    const followGuida = () => !!(this._nav?.fix && this._nav.follow && this._isGuida());
    for (const ev of ["dragstart", "zoomstart", "rotatestart", "pitchstart"]) {
      g.on(ev, (e) => {
        if (!e.originalEvent) return;
        if (followGuida()) {
          if (ev === "dragstart") {
            // anche il pinch sposta un po' la mappa: si aspetta un attimo per capire se è un trascinamento vero
            clearTimeout(this._g3dragT);
            this._g3dragT = setTimeout(() => { if (!this._g3gest.size) this._userMoved(); }, 250);
          } else {
            clearTimeout(this._g3dragT);
            this._g3gest.add(ev.replace("start", ""));
          }
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
    g.on("moveend", () => this._schedulePois()); // i punti di interesse della zona ora visibile
    g.on("moveend", () => this._scheduleClouds()); // nuvole della zona ora visibile
    g.on("moveend", (e) => {
      if (!e.originalEvent || (this._nav?.follow)) return;
      const cc = g.getCenter();
      this._from3d = true;
      try { this._map.setView([cc.lat, cc.lng], g.getZoom() + 1, { animate: false }); } finally { this._from3d = false; }
    });
    g.on("click", (e) => this._mapClick(L.latLng(e.lngLat.lat, e.lngLat.lng)));
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
    if (!g.getSource("ofm")) g.addSource("ofm", { type: "vector", url: OFM_URL, attribution: OFM_ATTR });
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
      g.on("move", () => this._placePlate3d()); // inclinazione e rotazione cambiano altezza e verso della targa
    } else {
      g.moveLayer("veh3d");
    }
    this._veh3dKey = null;
    // nuvole in cielo: disegnate su un foglio sopra la mappa, in prospettiva con la telecamera
    if (!this._cloudHooked) {
      this._cloudHooked = true;
      g.on("render", () => this._drawClouds());
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
    if (!this._3d || !this._clouds?.length) return;
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
    // vista dall'alto o poco inclinata: niente nuvole, coprirebbero la mappa (compaiono da 40° a 55°)
    const top = 0.92 * Math.min(1, Math.max(0, (g.getPitch() - 40) / 15));
    if (top <= 0) return;
    for (const [, sx, sy, rad, a, rain] of items) {
      x.globalAlpha = a * top * 0.6;
      x.drawImage(rain ? rainS : shadow, sx - rad, sy - rad * 0.8, rad * 2, rad * 2); // ombra sotto
      x.globalAlpha = a * top;
      x.drawImage(rain ? rainL : light, sx - rad, sy - rad * 1.1, rad * 2, rad * 2);
    }
    x.globalAlpha = 1;
  }

  // aspetto degli edifici: semplici (grigio chiaro), colorati secondo l'altezza (bassi chiari, alti azzurri) o con finestre
  _bldPaint(style) {
    const g = this._g3;
    const h = ["coalesce", ["get", "render_height"], 8];
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
    const h = ["coalesce", ["get", "render_height"], 8];
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
    for (const grp of [this._markerLayer, this._poiLayer, this._wxLayer, this._liveLayer].filter(Boolean)) {
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
    if (this._nav?.fix) return { lat: this._nav.fix.lat, lon: this._nav.fix.lon, dir: this._nav.dir ?? 0 };
    if (this._me && !this._nav) return { lat: this._me.lat, lon: this._me.lon, dir: this._meDir ?? 0 };
    return null;
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
    this._placePlate3d();
  }

  // ingrandimento del modellino: più si è lontani più è grande, così sullo schermo resta di misura simile;
  // due ruote e pedone sono piccoli davvero: un po' più ingranditi
  _veh3dScale(kind) {
    return Math.max(1.5, Math.min(60, 8 * 2 ** (17 - this._g3.getZoom()))) * (["moto", "scooter", "bici", "piedi"].includes(kind) ? 1.7 : 1);
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
      this._plate3d = new window.maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([f.lon, f.lat]).addTo(g);
    }
    const el = this._plate3d.getElement();
    if (el.dataset.t !== at.text) { el.dataset.t = at.text; el.innerHTML = `<span class="eu">I</span><b>${esc(at.text)}</b><span class="eu"></span>`; }
    const S = this._veh3dScale(at.kind);
    const th = (f.dir * Math.PI) / 180;
    const lat = f.lat + at.rear * Math.cos(th) * S / 111320;
    const lon = f.lon + (at.rear * Math.sin(th) * S) / (111320 * Math.cos((f.lat * Math.PI) / 180));
    // misura sullo schermo dalla larghezza vera del retro del modellino proiettata (con la prospettiva: lontano è più piccolo)
    const mLon = 1 / (111320 * Math.cos((f.lat * Math.PI) / 180));
    const side = (x) => [lon + x * Math.cos(th) * S * mLon, lat - (x * Math.sin(th) * S) / 111320];
    let px = 0;
    try {
      const a = g.project(side(-0.9)), b = g.project(side(0.9));
      px = Math.hypot(a.x - b.x, a.y - b.y);
    } catch (e) { /* fuori dai dati del rilievo */ }
    const mpp = (40075016.686 * Math.cos((f.lat * Math.PI) / 180)) / (512 * 2 ** g.getZoom()); // metri per pixel al centro
    const ratio = px > 0 ? px / ((1.8 * S) / mpp) : 1; // quanto la prospettiva rimpicciolisce il mezzo rispetto al centro
    // un po' più larga del retro del mezzo (deve leggersi), ma in proporzione: lontano rimpicciolisce con lui
    const wpx = Math.max(40, Math.min(130, (px || (1.8 * S) / mpp) * 1.35));
    el.style.width = `${wpx}px`;
    el.style.fontSize = `${Math.max(7, Math.min(17, wpx * 0.145))}px`;
    const away = Math.abs(((((f.dir - g.getBearing()) % 360) + 540) % 360) - 180) > 100;
    const pos = g.project([lon, lat]);
    const off = pos.x < -50 || pos.y < -50 || pos.x > g.getCanvas().clientWidth + 50 || pos.y > g.getCanvas().clientHeight + 50;
    el.style.visibility = away || off ? "hidden" : "";
    const pitch = (g.getPitch() * Math.PI) / 180;
    this._plate3d.setLngLat([lon, lat]).setOffset([0, -((at.z * S) / mpp) * Math.sin(pitch) * ratio]);
  }

  // la telecamera non deve finire sotto il terreno: inclinata sta dietro e più in basso del punto guardato, e le colline
  // vicine (accentuate dal rilievo) la coprono, con la mappa "stirata" e il nero sotto. Si prova la posizione e, se serve,
  // ci si allontana (zoom indietro a piccoli passi) finché la telecamera resta almeno 15 m sopra il terreno che ha davanti.
  // Margine piccolo apposta: con uno più largo la vista restava troppo alta e lo zoom con le dita veniva annullato.
  _clearCamera(opts, min = 15) {
    const g = this._g3;
    const ml = window.maplibregl;
    // la prova si fa su una copia della telecamera: spostare la vista vera interromperebbe l'animazione in corso
    // (zoom e inclinazione restavano a metà strada, e Ricentra sembrava non avvicinare)
    if (!g || !ml || !g.getTerrain() || typeof g.transform?.clone !== "function") return opts;
    // Prima si abbassa l'inclinazione (5° alla volta, fino a 20°): la telecamera sale e si avvicina, la distanza scelta resta.
    // Allontanarsi (zoom indietro) in una valle stretta la portava sopra le montagne dietro, sempre più lontano.
    let z = opts.zoom;
    let pitch = opts.pitch ?? g.getPitch();
    try {
      const center = ml.LngLat.convert(opts.center);
      let elev = null;
      try { elev = g.queryTerrainElevation(center); } catch (e) { /* quota del centro non pronta */ }
      for (let k = 0; k < 20; k++) {
        const tr = g.transform.clone();
        if (opts.padding) tr.setPadding(opts.padding);
        if (opts.bearing != null) tr.setBearing(opts.bearing);
        tr.setPitch(pitch);
        tr.setZoom(z);
        tr.setCenter(center);
        if (elev != null && Number.isFinite(elev)) tr.setElevation(elev);
        const cl = this._camClearance(tr, min);
        if (cl == null || cl >= 0) break;
        if (pitch > 20) pitch = Math.max(20, pitch - 5);
        else z -= 0.25; // pareti ripidissime: anche a 20° non basta
      }
    } catch (e) {
      z = opts.zoom; // controllo non riuscito: si va dove richiesto
      pitch = opts.pitch ?? g.getPitch();
    }
    return { ...opts, zoom: z, pitch };
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

  _sync3dCam() {
    const g = this._g3;
    if (!this._3d || !g || this._from3d || this._g3gest?.size) return; // durante un gesto con le dita decide l'utente
    const nav = this._nav;
    // MapLibre misura lo zoom con riquadri da 512 pixel, Leaflet da 256; in guida si aggiunge la distanza scelta dall'utente
    const z = nav?.fix && nav.follow && this._isGuida() ? this._base3dZoom() + this._zoom3dOff() : this._map.getZoom() - 1;
    const none = { top: 0, bottom: 0, left: 0, right: 0 };
    if (nav?.fix && nav.follow) {
      const guida = this._isGuida();
      const key = `${nav.fix.lat},${nav.fix.lon},${z},${nav.dir},${guida},${this._pitch3d()}`;
      if (key === this._g3key) return;
      this._g3key = key;
      const cam = this._clearCamera({ center: [nav.fix.lon, nav.fix.lat], zoom: z,
        bearing: guida && nav.dir != null ? nav.dir : g.getBearing(), pitch: guida ? this._pitch3d() : g.getPitch(),
        padding: guida ? { ...none, top: this.$("mapwrap").clientHeight * 0.45 } : none });
      g.easeTo({ ...cam, duration: 700, easing: (t) => t });
    } else {
      this._g3key = null;
      const c = this._map.getCenter();
      g.jumpTo(this._clearCamera({ center: [c.lng, c.lat], zoom: z, bearing: g.getBearing(), pitch: g.getPitch(), padding: none }));
    }
  }

  // dopo un cambio di dimensioni: mappa sulla posizione seguita, altrimenti sul centro di prima
  _relayout() {
    const m = this._map;
    if (!m) return;
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
    const delta = ((((this._nav.dir - cur) % 360) + 540) % 360) - 180; // giro più corto
    this._rot = cur + delta;
    this.$("map").style.transform = `rotate(${-this._rot}deg)`;
    this.$("map").style.setProperty("--maprot", `${this._rot}deg`);
  }

  // centra la mappa sulla posizione; in guida la posizione sta nel terzo basso dello schermo, con la strada davanti
  _followView(animate = true) {
    const nav = this._nav;
    const f = nav.fix;
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
    if (this._3d && Date.now() - (this._lastCenter || 0) < 1500 && this._zoom3dOff() !== 0) {
      this._setZoom3dOff(0);
      this._msg("Vista 3D: distanza predefinita");
    }
    this._lastCenter = Date.now();
    nav.follow = true;
    nav.manualZoomUntil = 0;
    const z = this._autoZoomOn() && nav.speed != null ? zoomForSpeed(nav.speed * 3.6) : 17;
    this._map.setZoom(z, { animate: false });
    this._g3key = null;
    if (nav.fix) this._followView();
    this._renderNav();
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
  _companion() {
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

  // app Companion Android: spesso la sua WebView non passa il GPS alle pagine, anche con tutte le autorizzazioni concesse.
  // La posizione arriva a Home Assistant dal sensore dell'app, nella propria persona.
  _staleHelp(source, age) {
    const st = this._hass.states[source];
    const name = st?.attributes?.friendly_name || source;
    const gps = window.isSecureContext && !!window.navigator.geolocation;
    const el = this.$("navpop");
    clearTimeout(this._nav?.popTimer);
    el.className = "navpop help";
    el.innerHTML = `<div class="big">🕘</div><h4>Posizione vecchia</h4>
      <div>L'ultima posizione di <b>${esc(name)}</b> è arrivata <b>${esc(fmtAge(age))}</b>: Home Assistant non ne riceve di nuove
        (di solito l'app Companion è chiusa o ha la posizione in background disattivata). La guida partirebbe da lì e si
        muoverebbe solo quando arriva una posizione nuova.</div>
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
    nav.cam = { to, maxspeed: next.maxspeed };
    nav.camsDone = nav.camsDone || new Set();
    if (!nav.camsDone.has(next.id) && to > 40) {
      nav.camsDone.add(next.id);
      const P = PHRASES[this._settings.lang];
      if (this._settings.voice) this._speak(`${P.camera(spokenDist(to, this._settings.lang))}${next.maxspeed ? `, ${P.limit(next.maxspeed)}` : ""}`, true);
      if (this._settings.beep) { this._beep(); setTimeout(() => this._beep(), 600); }
    }
  }

  // ----------------------------------------------------------------- impostazioni, voce e beep

  _saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this._settings)); } catch (e) { /* storage non disponibile */ }
  }

  // servizi notify dell'app Companion (mobile_app_…): prima quello del telefono della propria persona
  _notifyServices() {
    const list = Object.keys(this._hass?.services?.notify || {}).filter((n) => n.startsWith("mobile_app_"));
    const me = this._myPerson();
    const src = me && this._hass.states[me.id]?.attributes.source;
    const mine = src && `mobile_app_${src.split(".")[1]}`;
    return list.sort((a, b) => (b === mine) - (a === mine));
  }

  // dove si sente la voce: browser (computer, iPhone) o app Companion (Android, la cui pagina non sa parlare)
  _voiceOut() {
    const sel = this._settings.out;
    const browserOk = !!window.speechSynthesis && this._companion() !== "android";
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
    const browserOk = !!window.speechSynthesis && this._companion() !== "android";
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
        ${sw("autoZoom", "Zoom automatico in base alla velocità (mappa 2D)", "In guida: più vicino in città, più largo in autostrada. Dopo + o − resta il tuo zoom per 20 secondi")}
        ${sw("autoZoom3d", "Zoom automatico in base alla velocità (vista 3D)", "In guida la distanza dalla macchina cambia con la velocità, partendo da quella che hai scelto. Spento: la distanza resta sempre quella scelta")}
        <label class="line"><span>Modalità notte</span><select data-s="nightMode">${NIGHT_MODES.map(([v, n]) => `<option value="${v}" ${(s.nightMode || "auto") === v ? "selected" : ""}>${n}</option>`).join("")}</select></label>
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
        ${sw("clouds3d", "Nuvole in 3D", "In cielo, a 1–2 km di quota, tante quante la nuvolosità prevista nella zona (Open-Meteo); grigie dove piove")}
      </div>
      <div class="grp"><h3>Velocità</h3>
        ${sw("camAlert", "Avviso autovelox fissi", "Cartello nella barra della guida e, con le indicazioni vocali o il beep attivi, avviso a 600 metri (da 1 km in autostrada)")}
        ${sw("beep", "Beep quando superi il limite", "Limiti da OpenStreetMap, per auto e moto; tolleranza di 3 km/h (5% sopra i 60)")}
        <div class="row" style="margin-top:6px"><button data-s="testbeep">▶ Prova il beep</button></div>
      </div>
      ${this._garageHtml()}
      <div class="grp"><h3>Pulsanti all'arrivo</h3>
        <div class="note">In guida, a meno di 500 m dalla destinazione, tasti grandi nella barra in basso per azionare queste entità
          (cancello, garage, serratura, luci, script…).</div>
        <div class="chips">${(s.arrEntities || []).map((id) => `<span class="chip on" data-arrdel="${esc(id)}">${ARR_ICONS[id.split(".")[0]] || "⏻"} ${
          esc(this._hass.states[id]?.attributes?.friendly_name || id)} ✕</span>`).join("")}</div>
        <div class="row" style="margin:6px 0"><select data-arradd style="flex:1"><option value="">＋ Aggiungi un'entità…</option>${
          Object.values(this._hass.states).filter((st) => ARR_DOMAINS.includes(st.entity_id.split(".")[0]) && !(s.arrEntities || []).includes(st.entity_id))
            .sort((a, b) => (a.attributes.friendly_name || a.entity_id).localeCompare(b.attributes.friendly_name || b.entity_id))
            .map((st) => `<option value="${esc(st.entity_id)}">${ARR_ICONS[st.entity_id.split(".")[0]] || ""} ${esc(st.attributes.friendly_name || st.entity_id)}</option>`).join("")}</select></div>
        ${sw("arrHomeOnly", "Solo arrivando a Casa", "Spento: i tasti compaiono arrivando a qualsiasi destinazione")}
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
      <div class="grp note">Le impostazioni valgono per questo dispositivo.</div>
    </div>`;
    wrap.hidden = false;
    wrap.onclick = (e) => { if (e.target === wrap) wrap.hidden = true; };
    wrap.querySelector('[data-s="close"]').addEventListener("click", () => { wrap.hidden = true; });
    wrap.querySelectorAll("input[data-s]").forEach((el) => el.addEventListener("change", () => {
      s[el.dataset.s] = el.checked;
      this._saveSettings();
      if (el.dataset.s === "veh3d") { this._me3d?.remove(); this._me3d = null; this._drawVeh3d(); this._drawMe3d(); this._schedule3d(); }
      if (el.dataset.s === "clouds3d") { this._cloudKey = null; this._scheduleClouds(true); }
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
      if (k === "nightMode") this._applyNight();
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
    if (this._3d) requestAnimationFrame(() => this._placePitchCtl(this._nav?.follow && this._isGuida() ? this._pitch3d() : undefined));
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
      top.innerHTML = `<span class="ic">${maneuverIcon(next)}</span><div><div class="d">${toNext < 15 ? "Ora" : fmtDist(toNext)}</div><div class="t">${esc(next.text)}</div>${lanes}</div>`;
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
    const modeIco = (MODES.find((m) => m[0] === this._mode) || MODES[0])[1];
    bot.querySelector(".info").innerHTML = `<span title="Mezzo del percorso">${modeIco}</span><span class="rem">${fmtTime(remTime)}</span><span>${fmtKm(remM / 1000)} · arrivo ${arrival(remTime)}</span>
      ${kmh != null ? `<span class="spd ${nav.over ? "over" : ""}" title="Velocità">${kmh} km/h</span>` : ""}
      ${nav.limit ? `<span class="lim" title="Limite di velocità">${nav.limit}</span>` : ""}
      ${nav.cam ? `<span class="cam" title="Autovelox fisso">📷 ${fmtDist(nav.cam.to)}${nav.cam.maxspeed ? ` · ${nav.cam.maxspeed}` : ""}</span>` : ""}`;
    const c = bot.querySelector('[data-n="center"]');
    c.classList.toggle("attn", !nav.follow);
    c.title = nav.follow ? "La mappa segue la tua posizione" : "Torna sulla tua posizione";
  }

  // barra in basso della guida: tempi e, sotto, zoom, centra, tipo di mappa ed Esci
  _buildNavBar() {
    const bot = this.$("navbot");
    const opts = Object.entries(LAYERS).map(([k, v]) => `<option value="${k}" ${k === this._layer ? "selected" : ""}>${esc(v[0])}</option>`).join("");
    bot.innerHTML = `<div class="arr" hidden></div><div class="info"></div>
      <div class="tools">
        <button data-n="out" title="Riduci">−</button>
        <button data-n="in" title="Ingrandisci">+</button>
        <button data-n="center" title="Centra sulla tua posizione">◎</button>
        <button data-n="near" title="Distributori, parcheggi e autovelox">🔎</button>
        <button data-n="3d" class="b3d" title="Vista 3D con rilievo ed edifici">3D</button>
        <button data-n="full" title="Schermo intero">${FS_ON}</button>
        <select data-n="layer" title="Tipo di mappa">${opts}</select>
        <button class="stop" data-n="stop" title="Esci dalla navigazione">■ Esci</button>
      </div>`;
    // + e −: in 3D, mentre la vista segue, cambiano la distanza memorizzata; altrimenti lo zoom come sempre
    const zoomBtn = (d) => {
      if (this._3d && this._nav?.follow && this._isGuida()) {
        this._setZoom3dOff(this._zoom3dOff() + d * 0.5);
        this._g3key = null;
        this._sync3d();
        return;
      }
      if (d > 0) this._map.zoomIn(); else this._map.zoomOut();
      this._afterZoom();
    };
    bot.querySelector('[data-n="out"]').addEventListener("click", () => zoomBtn(-1));
    bot.querySelector('[data-n="in"]').addEventListener("click", () => zoomBtn(1));
    bot.querySelector('[data-n="center"]').addEventListener("click", () => this._recenter());
    bot.querySelector('[data-n="layer"]').addEventListener("change", (e) => {
      this._setLayer(e.target.value);
      this.$("layer").value = e.target.value;
      this.$("gattr").innerHTML = LAYERS[this._layer][3];
      this._saveState();
    });
    bot.querySelector('[data-n="near"]').addEventListener("click", () => this._openNearby(this._nearCat || "fuel"));
    bot.querySelector('[data-n="stop"]').addEventListener("click", () => this._stopNav());
    bot.querySelector('[data-n="full"]').addEventListener("click", () => this._toggleFull());
    bot.querySelector('[data-n="3d"]').addEventListener("click", () => this._toggle3d());
    this._syncFullBtns();
    this._sync3dBtns();
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
        points: this._points.map((p) => ({ lat: p.lat, lon: p.lon, name: p.name, address: p.address || "" })),
        mode: this._mode,
        avoid_tolls: this._avoid.tolls,
        avoid_highways: this._avoid.highways,
        avoid_ferries: this._avoid.ferries,
        exclude: this._excluded.flatMap((e) => e.points).slice(0, 40),
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
  }

  _drawRoute() {
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
    L.polyline(ahead, { color: "#fff", weight: 10, opacity: 0.9, interactive: false }).addTo(this._routeLayer);
    L.polyline(ahead, { color, weight: 6, opacity: 1, interactive: false, arrows: true }).addTo(this._routeLayer);
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
    const box = this.$("navbot")?.querySelector(".arr");
    if (!box) return;
    const nav = this._nav;
    const s = this._settings;
    const dest = this._points[this._points.length - 1];
    const ids = (s.arrEntities || []).filter((id) => this._hass.states[id]);
    let show = !!(nav?.fix && dest && ids.length) && distM([nav.fix.lat, nav.fix.lon], [dest.lat, dest.lon]) < 500;
    if (show && s.arrHomeOnly) {
      const h = this._homePoint();
      show = distM([dest.lat, dest.lon], [h.lat, h.lon]) < 250;
    }
    const key = show ? ids.join(",") : "";
    if (box.dataset.k === key) return;
    box.dataset.k = key;
    box.hidden = !show;
    box.innerHTML = show ? ids.map((id) => {
      const st = this._hass.states[id];
      return `<button data-arr="${esc(id)}">${ARR_ICONS[id.split(".")[0]] || "⏻"} ${esc(st.attributes.friendly_name || id)}</button>`;
    }).join("") : "";
    box.querySelectorAll("[data-arr]").forEach((b) => b.addEventListener("click", () => this._pressEntity(b.dataset.arr)));
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
    for (const p of this._wx?.items || []) {
      if (!p.warn?.length) continue;
      const w = p.warn[0];
      L.marker(p.ll, { title: `${w.txt} · ${fmtClock(p.t)}${p.temp != null ? ` · ${Math.round(p.temp)} °C` : ""}`,
        icon: L.divIcon({ className: "", html: `<div class="wxm">${w.ico}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }) }).addTo(lay);
    }
    this._schedule3d();
  }

  _wxHtml() {
    const wx = this._wx;
    if (!wx || !this._result || wx.rt !== this._result.routes[this._sel]) return "";
    if (wx.loading) return `<div class="sec"><h3>Meteo lungo il percorso</h3><div class="muted"><span class="loading"></span> Previsioni…</div></div>`;
    if (wx.error) return `<div class="sec"><h3>Meteo lungo il percorso</h3><div class="muted">${esc(wx.error)}</div></div>`;
    const temps = wx.items.map((p) => p.temp).filter((t) => t != null);
    const warns = wx.items.flatMap((p) => (p.warn || []).map((w) => ({ ...w, p })));
    const range = temps.length ? `${Math.round(Math.min(...temps))}–${Math.round(Math.max(...temps))} °C` : "";
    const list = warns.slice(0, 8).map(({ ico, txt, p }) => `<li>${ico} <b>${esc(txt)}</b> · km ${Math.round(p.along / 1000)} · ${fmtClock(p.t)}${
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
      this._navPopup("warn", w.ico, `${esc(w.txt)} tra ${fmtDist(to)}${p.temp != null ? `<br><b>${Math.round(p.temp)} °C</b>` : ""}`, 6000);
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
      const monthOf = (t) => new Date(t.start * 1000).toLocaleDateString("it-IT", { month: "long", year: "numeric" });
      let month = "";
      trips.forEach((t, k) => {
        const d = new Date(t.start * 1000);
        const m = monthOf(t);
        if (m !== month) {
          month = m;
          const inM = trips.filter((x) => monthOf(x) === m);
          html += `<div class="month">${m.charAt(0).toUpperCase() + m.slice(1)}<span>${inM.length} · ${fmtKm(inM.reduce((a, x) => a + (x.km || 0), 0))} · ${
            fmtTime(inM.reduce((a, x) => a + (x.duration || 0), 0))}</span></div>`;
        }
        const when = `${d.toLocaleDateString("it-IT", { weekday: "short", day: "numeric" })} ${d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`;
        const v = t.vehicle || {};
        const veh = v.type ? ` · ${vehIcon(v.type)} ${esc(v.name || "")}${v.plate ? ` ${esc(v.plate)}` : ""}` : "";
        const col = this._tripSel.get(t.id);
        html += `<div class="trip"><input type="checkbox" data-tc="${k}" ${col ? "checked" : ""} style="--tc:${col || ""}" title="Mostra sulla mappa">
          ${col ? `<span class="sw" style="background:${col}"></span>` : ""}
          <div class="nm" data-tv="${k}">${esc(t.from || "?")} → ${esc(t.to || "?")}
          <small>${t.status === "in_corso" ? "🔴 in corso · " : t.status === "interrotto" ? "⚠ interrotto (senza Esci) · " : ""}${when}${veh} · ${fmtKm(t.km || 0)} · ${fmtTime(t.duration || 0)} · media ${Math.round(t.avg || 0)} · max ${Math.round(t.max || 0)} km/h</small></div>
          <button class="icon" data-td="${k}" title="Elimina">🗑</button></div>`;
      });
    }
    box.innerHTML = html;
    box.querySelector('[data-t="none"]')?.addEventListener("click", () => { this._tripSel.clear(); this._drawTrips(); this._renderTrips(); });
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
          this._tripTracks.set(t.id, (await this._hass.callWS({ type: "navigator/trip", trip_id: t.id })).track || []);
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

  async _saveGarage(list) {
    try {
      this._garage = (await this._hass.callWS({ type: "navigator/garage_save", vehicles: list })).vehicles;
    } catch (e) {
      this._msg(`Garage non salvato: ${e.message || e}`);
    }
    this._renderPlanSel();
    if (this._result) this._renderResults();
  }

  _garageHtml() {
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
          </div>
          <div class="row" style="gap:6px;align-items:center;margin-top:6px">
            <input class="inp" data-g="name" data-k="${k}" placeholder="Nome (es. Panda)" value="${esc(v.name)}" style="flex:1;min-width:90px">
            <input class="inp" data-g="plate" data-k="${k}" placeholder="Targa" value="${esc(v.plate)}" style="width:100px;text-transform:uppercase">
            <button class="icon" data-g="del" data-k="${k}" title="Elimina">✕</button>
          </div>
        </div></div>`;
    }).join("");
    return `<div class="grp"><h3>Garage</h3>
      <div class="note">Garage <b>condiviso</b> da tutti gli utenti di Home Assistant: chiunque può aggiungere o modificare i veicoli.
        Scegli disegno e colore che vedrai sulla mappa; alla partenza ognuno sceglie il suo nel menu Veicolo (la scelta resta per
        ogni utente) e il diario dei viaggi lo ricorda. Con "Base" il mezzo si sceglie con i bottoni.</div>
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
    return this._nightOn && (this._layer === "sat" || this._layer === "otm") ? { "raster-brightness-max": 0.6, "raster-saturation": -0.2 } : {};
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

  async _loadPois() {
    const m = this._map;
    if (!m || !this._poiTiles) return;
    if (!this._poiKindsOn().size) { this._poiStatus(""); this._renderPois(); return; }
    // in 2D: i riquadri z14 di OpenFreeMap (gli stessi del 3D) letti dal browser; Overpass solo se OpenFreeMap non risponde
    if (!this._3d && !this._ofmDown) {
      if (await this._loadOfmPois()) return;
    }
    // in 3D i punti arrivano con le mappe di OpenFreeMap (subito, dal browser): niente Overpass
    if (this._3d && this._g3ok && this._g3?.getSource("ofm")) {
      this._poiStatus("");
      this._renderPois();
      console.debug("[Navigator POI] 3D: punti dalle mappe di OpenFreeMap", this._poiShown?.length || 0);
      return;
    }
    if (m.getZoom() < POI_MIN_ZOOM) {
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
  async _loadOfmPois() {
    const m = this._map;
    const z = 14;
    const n = 2 ** z;
    const b = m.getBounds();
    const tx = (lon) => Math.floor(((lon + 180) / 360) * n);
    const ty = (lat) => Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
    const c = m.getCenter();
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
        const tj = await (await fetch(OFM_URL)).json();
        this._ofmTpl = (tj.tiles || [])[0];
        if (!this._ofmTpl) throw new Error("TileJSON senza riquadri");
      }
      for (const k of todo) this._ofmTiles.set(k, null); // in corso
      await Promise.all(todo.map(async (k) => {
        const [tz, x, y] = k.split("/").map(Number);
        const r = await fetch(this._ofmTpl.replace("{z}", tz).replace("{x}", x).replace("{y}", y));
        if (!r.ok) throw new Error(`OpenFreeMap: errore ${r.status}`);
        const items = [];
        for (const p of mvtPoints(await r.arrayBuffer(), "poi", tz, x, y)) {
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
    if (!kinds.size || this._map.getZoom() < POI_MIN_ZOOM) return [];
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
    if (!this._3d && this._ofmView) {
      const b = this._map.getBounds().pad(0.1);
      for (const k of this._ofmView) {
        for (const it of this._ofmTiles?.get(k) || []) {
          if (kinds.has(it.k) && !seen.has(it.id) && b.contains([it.lat, it.lon])) { seen.add(it.id); out.push(it); }
        }
      }
    }
    for (const key of this._ofmDown || this._3d ? this._poiView || [] : []) {
      for (const it of this._poiTiles.get(key)?.items || []) {
        if (kinds.has(it.k) && !seen.has(it.id)) { seen.add(it.id); out.push(it); }
      }
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
    const open = (it) => this._showPlace({ name: it.name || POI_KINDS[it.k][0], address: POI_KINDS[it.k][0], lat: it.lat, lon: it.lon,
      poi: { name: it.name || "", osm: /^[nwr]\d+$/.test(it.id || "") ? it.id : "" } }, false);
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
        L.marker([it.lat, it.lon], { title: `${it.name || label} · ${label}`,
          icon: L.divIcon({ className: "", html: `<div class="poim" style="background:${col}">${ico}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) })
          .on("click", () => open(it)).addTo(this._poiMapLayer);
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
          feats.push({ type: "Feature", properties: { c: POI_KINDS[it.k][2], h: Number(f.properties?.render_height) || 8 },
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

  _renderResults() {
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
          <div class="tags">${tags.join("")}</div></div>`;
      });
      html += `</div>`;
      for (const w of r.warnings || []) html += `<div class="box warn">${esc(w)}</div>`;

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
      const rt = r.routes[this._sel];
      const dest = this._points[this._points.length - 1];
      html += `<div class="sec"><h3>Indicazioni <span class="muted" style="text-transform:none">${rt.maneuvers.length} passi</span></h3><ul class="steps">`;
      let leg = 0;
      rt.maneuvers.forEach((m, k) => {
        if (m.leg !== leg) {
          leg = m.leg;
          const p = this._points[leg];
          html += `<li class="legsep"><span class="ic">📍</span><span class="tx">Tappa ${leg}: ${esc(p?.name || "")}</span></li>`;
        }
        html += `<li data-k="${k}" class="${m.toll ? "toll" : ""}"><span class="ic">${maneuverIcon(m)}</span><span class="tx">${esc(m.text)}</span>
          <span class="d">${m.length_km > 0 ? fmtKm(m.length_km) : ""}</span></li>`;
      });
      html += `</ul></div>`;
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
    // cambiando la fonte in "Segui la posizione di", il punto blu passa subito alla nuova fonte
    this._renderPlanSel();
    box.querySelectorAll(".alt").forEach((el) => el.addEventListener("click", () => this._select(+el.dataset.i)));
    box.querySelectorAll(".steps li[data-k]").forEach((el) => el.addEventListener("click", () => {
      const m = r.routes[this._sel].maneuvers[+el.dataset.k];
      const shape = r.routes[this._sel].shape;
      const seg = shape.slice(m.begin, Math.max(m.end, m.begin) + 1);
      if (seg.length > 1 && m.length_km > 0.5) this._map.fitBounds(L.latLngBounds(seg), { padding: [40, 40], maxZoom: 17 });
      else this._map.setView(shape[m.begin], 17);
    }));
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

  _renderFavs() {
    const box = this.$("favsec");
    const favs = this._info?.favorites || [];
    const rec = this._info?.recent || [];
    let html = `<h3>Preferiti</h3>`;
    if (!favs.length) html += `<div class="muted">Nessun preferito: cerca un luogo o clicca sulla mappa e premi ★.</div>`;
    favs.forEach((f, k) => {
      html += `<div class="fav"><span>${esc(f.icon || "★")}</span><div class="nm" data-f="${k}">${esc(f.name)}<small>${esc(f.address || "")}</small></div>
        <button class="icon" data-go="${k}" title="Portami qui">➜</button><button class="icon" data-del="${k}" title="Elimina">🗑</button></div>`;
    });
    if (rec.length) {
      html += `<h3 style="margin-top:14px">Destinazioni recenti <button class="link" data-a="clearrec">Cancella</button></h3>`;
      rec.slice(0, 6).forEach((f, k) => {
        html += `<div class="fav"><span>🕘</span><div class="nm" data-r="${k}">${esc(f.name)}<small>${esc(f.address || "")}</small></div>
          <button class="icon" data-rgo="${k}" title="Portami qui">➜</button></div>`;
      });
    }
    box.innerHTML = html;
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
