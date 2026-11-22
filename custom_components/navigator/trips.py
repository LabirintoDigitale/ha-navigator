"""Diario dei viaggi (database SQLite) e garage (veicoli) di ogni utente.

I viaggi stanno in un database SQLite nella cartella di configurazione di Home Assistant (`navigator_trips.db`):
una riga per viaggio e una riga per ogni punto della traccia. Così l'archivio può crescere per anni senza
riscrivere ogni volta un unico file JSON, e senza limite al numero di viaggi. Garage e veicolo scelto, piccoli,
restano nello storage di Home Assistant. Alla prima partenza i viaggi del vecchio file JSON vengono copiati nel
database e tolti dal file.

Le operazioni sul database girano fuori dal ciclo di Home Assistant (executor), una alla volta.
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import DOMAIN

MAX_TRACK = 5000  # punti di una traccia restituiti alla mappa (quelli salvati sono tutti)
MIN_KM = 0.2  # tragitti più corti (200 m) non vanno in archivio
STALE_S = 30 * 60  # un viaggio "in corso" senza notizie da 30 minuti è interrotto (app chiusa senza Esci)
DB_FILE = "navigator_trips.db"
# campi con una colonna propria; tutti gli altri (da, a, mezzo, veicolo, statistiche) stanno in "info" (JSON)
COLS = ("id", "start", "end", "status", "updated")

SCHEMA = """
CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    start REAL,
    "end" REAL,
    status TEXT,
    updated REAL,
    info TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS trips_user ON trips (user_id, start DESC);
CREATE TABLE IF NOT EXISTS points (
    trip_id TEXT NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    PRIMARY KEY (trip_id, seq)
) WITHOUT ROWID;
"""


def _thin(track: list, n: int) -> list:
    """Al massimo n punti distribuiti su tutto il viaggio (l'ultimo sempre)."""
    if len(track) <= n:
        return track
    step = len(track) / n
    return [track[int(i * step)] for i in range(n)] + [track[-1]]


class TripDb:
    """Accesso sincrono al database (da chiamare nell'executor)."""

    def __init__(self, path: Path) -> None:
        self._lock = threading.Lock()
        self._con = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._con.execute("PRAGMA journal_mode=WAL")
        self._con.execute("PRAGMA foreign_keys=ON")
        self._con.executescript(SCHEMA)

    def close(self) -> None:
        with self._lock:
            self._con.close()

    @staticmethod
    def _row(r: tuple) -> dict:
        item = json.loads(r[5] or "{}")
        item.update(id=r[0], start=r[1], end=r[2], status=r[3], updated=r[4])
        if item.get("updated") is None:
            item.pop("updated")
        return item

    def _put(self, user_id: str, item: dict) -> None:
        info = {k: v for k, v in item.items() if k not in COLS and k != "track"}
        self._con.execute(
            # aggiornamento sul posto (non REPLACE: cancellerebbe la riga e, a cascata, i punti della traccia)
            'INSERT INTO trips (id, user_id, start, "end", status, updated, info) VALUES (?,?,?,?,?,?,?) '
            'ON CONFLICT (id) DO UPDATE SET start = excluded.start, "end" = excluded."end", status = excluded.status, '
            'updated = excluded.updated, info = excluded.info',
            (item["id"], user_id, item.get("start"), item.get("end"), item.get("status"), item.get("updated"),
             json.dumps(info, ensure_ascii=False)))

    def _add_points(self, trip_id: str, points: list) -> None:
        cur = self._con.execute("SELECT COALESCE(MAX(seq), -1) FROM points WHERE trip_id = ?", (trip_id,))
        base = cur.fetchone()[0] + 1
        self._con.executemany("INSERT INTO points (trip_id, seq, lat, lon) VALUES (?,?,?,?)",
                              [(trip_id, base + i, float(p[0]), float(p[1])) for i, p in enumerate(points)])

    def insert(self, user_id: str, item: dict, track: list) -> None:
        with self._lock:
            self._con.execute("BEGIN")
            try:
                self._put(user_id, item)
                self._con.execute("DELETE FROM points WHERE trip_id = ?", (item["id"],))
                self._add_points(item["id"], track)
                self._con.execute("COMMIT")
            except Exception:
                self._con.execute("ROLLBACK")
                raise

    def import_many(self, users: dict[str, list[dict]]) -> int:
        """Copia i viaggi del vecchio file JSON (una transazione sola). Restituisce quanti."""
        n = 0
        with self._lock:
            self._con.execute("BEGIN")
            try:
                for user_id, trips in users.items():
                    for t in trips:
                        if not t.get("id"):
                            continue
                        self._put(user_id, t)
                        self._con.execute("DELETE FROM points WHERE trip_id = ?", (t["id"],))
                        self._add_points(t["id"], [p for p in (t.get("track") or []) if len(p) >= 2])
                        n += 1
                self._con.execute("COMMIT")
            except Exception:
                self._con.execute("ROLLBACK")
                raise
        return n

    def close_open(self, user_id: str) -> None:
        with self._lock:
            # rimasti aperti (app chiusa senza Esci): troppo corti si tolgono, gli altri risultano interrotti
            self._con.execute("DELETE FROM trips WHERE user_id = ? AND status = 'in_corso' "
                              "AND COALESCE(json_extract(info, '$.km'), 0) < ?", (user_id, MIN_KM))
            self._con.execute("UPDATE trips SET status = 'interrotto' WHERE user_id = ? AND status = 'in_corso'", (user_id,))

    def purge_short(self) -> int:
        """Toglie dall'archivio i viaggi chiusi più corti di MIN_KM (anche quelli salvati prima di questa regola)."""
        with self._lock:
            cur = self._con.execute("DELETE FROM trips WHERE status != 'in_corso' "
                                    "AND COALESCE(json_extract(info, '$.km'), 0) < ?", (MIN_KM,))
            return cur.rowcount

    def get(self, user_id: str, trip_id: str, with_track: bool = True, last: int | None = None) -> dict | None:
        with self._lock:
            r = self._con.execute('SELECT id, start, "end", status, updated, info FROM trips WHERE id = ? AND user_id = ?',
                                  (trip_id, user_id)).fetchone()
            if r is None:
                return None
            item = self._row(r)
            if with_track:
                if last:
                    rows = self._con.execute("SELECT lat, lon FROM points WHERE trip_id = ? ORDER BY seq DESC LIMIT ?",
                                             (trip_id, last)).fetchall()[::-1]
                else:
                    rows = self._con.execute("SELECT lat, lon FROM points WHERE trip_id = ? ORDER BY seq",
                                             (trip_id,)).fetchall()
                item["track"] = [[a, b] for a, b in rows]
        return item

    def count_points(self, trip_id: str) -> int:
        with self._lock:
            return self._con.execute("SELECT COUNT(*) FROM points WHERE trip_id = ?", (trip_id,)).fetchone()[0]

    def append(self, user_id: str, trip_id: str, points: list, stats: dict[str, Any]) -> bool:
        with self._lock:
            r = self._con.execute('SELECT id, start, "end", status, updated, info FROM trips WHERE id = ? AND user_id = ?',
                                  (trip_id, user_id)).fetchone()
            if r is None:
                return False
            item = self._row(r)
            for k in ("km", "duration", "avg", "max", "end", "to"):
                if stats.get(k) is not None:
                    item[k] = stats[k]
            item["updated"] = time.time()
            if item.get("status") != "concluso":
                item["status"] = "in_corso"
            self._con.execute("BEGIN")
            try:
                self._put(user_id, item)
                if points:
                    self._add_points(trip_id, points)
                self._con.execute("COMMIT")
            except Exception:
                self._con.execute("ROLLBACK")
                raise
        return True

    def set_info(self, trip_id: str, extra: dict) -> None:
        """Aggiunge campi (es. dislivello) alle informazioni del viaggio."""
        with self._lock:
            r = self._con.execute("SELECT info FROM trips WHERE id = ?", (trip_id,)).fetchone()
            if r is None:
                return
            info = {**json.loads(r[0] or "{}"), **extra}
            self._con.execute("UPDATE trips SET info = ? WHERE id = ?", (json.dumps(info, ensure_ascii=False), trip_id))

    def set_status(self, trip_id: str, status: str) -> None:
        with self._lock:
            self._con.execute("UPDATE trips SET status = ? WHERE id = ?", (status, trip_id))

    def summaries(self, user_id: str) -> list[dict]:
        with self._lock:
            # con il punto d'arrivo (ultimo della traccia): serve a proporre le mete già fatte come destinazione
            rows = self._con.execute(
                'SELECT id, start, "end", status, updated, info, '
                '(SELECT lat FROM points p WHERE p.trip_id = t.id ORDER BY seq DESC LIMIT 1), '
                '(SELECT lon FROM points p WHERE p.trip_id = t.id ORDER BY seq DESC LIMIT 1) '
                'FROM trips t WHERE user_id = ? ORDER BY start DESC', (user_id,)).fetchall()
        out = []
        for r in rows:
            item = self._row(r[:6])
            if r[6] is not None and r[7] is not None:
                item["dest"] = [r[6], r[7]]
            out.append(item)
        return out

    def delete(self, user_id: str, trip_id: str) -> None:
        with self._lock:
            self._con.execute("DELETE FROM trips WHERE id = ? AND user_id = ?", (trip_id, user_id))


# ---------------------------------------------------------------- add-on
# Un add-on è una descrizione (niente codice da eseguire): una finestra sulla mappa che mostra un'immagine (da internet,
# aggiornata ogni tanto, o contenuta nello zip) e cosa fa al tocco. Si carica come file .zip dalle impostazioni del
# pannello; qui si controlla ogni campo e si salva in un archivio a parte (le immagini possono pesare).
ADDON_MAX = 20
ADDON_FILE_MAX = 1_500_000  # caratteri del data URL di un'immagine (~1,1 MB)
ADDON_TOTAL_MAX = 3_000_000
_ADDON_ID = re.compile(r"[^a-z0-9_-]+")
_DATA_IMG = re.compile(r"^data:image/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$")
_URL = re.compile(r"^https?://[^\s\"'<>]+$")
_SERVICE = re.compile(r"^[a-z0-9_]+\.[a-z0-9_]+$")


def _addon_click(c: Any) -> Any:
    """Cosa fa il tocco sulla finestra: "close" (si chiude), "refresh" (ricarica l'immagine), {"open": url} (apre un
    indirizzo), {"service": "dominio.servizio", "data": {...}} (servizio di Home Assistant, es. accendere una luce)."""
    if c in ("close", "refresh", "none"):
        return c
    if isinstance(c, dict):
        if isinstance(c.get("open"), str) and _URL.match(c["open"]) and len(c["open"]) <= 500:
            return {"open": c["open"]}
        if isinstance(c.get("service"), str) and _SERVICE.match(c["service"]):
            data = c.get("data") if isinstance(c.get("data"), dict) else {}
            if len(json.dumps(data)) <= 2000:
                return {"service": c["service"], "data": data}
    return "close"


def clean_addon(a: dict) -> dict:
    if not isinstance(a, dict):
        raise ValueError("add-on non valido")
    aid = _ADDON_ID.sub("-", str(a.get("id") or a.get("name") or "").lower()).strip("-")[:40]
    if not aid:
        raise ValueError("all'add-on manca il nome (campo \"id\" o \"name\" in addon.json)")
    files = {}
    total = 0
    w0 = a.get("window") if isinstance(a.get("window"), dict) else {}
    for name, data in list((a.get("files") or {}).items())[:20]:
        if isinstance(data, str) and len(data) <= ADDON_FILE_MAX and _DATA_IMG.match(data):
            files[str(name)[:80]] = data
            total += len(data)
    if total > ADDON_TOTAL_MAX:
        raise ValueError("le immagini dell'add-on sono troppo grandi (al massimo ~2 MB in tutto)")
    w = w0
    # immagini alternative (es. infrarosso, colori, vapore): tasti nella finestra per passare dall'una all'altra
    images = []
    for it in (w.get("images") or [])[:8] if isinstance(w.get("images"), list) else []:
        if isinstance(it, dict):
            u = str(it.get("image") or "")[:500]
            if _URL.match(u) or u in files:
                images.append({"label": str(it.get("label") or "")[:14] or str(len(images) + 1), "image": u})
    img = str(w.get("image") or (images[0]["image"] if images else ""))[:500]
    if not (_URL.match(img) or img in files):
        raise ValueError("la finestra dell'add-on non ha un'immagine valida (indirizzo http/https o file dello zip)")
    views = [v for v in (w.get("views") or ["2d", "3d"]) if v in ("2d", "3d")] or ["2d", "3d"]

    def num(v, lo, hi, d):
        try:
            return int(min(hi, max(lo, float(v))))
        except (TypeError, ValueError):
            return d

    return {
        "id": aid,
        "name": str(a.get("name") or aid)[:60],
        "version": str(a.get("version") or "")[:20],
        "description": str(a.get("description") or "")[:300],
        "author": str(a.get("author") or "")[:60],
        "enabled": a.get("enabled") is not False,
        "window": {
            "title": str(w.get("title") or "")[:60],
            "image": img,
            "refresh": num(w.get("refresh"), 0, 86400, 0),
            # zona intorno a te per i segnaposto {bbox}… degli indirizzi: metà altezza in km (0 = 100 km)
            "area_km": num(w.get("area_km"), 0, 2000, 0),
            "marker": w.get("marker") is True,  # pallino al centro dell'immagine: "tu sei qui" (con {bbox})
            # con la posizione negli indirizzi: false = si aggiorna solo al ricaricamento (refresh), non quando ti sposti
            "follow": w.get("follow") is not False,
            "width": num(w.get("width"), 80, 800, 240),
            "height": num(w.get("height"), 60, 800, 160),
            "views": views,
            "click": _addon_click(w.get("click", "close")),
            "images": images,
        },
        "files": files,
    }


def addon_from_zip(raw: bytes) -> dict:
    """Add-on da un file .zip (scaricato da un indirizzo): addon.json, anche dentro una cartella, più l'immagine che usa."""
    import base64
    import io
    import zipfile

    try:
        z = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as err:
        raise ValueError("non è un file .zip valido") from err
    names = [n for n in z.namelist() if not n.endswith("/") and not n.startswith("__MACOSX/")][:200]
    key = next((n for n in names if n == "addon.json" or n.endswith("/addon.json")), None)
    if not key:
        raise ValueError("nello zip manca addon.json")
    base = key[: -len("addon.json")]
    try:
        a = json.loads(z.read(key)[:200_000].decode("utf-8-sig"))
    except (ValueError, UnicodeDecodeError) as err:
        raise ValueError(f"addon.json non è valido ({err})") from err
    if not isinstance(a, dict):
        raise ValueError("addon.json non è valido")
    win = a.get("window") if isinstance(a.get("window"), dict) else {}
    wanted = [str(win.get("image") or "")] + [str(i.get("image") or "") for i in (win.get("images") or []) if isinstance(i, dict)]
    a["files"] = {}
    for img in dict.fromkeys(w for w in wanted if w):
        if img.startswith(("http://", "https://")):
            continue
        mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
                "svg": "image/svg+xml"}.get(img.rsplit(".", 1)[-1].lower())
        if not mime or base + img not in names:
            raise ValueError(f"l'immagine \"{img}\" non è nello zip")
        info = z.getinfo(base + img)
        if info.file_size > ADDON_FILE_MAX * 3 // 4:
            raise ValueError(f"l'immagine \"{img}\" è troppo grande")
        a["files"][img] = f"data:{mime};base64,{base64.b64encode(z.read(info)).decode()}"
    return a


class Trips:
    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._store: Store[dict] = Store(hass, 1, f"{DOMAIN}.trips")
        self._db: TripDb | None = None
        self.garage: list[dict] = []  # garage condiviso: gli stessi veicoli per tutti gli utenti di Home Assistant
        self.selected: dict[str, str] = {}  # utente -> veicolo scelto l'ultima volta ("base" o id del garage)
        self.layouts: dict[str, dict] = {}
        self._addon_store: Store[dict] = Store(hass, 1, f"{DOMAIN}.addons")
        self.addons: list[dict] = []

    async def _run(self, fn, *args):
        return await self._hass.async_add_executor_job(fn, *args)

    async def async_load(self) -> None:
        self._db = await self._run(TripDb, Path(self._hass.config.path(DB_FILE)))
        stored = await self._store.async_load() or {}
        garage = stored.get("garage", [])
        if isinstance(garage, dict):
            # versioni fino alla 1.9.14: un garage per utente. Si uniscono in quello condiviso (stessa targa o stesso
            # nome senza targa = stesso veicolo, tenuto una volta sola)
            merged: list[dict] = []
            seen: set[str] = set()
            for vehicles in garage.values():
                for v in vehicles:
                    key = f"p:{v['plate']}" if v.get("plate") else f"n:{(v.get('name') or '').lower()}|{v.get('type')}"
                    if key in seen or any(m["id"] == v.get("id") for m in merged):
                        continue
                    seen.add(key)
                    merged.append(v)
            garage = merged
        self.garage = garage
        self.selected = stored.get("selected", {})
        self.layouts = stored.get("layouts", {})  # posizioni dei riquadri della guida (es. "auto": schermo di Android Auto)
        self.addons = ((await self._addon_store.async_load()) or {}).get("addons", [])
        # versioni fino alla 1.9.84: viaggi nel file JSON. Si copiano nel database e poi si tolgono dal file
        users = stored.get("users")
        if users:
            await self._run(self._db.import_many, users)
            await self._store.async_save({"garage": self.garage, "selected": self.selected, "layouts": self.layouts})
        await self._run(self._db.purge_short)

    async def async_close(self) -> None:
        if self._db is not None:
            db, self._db = self._db, None
            await self._run(db.close)

    def _save(self) -> None:
        self._store.async_delay_save(lambda: {"garage": self.garage, "selected": self.selected, "layouts": self.layouts}, 5)

    async def addon_change(self, add: dict | None = None, remove: str | None = None, enable: str | None = None,
                           on: bool = True) -> list[dict]:
        """Aggiunge (o aggiorna, stesso id) un add-on, lo toglie, oppure lo attiva/disattiva."""
        addons = list(self.addons)
        if add is not None:
            c = clean_addon(add)
            addons = [x for x in addons if x["id"] != c["id"]]
            if len(addons) >= ADDON_MAX:
                raise ValueError(f"al massimo {ADDON_MAX} add-on: togline qualcuno")
            addons.append(c)
        if remove:
            addons = [x for x in addons if x["id"] != remove]
        if enable:
            addons = [{**x, "enabled": bool(on)} if x["id"] == enable else x for x in addons]
        self.addons = addons
        await self._addon_store.async_save({"addons": addons})
        return addons

    def set_layout(self, profile: str, data: dict) -> dict:
        """Posizioni dei riquadri spostati a mano (frazioni 0..1 della mappa) per un profilo (es. "auto")."""
        clean = {}
        for name, pos in list((data or {}).items())[:40]:  # barra, croce, velocità e i tasti all'arrivo
            if not isinstance(pos, dict):
                continue
            item = {k: round(min(1.0, max(0.0, float(pos[k]))), 4) for k in ("x", "y") if isinstance(pos.get(k), (int, float))}
            if item:
                clean[str(name)[:80]] = item
        self.layouts[str(profile)[:40]] = clean
        self._save()
        return clean

    def vehicles(self, user_id: str) -> list[dict]:  # noqa: ARG002 - garage uguale per tutti
        return self.garage

    def select(self, user_id: str, vehicle_id: str) -> None:
        """Ricorda il veicolo scelto dall'utente: alla prossima apertura del pannello (su qualsiasi dispositivo) è già quello."""
        self.selected[user_id] = str(vehicle_id or "base")[:16]
        self._save()

    def set_vehicles(self, user_id: str, vehicles: list[dict]) -> list[dict]:  # noqa: ARG002
        """Salva il garage condiviso (lo può modificare ogni utente)."""
        clean = []
        for v in vehicles[:30]:
            item = {"id": str(v.get("id") or uuid.uuid4().hex[:8])[:16], "name": str(v.get("name") or "")[:40],
                    "plate": str(v.get("plate") or "").upper()[:12], "type": str(v.get("type") or "auto")[:12]}
            # disegno sulla mappa e colore (#rrggbb), facoltativi
            if v.get("icon"):
                item["icon"] = str(v["icon"])[:16]
            if re.fullmatch(r"#[0-9a-fA-F]{6}", str(v.get("color") or "")):
                item["color"] = str(v["color"]).lower()
            if re.fullmatch(r"#[0-9a-fA-F]{6}", str(v.get("roof") or "")):
                item["roof"] = str(v["roof"]).lower()  # tetto/capote di un altro colore (utilitaria 3D)
            if v.get("sunroof") == "no":
                item["sunroof"] = "no"  # utilitaria 3D senza tettuccio in vetro
            # auto associata (dall'app NaviHA: Bluetooth dell'auto o marca/modello) e logo di avvio in auto
            if v.get("car"):
                item["car"] = str(v["car"])[:120]
                item["carName"] = str(v.get("carName") or "")[:80]
            sp = str(v.get("splash") or "")
            if sp == "veicolo" or (re.match(r"^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$", sp) and len(sp) <= 300_000):
                item["splash"] = sp
            clean.append(item)
        self.garage = clean
        self._save()
        return clean

    # ------------------------------------------------------------------ viaggi (database)

    async def add(self, user_id: str, trip: dict[str, Any]) -> dict:
        track = trip.get("track") or []
        if float(trip.get("km") or 0) < MIN_KM:  # troppo corto: non si salva
            return {**trip, "id": ""}
        item = {**{k: v for k, v in trip.items() if k != "track"}, "id": uuid.uuid4().hex[:12]}
        await self._run(self._db.insert, user_id, item, track)
        return item

    # viaggio salvato man mano: creato alla partenza, punti aggiunti durante la guida, concluso con Esci
    async def start(self, user_id: str, meta: dict[str, Any]) -> dict:
        now = time.time()
        item = {**meta, "id": uuid.uuid4().hex[:12], "km": 0, "duration": 0, "avg": 0, "max": 0,
                "start": meta.get("start") or now, "end": now, "status": "in_corso", "updated": now}
        await self._run(self._db.close_open, user_id)  # un viaggio rimasto aperto (app chiusa senza Esci) è interrotto
        await self._run(self._db.insert, user_id, item, [])
        return item

    async def append(self, user_id: str, trip_id: str, points: list, stats: dict[str, Any]) -> bool:
        return await self._run(self._db.append, user_id, trip_id, points, stats)

    async def finish(self, user_id: str, trip_id: str) -> bool:
        """Chiude il viaggio; False se era troppo corto ed è stato tolto."""
        t = await self._run(self._db.get, user_id, trip_id, False)
        if t is None:
            return False
        n = await self._run(self._db.count_points, trip_id)
        if (t.get("km") or 0) < MIN_KM or n < 2:  # troppo corto (meno di 200 m): non serve in archivio
            await self._run(self._db.delete, user_id, trip_id)
            return False
        await self._run(self._db.set_status, trip_id, "concluso")
        return True

    async def set_info(self, trip_id: str, extra: dict) -> None:
        await self._run(self._db.set_info, trip_id, extra)

    async def summaries(self, user_id: str) -> list[dict]:
        out = await self._run(self._db.summaries, user_id)
        now = time.time()
        for item in out:
            if item.get("status") == "in_corso" and now - (item.get("updated") or 0) > STALE_S:
                item["status"] = "interrotto"
        return out

    async def get(self, user_id: str, trip_id: str, last: int | None = None) -> dict | None:
        """Viaggio con la traccia (sfoltita per la mappa); con last solo gli ultimi punti (scheda Live)."""
        t = await self._run(self._db.get, user_id, trip_id, True, last)
        if t is not None and not last:
            t["track"] = _thin(t["track"], MAX_TRACK)
        return t

    async def delete(self, user_id: str, trip_id: str) -> None:
        await self._run(self._db.delete, user_id, trip_id)
