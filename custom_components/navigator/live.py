"""Navigazione in corso di ogni utente, per i sensori (orario di arrivo, tempo e distanza rimanenti).

Il pannello manda lo stato della guida (comando navigator/live); i sensori di ogni utente nascono la prima volta che
quell'utente naviga e restano (l'elenco degli utenti è salvato), così gli entity_id non cambiano.
"""

from __future__ import annotations

from datetime import datetime, timedelta
import time
from typing import Any, Callable

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.helpers.storage import Store

from .const import DOMAIN

SIGNAL = f"{DOMAIN}_live_update"
STALE_S = 15 * 60  # nessun aggiornamento per 15 minuti (app chiusa, telefono spento): la guida si considera finita


class Live:
    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store: Store[dict] = Store(hass, 1, f"{DOMAIN}.users")
        self.users: dict[str, str] = {}  # user_id -> nome
        self.state: dict[str, dict[str, Any]] = {}
        self.add_entities: Callable | None = None
        self._made: set[str] = set()
        self._unsub = None

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        self.users = data.get("users", {})
        self._unsub = async_track_time_interval(self.hass, self._expire, timedelta(minutes=1))

    def async_unload(self) -> None:
        if self._unsub:
            self._unsub()
            self._unsub = None

    @callback
    def make_entities(self, user_id: str) -> None:
        """Crea i sensori di un utente (una volta sola)."""
        if self.add_entities is None or user_id in self._made:
            return
        from .sensor import entities_for  # import qui: sensor.py importa questo modulo

        self._made.add(user_id)
        self.add_entities(entities_for(self, user_id))

    async def update(self, user_id: str, name: str, data: dict[str, Any]) -> None:
        if self.users.get(user_id) != name:
            self.users[user_id] = name
            self._store.async_delay_save(lambda: {"users": self.users}, 1)
        self.make_entities(user_id)
        self.state[user_id] = {**data, "updated": time.time()}
        async_dispatcher_send(self.hass, SIGNAL, user_id)

    def get(self, user_id: str) -> dict[str, Any]:
        st = self.state.get(user_id) or {}
        if st.get("active") and time.time() - st.get("updated", 0) > STALE_S:
            return {**st, "active": False}
        return st

    @callback
    def _expire(self, _now: datetime) -> None:
        for uid, st in self.state.items():
            if st.get("active") and time.time() - st.get("updated", 0) > STALE_S and not st.get("expired"):
                st["expired"] = True
                async_dispatcher_send(self.hass, SIGNAL, uid)
