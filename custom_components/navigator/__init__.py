"""Navigator: mappe, ricerca di destinazioni e itinerari nella barra laterale di Home Assistant."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from . import services, ws_api
from .api import MapServices
from .const import (
    CONF_NOMINATIM_URL,
    CONF_OSRM_URL,
    CONF_PHOTON_URL,
    CONF_VALHALLA_URL,
    DATA_STATIC_REGISTERED,
    DEFAULT_OPTIONS,
    DOMAIN,
    PANEL_ELEMENT,
    PANEL_ICON,
    PANEL_TITLE,
    PANEL_URL,
    STATIC_URL,
    VERSION,
)
from .places import Places


@dataclass
class NavigatorData:
    maps: MapServices
    places: Places


type NavigatorConfigEntry = ConfigEntry[NavigatorData]


async def async_setup_entry(hass: HomeAssistant, entry: NavigatorConfigEntry) -> bool:
    """Prepara i client dei servizi di mappe, registra il pannello e i comandi websocket."""
    opts = {**DEFAULT_OPTIONS, **entry.options}
    maps = MapServices(
        async_get_clientsession(hass),
        opts[CONF_VALHALLA_URL],
        opts[CONF_OSRM_URL],
        opts[CONF_PHOTON_URL],
        opts[CONF_NOMINATIM_URL],
    )
    places = Places(hass)
    await places.async_load()
    entry.runtime_data = NavigatorData(maps, places)
    hass.data[DOMAIN] = entry

    if not hass.data.get(DATA_STATIC_REGISTERED):
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL, str(Path(__file__).parent / "frontend"), False)]
        )
        hass.data[DATA_STATIC_REGISTERED] = True

    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL,
        webcomponent_name=PANEL_ELEMENT,
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        module_url=f"{STATIC_URL}/navigator-panel.js?v={VERSION}",
        embed_iframe=False,
        require_admin=False,
        config={},
    )
    ws_api.async_setup(hass)
    services.async_setup(hass)
    entry.async_on_unload(entry.add_update_listener(_async_reload))
    return True


async def _async_reload(hass: HomeAssistant, entry: NavigatorConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: NavigatorConfigEntry) -> bool:
    """Rimuove il pannello."""
    frontend.async_remove_panel(hass, PANEL_URL)
    hass.data.pop(DOMAIN, None)
    return True
