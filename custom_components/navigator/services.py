"""Servizio navigator.plan_route: tempo e distanza di un percorso, utilizzabile nelle automazioni."""

from __future__ import annotations

import re

import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse, callback
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
import homeassistant.helpers.config_validation as cv

from .api import NavigatorError
from .const import DOMAIN, MODES

SERVICE_PLAN_ROUTE = "plan_route"

SCHEMA = vol.Schema({
    vol.Required("origin"): cv.string,
    vol.Required("destination"): cv.string,
    vol.Optional("via", default=[]): vol.All(cv.ensure_list, [cv.string]),
    vol.Optional("mode", default="auto"): vol.In(list(MODES)),
    vol.Optional("avoid_tolls", default=False): cv.boolean,
    vol.Optional("avoid_highways", default=False): cv.boolean,
    vol.Optional("avoid_ferries", default=False): cv.boolean,
})

_COORDS = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$")


async def _resolve(hass: HomeAssistant, value: str) -> dict:
    """Converte in coordinate: "lat,lon", un'entità (zone, person, device_tracker…) o un indirizzo."""
    if m := _COORDS.match(value):
        return {"lat": float(m.group(1)), "lon": float(m.group(2)), "name": value}
    if value.lower() in ("home", "casa", "zone.home"):
        return {"lat": hass.config.latitude, "lon": hass.config.longitude, "name": "Casa"}
    if "." in value and (state := hass.states.get(value)) is not None:
        lat, lon = state.attributes.get("latitude"), state.attributes.get("longitude")
        if lat is None or lon is None:
            # una persona in una zona: usa la posizione della zona
            zone = hass.states.get("zone.home") if state.state == "home" else next(
                (z for z in hass.states.async_all("zone") if z.attributes.get("friendly_name") == state.state), None)
            if zone is not None:
                lat, lon = zone.attributes.get("latitude"), zone.attributes.get("longitude")
        if lat is None or lon is None:
            raise ServiceValidationError(f"{value} non ha una posizione")
        return {"lat": lat, "lon": lon, "name": state.attributes.get("friendly_name", value)}
    entry = hass.data[DOMAIN]
    results = await entry.runtime_data.maps.search(value, hass.config.latitude, hass.config.longitude, limit=1)
    if not results:
        raise ServiceValidationError(f"Indirizzo non trovato: {value}")
    r = results[0]
    return {"lat": r["lat"], "lon": r["lon"], "name": r["name"], "address": r["address"]}


@callback
def async_setup(hass: HomeAssistant) -> None:
    if hass.services.has_service(DOMAIN, SERVICE_PLAN_ROUTE):
        return

    async def plan_route(call: ServiceCall) -> ServiceResponse:
        if DOMAIN not in hass.data:
            raise HomeAssistantError("Navigator non è configurato")
        maps = hass.data[DOMAIN].runtime_data.maps
        points = [await _resolve(hass, call.data["origin"])]
        for via in call.data["via"]:
            points.append(await _resolve(hass, via))
        points.append(await _resolve(hass, call.data["destination"]))
        try:
            result = await maps.route(points, call.data["mode"], call.data["avoid_tolls"],
                                      call.data["avoid_highways"], call.data["avoid_ferries"], alternatives=False)
        except NavigatorError as err:
            raise HomeAssistantError(str(err)) from err
        route = result["routes"][0]
        s = route["summary"]
        return {
            "duration_min": round(s["time"] / 60, 1),
            "distance_km": round(s["length_km"], 1),
            "has_toll": s["has_toll"],
            "toll_km": route["toll_km"],
            "has_highway": s["has_highway"],
            "has_ferry": s["has_ferry"],
            "engine": result["engine"],
            "origin": points[0],
            "destination": points[-1],
            "instructions": [m["text"] for m in route["maneuvers"]],
            "warnings": result["warnings"],
        }

    hass.services.async_register(DOMAIN, SERVICE_PLAN_ROUTE, plan_route, schema=SCHEMA,
                                 supports_response=SupportsResponse.ONLY)
