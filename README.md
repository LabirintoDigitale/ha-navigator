<p align="center"><img src="docs/images/logo.png" alt="Navigator: rosa dei venti con il quadrante di 0 e 1" width="220"></p>

# Navigator per Home Assistant

**Mappe, ricerca di destinazioni e itinerari nella barra laterale di Home Assistant**, con servizi online **gratuiti e senza chiave** basati su OpenStreetMap.

Cerca un indirizzo o un'attività, imposta partenza, tappe e destinazione e calcola il percorso in auto, moto, bici o a piedi. Se il percorso usa **tratte a pagamento** Navigator te le mostra sulla mappa e puoi **toglierle tutte** con un clic oppure **solo quelle che non vuoi pagare**, e il percorso viene ricalcolato.

![Percorso con alternative e tratte a pagamento](docs/images/screenshots/percorso.jpg)

## Funzioni

- **Pannello "Navigator" nella barra laterale**, a tutta pagina, anche da telefono (app Companion).
- **Ricerca** di indirizzi, città, attività e punti d'interesse con suggerimenti mentre scrivi.
- **Itinerario** con partenza, destinazione e fino a 10 tappe intermedie: riordina, inverti, trascina i segnaposto sulla mappa.
- Punti rapidi: **Casa** (posizione di Home Assistant), **la mia posizione** (GPS del dispositivo), zone e persone di Home Assistant, **preferiti** e **destinazioni recenti**.
- Clic sulla mappa: *Parti da qui*, *Aggiungi tappa*, *Arriva qui*, *Salva nei preferiti*.
- Mezzo: **auto, moto, bici, a piedi**. Opzioni: evita pedaggi, autostrade, traghetti.
- Fino a **3 percorsi alternativi** con durata, distanza, orario di arrivo stimato e chilometri a pagamento.
- **Pedaggi**:
  - le tratte a pagamento sono evidenziate in arancione sulla mappa ed elencate con nome (A4, A21…) e lunghezza;
  - **Ricalcola senza pedaggi**: Navigator evita le strade a pagamento e, se il server ne usa ancora qualcuna, la esclude e ricalcola finché il percorso è gratuito;
  - **Togli** una singola tratta: il percorso viene ricalcolato senza quella tratta (segnata con ✕ sulla mappa); le tratte tolte si possono ripristinare.
- **Indicazioni passo passo** in italiano: clic su un passo per vederlo sulla mappa.
- **Navigazione** con la tua posizione: la mappa ti segue, in alto vedi la prossima manovra e la distanza, in basso tempo e km rimanenti e l'orario di arrivo. Se esci dal percorso per qualche secondo compare il popup **"Ricalcolo del percorso…"** e Navigator rifà la strada da dove sei (con le stesse opzioni: pedaggi, tratte tolte, tappe ancora da raggiungere).
- Apri il percorso in **Google Maps**, **Waze** o **OpenStreetMap**, oppure copia il riepilogo.
- Mappe gratuite senza chiave: stradale, topografica, scura e satellite (Esri), escursionistica (OpenTopoMap).
- Servizio **`navigator.plan_route`** per le automazioni (tempo di viaggio, distanza, pedaggi).

| Togli una tratta a pagamento | Ricalcola senza pedaggi |
| --- | --- |
| ![Tratta tolta](docs/images/screenshots/tratta-tolta.jpg) | ![Senza pedaggi](docs/images/screenshots/senza-pedaggi.jpg) |

## Installazione

### HACS (repository personalizzato)

[![Apri in HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=LabirintoDigitale&repository=ha-navigator&category=integration)

1. HACS → ⋮ → **Repository personalizzati** → aggiungi `https://github.com/LabirintoDigitale/ha-navigator` come **Integrazione**
2. Installa **Navigator** e **riavvia Home Assistant**
3. Impostazioni → Dispositivi e servizi → **Aggiungi integrazione** → **Navigator**

Nella barra laterale compare **Navigator** con l'icona della rosa dei venti.

### Manuale

Copia la cartella `custom_components/navigator` nella cartella `config/custom_components/` di Home Assistant, riavvia e aggiungi l'integrazione.

## Servizi usati

Tutte le richieste partono da Home Assistant (nessuna chiave, nessun account):

| A cosa serve | Servizio | Note |
| --- | --- | --- |
| Percorsi | [Valhalla](https://github.com/valhalla/valhalla) su `valhalla1.openstreetmap.de` (FOSSGIS) | istruzioni in italiano, pedaggi, alternative |
| Percorsi (riserva) | [OSRM](https://project-osrm.org/) su `routing.openstreetmap.de` (FOSSGIS) | usato solo se Valhalla non risponde; senza opzioni "evita" |
| Ricerca | [Photon](https://photon.komoot.io) (komoot) | suggerimenti mentre scrivi |
| Ricerca e indirizzi (riserva) | [Nominatim](https://nominatim.org) di OpenStreetMap | max 1 richiesta al secondo |
| Mappe | Esri (stradale, topografica, scura, satellite), OpenTopoMap | caricate dal browser; i server di OpenStreetMap bloccano le richieste da un Home Assistant in rete locale |

Sono servizi gratuiti offerti dalla comunità con limiti d'uso "ragionevole": Navigator è pensato per l'uso personale.
Nelle **opzioni dell'integrazione** puoi indicare i tuoi server Valhalla, OSRM, Photon o Nominatim.

## Servizio `navigator.plan_route`

Restituisce durata e distanza di un percorso, utile nelle automazioni (es. "quanto ci metto per andare al lavoro?").
`origin`, `destination` e `via` accettano un indirizzo, coordinate `lat,lon` o un'entità (`zone.home`, `person.mario`, `device_tracker.telefono`).

```yaml
action: navigator.plan_route
data:
  origin: person.mario
  destination: "Piazza Castello, Torino"
  mode: auto
  avoid_tolls: true
response_variable: percorso
```

Risposta: `duration_min`, `distance_km`, `has_toll`, `toll_km`, `has_highway`, `has_ferry`, `instructions`, `warnings`.

## Navigazione e posizione

Dopo aver calcolato un percorso, nella sezione **Navigazione** scegli da dove prendere la posizione e premi **Avvia navigazione**:

- **GPS di questo dispositivo**: il più preciso, ma il browser lo concede solo se Home Assistant è aperto in **HTTPS**.
- **Una persona o un dispositivo di Home Assistant** (`person.…`, `device_tracker.…`): la posizione inviata dall'**app Companion**, funziona anche in http.
  Per aggiornamenti ogni pochi secondi attiva nell'app *Impostazioni → App Companion → Gestisci sensori → Posizione in background → Modalità alta precisione*.

Durante la navigazione l'icona sulla mappa passa fra due modalità (con un percorso calcolato, la stessa icona avvia la guida):

- **🧭 Guida**: mappa a tutto schermo che **ruota con la direzione di marcia** (avanti è sempre in alto, la destra è la destra del veicolo), con la tua posizione nel terzo basso per vedere la strada davanti. Puoi trascinare la mappa col mouse o con un dito e ingrandire con due dita (o con **+**, **−** e la rotellina): la mappa smette di seguirti finché non premi **◎ Ricentra**.
- **🗺 Mappa**: vista normale con il pannello, nord in alto e mappa libera da spostare; la navigazione e il ricalcolo continuano.

Navigator considera "fuori percorso" una posizione a più di 45 m dalla strada (30 m a piedi o in bici, più l'imprecisione del GPS).
Se resti fuori per almeno 6 secondi (e almeno due posizioni) ricalcola il percorso dalla posizione attuale; trascinando la mappa smette di seguirti finché non premi **Ricentra**.

## Note

- *La mia posizione* usa il GPS del dispositivo: il browser la concede solo se Home Assistant è aperto in **HTTPS** (o dall'app Companion).
- Valhalla tratta "evita pedaggi" come una preferenza forte: se l'unica strada possibile è a pagamento, Navigator lo segnala.
- Le app esterne (Google Maps, Waze) ricalcolano il percorso per conto loro: le tratte tolte in Navigator non vengono trasmesse.

## Crediti

Dati cartografici © [OpenStreetMap](https://www.openstreetmap.org/copyright) e collaboratori (ODbL).
Mappa interattiva: [Leaflet](https://leafletjs.com) (BSD-2-Clause), incluso in `frontend/leaflet`.

## Licenza

MIT
