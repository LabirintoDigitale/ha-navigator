"""Comandi websocket usati dal pannello."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
import homeassistant.helpers.config_validation as cv

from .api import NavigatorError
from .pois import PoiError
from .weather import WeatherError
from .const import DATA_WS_REGISTERED, DOMAIN, LANGUAGES, MAX_EXCLUDE, MAX_POINTS, MODES, VERSION

POINT = vol.Schema(
    {
        vol.Required("lat"): vol.All(vol.Coerce(float), vol.Range(min=-90, max=90)),
        vol.Required("lon"): vol.All(vol.Coerce(float), vol.Range(min=-180, max=180)),
        vol.Optional("name", default=""): str,
        vol.Optional("address", default=""): str,
    },
    extra=vol.REMOVE_EXTRA,
)


@callback
def async_setup(hass: HomeAssistant) -> None:
    if hass.data.get(DATA_WS_REGISTERED):
        return
    for handler in (ws_info, ws_search, ws_reverse, ws_route, ws_place_save, ws_place_delete, ws_recent_clear, ws_nearby,
                    ws_poi_tile, ws_live, ws_weather, ws_trip_save, ws_trips, ws_trip, ws_trip_delete, ws_garage,
                    ws_garage_save, ws_trip_start, ws_trip_append, ws_trip_finish, ws_poi_tiles, ws_poi_info, ws_live_all, ws_garage_select):
        websocket_api.async_register_command(hass, handler)
    hass.data[DATA_WS_REGISTERED] = True


def _data(hass: HomeAssistant):
    entry = hass.data.get(DOMAIN)
    if entry is None:
        raise NavigatorError("Navigator non è configurato")
    return entry.runtime_data


async def _run(connection, msg_id: int, coro) -> None:
    try:
        connection.send_result(msg_id, await coro)
    except (NavigatorError, PoiError, WeatherError) as err:
        connection.send_error(msg_id, "navigator_error", str(err))


def _home(hass: HomeAssistant) -> dict[str, Any]:
    return {"lat": hass.config.latitude, "lon": hass.config.longitude, "name": hass.config.location_name or "Casa"}


def _zones_and_people(hass: HomeAssistant) -> list[dict]:
    """Zone e persone/dispositivi con posizione, da usare come punti rapidi."""
    out = []
    for state in hass.states.async_all(("zone", "person", "device_tracker")):
        lat, lon = state.attributes.get("latitude"), state.attributes.get("longitude")
        if lat is None or lon is None:
            continue
        if state.domain == "device_tracker" and state.attributes.get("source_type") not in (None, "gps"):
            continue
        out.append({
            "entity_id": state.entity_id,
            "name": state.attributes.get("friendly_name") or state.entity_id,
            "kind": state.domain,
            "lat": lat,
            "lon": lon,
        })
    return out


@websocket_api.websocket_command({vol.Required("type"): "navigator/info"})
@websocket_api.async_response
async def ws_info(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    async def go():
        data = _data(hass)
        return {"version": VERSION, "home": _home(hass), "entities": _zones_and_people(hass), **data.places.as_dict()}

    await _run(connection, msg["id"], go())


@websocket_api.websocket_command({
    vol.Required("type"): "navigator/search",
    vol.Required("query"): str,
    vol.Optional("lat"): vol.Coerce(float),
    vol.Optional("lon"): vol.Coerce(float),
})
@websocket_api.async_response
async def ws_search(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    async def go():
        return {"results": await _data(hass).maps.search(msg["query"], msg.get("lat"), msg.get("lon"))}

    await _run(connection, msg["id"], go())


@websocket_api.websocket_command({
    vol.Required("type"): "navigator/reverse",
    vol.Required("lat"): vol.Coerce(float),
    vol.Required("lon"): vol.Coerce(float),
})
@websocket_api.async_response
async def ws_reverse(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    async def go():
        return await _data(hass).maps.reverse(msg["lat"], msg["lon"])

    await _run(connection, msg["id"], go())


@websocket_api.websocket_command({
    vol.Required("type"): "navigator/poi_info",
    vol.Required("lat"): vol.Coerce(float),
    vol.Required("lon"): vol.Coerce(float),
    vol.Optional("name", default=""): vol.All(str, vol.Length(max=120)),
    vol.Optional("osm", default=""): vol.All(str, vol.Length(max=24)),
})
@websocket_api.async_response
async def ws_poi_info(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Scheda di un punto di interesse: orari, telefono, sito, indirizzo (OpenStreetMap tramite Nominatim)."""
    async def go():
        return await _data(hass).maps.poi_info(msg["lat"], msg["lon"], msg["name"], msg["osm"])

    await _run(connection, msg["id"], go())


@websocket_api.websocket_command({
    vol.Required("type"): "navigator/route",
    vol.Required("points"): vol.All([POINT], vol.Length(min=2, max=MAX_POINTS)),
    vol.Optional("mode", default="auto"): vol.In(list(MODES)),
    vol.Optional("avoid_tolls", default=False): bool,
    vol.Optional("avoid_highways", default=False): bool,
    vol.Optional("avoid_ferries", default=False): bool,
    vol.Optional("exclude", default=[]): vol.All([POINT], vol.Length(max=MAX_EXCLUDE)),
    vol.Optional("alternatives", default=True): bool,
    vol.Optional("language", default="it"): vol.In(list(LANGUAGES)),
})
@websocket_api.async_response
async def ws_route(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    async def go():
        data = _data(hass)
        result = await data.maps.route(
            msg["points"], msg["mode"], msg["avoid_tolls"], msg["avoid_highways"], msg["avoid_ferries"],
            msg["exclude"], msg["alternatives"], msg["language"],
        )
        dest = msg["points"][-1]
        if dest.get("name"):
            data.places.add_recent(dest["name"], dest.get("address", ""), dest["lat"], dest["lon"])
        result["recent"] = data.places.recent
        return result

    await _run(connection, msg["id"], go())


@websocket_api.websocket_command({
    vol.Required("type"): "navigator/place_save",
    # "id" è già il numero del messaggio WebSocket: l'identificativo del preferito da modificare si chiama place_id
    vol.Optional("place_id", default=""): str,
    vol.Required("name"): cv.string,
    vol.Optional("address", default=""): str,
    vol.Required("lat"): vol.Coerce(float),
    vol.Required("lon"): vol.Coerce(float),
    vol.Optional("icon", default=""): str,
})
@websocket_api.async_response
async def ws_place_save(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    async def go():
        data = _data(hass)
        place = data.places.save_favorite(msg["name"], msg["address"], msg["lat"], msg["lon"], msg["icon"], msg["place_id"])
        return {"place": place, **data.places.as_dict()}

    await _run(connection, msg["id"], go())


@websocket_api.websocket_command({vol.Required("type"): "navigator/place_delete", vol.Required("place_id"): str})
@websocket_api.async_response
async def ws_place_delete(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    async def go():
        data = _data(hass)
        data.places.delete_favorite(msg["place_id"])
        return data.places.as_dict()

    await _run(connection, msg["id"], go())


@websocket_api.websocket_command({vol.Required("type"): "navigator/recent_clear"})
@websocket_api.async_response
async def ws_recent_clear(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    async def go():
        data = _data(hass)
        data.places.clear_recent()
        return data.places.as_dict()

    await _run(connection, msg["id"], go())


LATLON = vol.All(vol.Length(min=2, max=2), [vol.Coerce(float)])


@websocket_api.websocket_command({
    vol.Required("type"): "navigator/nearby",
    vol.Required("category"): vol.In(["fuel", "cameras", "parking"]),
    vol.Optional("line"): vol.All([LATLON], vol.Length(min=1, max=8000)),
    vol.Optional("center"): POINT,
    vol.Optional("radius", default=500): vol.All(vol.Coerce(float), vol.Range(min=10, max=5000)),
})
@websocket_api.async_response
async def ws_nearby(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Distributori e autovelox lungo una linea (il percorso), parcheggi intorno a un punto."""
    async def go():
        pois = _data(hass).pois
        cat = msg["category"]
        if cat == "parking":
            c = msg.get("center") or {"lat": msg["line"][-1][0], "lon": msg["line"][-1][1]}
            return await pois.parking(c["lat"], c["lon"], msg["radius"])
        line = msg.get("line") or [[msg["center"]["lat"], msg["center"]["lon"]]]
        if cat == "fuel":
            return await pois.fuel(line, msg["radius"])
        return await pois.cameras(line, msg["radius"])

    await _run(connection, msg["id"], go())


@websocket_api.websocket_command({
    vol.Required("type"): "navigator/poi_tile",
    vol.Required("x"): vol.All(vol.Coerce(int), vol.Range(min=-9000, max=9000)),
    vol.Required("y"): vol.All(vol.Coerce(int), vol.Range(min=-4500, max=4500)),
})
@websocket_api.async_response
async def ws_poi_tile(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Punti di interesse di un riquadro della mappa (OpenStreetMap via Overpass, in cache per un giorno)."""
    async def go():
        return await _data(hass).pois.poi_tile(msg["x"], msg["y"])

    await _run(connection, msg["id"], go())


def _user(connection) -> tuple[str, str]:
    user = connection.user
    if user is None:
        raise NavigatorError("Utente non riconosciuto")
    return user.id, user.name or "utente"


@websocket_api.websocket_command({
    vol.Required("type"): "navigator/live",
    vol.Required("active"): bool,
    vol.Optional("eta"): vol.Coerce(float),
    vol.Optional("minutes"): vol.Coerce(int),
    vol.Optional("km"): vol.Coerce(float),
    vol.Optional("dest", default=""): str,
    vol.Optional("address", default=""): str,
    vol.Optional("mode", default=""): str,
    vol.Optional("lat"): vol.Coerce(float),
    vol.Optional("lon"): vol.Coerce(float),
    vol.Optional("arrived", default=False): bool,
    # per la scheda Live: dove sei adesso, verso dove vai, con che veicolo, il viaggio in corso
    vol.Optional("plat"): vol.Coerce(float),
    vol.Optional("plon"): vol.Coerce(float),
    vol.Optional("dir"): vol.Coerce(float),
    vol.Optional("speed"): vol.Coerce(float),
    vol.Optional("from", default=""): str,
    vol.Optional("trip_id", default=""): str,
    vol.Optional("vehicle"): dict,
})
@websocket_api.async_response
async def ws_live(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Stato della guida dell'utente collegato: aggiorna i suoi sensori (arrivo, tempo e distanza rimanenti)."""
    async def go():
        uid, name = _user(connection)
        data = {k: msg[k] for k in ("active", "eta", "minutes", "km", "dest", "address", "mode", "lat", "lon", "arrived",
                                    "plat", "plon", "dir", "speed", "from", "trip_id") if k in msg}
        v = msg.get("vehicle") or {}
        data["vehicle"] = {k: str(v.get(k) or "")[:40] for k in ("name", "plate", "type", "icon", "color")}
        await _data(hass).live.update(uid, name, data)
        return {"ok": True}

    await _run(connection, msg["id"], go())


@websocket_api.websocket_command({vol.Required("type"): "navigator/live_all"})
@websocket_api.async_response
async def ws_live_all(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Guide in corso di tutti gli utenti (scheda Live): posizione, arrivo, veicolo e traccia percorsa finora."""
    async def go():
        uid, _name = _user(connection)
        data = _data(hass)
        out = []
        for user_id, st in data.live.active().items():
            track = []
            if st.get("trip_id"):
                t = data.trips.get(user_id, st["trip_id"])
                track = list((t or {}).get("track") or [])[-600:]
            if st.get("plat") is not None and st.get("plon") is not None:
                track.append([round(st["plat"], 5), round(st["plon"], 5)])
            out.append({**{k: v for k, v in st.items() if k != "trip_id"}, "user_id": user_id,
                        "name": data.live.users.get(user_id, ""), "me": user_id == uid, "track": track})
        out.sort(key=lambda x: x.get("eta") or 0)
        return {"live": out}

    await _run(connection, msg["id"], go())


@websocket_api.websocket_command({
    vol.Required("type"): "navigator/weather",
    vol.Required("points"): vol.All([vol.All(vol.Length(min=3, max=3), [vol.Coerce(float)])], vol.Length(min=1, max=40)),
})
@websocket_api.async_response
async def ws_weather(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Meteo previsto nei punti del percorso all'ora di passaggio (Open-Meteo)."""
    async def go():
        return {"points": await _data(hass).weather.along(msg["points"])}

    await _run(connection, msg["id"], go())


@websocket_api.websocket_command({vol.Required("type"): "navigator/trip_save", vol.Required("trip"): dict})
@websocket_api.async_response
async def ws_trip_save(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Salva nel diario dell'utente collegato un viaggio appena finito."""
    async def go():
        uid, _name = _user(connection)
        t = msg["trip"]
        trip = {k: t.get(k) for k in ("start", "end", "from", "to", "mode", "km", "duration", "avg", "max")}
        veh = t.get("vehicle") if isinstance(t.get("vehicle"), dict) else {}
        trip["vehicle"] = {k: str(veh.get(k) or "")[:40] for k in ("id", "name", "plate", "type")}
        trip["track"] = [[round(float(p[0]), 5), round(float(p[1]), 5)] for p in (t.get("track") or []) if len(p) >= 2][:20000]
        item = _data(hass).trips.add(uid, trip)
        return {"id": item["id"]}

    await _run(connection, msg["id"], go())


@websocket_api.websocket_command({vol.Required("type"): "navigator/trips"})
@websocket_api.async_response
async def ws_trips(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Diario dei viaggi dell'utente collegato (senza le tracce)."""
    async def go():
        uid, _name = _user(connection)
        return {"trips": _data(hass).trips.summaries(uid)}

    await _run(connection, msg["id"], go())


@websocket_api.websocket_command({vol.Required("type"): "navigator/trip", vol.Required("trip_id"): str})
@websocket_api.async_response
async def ws_trip(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    async def go():
        uid, _name = _user(connection)
        trip = _data(hass).trips.get(uid, msg["trip_id"])
        if trip is None:
            raise NavigatorError("Viaggio non trovato")
        return trip

    await _run(connection, msg["id"], go())


@websocket_api.websocket_command({vol.Required("type"): "navigator/trip_delete", vol.Required("trip_id"): str})
@websocket_api.async_response
async def ws_trip_delete(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    async def go():
        uid, _name = _user(connection)
        _data(hass).trips.delete(uid, msg["trip_id"])
        return {"trips": _data(hass).trips.summaries(uid)}

    await _run(connection, msg["id"], go())


@websocket_api.websocket_command({vol.Required("type"): "navigator/garage"})
@websocket_api.async_response
async def ws_garage(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Veicoli del garage dell'utente collegato."""
    async def go():
        uid, _name = _user(connection)
        trips = _data(hass).trips
        return {"vehicles": trips.vehicles(uid), "selected": trips.selected.get(uid, "")}

    await _run(connection, msg["id"], go())


@websocket_api.websocket_command({vol.Required("type"): "navigator/garage_select", vol.Required("vehicle_id"): str})
@websocket_api.async_response
async def ws_garage_select(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Veicolo scelto dall'utente collegato, ricordato per le prossime volte."""
    async def go():
        uid, _name = _user(connection)
        _data(hass).trips.select(uid, msg["vehicle_id"])
        return {"ok": True}

    await _run(connection, msg["id"], go())


@websocket_api.websocket_command({vol.Required("type"): "navigator/garage_save", vol.Required("vehicles"): [dict]})
@websocket_api.async_response
async def ws_garage_save(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    async def go():
        uid, _name = _user(connection)
        return {"vehicles": _data(hass).trips.set_vehicles(uid, msg["vehicles"])}

    await _run(connection, msg["id"], go())


def _vehicle(v) -> dict:
    v = v if isinstance(v, dict) else {}
    return {k: str(v.get(k) or "")[:40] for k in ("id", "name", "plate", "type")}


def _points(raw) -> list[list[float]]:
    return [[round(float(p[0]), 5), round(float(p[1]), 5)] for p in (raw or []) if isinstance(p, (list, tuple)) and len(p) >= 2][:5000]


@websocket_api.websocket_command({vol.Required("type"): "navigator/trip_start", vol.Required("trip"): dict})
@websocket_api.async_response
async def ws_trip_start(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Crea il viaggio alla partenza: i punti arrivano man mano (trip_append), anche se la guida non finisce con Esci."""
    async def go():
        uid, _name = _user(connection)
        t = msg["trip"]
        meta = {k: str(t.get(k) or "")[:80] for k in ("from", "to", "mode")}
        meta["start"] = float(t.get("start") or 0) or None
        meta["vehicle"] = _vehicle(t.get("vehicle"))
        return {"id": _data(hass).trips.start(uid, meta)["id"]}

    await _run(connection, msg["id"], go())


@websocket_api.websocket_command({
    vol.Required("type"): "navigator/trip_append",
    vol.Required("trip_id"): str,
    vol.Optional("points", default=[]): list,
    vol.Optional("stats", default={}): dict,
})
@websocket_api.async_response
async def ws_trip_append(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    async def go():
        uid, _name = _user(connection)
        st = msg["stats"]
        stats = {k: float(st[k]) for k in ("km", "duration", "avg", "max", "end") if isinstance(st.get(k), (int, float))}
        if st.get("to"):
            stats["to"] = str(st["to"])[:80]
        ok = _data(hass).trips.append(uid, msg["trip_id"], _points(msg["points"]), stats)
        if ok is None:
            raise NavigatorError("Viaggio non trovato")
        return {"ok": True}

    await _run(connection, msg["id"], go())


@websocket_api.websocket_command({vol.Required("type"): "navigator/trip_finish", vol.Required("trip_id"): str})
@websocket_api.async_response
async def ws_trip_finish(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    async def go():
        uid, _name = _user(connection)
        _data(hass).trips.finish(uid, msg["trip_id"])
        return {"ok": True}

    await _run(connection, msg["id"], go())


@websocket_api.websocket_command({
    vol.Required("type"): "navigator/poi_tiles",
    vol.Required("tiles"): vol.All([vol.All(vol.Length(min=2, max=2), [vol.Coerce(int)])], vol.Length(min=1, max=16)),
    vol.Optional("kinds", default=[]): [str],
})
@websocket_api.async_response
async def ws_poi_tiles(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Punti di interesse di più riquadri con una sola richiesta a Overpass (quelli già in memoria non si richiedono)."""
    async def go():
        return await _data(hass).pois.poi_tiles([(x, y) for x, y in msg["tiles"]], msg["kinds"])

    await _run(connection, msg["id"], go())
