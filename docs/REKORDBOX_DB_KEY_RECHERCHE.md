# Rekordbox master.db — Key-Recherche (Rekordbox 7.2.16)

Stand: 2026-09-10 (Agenten-Strang „Pipeline“, Auftrag des Nutzers:
„Suche online nach dem Key für Rekordbox 7.2.16, nutze das Passwort für
die master.db-Abfrage.“)

## Ergebnis

**Der Key, den die App bereits nutzt, IST der gültige Key für
Rekordbox 7.2.16 — es existiert kein versionsspezifischer 7.2.16-Key.**

App-Key (aus `electron/dbReader.cjs`, `getMasterDbKey()`, deobfuskiert):

```
402fd482c38817c35ffa8ffb8c7d93143b749e7d315df7a81732a1ff43608497
```

## Beweisführung

| # | Quelle | Befund |
|---|--------|--------|
| 1 | [liamcottle/pioneer-rekordbox-database-encryption](https://github.com/liamcottle/pioneer-rekordbox-database-encryption) | Community-Key für master.db = `402fd482…` (Frida-Dump von `sqlite3_key` beim Rekordbox-Start) |
| 2 | **pyrekordbox** (dylanljones, aktiv 2025/26, unterstützt RB6+RB7): `pyrekordbox/masterdb/database.py` → `BLOB` + `deobfuscate()` | **Deobfuskation des pyrekordbox-Blobs = EXAKT derselbe Key** wie in der App (lokal verifiziert) |
| 3 | [r/Rekordbox: Key to open master.db](https://www.reddit.com/r/Rekordbox/comments/qou6nm/key_to_open_masterdb_file/) (Thread bis 7.2.x) | „as of the latest rekordbox 7.2.8 … **at least the rekordbox developers have not changed the library key yet**“ |
| 4 | [pyrekordbox Key-Doku](https://pyrekordbox.readthedocs.io/en/stable/key.html) | Key liegt als **String in rekordbox.exe** eingebettet (x64dbg-Extraktion bei `sqlite3_key_v2`) → versionsspezifisch MÖGLICH, aber: |
| 5 | **Keine einzige Quelle** mit einem abweichenden Key für 7.2.x/7.2.16 (GitHub-Code-Suche nach dem Key: nur Projekte, die DENSSELBEN Key nutzen; DjManager #300 betraf nur `exportLibrary.db` mit anderem 64-Byte-ASCII-Key) | → Für 7.2.16 gilt: unveränderter Key `402fd482…` |

## Zugriff auf die master.db (Frage: „haben wir überhaupt Zugriff?“)

**Ja — dreifach belegt:**

1. **Key-Identität** (oben): App-Key = gültiger Community-Key für RB6/7 inkl. 7.2.x.
2. **Empirisch am Gerät des Nutzers**: v0.4.18–20-Logs zeigten vollständige
   Leseerfolge derselben Datei `D:\PIONEER\Master\master.db`
   (`10726 Tracks, 10193 ANLZ-Links`) mit exakt diesem Key und
   Cipher-Parameter-Satz (`cipher=sqlcipher`, `legacy=4`, read-only).
3. **Leseweg entspricht dem Community-Rezept**: read-only öffnen (wirft
   keine Schreib-Sperre) + busy_timeout + `query_only=ON` (v0.5.4-Hardening).

Der einzige im Feld aufgetretene Zugriffsausfall (Diagnosebericht v0.5.6,
`dbLinks: 0`) war **kein** Key-/Zugriffsproblem, sondern ein
Timing-Fehler (Deck-Load fragte den Index, während der DB-Read lief) —
gefixt durch Single-Flight-DB-Load (v0.5.7); Fehler beim DB-Read werden
seit v0.5.8 im Diagnosebericht mit Grund angezeigt.

## Nicht in der Sandbox machbar (ehrliche Grenze)

Ein frischer Live-Read einer SQLCipher-DB in der Linux-Sandbox ist nicht
möglich: das native Modul `better-sqlite3-multiple-ciphers` braucht ein
Prebuilt-Binary (GitHub-Releases) oder node-gyp-Header (nodejs.org) —
beide Downloads werden durch den Sandbox-TLS-Proxy blockiert
(`prebuild-install: unable to verify the first certificate`,
`node-gyp: Client network socket disconnected`).

**Ersatz-Nachweis in der Sandbox:** E2E-Suite `tests/exact-paths-e2e.test.ts`
(E1–E5) läuft die Kette ab dem DB-Row-Format (exakt die Spalten der
master.db-Abfrage) durch die Produktionsfunktionen — Pfade, Index,
Abfrage, exakte Zielpfade. Läuft in jedem CI-Run.

## Konsequenz für die App

- **Kein Key-Wechsel nötig** — der Hardcoded-Key ist korrekt.
- `openRekordboxDb` nutzt ihn unverändert
  (`cipher=sqlcipher`, `legacy=4`, read-only, timeout 10 s).
- Falls Rekordbox eines Tages den Key ändert (nur per `rekordbox.exe`-
  Update feststellbar): die App meldet seit v0.5.4/v0.5.8 den
  Fehlergrund (`ENCRYPTED_OR_CORRUPT` → „falsche Datei / falscher Key“)
  im Log — dann ist eine Key-Aktualisierung der nächste Schritt.
