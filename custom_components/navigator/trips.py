"""Diario dei viaggi e garage (veicoli) di ogni utente, salvati nello storage di Home Assistant."""

from __future__ import annotations

import uuid
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import DOMAIN

MAX_TRIPS = 300   # per utente
MAX_TRACK = 3000  # punti della traccia


class Trips:
    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store[dict] = Store(hass, 1, f"{DOMAIN}.trips")
        self.data: dict[str, list[dict]] = {}
        self.garage: dict[str, list[dict]] = {}

    async def async_load(self) -> None:
        stored = await self._store.async_load() or {}
        self.data = stored.get("users", {})
        self.garage = stored.get("garage", {})

    def _save(self) -> None:
        self._store.async_delay_save(lambda: {"users": self.data, "garage": self.garage}, 5)

    def vehicles(self, user_id: str) -> list[dict]:
        return self.garage.get(user_id, [])

    def set_vehicles(self, user_id: str, vehicles: list[dict]) -> list[dict]:
        clean = []
        for v in vehicles[:30]:
            clean.append({"id": str(v.get("id") or uuid.uuid4().hex[:8])[:16], "name": str(v.get("name") or "")[:40],
                          "plate": str(v.get("plate") or "").upper()[:12], "type": str(v.get("type") or "auto")[:12]})
        self.garage[user_id] = clean
        self._save()
        return clean

    def add(self, user_id: str, trip: dict[str, Any]) -> dict:
        track = trip.get("track") or []
        if len(track) > MAX_TRACK:  # si tengono punti distribuiti su tutto il viaggio
            step = len(track) / MAX_TRACK
            track = [track[int(i * step)] for i in range(MAX_TRACK)] + [track[-1]]
        item = {**trip, "track": track, "id": uuid.uuid4().hex[:12]}
        trips = self.data.setdefault(user_id, [])
        trips.insert(0, item)
        del trips[MAX_TRIPS:]
        self._save()
        return item

    def summaries(self, user_id: str) -> list[dict]:
        return [{k: v for k, v in t.items() if k != "track"} for t in self.data.get(user_id, [])]

    def get(self, user_id: str, trip_id: str) -> dict | None:
        return next((t for t in self.data.get(user_id, []) if t["id"] == trip_id), None)

    def delete(self, user_id: str, trip_id: str) -> None:
        self.data[user_id] = [t for t in self.data.get(user_id, []) if t["id"] != trip_id]
        self._save()
