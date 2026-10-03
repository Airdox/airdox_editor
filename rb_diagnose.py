#!/usr/bin/env python3
"""
rb_diagnose.py  -  EINE Datei, EIN Befehl, kompletter Bericht.

Starten (Windows):   python rb_diagnose.py
(oder Doppelklick; das Fenster bleibt am Ende offen)

Das Skript findet Pfade selbst (aus der Rekordbox-options.json), prueft die ganze Kette

    XML-Track -> master.db-Eintrag -> AnalysisDataPath -> ANLZ-Datei (.DAT/.EXT) -> Waveform

und schreibt am Ende einen lesbaren Bericht (rb_diagnose_bericht.txt + .json) auf den
Desktop bzw. neben das Skript. Danach nur diese Datei an Claude geben.

SICHERHEIT
  * Rekordbox-Dateien auf D: werden nie veraendert. ANLZ/Optionen: nur "rb"/Lesen.
  * master.db (+ -wal/-shm) wird in einen Temp-Ordner KOPIERT, nur die Kopie wird geoeffnet.
  * Der Bericht wird nie in den Rekordbox-Ordner geschrieben.
  * Der Wert "dp" (DB-Schluessel) in der options.json wird nie ausgegeben.

OPTIONEN (alle optional, es gibt sinnvolle Standardwerte)
  --xml PFAD            Rekordbox-XML (sonst automatische Suche im Repo-Ordner)
  --db PFAD             master.db (sonst aus options.json)
  --analysis-root PFAD  Ordner "share" (sonst aus options.json)
  --ids ID [ID ...]     TrackIDs, die einzeln durchgespielt werden
  --no-install          pyrekordbox nicht automatisch installieren
  --selftest            Selbsttest mit synthetischen Daten
"""
import argparse
import json
import os
import random
import shutil
import struct
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path
from urllib.parse import unquote, urlparse

WAVE_TAGS = {"PWAV", "PWV2", "PWV3", "PWV4", "PWV5", "PWV6", "PWV7", "PWVC"}
DEFAULT_IDS = ["87868672", "142225026"]
LOG = []


# ----------------------------------------------------------------------------- Ausgabe
def say(text=""):
    print(text)
    LOG.append(text)


def status(level, text):
    tag = {"ok": "[OK]", "warn": "[!!]", "err": "[XX]", "info": "[..]"}[level]
    say(f"  {tag} {text}")


# ----------------------------------------------------------------------------- Helfer
def norm_path(p):
    return str(p).replace("\\", "/").rstrip("/").lower() if p else ""


def location_to_path(loc):
    if not loc:
        return ""
    u = urlparse(loc)
    path = unquote(u.path if u.scheme else loc)
    if len(path) > 2 and path[0] == "/" and path[2] == ":":
        path = path[1:]
    return path


def read_options(explicit=None):
    cand = Path(explicit) if explicit else (
        Path(os.environ.get("APPDATA", "")) / "Pioneer" / "rekordboxAgent" / "storage" / "options.json")
    res = {"file": str(cand), "found": cand.is_file(), "db_path": None, "analysis_root": None, "app_ver": None}
    if res["found"]:
        try:
            raw = json.loads(cand.read_text(encoding="utf-8-sig"))
            opts = {k: v for k, v in raw.get("options", []) if isinstance(k, str)}
            res.update(db_path=opts.get("db-path"), analysis_root=opts.get("analysis-data-root-path"),
                       app_ver=opts.get("app_ver"))
        except Exception as e:  # noqa: BLE001
            res["error"] = str(e)
    return res


def find_xml(explicit):
    if explicit:
        return Path(explicit) if Path(explicit).is_file() else None
    here = Path(__file__).resolve().parent
    for base in (Path.cwd(), here, here.parent):
        for depth_glob in ("*.xml", "*/*.xml", "*/*/*.xml"):
            for p in sorted(base.glob(depth_glob)):
                if any(x in p.parts for x in ("node_modules", ".git", "dist")):
                    continue
                if "rekordbox" in p.name.lower() or "export" in p.name.lower():
                    return p
    return None


def read_xml(path):
    tracks = []
    for _, el in ET.iterparse(str(path), events=("end",)):
        if el.tag == "TRACK" and el.get("TrackID"):
            tracks.append({"track_id": el.get("TrackID"), "location": location_to_path(el.get("Location")),
                           "name": el.get("Name")})
            el.clear()
    return tracks


def parse_anlz(path):
    data = Path(path).read_bytes()
    out = {"ok": False, "tags": [], "problem": None, "size": len(data)}
    if len(data) < 12 or data[:4] != b"PMAI":
        out["problem"] = "keine PMAI-Kennung"
        return out
    len_header, len_file = struct.unpack(">II", data[4:12])
    if len_file != len(data):
        out["problem"] = f"len_file {len_file} != Dateigroesse {len(data)}"
    pos = len_header
    while pos + 12 <= len(data):
        fourcc = data[pos:pos + 4].decode("ascii", "replace")
        length = struct.unpack(">I", data[pos + 8:pos + 12])[0]
        if length < 12 or pos + length > len(data):
            out["problem"] = out["problem"] or f"Sektion {fourcc}@{pos} unplausibel"
            return out
        out["tags"].append(fourcc)
        pos += length
    out["ok"] = out["problem"] is None
    return out


def anlz_candidates(analysis_root, adp):
    base = Path(analysis_root) / str(adp).replace("\\", "/").lstrip("/")
    dat = base if base.suffix.upper() == ".DAT" else base.with_suffix(".DAT")
    return {"DAT": dat, "EXT": dat.with_suffix(".EXT")}


# ----------------------------------------------------------------------------- DB (pyrekordbox)
def ensure_pyrekordbox(allow_install):
    try:
        import pyrekordbox  # noqa: F401
        return True, "pyrekordbox ist installiert"
    except ImportError:
        if not allow_install:
            return False, "pyrekordbox fehlt (Installation per --no-install abgeschaltet)"
    say("  [..] pyrekordbox fehlt -> installiere automatisch (pip install pyrekordbox) ...")
    r = subprocess.run([sys.executable, "-m", "pip", "install", "pyrekordbox"], capture_output=True, text=True)
    if r.returncode != 0:
        return False, "pip install pyrekordbox fehlgeschlagen: " + (r.stderr.strip().splitlines() or ["?"])[-1]
    try:
        import pyrekordbox  # noqa: F401
        return True, "pyrekordbox wurde installiert"
    except ImportError as e:
        return False, f"Import nach Installation fehlgeschlagen: {e}"


def load_db_rows(db_path):
    from pyrekordbox import Rekordbox6Database
    tmp = Path(tempfile.mkdtemp(prefix="rb_diag_"))
    src = Path(db_path)
    for suf in ("", "-wal", "-shm"):
        f = src.with_name(src.name + suf)
        if f.exists():
            shutil.copy2(f, tmp / f.name)
    copy = tmp / src.name
    db, last = None, None
    for attempt in range(2):
        for kwargs in ({"path": str(copy)}, {"db_dir": str(tmp)}):
            try:
                db = Rekordbox6Database(**kwargs)
                break
            except Exception as e:  # noqa: BLE001
                last = e
        if db is not None:
            break
        if attempt == 0:
            say("  [..] Datenbank liess sich nicht oeffnen -> versuche Schluessel zu laden (pyrekordbox download-key) ...")
            subprocess.run([sys.executable, "-m", "pyrekordbox", "download-key"], capture_output=True, text=True)
    if db is None:
        shutil.rmtree(tmp, ignore_errors=True)
        raise RuntimeError(str(last))
    rows = []
    for c in db.get_content():
        rows.append({"id": str(c.ID), "folder_path": getattr(c, "FolderPath", None),
                     "analysis_path": getattr(c, "AnalysisDataPath", None),
                     "uuid": getattr(c, "UUID", None), "title": getattr(c, "Title", None)})
    try:
        db.close()
    except Exception:  # noqa: BLE001
        pass
    shutil.rmtree(tmp, ignore_errors=True)
    return rows


# ----------------------------------------------------------------------------- Pruefschritte
def step_files(report, db_path, analysis_root):
    say("\n== 1) Pfade und Dateien")
    ok = True
    dbp, ar = (Path(db_path) if db_path else None), (Path(analysis_root) if analysis_root else None)
    if not dbp or not dbp.is_file():
        status("err", f"master.db nicht gefunden: {db_path}")
        ok = False
    else:
        head = dbp.open("rb").read(16)
        kind = "unverschluesseltes SQLite" if head.startswith(b"SQLite format 3\x00") else "verschluesselt (SQLCipher, normal)"
        status("ok", f"master.db: {dbp} ({dbp.stat().st_size // 1024} KB, {kind})")
        report["db_kind"] = kind
    usb = (ar / "PIONEER" / "USBANLZ") if ar else None
    if not usb or not usb.is_dir():
        status("err", f"ANLZ-Ordner nicht gefunden: {usb}")
        ok = False
    else:
        status("ok", f"ANLZ-Ordner: {usb}")
        report["usbanlz"] = str(usb)
    return ok, usb


def step_anlz_census(report, usb):
    say("\n== 2) ANLZ-Dateien (Format und Waveform-Sektionen)")
    files = [p for p in usb.rglob("*") if p.is_file() and p.suffix.upper() in (".DAT", ".EXT", ".2EX")]
    by_ext = Counter(p.suffix.upper() for p in files)
    sample = files if len(files) <= 3000 else random.Random(1).sample(files, 3000)
    wave, errors, no_wave = Counter(), Counter(), 0
    for p in sample:
        try:
            r = parse_anlz(p)
        except OSError:
            errors["nicht lesbar"] += 1
            continue
        if not r["ok"]:
            errors[r["problem"].split(" ")[0] if r["problem"] else "?"] += 1
        w = set(r["tags"]) & WAVE_TAGS
        wave.update(w)
        if p.suffix.upper() in (".DAT", ".EXT") and not w:
            no_wave += 1
    report["anlz"] = {"files": len(files), "by_ext": dict(by_ext), "sampled": len(sample),
                      "wave_tags": dict(wave), "errors": dict(errors), "no_wave": no_wave}
    status("info", f"{len(files)} Dateien {dict(by_ext)}, geprueft: {len(sample)}")
    status("ok" if wave else "err", f"Waveform-Sektionen: {dict(wave) or 'KEINE'}")
    if errors:
        status("err", f"Formatfehler: {dict(errors)}  (Endian-/Formatannahme pruefen)")
    if no_wave:
        status("warn", f"{no_wave} .DAT/.EXT ohne Waveform-Sektion")
    return bool(wave) and not errors


def step_link(report, xml_tracks, rows, analysis_root, probe_ids):
    say("\n== 3) Verbindung XML <-> master.db")
    by_id = {r["id"]: r for r in rows}
    by_path = {}
    for r in rows:
        by_path.setdefault(norm_path(r["folder_path"]), r)
    a = [t for t in xml_tracks if t["track_id"] in by_id]
    pairs = [(t, by_path.get(norm_path(t["location"]))) for t in xml_tracks]
    pairs = [(t, r) for t, r in pairs if r]
    same = sum(1 for t, r in pairs if r["id"] == t["track_id"])
    diff = len(pairs) - same
    link = {"xml": len(xml_tracks), "db": len(rows), "by_id": len(a), "by_path": len(pairs),
            "path_same_id": same, "path_diff_id": diff,
            "examples_diff": [{"xml": t["track_id"], "db": r["id"], "path": t["location"]}
                              for t, r in pairs if r["id"] != t["track_id"]][:5],
            "examples_missing": [{"xml": t["track_id"], "path": t["location"]}
                                 for t in xml_tracks if t["track_id"] not in by_id
                                 and norm_path(t["location"]) not in by_path][:5]}
    report["link"] = link
    status("info", f"XML-Tracks: {len(xml_tracks)} | Datenbank-Zeilen: {len(rows)}")
    status("info", f"A) XML-TrackID == djmdContent.ID:      {len(a)}")
    status("info", f"B) XML-Location == djmdContent.FolderPath: {len(pairs)} (davon gleiche ID: {same}, andere ID: {diff})")
    if a and diff == 0:
        key = "ID"
        status("ok", "Primaerschluessel gefunden: XML TrackID == djmdContent.ID  -> direkter Lookup moeglich")
    elif pairs and diff:
        key = "PFAD"
        status("warn", "TrackID != ID. Verbindung nur ueber Dateipfad (FolderPath) -> XML evtl. veralteter Stand")
    elif not a and not pairs:
        key = "KEINE"
        status("err", "Weder ID noch Pfad passen: XML und master.db sind nicht dieselbe Sammlung")
    else:
        key = "TEIL"
        status("warn", "Teilweise Uebereinstimmung (siehe JSON)")
    report["link_key"] = key

    say("\n== 4) Kette bis zur Waveform (Stichprobe)")
    chain = {"checked": 0, "dat_ok": 0, "ext_ok": 0, "wave": 0, "missing_file": 0, "bad": 0, "examples": []}
    cand = [r for r in rows if r["analysis_path"]]
    step = max(1, len(cand) // 300)
    for r in cand[::step][:300]:
        chain["checked"] += 1
        files = anlz_candidates(analysis_root, r["analysis_path"])
        have_wave = False
        for kind, p in files.items():
            if not p.is_file():
                if kind == "DAT":
                    chain["missing_file"] += 1
                    if len(chain["examples"]) < 5:
                        chain["examples"].append({"id": r["id"], "fehlt": str(p)})
                continue
            res = parse_anlz(p)
            if not res["ok"]:
                chain["bad"] += 1
                continue
            chain["dat_ok" if kind == "DAT" else "ext_ok"] += 1
            have_wave = have_wave or bool(set(res["tags"]) & WAVE_TAGS)
        chain["wave"] += 1 if have_wave else 0
    report["chain"] = chain
    n = chain["checked"] or 1
    status("info", f"{chain['checked']} Tracks per AnalysisDataPath aufgeloest")
    status("ok" if chain["missing_file"] == 0 else "err",
           f".DAT vorhanden: {chain['dat_ok']}/{chain['checked']}, fehlend: {chain['missing_file']}")
    status("ok" if chain["wave"] == chain["checked"] else "warn",
           f"mit Waveform-Sektion: {chain['wave']}/{chain['checked']} ({100 * chain['wave'] // n} %)")

    say("\n== 5) Einzelne Tracks durchgespielt")
    probes = []
    for pid in probe_ids:
        t = next((x for x in xml_tracks if x["track_id"] == pid), None)
        r = by_id.get(pid) or (by_path.get(norm_path(t["location"])) if t else None)
        entry = {"id": pid, "in_xml": bool(t), "in_db": bool(by_id.get(pid)), "via_path": bool(r and not by_id.get(pid))}
        if r and r["analysis_path"]:
            fs = anlz_candidates(analysis_root, r["analysis_path"])
            entry["files"] = {k: str(v) for k, v in fs.items()}
            entry["exists"] = {k: v.is_file() for k, v in fs.items()}
            entry["wave_tags"] = sorted({tg for v in fs.values() if v.is_file()
                                         for tg in parse_anlz(v)["tags"] if tg in WAVE_TAGS})
        probes.append(entry)
        status("ok" if entry.get("wave_tags") else "err",
               f"TrackID {pid}: XML={entry['in_xml']} DB(ID)={entry['in_db']} "
               f"DB(Pfad)={entry['via_path']} Waveform={entry.get('wave_tags') or 'nein'}")
    report["probes"] = probes
    return key, chain


def step_verdict(report, ok_files, ok_anlz, key, chain, db_error):
    say("\n== FAZIT UND NAECHSTER SCHRITT")
    todo = []
    if not ok_files:
        todo.append("Pfade stimmen nicht: Editor muss db-path und analysis-data-root-path aus der "
                    "options.json lesen (D:\\PIONEER\\Master\\master.db, D:\\PIONEER\\Master\\share).")
    if db_error:
        todo.append(f"master.db liess sich nicht lesen: {db_error}")
    if key == "ID":
        todo.append("Editor: Track direkt per djmdContent.ID = XML-TrackID suchen (kein Pfadvergleich noetig).")
    elif key == "PFAD":
        todo.append("Editor: Track ueber FolderPath (normalisiert, URL-dekodiert, Slash/Gross-Klein) suchen; "
                    "XML-Stand pruefen/neu exportieren.")
    elif key == "KEINE":
        todo.append("XML neu aus derselben Rekordbox-Bibliothek exportieren (andere Sammlung als master.db).")
    if chain and chain["missing_file"]:
        todo.append("AnalysisDataPath relativ zu analysis-data-root-path aufloesen "
                    "(D:\\PIONEER\\Master\\share + /PIONEER/USBANLZ/...), nicht relativ zu D:\\PIONEER.")
    if not ok_anlz:
        todo.append("ANLZ-Format/Waveform-Sektionen pruefen (siehe Abschnitt 2).")
    if not todo:
        todo.append("Kette komplett in Ordnung -> Fehler liegt nur noch im Editor-Code (Pfad-Zusammenbau/Anzeige). "
                    "Bericht an Claude geben.")
    for t in todo:
        status("warn" if len(todo) > 1 or "Kette komplett" not in t else "ok", t)
    report["todo"] = todo


# ----------------------------------------------------------------------------- main
def run(args, rows_override=None):
    report = {}
    say("rb_diagnose  -  Rekordbox-Kette automatisch pruefen (nur lesend)")
    opt = read_options(args.options)
    report["options"] = {k: opt[k] for k in ("file", "found", "db_path", "analysis_root", "app_ver")}
    say("\n== 0) Rekordbox-Einstellungen")
    if opt["found"]:
        status("ok", f"options.json gelesen (Rekordbox {opt['app_ver']})")
    else:
        status("warn", f"options.json nicht gefunden: {opt['file']} -> verwende Standardpfade auf D:")
    db_path = args.db or opt["db_path"] or r"D:\PIONEER\Master\master.db"
    analysis_root = args.analysis_root or opt["analysis_root"] or r"D:\PIONEER\Master\share"
    status("info", f"db-path: {db_path}")
    status("info", f"analysis-data-root-path: {analysis_root}")

    ok_files, usb = step_files(report, db_path, analysis_root)
    ok_anlz = step_anlz_census(report, usb) if usb and usb.is_dir() else False

    key, chain, db_error = "?", None, None
    xml_path = find_xml(args.xml)
    xml_tracks = []
    say("\n== XML")
    if xml_path:
        xml_tracks = read_xml(xml_path)
        status("ok", f"{xml_path}: {len(xml_tracks)} Tracks")
    else:
        status("err", "Keine Rekordbox-XML gefunden. Mit --xml PFAD angeben.")
    report["xml"] = str(xml_path) if xml_path else None

    rows = rows_override
    if rows is None and ok_files:
        good, msg = ensure_pyrekordbox(not args.no_install)
        status("ok" if good else "err", msg)
        if good:
            try:
                rows = load_db_rows(db_path)
                status("ok", f"master.db-Kopie gelesen: {len(rows)} Tracks in djmdContent")
            except Exception as e:  # noqa: BLE001
                db_error = str(e)
                status("err", f"master.db nicht lesbar: {db_error}")
        else:
            db_error = msg
    if rows is not None and xml_tracks:
        key, chain = step_link(report, xml_tracks, rows, analysis_root, args.ids or DEFAULT_IDS)
    step_verdict(report, ok_files, ok_anlz, key, chain, db_error)
    return report


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--xml")
    ap.add_argument("--db")
    ap.add_argument("--analysis-root")
    ap.add_argument("--options")
    ap.add_argument("--ids", nargs="*")
    ap.add_argument("--out-dir")
    ap.add_argument("--no-install", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        return selftest(args)

    out_dir = Path(args.out_dir) if args.out_dir else (
        Path.home() / "Desktop" if (Path.home() / "Desktop").is_dir() else Path(__file__).resolve().parent)
    try:
        out_dir.resolve().relative_to(Path(r"D:\PIONEER").resolve())
        print("ABBRUCH: --out-dir liegt unter D:\\PIONEER")
        return 2
    except ValueError:
        pass
    report = run(args)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "rb_diagnose_bericht.txt").write_text("\n".join(LOG), encoding="utf-8")
    (out_dir / "rb_diagnose_bericht.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    say(f"\nBericht gespeichert in: {out_dir}  (rb_diagnose_bericht.txt / .json)")
    if len(sys.argv) == 1 and sys.stdin and sys.stdin.isatty():
        input("\nEnter druecken zum Beenden ...")
    return 0


def selftest(args):
    tmp = Path(tempfile.mkdtemp())
    usb = tmp / "share" / "PIONEER" / "USBANLZ" / "abc" / "def"
    usb.mkdir(parents=True)
    path = "D:/m/a.mp3".encode("utf-16-be")

    def tag(f, body):
        return f.encode() + struct.pack(">II", 12, 12 + len(body)) + body
    body = tag("PPTH", struct.pack(">I", len(path)) + path) + tag("PWAV", b"\0" * 8)
    blob = b"PMAI" + struct.pack(">II", 28, 28 + len(body)) + b"\0" * 16 + body
    (usb / "ANLZ0000.DAT").write_bytes(blob)
    (usb / "ANLZ0000.EXT").write_bytes(blob)
    (tmp / "master.db").write_bytes(b"x" * 100)
    (tmp / "export.xml").write_text('<DJ_PLAYLISTS><COLLECTION><TRACK TrackID="7" Name="a" '
                                    'Location="file://localhost/D:/m/a.mp3"/></COLLECTION></DJ_PLAYLISTS>')
    args.db, args.analysis_root, args.xml, args.ids = str(tmp / "master.db"), str(tmp / "share"), str(tmp / "export.xml"), ["7"]
    args.options = str(tmp / "none.json")
    rows = [{"id": "7", "folder_path": "D:/m/a.mp3", "analysis_path": "/PIONEER/USBANLZ/abc/def/ANLZ0000.DAT",
             "uuid": "u", "title": "a"}]
    run(args, rows_override=rows)
    shutil.rmtree(tmp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
