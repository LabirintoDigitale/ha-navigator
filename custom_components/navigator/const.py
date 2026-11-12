"""Costanti dell'integrazione Navigator."""

DOMAIN = "navigator"
VERSION = "1.8.5"

PANEL_URL = "navigator"
PANEL_TITLE = "Navigator"
PANEL_ICON = "mdi:compass-rose"
PANEL_ELEMENT = "navigator-panel"
STATIC_URL = "/navigator_static"

DATA_STATIC_REGISTERED = f"{DOMAIN}_static_registered"
DATA_WS_REGISTERED = f"{DOMAIN}_ws_registered"

# server gratuiti predefiniti (modificabili dalle opzioni dell'integrazione)
CONF_VALHALLA_URL = "valhalla_url"
CONF_OSRM_URL = "osrm_url"
CONF_PHOTON_URL = "photon_url"
CONF_NOMINATIM_URL = "nominatim_url"

DEFAULT_VALHALLA_URL = "https://valhalla1.openstreetmap.de"
DEFAULT_OSRM_URL = "https://routing.openstreetmap.de"
DEFAULT_PHOTON_URL = "https://photon.komoot.io"
DEFAULT_NOMINATIM_URL = "https://nominatim.openstreetmap.org"

DEFAULT_OPTIONS = {
    CONF_VALHALLA_URL: DEFAULT_VALHALLA_URL,
    CONF_OSRM_URL: DEFAULT_OSRM_URL,
    CONF_PHOTON_URL: DEFAULT_PHOTON_URL,
    CONF_NOMINATIM_URL: DEFAULT_NOMINATIM_URL,
}

# i servizi OSM chiedono un User-Agent che identifichi l'applicazione
USER_AGENT = f"HomeAssistant-Navigator/{VERSION} (+https://github.com/LabirintoDigitale/ha-navigator)"

# mezzi di trasporto: valore del pannello -> costing di Valhalla, profilo OSRM
MODES = {
    "auto": ("auto", "car"),
    "moto": ("motorcycle", "car"),
    "bici": ("bicycle", "bike"),
    "piedi": ("pedestrian", "foot"),
}

# lingue delle indicazioni (Valhalla) e della voce
LANGUAGES = {"it": "it-IT", "en": "en-US", "de": "de-DE", "fr": "fr-FR", "es": "es-ES"}

MAX_POINTS = 12
MAX_EXCLUDE = 40
MAX_RECENT = 12
