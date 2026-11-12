"""Diario dei viaggi e garage (veicoli) di ogni utente, salvati nello storage di Home Assistant."""

from __future__ import annotations

import time
import uuid
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import DOMAIN

MAX_TRIPS = 300   # per utente
MAX_TRACK = 3000  # punti della traccia
STALE_S = 30 * 60  # un viaggio "in corso" senza notizie da 30 minuti è interrotto (app chiusa senza Esci)


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

    # viaggio salvato man mano: creato alla partenza, punti aggiunti durante la guida, concluso con Esci
    def start(self, user_id: str, meta: dict[str, Any]) -> dict:
        now = time.time()
        item = {**meta, "id": uuid.uuid4().hex[:12], "track": [], "km": 0, "duration": 0, "avg": 0, "max": 0,
                "start": meta.get("start") or now, "end": now, "status": "in_corso", "updated": now}
        trips = self.data.setdefault(user_id, [])
        for t in trips:  # un viaggio rimasto aperto (app chiusa senza Esci) è interrotto
            if t.get("status") == "in_corso":
                t["status"] = "interrotto"
        trips.insert(0, item)
        del trips[MAX_TRIPS:]
        self._save()
        return item

    def append(self, user_id: str, trip_id: str, points: list, stats: dict[str, Any]) -> dict | None:
        t = self.get(user_id, trip_id)
        if t is None:
            return None
        t["track"].extend(points)
        if len(t["track"]) > MAX_TRACK:  # si dimezzano i punti più vecchi, l'ultimo resta
            t["track"] = t["track"][: len(t["track"]) - 1 : 2] + [t["track"][-1]]
        for k in ("km", "duration", "avg", "max", "end", "to"):
            if stats.get(k) is not None:
                t[k] = stats[k]
        t["updated"] = time.time()
        if t.get("status") != "concluso":
            t["status"] = "in_corso"
        self._save()
        return t

    def finish(self, user_id: str, trip_id: str) -> None:
        t = self.get(user_id, trip_id)
        if t is None:
            return
        if (t.get("km") or 0) < 0.3 or len(t.get("track") or []) < 2:  # troppo corto: non serve in archivio
            self.delete(user_id, trip_id)
            return
        t["status"] = "concluso"
        self._save()

    def summaries(self, user_id: str) -> list[dict]:
        out = []
        for t in self.data.get(user_id, []):
            item = {k: v for k, v in t.items() if k != "track"}
            if item.get("status") == "in_corso" and time.time() - item.get("updated", 0) > STALE_S:
                item["status"] = "interrotto"
            out.append(item)
        return out

    def get(self, user_id: str, trip_id: str) -> dict | None:
        return next((t for t in self.data.get(user_id, []) if t["id"] == trip_id), None)

    def delete(self, user_id: str, trip_id: str) -> None:
        self.data[user_id] = [t for t in self.data.get(user_id, []) if t["id"] != trip_id]
        self._save()
