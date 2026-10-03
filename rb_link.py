#!/usr/bin/env python3
"""rb_link: findet heraus, wie ein Track der Rekordbox-XML mit seinem master.db-Eintrag
und seinen ANLZ-Dateien verbunden ist. Nur lesend.

Voraussetzung (einmalig):  pip install pyrekordbox
Falls der Schluessel fehlt: python -m pyrekordbox download-key

Aufruf:
  python rb_link.py --xml C:\\pfad\\rekordbox_export2.xml ^
      --db D:\\PIONEER\\Master\\master.db ^
      --analysis-root D:\\PIONEER\\Master\\share ^
      --ids 87868672 142225026 ^
      --out C:\\Users\\p_kro\\rb_link_report.json

Sicherheit: master.db (plus -wal/-shm) wird zuerst in einen Temp-Ordner KOPIERT und nur die
Kopie geoeffnet. Das Original wird nie geoeffnet oder veraendert. Der Bericht darf nicht
unter D:\\PIONEER liegen. Der Schluessel ("dp") wird nie ausgegeben.

Geprueft werden drei Kandidaten fuer die Verbindung:
  A) XML TrackID  == djmdContent.ID
  B) XML Location == djmdContent.FolderPath   (Dateipfad)
  C) XML Name/Artist/Size/TotalTime           (nur Gegenprobe)
Dazu: AnalysisDataPath -> <analysis-root>/... -> ANLZ-Datei vorhanden?
"""
import argparse
import json
import shutil
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import unquote, urlparse


def norm_path(p):
    if not p:
        return ""
    return str(p).replace("\\", "/").rstrip("/").lower()


def location_to_path(loc):
    """file://localhost/D:/Musik/a%20b.mp3 -> D:/Musik/a b.mp3"""
    if not loc:
        return ""
    u = urlparse(loc)
    path = unquote(u.path if u.scheme else loc)
    if len(path) > 2 and path[0] == "/" and path[2] == ":":
        path = path[1:]
    return path


def read_xml(path):
    tracks = []
    for _, el in ET.iterparse(path, events=("end",)):
        if el.tag == "TRACK" and el.get("TrackID"):
            tracks.append({
                "track_id": el.get("TrackID"),
                "location": location_to_path(el.get("Location")),
                "name": el.get("Name"), "artist": el.get("Artist"),
                "size": el.get("Size"), "total_time": el.get("TotalTime"),
            })
            el.clear()
    return tracks


def compare(xml_tracks, db_rows, analysis_root, probe_ids):
    by_id = {str(r["id"]): r for r in db_rows}
    by_path = {}
    for r in db_rows:
        by_path.setdefault(norm_path(r.get("folder_path")), r)
    res = {"xml_tracks": len(xml_tracks), "db_rows": len(db_rows)}
    id_hits = [t for t in xml_tracks if t["track_id"] in by_id]
    path_hits = [(t, by_path.get(norm_path(t["location"]))) for t in xml_tracks]
    path_hits = [(t, r) for t, r in path_hits if r]
    res["A_trackid_equals_content_id"] = len(id_hits)
    res["B_location_equals_folderpath"] = len(path_hits)
    res["B_with_same_id"] = sum(1 for t, r in path_hits if str(r["id"]) == t["track_id"])
    res["B_with_different_id"] = res["B_location_equals_folderpath"] - res["B_with_same_id"]
    res["examples_different_id"] = [
        {"xml_track_id": t["track_id"], "db_id": str(r["id"]), "path": t["location"]}
        for t, r in path_hits if str(r["id"]) != t["track_id"]][:5]
    res["examples_xml_not_in_db"] = [
        {"xml_track_id": t["track_id"], "path": t["location"]}
        for t in xml_tracks if t["track_id"] not in by_id and norm_path(t["location"]) not in by_path][:5]

    # ANLZ-Aufloesung ueber AnalysisDataPath
    ok = missing = 0
    miss_ex = []
    for r in db_rows:
        adp = r.get("analysis_path")
        if not adp:
            continue
        cand = Path(analysis_root) / str(adp).replace("\\", "/").lstrip("/")
        if cand.exists():
            ok += 1
        else:
            missing += 1
            if len(miss_ex) < 5:
                miss_ex.append({"id": str(r["id"]), "analysis_path": adp, "geprueft": str(cand)})
    res["anlz_resolved"] = ok
    res["anlz_missing"] = missing
    res["anlz_missing_examples"] = miss_ex

    probes = []
    for pid in probe_ids:
        t = next((x for x in xml_tracks if x["track_id"] == pid), None)
        r = by_id.get(pid)
        probes.append({"id": pid, "in_xml": t, "db_row_by_id": r,
                       "db_row_by_xml_path": by_path.get(norm_path(t["location"])) if t else None})
    res["probes"] = probes

    if res["A_trackid_equals_content_id"] and res["B_with_different_id"] == 0:
        v = "TrackID der XML == djmdContent.ID: direkter Primaerschluessel-Lookup funktioniert."
    elif res["B_location_equals_folderpath"] and res["B_with_different_id"]:
        v = ("TrackID und ID stimmen NICHT ueberein: Verbindung nur ueber den Dateipfad (FolderPath) "
             "oder UUID. XML ist evtl. aus anderem Bibliotheksstand.")
    elif not res["A_trackid_equals_content_id"] and not res["B_location_equals_folderpath"]:
        v = ("Weder ID noch Pfad passen: XML und master.db sind nicht dieselbe Sammlung "
             "(oder Laufwerksbuchstaben/Pfade unterscheiden sich).")
    else:
        v = "Teilweise Uebereinstimmung, Details im Bericht."
    res["verdict"] = v
    return res


def load_db_rows(db_path):
    try:
        from pyrekordbox import Rekordbox6Database
    except ImportError:
        sys.exit("pyrekordbox fehlt: pip install pyrekordbox")
    tmp = Path(tempfile.mkdtemp(prefix="rb_link_"))
    src = Path(db_path)
    for suf in ("", "-wal", "-shm"):
        f = src.with_name(src.name + suf)
        if f.exists():
            shutil.copy2(f, tmp / f.name)
    copy = tmp / src.name
    db = None
    last = None
    for kwargs in ({"path": str(copy)}, {"db_dir": str(tmp)}):
        try:
            db = Rekordbox6Database(**kwargs)
            break
        except Exception as e:  # noqa: BLE001
            last = e
    if db is None:
        sys.exit(f"master.db-Kopie liess sich nicht oeffnen: {last}\n"
                 "Tipp: python -m pyrekordbox download-key  (oder pyrekordbox/SQLCipher-Installation pruefen)")
    rows = []
    for c in db.get_content():
        rows.append({"id": c.ID, "folder_path": getattr(c, "FolderPath", None),
                     "analysis_path": getattr(c, "AnalysisDataPath", None),
                     "uuid": getattr(c, "UUID", None), "title": getattr(c, "Title", None)})
    try:
        db.close()
    except Exception:  # noqa: BLE001
        pass
    shutil.rmtree(tmp, ignore_errors=True)
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--xml", required=False)
    ap.add_argument("--db", default=r"D:\PIONEER\Master\master.db")
    ap.add_argument("--analysis-root", default=r"D:\PIONEER\Master\share")
    ap.add_argument("--ids", nargs="*", default=["87868672", "142225026"])
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent / "rb_link_report.json"))
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()

    if a.selftest:
        xml = [{"track_id": "1", "location": "D:/M/a.mp3"}, {"track_id": "2", "location": "D:/M/b.mp3"}]
        db = [{"id": "1", "folder_path": "D:/M/a.mp3", "analysis_path": "/PIONEER/USBANLZ/x/ANLZ0000.DAT"},
              {"id": "9", "folder_path": "d:\\m\\b.mp3", "analysis_path": None}]
        print(json.dumps(compare(xml, db, "/nonexistent", ["2"]), indent=2, ensure_ascii=False))
        return 0
    if not a.xml:
        ap.error("--xml ist erforderlich")
    try:
        Path(a.out).resolve().relative_to(Path(r"D:\PIONEER").resolve())
        sys.exit("ABBRUCH: --out liegt unter D:\\PIONEER")
    except ValueError:
        pass

    xml_tracks = read_xml(a.xml)
    rows = load_db_rows(a.db)
    res = compare(xml_tracks, rows, a.analysis_root, a.ids)
    Path(a.out).write_text(json.dumps(res, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    print(f"XML-Tracks: {res['xml_tracks']} | DB-Zeilen: {res['db_rows']}")
    print(f"A) TrackID == Content-ID:       {res['A_trackid_equals_content_id']}")
    print(f"B) Location == FolderPath:      {res['B_location_equals_folderpath']} "
          f"(gleiche ID: {res['B_with_same_id']}, andere ID: {res['B_with_different_id']})")
    print(f"ANLZ ueber AnalysisDataPath:    aufloesbar {res['anlz_resolved']}, fehlend {res['anlz_missing']}")
    print("FAZIT:", res["verdict"])
    print(f"Bericht: {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
