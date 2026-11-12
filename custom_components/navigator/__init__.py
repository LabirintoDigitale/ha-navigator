"""Navigator: mappe, ricerca di destinazioni e itinerari nella barra laterale di Home Assistant."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
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
from .live import Live
from .places import Places
from .pois import Pois
from .trips import Trips
from .weather import Weather

PLATFORMS = ["sensor"]


@dataclass
class NavigatorData:
    maps: MapServices
    places: Places
    pois: Pois
    live: Live
    trips: Trips
    weather: Weather


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
    pois = Pois(async_get_clientsession(hass), Path(hass.config.path("navigator_cache")), hass.config.country,
                hass.async_add_executor_job, opts[CONF_PHOTON_URL])
    live = Live(hass)
    await live.async_load()
    trips = Trips(hass)
    await trips.async_load()
    entry.runtime_data = NavigatorData(maps, places, pois, live, trips, Weather(async_get_clientsession(hass)))
    hass.data[DOMAIN] = entry

    # "servizio" nella scheda dell'integrazione: mostra la versione installata
    dr.async_get(hass).async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, "navigator")},
        name="Navigator",
        manufacturer="LabirintoDigitale",
        model="Mappe e itinerari (OpenStreetMap)",
        sw_version=VERSION,
        entry_type=dr.DeviceEntryType.SERVICE,
        configuration_url="https://github.com/LabirintoDigitale/ha-navigator",
    )

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
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_reload))
    return True


async def _async_reload(hass: HomeAssistant, entry: NavigatorConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: NavigatorConfigEntry) -> bool:
    """Rimuove il pannello e i sensori."""
    ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    entry.runtime_data.live.async_unload()
    frontend.async_remove_panel(hass, PANEL_URL)
    hass.data.pop(DOMAIN, None)
    return ok
