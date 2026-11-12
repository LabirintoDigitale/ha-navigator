"""Sensori di Navigator: per ogni utente orario di arrivo, tempo e distanza rimanenti della guida in corso."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.const import UnitOfLength, UnitOfTime
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .live import SIGNAL, Live


async def async_setup_entry(hass: HomeAssistant, entry, async_add_entities: AddEntitiesCallback) -> None:
    live: Live = entry.runtime_data.live
    live.add_entities = async_add_entities
    for user_id in list(live.users):
        live.make_entities(user_id)


def entities_for(live: Live, user_id: str) -> list[SensorEntity]:
    return [NavArrival(live, user_id), NavMinutes(live, user_id), NavDistance(live, user_id)]


class _NavSensor(SensorEntity):
    _attr_should_poll = False
    _attr_has_entity_name = False
    _key = ""
    _label = ""

    def __init__(self, live: Live, user_id: str) -> None:
        self._live = live
        self._uid = user_id
        name = live.users.get(user_id) or "utente"
        self._attr_unique_id = f"{user_id}_{self._key}"
        self._attr_name = f"Navigator {name} {self._label}"
        self._attr_device_info = DeviceInfo(identifiers={(DOMAIN, "navigator")})

    async def async_added_to_hass(self) -> None:
        @callback
        def _changed(user_id: str) -> None:
            if user_id == self._uid:
                self.async_write_ha_state()

        self.async_on_remove(async_dispatcher_connect(self.hass, SIGNAL, _changed))

    @property
    def _st(self) -> dict[str, Any]:
        return self._live.get(self._uid)

    @property
    def _active(self) -> bool:
        return bool(self._st.get("active"))


class NavArrival(_NavSensor):
    _key = "arrivo"
    _label = "arrivo"
    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_icon = "mdi:map-marker-check"

    @property
    def native_value(self) -> datetime | None:
        eta = self._st.get("eta")
        if not self._active or not eta:
            return None
        return datetime.fromtimestamp(eta, tz=timezone.utc)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        st = self._st
        attrs = {"in_navigazione": self._active}
        if self._active:
            attrs.update(destinazione=st.get("dest", ""), indirizzo=st.get("address", ""), mezzo=st.get("mode", ""),
                         latitudine_destinazione=st.get("lat"), longitudine_destinazione=st.get("lon"),
                         arrivato=bool(st.get("arrived")))
        return attrs


class NavMinutes(_NavSensor):
    _key = "minuti"
    _label = "tempo rimanente"
    _attr_device_class = SensorDeviceClass.DURATION
    _attr_native_unit_of_measurement = UnitOfTime.MINUTES
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_icon = "mdi:timer-sand"

    @property
    def native_value(self) -> int | None:
        return self._st.get("minutes") if self._active else None


class NavDistance(_NavSensor):
    _key = "km"
    _label = "distanza rimanente"
    _attr_device_class = SensorDeviceClass.DISTANCE
    _attr_native_unit_of_measurement = UnitOfLength.KILOMETERS
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_icon = "mdi:map-marker-distance"
    _attr_suggested_display_precision = 1

    @property
    def native_value(self) -> float | None:
        return self._st.get("km") if self._active else None
