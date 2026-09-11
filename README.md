# airdox_SMART_Editor

**Professioneller DJ-Audio-Editor mit nicht-destruktivem Rekordbox-Import (Windows-Desktop, Electron + React).**

> **Verbindliche Grundregel des gesamten Projekts:**
> Es werden **ausschließlich die von Rekordbox bereits analysierten Daten** extrahiert und
> visualisiert. Von unserer Seite gibt es **keine Berechnungen, keine Anpassungen, keine
> Weglassungen** — nichts, was die Wahrheit der Originaldaten verzerrt. Originaldateien
> (Audio, XML, ANLZ, Datenbank) werden **niemals verändert**, nur gelesen.

Dieses Dokument ist verbindlich. Detailverträge: [`AGENTS.md`](./AGENTS.md) (Contributor-Vertrag)
und [`REKORDBOX_PIPELINE_ARCHITECTURE.md`](./REKORDBOX_PIPELINE_ARCHITECTURE.md) (Tiefenanalyse).
Ziel-Rekordbox-Version: **7.2.16**.

---

## 1. Die Pipeline auf einen Blick

```text
┌─────────────────────┐
│  Rekordbox XML       │  Export aus Rekordbox (Datei → Bibliothek exportieren)
│  COLLECTION/TRACK    │  liefert: TrackID, Location, Metadaten, Cues, TEMPO-Marker
└─────────┬────────────┘
          │  Track-Auswahl durch den Benutzer (nie automatisch)
          ▼
┌─────────────────────┐
│  master.db           │  SQLCipher-verschlüsselte Rekordbox-Datenbank,
│  djmdContent-Zeile   │  wird NUR LESEND geöffnet (SQLite readonly)
│                      │  liefert: AnalysisDataPath = Adresse der Analysedaten
└─────────┬────────────┘
          │  deterministische Auflösung: <db-root>/share/PIONEER/USBANLZ/…
          ▼
┌─────────────────────┐
│  ANLZ-Container      │  ANLZnnnn.DAT + .EXT (+ optional .2EX), read-only
│  (binär)             │  liefert: Waveform (PWAV/PWV2–PWV7), Beatgrid (PQTZ),
│                      │  Cues (PCOB/PCO2), Phrasen (PSSI), Quellpfad (PPTH)
└─────────┬────────────┘
          │  verbatim, ohne jede Umrechnung
          ▼
┌─────────────────────┐
│  Modell → Renderer   │  zeigt die Rekordbox-Werte 1:1 (Visual-Lock)
└─────────────────────┘
```

Das Original-Audio (XML-`Location`) wird davon getrennt nur für **Wiedergabe, Schnitt und
Export** geladen — niemals als Analysequelle für Rekordbox-Tracks.

---

## 2. Die Verknüpfung XML ↔ master.db (Kern-Erkenntnis)

Die zentrale Frage der Pipeline: *Welche `djmdContent`-Zeile gehört zum ausgewählten
XML-Track?* Nur diese Zeile kennt den `AnalysisDataPath` zu den echten Analysedaten.

### Die Rekordbox-eigene Zuordnung existiert

Wenn **Rekordbox selbst** die XML exportiert, schreibt es die `TrackID` aus seiner eigenen
Datenbank in die XML. `djmdContent.ID` ist die Primäridentität der Track-Zeile in
`master.db` — die Zuordnung `XML-TrackID ↔ djmdContent.ID` ist damit genau die Verbindung,
die Rekordbox intern benutzt. **Diese Zuordnung ist der Primärweg der App.**

Einzige Einschränkung: Die XML ist ein offenes Austauschformat. Drittprogramme
(Mixed In Key, Lexicon, …) dürfen gültige XMLs mit *eigenen* TrackIDs erzeugen, die mit
keiner `master.db` zusammenhängen. Deshalb wird der ID-Weg **bewacht** statt blind vertraut.

### Die zwei Verträge (in dieser Reihenfolge, deterministisch)

| # | Vertrag | Bedingung | Herkunft |
|---|---------|-----------|----------|
| 1 | **ID-Vertrag** (Primär) | XML-`TrackID` existiert **genau einmal** als `djmdContent.ID` **und** der kanonische Dateipfad (XML-`Location` ↔ `FolderPath`) ist identisch | die Rekordbox-eigene Export-Zuordnung |
| 2 | **Pfadvertrag** (Sekundär) | der exakte kanonische Dateipfad der XML kommt **genau einmal** in `djmdContent` vor; mehrdeutige Pfade (gleicher Pfad, verschiedene Analyse-Zeilen) sind hart aus dem Index ausgeschlossen | der am 09.09.2026 verifiziert funktionierende Stand `52af2dc` |
| — | **Kein Vertrag erfüllt** | → **sichtbarer Pipelinefehler** mit vollständiger Diagnose | es wird niemals geraten |

**Verboten sind und bleiben:** Titel-/Artist-/BPM-Vergleich, Dateinamens-Ähnlichkeit,
Fuzzy-Matching, Dateisystem-Scans als Zuordnungsquelle, manuelle ANLZ-Zuweisung,
PPTH-basierte Dateisuche (PPTH ist nur Diagnose-Gegenprobe).

### Kanonisierung (die einzigen erlaubten Pfad-Operationen)

Zwei Schreibweisen derselben physischen Datei müssen gleich vergleichen — mehr nicht:
- `file://`-Präfix abwerfen, URI-Decoding (`%20` → Leerzeichen)
- `\\?\`-Long-Path-Präfix abwerfen, `\` → `/`, Mehrfach-Slashes bündeln
- Windows-gerechte Kleinschreibung
- die dokumentierte Rekordbox-7-Relativform: `file://localhost//contents_<id>/…` in der XML
  entspricht `<db-root>\contents_<id>\…` in der DB (beide sind exakte Adressen derselben Datei)

Implementierung: `normalizeAudioKey`, `joinAudioPath`, `buildDbAnalysisIndex`,
`buildDbAnalysisIdIndex`, `resolveVerifiedDbIdentity` in
[`src/rekordbox/analysisResolver.ts`](./src/rekordbox/analysisResolver.ts) (pur, vollständig getestet).

### Empirische Bestätigung auf der eigenen Installation

```bash
npm run probe:identity -- --xml "C:\Pfad\zu\deinem\export.xml"
```

[`scripts/xml-db-identity-probe.mjs`](./scripts/xml-db-identity-probe.mjs) prüft read-only
jede XML-Spur gegen `djmdContent` und klassifiziert: `ID_MATCH` / `ID_PATH_CONFLICT` /
`ID_MISSING` / `ID_DUPLICATE` / `NO_LOCATION`. **PASS bei 100 % `ID_MATCH`** = der
ID-Vertrag ist für diese Bibliothek bewiesen; die App nutzt exakt die Zuordnung, die
Rekordbox selbst beim Export verwendet. Datei-Fingerprint vor/nach dem Lauf belegt die
Read-Only-Garantie; der SQLCipher-Schlüssel wird niemals ausgegeben.

---

## 3. Stationen der Pipeline im Detail

### 3.1 XML-Import (`src/rekordbox/xmlParser.ts`)

- Liest `COLLECTION/TRACK`: TrackID, Location, Metadaten, `POSITION_MARK` (Memory-Cues,
  Hot Cues, Loops), `TEMPO`-Gridmarker.
- **XML-TEMPO ist Metadatum, kein Beatgrid**: Es wird *kein* dichtes Beatgrid aus
  `firstBeat + n·60/BPM` konstruiert. Detaillierte Beat-Positionen liefert ausschließlich
  ANLZ-PQTZ.
- Die Collection ist ein Browser: kein Track landet automatisch im Deck; der Benutzer wählt.

### 3.2 Datenbank-Zugriff (`electron/dbReader.cjs`)

- Findet `master.db` automatisch (`%APPDATA%\Pioneer\rekordbox*`, verschobene Bibliotheken
  über `rekordboxAgent/storage/options.json`, z. B. `D:\PIONEER\Master\master.db`);
  die `options.json`-Adresse ist autoritativ und rangiert vor einer veralteten
  Standard-Position.
- Öffnet SQLCipher mit den dokumentierten Community-Schlüsseln **ausschließlich
  SQLite-readonly**; liest `djmdContent` (+ Artist/Album/Genre/Key/Label/Cues/Playlists)
  und schließt sofort.
- XML-Tracks werden nur mit der Desktop-`master.db` verknüpft (OneLibrary/Device Library
  Plus ist ein eigener Identitäts-Namensraum). Genau **eine** Desktop-Bibliothek besitzt
  den XML-Namensraum — Zeilen mehrerer gefundener DBs werden nie vermischt.
- Parallele Ladevorgänge werden serialisiert (Single-Flight): ein zweiter Deck-Load sieht
  nie einen halb gebauten Index.

### 3.3 AnalysisDataPath-Auflösung (`src/rekordbox/analysisResolver.ts`)

- `AnalysisDataPath` wird **nur** relativ zum Verzeichnis der tatsächlich geöffneten
  `master.db` aufgelöst: führende Separatoren und optionales `share/` abstreifen, dann
  unter `<db-root>/share/PIONEER/USBANLZ/…` auflösen. Absolute Pfade gelten verbatim.
- Traversal (`..`) und Nicht-USBANLZ-Formen werden abgelehnt → Pipelinefehler, keine Suche.

### 3.4 ANLZ-Dekodierung (`src/rekordbox/anlzParser.ts`)

Dekodiert gegen die dokumentierte Binärstruktur (Deep Symmetry / Kaitai / rekordcrate):

| Tag | Inhalt | Behandlung |
|-----|--------|------------|
| `PPTH` | Quellpfad der analysierten Audiodatei | nur Plausibilitäts-Gegenprobe/Diagnose |
| `PQTZ` | Beatgrid: **jede** Beat-Zeit + per-Beat-BPM | verbatim; nie durch uniforme Rekonstruktion ersetzt, nie ein generierter Tail angehängt |
| `PCOB`/`PCPT` | klassische Cues/Loops | unverändert übernommen |
| `PCO2`/`PCP2` | erweiterte (nxs2) Cues inkl. Farben/Kommentaren | unverändert übernommen |
| `PWAV`/`PWV2`–`PWV7` | Waveform-Varianten (Preview, Detail, Farbe, 3-Band) | Höhen-/Farbwerte sind die gespeicherten Bits — keine Mischformeln, keine Glättung, kein Peak-Hold |
| `PSSI` | Song-Struktur/Phrasen (inkl. XOR-Maskierung) | Phrasengrenzen aus echten PQTZ-Beat-Positionen, nie aus `BPM·n` geschätzt |

- Geschwister-Container werden deterministisch geladen: gleiche Adresse, nur Extension
  getauscht (`.DAT` ↔ `.EXT`, optional `.2EX`). Die EXT trägt Farb-Waveform (PWV5),
  Phrasen (PSSI) und Farb-Cues (PCO2). Ein unlesbarer EXT-Geschwister ist ein sichtbarer
  Pipelinefehler; ein fehlender optionaler 2EX ändert nichts.

### 3.5 Visualisierung — der Visual-Lock (`src/waveform/renderModel.ts`, `DetailWaveform`, `TrackOverview`)

- **PWV5 (RGB-Detail):** die gespeicherten 3-Bit-Farbkomponenten SIND die Spaltenfarbe,
  der 5-Bit-Wert die Höhe.
- **PWAV/PWV2/PWV3 (blau):** 5-Bit-Höhe + dokumentierte 3-Bit-Whiteness → authentische
  Blau-Rampe.
- **3-Band:** dunkelblau/bernstein/weiß auf derselben Achse, wie das Original.
- **Ohne ANLZ ehrlich leer:** keine Pseudo-Amplituden, keine Vorschau-Konturen, keine
  Hüllkurven. Sichtbar bleiben nur importierte Gitterdaten + Klartext-Status
  (`MISSING_REKORDBOX_ANALYSIS`). Rekordbox zeichnet ohne Analysedaten auch nichts.
- Kein Demo-Track, keine synthetischen Fallbacks, keine Template-Phrasen im App-Code.

### 3.6 Schreibpfad (nicht-destruktiv)

Exporte/Projekte werden nur als **neue Dateien** gespeichert; `electron/pathGuard.cjs`
verweigert hart jedes Überschreiben einer Original-Rekordbox-Quelle. Projektformat
`.airdox.json` referenziert Original-Audio per Read-Only-Pfad statt es zu duplizieren.

---

## 4. Fehlerphilosophie: Wahrheit vor Komfort

Jeder Schritt, der nicht deterministisch liefern kann, bricht **sichtbar** ab:

- Kein DB-Datensatz → `[ANLZ Pipelinefehler]` mit XML-Adresse, DB-Zählwerten und Diagnose.
- `AnalysisDataPath` nicht auflösbar → Fehler, keine Suche.
- ANLZ-Container ohne lesbare PWAV/PWV-Wellenform → Fehler, kein Ersatz.
- Alle Entscheidungsparameter landen zusätzlich im dauerhaften Log
  (`%APPDATA%/airdox_SMART_Editor/airdox-smart-editor.log`), sodass jede fehlende Waveform
  nachträglich auf den exakten fehlgeschlagenen Schritt zurückführbar ist.

---

## 5. Nachweise (Stand 11.09.2026)

| Nachweis | Umfang | Ort |
|----------|--------|-----|
| Unit-/Integrationssuite | **114 Checks grün** (`npm test`), inkl. Vertrags-Tests der Verknüpfung und der Identitätsprobe | `tests/` |
| Typprüfung | `tsc --noEmit` ohne Fehler | — |
| **End-to-End mit Screenshots** | echte App im Headless-Chromium, echte binäre ANLZ-Container, simulierte `master.db`; 8/8 Assertions: ID-Vertrag ✓, Pfadvertrag ✓, Pipelinefehler ohne Ersatzdaten ✓ | [`docs/e2e-proof/`](./docs/e2e-proof/README.md) |
| Identitätsprobe (lokal ausführbar) | bestätigt `XML-TrackID == djmdContent.ID` auf der realen Installation | `npm run probe:identity` |

Herkunft der vereinigten Pipeline: funktionierender DB-/Visual-Lock-Stand `52af2dc`
(09.09.2026, ~23:00 Uhr, Branch `arena/01a0880b`) + strenger ANLZ-Primärpfad aus
`arena/01a08dc7`, zusammengeführt am 11.09.2026 (`bb67594`).

---

## 6. Entwicklung

**Voraussetzungen:** Node.js ≥ 20; für den DB-Import das native Modul
`better-sqlite3-multiple-ciphers` (`npm run rebuild:electron`, im CI automatisch).

```bash
npm install
npm run dev            # Vite-Dev-Server (Browser, ohne Desktop-Bridge)
npm run desktop        # Build + Electron (voller Desktop-Funktionsumfang)
npm test               # komplette Suite (114 Checks)
npm run lint           # tsc --noEmit
npm run probe:identity # XML↔master.db-Identitätsnachweis (read-only)
npm run package:win    # Windows-Build (NSIS + Portable), siehe BUILD_WINDOWS.md
```

**Bevor du Pipeline-Code änderst:** [`AGENTS.md`](./AGENTS.md) und
[`REKORDBOX_PIPELINE_ARCHITECTURE.md`](./REKORDBOX_PIPELINE_ARCHITECTURE.md) lesen —
beide sind für jeden menschlichen und automatisierten Contributor bindend.
