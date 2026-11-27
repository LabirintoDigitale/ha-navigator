"""Lettori NaviHA: ogni telefono con l'app NaviHA diventa un lettore di Home Assistant (media_player), così Music
Assistant (o chiunque) può farci suonare la musica. Home Assistant passa i comandi al pannello aperto nell'app
(websocket) e fa da ponte per il flusso audio (/api/navigator/stream/<codice>), così si sente anche fuori casa."""
from __future__ import annotations

import re
import secrets
import time
from collections.abc import Callable
from typing import Any

import aiohttp
from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.storage import Store

from .const import DOMAIN

SIGNAL = "navigator_player_changed"
STREAMS_MAX = 40


class Players:
    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store = Store(hass, 1, "navigator.players")
        self.players: dict[str, dict[str, Any]] = {}  # id -> {"name"}
        self.subs: dict[str, dict[int, Callable[[dict], None]]] = {}  # id -> {n: invia evento}
        self.states: dict[str, dict[str, Any]] = {}  # id -> ultimo stato mandato dall'app
        self.streams: dict[str, str] = {}  # codice -> indirizzo vero del flusso
        self.add_entities: Callable | None = None
        self.entities: dict[str, Any] = {}
        self._seq = 0
        self._n = 0

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        self.players = {k: v for k, v in (data.get("players") or {}).items() if isinstance(v, dict)}

    @staticmethod
    def full_name(name: str, user: str | None) -> str:
        """Nome del lettore "App - utente - telefono" (es. "NaviHA - Luca - SM-S918B"): l'app manda "App telefono",
        l'utente è quello di Home Assistant collegato, così due telefoni uguali di persone diverse si distinguono."""
        name = " ".join(name.split())
        if " - " in name:
            return name[:60]
        app, _, model = name.partition(" ")
        user = " ".join((user or "").split())
        return " - ".join(x for x in (app, user, model) if x)[:60]

    @callback
    def make_entity(self, pid: str) -> None:
        if pid in self.entities or self.add_entities is None:
            return
        from .media_player import NaviHAPlayer

        ent = NaviHAPlayer(self, pid)
        self.entities[pid] = ent
        self.add_entities([ent])

    async def register(self, pid: str, name: str) -> None:
        # stesso telefono registrato due volte (vecchia app con codice casuale, prima di quello fisso del telefono):
        # via il doppione con lo stesso nome. Solo i codici casuali vecchi: due telefoni uguali hanno lo stesso
        # modello (e magari lo stesso utente) ma codici fissi diversi, e restano entrambi.
        dup = [k for k, v in self.players.items()
               if k != pid and v.get("name") == name and re.fullmatch(r"[a-z]+_[0-9a-f]{10}", k)]
        if dup:
            from homeassistant.helpers import entity_registry as er

            reg = er.async_get(self.hass)
            for k in dup:
                self.players.pop(k, None)
                ent = self.entities.pop(k, None)
                eid = reg.async_get_entity_id("media_player", DOMAIN, f"player_{k}")
                if eid:
                    reg.async_remove(eid)
                elif ent is not None:
                    await ent.async_remove()
            await self._store.async_save({"players": self.players})
        old = self.players.get(pid)
        if not old or old.get("name") != name:
            self.players[pid] = {"name": name}
            await self._store.async_save({"players": self.players})
        self.make_entity(pid)
        if old and old.get("name") != name:
            async_dispatcher_send(self.hass, SIGNAL, pid)

    @callback
    def subscribe(self, pid: str, send: Callable[[dict], None]) -> Callable[[], None]:
        self._n += 1
        n = self._n
        self.subs.setdefault(pid, {})[n] = send
        async_dispatcher_send(self.hass, SIGNAL, pid)

        @callback
        def unsub() -> None:
            self.subs.get(pid, {}).pop(n, None)
            async_dispatcher_send(self.hass, SIGNAL, pid)

        return unsub

    def online(self, pid: str) -> bool:
        return bool(self.subs.get(pid))

    @callback
    def send(self, pid: str, cmd: dict) -> bool:
        """Comando all'app (tutte le sue pagine aperte; l'app esegue una volta sola ogni numero)."""
        self._seq += 1
        cmd = {**cmd, "seq": f"{int(time.time())}-{self._seq}"}
        subs = list(self.subs.get(pid, {}).values())
        for s in subs:
            s(cmd)
        return bool(subs)

    @callback
    def set_state(self, pid: str, st: dict) -> None:
        old = self.states.get(pid, {})
        new = {**old, **st}
        same = all(old.get(k) == new.get(k) for k in ("state", "volume", "duration"))
        if same and abs((new.get("position") or 0) - (old.get("position") or 0)) < 10:
            return  # niente di nuovo: non si riscrive lo stato (meno aggiornamenti a chi lo segue, es. Music Assistant)
        self.states[pid] = {**new, "_t": time.time()}
        async_dispatcher_send(self.hass, SIGNAL, pid)

    def stream_path(self, url: str) -> str:
        """Indirizzo del ponte per un flusso audio: un codice casuale al posto dell'indirizzo (anche di casa)."""
        code = secrets.token_hex(16)
        self.streams[code] = url
        while len(self.streams) > STREAMS_MAX:
            self.streams.pop(next(iter(self.streams)))
        return f"/api/navigator/stream/{code}"


class StreamProxyView(HomeAssistantView):
    """Ponte per l'audio: Home Assistant legge il flusso (es. dal server di Music Assistant, in casa) e lo passa
    all'app. Senza accesso (il lettore di Android non lo saprebbe dare), ma solo con un codice casuale e recente."""

    url = "/api/navigator/stream/{code}"
    name = "api:navigator:stream"
    requires_auth = False

    async def get(self, request: web.Request, code: str) -> web.StreamResponse:
        hass = request.app["hass"]
        entry = hass.data.get(DOMAIN)
        players: Players | None = getattr(getattr(entry, "runtime_data", None), "players", None)
        src = players.streams.get(code) if players else None
        if not src:
            return web.Response(status=404)
        headers = {"Icy-MetaData": "0"}
        if request.headers.get("Range"):
            headers["Range"] = request.headers["Range"]
        try:
            up = await async_get_clientsession(hass).get(
                src, headers=headers, timeout=aiohttp.ClientTimeout(total=None, sock_connect=15, sock_read=90))
        except (aiohttp.ClientError, TimeoutError):
            return web.Response(status=502)
        try:
            if up.status not in (200, 206):
                return web.Response(status=up.status)
            out = {"Content-Type": up.headers.get("Content-Type", "audio/mpeg"), "Cache-Control": "no-store"}
            for h in ("Content-Length", "Content-Range", "Accept-Ranges"):
                if up.headers.get(h):
                    out[h] = up.headers[h]
            resp = web.StreamResponse(status=up.status, headers=out)
            await resp.prepare(request)
            try:
                async for chunk in up.content.iter_chunked(32768):
                    await resp.write(chunk)
            except (ConnectionResetError, aiohttp.ClientError, TimeoutError):
                pass
            return resp
        finally:
            up.release()
