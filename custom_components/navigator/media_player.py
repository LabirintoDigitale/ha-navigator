"""Lettore di Home Assistant per ogni telefono con l'app NaviHA (vedi players.py)."""
from __future__ import annotations

from typing import Any

import yarl

from homeassistant.components import media_source
from homeassistant.components.media_player import (
    BrowseMedia,
    MediaPlayerEntity,
    MediaPlayerEntityFeature,
    MediaPlayerState,
    MediaType,
    async_process_play_media_url,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.network import is_hass_url

from .const import DOMAIN
from .players import SIGNAL, Players


async def async_setup_entry(hass: HomeAssistant, entry, async_add_entities: AddEntitiesCallback) -> None:
    players: Players = entry.runtime_data.players
    players.add_entities = async_add_entities
    # via i lettori NaviHA rimasti da prove vecchie (non più fra quelli registrati)
    from homeassistant.helpers import entity_registry as er

    reg = er.async_get(hass)
    for e in er.async_entries_for_config_entry(reg, entry.entry_id):
        if e.domain == "media_player" and e.unique_id.startswith("player_") and e.unique_id[7:] not in players.players:
            reg.async_remove(e.entity_id)
    for pid in list(players.players):
        players.make_entity(pid)


class NaviHAPlayer(MediaPlayerEntity):
    _attr_should_poll = False
    _attr_has_entity_name = False
    _attr_media_content_type = MediaType.MUSIC
    _attr_supported_features = (
        MediaPlayerEntityFeature.PLAY_MEDIA
        | MediaPlayerEntityFeature.PLAY
        | MediaPlayerEntityFeature.PAUSE
        | MediaPlayerEntityFeature.STOP
        | MediaPlayerEntityFeature.VOLUME_SET
        | MediaPlayerEntityFeature.BROWSE_MEDIA
    )

    def __init__(self, players: Players, pid: str) -> None:
        self._p = players
        self._pid = pid
        self._meta: dict[str, Any] = {}
        self._attr_unique_id = f"player_{pid}"
        self._attr_device_info = DeviceInfo(identifiers={(DOMAIN, "navigator")})

    @property
    def name(self) -> str:
        return self._p.players.get(self._pid, {}).get("name") or "NaviHA"

    async def async_added_to_hass(self) -> None:
        @callback
        def _changed(pid: str) -> None:
            if pid == self._pid:
                self.async_write_ha_state()

        self.async_on_remove(async_dispatcher_connect(self.hass, SIGNAL, _changed))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"naviha_id": self._pid}  # per riconoscere nel pannello il lettore di questo telefono

    @property
    def _st(self) -> dict[str, Any]:
        return self._p.states.get(self._pid, {})

    @property
    def available(self) -> bool:
        return self._p.online(self._pid)

    @property
    def state(self) -> MediaPlayerState:
        s = self._st.get("state")
        return {"playing": MediaPlayerState.PLAYING, "paused": MediaPlayerState.PAUSED,
                "buffering": MediaPlayerState.BUFFERING}.get(s, MediaPlayerState.IDLE)

    @property
    def volume_level(self) -> float | None:
        v = self._st.get("volume")
        return float(v) if isinstance(v, (int, float)) else None

    @property
    def media_title(self) -> str | None:
        return self._meta.get("title") or None

    @property
    def media_artist(self) -> str | None:
        return self._meta.get("artist") or None

    @property
    def media_album_name(self) -> str | None:
        return self._meta.get("album") or None

    @property
    def media_image_url(self) -> str | None:
        return self._meta.get("image") or None

    @property
    def media_duration(self) -> int | None:
        d = self._st.get("duration")
        return int(d) if isinstance(d, (int, float)) and d > 0 else None

    @property
    def media_position(self) -> int | None:
        p = self._st.get("position")
        return int(p) if isinstance(p, (int, float)) else None

    @property
    def media_position_updated_at(self):
        from homeassistant.util import dt as dt_util

        t = self._st.get("_t")
        return dt_util.utc_from_timestamp(t) if t else None

    async def async_play_media(self, media_type: MediaType | str, media_id: str, **kwargs: Any) -> None:
        if media_source.is_media_source_id(media_id):
            item = await media_source.async_resolve_media(self.hass, media_id, self.entity_id)
            media_id = item.url
        # indirizzi di Home Assistant (firmati) li apre l'app così come sono; tutti gli altri (es. il server di Music
        # Assistant in casa) passano dal ponte di Navigator, che li rende raggiungibili anche fuori casa
        url = async_process_play_media_url(self.hass, media_id, allow_relative_url=True)
        if url.startswith("/"):
            path = url
        elif is_hass_url(self.hass, url):
            path = str(yarl.URL(url).relative())
        else:
            path = self._p.stream_path(url)
        extra = kwargs.get("extra") or {}
        md = extra.get("metadata") if isinstance(extra.get("metadata"), dict) else {}
        self._meta = {
            "title": md.get("title") or md.get("name") or "",
            "artist": md.get("artist") or (", ".join(md["artists"]) if isinstance(md.get("artists"), list) else ""),
            "album": md.get("album") or md.get("albumName") or "",
            "image": md.get("imageUrl") or md.get("image_url") or md.get("thumb") or "",
        }
        self._p.send(self._pid, {"cmd": "play", "url": path, **{k: v for k, v in self._meta.items() if v}})
        self._p.set_state(self._pid, {"state": "buffering", "position": 0})

    async def async_media_play(self) -> None:
        self._p.send(self._pid, {"cmd": "resume"})

    async def async_media_pause(self) -> None:
        self._p.send(self._pid, {"cmd": "pause"})

    async def async_media_stop(self) -> None:
        self._p.send(self._pid, {"cmd": "stop"})
        self._meta = {}

    async def async_set_volume_level(self, volume: float) -> None:
        self._p.send(self._pid, {"cmd": "volume", "volume": max(0.0, min(1.0, float(volume)))})
        self._p.set_state(self._pid, {"volume": max(0.0, min(1.0, float(volume)))})

    async def async_browse_media(self, media_content_type: MediaType | str | None = None,
                                 media_content_id: str | None = None) -> BrowseMedia:
        return await media_source.async_browse_media(
            self.hass, media_content_id, content_filter=lambda item: item.media_content_type.startswith("audio/"))
