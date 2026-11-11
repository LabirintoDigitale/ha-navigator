// Pannello "Navigator" per Home Assistant: mappa, ricerca di destinazioni e itinerari
// con servizi gratuiti basati su OpenStreetMap (Valhalla / OSRM per i percorsi, Photon / Nominatim per la ricerca).

import * as L from "./leaflet/leaflet-src.esm.js";

// deve coincidere con VERSION in const.py: se il backend ne riporta un'altra manca un riavvio
const PANEL_VERSION = "1.4.3";

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

// il veicolo in navigazione: fuoristrada blu scuro visto dall'alto, tetto in due pannelli e hardtop posteriore grigio;
// il muso è in alto (direzione di marcia)
const CAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 80" width="26" height="47">
  <defs>
    <linearGradient id="nvb" x1="0" x2="1"><stop offset="0" stop-color="#0a2150"/><stop offset=".5" stop-color="#173a7a"/><stop offset="1" stop-color="#0a2150"/></linearGradient>
    <linearGradient id="nvg" x1="0" x2="1"><stop offset="0" stop-color="#7d8792"/><stop offset=".5" stop-color="#aeb6bf"/><stop offset="1" stop-color="#7d8792"/></linearGradient>
    <linearGradient id="nvv" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5c7fb8"/><stop offset="1" stop-color="#1c355f"/></linearGradient>
  </defs>
  <rect x="1" y="12" width="5" height="13" rx="2" fill="#151515"/><rect x="38" y="12" width="5" height="13" rx="2" fill="#151515"/>
  <rect x="1" y="54" width="5" height="13" rx="2" fill="#151515"/><rect x="38" y="54" width="5" height="13" rx="2" fill="#151515"/>
  <rect x="4" y="2" width="36" height="76" rx="8" fill="url(#nvb)" stroke="#fff" stroke-width="1.6"/>
  <rect x="7" y="3.2" width="7" height="2.6" rx="1.2" fill="#ffe28a"/><rect x="30" y="3.2" width="7" height="2.6" rx="1.2" fill="#ffe28a"/>
  <rect x="7" y="74.4" width="6" height="2.4" rx="1" fill="#e53935"/><rect x="31" y="74.4" width="6" height="2.4" rx="1" fill="#e53935"/>
  <path d="M15 6 L15 18 M29 6 L29 18" stroke="#2b5299" stroke-width="1.2" stroke-linecap="round"/>
  <ellipse cx="3" cy="27" rx="3" ry="1.8" fill="#0a2150" stroke="#fff" stroke-width=".8"/>
  <ellipse cx="41" cy="27" rx="3" ry="1.8" fill="#0a2150" stroke="#fff" stroke-width=".8"/>
  <path d="M8 29 Q22 20 36 29 L34 33 Q22 27 10 33 Z" fill="url(#nvv)"/>
  <rect x="10" y="33.5" width="11.3" height="14" rx="2" fill="#123372" stroke="#06142f" stroke-width=".8"/>
  <rect x="22.7" y="33.5" width="11.3" height="14" rx="2" fill="#123372" stroke="#06142f" stroke-width=".8"/>
  <rect x="9" y="48.5" width="26" height="22" rx="2.5" fill="url(#nvg)" stroke="#5a636c" stroke-width=".8"/>
  <path d="M15 51 L15 68 M19.7 51 L19.7 68 M24.3 51 L24.3 68 M29 51 L29 68" stroke="#6c757e" stroke-width="1" stroke-linecap="round"/>
  <rect x="11" y="70.8" width="22" height="2.6" rx="1" fill="#1c355f"/>
</svg>`;

// moto vista dall'alto: ruote, manubrio con specchietti, serbatoio blu, sella grigia e motociclista col casco
const MOTO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 80" width="18" height="47">
  <rect x="12" y="1.5" width="6" height="17" rx="3" fill="#151515"/>
  <rect x="11.5" y="60" width="7" height="18.5" rx="3.5" fill="#151515"/>
  <path d="M9 14 Q15 8 21 14 L20 24 L10 24 Z" fill="#173a7a" stroke="#fff" stroke-width="1.2"/>
  <rect x="12.5" y="9.5" width="5" height="2.4" rx="1.2" fill="#ffe28a"/>
  <rect x="2" y="21" width="26" height="2.6" rx="1.3" fill="#222" stroke="#fff" stroke-width=".7"/>
  <ellipse cx="3.5" cy="18.5" rx="2.6" ry="1.6" fill="#0a2150" stroke="#fff" stroke-width=".7"/>
  <ellipse cx="26.5" cy="18.5" rx="2.6" ry="1.6" fill="#0a2150" stroke="#fff" stroke-width=".7"/>
  <ellipse cx="15" cy="31" rx="7" ry="8" fill="#173a7a" stroke="#fff" stroke-width="1.2"/>
  <rect x="10.5" y="45" width="9" height="14" rx="3.5" fill="#9aa3ad" stroke="#5a636c" stroke-width=".8"/>
  <rect x="12" y="58.6" width="6" height="2" rx="1" fill="#e53935"/>
  <path d="M7 41 L4.5 23.5 M23 41 L25.5 23.5" stroke="#0e2a5c" stroke-width="3.2" stroke-linecap="round"/>
  <ellipse cx="15" cy="42" rx="10.5" ry="6" fill="#0e2a5c" stroke="#fff" stroke-width="1.2"/>
  <circle cx="15" cy="38" r="6.2" fill="#0a2150" stroke="#fff" stroke-width="1.2"/>
  <path d="M10.3 35.5 Q15 30.6 19.7 35.5 Q15 33.4 10.3 35.5 Z" fill="#5c7fb8"/>
</svg>`;

// bicicletta vista dall'alto: ruote sottili, telaio, manubrio e ciclista col caschetto
const BICI_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 80" width="18" height="47">
  <rect x="13.4" y="1" width="3.2" height="22" rx="1.6" fill="#151515"/>
  <rect x="13.4" y="57" width="3.2" height="22" rx="1.6" fill="#151515"/>
  <path d="M15 21 L15 60" stroke="#8a939c" stroke-width="2.2" stroke-linecap="round"/>
  <rect x="4" y="18.5" width="22" height="2.2" rx="1.1" fill="#333" stroke="#fff" stroke-width=".6"/>
  <ellipse cx="15" cy="52" rx="2.8" ry="4.2" fill="#222"/>
  <path d="M7.5 40 L5.5 20.5 M22.5 40 L24.5 20.5" stroke="#173a7a" stroke-width="3" stroke-linecap="round"/>
  <ellipse cx="15" cy="41" rx="10" ry="5.6" fill="#173a7a" stroke="#fff" stroke-width="1.2"/>
  <ellipse cx="15" cy="37" rx="5" ry="6.6" fill="#0a2150" stroke="#fff" stroke-width="1.2"/>
  <path d="M13 32.5 L13 41.5 M17 32.5 L17 41.5" stroke="#9aa3ad" stroke-width="1" stroke-linecap="round"/>
</svg>`;

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

const VEHICLE_SVG = { auto: CAR_SVG, moto: MOTO_SVG, bici: BICI_SVG, piedi: PIEDI_SVG };

// impostazioni salvate su questo dispositivo
const SETTINGS_KEY = "navigator-panel-settings";
const DEFAULT_SETTINGS = { voice: false, lang: "it", voiceSel: "f", out: "auto", autoZoom: true, beep: false,
  fuelBrands: [], fuelKind: "", camAlert: true, view3d: false, b3d: true, terrainEx: "1.5", pitch3d: 60 };
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
  #map.rot { transition: transform .8s ease-out; }
  #map.rot.moving { transition: none; }
  .main.guida #map { touch-action: none; cursor: grab; }
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
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (this._menuBtn) this._menuBtn.hass = hass;
    if (this._nav && this._nav.source !== "gps") this._entityFix();
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
          <div class="sec">
            <h3>Cerca un luogo</h3>
            <div class="field search"><input type="text" id="q" placeholder="Indirizzo, città, attività…" autocomplete="off"></div>
            <div id="placecard"></div>
          </div>
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
            <div class="row" style="margin-top:10px"><button class="primary" id="go" style="flex:1">Calcola percorso</button></div>
          </div>
          <div id="results"></div>
          <div class="sec" id="favsec"></div>
          <div class="sec muted" style="font-size:12px">Percorsi: Valhalla (FOSSGIS) · OSRM — Ricerca: Photon (komoot) · Nominatim — Mappe Esri e OpenTopoMap, dati © OpenStreetMap e collaboratori.
            Servizi gratuiti con limiti d'uso: le richieste passano da Home Assistant.
            <div class="footver"><img src="${ICON}" alt=""> Navigator versione ${PANEL_VERSION} ·
              <a href="https://github.com/LabirintoDigitale/ha-navigator" target="_blank" rel="noopener">LabirintoDigitale/ha-navigator</a></div></div>
        </div>
        <div class="mapwrap" id="mapwrap">
          <div id="map"></div>
          <div id="map3d" hidden></div>
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
    this._map.on("click", (e) => this._mapClick(e.latlng));
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
    document.addEventListener("visibilitychange", () => this._updateAwake());

    // controlli
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
    const [, url, maxZoom, attribution] = LAYERS[key];
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
      <div class="row">
        <button class="primary" data-a="dest">➜ Portami qui</button>
        <button data-a="stop">＋ Tappa</button>
        <button data-a="start">Parti da qui</button>
        <button data-a="fav" title="Salva nei preferiti">★</button>
        <button class="icon" data-a="close" title="Chiudi">✕</button>
      </div></div>`;
    box.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => this._placeAction(b.dataset.a, p)));
    this._drawMarkers();
    if (fly) this._map.flyTo([p.lat, p.lon], Math.max(this._map.getZoom(), 15), { duration: 0.8 });
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
    // i popup di Leaflet vivono nello shadow DOM: servono gli stili del pannello
    const popup = L.popup({ maxWidth: 300 }).setLatLng(latlng).setContent(el).openOn(this._map);
    let place = { name: `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`, address: "", lat: latlng.lat, lon: latlng.lng };
    el.querySelectorAll("button").forEach((b) => b.addEventListener("click", (ev) => {
      L.DomEvent.stopPropagation(ev);
      this._map.closePopup(popup);
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
    if (this._me) {
      L.marker([this._me.lat, this._me.lon], { icon: L.divIcon({ className: "", html: '<div class="me"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
        title: "La mia posizione", interactive: false }).addTo(this._markerLayer);
    }
  }

  _locate(fly) {
    return new Promise((resolve) => {
      const android = this._companion() === "android";
      // app Android: se il GPS della pagina non risponde si ripiega sulla propria persona
      const fromPerson = () => {
        const me = this._myPerson();
        const st = me && this._hass.states[me.id];
        if (!st) return false;
        this._me = { lat: st.attributes.latitude, lon: st.attributes.longitude };
        this._drawMarkers();
        if (fly) this._map.flyTo([this._me.lat, this._me.lon], 15, { duration: 0.8 });
        resolve(this._me);
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
        this._me = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        this._drawMarkers();
        if (fly) this._map.flyTo([this._me.lat, this._me.lon], 15, { duration: 0.8 });
        resolve(this._me);
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
      out.push({ id, name: `${id.startsWith("person.") ? "👤" : "📡"} ${st.attributes.friendly_name || id}`, ok: true });
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

  _navSectionHtml() {
    if (this._nav) {
      const src = this._navSources().find((s) => s.id === this._nav.source);
      return `<div class="sec"><h3>Navigazione attiva</h3>
        <div class="row"><button class="primary" data-a="navstop" style="flex:1;background:#c62828;border-color:#c62828">■ Ferma navigazione</button></div>
        <div class="muted" style="margin-top:6px">Posizione da: ${esc(src?.name || this._nav.source)}. Se esci dal percorso per qualche secondo,
          Navigator ricalcola la strada da dove sei.</div></div>`;
    }
    const list = this._navSources();
    const def = this._defaultNavSource(list);
    const opts = list.map((s) => `<option value="${esc(s.id)}" ${s.id === def ? "selected" : ""} ${s.ok ? "" : "disabled"}>${esc(s.name)}</option>`).join("");
    const hint = this._companion() === "android"
      ? `<div class="muted" style="margin-top:6px">Nell'app Android puoi provare il GPS del dispositivo; se l'app non lo passa alla pagina
         scegli la tua persona. Per seguirti bene in auto con la persona attiva
         nell'app la posizione ad alta precisione (Impostazioni → App Companion → Gestisci sensori → Posizione in background →
         Modalità alta precisione).</div>`
      : window.isSecureContext ? ""
      : `<div class="muted" style="margin-top:6px">Home Assistant è aperto in http: il browser non concede il GPS. Usa la posizione che l'app
         Companion invia a Home Assistant; per aggiornamenti ogni pochi secondi attiva nell'app la posizione ad alta precisione
         (Impostazioni → App Companion → Gestisci sensori → Posizione in background → Modalità alta precisione).</div>`;
    return `<div class="sec"><h3>Navigazione</h3>
      <label class="muted" style="display:block;margin-bottom:4px">Segui la posizione di</label>
      <select class="inp" id="navsrc">${opts}</select>
      <div class="row" style="margin-top:8px"><button class="primary" data-a="navstart" style="flex:1">▶ Parti</button></div>${hint}
      <button class="link" data-a="gpshelp" style="margin-top:6px;padding-left:0">📡 Problemi con il GPS? Posizione negata?</button></div>`;
  }

  async _startNav(source) {
    if (!this._result) return;
    if (source === "gps" && !(window.isSecureContext && window.navigator.geolocation)) {
      this._msg("Il GPS del browser richiede Home Assistant in HTTPS: scegli la posizione dell'app Companion");
      return;
    }
    try { localStorage.setItem(`${STORE_KEY}-navsrc`, source); } catch (e) { /* storage non disponibile */ }
    this._sel = 0;
    this._nav = { source, follow: true, idx: 0, passed: 0, offSince: null, offCount: 0, rerouting: false, lastReroute: 0,
      lastKey: null, fix: null, arrived: false, view: "guida", dir: null };
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
    if (nav.watch != null) window.navigator.geolocation.clearWatch(nav.watch);
    clearTimeout(nav.popTimer);
    this._nav = null;
    this._updateAwake();
    this._meMarker?.remove();
    this._accCircle?.remove();
    this._meMarker = this._accCircle = null;
    this._me3d?.remove();
    this._me3d = null;
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
    const prev = nav.fix;
    if (prev && distM([prev.lat, prev.lon], [fix.lat, fix.lon]) > 3) {
      nav.heading = bearing([prev.lat, prev.lon], [fix.lat, fix.lon]);
    }
    // velocità (m/s): quella del GPS o dell'app, altrimenti dallo spostamento fra due posizioni
    let speed = typeof fix.speed === "number" && !Number.isNaN(fix.speed) && fix.speed >= 0 ? fix.speed : null;
    if (speed == null && prev && now - prev.time > 800) speed = distM([prev.lat, prev.lon], [fix.lat, fix.lon]) / ((now - prev.time) / 1000);
    if (speed != null) nav.speed = nav.speed == null ? speed : nav.speed * 0.4 + speed * 0.6;
    nav.fix = { ...fix, time: now };

    const rt = this._geom(this._result.routes[this._sel]);
    const snap = this._snap(rt, fix, nav.idx);
    const slow = this._mode === "piedi" || this._mode === "bici";
    // tolleranza: strada + imprecisione del GPS
    const limit = (slow ? 30 : 45) + Math.min(fix.acc || 0, 80);
    nav.snap = snap;
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
    }
    this._speedCheck(rt, snap.dist <= limit ? snap.idx : null);
    if (snap.dist <= limit) this._cameraCheck(rt, snap.along);
    this._renderNav();
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
      const icon = L.divIcon({ className: "", iconSize: [47, 47], iconAnchor: [23.5, 23.5], html: `<div class="nav-car">${VEHICLE_SVG[this._mode] || CAR_SVG}</div>` });
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
    const m = this._map;
    this.$("mainbox").classList.toggle("guida", g);
    if (g) {
      m.dragging.disable();
      m.doubleClickZoom.disable();
      m.options.scrollWheelZoom = "center"; // lo zoom resta sul centro: con la mappa ruotata il punto del mouse non torna
      m.touchZoom.disable();
      m.options.zoomSnap = 0.25;
    } else {
      m.dragging.enable();
      m.doubleClickZoom.enable();
      m.options.scrollWheelZoom = true;
      m.touchZoom.enable();
      if (m.options.zoomSnap !== 1) {
        m.options.zoomSnap = 1;
        m.setZoom(Math.round(m.getZoom()), { animate: false });
      }
    }
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
      try {
        await this._init3d();
      } catch (e) {
        this._3d = false;
        this._sync3dBtns();
        this._msg(`Vista 3D non disponibile: ${e.message || e}`);
        return;
      }
      if (!this._3d) return; // spenta mentre si caricava
      this.$("map3d").hidden = false;
      this.$("map").classList.add("under3d");
      if (this._tiles && this._map.hasLayer(this._tiles)) this._map.removeLayer(this._tiles);
      this.$("gattr").hidden = true;
      this._g3.resize();
      this._update3d();
      this._sync3d();
      this._placePitchCtl();
    } else {
      this.$("map3d").hidden = true;
      this.$("map").classList.remove("under3d");
      this.$("gattr").hidden = !this._isGuida();
      this._placePitchCtl();
      if (this._tiles && !this._map.hasLayer(this._tiles)) this._tiles.addTo(this._map);
    }
    this._settings.view3d = this._3d;
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
  }

  _baseSource() {
    const [, url, maxZoom, attribution] = LAYERS[this._layer] || LAYERS.strade;
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
          { id: "base", type: "raster", source: "base" },
          { id: "hs", type: "hillshade", source: "hs", paint: { "hillshade-exaggeration": 0.3, "hillshade-shadow-color": "#3e3a36" } },
          { id: "lines", type: "line", source: "lines", layout: { "line-join": "round", "line-cap": "round", "line-sort-key": ["get", "i"] },
            paint: { "line-color": ["get", "c"], "line-width": ["get", "w"], "line-opacity": ["get", "o"] } },
        ],
        terrain: { source: "dem", exaggeration: +this._settings.terrainEx || 1.5 },
        sky: { "sky-color": "#8cc3f0", "horizon-color": "#dcebf7", "fog-color": "#f2f2f2", "sky-horizon-blend": 0.6,
          "horizon-fog-blend": 0.5, "fog-ground-blend": 0.85, "atmosphere-blend": 0.6 },
      },
    });
    this._g3 = g;
    this._g3markers = [];
    // pronta appena c'è lo stile, senza aspettare i primi riquadri (con rete lenta il "load" arriva tardi)
    this._g3ready = new Promise((ok) => { g.once("style.load", ok); g.once("load", ok); }).then(() => { this._g3ok = true; });
    g.on("error", (e) => console.debug("Navigator 3D:", e?.error?.message || e)); // riquadri mancanti: la vista va avanti
    // movimenti fatti a mano nella vista 3D: la guida smette di seguire, Leaflet si sposta nello stesso punto
    for (const ev of ["dragstart", "zoomstart", "rotatestart", "pitchstart"]) {
      g.on(ev, (e) => {
        if (!e.originalEvent) return;
        if (ev === "zoomstart" && this._nav) this._nav.manualZoomUntil = Date.now() + 20000;
        if (ev !== "pitchstart") this._userMoved();
      });
    }
    g.on("moveend", (e) => {
      if (!e.originalEvent || (this._nav?.follow)) return;
      const cc = g.getCenter();
      this._from3d = true;
      try { this._map.setView([cc.lat, cc.lng], g.getZoom() + 1, { animate: false }); } finally { this._from3d = false; }
    });
    g.on("click", (e) => this._mapClick(L.latLng(e.lngLat.lat, e.lngLat.lng)));
    g.on("pitchend", () => this._placePitchCtl());
    // quando le quote del terreno sono arrivate si ricontrolla: se la telecamera è finita sotto una collina ci si allontana
    // (solo misura, nessun movimento se è tutto a posto: così "idle" non si ripete all'infinito)
    g.on("idle", () => {
      if (!this._3d) return;
      const cl = this._camClearance();
      if (cl == null || cl >= 5) return; // solo se la telecamera è davvero quasi dentro il terreno
      const cam = this._clearCamera({ center: g.getCenter(), zoom: g.getZoom(), bearing: g.getBearing(), pitch: g.getPitch(), padding: g.getPadding() });
      if (cam.zoom < g.getZoom() - 0.05) g.easeTo({ ...cam, duration: 500 });
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
    g.setTerrain({ source: "dem", exaggeration: +this._settings.terrainEx || 1.5 });
    const want = this._settings.b3d !== false;
    if (want && !g.getLayer("bld")) {
      if (!g.getSource("ofm")) g.addSource("ofm", { type: "vector", url: OFM_URL, attribution: OFM_ATTR });
      g.addLayer({ id: "bld", type: "fill-extrusion", source: "ofm", "source-layer": "building", minzoom: 14,
        paint: { "fill-extrusion-color": "#d9d4cb", "fill-extrusion-opacity": 0.85,
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], 8],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0] } }, "lines");
    } else if (!want && g.getLayer("bld")) {
      g.removeLayer("bld");
    }
  }

  _set3dBase() {
    const g = this._g3;
    if (!g || !this._g3ok) return;
    g.removeLayer("base");
    g.removeSource("base");
    g.addSource("base", this._baseSource());
    g.addLayer({ id: "base", type: "raster", source: "base" }, "hs");
  }

  // percorso e segnaposto ricopiati da Leaflet (una volta per fotogramma, anche se cambiano più cose insieme)
  _schedule3d() {
    if (!this._3d || this._g3pending) return;
    this._g3pending = true;
    requestAnimationFrame(() => { this._g3pending = false; this._update3d(); });
  }

  _update3d() {
    const g = this._g3;
    if (!this._3d || !g || !this._g3ok) return;
    const feats = [];
    let i = 0;
    this._routeLayer.eachLayer((l) => {
      if (!(l instanceof L.Polyline)) return;
      const o = l.options;
      feats.push({ type: "Feature", properties: { c: o.color, w: o.weight, o: o.opacity ?? 1, i: i++ },
        geometry: { type: "LineString", coordinates: l.getLatLngs().map((p) => [p.lng, p.lat]) } });
    });
    g.getSource("lines").setData({ type: "FeatureCollection", features: feats });
    for (const m of this._g3markers) m.remove();
    this._g3markers = [];
    for (const grp of [this._markerLayer, this._poiLayer]) {
      grp.eachLayer((l) => {
        const ic = l.options?.icon?.options;
        if (!(l instanceof L.Marker) || !ic?.html) return;
        const el = document.createElement("div");
        el.innerHTML = ic.html;
        const a = ic.iconAnchor || [0, 0];
        const ll = l.getLatLng();
        this._g3markers.push(new window.maplibregl.Marker({ element: el, anchor: "top-left", offset: [-a[0], -a[1]] })
          .setLngLat([ll.lng, ll.lat]).addTo(g));
      });
    }
    this._drawMe3d();
  }

  // il veicolo: disegnato sul piano della mappa, così si inclina con la vista e gira con la direzione di marcia
  _drawMe3d() {
    const g = this._g3;
    const f = this._nav?.fix;
    if (!this._3d || !g || !f) return;
    if (!this._me3d) {
      const el = document.createElement("div");
      el.innerHTML = `<div class="nav-car">${VEHICLE_SVG[this._mode] || CAR_SVG}</div>`;
      this._me3d = new window.maplibregl.Marker({ element: el, rotationAlignment: "map", pitchAlignment: "map" })
        .setLngLat([f.lon, f.lat]).addTo(g);
    }
    this._me3d.setLngLat([f.lon, f.lat]).setRotation(this._nav.dir ?? 0);
    this._sync3d();
  }

  // la telecamera non deve finire sotto il terreno: inclinata sta dietro e più in basso del punto guardato, e le colline
  // vicine (accentuate dal rilievo) la coprono, con la mappa "stirata" e il nero sotto. Si prova la posizione e, se serve,
  // ci si allontana (zoom indietro a piccoli passi) finché la telecamera resta almeno 15 m sopra il terreno che ha davanti.
  // Margine piccolo apposta: con uno più largo la vista restava troppo alta e lo zoom con le dita veniva annullato.
  _clearCamera(opts, min = 15) {
    const g = this._g3;
    const tr = g?.transform;
    if (!g || !g.getTerrain() || typeof tr?.getCameraAltitude !== "function") return opts;
    const save = { center: g.getCenter(), zoom: g.getZoom(), bearing: g.getBearing(), pitch: g.getPitch(), padding: g.getPadding() };
    let z = opts.zoom;
    try {
      for (let k = 0; k < 20; k++) {
        g.jumpTo({ ...opts, zoom: z });
        const cl = this._camClearance();
        if (cl == null || cl >= min) break;
        z -= 0.25;
      }
    } finally {
      g.jumpTo(save);
    }
    return { ...opts, zoom: z };
  }

  // metri fra la telecamera e il punto più alto del terreno che ha davanti, fino al centro della vista (null senza rilievo).
  // Il terreno subito sotto e dietro la telecamera non si vede e non crea problemi: si parte da un quarto della distanza.
  _camClearance() {
    const g = this._g3;
    const tr = g?.transform;
    if (!g || !g.getTerrain() || typeof tr?.getCameraAltitude !== "function") return null;
    const cam = tr.getCameraLngLat();
    const c = g.getCenter();
    let ground = null;
    for (let t = 0.25; t <= 1.001; t += 0.075) {
      const e = g.queryTerrainElevation([cam.lng + (c.lng - cam.lng) * t, cam.lat + (c.lat - cam.lat) * t]);
      if (e != null && (ground == null || e > ground)) ground = e;
    }
    return ground == null ? null : tr.getCameraAltitude() - ground;
  }

  // telecamera 3D: in guida segue la posizione (nel terzo basso, girata nella direzione di marcia), altrimenti ricopia Leaflet
  _sync3d() {
    const g = this._g3;
    if (!this._3d || !g || this._from3d) return;
    const nav = this._nav;
    const z = this._map.getZoom() - 1; // MapLibre misura lo zoom con riquadri da 512 pixel, Leaflet da 256
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
    if (this._isGuida()) {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      const d = Math.ceil(Math.hypot(w, h));
      Object.assign(el.style, { width: `${d}px`, height: `${d}px`, left: `${(w - d) / 2}px`, top: `${(h - d) / 2}px`, right: "auto", bottom: "auto" });
      el.classList.add("rot");
      el.style.transform = `rotate(${-(this._rot || 0)}deg)`;
    } else {
      for (const k of ["width", "height", "left", "top", "right", "bottom", "transform"]) el.style[k] = "";
      el.classList.remove("rot");
      this._rot = 0;
    }
  }

  _applyRotation() {
    if (!this._isGuida() || this._nav.dir == null) return;
    const cur = this._rot || 0;
    const delta = ((((this._nav.dir - cur) % 360) + 540) % 360) - 180; // giro più corto
    this._rot = cur + delta;
    this.$("map").style.transform = `rotate(${-this._rot}deg)`;
  }

  // centra la mappa sulla posizione; in guida la posizione sta nel terzo basso dello schermo, con la strada davanti
  _followView(animate = true) {
    const nav = this._nav;
    const f = nav.fix;
    // al primo aggancio almeno zoom 16, poi resta quello scelto con + e −
    let z = nav.zoomed ? this._map.getZoom() : Math.max(this._map.getZoom(), 16);
    // zoom secondo la velocità, salvo per 20 secondi dopo uno zoom fatto a mano
    if (this._settings.autoZoom && this._isGuida() && nav.speed != null && Date.now() > (nav.manualZoomUntil || 0)) {
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
    nav.follow = true;
    nav.manualZoomUntil = 0;
    const z = this._settings.autoZoom && nav.speed != null ? zoomForSpeed(nav.speed * 3.6) : 17;
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

  // trascinamento (mouse o un dito) e zoom con due dita sulla mappa ruotata della guida
  _bindGuidaGestures() {
    const el = this.$("map");
    const pts = new Map();
    let prev = null;
    let moved = false;
    let pinch0 = null; // distanza e zoom all'inizio del pinch: lo zoom si calcola da lì, non a piccoli passi
    const state = () => {
      const a = [...pts.values()];
      const c = a.length >= 2 ? { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 } : { x: a[0].x, y: a[0].y };
      const d = a.length >= 2 ? Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) : 0;
      return { c, d, n: a.length, zoom: this._map.getZoom() };
    };
    el.addEventListener("pointerdown", (e) => {
      if (!this._isGuida() || e.button > 0) return;
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* puntatore simulato */ }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      prev = state();
      if (pts.size === 1) moved = false;
      pinch0 = pts.size >= 2 ? { d: prev.d, zoom: prev.zoom } : null;
    });
    el.addEventListener("pointermove", (e) => {
      if (!this._isGuida() || !pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const now = state();
      if (now.n !== prev.n) { prev = now; pinch0 = now.n >= 2 ? { d: now.d, zoom: now.zoom } : null; return; }
      const dx = now.c.x - prev.c.x;
      const dy = now.c.y - prev.c.y;
      const pinch = now.n >= 2 && pinch0 && pinch0.d > 0;
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
      if (pts.size) { prev = state(); pinch0 = pts.size >= 2 ? { d: prev.d, zoom: prev.zoom } : null; }
      else { el.classList.remove("moving"); pinch0 = null; }
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
        <label class="line"><span>Riproduci su</span><select data-s="out">${outs}</select></label>
        ${outNote ? `<div class="note">${outNote}</div>` : ""}
        <div class="row" style="margin-top:6px"><button data-s="testvoice">▶ Prova la voce</button></div>
      </div>
      <div class="grp"><h3>Mappa</h3>
        ${sw("autoZoom", "Zoom automatico in base alla velocità", "In guida: più vicino in città, più largo in autostrada. Dopo + o − resta il tuo zoom per 20 secondi")}
      </div>
      <div class="grp"><h3>Vista 3D</h3>
        <div class="note">Tasto <b>3D</b> sulla mappa e nella barra della guida: mappa inclinata con il rilievo del terreno. Usa la grafica del
          telefono e scarica anche le quote del terreno: consuma più batteria e dati della mappa piatta.</div>
        <label class="line"><span>Rilievo</span><select data-s="terrainEx">${TERRAIN_EX.map(([v, n]) => `<option value="${v}" ${String(s.terrainEx) === v ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        ${sw("b3d", "Edifici in 3D", "Da vicino, con l'altezza degli edifici dove è nota (OpenFreeMap, dati OpenStreetMap)")}
      </div>
      <div class="grp"><h3>Velocità</h3>
        ${sw("camAlert", "Avviso autovelox fissi", "Cartello nella barra della guida e, con le indicazioni vocali o il beep attivi, avviso a 600 metri (da 1 km in autostrada)")}
        ${sw("beep", "Beep quando superi il limite", "Limiti da OpenStreetMap, per auto e moto; tolleranza di 3 km/h (5% sopra i 60)")}
        <div class="row" style="margin-top:6px"><button data-s="testbeep">▶ Prova il beep</button></div>
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
      if (el.dataset.s === "b3d") this._apply3dSettings();
      if (el.dataset.s === "voice" && el.checked) this._unlockAudio();
    }));
    wrap.querySelectorAll("select[data-s]").forEach((el) => el.addEventListener("change", () => {
      const k = el.dataset.s;
      s[k] = el.value;
      if (k === "lang") s.voiceSel = s.voiceSel === "m" ? "m" : "f"; // le voci cambiano con la lingua
      this._saveSettings();
      if (k === "terrainEx") this._apply3dSettings();
      if (k === "lang" && this._result && !this._nav) this._compute(false); // indicazioni nella nuova lingua
      this._openSettings();
    }));
    wrap.querySelector('[data-s="testvoice"]').addEventListener("click", () => {
      this._unlockAudio();
      if (this._voiceOut().kind === "none") { this._msg("Nessuna voce disponibile su questo dispositivo"); return; }
      this._speak(PHRASES[s.lang].test, true, true);
    });
    wrap.querySelector('[data-s="testbeep"]').addEventListener("click", () => this._beep());
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
      top.innerHTML = `<span class="ic">${maneuverIcon(next)}</span><div><div class="d">${toNext < 15 ? "Ora" : fmtDist(toNext)}</div><div class="t">${esc(next.text)}</div></div>`;
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
    const kmh = nav.speed != null && nav.fix ? Math.round(nav.speed * 3.6) : null;
    bot.querySelector(".info").innerHTML = `<span class="rem">${fmtTime(remTime)}</span><span>${fmtKm(remM / 1000)} · arrivo ${arrival(remTime)}</span>
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
    bot.innerHTML = `<div class="info"></div>
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
    bot.querySelector('[data-n="out"]').addEventListener("click", () => { this._map.zoomOut(); this._afterZoom(); });
    bot.querySelector('[data-n="in"]').addEventListener("click", () => { this._map.zoomIn(); this._afterZoom(); });
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
    const r = this._result;
    if (!r) return;
    // alternative (sotto, grigie e cliccabili), poi il percorso scelto
    r.routes.forEach((rt, i) => {
      if (i === this._sel || this._nav) return;
      const line = L.polyline(rt.shape, { color: "#78909c", weight: 6, opacity: 0.7 }).addTo(this._routeLayer);
      line.bindTooltip(`${fmtTime(rt.summary.time)} · ${fmtKm(rt.summary.length_km)}`, { sticky: true });
      line.on("click", (ev) => { L.DomEvent.stopPropagation(ev); this._select(i); });
    });
    const rt = r.routes[this._sel];
    const color = ROUTE_COLORS[this._sel % ROUTE_COLORS.length];
    L.polyline(rt.shape, { color: "#fff", weight: 10, opacity: 0.9, interactive: false }).addTo(this._routeLayer);
    L.polyline(rt.shape, { color, weight: 6, opacity: 1, interactive: false }).addTo(this._routeLayer);
    for (const seg of rt.toll_segments) {
      L.polyline(rt.shape.slice(seg.begin, seg.end + 1), { color: "#f57c00", weight: 6, opacity: 1 })
        .bindTooltip(`💶 ${seg.name} · ${fmtKm(seg.length_km)} a pagamento`, { sticky: true })
        .addTo(this._routeLayer);
    }
    for (const m of rt.maneuvers) {
      if (m.ferry) {
        L.polyline(rt.shape.slice(m.begin, m.end + 1), { color: "#0288d1", weight: 5, dashArray: "8 8" }).addTo(this._routeLayer);
      }
    }
  }

  _select(i) {
    this._sel = i;
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
      html += `<div class="sec"><h3>Percorsi <span class="muted" style="text-transform:none">${r.engine === "osrm" ? "OSRM" : "Valhalla"}</span></h3><div class="alts">`;
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
        this._startNav(box.querySelector("#navsrc")?.value || "gps");
      } else if (a.startsWith("near-")) {
        this._openNearby(a.slice(5));
      } else if (a === "gpshelp") {
        this._gpsHelp(true);
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
