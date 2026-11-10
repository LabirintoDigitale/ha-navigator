"""Luoghi preferiti e destinazioni recenti, salvati nello storage di Home Assistant."""

from __future__ import annotations

import time
import uuid

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import DOMAIN, MAX_RECENT


class Places:
    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store[dict] = Store(hass, 1, f"{DOMAIN}.places")
        self.favorites: list[dict] = []
        self.recent: list[dict] = []

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        self.favorites = data.get("favorites", [])
        self.recent = data.get("recent", [])

    def _save(self) -> None:
        self._store.async_delay_save(lambda: {"favorites": self.favorites, "recent": self.recent}, 1)

    def as_dict(self) -> dict:
        return {"favorites": self.favorites, "recent": self.recent}

    def save_favorite(self, name: str, address: str, lat: float, lon: float, icon: str = "", place_id: str = "") -> dict:
        place = next((p for p in self.favorites if p["id"] == place_id), None) if place_id else None
        if place is None:
            place = {"id": uuid.uuid4().hex[:12]}
            self.favorites.append(place)
        place.update(name=name.strip() or "Senza nome", address=address, lat=lat, lon=lon, icon=icon or "★")
        self._save()
        return place

    def delete_favorite(self, place_id: str) -> None:
        self.favorites = [p for p in self.favorites if p["id"] != place_id]
        self._save()

    def add_recent(self, name: str, address: str, lat: float, lon: float) -> None:
        self.recent = [p for p in self.recent
                       if abs(p["lat"] - lat) > 1e-4 or abs(p["lon"] - lon) > 1e-4][: MAX_RECENT - 1]
        self.recent.insert(0, {"name": name, "address": address, "lat": lat, "lon": lon, "time": int(time.time())})
        self._save()

    def clear_recent(self) -> None:
        self.recent = []
        self._save()
