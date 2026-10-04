#!/usr/bin/env python3
"""rb_probe: nur-lesende Gesamtanalyse eines Rekordbox-Ordners (Standard: D:\\PIONEER).

Aufruf (Windows, nur Python 3 nötig, keine Zusatzpakete):
    python rb_probe.py                      -> analysiert D:\\PIONEER
    python rb_probe.py D:\\PIONEER --out C:\\temp\\rb_probe_report.json

Was geprüft wird (alles in einem Lauf):
  1. Ordnerstruktur und Dateizahlen
  2. Datenbankdateien (master.db, exportLibrary.db, export.pdb, ...): Typ am Header erkennen
  3. ANLZ-Dateien (.DAT/.EXT/.2EX): Header, Sektionen, Waveform-Sektionen, Fehler
  4. PPTH-Pfade (Audiopfad laut Analyse) und ob sie auflösbar sind
  5. Fazit mit konkreten nächsten Schritten

Sicherheit: Alle Dateien unter dem Zielordner werden nur mit "rb" geöffnet.
Der Bericht wird NIE in den Zielordner geschrieben (das Skript bricht sonst ab).
Annahmen, die am echten Bestand geprüft werden (Ausgabe zeigt Abweichungen):
  - ANLZ ist Big Endian, Sektionskopf = FourCC, len_header, len_tag (je 4 Byte)
  - PDB: Blockgröße 4096 (Int an Offset 4, little endian) laut Fremddokumentation
"""
import argparse
import json
import os
import struct
import sys
from collections import Counter
from pathlib import Path

DB_NAMES = {
    "master.db": "Rekordbox 6/7 Bibliothek (SQLCipher erwartet)",
    "master.backup.db": "Backup der Bibliothek",
    "exportlibrary.db": "Device Library Plus / OneLibrary (SQLCipher erwartet)",
    "export.pdb": "Pioneer-Export im DeviceSQL-Format",
    "exportext.pdb": "Pioneer-Export, Zusatzdaten (DeviceSQL)",
    "product.db": "Rekordbox Produktdatenbank",
    "datafile.edb": "Rekordbox 5 Bibliothek (DeviceSQL)",
    "extdata.edb": "Rekordbox 5 Zusatzdaten",
}
WAVE_TAGS = {"PWAV", "PWV2", "PWV3", "PWV4", "PWV5", "PWV6", "PWV7", "PWVC"}
ANLZ_EXT = {".dat", ".ext", ".2ex"}


def classify_db(path: Path):
    try:
        with open(path, "rb") as f:
            head = f.read(32)
    except OSError as e:
        return {"kind": "nicht lesbar", "detail": str(e)}
    if head.startswith(b"SQLite format 3\x00"):
        return {"kind": "SQLite unverschlüsselt", "detail": "Standard-SQLite-Header"}
    if path.suffix.lower() == ".pdb" and len(head) >= 8:
        page = struct.unpack("<I", head[4:8])[0]
        if page == 4096:
            return {"kind": "DeviceSQL PDB", "detail": "Blockgröße 4096 passt"}
        return {"kind": "PDB mit unerwartetem Header", "detail": f"Int@4={page}"}
    return {"kind": "vermutlich SQLCipher/verschlüsselt",
            "detail": "kein SQLite-Klartextheader (bei master.db/exportLibrary.db normal)"}


def parse_anlz(path: Path):
    data = path.read_bytes()
    out = {"size": len(data), "ok": False, "tags": [], "ppth": None, "problem": None}
    if len(data) < 12 or data[:4] != b"PMAI":
        out["problem"] = "keine PMAI-Kennung"
        return out
    len_header, len_file = struct.unpack(">II", data[4:12])
    if len_file != len(data):
        out["problem"] = f"len_file {len_file} != Dateigröße {len(data)}"
    pos = len_header
    while pos + 12 <= len(data):
        fourcc = data[pos:pos + 4].decode("ascii", "replace")
        length = struct.unpack(">I", data[pos + 8:pos + 12])[0]
        if length < 12 or pos + length > len(data):
            out["problem"] = out["problem"] or f"Sektion {fourcc}@{pos} len_tag={length} unplausibel"
            return out
        out["tags"].append(fourcc)
        if fourcc == "PPTH" and out["ppth"] is None:
            try:
                n = struct.unpack(">I", data[pos + 12:pos + 16])[0]
                out["ppth"] = data[pos + 16:pos + 16 + n].decode("utf-16-be", "replace").rstrip("\x00")
            except Exception as e:  # noqa: BLE001
                out["problem"] = out["problem"] or f"PPTH nicht lesbar: {e}"
        pos += length
    out["ok"] = out["problem"] is None
    return out


def resolve_ppth(ppth: str, root: Path):
    """Prüft, ob ein PPTH-Pfad (Export: /Contents/..., lokal: Laufwerkspfad) auflösbar ist."""
    if not ppth:
        return None
    cands = [Path(ppth)]
    rel = ppth.replace("\\", "/").lstrip("/")
    cands.append(root.parent / rel)
    cands.append(root / rel)
    return any(c.exists() for c in cands)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("root", nargs="?", default=r"D:\PIONEER")
    ap.add_argument("--out", default=None, help="Pfad des JSON-Berichts (nicht im Zielordner)")
    ap.add_argument("--max-anlz", type=int, default=20000, help="Obergrenze geparster ANLZ-Dateien")
    args = ap.parse_args()

    root = Path(args.root)
    out_path = Path(args.out) if args.out else Path(__file__).resolve().parent / "rb_probe_report.json"
    try:
        out_path.resolve().relative_to(root.resolve())
        print(f"ABBRUCH: Bericht würde im Zielordner liegen: {out_path}. Anderen --out wählen.")
        return 2
    except ValueError:
        pass

    report = {"root": str(root), "exists": root.exists()}
    print(f"== rb_probe für {root}")
    if not root.exists():
        print("FEHLER: Ordner existiert nicht. Laufwerksbuchstabe/Pfad prüfen (ist D: eingehängt?).")
        out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        return 1

    files = [p for p in root.rglob("*") if p.is_file()]
    exts = Counter(p.suffix.lower() or "(ohne)" for p in files)
    report["files_total"] = len(files)
    report["extensions"] = dict(exts.most_common(15))
    top = sorted({p.relative_to(root).parts[0] for p in files if len(p.relative_to(root).parts) > 1})
    report["top_level_dirs"] = top
    print(f"Dateien gesamt: {len(files)} | Top-Ordner: {', '.join(top) or '-'}")
    print("Häufigste Endungen:", ", ".join(f"{k}:{v}" for k, v in exts.most_common(8)))

    # 2. Datenbanken
    dbs = []
    for p in files:
        low = p.name.lower()
        base = low[:-4] if low.endswith(("-wal", "-shm")) and False else low
        if base in DB_NAMES:
            info = classify_db(p)
            st = p.stat()
            dbs.append({"path": str(p), "role": DB_NAMES[base], "size": st.st_size,
                        "mtime": st.st_mtime, **info,
                        "wal": p.with_name(p.name + "-wal").exists(),
                        "shm": p.with_name(p.name + "-shm").exists()})
    report["databases"] = dbs
    print("\n-- Datenbankdateien")
    if not dbs:
        print("  KEINE bekannte Datenbankdatei gefunden (master.db, exportLibrary.db, export.pdb, ...).")
    for d in dbs:
        print(f"  {d['path']}\n    {d['role']} | {d['size']} Bytes | {d['kind']} ({d['detail']})"
              f"{' | WAL vorhanden' if d['wal'] else ''}")

    # 3. ANLZ
    anlz_files = [p for p in files if p.suffix.lower() in ANLZ_EXT and p.name.upper().startswith("ANLZ")]
    by_ext = Counter(p.suffix.upper() for p in anlz_files)
    stats = {"parsed": 0, "ok": 0, "no_wave": 0, "errors": Counter(), "wave_tags": Counter(),
             "ppth_checked": 0, "ppth_resolvable": 0}
    examples = {"errors": [], "no_wave": [], "ppth": []}
    for p in anlz_files[: args.max_anlz]:
        try:
            r = parse_anlz(p)
        except OSError as e:
            r = {"ok": False, "tags": [], "ppth": None, "problem": f"nicht lesbar: {e}"}
        stats["parsed"] += 1
        waves = sorted(set(r["tags"]) & WAVE_TAGS)
        for w in waves:
            stats["wave_tags"][w] += 1
        if r["ok"]:
            stats["ok"] += 1
        else:
            stats["errors"][r["problem"].split(" ")[0] if r["problem"] else "?"] += 1
            if len(examples["errors"]) < 5:
                examples["errors"].append({"file": str(p), "problem": r["problem"]})
        if p.suffix.lower() in (".dat", ".ext") and not waves:
            stats["no_wave"] += 1
            if len(examples["no_wave"]) < 5:
                examples["no_wave"].append({"file": str(p), "tags": r["tags"]})
        if r["ppth"]:
            stats["ppth_checked"] += 1
            res = resolve_ppth(r["ppth"], root)
            stats["ppth_resolvable"] += 1 if res else 0
            if len(examples["ppth"]) < 5:
                examples["ppth"].append({"ppth": r["ppth"], "auflösbar": res})
    stats["errors"] = dict(stats["errors"])
    stats["wave_tags"] = dict(stats["wave_tags"])
    report["anlz"] = {"count_by_ext": dict(by_ext), "total": len(anlz_files), **stats, "examples": examples}
    print("\n-- ANLZ-Dateien")
    print(f"  gefunden: {len(anlz_files)} {dict(by_ext)} | geparst: {stats['parsed']} | fehlerfrei: {stats['ok']}")
    print(f"  Waveform-Sektionen: {stats['wave_tags'] or 'KEINE'}")
    print(f"  .DAT/.EXT ohne Waveform-Sektion: {stats['no_wave']}")
    if stats["errors"]:
        print(f"  Fehlerarten: {stats['errors']}  (Beispiele im JSON-Bericht)")
    if stats["ppth_checked"]:
        print(f"  PPTH auflösbar: {stats['ppth_resolvable']}/{stats['ppth_checked']}")
        for e in examples["ppth"][:3]:
            print(f"    Beispiel PPTH: {e['ppth']} -> {e['auflösbar']}")

    # 5. Fazit
    verdict = []
    if not dbs:
        verdict.append("Keine Datenbank im Ordner: DB liegt anderswo, oder Pfad ist nicht der Datenordner.")
    else:
        kinds = {Path(d["path"]).name.lower() for d in dbs}
        if "exportlibrary.db" in kinds or "master.db" in kinds:
            verdict.append("SQLCipher-Datenbank vorhanden: Editor-Gate kann sie grundsätzlich lesen. "
                           "Dann fehlt eher der feste Pfad (Autoerkennung findet D:\\PIONEER nicht).")
        if kinds & {"export.pdb"} and not kinds & {"exportlibrary.db", "master.db"}:
            verdict.append("NUR export.pdb (DeviceSQL): laut VORHABEN.md liest der Editor das nicht -> "
                           "PDB-Parser nötig oder neuen Export (exportLibrary.db) erzeugen.")
    if not anlz_files:
        verdict.append("Keine ANLZ-Dateien: Analysedaten liegen woanders (z. B. ...\\share\\PIONEER\\USBANLZ).")
    elif not stats["wave_tags"]:
        verdict.append("ANLZ vorhanden, aber ohne Waveform-Sektionen: Tracks wurden nicht analysiert/exportiert.")
    elif stats["errors"]:
        verdict.append("ANLZ-Parsefehler: Endianness-/Formatannahme prüfen (Beispiele im JSON).")
    else:
        verdict.append("ANLZ-Format und Waveform-Sektionen in Ordnung -> Fehler liegt im Editor (Pfadauflösung/Gate).")
    report["verdict"] = verdict
    print("\n-- Fazit")
    for v in verdict:
        print("  *", v)

    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    print(f"\nBericht: {out_path}  (bitte Inhalt oder Datei an Claude geben)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
