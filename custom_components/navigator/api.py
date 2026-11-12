"""Client dei servizi gratuiti di mappe: ricerca (Photon / Nominatim) e percorsi (Valhalla / OSRM).

Non dipende da Home Assistant: riceve una sessione aiohttp e gli indirizzi dei server.
"""

from __future__ import annotations

import asyncio
import math
import re
import time
from collections import OrderedDict
from typing import Any

import aiohttp

from .const import LANGUAGES, MAX_EXCLUDE, MODES, USER_AGENT

TIMEOUT = aiohttp.ClientTimeout(total=30)


class NavigatorError(Exception):
    """Errore comprensibile da mostrare all'utente."""


def decode_polyline(encoded: str, precision: int = 6) -> list[list[float]]:
    """Decodifica una polyline codificata (Valhalla usa 6 decimali, OSRM 5 o 6)."""
    factor = 10**precision
    points: list[list[float]] = []
    index = lat = lon = 0
    length = len(encoded)
    while index < length:
        for which in (0, 1):
            result = shift = 0
            while True:
                byte = ord(encoded[index]) - 63
                index += 1
                result |= (byte & 0x1F) << shift
                shift += 5
                if byte < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if which == 0:
                lat += delta
            else:
                lon += delta
        points.append([round(lat / factor, 6), round(lon / factor, 6)])
    return points


def haversine_km(a: list[float], b: list[float]) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(h))


def _photon_label(props: dict[str, Any]) -> tuple[str, str]:
    """Nome breve e indirizzo leggibile di un risultato Photon."""
    name = props.get("name") or ""
    street = props.get("street") or ""
    if street and props.get("housenumber"):
        street = f"{street} {props['housenumber']}"
    city = props.get("city") or props.get("town") or props.get("village") or props.get("locality") or ""
    parts = []
    if street and street != name:
        parts.append(street)
    place = " ".join(p for p in (props.get("postcode") or "", city) if p)
    if place and city != name:
        parts.append(place)
    for key in ("county", "state", "country"):
        val = props.get(key)
        if val and val not in parts and val != name and val != city:
            parts.append(val)
            break
    if props.get("country") and props["country"] not in parts and props["country"] != name:
        parts.append(props["country"])
    if not name:
        name = street or city or (parts[0] if parts else "Punto senza nome")
        parts = [p for p in parts if p != name]
    return name, ", ".join(parts)


class MapServices:
    """Ricerca di luoghi e calcolo dei percorsi sui server gratuiti."""

    def __init__(self, session: aiohttp.ClientSession, valhalla: str, osrm: str, photon: str, nominatim: str) -> None:
        self._session = session
        self.valhalla = valhalla.rstrip("/")
        self.osrm = osrm.rstrip("/")
        self.photon = photon.rstrip("/")
        self.nominatim = nominatim.rstrip("/")
        self._headers = {"User-Agent": USER_AGENT, "Accept-Language": "it"}
        self._cache: OrderedDict[str, Any] = OrderedDict()
        # Nominatim: al massimo una richiesta al secondo (regole d'uso del servizio)
        self._nominatim_lock = asyncio.Lock()
        self._nominatim_last = 0.0

    # ------------------------------------------------------------------ utilità HTTP

    def _cache_get(self, key: str) -> Any:
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key]
        return None

    def _cache_put(self, key: str, value: Any) -> None:
        self._cache[key] = value
        while len(self._cache) > 300:
            self._cache.popitem(last=False)

    async def _get_json(self, url: str, params: dict[str, Any]) -> Any:
        async with self._session.get(url, params=params, headers=self._headers, timeout=TIMEOUT) as resp:
            if resp.status >= 400:
                raise NavigatorError(f"Il server {url.split('/')[2]} ha risposto con errore {resp.status}")
            return await resp.json(content_type=None)

    async def _nominatim(self, path: str, params: dict[str, Any]) -> Any:
        async with self._nominatim_lock:
            wait = 1.05 - (time.monotonic() - self._nominatim_last)
            if wait > 0:
                await asyncio.sleep(wait)
            try:
                return await self._get_json(f"{self.nominatim}/{path}", {**params, "format": "jsonv2", "accept-language": "it"})
            finally:
                self._nominatim_last = time.monotonic()

    # ------------------------------------------------------------------ ricerca

    async def search(self, query: str, lat: float | None = None, lon: float | None = None, limit: int = 8) -> list[dict]:
        """Cerca luoghi e indirizzi. Photon (adatto alla ricerca mentre si scrive), poi Nominatim."""
        query = query.strip()
        if len(query) < 2:
            return []
        key = f"s|{query.lower()}|{round(lat or 0, 1)}|{round(lon or 0, 1)}|{limit}"
        if (cached := self._cache_get(key)) is not None:
            return cached
        results: list[dict] = []
        try:
            params: dict[str, Any] = {"q": query, "limit": limit}
            if lat is not None and lon is not None:
                params.update(lat=lat, lon=lon)
            data = await self._get_json(f"{self.photon}/api", params)
            for feat in data.get("features", []):
                props = feat.get("properties", {})
                coords = feat.get("geometry", {}).get("coordinates") or [0, 0]
                name, address = _photon_label(props)
                results.append({
                    "name": name,
                    "address": address,
                    "lat": coords[1],
                    "lon": coords[0],
                    "kind": props.get("osm_value") or props.get("type") or "",
                    "source": "photon",
                })
        except (aiohttp.ClientError, asyncio.TimeoutError, NavigatorError, ValueError):
            results = []
        if not results:
            try:
                data = await self._nominatim("search", {"q": query, "limit": limit, "addressdetails": 0})
            except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as err:
                raise NavigatorError("Ricerca non disponibile: i server Photon e Nominatim non rispondono") from err
            for item in data:
                display = item.get("display_name", "")
                name = item.get("name") or display.split(",")[0]
                address = ", ".join(p.strip() for p in display.split(",")[1:] if p.strip())
                results.append({
                    "name": name,
                    "address": address,
                    "lat": float(item["lat"]),
                    "lon": float(item["lon"]),
                    "kind": item.get("type", ""),
                    "source": "nominatim",
                })
        seen: set[tuple] = set()
        unique = []
        for r in results:
            sig = (r["name"], r["address"])
            if sig not in seen:
                seen.add(sig)
                unique.append(r)
        self._cache_put(key, unique)
        return unique

    async def reverse(self, lat: float, lon: float) -> dict:
        """Indirizzo del punto (lat, lon)."""
        key = f"r|{lat:.5f}|{lon:.5f}"
        if (cached := self._cache_get(key)) is not None:
            return cached
        result: dict | None = None
        try:
            data = await self._get_json(f"{self.photon}/reverse", {"lat": lat, "lon": lon, "limit": 1})
            feats = data.get("features") or []
            if feats:
                name, address = _photon_label(feats[0].get("properties", {}))
                result = {"name": name, "address": address, "lat": lat, "lon": lon}
        except (aiohttp.ClientError, asyncio.TimeoutError, NavigatorError, ValueError):
            result = None
        if result is None:
            try:
                item = await self._nominatim("reverse", {"lat": lat, "lon": lon, "zoom": 18})
                display = item.get("display_name") or ""
                result = {
                    "name": item.get("name") or display.split(",")[0] or f"{lat:.5f}, {lon:.5f}",
                    "address": ", ".join(p.strip() for p in display.split(",")[1:] if p.strip()),
                    "lat": lat,
                    "lon": lon,
                }
            except (aiohttp.ClientError, asyncio.TimeoutError, NavigatorError, ValueError):
                result = {"name": f"{lat:.5f}, {lon:.5f}", "address": "", "lat": lat, "lon": lon}
        self._cache_put(key, result)
        return result

    # ------------------------------------------------------------------ percorsi

    async def route(
        self,
        points: list[dict],
        mode: str = "auto",
        avoid_tolls: bool = False,
        avoid_highways: bool = False,
        avoid_ferries: bool = False,
        exclude: list[dict] | None = None,
        alternatives: bool = True,
        language: str = "it",
    ) -> dict:
        """Calcola il percorso fra i punti (partenza, tappe, arrivo).

        Con avoid_tolls il percorso viene ricalcolato escludendo una alla volta le tratte a pagamento
        che Valhalla usa ancora (la sola preferenza "use_tolls=0" a volte non basta).
        """
        if len(points) < 2:
            raise NavigatorError("Servono almeno partenza e arrivo")
        if mode not in MODES:
            raise NavigatorError(f"Mezzo sconosciuto: {mode}")
        exclude = list(exclude or [])[:MAX_EXCLUDE]
        warnings: list[str] = []
        try:
            auto_excluded: list[dict] = []
            lang = LANGUAGES.get(language, "it-IT")
            result = await self._valhalla(points, mode, avoid_tolls, avoid_highways, avoid_ferries, exclude, alternatives, lang)
            if avoid_tolls and MODES[mode][0] in ("auto", "motorcycle"):
                for _ in range(4):
                    main = result["routes"][0]
                    if not main["toll_segments"] or len(exclude) + len(auto_excluded) >= MAX_EXCLUDE:
                        break
                    extra = [p for seg in main["toll_segments"] for p in seg["exclude"]]
                    try:
                        retry = await self._valhalla(points, mode, avoid_tolls, avoid_highways, avoid_ferries,
                                                     exclude + auto_excluded + extra, alternatives, lang)
                    except NavigatorError:
                        break
                    auto_excluded += extra
                    result = retry
                result["routes"] = [r for i, r in enumerate(result["routes"]) if i == 0 or not r["toll_segments"]]
                if result["routes"][0]["toll_segments"]:
                    warnings.append("Non è stato possibile evitare tutte le tratte a pagamento: "
                                    "probabilmente non esiste una strada alternativa.")
            result["auto_excluded"] = auto_excluded
            if MODES[mode][0] in ("auto", "motorcycle"):
                await self._speed_limits(result["routes"][0], MODES[mode][0])
        except NavigatorError as err:
            if getattr(err, "no_route", False):
                raise
            # Valhalla non disponibile: ripiego su OSRM (senza opzioni di esclusione)
            try:
                result = await self._osrm(points, mode, alternatives)
            except NavigatorError:
                raise err from None
            result["auto_excluded"] = []
            warnings.append(f"Server Valhalla non disponibile ({err}): percorso calcolato con OSRM, "
                            "senza le opzioni per evitare pedaggi, autostrade o traghetti.")
        result["warnings"] = warnings + result.get("warnings", [])
        for r in result["routes"]:
            r.pop("_legs_enc", None)
            r.setdefault("speed_limits", [])
        return result

    async def _speed_limits(self, route: dict, costing: str) -> None:
        """Limiti di velocità lungo il percorso: [[inizio, fine, km/h], ...] sugli indici della forma."""
        limits: list[list[int]] = []
        try:
            for offset, enc in route.get("_legs_enc", []):
                body = {
                    "encoded_polyline": enc,
                    "costing": costing,
                    "shape_match": "edge_walk",
                    "filters": {"attributes": ["edge.speed_limit", "edge.begin_shape_index", "edge.end_shape_index"],
                                "action": "include"},
                }
                async with self._session.post(f"{self.valhalla}/trace_attributes", json=body, headers=self._headers,
                                              timeout=TIMEOUT) as resp:
                    if resp.status >= 400:
                        return
                    data = await resp.json(content_type=None)
                for e in data.get("edges", []):
                    lim = e.get("speed_limit")
                    if not isinstance(lim, (int, float)) or lim <= 0 or lim > 200:
                        continue
                    a, b = offset + e.get("begin_shape_index", 0), offset + e.get("end_shape_index", 0)
                    if limits and limits[-1][2] == lim and limits[-1][1] >= a:
                        limits[-1][1] = b  # tratti consecutivi con lo stesso limite
                    else:
                        limits.append([a, b, int(lim)])
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
            return  # senza limiti la navigazione funziona lo stesso
        route["speed_limits"] = limits

    async def _valhalla(self, points, mode, avoid_tolls, avoid_highways, avoid_ferries, exclude, alternatives,
                        language: str = "it-IT") -> dict:
        costing = MODES[mode][0]
        options: dict[str, Any] = {"use_ferry": 0.0 if avoid_ferries else 0.5}
        if costing in ("auto", "motorcycle"):
            options["use_tolls"] = 0.0 if avoid_tolls else 0.5
            options["use_highways"] = 0.0 if avoid_highways else 1.0
        if costing == "pedestrian":
            # a piedi: preferire marciapiedi, percorsi pedonali e attraversamenti (strisce) quando in OpenStreetMap sono
            # disegnati a parte; dove ci sono solo le strade il percorso resta quello di prima
            options["walkway_factor"] = 0.6
            options["sidewalk_factor"] = 0.6
        body: dict[str, Any] = {
            "locations": [{"lat": p["lat"], "lon": p["lon"], "type": "break"} for p in points],
            "costing": costing,
            "costing_options": {costing: options},
            "directions_options": {"units": "kilometers", "language": language},
        }
        if exclude:
            body["exclude_locations"] = [{"lat": p["lat"], "lon": p["lon"]} for p in exclude]
        if alternatives and len(points) == 2:
            body["alternates"] = 2
        try:
            async with self._session.post(f"{self.valhalla}/route", json=body, headers=self._headers,
                                          timeout=TIMEOUT) as resp:
                data = await resp.json(content_type=None)
                status = resp.status
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as err:
            raise NavigatorError(f"server non raggiungibile: {err.__class__.__name__}") from err
        if status >= 400 or "trip" not in data:
            code = data.get("error_code") if isinstance(data, dict) else None
            msg = data.get("error") if isinstance(data, dict) else None
            if code in (171, 442, 443):
                err = NavigatorError("Nessun percorso trovato fra questi punti con le opzioni scelte"
                                     + (" (prova a rimuovere qualche tratta esclusa)" if exclude else ""))
                err.no_route = True  # type: ignore[attr-defined]
                raise err
            if code in (150, 154, 155, 157, 158, 170, 171, 172):
                err = NavigatorError(f"Percorso non calcolabile: {msg or code}")
                err.no_route = True  # type: ignore[attr-defined]
                raise err
            raise NavigatorError(f"errore {status} {msg or ''}".strip())
        trips = [data["trip"]] + [a["trip"] for a in data.get("alternates", []) if "trip" in a]
        return {"engine": "valhalla", "routes": [self._norm_valhalla(t) for t in trips]}

    @staticmethod
    def _norm_valhalla(trip: dict) -> dict:
        shape: list[list[float]] = []
        maneuvers: list[dict] = []
        legs = []
        legs_enc = []
        for leg_no, leg in enumerate(trip.get("legs", [])):
            pts = decode_polyline(leg.get("shape", ""), 6)
            offset = len(shape)
            legs_enc.append((offset, leg.get("shape", "")))
            shape.extend(pts)
            legs.append({"time": leg["summary"]["time"], "length_km": leg["summary"]["length"]})
            for m in leg.get("maneuvers", []):
                streets = list(m.get("street_names") or m.get("begin_street_names") or [])
                branch = ((m.get("sign") or {}).get("exit_branch_elements") or [{}])[0].get("text", "")
                # rampe verso un'autostrada: la sigla (A21) è solo sul cartello, il nome è quello europeo (E 70)
                if branch and re.match(r"^A\d", branch) and not any(re.match(r"^A\d", n) for n in streets):
                    streets.insert(0, branch)
                maneuvers.append({
                    "text": m.get("instruction", ""),
                    "verbal": m.get("verbal_pre_transition_instruction", ""),
                    "alert": m.get("verbal_transition_alert_instruction") or m.get("verbal_succinct_transition_instruction", ""),
                    "type": m.get("type", 0),
                    "time": m.get("time", 0),
                    "length_km": m.get("length", 0),
                    "street": ", ".join(streets),
                    "toll": bool(m.get("toll")),
                    "highway": bool(m.get("highway")),
                    "ferry": m.get("travel_type") == "ferry" or bool(m.get("ferry")),
                    "begin": offset + m.get("begin_shape_index", 0),
                    "end": offset + m.get("end_shape_index", 0),
                    "leg": leg_no,
                })
        summary = trip.get("summary", {})
        toll_segments = _toll_segments(maneuvers, shape)
        return {
            "summary": {
                "time": summary.get("time", 0),
                "length_km": summary.get("length", 0),
                "has_toll": bool(summary.get("has_toll")) or bool(toll_segments),
                "has_highway": bool(summary.get("has_highway")),
                "has_ferry": bool(summary.get("has_ferry")),
            },
            "legs": legs,
            "shape": shape,
            "maneuvers": maneuvers,
            "toll_segments": toll_segments,
            "toll_km": round(sum(s["length_km"] for s in toll_segments), 1),
            "_legs_enc": legs_enc,
        }

    async def _osrm(self, points, mode, alternatives) -> dict:
        profile = MODES[mode][1]
        coords = ";".join(f"{p['lon']},{p['lat']}" for p in points)
        url = f"{self.osrm}/routed-{profile}/route/v1/driving/{coords}"
        params = {"overview": "full", "geometries": "polyline6", "steps": "true",
                  "alternatives": "true" if alternatives and len(points) == 2 else "false"}
        try:
            data = await self._get_json(url, params)
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as err:
            raise NavigatorError("nessun server di percorso raggiungibile") from err
        if data.get("code") != "Ok" or not data.get("routes"):
            raise NavigatorError(data.get("message") or "Nessun percorso trovato")
        routes = []
        for r in data["routes"]:
            shape = decode_polyline(r["geometry"], 6)
            maneuvers = []
            for leg_no, leg in enumerate(r.get("legs", [])):
                for step in leg.get("steps", []):
                    loc = step["maneuver"]["location"]
                    begin = _nearest_index(shape, [loc[1], loc[0]])
                    toll = any("toll" in (i.get("classes") or []) for i in step.get("intersections", []))
                    maneuvers.append({
                        "text": _osrm_text(step),
                        "verbal": "",
                        "type": 0,
                        "time": step.get("duration", 0),
                        "length_km": step.get("distance", 0) / 1000,
                        "street": step.get("name") or step.get("ref") or "",
                        "toll": toll,
                        "highway": any("motorway" in (i.get("classes") or []) for i in step.get("intersections", [])),
                        "ferry": step.get("mode") == "ferry",
                        "begin": begin,
                        "end": begin,
                        "leg": leg_no,
                    })
            for a, b in zip(maneuvers, maneuvers[1:]):
                a["end"] = max(a["begin"], b["begin"])
            toll_segments = _toll_segments(maneuvers, shape)
            routes.append({
                "summary": {
                    "time": r.get("duration", 0),
                    "length_km": r.get("distance", 0) / 1000,
                    "has_toll": bool(toll_segments),
                    "has_highway": any(m["highway"] for m in maneuvers),
                    "has_ferry": any(m["ferry"] for m in maneuvers),
                },
                "legs": [{"time": leg.get("duration", 0), "length_km": leg.get("distance", 0) / 1000}
                         for leg in r.get("legs", [])],
                "shape": shape,
                "maneuvers": maneuvers,
                "toll_segments": toll_segments,
                "toll_km": round(sum(s["length_km"] for s in toll_segments), 1),
            })
        return {"engine": "osrm", "routes": routes}


def _nearest_index(shape: list[list[float]], point: list[float]) -> int:
    best, best_d = 0, float("inf")
    for i, p in enumerate(shape):
        d = (p[0] - point[0]) ** 2 + (p[1] - point[1]) ** 2
        if d < best_d:
            best, best_d = i, d
    return best


def _toll_segments(maneuvers: list[dict], shape: list[list[float]]) -> list[dict]:
    """Raggruppa le manovre consecutive a pagamento in tratte; per ognuna i punti da escludere."""
    segments: list[dict] = []
    current: dict | None = None
    for idx, m in enumerate(maneuvers):
        if not m["toll"]:
            current = None
            continue
        mid = shape[min((m["begin"] + m["end"]) // 2, len(shape) - 1)] if shape else [0, 0]
        if current is None:
            current = {"first": idx, "last": idx, "begin": m["begin"], "end": m["end"],
                       "length_km": 0.0, "names": [], "exclude": []}
            segments.append(current)
        current["last"] = idx
        current["end"] = m["end"]
        current["length_km"] += m["length_km"]
        current["exclude"].append({"lat": mid[0], "lon": mid[1]})
        for name in (m["street"] or "").split(", "):
            if name and name not in current["names"]:
                current["names"].append(name)
    for seg in segments:
        seg["length_km"] = round(seg["length_km"], 1)
        # prima le sigle delle autostrade italiane (A4, A21…), poi i nomi; le strade europee (E 70) per ultime
        names = sorted(seg["names"], key=lambda n: (0 if re.match(r"^A\d", n) else 2 if re.match(r"^E ?\d", n) else 1))
        seg["name"] = " / ".join(names[:2]) or "Tratta a pagamento"
        seg["start_text"] = maneuvers[seg["first"]]["text"]
        del seg["names"]
    return segments


_DIRS = {
    "left": "a sinistra", "right": "a destra", "slight left": "leggermente a sinistra",
    "slight right": "leggermente a destra", "sharp left": "decisamente a sinistra",
    "sharp right": "decisamente a destra", "straight": "dritto", "uturn": "con un'inversione a U",
}


def _osrm_text(step: dict) -> str:
    """Istruzione in italiano per un passo OSRM (OSRM non le genera)."""
    man = step.get("maneuver", {})
    kind = man.get("type", "")
    mod = _DIRS.get(man.get("modifier", ""), "")
    name = step.get("name") or step.get("ref") or ""
    on = f" su {name}" if name else ""
    if kind == "depart":
        return f"Parti{on}"
    if kind == "arrive":
        return "Sei arrivato a destinazione" if not mod or mod == "dritto" else f"La destinazione è {mod}"
    if kind in ("roundabout", "rotary", "exit roundabout", "exit rotary"):
        exit_no = man.get("exit")
        return f"Alla rotonda prendi la {exit_no}ª uscita{on}" if exit_no else f"Entra nella rotonda{on}"
    if kind == "on ramp":
        return f"Prendi la rampa {mod}{on}".replace("  ", " ")
    if kind == "off ramp":
        return f"Prendi l'uscita {mod}{on}".replace("  ", " ")
    if kind == "fork":
        return f"Al bivio tieni {mod}{on}"
    if kind == "merge":
        return f"Immettiti {mod}{on}".replace("  ", " ")
    if kind == "end of road":
        return f"Alla fine della strada svolta {mod}{on}"
    if kind in ("continue", "new name"):
        return f"Continua {mod}{on}".replace("  ", " ") if mod and mod != "dritto" else f"Prosegui{on}"
    if mod == "dritto":
        return f"Prosegui dritto{on}"
    return f"Svolta {mod}{on}" if mod else f"Prosegui{on}"
