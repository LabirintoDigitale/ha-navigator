"""Comandi websocket usati dal pannello."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
import homeassistant.helpers.config_validation as cv

from .api import NavigatorError
from .const import DATA_WS_REGISTERED, DOMAIN, MAX_EXCLUDE, MAX_POINTS, MODES, VERSION

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
    for handler in (ws_info, ws_search, ws_reverse, ws_route, ws_place_save, ws_place_delete, ws_recent_clear):
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
    except NavigatorError as err:
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
    vol.Required("type"): "navigator/route",
    vol.Required("points"): vol.All([POINT], vol.Length(min=2, max=MAX_POINTS)),
    vol.Optional("mode", default="auto"): vol.In(list(MODES)),
    vol.Optional("avoid_tolls", default=False): bool,
    vol.Optional("avoid_highways", default=False): bool,
    vol.Optional("avoid_ferries", default=False): bool,
    vol.Optional("exclude", default=[]): vol.All([POINT], vol.Length(max=MAX_EXCLUDE)),
    vol.Optional("alternatives", default=True): bool,
})
@websocket_api.async_response
async def ws_route(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    async def go():
        data = _data(hass)
        result = await data.maps.route(
            msg["points"], msg["mode"], msg["avoid_tolls"], msg["avoid_highways"], msg["avoid_ferries"],
            msg["exclude"], msg["alternatives"],
        )
        dest = msg["points"][-1]
        if dest.get("name"):
            data.places.add_recent(dest["name"], dest.get("address", ""), dest["lat"], dest["lon"])
        result["recent"] = data.places.recent
        return result

    await _run(connection, msg["id"], go())


@websocket_api.websocket_command({
    vol.Required("type"): "navigator/place_save",
    vol.Optional("id", default=""): str,
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
        place = data.places.save_favorite(msg["name"], msg["address"], msg["lat"], msg["lon"], msg["icon"], msg["id"])
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
