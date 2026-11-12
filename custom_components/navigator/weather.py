"""Meteo lungo il percorso: previsioni orarie di Open-Meteo (gratuito, senza chiave) nei punti e alle ore di passaggio."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import aiohttp

from .const import USER_AGENT

OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
HOURLY = "temperature_2m,precipitation,snowfall,weather_code,wind_gusts_10m"


class WeatherError(Exception):
    """Errore comprensibile da mostrare all'utente."""


class Weather:
    def __init__(self, session: aiohttp.ClientSession) -> None:
        self._session = session
        self._cache: dict[str, tuple[float, dict]] = {}

    async def along(self, points: list[list[float]]) -> list[dict[str, Any]]:
        """points: [[lat, lon, ora di passaggio (unix)], ...] -> meteo previsto in quel punto a quell'ora."""
        need = []
        for lat, lon, _t in points:
            key = f"{lat:.2f},{lon:.2f}"
            hit = self._cache.get(key)
            if not hit or time.time() - hit[0] > 1800:
                need.append((key, round(lat, 2), round(lon, 2)))
        if need:
            uniq = list({k: (k, la, lo) for k, la, lo in need}.values())
            params = {"latitude": ",".join(str(x[1]) for x in uniq), "longitude": ",".join(str(x[2]) for x in uniq),
                      "hourly": HOURLY, "timezone": "UTC", "timeformat": "unixtime", "forecast_days": 3,
                      "wind_speed_unit": "kmh"}
            try:
                async with self._session.get(OPEN_METEO, params=params, headers={"User-Agent": USER_AGENT},
                                             timeout=aiohttp.ClientTimeout(total=15)) as resp:
                    if resp.status >= 400:
                        raise WeatherError(f"Open-Meteo ha risposto con errore {resp.status}")
                    data = await resp.json(content_type=None)
            except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as err:
                raise WeatherError("Meteo non disponibile ora (Open-Meteo non risponde)") from err
            data = data if isinstance(data, list) else [data]
            for (key, _la, _lo), d in zip(uniq, data):
                self._cache[key] = (time.time(), d.get("hourly") or {})
        out = []
        for lat, lon, t in points:
            h = self._cache.get(f"{lat:.2f},{lon:.2f}", (0, {}))[1]
            times = h.get("time") or []
            if not times:
                out.append({"lat": lat, "lon": lon, "t": t})
                continue
            i = min(range(len(times)), key=lambda k: abs(times[k] - t))
            pick = lambda name: (h.get(name) or [None] * len(times))[i]  # noqa: E731
            out.append({"lat": lat, "lon": lon, "t": t, "temp": pick("temperature_2m"), "prec": pick("precipitation"),
                        "snow": pick("snowfall"), "code": pick("weather_code"), "gust": pick("wind_gusts_10m")})
        return out
