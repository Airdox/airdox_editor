# Pipeline-Stufenplan – Rekordbox-Daten read-only extrahieren und darstellen

**Stand: 2026-09-10** · Ergänzt `VORHABEN.md` und `docs/ROADMAP_0.4.20_PLUS.md`.
Dieses Dokument ist die Bauanleitung: Die Pipeline wird **stufe für Stufe** aufgebaut,
jede Stufe hat einen eigenen Trockenübungs-Befehl und eine messbare Evidenz.
Eine Stufe gilt erst dann als fertig, wenn ihr Befehl grün ist – nicht wenn der Code exists.

## 1. Harte Regeln (gelten in jeder Stufe)

1. **Nur lesen.** `master.db`, `exportLibrary.db`, `rekordbox.xml`, ANLZ-Dateien und
   Audio werden ausschließlich mit Read-Only-Zugriff geöffnet. Kein `sqlcipher_export`,
   keine Kopie, kein Temp-File neben der Quelle.
2. **Nichts erfinden.** Es existiert kein Fallback, der eine Wellenform berechnet,
   interpoliert, schätzt oder aus BPM/Dateigröße ableitet. Fehlt die Quelle, bleibt die
   Spur leer oder zeigt explizit „VORSCHAU“ (Beatgrid-Kontur aus importierten BPM).
3. **Nichts ändern.** Weder Metadaten noch Cue-Positionen noch Amplituden werden
   „bereinigt“, gerundet oder umgerechnet, außer mit dokumentierter, verlustfreier
   Skalierung (z. B. BPM × 100 → BPM, 5-Bit-Wert ÷ 31).
4. **Keine Daten liegen lassen.** Jede lesbare Sektion einer Quelle wird entweder
   verwendet oder im Bericht als „vorhanden, nicht genutzt“ aufgeführt.
5. **Herkunft immer sichtbar.** Jeder Wert trägt `REKORDBOX_XML`, `REKORDBOX_DB` oder
   `REKORDBOX_ANLZ`; der Renderer darf nur diese drei Quellen zeichnen.

## 2. Pipeline im Überblick

```
rekordbox.xml ──► [1] TrackID, Location, POSITION_MARK, TEMPO
                        │  (Schlüssel: TrackID bzw. normierter Location-Pfad)
                        ▼
master.db (SQLCipher, D:) ──► [2] djmdContent: BPM, Length, Cues, AnalysisDataPath
                                     │  (deterministische Pfadableitung, kein Suchen)
                                     ▼
<Pfad>/ANLZnnnn.DAT + .EXT ──► [3] Tag-Inventar: PPTH, PQTZ, PWAV/PWV2…PWV7, PCOB/PCO2, PSSI
                                     │
                                     ▼
                          [4] Modell (Beatgrid, Cues, Loops, Phrasen, Wellenform)
                                     │
                                     ▼
                          [5] Renderer + Palette (nur PWV-Daten, keine Berechnung)
                                     │
                                     ▼
                          [6] Provenance/Log  →  [7] Export/Projekt (nur NEUE Dateien)
```

## 3. Die Stufen

### Stufe 0 – Master-DB-Zugriff (Trockenübung) ✅ gebaut, lokal verifiziert

**Frage:** Kommen wir überhaupt an die verschlüsselte `master.db` auf `D:` heran?

**Befehl:**

```bat
npm run probe:masterdb
node scripts/masterdb-probe.mjs --db "D:\rekordbox\dataSources\master.db"
node scripts/masterdb-probe.mjs --root "D:\" --limit 5 --json masterdb-report.json
node scripts/masterdb-probe.mjs --track 12345
```

**Was passiert:** Datei lokalisieren (Auto-Suche `%APPDATA%\Pioneer\rekordbox*`,
`rekordboxAgent\storage\options.json` → `db-path`, plus `--root`), SHA-256-Fingerabdruck
vorher, Entschlüsselung **im Speicher** mit dem master.db-Schlüssel
(`cipher=sqlcipher`, `legacy=4`, SQLite `readonly`), Schema-Scan, Zeilenzahlen,
`AnalysisDataPath`-Füllgrad, Stichproben, Fingerabdruck nachher.

**Evidenz (Gate):** `[10] Fingerabdruck NACHHER = PASS` (SHA-256, Größe und mtime
identisch) **und** `ERGEBNIS: PASS`. Der Schlüssel wird niemals ausgegeben, nur maskiert
(`402fd4… (64 Zeichen, sha256 ff44e872)`).

**Test:** `node tests/masterdb-probe.test.mjs` – erzeugt eine echt verschlüsselte
`master.db`-Fixture, führt die CLI als eigenen Prozess aus und prüft Zählwerte,
Read-Only-Beweis, „keine Kopie entstanden“ sowie die Negativfälle (beschädigte Datei →
Exit 1).

**Status:** lokal grün (Fixture). **Auf dem Windows-Rechner mit der echten `D:`-Bibliothek
noch auszuführen** – das ist der nächste Handschlag.

---

### Stufe 1 – XML-Bibliothek ✅ vorhanden

`src/rekordbox/xmlParser.ts` liest `COLLECTION/TRACK` mit `Location`, `Name`, `Artist`,
`AverageBpm`, `TEMPO`-Beatgrid und `POSITION_MARK` (robust gegen `CUE`/`HOT_CUE`/
`MEMORY_CUE`/`MARK` und alternative Attributnamen).

**Schlüssel für Stufe 2:** `TrackID` sowie der normierte `Location`-Pfad
(`normalizeAudioKey` in `src/rekordbox/analysisResolver.ts`: `file://`, `\\?\`,
Groß/Kleinschreibung, Trennzeichen).

**Gate:** `tsx tests/xml-exclusive-import.test.ts` – keine Waveform/Phrasen ohne echte
Quelle, Cue-Parser ohne Positions-Attribut ignoriert.

---

### Stufe 2 – Datenbankabfrage zur Track-ID ✅ vorhanden, Regression heute ergänzt

**Korrektes Statement für `master.db`** (Rekordbox 6/7, `djmd*`-Schema):

```sql
SELECT ID, Title, ArtistID, BPM, Length, FolderPath, FileNameL, AnalysisDataPath
FROM djmdContent
WHERE ID = 12345;
```

**Korrektes Statement für `exportLibrary.db`** (OneLibrary / Device Library Plus):

```sql
SELECT id, title, bpm, duration, folder_path, file_name, analysis_data_path
FROM content
WHERE id = '<uuid>';
```

Audiopfad-Regel (beobachtet an der echten `D:\PIONEER\Master\master.db` am
10.09.2026): `FolderPath` enthält versionsabhängig bereits den **vollen Dateipfad**,
`FileNameL` wiederholt den Basisnamen. `joinAudioPath()` in
`src/rekordbox/analysisResolver.ts` übernimmt `FolderPath` daher unverändert, wenn es auf
`FileNameL` endet (case-insensitiv), und fügt sonst mit erkanntem Separator – die naive
Verkettung (`…/x.mp3x.mp3`) würde den XML↔DB-Exakt-Match lautlos brechen. Regressionstests
in `tests/analysis-resolver.test.ts`.

**Gate:** `tsx tests/rekordbox-db-import.test.ts` **und** der neue Block in
`tests/masterdb-probe.test.mjs`, der `readRekordboxDatabase()` gegen die verschlüsselte
Fixture aufruft (`available: true`, 3 Tracks, 5 Cues, `BPM = 12400` roh,
`AnalysisDataPath` unverändert).

---

### Stufe 3 – Analysepfad deterministisch auflösen ✅ vorhanden

`resolveAnalysisFilePath(dbDir, AnalysisDataPath)` in
`src/rekordbox/analysisResolver.ts`:

* absolute Pfade (Laufwerk/UNC/`file://`) werden **wörtlich** benutzt;
* `/PIONEER/USBANLZ/...` bzw. `share/PIONEER/...` → `<ordner der Datenbank>/share/PIONEER/USBANLZ/...`;
* jede andere Form → `null` (manuelle Zuordnung), **kein** Suchen, kein Raten,
  kein Zusammenbauen aus Tracknamen.

Danach wird immer das Geschwister-Paar geladen: `deriveSiblingExtension` → `ANLZnnnn.DAT`
**und** `ANLZnnnn.EXT` (Farb-Waveform `PWV5`, Phrasen `PSSI`, Farb-Cues `PCO2` liegen nur
in der `.EXT`; `.2EX` ist der CDJ-3000-Container).

**Fallback ohne SQLCipher:** PPTH-Scan (`scanAnlzForPaths` in `electron/dbReader.cjs`) –
liest nur die 1 KB Header der ANLZ-Container.

**Gate:** `tsx tests/analysis-resolver.test.ts`, `node tests/anlz-ppth-scan.test.mjs`.

---

### Stufe 4 – ANLZ-Tag-Inventar ✅ gebaut, lokal verifiziert

**Befehl:**

```bat
npm run probe:anlz -- --db "<master.db>" --track 12345
npm run probe:anlz -- --anlz "D:\…\ANLZ0000.DAT"
```

**Ausgabe (read-only):** Dateigröße DAT/EXT/.2EX, `PPTH`-Pfad + Plausibilitätsvergleich
mit `FolderPath+FileNameL`, alle gefundenen Tags, pro Waveform-Tag
`len_entry_bytes`/`len_entries`/Stil, Anzahl PQTZ-Beats (inkl. Zeitfenster), Cue-/Loop-Zahl,
PSSI (maskiert/unmaskiert, Mood, Bank, End-Beat) sowie vorhandene, aber nicht dekodierte
Tags („keine Daten liegen lassen“). Die CLI läuft über `tsx` mit **demselben** Parser wie
der App-Pfad (`src/rekordbox/anlzParser.ts`); das Inventar (`tagInventory`) wird dort
read-only mitgeführt und nicht separat nachimplementiert.

**PPTH-Plausibilität ([6]):** `classifyPpthPlausibility()` in
`src/rekordbox/analysisResolver.ts` unterscheidet drei deterministische Fälle: `EXACT`
(normalisierte Vollpfade identisch), `PLACEHOLDER_BASENAME` (rekordbox schreibt für
manche Analysen `?/` + Basisname statt Laufwerk+Verzeichnis – Rohdaten-Evidenz
`003f002f…` vom 10.09.2026; dann wird der **exakte** Basisname geprüft, kein Fuzzy) und
`MISMATCH` (WARN + Rohdaten-Diagnose). Die Zuordnung der Container stammt immer aus
`analysisResolver` bzw. dem PPTH-Tier-1-Scan, nie aus der Plausibilitätsprüfung.

**Gate:** mindestens `PPTH + PQTZ/PQT2 + ein dekodierbarer PWV*-Tag`, sonst FAIL
(kein „grün“ ohne Evidenz). Zusätzlich `[7] Fingerabdruck NACHHER = PASS`.

Existiert der deterministisch aufgelöste Pfad nicht, greift der in Stufe 3 definierte
Fallback: PPTH-Scan der Standardordner (inkl. `<dbDir>/USBANLZ`-Varianten), **nur exakte
Tier-1-Treffer** (PPTH == Audiopfad, kein Fuzzy); die Quelle dieser Pfadwahl wird in der
Ausgabe genannt (`analysisResolver` vs. `PPTH-Scan`).

**Test:** `npx tsx tests/anlz-probe.test.ts` – baut `master.db` + `share/PIONEER/USBANLZ`
mit den echt-formatigen Fixtures (.DAT: PMAI/PPTH/PQTZ/PCOB/PWV5; .EXT: PCO2/PWV3/PWV7/PSSI),
führt die CLI als Prozess aus und prüft Gate, Inventarwerte (PWV5 = 2 Bytes/600/`RGB_5BIT`,
PWV3 = 1 Byte/900/`MONO_5BIT`, PWV7 = 3 Bytes/900/`TRIPLE_BYTE`), PPTH-Exakttreffer,
Read-Only-Beweis und den Negativfall (PPTH-only → Exit 1).

**Status:** lokal grün (Fixture). **Auf dem Windows-Rechner mit einem echten Track aus der
`D:`-Bibliothek noch auszuführen** – erst dann ist die Stufe gegen echte Daten bestätigt.

---

### Stufe 5 – Darstellung ausschließlich aus PWV ✅ vorhanden

`src/rekordbox/anlzParser.ts` dekodiert die Sektionen; `src/waveform/renderModel.ts`
und `DetailWaveform` zeichnen **nur** diese Arrays. Eigene Peak-Analyse
(`analyzeAudioBuffer`) wird für Rekordbox-Tracks nie aufgerufen.

**Gate:** `node scripts/waveform-gates.mjs` (`npm run verify:waveform`) +
`tsx tests/waveform-variants.test.ts`.

---

### Stufe 6 – Herkunft sichtbar + dauerhaftes Log ✅ vorhanden

Status-Chips im Track-Header, Footer-Hinweis in der Wellenform, Spiegelung aller
Entscheidungsparameter nach `<userData>/airdox-smart-editor.log`
(`electron/logWriter.cjs`).

**Gate:** `node tests/log-writer.test.mjs`.

---

### Stufe 7 – Schreiben nur in neue Dateien ✅ vorhanden

`saveExportFile` / `openProjectFile` mit `electron/pathGuard.cjs`: Kollision mit einem
Originalpfad → Abbruch statt Überschreiben.

**Gate:** `node tests/path-guard.test.mjs`, `tsx tests/project-file.test.ts`.

## 4. Korrekturen am eingereichten Workflow

Der eingereichte Entwurf ist in der Struktur richtig; diese Punkte weichen von der
tatsächlichen Implementierung ab und wurden übernommen:

| Entwurf | Korrektur (verifiziert) |
|---|---|
| `sqlcipher master.db "ATTACH … sqlcipher_export('plaintext') …"` | **Nicht verwendet.** Die Entschlüsselung läuft im Prozess (`better-sqlite3-multiple-ciphers`, SQLite `readonly`); es entsteht keine unverschlüsselte Kopie der Bibliothek. Nebenbei: `sqlcipher.exe` ist kein Bestandteil der App und unter Windows nicht vorhanden. Variante B (Kopie) ist nur als Notlösung zulässig, dann in `%TEMP%` außerhalb des Rekordbox-Ordners und mit Löschung nach dem Lauf. |
| `SELECT file_path FROM content WHERE id = 'TRACK_ID'` | `content`/`file_path` ist **OneLibrary** (`exportLibrary.db`). In `master.db` heißt die Tabelle `djmdContent` und die Spalte `AnalysisDataPath`; `ID` ist eine Ganzzahl. |
| Pfad `%APPDATA%\Pioneer\rekordbox\master.db` | Rekordbox legt die Version im Ordnernamen ab (`rekordbox7`, `rekordbox6`) **und** den echten Speicherort in `rekordboxAgent\storage\options.json` (`db-path`) – hier `D:`. Beides wird gesucht, `--root "D:\"` zusätzlich. |
| Block-Header `[0x08-0x0B] Block Length` | Richtig, aber unvollständig: Envelope ist `Tag(4) + len_header(+4) + len_tag(+8)`; vor dem ersten Tag steht ein `PMAI`-Dateikopf, dessen `len_header` übersprungen werden muss. `PPTH` trägt zusätzlich `len_path` bei `+0x0c`. |
| `PWV3` = „High-Resolution RGB“ | Laut implementierter Spezifikation: `PWV3` = 1 Byte/Spalte (5-Bit-Mono), `PWV4` = 6 Bytes/Spalte (Farbe), `PWV5` = 2 Bytes/Spalte (RGB 5-Bit), `PWV6`/`PWV7` = 3 Bytes/Spalte (Mid, High, Low). Priorität: `PWV7 > PWV5 > PWV6 > PWV4 > PWV3 > PWV2 > PWAV`. |
| `PWAV`/`PWV2` „Amplituden 0–255“ | `PWAV` = 5-Bit-Wert im Byte (`& 0x1F` / 31), `PWV2` = 4-Bit-Wert (`& 0x0F` / 15), `PWV5` = 5-Bit-Peak + 3×3-Bit-Bandenergie in einem Big-Endian-UInt16. |
| „Amplituden auf Pixeldichte skalieren“ | Zulässig ist ausschließlich **Aggregation vorhandener Stützstellen** (max-Wert pro Pixel). Neue Stützstellen werden nicht erzeugt. |
| `PFIX` | In der implementierten Spezifikation nicht vorhanden; erweiterte Cues kommen aus `PCO2` (Einträge `PCP2`), klassische aus `PCOB` (Einträge `PCPT`). |
| PPTH immer voller Pfad | Echte Analysen dieser Bibliothek tragen `?/<Basisname>` im PPTH (UTF-16BE, Rohdaten `003f002f…` – kein Encoding-Fehler). `classifyPpthPlausibility()` prüft dann den exakten Basisname (`PLACEHOLDER_BASENAME`); Vollpfad-Vergleich bleibt für echte Pfade (`EXACT`), alles andere `MISMATCH`. |
| `FolderPath` + `FileNameL` naiv verkettet | Echte Rekordbox-7-DBs speichern in `FolderPath` teils den vollen Pfad; `FileNameL` wiederholt den Basisnamen (`…/x.mp3x.mp3`). Neue Regel `joinAudioPath()` (analysisResolver.ts, auch von `dbParser.ts` genutzt): endet `FolderPath` auf `FileNameL`, wird es unverändert übernommen. |

## 5. Befund vom 2026-09-10

Die Trockenübung hat einen echten Fehler im App-Pfad gefunden: `openRekordboxDb()` in
`electron/dbReader.cjs` lieferte bei Erfolg `{ db, dbType }` **ohne** `available: true`.
`readRekordboxDatabase()` prüft aber `if (!opened.available) return opened;` – damit wurde
jede erfolgreich entschlüsselte Datenbank sofort als „nicht verfügbar“ zurückgegeben (und
das offene Handle nie geschlossen). `src/App.tsx` prüft `!result.available || !result.rows`
und meldet dann genau das. **Behoben** (`{ available: true, db, dbType }`) und durch
`tests/masterdb-probe.test.mjs` abgesichert.

## 6. Datenvertrag: welche Bytes werden welche Pixel

| Quelle | Tag/Spalte | Inhalt | Verwendung |
|---|---|---|---|
| `master.db` | `djmdContent.BPM`, `Length`, `SampleRate`, `Rating`, `KeyID` | Metadaten | Header, Sortierung, Filter |
| `master.db` | `djmdCue.InMsec/OutMsec/Kind/Color/Comment` | Cues/Loops | Marker (nur wenn ANLZ keine hat) |
| `master.db` | `djmdContent.AnalysisDataPath` | Verweis auf ANLZ | Stufe 3 |
| ANLZ `.DAT` | `PPTH` | Original-Audiopfad | Zuordnungsprüfung |
| ANLZ `.DAT` | `PQTZ`/`PQT2` | Beat-Nummer, Tempo × 100, Zeit ms | Beatgrid-Linien |
| ANLZ `.DAT` | `PCOB`/`PCPT` | klassische Cues | Marker |
| ANLZ `.EXT` | `PWV5` | 2 Byte/Spalte, RGB 5-Bit + Peak | Farb-Wellenform |
| ANLZ `.EXT` | `PCO2`/`PCP2` | erweiterte Cues, Farbe, Kommentar | Marker |
| ANLZ `.EXT` | `PSSI` | Phrasen (XOR-maskiert) | Phrasen-Bänder |
| ANLZ `.2EX` | `PWV6`/`PWV7` | 3 Bytes/Spalte (Mid, High, Low) | 3-Band-Wellenform |

## 7. Quellen

* Deep Symmetry – Analysis Files: https://djl-analysis.deepsymmetry.org/
* pyrekordbox ANLZ-Format: https://pyrekordbox.readthedocs.io/en/latest/formats/anlz.html
* crate-digger (Kaitai-Spec): https://github.com/Deep-Symmetry/crate-digger
* Rekordbox-Datenbank-Verschlüsselung: https://github.com/dylanljones/pyrekordbox,
  https://github.com/liamcottle/pioneer-rekordbox-database-encryption
* Rekordbox/AlphaTheta: https://rekordbox.com
