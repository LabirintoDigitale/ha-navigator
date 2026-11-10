"""Configurazione guidata: nessun dato richiesto; nelle opzioni si possono cambiare i server."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback

from .const import (
    CONF_NOMINATIM_URL,
    CONF_OSRM_URL,
    CONF_PHOTON_URL,
    CONF_VALHALLA_URL,
    DEFAULT_OPTIONS,
    DOMAIN,
)


def _clean(user_input: dict[str, Any]) -> tuple[dict[str, str], dict[str, str]]:
    errors: dict[str, str] = {}
    out: dict[str, str] = {}
    for key in DEFAULT_OPTIONS:
        val = str(user_input.get(key) or DEFAULT_OPTIONS[key]).strip().rstrip("/")
        if not val.startswith(("http://", "https://")):
            errors[key] = "invalid_url"
        out[key] = val
    return out, errors


def _schema(values: dict[str, Any]) -> vol.Schema:
    return vol.Schema({vol.Required(k, default=values.get(k, d)): str for k, d in DEFAULT_OPTIONS.items()})


class NavigatorConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        if user_input is not None:
            return self.async_create_entry(title="Navigator", data={}, options=dict(DEFAULT_OPTIONS))
        return self.async_show_form(step_id="user", data_schema=vol.Schema({}))

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return NavigatorOptionsFlow()


class NavigatorOptionsFlow(OptionsFlow):
    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            values, errors = _clean(user_input)
            if not errors:
                return self.async_create_entry(data=values)
        values = {**DEFAULT_OPTIONS, **self.config_entry.options, **(user_input or {})}
        return self.async_show_form(step_id="init", data_schema=_schema(values), errors=errors)
