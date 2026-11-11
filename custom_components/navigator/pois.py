"""Luoghi nelle vicinanze: distributori, autovelox fissi e parcheggi.

- Distributori in Italia: anagrafica ufficiale degli impianti attivi del MIMIT (dati aperti Osservaprezzi), con la marca;
  scaricata una volta al giorno e cercata in locale. Carburanti venduti e prezzi dal file "prezzo alle 8" del MIMIT,
  scaricato due volte al giorno. Fuori dall'Italia: OpenStreetMap tramite Overpass (carburanti dai tag fuel:*, senza prezzi).
- Autovelox fissi: OpenStreetMap (highway=speed_camera) dell'intero paese, scaricati una volta alla settimana.
- Parcheggi: OpenStreetMap tramite Overpass, su richiesta, con una cache di mezz'ora.

I server pubblici di Overpass sono spesso carichi: si provano in sequenza e i dati scaricati restano in cache.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import aiohttp

from .const import USER_AGENT

_LOGGER = logging.getLogger(__name__)

MIMIT_URL = "https://www.mimit.gov.it/images/exportCSV/anagrafica_impianti_attivi.csv"
PRICES_URL = "https://www.mimit.gov.it/images/exportCSV/prezzo_alle_8.csv"
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
FUEL_MAX_AGE = 24 * 3600
PRICES_MAX_AGE = 12 * 3600
CAMERAS_MAX_AGE = 7 * 24 * 3600
RETRY_AFTER = 900  # dopo un errore si riprova fra 15 minuti


class PoiError(Exception):
    """Errore comprensibile da mostrare all'utente."""


def _dist_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    kx = 111320 * math.cos(math.radians(lat1))
    return math.hypot((lon2 - lon1) * kx, (lat2 - lat1) * 110540)


def _seg_dist_m(lat: float, lon: float, a: list[float], b: list[float]) -> float:
    kx = 111320 * math.cos(math.radians(lat))
    ax, ay = (a[1] - lon) * kx, (a[0] - lat) * 110540
    bx, by = (b[1] - lon) * kx, (b[0] - lat) * 110540
    vx, vy = bx - ax, by - ay
    l2 = vx * vx + vy * vy
    t = max(0.0, min(1.0, -(ax * vx + ay * vy) / l2)) if l2 > 0 else 0.0
    return math.hypot(ax + t * vx, ay + t * vy)


def _near_line(items: list[dict], line: list[list[float]], radius: float) -> list[dict]:
    """Elementi entro radius metri dalla linea: prima un riquadro per tratto, poi la distanza vera."""
    if not line:
        return []
    if len(line) == 1:
        line = [line[0], line[0]]
    pad_lat = radius / 110540
    out = []
    # tratti di linea raggruppati a blocchi per un primo filtro veloce
    block = 20
    boxes = []
    for i in range(0, len(line) - 1, block):
        chunk = line[i:i + block + 1]
        lat0 = sum(p[0] for p in chunk) / len(chunk)
        pad_lon = radius / (111320 * max(0.2, math.cos(math.radians(lat0))))
        boxes.append((min(p[0] for p in chunk) - pad_lat, max(p[0] for p in chunk) + pad_lat,
                      min(p[1] for p in chunk) - pad_lon, max(p[1] for p in chunk) + pad_lon, i, chunk))
    for it in items:
        lat, lon = it["lat"], it["lon"]
        best = None
        for la0, la1, lo0, lo1, _, chunk in boxes:
            if la0 <= lat <= la1 and lo0 <= lon <= lo1:
                for a, b in zip(chunk, chunk[1:]):
                    d = _seg_dist_m(lat, lon, a, b)
                    if best is None or d < best:
                        best = d
        if best is not None and best <= radius:
            out.append({**it, "off": round(best)})
    return out


def _bbox_chunks(line: list[list[float]], radius: float, step_km: float = 4) -> list[tuple]:
    """Riquadri (sud, ovest, nord, est) lungo la linea, per le richieste a Overpass."""
    out, cur, acc = [], [line[0]], 0.0
    for a, b in zip(line, line[1:]):
        acc += _dist_m(a[0], a[1], b[0], b[1]) / 1000
        cur.append(b)
        if acc >= step_km:
            out.append(cur)
            cur, acc = [b], 0.0
    if len(cur) > 1 or not out:
        out.append(cur)
    res = []
    for c in out:
        lat0 = sum(p[0] for p in c) / len(c)
        pl, po = radius / 110540, radius / (111320 * max(0.2, math.cos(math.radians(lat0))))
        res.append((min(p[0] for p in c) - pl, min(p[1] for p in c) - po, max(p[0] for p in c) + pl, max(p[1] for p in c) + po))
    return res


class Pois:
    def __init__(self, session: aiohttp.ClientSession, cache_dir: Path, country: str | None, executor,
                 photon_url: str = "https://photon.komoot.io") -> None:
        self._session = session
        self._photon = photon_url.rstrip("/")
        self._dir = cache_dir
        self.country = (country or "IT").upper()
        self._exec = executor  # hass.async_add_executor_job
        self._fuel: list[dict] | None = None
        self._fuel_time = 0.0
        self._cams: list[dict] | None = None
        self._cams_time = 0.0
        self._fail: dict[str, float] = {}
        self._prices: dict[str, list] | None = None
        self._prices_time = 0.0
        self._locks = {k: asyncio.Lock() for k in ("fuel", "prices", "cams", "overpass")}
        self._cache: dict[str, tuple[float, list]] = {}

    # ------------------------------------------------------------------ file di cache

    def _read(self, name: str) -> dict | None:
        try:
            return json.loads((self._dir / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _write(self, name: str, data: dict) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        tmp = self._dir / f"{name}.tmp"
        tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        tmp.replace(self._dir / name)

    # ------------------------------------------------------------------ Overpass

    async def _overpass(self, query: str, timeout: int = 60) -> list[dict]:
        last = None
        async with self._locks["overpass"]:  # una richiesta alla volta (regole d'uso dei server pubblici)
            for url in OVERPASS_URLS:
                try:
                    async with self._session.post(url, data={"data": query}, headers={"User-Agent": USER_AGENT},
                                                  timeout=aiohttp.ClientTimeout(total=timeout)) as resp:
                        if resp.status != 200:
                            last = f"{url.split('/')[2]}: errore {resp.status}"
                            continue
                        data = await resp.json(content_type=None)
                        return data.get("elements", [])
                except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as err:
                    last = f"{url.split('/')[2]}: {err.__class__.__name__}"
        raise PoiError(f"I server di OpenStreetMap (Overpass) non rispondono, riprova fra poco ({last})")

    async def _overpass_race(self, query: str, timeout: float) -> list[dict]:
        """Richiesta interattiva: tutti i server insieme, vince la prima risposta valida (entro timeout secondi)."""
        async def one(url: str) -> list[dict]:
            async with self._session.post(url, data={"data": query}, headers={"User-Agent": USER_AGENT},
                                          timeout=aiohttp.ClientTimeout(total=timeout)) as resp:
                if resp.status != 200:
                    raise PoiError(f"{url.split('/')[2]}: errore {resp.status}")
                data = await resp.json(content_type=None)
                if data.get("remark") and not data.get("elements"):
                    raise PoiError(data["remark"][:80])
                return data.get("elements", [])

        tasks = [asyncio.ensure_future(one(u)) for u in OVERPASS_URLS]
        try:
            for fut in asyncio.as_completed(tasks):
                try:
                    return await fut
                except (PoiError, aiohttp.ClientError, asyncio.TimeoutError, ValueError):
                    continue
        finally:
            for t in tasks:
                t.cancel()
        raise PoiError("I server di OpenStreetMap (Overpass) non rispondono")

    @staticmethod
    def _osm_item(e: dict) -> dict | None:
        lat = e.get("lat", (e.get("center") or {}).get("lat"))
        lon = e.get("lon", (e.get("center") or {}).get("lon"))
        if lat is None or lon is None:
            return None
        return {"lat": lat, "lon": lon, "tags": e.get("tags", {}), "id": f"{e.get('type', 'n')[0]}{e.get('id')}"}

    # ------------------------------------------------------------------ distributori

    async def _load_fuel(self) -> list[dict]:
        async with self._locks["fuel"]:
            now = time.time()
            if self._fuel is not None and now - self._fuel_time < FUEL_MAX_AGE:
                return self._fuel
            if self._fuel is None:
                saved = await self._exec(self._read, "impianti.json")
                if saved and saved.get("items"):
                    self._fuel, self._fuel_time = saved["items"], saved.get("time", 0)
                    if now - self._fuel_time < FUEL_MAX_AGE:
                        return self._fuel
            if now - self._fail.get("fuel", 0) < RETRY_AFTER and self._fuel is not None:
                return self._fuel
            try:
                async with self._session.get(MIMIT_URL, headers={"User-Agent": USER_AGENT},
                                             timeout=aiohttp.ClientTimeout(total=120)) as resp:
                    resp.raise_for_status()
                    raw = await resp.read()
                items = await self._exec(_parse_mimit, raw)
                if len(items) < 1000:
                    raise ValueError("anagrafica incompleta")
                self._fuel, self._fuel_time = items, now
                await self._exec(self._write, "impianti.json", {"time": now, "items": items})
            except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as err:
                self._fail["fuel"] = now
                _LOGGER.warning("Anagrafica distributori MIMIT non scaricata: %s", err)
                if self._fuel is None:
                    raise PoiError("Elenco dei distributori non disponibile ora (sito del MIMIT non raggiungibile)") from err
            return self._fuel

    async def _load_prices(self) -> dict[str, list]:
        """Carburanti e prezzi per impianto; se il file non arriva si tengono gli ultimi scaricati (o nessuno)."""
        async with self._locks["prices"]:
            now = time.time()
            if self._prices is not None and now - self._prices_time < PRICES_MAX_AGE:
                return self._prices
            if self._prices is None:
                saved = await self._exec(self._read, "prezzi.json")
                if saved and saved.get("items"):
                    self._prices, self._prices_time = saved["items"], saved.get("time", 0)
                    if now - self._prices_time < PRICES_MAX_AGE:
                        return self._prices
            if now - self._fail.get("prices", 0) < RETRY_AFTER:
                return self._prices or {}
            try:
                async with self._session.get(PRICES_URL, headers={"User-Agent": USER_AGENT},
                                             timeout=aiohttp.ClientTimeout(total=120)) as resp:
                    resp.raise_for_status()
                    raw = await resp.read()
                items = await self._exec(_parse_prices, raw)
                if len(items) < 1000:
                    raise ValueError("file dei prezzi incompleto")
                self._prices, self._prices_time = items, now
                await self._exec(self._write, "prezzi.json", {"time": now, "items": items})
            except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as err:
                self._fail["prices"] = now
                _LOGGER.warning("Prezzi dei carburanti MIMIT non scaricati: %s", err)
            return self._prices or {}

    async def fuel(self, line: list[list[float]], radius: float) -> dict:
        if self.country == "IT":
            items = await self._load_fuel()
            near = await self._exec(_near_line, items, line, radius)
            prices = await self._load_prices()
            for it in near:
                it["fuels"] = prices.get(it["id"], [])
            src = "MIMIT (anagrafica impianti attivi" + (", carburanti e prezzi comunicati dai gestori)" if prices else ")")
            return {"items": near, "source": src, "updated": int(self._fuel_time),
                    "prices": int(self._prices_time) if prices else None}
        # fuori dall'Italia: OpenStreetMap
        boxes = _bbox_chunks(line, radius)
        q = "[out:json][timeout:40];(" + "".join(
            f'nwr["amenity"="fuel"]({s:.4f},{w:.4f},{n:.4f},{e:.4f});' for s, w, n, e in boxes) + ");out center tags;"
        els = await self._overpass(q)
        items = []
        for e in els:
            it = self._osm_item(e)
            if not it:
                continue
            t = it.pop("tags")
            items.append({**it, "brand": t.get("brand") or t.get("operator") or "", "name": t.get("name") or "",
                          "addr": " ".join(x for x in (t.get("addr:street"), t.get("addr:housenumber")) if x),
                          "town": t.get("addr:city") or "", "motorway": False, "fuels": _osm_fuels(t)})
        return {"items": await self._exec(_near_line, items, line, radius), "source": "OpenStreetMap", "updated": int(time.time())}

    # ------------------------------------------------------------------ autovelox fissi

    async def _load_cameras(self) -> list[dict]:
        async with self._locks["cams"]:
            now = time.time()
            if self._cams is not None and now - self._cams_time < CAMERAS_MAX_AGE:
                return self._cams
            name = f"autovelox_{self.country}.json"
            if self._cams is None:
                saved = await self._exec(self._read, name)
                if saved and "items" in saved:
                    self._cams, self._cams_time = saved["items"], saved.get("time", 0)
                    if now - self._cams_time < CAMERAS_MAX_AGE:
                        return self._cams
            if now - self._fail.get("cams", 0) < RETRY_AFTER:
                if self._cams is not None:
                    return self._cams
                raise PoiError("Autovelox non disponibili ora: i server di OpenStreetMap non rispondono, riprovo fra qualche minuto")
            q = (f'[out:json][timeout:120];area["ISO3166-1"="{self.country}"][admin_level=2]->.a;'
                 'node["highway"="speed_camera"](area.a);out body;')
            try:
                els = await self._overpass(q, timeout=150)
            except PoiError:
                self._fail["cams"] = now
                if self._cams is not None:
                    return self._cams
                raise
            items = []
            for e in els:
                if "lat" not in e or "lon" not in e:
                    continue
                t = e.get("tags", {})
                ms = t.get("maxspeed", "")
                items.append({"lat": e["lat"], "lon": e["lon"], "id": f"n{e['id']}",
                              "maxspeed": int(ms) if str(ms).isdigit() else None,
                              "direction": t.get("direction", ""), "name": t.get("name") or t.get("description") or ""})
            self._cams, self._cams_time = items, now
            await self._exec(self._write, name, {"time": now, "items": items})
            return items

    async def cameras(self, line: list[list[float]], radius: float) -> dict:
        items = await self._load_cameras()
        return {"items": await self._exec(_near_line, items, line, radius), "source": "OpenStreetMap", "updated": int(self._cams_time)}

    # ------------------------------------------------------------------ parcheggi

    async def parking(self, lat: float, lon: float, radius: float) -> dict:
        key = f"p|{lat:.3f}|{lon:.3f}|{int(radius)}"
        hit = self._cache.get(key)
        if hit and time.time() - hit[0] < 1800:
            return {"items": hit[1], "source": "OpenStreetMap", "updated": int(hit[0])}
        q = (f'[out:json][timeout:15];nwr["amenity"="parking"]["access"!~"^(private|no|customers|permit)$"]'
             f"(around:{int(radius)},{lat:.5f},{lon:.5f});out center tags;")
        try:
            els = await self._overpass_race(q, 15)
        except PoiError:
            return await self._parking_photon(lat, lon, radius)
        items = []
        for e in els:
            it = self._osm_item(e)
            if not it:
                continue
            t = it.pop("tags")
            cap = t.get("capacity", "")
            items.append({**it, "name": t.get("name") or "", "kind": t.get("parking") or "",
                          "fee": t.get("fee") or "", "capacity": int(cap) if str(cap).isdigit() else None,
                          "covered": t.get("covered") == "yes" or t.get("parking") in ("underground", "multi-storey"),
                          "hours": t.get("opening_hours") or "",
                          "off": round(_dist_m(lat, lon, it["lat"], it["lon"]))})
        items.sort(key=lambda x: x["off"])
        self._cache[key] = (time.time(), items)
        return {"items": items, "source": "OpenStreetMap", "updated": int(time.time())}


    async def _parking_photon(self, lat: float, lon: float, radius: float) -> dict:
        """Riserva quando Overpass non risponde: i parcheggi con un nome, cercati con Photon."""
        r = max(radius, 1500)
        dl, do = r / 110540, r / (111320 * max(0.2, math.cos(math.radians(lat))))
        params = {"q": "parcheggio", "osm_tag": "amenity:parking", "limit": 30,
                  "bbox": f"{lon - do:.5f},{lat - dl:.5f},{lon + do:.5f},{lat + dl:.5f}"}
        try:
            async with self._session.get(f"{self._photon}/api", params=params, headers={"User-Agent": USER_AGENT},
                                         timeout=aiohttp.ClientTimeout(total=15)) as resp:
                resp.raise_for_status()
                data = await resp.json(content_type=None)
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as err:
            raise PoiError("Parcheggi non disponibili ora: i server di OpenStreetMap non rispondono, riprova fra poco") from err
        items = []
        for f in data.get("features", []):
            c = (f.get("geometry") or {}).get("coordinates") or [0, 0]
            pr = f.get("properties", {})
            items.append({"lat": c[1], "lon": c[0], "id": f"{pr.get('osm_type', 'N')}{pr.get('osm_id', '')}",
                          "name": pr.get("name") or "", "kind": "", "fee": "", "capacity": None, "covered": False,
                          "hours": "", "off": round(_dist_m(lat, lon, c[1], c[0]))})
        items.sort(key=lambda x: x["off"])
        return {"items": items, "source": "Photon (Overpass non risponde: solo i parcheggi con un nome)", "updated": int(time.time())}


def _parse_mimit(raw: bytes) -> list[dict]:
    """Anagrafica MIMIT: idImpianto|Gestore|Bandiera|Tipo Impianto|Nome Impianto|Indirizzo|Comune|Provincia|Lat|Lon."""
    text = raw.decode("utf-8", errors="replace")
    items = []
    for line in text.splitlines()[2:]:
        f = line.split("|")
        if len(f) < 10:
            continue
        try:
            lat, lon = float(f[8]), float(f[9])
        except ValueError:
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180) or (lat == 0 and lon == 0):
            continue
        brand = f[2].strip()
        items.append({
            "id": f[0].strip(), "lat": round(lat, 6), "lon": round(lon, 6),
            "brand": "Pompe bianche" if brand.lower() == "pompe bianche" else brand,
            "name": " ".join(f[4].split()), "addr": " ".join(f[5].split()).title(),
            "town": f[6].strip().title(), "motorway": f[3].strip().lower() == "autostradale",
        })
    # alcune righe hanno coordinate segnaposto (es. il centro di Milano per un impianto di Brescia):
    # lo stesso punto usato da impianti di comuni diversi non è affidabile
    groups: dict[tuple, set] = {}
    for it in items:
        groups.setdefault((round(it["lat"], 4), round(it["lon"], 4)), set()).add(it["town"])
    return [it for it in items if len(groups[(round(it["lat"], 4), round(it["lon"], 4))]) == 1]


# ---------------------------------------------------------------------- carburanti

# tipi di carburante (per il filtro): i nomi nel file del MIMIT sono quelli commerciali scelti dai gestori
_OCT100 = re.compile(r"(?<!\d)100(?!\d)")


def fuel_kind(name: str) -> str:
    """benzina, benzina_plus, benzina100, gasolio, gasolio_plus, gpl, metano, gnl o altro."""
    n = " ".join(name.lower().split())
    if "gpl" in n or "lpg" in n:
        return "gpl"
    if "gnl" in n or "lng" in n:
        return "gnl"
    if "metano" in n or "gnc" in n or "cng" in n:
        return "metano"
    if "adblue" in n or "ad blue" in n:
        return "altro"
    if "gasolio" in n or "diesel" in n or "hvo" in n:
        return "gasolio" if n == "gasolio" else "gasolio_plus"
    if _OCT100.search(n):
        return "benzina100"
    if n in ("benzina", "super", "verde"):
        return "benzina"
    if any(k in n for k in ("benzina", "super", "perform", "power", "ottan", "plus", "premium", "speciale", "racing")):
        return "benzina_plus"
    return "altro"


def _parse_prices(raw: bytes) -> dict[str, list]:
    """Prezzi alle 8: idImpianto|descCarburante|prezzo|isSelf|dtComu (prima riga: data dell'estrazione).

    Per impianto: [{"n": nome, "k": tipo, "s": prezzo self, "v": prezzo servito, "t": data della comunicazione}].
    """
    text = raw.decode("utf-8", errors="replace")
    tz = ZoneInfo("Europe/Rome")
    out: dict[str, dict[str, dict]] = {}
    for line in text.splitlines():
        sep = "|" if "|" in line else ";"
        f = [x.strip() for x in line.split(sep)]
        if len(f) < 4 or not f[0].isdigit():
            continue  # intestazioni e righe rovinate
        try:
            price = float(f[2].replace(",", "."))
        except ValueError:
            continue
        if not 0.2 < price < 5:
            continue  # prezzi sbagliati (es. 0,001 o 1789 al posto di 1,789)
        name = " ".join(f[1].split())
        if not name:
            continue
        ts = 0
        if len(f) > 4 and f[4]:
            for fmt in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%Y-%m-%d %H:%M:%S"):
                try:
                    ts = int(datetime.strptime(f[4], fmt).replace(tzinfo=tz).timestamp())
                    break
                except ValueError:
                    continue
        fuel = out.setdefault(f[0], {}).setdefault(name.lower(), {"n": name, "k": fuel_kind(name), "s": None, "v": None, "t": 0})
        fuel["s" if f[3] in ("1", "true", "True") else "v"] = round(price, 3)
        fuel["t"] = max(fuel["t"], ts)
    order = ["benzina", "gasolio", "benzina_plus", "benzina100", "gasolio_plus", "gpl", "metano", "gnl", "altro"]
    return {k: sorted(v.values(), key=lambda x: (order.index(x["k"]), x["n"])) for k, v in out.items()}


_OSM_FUELS = [("fuel:octane_95", "Benzina 95", "benzina"), ("fuel:e10", "Benzina E10", "benzina"),
              ("fuel:octane_98", "Benzina 98", "benzina_plus"), ("fuel:octane_100", "Benzina 100 ottani", "benzina100"),
              ("fuel:diesel", "Gasolio", "gasolio"), ("fuel:GTL_diesel", "Gasolio GTL", "gasolio_plus"),
              ("fuel:HVO100", "Gasolio HVO", "gasolio_plus"), ("fuel:lpg", "GPL", "gpl"), ("fuel:cng", "Metano", "metano"),
              ("fuel:lng", "GNL", "gnl")]


def _osm_fuels(tags: dict) -> list[dict]:
    return [{"n": n, "k": k, "s": None, "v": None, "t": 0} for tag, n, k in _OSM_FUELS if tags.get(tag) == "yes"]
