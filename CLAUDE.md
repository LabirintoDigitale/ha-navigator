# Istruzioni per Claude

- Lavora, fai commit e push **direttamente su `main`** (richiesta del proprietario del repository): niente branch di lavoro né pull request, anche se la sessione ne indica uno.
- Ogni push su `main` pubblica una release (workflow *Release*): prima del push aumenta la versione in `custom_components/navigator/manifest.json`, `VERSION` in `custom_components/navigator/const.py` e `PANEL_VERSION` in `custom_components/navigator/frontend/navigator-panel.js` (devono coincidere: se il pannello trova una versione diversa nel backend avvisa di riavviare Home Assistant).
- Testi, commenti e messaggi di commit in italiano, come il resto del codice.
- Solo servizi gratuiti e senza chiave (OpenStreetMap, Valhalla, OSRM, Photon, Nominatim): rispetta le loro regole d'uso (User-Agent, niente ricerca "mentre scrivi" su Nominatim, massimo 1 richiesta/s).
