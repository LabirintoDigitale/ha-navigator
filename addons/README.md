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
| `window.images` | facoltativo: immagini alternative, ognuna con un tasto nella finestra per passarci: `[{"label": "IR", "image": "https://…"}, {"label": "Colori", "image": "https://…"}]` (al massimo 8; la scelta resta) |
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

## Posizione e percorso negli indirizzi

Negli indirizzi (`image`, `images`, `open`) si possono scrivere dei **segnaposto fra graffe**: Navigator li sostituisce
con i dati del momento e, se l'indirizzo usa la posizione, **ricarica l'immagine quando ti sposti** (circa il 15% della
zona, controllo ogni 10 secondi). L'add-on non riceve altro: nessun codice, solo questi valori.

| Segnaposto | Valore |
|---|---|
| `{lat}`, `{lon}` | la tua posizione (in guida il GPS, altrimenti il centro della mappa) |
| `{bbox}` | zona intorno a te come `lat_min,lon_min,lat_max,lon_max` (l'ordine dei servizi WMS 1.3.0) |
| `{bbox_xy}` | la stessa zona come `lon_min,lat_min,lon_max,lat_max` |
| `{lat_min}`, `{lat_max}`, `{lon_min}`, `{lon_max}` | i bordi della zona |
| `{zoom}` | zoom della mappa |
| `{speed}`, `{heading}` | velocità (km/h) e direzione di marcia (gradi), in guida |
| `{dest_lat}`, `{dest_lon}`, `{dest_name}` | l'arrivo del percorso |
| `{left_km}`, `{left_min}` | quanto manca all'arrivo, in guida |

La zona è grande `window.area_km` km dal centro in su e in giù (predefinito 100), larga secondo la forma dell'immagine;
con `"marker": true` al centro dell'immagine compare un pallino rosso (*tu sei qui*).
Con `"follow": false` la posizione si aggiorna solo quando l'immagine si ricarica (`refresh`), non mentre ti sposti:
basta per immagini molto ampie.
Su un'immagine con area **fissa** (non centrata su di te) il pallino va comunque dove sei se l'add-on dice quale zona
copre: `"marker_bbox": [lat_min, lon_min, lat_max, lon_max]` (la stessa del `bbox` dell'indirizzo, in EPSG:4326).
L'esempio [`satellite-zona`](satellite-zona) mostra il satellite solo intorno a te:
`"image": "https://view.eumetsat.int/geoserver/ows?…&bbox={bbox}&width=480&height=340"`.

## Esempio

La cartella [`meteo-satellite`](meteo-satellite) è l'add-on del meteo dal satellite (immagine Meteosat a infrarossi di EUMETSAT,
gratuita, dal servizio EUMETView). Per installarlo comprimi la cartella in un .zip (oppure scarica `meteo-satellite.zip`) e caricalo dalle
impostazioni.
