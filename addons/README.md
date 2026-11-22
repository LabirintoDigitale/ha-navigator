# Add-on di Navigator: guida completa

Gli **add-on** aggiungono a Navigator delle **finestre sulla mappa** (2D e 3D): un'immagine che si aggiorna da sola
(il meteo dal satellite, una webcam, la copertina del brano che stai ascoltando…), con dei **tasti** sopra che fanno
qualcosa (cambiare immagine, chiamare un servizio di Home Assistant, aprire un elenco da cui scegliere).

Un add-on è **solo una descrizione** (il file `addon.json`): **nessun codice viene eseguito**, quindi uno zip trovato in
giro non può fare niente di nascosto. Gli add-on sono salvati in Home Assistant e valgono per **tutti i dispositivi**,
anche lo schermo dell'auto.

- [Installare un add-on](#installare-un-add-on)
- [Usare gli add-on](#usare-gli-add-on)
- [Creare un add-on](#creare-un-add-on)
  - [Il file addon.json](#il-file-addonjson)
  - [Immagini alternative (formati)](#immagini-alternative-formati)
  - [Posizione e percorso negli indirizzi](#posizione-e-percorso-negli-indirizzi)
  - [Tasti, elenchi e impostazioni](#tasti-elenchi-e-impostazioni)
  - [Cosa fa il tocco sull'immagine](#cosa-fa-il-tocco-sullimmagine)
- [Esempi](#esempi)
- [Limiti](#limiti)

---

## Installare un add-on

Da **⚙ (impostazioni) → 🧩 Add-on**:

- **➕ Aggiungi add-on (.zip)**: scegli il file. Funziona nel browser e nell'app NaviHA. Nell'**app Companion** di Home
  Assistant scegliere un file ricarica la pagina e il file si perde: lì usa uno dei due modi qui sotto.
- **Indirizzo dello zip** + **Installa**: lo zip lo scarica Home Assistant (per esempio da GitHub).
- **Tasti Esempio**: installano con un tocco gli esempi di questa cartella.

Un add-on con lo stesso `id` di uno già installato lo **aggiorna**: restano le tue scelte (acceso/spento, dove compare,
impostazioni) e la posizione della finestra.

## Usare gli add-on

- **Fuori dalla guida** ogni add-on è una finestra libera: si **sposta tenendola premuta** (la posizione resta).
- **In guida** gli add-on si attaccano alle barre e se ne vede **uno alla volta**:
  - in **verticale** in un blocco unico con la barra verde in alto e la croce a fianco;
  - in **orizzontale** a sinistra, alti quanto lo spazio fra la barra verde e il fondo della barra in basso (le scritte
    della barra in basso cominciano a destra dell'add-on);
  - sull'immagine: **⟳** in alto a sinistra cambia formato, **▲ ▼** a destra passa all'add-on successivo (anche
    strisciando su/giù), dopo l'ultimo ricomincia dal primo.
- **Tocco sul riquadro dei km/h**: elenco degli add-on che non sono sulla mappa (chiusi o spenti) per farli ricomparire.
- Nelle impostazioni, per ogni add-on: **acceso/spento**, **dove compare** (in guida e in pianificazione, solo in guida,
  solo in pianificazione), le sue **impostazioni** (es. quale lettore), **Mostra di nuovo** se l'hai chiuso, 🗑 per toglierlo.
- Un add-on che non è sulla mappa **non lavora**: niente immagini scaricate, niente aggiornamenti.

---

## Creare un add-on

1. Crea una cartella, per esempio `mio-addon`.
2. Dentro scrivi il file **`addon.json`** (vedi sotto).
3. Se usi immagini tue (png, jpg, gif, webp o svg, al massimo ~1 MB l'una), mettile nella stessa cartella.
4. Comprimi la cartella in un **.zip** e installalo (oppure pubblicalo, per esempio su GitHub, e installalo dall'indirizzo).

### Il file addon.json

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
| `window.image` | indirizzo `https://…` dell'immagine, nome di un file dello zip, oppure `entity:…` (vedi [più sotto](#tasti-elenchi-e-impostazioni)) |
| `window.images` | facoltativo: [immagini alternative](#immagini-alternative-formati), ognuna con un tasto |
| `window.refresh` | ogni quanti secondi ricaricare l'immagine da internet (`0` = mai) |
| `window.width`, `window.height` | grandezza dell'immagine in pixel (80–800) |
| `window.views` | dove compare: `"2d"`, `"3d"` o tutte e due |
| `window.click` | cosa fa il [tocco sull'immagine](#cosa-fa-il-tocco-sullimmagine) |
| `window.area_km`, `window.marker`, `window.marker_bbox`, `window.follow` | [posizione](#posizione-e-percorso-negli-indirizzi) |
| `window.buttons`, `window.caption`, `settings` | [tasti, elenchi e impostazioni](#tasti-elenchi-e-impostazioni) |

### Immagini alternative (formati)

Con `window.images` la finestra ha più immagini, per esempio i formati del satellite:

```json
"images": [
  {"label": "IR", "image": "https://…infrarosso…"},
  {"label": "Colori", "image": "https://…colori…"},
  {"label": "Pioggia", "image": "https://…pioggia…"}
]
```

Al massimo 8. Fuori dalla guida sotto l'immagine c'è un tasto per ciascuna; in guida un solo tasto **⟳** le cicla e il
nome di quella scelta compare sull'immagine. La scelta resta. Si scarica solo l'immagine che stai guardando.

### Posizione e percorso negli indirizzi

Negli indirizzi (`image`, `images`, `open`, e nei `data` dei tasti) si possono scrivere dei **segnaposto fra graffe**:
Navigator li sostituisce con i dati del momento.

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
| `{player}`… | i valori scelti nelle [impostazioni dell'add-on](#tasti-elenchi-e-impostazioni) |

- `window.area_km`: la zona è grande tanti km dal centro in su e in giù (predefinito 100), larga secondo la forma
  dell'immagine.
- Se l'indirizzo usa la posizione, l'immagine **si ricarica quando ti sposti** (circa il 15% della zona, controllo ogni
  10 secondi). Con `"follow": false` invece solo al ricaricamento (`refresh`): basta per immagini molto ampie.
- `"marker": true`: pallino rosso **"tu sei qui"** al centro dell'immagine.
- `"marker_bbox": [lat_min, lon_min, lat_max, lon_max]`: per un'immagine con area **fissa** (non centrata su di te) il
  pallino va comunque dove sei (la stessa zona del `bbox` dell'indirizzo, in EPSG:4326).

### Tasti, elenchi e impostazioni

**Tasti sopra l'immagine** (`window.buttons`, al massimo 8). Ogni tasto ha un'`icon` (e una `label`, che compare
tenendoci il dito sopra) e fa una di queste cose:

- `"service": "dominio.servizio", "data": {…}`: chiama un servizio di Home Assistant (es. `media_player.media_play`,
  `light.toggle`);
- `"list": {"browse": "media_player.x", "path": ["Playlists"]}`: apre **dentro l'add-on** l'elenco dei contenuti di un
  lettore, sfogliato come nel pannello *Media* di Home Assistant (`path` = cartelle in cui entrare, per nome). Toccando
  una voce parte su quel lettore, toccando una cartella si apre, ✕ chiude.

**Icone**: per avere tasti tutti nello stesso stile (linee sottili, bianche) scrivi in `icon` uno di questi nomi:
`play`, `pause`, `playpause`, `stop`, `next`, `prev`, `playlist`, `volup`, `voldown`, `mute`, `power`, `light`,
`refresh`, `shuffle`, `repeat` (valgono anche le emoji corrispondenti, es. `▶`, `⏹`, `⏭`, `📃`). Altrimenti compare il
testo o l'emoji scritta. I tasti con un elenco (`list`) stanno in alto a sinistra, gli altri in basso, allineati.

**Impostazioni scelte da chi usa l'add-on** (`settings`, al massimo 6), in ⚙ → 🧩 Add-on:

```json
"settings": [
  {"key": "player", "label": "Lettore", "type": "entity", "domain": "media_player"}
]
```

`"type": "entity"` mostra l'elenco delle entità (di quel `domain`), `"type": "text"` un campo da scrivere. Il valore
scelto si usa ovunque come `{player}`: nei `data` dei tasti, nel `browse`, negli indirizzi. Le scelte restano anche
reinstallando l'add-on.

**Immagine da un'entità**: `"image": "entity:{player}"` mostra la **copertina** di quello che il lettore sta suonando
(si aggiorna da sola); con `"caption": "media"` sopra compaiono **titolo e artista**.

Esempio di tasti per la musica:

```json
"buttons": [
  {"icon": "play", "label": "Play", "service": "media_player.media_play", "data": {"entity_id": "{player}"}},
  {"icon": "next", "label": "Brano successivo", "service": "media_player.media_next_track", "data": {"entity_id": "{player}"}},
  {"icon": "playlist", "label": "Playlist", "list": {"browse": "{player}", "path": ["Playlists"]}}
]
```

### Cosa fa il tocco sull'immagine

`window.click`:

| Valore | Effetto |
|---|---|
| `"close"` | chiude la finestra (torna al prossimo avvio, con *Mostra di nuovo* o dal tocco sui km/h) |
| `"refresh"` | ricarica subito l'immagine |
| `"none"` | niente (utile con i tasti, per non chiuderla per sbaglio) |
| `{"open": "https://…"}` | apre un indirizzo (anche con i segnaposto) |
| `{"service": "light.toggle", "data": {"entity_id": "light.cortile"}}` | chiama un servizio di Home Assistant |

---

## Esempi

| Add-on | Cosa fa | Zip |
|---|---|---|
| [`meteo-satellite`](meteo-satellite) | nuvole dal satellite Meteosat (EUMETSAT, gratuito) su tutta l'Europa, col pallino dove sei; IR, colori, visibile, vapore, masse d'aria, pioggia | [meteo-satellite.zip](meteo-satellite.zip) |
| [`satellite-zona`](satellite-zona) | il satellite per 150 km intorno a te, con regioni e città, ti segue mentre guidi | [satellite-zona.zip](satellite-zona.zip) |
| [`music-assistant`](music-assistant) | musica da Music Assistant: copertina, titolo, ▶ ⏹ ⏭ e l'elenco delle playlist, sul lettore scelto | [music-assistant.zip](music-assistant.zip) |

Le immagini del satellite vengono dal servizio gratuito EUMETView di EUMETSAT (WMS). Per avere i nomi di città e stati
più grandi l'immagine si chiede a 640×453 pixel con `format_options=dpi:190`: con immagini più piccole il servizio toglie
i nomi.

## Limiti

- Al massimo 20 add-on installati; immagini nello zip al massimo ~1 MB l'una e ~2 MB in tutto; zip al massimo 6 MB.
- Gli indirizzi devono iniziare con `http://` o `https://`; i servizi si scrivono `dominio.servizio`.
- Gli add-on non possono eseguire codice né leggere altro di Home Assistant oltre a quello descritto qui (segnaposto,
  entità scelte, elenchi dei lettori).
