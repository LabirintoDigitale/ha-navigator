"""Copertine per il pannello: Home Assistant scarica un'immagine (es. dal server di Music Assistant in http, che una
pagina in https non può caricare) e la passa al pannello. Solo per utenti di Home Assistant (indirizzo firmato o
accesso) e solo immagini fino a 3 MB."""

# === Navigator per Home Assistant ======================================
# © 2026 LabirintoDigitale — Licenza PolyForm Strict 1.0.0 (file LICENSE).
# Uso e installazione gratuiti, anche commerciali; è vietato modificare,
# ridistribuire o riutilizzare questo codice per creare progetti o
# prodotti simili. https://github.com/LabirintoDigitale/ha-navigator
# =======================================================================

from __future__ import annotations

import aiohttp
from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.helpers.aiohttp_client import async_get_clientsession

MAX = 3_000_000


class ImageProxyView(HomeAssistantView):
    url = "/api/navigator/image"
    name = "api:navigator:image"
    requires_auth = True

    async def get(self, request: web.Request) -> web.StreamResponse:
        src = request.query.get("url", "")
        if not src.startswith(("http://", "https://")) or len(src) > 2000:
            return web.Response(status=400)
        hass = request.app["hass"]
        try:
            async with async_get_clientsession(hass).get(src, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                ctype = resp.headers.get("Content-Type", "")
                if resp.status != 200 or not ctype.startswith("image/"):
                    return web.Response(status=404)
                data = await resp.content.read(MAX + 1)
        except (aiohttp.ClientError, TimeoutError):
            return web.Response(status=502)
        if len(data) > MAX:
            return web.Response(status=413)
        return web.Response(body=data, content_type=ctype.split(";")[0], headers={"Cache-Control": "private, max-age=86400"})
