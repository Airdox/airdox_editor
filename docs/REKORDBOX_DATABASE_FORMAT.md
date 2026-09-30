# Rekordbox-Datenbank: Aufbau, Einträge und Abgleich mit unserem Code

**Stand:** 30.09.2026 · `arena/01a0eff8-airdox-editor`
**Zweck:** Nachweis, dass unsere Implementierung (Abfragen + Inhalte der
Rekordbox-Datenbank) zum dokumentierten Format passt — und einer kleinen
eigenen Datenbankumgebung, die die Pipeline vom Prinzip her als funktionsfähig
belegt.

---

## 1. Quellen („Rekordbox für Entwickler")

Die verlässliche Formatdokumentation stammt aus der Entwickler-Community (Pioneer
selbst veröffentlicht keine):

| Quelle | Inhalt |
| --- | --- |
| [pyrekordbox – Rekordbox 6 Database Format](https://pyrekordbox.readthedocs.io/en/latest/formats/db6.html) | Aufbau der `master.db` (Tabellen `djmd*`, Einträge/Spalten, Einheiten) |
| [pyrekordbox – Device Library Plus](https://github.com/dylanljones/pyrekordbox/blob/master/docs/source/formats/devicelib_plus.md) | Aufbau der OneLibrary `exportLibrary.db` (`content`/`cue`/`playlist`/…) |
| [Deep Symmetry – Database Exports](https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/exports.html) | Byteblock-Seitenformat der DeviceSQL-`export.pdb` (USB/CDJ) + Zeilen-Aufbau |
| [henrybetts – Rekordbox-Decoding](https://github.com/henrybetts/Rekordbox-Decoding) | Erste Zerlegung derselben Byteblöcke/Zeilenregionen |
| [0xdevalias – SQLCipher-Schlüssel-Gist](https://gist.github.com/0xdevalias/b803476793b56f7c45e6361799168eb0) | Bestätigung der deobfuskierten Schlüssel/Modi |
| [tnayuki/sujay PR #45](https://github.com/tnayuki/sujay/pull/45), [chrisle/onelibrary-connect PR #1](https://github.com/chrisle/onelibrary-connect/pull/1) | Real-Daten-Nachweis zur Einheit der Spieldauer (Sekunden) |

---

## 2. Physischer Aufbau: „Byteblöcke mit Informationen pro Region"

Die Dokumentation beschreibt Datenbanken als **feste Byteblöcke (Seiten)**, in
denen **verschiedene Regionen** unterschiedliche Informationen tragen. Je nach
Datenbank-Generation gibt es drei solcher Blockformate:

### 2.1 `master.db` / `exportLibrary.db` (Rekordbox 6/7 & OneLibrary) — SQLCipher-Seiten
Seit Rekordbox 6 speichert Pioneer die Bibliothek als **SQLite3, verschlüsselt
mit SQLCipher4**. Physisch sind auch das 4096-Byte-Seiten (verschlüsselte
Blöcke mit SQL-/B-Tree-Struktur: Seitenkopf, Zeiger-Array, Zellregionen).
Dieses Blockformat wird **nicht selbst geparst**, sondern bewusst an die
SQLCipher-Engine delegiert (`better-sqlite3-multiple-ciphers`, `cipher =
sqlcipher`, `legacy = 4`) — die „Abfragen der Datenbank" sind damit echte
SQL-Abfragen auf entschlüsselten Seiten.

*Prinzip-Nachweis in unserer Umgebung:* die erzeugte `master.db` beginnt am Rest
**nicht** mit `SQLite format 3` (Bytes sind echte verschlüsselte Blöcke) und wird
trotzdem über unsere Queries vollständig gelesen —
`tests/rekordbox-db-env-pipeline.test.ts` (Prüfungen 1/2/4).

### 2.2 `export.pdb` (DeviceSQL, USB-Sticks/CDJ) — 4096-Byte-Seiten mit Regionen
Das alte Geräteformat ist genau das in der Entwicklerdoku beschriebene
Block/Raster-Prinzip ([Deep Symmetry](https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/exports.html)):

```
Datei   = Kopfseite (len_page = 4096, num_tables, Tabelle → erste Seite)
Seite   = [Kopf-Region | Zeilen-Heap (wächst nach oben) | Zeilenindex (wächst von unten nach hinten)]
Zeile   = [4-Byte-Kopf (Tabellen-ID) | fixe Spaltenregion | Offset-Tabelle | String-Region]
```

**Unser Code liest dieses Byteblock-Format bewusst NICHT.** Der Anwendungspfad
dieses Projekts ist die Rekordbox-6/7-Bibliothek (`master.db`) plus ANLZ; die
logische Zeilenschema-Familie (Titel, Dateipfad, Spieldauer in Sekunden, Cues …)
ist dieselbe. Ein USB-`export.pdb`-Importer wäre eine eigenständige Erweiterung
und ist hier nicht Teil der Pipeline.

### 2.3 ANLZ-Analysedateien — getaggte Byteblöcke mit Sektionsregionen
Auch die ANLZ-Container (`.DAT`/`.EXT`/`.2EX`) sind Byteblöcke mit Regionen pro
Block: 12-Byte-Sektionskopf (Magic + Kennung + Länge) + Body-Region mit
dokumentierten Feldern (PMAI, PPTH, PQTZ, PCOB/PCO2, PWAV/PWV2…PWV7, PSSI).
Diesen Walk implementieren wir **selbst** (`src/rekordbox/anlzStructure.ts`,
gemeinsam genutzt von Renderer und Electron-Gate) — Parität ist über
`tests/anlz-structure-parity.test.ts` und den Env-Test (Prüfungen 12/13) belegt.

---

## 3. Logischer Aufbau: Tabellen (Datenbank) und Zeilen (Datenbankeinträge)

### 3.1 `master.db` — dokumentierte Tabellen/Spalten vs. unsere Abfragen

| Dokumentation (pyrekordbox db6) | `electron/dbReader.cjs` (`readMasterDb`) | Status |
| --- | --- | --- |
| `djmdContent` (ID, FolderPath, FileNameL, Title, ArtistID, AlbumID, GenreID, BPM, Length, Commnt, Rating, KeyID, LabelID, DJPlayCount, AnalysisDataPath, FileSize, SampleRate, ISRC, …) | `SELECT` exakt dieser Spalten | ✅ identisch |
| `djmdCue` (ID, ContentID, InMsec, InFrame, OutMsec, OutFrame, Kind, Color, ColorTableIndex, ActiveLoop, Comment, BeatLoopSize) | `SELECT` exakt dieser Spalten | ✅ identisch |
| `djmdArtist`/`djmdAlbum`/`djmdGenre`/`djmdLabel` (ID, Name) | `SELECT ID, Name` | ✅ |
| `djmdKey` (ID, ScaleName, Seq) | `SELECT ID, ScaleName, Seq` | ✅ |
| `djmdPlaylist` (ID, Seq, Name, ImagePath, Attribute, ParentID, SmartList) | `SELECT ID, Name, ParentID, Attribute` (Teilmenge) | ✅ (reicht für die Playlist-Anzeige) |
| `djmdSongPlaylist` (ID, PlaylistID, ContentID, TrackNo) | `SELECT` exakt dieser Spalten | ✅ |
| Default-Spalte `rb_local_deleted` (lokale Löschung) | wird jetzt gefiltert | ✅ angepasst (Befund 3) |

**Dokumentierte Einheiten der Einträge** (Abgleich mit `src/rekordbox/dbParser.ts`):

| Feld | Dokumentation | Unser Mapping | Status |
| --- | --- | --- | --- |
| `BPM` | BPM × 100 (z. B. `12800` = 128.00) | `normalizeBpm`: ÷100 | ✅ |
| `Length` | **ganze Sekunden** | `duration = Length` (Sekunden) | ✅ korrigiert (Befund 1) |
| `Rating` | 0..255 | 0..5-Sterne skaliert | ✅ |
| `djmdCue.InMsec`/`OutMsec` | Millisekunden; `OutMsec = -1` ohne Loop | `position = InMsec/1000`; Loop iff `OutMsec > InMsec` | ✅ |
| `djmdCue.Kind` | `0` = Memory Cue, sonst Hot-Cue-Nummer | `1..8` → Hot Cue A..H, sonst Memory | ✅ |
| Verweise (ArtistID, AlbumID, GenreID, KeyID, LabelID) | Fremdschlüssel auf `djmd*` | Join über Maps auf `ID` | ✅ |
| Verschlüsselung | SQLCipher4, globaler Schlüssel | `cipher=sqlcipher`, `legacy=4`, deobfuskiert per Base85+XOR+Inflate | ✅ (Hex-Key `402fd482…` in `tests/db-reader-keys.test.mjs` festgeschrieben) |

### 3.2 `exportLibrary.db` (OneLibrary / Device Library Plus) — vs. unsere Abfragen

| Dokumentation (pyrekordbox devicelib_plus) | `electron/dbReader.cjs` (`readOneLibraryDb`) | Status |
| --- | --- | --- |
| `content` (content_id, title, bpmx100, length, artist_id_artist, album_id, genre_id, label_id, key_id, djComment, rating, path, fileName, samplingRate, isrc, djPlayCount, analysisDataFilePath, …) | `SELECT *`, Mapping über diese Namen | ✅ identisch |
| `cue` (cue_id, content_id, kind, cueComment, isActiveLoop, inUsec, outUsec, …) | `SELECT *`; Mapper liest `kind`, `inUsec`, `outUsec`, `cueComment`, `isActiveLoop` | ✅ |
| `artist`/`album`/`genre`/`key`/`label` (`*_id`, name) | `SELECT *_id, name` | ✅ |
| `playlist` (playlist_id, sequenceNo, name, attribute, playlist_id_parent) | `SELECT playlist_id, name, playlist_id_parent, attribute` | ✅ |
| `playlist_content` (**playlist_id + content_id** + sequenceNo, ohne eigene ID) | `SELECT playlist_id, content_id, sequenceNo` | ✅ korrigiert (Befund 2) |

**Einheiten:** `bpmx100` = ×100 ✅; `rating` 0..5 ✅; Cues in **Mikrosekunden**
(`inUsec`/`outUsec`) ✅; `length` = **ganze Sekunden** ✅ korrigiert (Befund 1).
⚠️ Die pyrekordbox-Seite notiert `length` als „milliseconds" — das ist durch
reale Exporte widerlegt (drei echte `exportLibrary.db`: `195, 390, 297` für
normale Tracks, [onelibrary-connect PR #1](https://github.com/chrisle/onelibrary-connect/pull/1));
die DeviceSQL-`export.pdb` speichert die Spieldauer ebenfalls in Sekunden
([henrybetts](https://github.com/henrybetts/Rekordbox-Decoding), Zeilen-Schema
`0x54 | uint16 | Duration (seconds)`). Ebenso bestätigt
[sujay PR #45](https://github.com/tnayuki/sujay/pull/45) für `djmdContent.Length`
an 1.514 realen Zeilen: Sekunden (`FileSize*8/(BitRate*1000)/Length ≈ 1.04`).

---

## 4. Befund: Abweichungen, die unser Code hatte (alle behoben)

1. **`Length`/`length` als Millisekunden interpretiert (÷1000).**
   Dokumentation und reale Bibliotheken speichern **ganze Sekunden** — ein
   4-Minuten-Track (`Length = 240`) wäre als `0,24 s` erschienen. Behoben in
   `src/rekordbox/dbParser.ts` (`duration = Length`), Test-Fixtures auf
   dokumentierte Einheiten umgestellt.
2. **OneLibrary `playlist_content` mit nicht existierender Spalte
   `playlist_content_id` abgefragt.** Der SELECT scheiterte an realen Datenbanken
   stillschweigend (→ `__missing`), Playlist-Inhalte fehlten. Behoben:
   `playlist_id, content_id, sequenceNo` (zusammengesetzter Schlüssel).
3. **`rb_local_deleted`-Zeilen wurden mitgelesen.** Rekordbox blendet lokal
   gelöschte Einträge aus (real belegt, sujay PR). `readMasterDb` filtert sie
   jetzt; `openContentRow` behandelt sie als „nicht gefunden".
4. **`openRekordboxDb()` lieferte beim Erfolg kein `available: true`.**
   Beide Aufrufer (`readRekordboxDatabase`, `openContentRow`) brachen dadurch
   ab, sobald das native SQLCipher-Modul wirklich geladen war — in Umgebungen
   ohne natives Modul (bisherige Testläufe) trat der Fall nie auf und der Fehler
   blieb latent. **Genau dafür ist die kleine Datenbankumgebung der
   Prinzip-Nachweis:** siehe Abschnitt 5.
5. **Runtime-Preflight: die Funktionsprobe war unmöglich zu bestehen.**
   `probeCipherFunctionality` nutzte `PRAGMA key` auf einer `:memory:`-Datenbank
   — das verweigert `better-sqlite3-multiple-ciphers` grundsätzlich
   („Setting key not supported for in-memory or temporary databases"). Der
   Check `SQLCIPHER_FUNCTIONAL` fiel damit auch bei perfekt funktionierendem
   Modul auf `FAIL`. Ersetzt durch eine isolierte Probestube
   (`electron/rekordboxCipherProbe.cjs`): eine Scratch-Datei in einem
   `mkdtemp`-Verzeichnis unter `os.tmpdir()`, write + read-only-Reopen mit
   Schlüssel, danach vollständiges Aufräumen — keine Nutzerpfade, hart vom
   Hardening-Test erzwungen.
6. **Test-Annahme „natives Modul fehlt immer".**
   `tests/rekordbox-gate-hardening.test.mjs` verlangte, dass der Preflight
   `NATIVE_MODULE_RESOLVED`/`SQLCIPHER_FUNCTIONAL` als `FAIL` meldet. Auf jedem
   Rechner mit gebautem Modul (u. a. nach `npm run rekordbox:native:rebuild`)
   fiel der Test. Jetzt werden beide Realitäten geprüft: fehlendes Modul →
   Fehlerbild; vorhandenes Modul → Nachweis (OK).

Bewusst unverändert korrekt: Schlüssel-Deobfuskiation (Base85 → XOR → Inflate,
gegen die öffentlich bestätigten Werte getestet), Read-only-Modus (kein
Schreibpfad zu Quelldateien), Kind-/Loop-Semantik der Cues, BPM-Heuristik,
Rating-Skalierung, Join-Struktur.

---

## 5. Kleine eigene Datenbankumgebung (Prinzip-Nachweis der Pipeline)

Um die Kette ohne echte Benutzerbibliothek nachweisen zu können, erzeugt
`tests/support/rekordboxDbEnv.mjs` eine komplette Mini-Bibliothek im
dokumentierten Aufbau:

```
<ziel>/master.db               echte SQLCipher-master.db (djmd*, 2 Tracks + 1 lokal gelöschter,
                               Cues: Memory/Hot A/B/Active-Loop, Joins, Playlist)
<ziel>/exportLibrary.db        echte OneLibrary-Bibliothek (content/cue/…, Mikrosekunden-Cues)
<ziel>/analysis/PQT000001.DAT  ANLZ-Byteblöcke (PMAI + PPTH + PQTZ + PWV5, 480 Buckets)
<ziel>/Music/*.wav             winziges Original-Audio (read-only genutzt)
```

* Materialisieren: `npm run rekordbox:dbenv` (Ziel `artifacts/rekordbox-db-env/`,
  generiert und nicht im Git).
* Pipeline-Nachweis: `npx tsx tests/rekordbox-db-env-pipeline.test.ts` —
  14 Prüfungen über die unveränderte Produktionskette
  `electron/dbReader.cjs → src/rekordbox/dbParser.ts → Deck-Expansion` plus
  ANLZ-Blockwalk (`anlzStructure`/`anlzParser`), inkl. Read-only-Fingerprints
  und Verschlüsselungs-Nachweis am Dateiheader.
* Ohne natives SQLCipher-Modul meldet der Test SKIP (wie
  `tests/rekordbox-gate-integration.test.mjs`); mit Modul läuft die echte
  Entschlüsselung.

---

## 6. Prüfstatus

* `npm run lint` — TypeScript ohne Fehler.
* `npm test` — **70/70 Tests bestanden**, 4 umgebungsabhängige SKIPs
  (Python/PyTorch/onnxruntime fehlen in der Sandbox), 0 fehlgeschlagen.
* `npx tsx tests/rekordbox-db-env-pipeline.test.ts` — **14/14 bestanden**
  (echte SQLCipher-Byteblöcke → SQL → Einträge → TrackModel → ANLZ-Waveform).
* `node tests/db-reader-keys.test.mjs`, `npx tsx tests/rekordbox-db-import.test.ts`
  (6/6), `node tests/master-db-gate.test.mjs` (13 Gate-Codes),
  `node tests/rekordbox-gate-integration.test.mjs` — alle grün; der
  Gate-Integrationstest läuft seither **mit** echtem SQLCipher-Lauf, weil
  `openContentRow` den Erfolgsfall korrekt meldet (Befund 4).
* `node tests/rekordbox-gate-hardening.test.mjs` — prüft jetzt beide Zustände
  (Modul fehlt / Modul vorhanden + Scratch-Probe) und den Temp-Vertrag der
  Probestube (Befund 5/6).
* Offen bleibt (wie bisher) der Abgleich gegen eine echte Pioneer-Benutzer-
  bibliothek auf dem Zielrechner — die dokumentierten Aufbauten und real
  belegten Einheiten sind jedoch vollständig in der Testumgebung abgebildet.
