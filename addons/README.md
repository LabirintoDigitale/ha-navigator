# Add-on di Navigator

Un add-on aggiunge una **finestra sulla mappa** (2D, 3D o entrambe): mostra un'immagine e fa qualcosa quando la tocchi.
Si installa dalle impostazioni del pannello: **Impostazioni → 🧩 Add-on → ➕ Aggiungi add-on (.zip)**, oppure scrivendo
l'indirizzo dello zip (lo scarica Home Assistant; nell'app Companion scegliere un file ricarica la pagina). L'esempio si
installa anche col tasto **🛰️ Installa l'esempio**.
Gli add-on sono salvati in Home Assistant e valgono per tutti i dispositivi (anche lo schermo dell'auto).
La finestra si sposta tenendola premuta, come gli altri riquadri.

Un add-on è solo una descrizione: **nessun codice viene eseguito**.

## Il file .zip

Dentro lo zip (anche in una cartella) ci vuole `addon.json`; se l'immagine è nello zip, anche il file dell'immagine
(png, jpg, gif, webp o svg; al massimo ~1 MB).

```json
{
  "id": "meteo-satellite",
  "name": "Meteo dal satellite",
  "version": "1.0",
  "author": "Io",
  "description": "Cosa fa, in una riga",
  "window": {
    "title": "🛰️ Satellite",
    "image": "https://indirizzo/immagine.jpg",
    "refresh": 900,
    "width": 240,
    "height": 170,
    "views": ["2d", "3d"],
    "click": "close"
  }
}
```

| Campo | Cosa è |
|---|---|
| `id` | nome breve senza spazi; un add-on con lo stesso `id` sostituisce quello installato (aggiornamento) |
| `name`, `version`, `author`, `description` | come compare nelle impostazioni |
| `window.title` | scritta sopra l'immagine (facoltativa) |
| `window.image` | indirizzo `https://…` dell'immagine, oppure il nome di un file dello zip (es. `"foto.png"`) |
| `window.refresh` | ogni quanti secondi ricaricare l'immagine da internet (0 = mai) |
| `window.width`, `window.height` | grandezza dell'immagine in pixel (80–800) |
| `window.views` | dove compare: `"2d"`, `"3d"` o entrambe |
| `window.click` | cosa fa il tocco (vedi sotto) |

### Cosa fa il tocco (`click`)

- `"close"`: chiude la finestra (si riapre al prossimo avvio o con *Mostra di nuovo* nelle impostazioni)
- `"refresh"`: ricarica subito l'immagine
- `"none"`: niente
- `{"open": "https://…"}`: apre un indirizzo
- `{"service": "light.toggle", "data": {"entity_id": "light.cortile"}}`: chiama un servizio di Home Assistant

## Esempio

La cartella [`meteo-satellite`](meteo-satellite) è l'add-on del meteo dal satellite (immagine Meteosat di EUMETSAT,
gratuita). Per installarlo comprimi la cartella in un .zip (oppure scarica `meteo-satellite.zip`) e caricalo dalle
impostazioni.
