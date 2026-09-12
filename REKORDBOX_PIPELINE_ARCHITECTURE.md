# Rekordbox-XML → `master.db` → ANLZ → Visualisierung

**Architektur- und Verifikationsbericht**  
Stand: 11. September 2026

## 1. Ergebnis in einem Satz

Airdox muss eine XML-Spur zuerst **nachweisbar und eindeutig** derselben `djmdContent`-Zeile in der Desktop-`master.db` zuordnen, ausschließlich deren `AnalysisDataPath` auflösen, die adressierten `.DAT`/`.EXT`/`.2EX`-Dateien als PMAI/ANLZ dekodieren und deren Beat-, Cue-, Phrasen- und Waveformwerte ohne Audioanalyse, Synthese, Glättung, Mittelung oder Peak-Hold bis zum Renderer transportieren.

Der derzeit entscheidende offene Punkt ist nicht das ANLZ-Format, sondern die Identitätsrelation:

> Die offizielle XML-Spezifikation garantiert, dass `COLLECTION/TRACK@TrackID` eine Spur **in dieser XML** identifiziert und dass Playlist-Keys darauf verweisen können. Sie garantiert nicht öffentlich, dass dieser Wert mit `master.db.djmdContent.ID` identisch ist.

Eine direkte SQL-Abfrage `WHERE djmdContent.ID = XML.TrackID` darf deshalb erst zum Produktvertrag werden, nachdem sie an einem zusammengehörigen XML/`master.db`-Fixture vollständig bestätigt wurde. Das ist keine Fallback-Suche, sondern die einmalige Verifikation des Primärschlüssels.

---

## 2. Evidenzklassen

| Klasse | Bedeutung | Verwendete Quellen |
|---|---|---|
| **A – offiziell** | Von Pioneer DJ/AlphaTheta veröffentlichter Vertrag | rekordbox Developer-Seite und XML-Format-PDF; offizielle OneLibrary-Produktinformationen |
| **B – reif reverse-engineered** | Nicht offiziell spezifiziert, aber unabhängig dokumentiert und in mehreren Parsern implementiert | Deep Symmetry/crate-digger/Kaitai, pyrekordbox, rekordcrate |
| **C – installationsspezifisch zu verifizieren** | Kann nur mit einem zusammengehörigen Datenpaar sicher entschieden werden | XML-ID ↔ Desktop-DB-ID; konkreter verschobener Windows-Datenbankroot; konkrete Rekordbox-Version |

### Öffentliche Dokumentationsgrenze

Die [offizielle rekordbox-Developer-Seite](https://rekordbox.com/en/support/developer/) veröffentlicht den XML-Austauschweg und die [XML-Formatspezifikation](https://cdn.rekordbox.com/files/20200410160904/xml_format_list.pdf). Eine öffentliche Hersteller-Spezifikation für SQLCipher-Schema und Semantik der Desktop-`master.db` oder für die binären ANLZ-Taglayouts wurde nicht gefunden. rekordcrate weist entsprechend darauf hin, dass diese Strukturen aus Reverse Engineering stammen. Die ANLZ-Erkenntnisse sind dennoch belastbar, weil Deep Symmetry sie als Kaitai-Struktur formalisiert hat und pyrekordbox sowie rekordcrate sie unabhängig implementieren.

---

## 3. Drei Datenbankformate dürfen nicht vermischt werden

| Format | Zweck/Ort | Technik | Track-/ANLZ-Adressierung | Bedeutung für Airdox |
|---|---|---|---|---|
| Desktop **`master.db`** | Aktive Rekordbox-6/7-Sammlung auf dem Computer bzw. verschobener Master-Datenbankroot | SQLCipher-4-verschlüsseltes SQLite; Schema reverse-engineered | `djmdContent.ID`; `djmdContent.AnalysisDataPath` relativ zum Desktop-Datenbankroot | **Für diesen Workflow autoritativ** |
| Legacy Device Library **`PIONEER/rekordbox/export.pdb`** | Exportmedium für klassische CDJ/XDJ-Geräte | proprietäres, seitenbasiertes DeviceSQL/PDB-Format, little-endian | Trackzeile enthält Track-ID und Pfad zur exportierten ANLZ-Datei | Nicht als Ersatz für die Desktop-DB verwenden |
| Device Library Plus / heute **OneLibrary `PIONEER/rekordbox/exportLibrary.db`** | Exportmedium für neuere Hardware und herstellerübergreifenden USB-Export | separates SQLCipher-SQLite-Schema; ähnlich, aber nicht identisch mit `master.db` | `content.content_id`, `masterDbId` und `analysisDataFilePath` sind formatinterne Felder | Nicht mit `djmdContent` oder XML-ID gleichsetzen |

AlphaTheta beschreibt offiziell Device Library und OneLibrary als zwei Bibliotheksformate für unterschiedliche Geräte; aktuelle Rekordbox-Versionen können beide auf ein Medium schreiben ([offizielle Kompatibilitätsmitteilung](https://alphatheta.com/en/information/important-notice-for-customers-using-usb-devices-with-our-dj-equipment/)). Die Low-Level-Strukturen sind dagegen nicht Teil dieses offiziellen Produktvertrags. Deep Symmetry dokumentiert `export.pdb` als DeviceSQL-Exportdatei und warnt durch die getrennte Struktur implizit vor einer Gleichsetzung mit Desktop-SQLite ([Database Exports](https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/exports.html)).

**Konsequenz:** Eine „Rekordbox-ID“ ist ohne Namensraum bedeutungslos. Das interne Modell muss mindestens `xmlTrackId`, `desktopContentId`, `devicePdbTrackId` und `oneLibraryContentId` getrennt benennen. Airdox braucht hier nur die ersten beiden.

---

## 4. XML-Vertrag

### 4.1 Offiziell definierte Felder

`DJ_PLAYLISTS/COLLECTION/TRACK` liefert unter anderem:

- `TrackID`: vorzeichenbehaftete Ganzzahl, Identifikation der Spur in der XML;
- `Location`: obligatorische URI inklusive Dateiname;
- `AverageBpm`: durchschnittliches Tempo;
- `Tonality`: Tonart;
- `TotalTime` sowie weitere beschreibende Metadaten;
- null bis mehrere `TEMPO`-Elemente mit `Inizio`, `Bpm`, `Metro`, `Battito`;
- null bis mehrere `POSITION_MARK`-Elemente mit Typ, Start-/Endposition, Name und Cue-Nummer.

Playlist-Nodes definieren über `KeyType`, ob `PLAYLISTS/.../TRACK@Key` auf `COLLECTION/TRACK@TrackID` oder `Location` verweist. Das ist die einzige offiziell erklärte ID-Relation.

### 4.2 Was daraus **nicht** folgt

Aus dem Namen `TrackID` folgt nicht automatisch:

```text
XML TrackID == desktop master.db djmdContent.ID
```

Warum dies als allgemeiner Vertrag unmöglich ist:

1. XML ist ausdrücklich ein Import-/Export-Austauschformat. Ein Drittprogramm darf gültige TrackIDs erzeugen, ohne Zugriff auf irgendeine `master.db` zu haben.
2. Eine XML kann in eine andere Rekordbox-Sammlung importiert werden; dort entstehen lokale DB-Identitäten.
3. Die private Desktop-Tabelle besitzt mehrere Identitätsfelder (`ID`, `UUID`, `MasterSongID`, `rb_file_id`, `MasterDBID`). Deren genaue lebenszyklusübergreifende Semantik ist nicht offiziell dokumentiert.
4. Der XML-Vertrag beschreibt ausschließlich den XML-internen Verweis von Playlist-Key zu Collection-Track.

Für eine **von derselben laufenden Rekordbox-Sammlung exportierte XML** kann Rekordbox praktisch denselben Zahlenwert verwenden. Das ist eine plausible Hypothese, aber derzeit weder Herstellervertrag noch Fixture-belegte Tatsache für die konkrete Installation.

### 4.3 Erforderlicher XML-Importvertrag

Der Parser muss Rohwerte erhalten und darf fehlende Werte nicht erfinden:

```ts
interface XmlTrackRecord {
  xmlTrackId: string;       // exakter Attributtext; zusätzlich streng als int32 validieren
  locationUri: string;      // exakter URI-Text
  decodedLocation: string;  // ausschließlich RFC/URI-Decoding, keine Suche
  averageBpm?: number;
  tonality?: string;
  totalTimeSec?: number;
  tempos: Array<{
    inizioSec: number;
    bpm: number;
    metroRaw?: string;
    battito?: number;
  }>;
  positionMarks: Array<{
    name?: string;
    type: number;
    startSec: number;
    endSec?: number;
    num?: number;
    rawAttributes: Record<string, string>;
  }>;
  rawAttributes: Record<string, string>;
}
```

Keine Defaultwerte wie 130 BPM, `2A`, fünf Minuten Dauer oder ein erzeugtes dichtes Beatgrid. XML-`TEMPO`-Marker bleiben XML-Daten; sie sind nicht die ANLZ-Waveform und dürfen nicht in Waveformhöhen übersetzt werden.

---

## 5. Nachweis der XML-zu-`master.db`-Identität

### 5.1 Einmaliges Read-only-Verifikationsverfahren

Benötigt werden eine XML und exakt die `master.db`, aus der sie exportiert wurde. Das Verfahren verändert keine Datei.

1. DB-Root = Verzeichnis der tatsächlich geöffneten `master.db` protokollieren.
2. Alle XML-`TrackID`-Werte als int32 und alle XML-Locations URI-dekodieren.
3. Für jede XML-Spur exakt abfragen:

```sql
SELECT
  ID, UUID, MasterDBID, MasterSongID, rb_file_id,
  FolderPath, FileNameL, AnalysisDataPath
FROM djmdContent
WHERE ID = ?;
```

4. Ergebnisse klassifizieren:
   - **0 Zeilen:** ID-Gleichheit widerlegt oder falsche DB geöffnet.
   - **1 Zeile:** Kandidat; physische Datei muss durch exakte Pfadkanonisierung mit XML-Location übereinstimmen.
   - **>1 Zeile:** Schema-/Abfragefehler; `ID` sollte Primäridentität sein.
5. Für die gesamte Stichprobe bzw. bevorzugt die komplette XML folgende Invarianten verlangen:
   - 100 % genau eine ID-Zeile;
   - 100 % exakte kanonische Übereinstimmung der physischen Datei;
   - 100 % nichtleerer `AnalysisDataPath` für die untersuchten analysierten Tracks;
   - keine Kollision desselben XML-TrackID mit unterschiedlichen DB-Zeilen.
6. Zusätzlich die übrigen Identitätsfelder protokollieren, um festzustellen, ob tatsächlich ein anderes Feld die XML-ID trägt. Eine Relation wird nur akzeptiert, wenn sie in allen Fixtures eindeutig und konsistent ist.

### 5.2 Exakte Pfadkanonisierung zur **Verifikation**, nicht als Laufzeit-Fallback

Für die konkrete verschobene Bibliothek dürfen diese beiden Schreibweisen auf denselben physischen Schlüssel normalisiert werden:

```text
XML: file://localhost//contents_<hash>/folder/file.ext
DB:  D:\PIONEER\Master\contents_<hash>\folder\file.ext
```

Kanonischer Vergleichsschlüssel:

```text
contents_<hash>/folder/file.ext
```

Erlaubte Operationen sind URI-Decoding, Slash-Normalisierung, Windows-Laufwerks-/Root-Abtrennung gemäß **konfiguriertem DB-Root** und Windows-gerechte Groß-/Kleinschreibung. Nicht erlaubt sind Titel-/Artist-/BPM-Vergleich, Basename-Suche, Fuzzy Matching oder Dateisystemscan.

Der Pfadvergleich ist eine Gegenprobe der ID-Relation. Er darf nicht stillschweigend eine fehlgeschlagene ID-Zuordnung ersetzen, weil dieselbe Audiodatei grundsätzlich in mehreren Collection-Zeilen mit unterschiedlichen Cue-/Analyse-Sätzen vorkommen kann.

### 5.3 Entscheidungstor

**Implementierungsstand nach Benutzerfreigabe:** Für den benannten Zielstand rekordbox 7.2.16 ist der ID-Join als streng bewachter Vertrag implementiert: derselbe Zahlenwert muss genau einmal als `djmdContent.ID` existieren **und** der kanonische XML-/DB-Dateipfad muss identisch sein. Ein Widerspruch führt zum sichtbaren Pipelinefehler; es gibt keinen Pfad- oder Metadatenfallback. Ein reales gepaartes Fixture bleibt erforderlich, um diesen Vertrag gegen die konkrete Installation empirisch zu bestätigen.

- **Wenn `TrackID == djmdContent.ID` vollständig bestätigt ist:** Laufzeitjoin ausschließlich per `ID = ?`; Pfad nur als harte Konsistenzprüfung.
- **Wenn ein anderes DB-Feld vollständig bestätigt ist:** Laufzeitjoin ausschließlich auf diesem Feld, mit dokumentierter Rekordbox-Versionsgrenze und Eindeutigkeitsconstraint.
- **Wenn keine eindeutige Relation bestätigt ist:** Nicht implementieren und nicht raten. Dann fehlt ein verlässlicher Primärschlüsselvertrag; benötigt wird ein weiteres zusammengehöriges Fixture oder eine instrumentierte Exportbeobachtung.

---

## 6. Autoritative Desktop-DB-Abfrage

Die reife, aber inoffizielle [pyrekordbox-Schemadokumentation](https://pyrekordbox.readthedocs.io/en/latest/formats/db6.html) beschreibt `master.db` als SQLCipher-4-SQLite, `djmdContent` als Tracktabelle, `FolderPath` als vollständigen Audiodateipfad und `AnalysisDataPath` als relativ zum Rekordbox-Datenbankroot.

Nach bestätigtem Join lautet der Produktionsvertrag:

```sql
SELECT ID, FolderPath, FileNameL, AnalysisDataPath
FROM djmdContent
WHERE ID = ?
LIMIT 2;
```

`LIMIT 2` dient der Eindeutigkeitsdiagnose, nicht der willkürlichen Auswahl. Gültig ist ausschließlich genau eine Zeile.

### DB-Auswahl

Für die bekannte Installation ist autoritativ:

```text
D:\PIONEER\Master\master.db
```

Die Auswahlreihenfolge muss deterministisch sein:

1. explizit konfigurierte/ausgewählte `master.db`;
2. der von Rekordbox Agent `storage/options.json` veröffentlichte `db-path`;
3. nur dokumentierte Standardorte der Plattform.

Jeder Kandidat muss als Diagnose mit Herkunft, Existenz und Öffnungsergebnis erscheinen. Es darf niemals still eine andere gefundene DB verwendet werden, nachdem ein expliziter Pfad fehlschlägt.

---

## 7. `AnalysisDataPath` exakt auflösen

Bei

```text
master.db = D:\PIONEER\Master\master.db
AnalysisDataPath = /share/PIONEER/USBANLZ/Pxxx/yyyyyyyy/ANLZ0000.DAT
```

ist das Ergebnis:

```text
D:\PIONEER\Master\share\PIONEER\USBANLZ\Pxxx\yyyyyyyy\ANLZ0000.DAT
```

Vertrag:

1. `dbRoot = dirname(openedMasterDbPath)`;
2. führende `/` oder `\` des **DB-relativen** Werts entfernen, ohne ihn als Dateisystemroot zu interpretieren;
3. Separatoren für die Hostplattform normalisieren;
4. `resolve(dbRoot, relativeAnalysisPath)` bilden;
5. sicherstellen, dass das Ergebnis innerhalb `dbRoot` liegt (`..`-Traversal ablehnen);
6. exakt diese Datei lesen.

`.EXT` und `.2EX` dürfen ausschließlich durch Austausch der letzten Erweiterung desselben Basispfads entstehen:

```text
ANLZ0000.DAT → ANLZ0000.EXT → ANLZ0000.2EX
```

Kein Verzeichnislauf, keine PPTH-Suche, keine Hash-/Dateinamensuche und keine manuelle Zuordnung.

---

## 8. ANLZ/PMAI-Decodiervertrag

### 8.1 Container

Deep Symmetry dokumentiert ANLZ als big-endian PMAI-Datei ([ANLZ Analysis Files](https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/anlz.html)); die zugehörige [Kaitai-Struktur](https://github.com/Deep-Symmetry/crate-digger/blob/main/src/main/kaitai/rekordbox_anlz.ksy) formalisiert denselben Aufbau.

```text
PMAI
u32be len_header
u32be len_file
... Rest des Dateiheaders bis len_header
wiederholt:
  fourcc tag
  u32be len_header
  u32be len_tag
  ... Tagkörper bis len_tag
```

Harte Prüfungen:

- Magic exakt `PMAI`;
- `len_header >= 12` und innerhalb Datei;
- `len_file` plausibel und mit gelesener Länge konsistent;
- je Tag `len_tag >= 12`, Tagende innerhalb Datei und strikt vorwärts;
- bekannte Tags nach ihrem eigenen Entry-Count/Entry-Size prüfen;
- unbekannte Tags anhand `len_tag` unverändert überspringen und protokollieren;
- keine „Legacy-Fixture“-Heuristik darf vor dem echten Layout greifen.

### 8.2 Relevante Tags und Eigentümer

| Datei/Tag | Rekordbox-Inhalt | Zu bewahrende Rohwerte | Verbraucher |
|---|---|---|---|
| DAT `PQTZ` | Beatgrid | `beat_number`, `tempo_x100`, `time_ms` je Beat | Beatgrid/Bar-Linien, Phrasenzeitzuordnung |
| DAT/EXT `PCOB` | Memory-/Hot-Cues und Loops | Listentyp, Hot-Cue-Nr., Status, Typ, `time_ms`, `loop_time_ms` | Cue-/Loop-Layer, falls kein passender PCO2-Datensatz |
| EXT `PCO2` | erweiterte Cues/Loops | obige Werte plus Kommentar/Farbe und weitere Felder | bevorzugte Cue-/Loop-Darstellung |
| DAT `PWAV`, `PWV2` | feste monochrome Preview | gepacktes Byte je Spalte | kleine/Legacy-Overview |
| EXT `PWV3` | monochromes Detail | gepacktes Byte je Halbframe | Detailansicht Blue |
| EXT `PWV4` | feste Farbpreview | sechs Rohbytes je Spalte | RGB-Overview |
| EXT `PWV5` | Farbdetail | gepackte 16 Bit je Halbframe | RGB-Detail |
| 2EX `PWV6` | feste 3-Band-Preview | drei Bandwerte je Spalte | 3-Band-Overview |
| 2EX `PWV7` | 3-Band-Detail | drei Bandwerte je Halbframe | 3-Band-Detail |
| 2EX `PWVC` | 3-Band-Kalibrierung | rohe Kalibrierwerte | nur nach dokumentierter Semantik anwenden |
| EXT `PSSI` | Songstruktur/Phrasen | Mood, Bank, Endbeat und sämtliche Entry-Felder | Phrase-Layer |
| `PPTH` | eingebetteter Audioquellpfad | UTF-16BE-Text | Diagnose/Konsistenz, **nie Tracksuche** |

Die von pyrekordbox zusammengefasste Tagreihenfolge ist typischerweise DAT: `PPTH, PVBR, PQTZ, PWAV, PWV2, PCOB...`; EXT: `PPTH, PCOB/PCO2, PQT2, PWV3, PWV4, PWV5, PSSI`; 2EX: `PPTH, PWV6, PWV7, PWVC` ([Analysis Files Format](https://pyrekordbox.readthedocs.io/en/latest/formats/anlz.html)). Das ist „typisch“, kein Grund, eine Datei bei anderer Reihenfolge abzulehnen.

### 8.3 Zeiteinheiten und Waveformspalten

- `PQTZ.tempo` = BPM × 100, `PQTZ.time` = Millisekunden.
- `PWV3` und `PWV5` besitzen nach etablierter Dokumentation 150 Detailspalten pro Sekunde (eine Spalte je Halbframe bei 75 Frames/s).
- Preview-Tags bilden die gesamte Spur mit fester Spaltenzahl ab; etwa `PWAV` mit 400 und `PWV4` mit 1200 Spalten.

Die kanonische Schicht muss Integerrohwerte behalten. Sekunden und normalisierte Farb-/Höhenwerte dürfen nur als abgeleitete View-Felder danebenstehen, niemals die Rohwerte ersetzen.

### 8.4 Variantenwahl

Für einen gewählten Modus ist die Rekordbox-Detailvariante maßgeblich:

- Blue: `PWV3`, sonst echte Rekordbox-Preview `PWAV/PWV2`;
- RGB: `PWV5`, sonst `PWV4`;
- 3Band: `PWV7`, sonst `PWV6`.

„Sonst“ bedeutet nur eine andere tatsächlich geladene ANLZ-Variante desselben Tracks, keine Erzeugung. Für Overview ist die echte Preview-Variante vorzuziehen; für Zoom die echte Detailvariante.

---

## 9. Unveränderte Datenkette

### 9.1 Namespaced, unveränderliches Modell

```ts
interface RekordboxTrackBundle {
  xml: XmlTrackRecord;
  identity: {
    joinKind: 'XML_TRACK_ID_EQUALS_DJMD_CONTENT_ID'; // erst nach Fixture-Beweis
    desktopContentId: string;
    verifiedAgainstLocation: true;
  };
  database: {
    openedDatabasePath: string;
    databaseRoot: string;
    contentId: string;
    folderPath: string;
    fileNameL?: string;
    analysisDataPathRaw: string;
    analysisDatAbsolutePath: string;
  };
  anlz: {
    dat?: ParsedAnlzFile;
    ext?: ParsedAnlzFile;
    twoEx?: ParsedAnlzFile;
  };
}
```

Jede Datei und jeder Tag behält:

- Quelldatei und absoluten Pfad;
- FourCC;
- Byteoffset, Headerlänge und Taglänge;
- Roh-Entry-Count/Entry-Size;
- rohe Integer-/Bytewerte;
- explizite, deterministisch dekodierte Viewfelder.

XML-Cues und ANLZ-Cues dürfen nicht ineinander überschrieben werden. Der Renderer des Rekordbox-Analysepfads nutzt ANLZ; XML-Werte bleiben für Importtreue, Vergleich und Export erhalten.

### 9.2 Erlaubte Darstellungstransformationen

Darstellung braucht zwangsläufig Koordinaten. Erlaubt sind nur:

- `x = sourceIndex / sourceColumnRate` bzw. Preview-Index proportional zur Trackdauer;
- `y/height` gemäß dokumentierter Bitfeldbedeutung;
- direkte Farbabbildung der gespeicherten Farbkomponenten;
- `time_ms / 1000`;
- PSSI-Beatnummer → Lookup der **vorhandenen** PQTZ-Beatzeit;
- PSSI-Mood/Kind → dokumentierte Bezeichnung, während Rohwerte erhalten bleiben.

Nicht erlaubt:

- Audio-Decoding zur Analyse;
- Berechnung zusätzlicher Beatpositionen vor/nach PQTZ;
- Beatgrid aus BPM/`TEMPO` auffüllen;
- pseudo-Waveform aus Beatgrid, Cues oder Metadaten;
- Mittelwert, Glättung, Interpolation, spektrale Rekonstruktion;
- Peak-Hold/Maximum mehrerer ANLZ-Spalten zu einer neuen Spalte;
- erfundene Frequenzbandanteile;
- Normalisierung anhand selbst berechneter globaler Maxima.

Wenn mehr Quellspalten als Displaypixel existieren, bleibt jede Quellspalte ein Draw-Primitive mit ihrer eigenen Quell-ID und wird direkt auf eine möglicherweise subpixelige x-Koordinate abgebildet. Airdox fasst sie nicht vorher zu neuen Daten zusammen. Wenn keine echte passende ANLZ-Variante geladen wurde, zeichnet der Waveform-Layer nichts.

---

## 10. Renderer-Eingaben

### DetailWaveform

```ts
interface DetailWaveformInput {
  sourceTag: 'PWV3' | 'PWV5' | 'PWV7';
  columns: readonly DecodedAnlzColumn[];
  columnRateHz: 150;
  beatEntries: readonly PqtzBeat[];
  cues: readonly DecodedAnlzCue[];
  phrases: readonly DecodedPssiPhrase[];
  viewport: { startSec: number; endSec: number; widthPx: number; heightPx: number };
}
```

### TrackOverview

```ts
interface TrackOverviewInput {
  sourceTag: 'PWAV' | 'PWV2' | 'PWV4' | 'PWV6' | 'PWV3' | 'PWV5' | 'PWV7';
  columns: readonly DecodedAnlzColumn[];
  durationSec: number;
  cues: readonly DecodedAnlzCue[];
  phrases: readonly DecodedPssiPhrase[];
}
```

Preview-Tags besitzen keinen pauschalen `150 Hz`-Zeitmaßstab, sondern werden über ihre Position in der festen, spurweiten Liste abgebildet. Der Datensatz muss daher Tagtyp und Timingmodell explizit tragen.

---

## 11. Diagnosevertrag: jede Stufe muss lokalisierbar sein

Fehler werden mit maschinenlesbarem Code und sichtbarer Detailkette gemeldet:

| Code | Bedeutung | Pflichtdetails |
|---|---|---|
| `XML_INVALID` | XML/Track-Feld ungültig | Datei, Trackindex, Attribut, Rohwert |
| `DB_NOT_FOUND` | autoritative `master.db` fehlt | alle geprüften deterministischen Kandidaten und Herkunft |
| `DB_OPEN_FAILED` | SQLCipher/IO/Schemafehler | gewählter Pfad, Stage, native Fehlermeldung ohne Secrets |
| `TRACK_ID_UNVERIFIED` | Identitätsvertrag nicht fixture-bestätigt | XML-ID, Rekordbox-Version, Fixture-ID |
| `TRACK_ROW_MISSING` | bestätigter Join liefert 0 Zeilen | XML-ID, DB-Pfad, Query-Feld |
| `TRACK_ROW_AMBIGUOUS` | Join liefert >1 Zeile | IDs/Rowcount |
| `TRACK_PATH_MISMATCH` | ID-Zeile verweist auf andere physische Datei | XML- und DB-Kanonikschlüssel |
| `ANALYSIS_PATH_EMPTY` | exakte Zeile hat keinen Pfad | Content-ID |
| `ANALYSIS_FILE_NOT_FOUND` | DB-adressierte Datei fehlt/ist nicht lesbar | roher und aufgelöster Pfad, Dateityp |
| `ANLZ_BAD_CONTAINER` | PMAI/Header ungültig | Datei, Offset, erwarteter/tatsächlicher Wert |
| `ANLZ_BAD_TAG` | Taggrenzen/Entrygrößen ungültig | Datei, FourCC, Offset, Längen |
| `ANLZ_REQUIRED_TAG_MISSING` | erwarteter Darstellungsinhalt fehlt | Content-ID, gelesene Dateien, `tagsFound` |
| `RENDER_SOURCE_MISSING` | Renderer erhielt keine echte ANLZ-Quelle | Track-ID, Modus, verlangte Tags |

Das Wort „Fallback“ darf in dieser Pipeline nur in einer Negativdiagnose vorkommen: Es gibt keinen Scan-, PPTH-, Metadaten-, Audioanalyse- oder Syntheseweg.

---

## 12. Audit-Ausgangspunkt und Implementierungsstatus

> Dieser Abschnitt dokumentiert den Audit-Ausgangspunkt vor dem anschließenden Implementierungsauftrag. Die genannten Vertragsverletzungen wurden danach gezielt bearbeitet. Der verbindliche aktuelle Nachaudit steht in [`REKORDBOX_PIPELINE_IMPLEMENTATION_AUDIT.md`](./REKORDBOX_PIPELINE_IMPLEMENTATION_AUDIT.md).

### Bereits am Audit-Ausgangspunkt in richtige Richtung umgesetzt

- XML-Deck-Load ruft keinen PPTH-Index und keinen ANLZ-Dateisystemscan mehr auf.
- DB-Loading ist single-flight, wodurch ein leerer Zwischenindex nicht mehr als endgültig gilt.
- `AnalysisDataPath` wird direkt verwendet; `.EXT`/`.2EX` können als Geschwister desselben Basispfads adressiert werden.
- Vollständiges `FolderPath` wird nicht nochmals mit `FileNameL` verdoppelt.
- Waveform-Komponenten zeigen ohne ANLZ keine Beatgrid-Ersatzwaveform.

### Vor weiterer Implementierung zu korrigierende Vertragsverletzungen

1. **Unbewiesener ID-Join:** Der aktuelle Direktpfad basiert auf der noch nicht fixture-bestätigten Annahme XML-ID = DB-ID.
2. **XML-Erfindungen:** `xmlParser.ts` verwendet derzeit Defaults wie 130 BPM, Tonart `2A`, 300 Sekunden und kann aus `TEMPO` ein dichtes Beatgrid bauen.
3. **Beat-Tail-Erzeugung:** `databaseExtractor.ts` hängt gleichförmige Beatnodes nach dem letzten echten PQTZ-Beat an (`tailExtended`).
4. **Overview-Aggregation:** `TrackOverview.tsx` nutzt `peakHoldColumn`, also Maxima mehrerer ANLZ-Spalten. Das verletzt den verlangten unveränderten Transport.
5. **Analyse-/Fallback-Typen bleiben global vorhanden:** `LOCAL_ANALYSIS` und `GENERATED_FALLBACK` existieren weiterhin. Sie dürfen im XML/Rekordbox-Pfad weder erreichbar sein noch in dessen Datenmodell passen.
6. **Parser-Heuristiken:** Der ANLZ-Parser unterstützt ältere Fixture-Layouts. Diese müssen klar isoliert sein und dürfen echte PMAI-Daten nie heuristisch fehlinterpretieren.
7. **Phrase-Semantik:** PSSI-Zeiten und Namen müssen als deterministische Projektion aus Roh-PSSI plus echten PQTZ-Beats modelliert werden, nicht als generierte Phrasenstruktur.

Der bestandene Build/Test beweist Regressionsfreiheit gegenüber dem aktuellen Testbestand, nicht die reale XML-DB-Identität und nicht den stärkeren Pass-through-Vertrag.

---

## 13. Fixture- und Testplan

### Phase 0 – Identität beweisen (keine Produktänderung)

**Fixtures:**

- zusammengehörige XML + entschlüsselte Read-only-Schema-/Zeilenauszüge oder testweise lesbare `master.db`;
- mindestens 20 Tracks, besser die vollständige XML;
- ASCII, Umlaute, Prozentzeichen, Leerzeichen;
- mindestens ein `contents_<hash>`-Pfad;
- wenn vorhanden: doppelte Audiodatei mit separaten Collection-Einträgen;
- Rekordbox-Version und Exportzeitpunkt protokollieren.

**Akzeptanz:** 100 % eindeutige Relation und exakte Pfadgegenprobe. Ergebnis als versioniertes Fixture-Manifest speichern, z. B. Hashes und redigierte Pfade, keine persönlichen Daten.

### Phase 1 – DB-Locator und exakter Join

Tests:

- explizites `D:\PIONEER\Master\master.db` gewinnt deterministisch;
- Agent-`db-path` wird relativ zu seiner Optionsdatei korrekt interpretiert;
- falsche explizite DB löst sichtbaren Fehler aus, keine stille Ersatz-DB;
- 0/1/>1-Zeilen-Vertrag;
- `FolderPath` vollständig vs. Ordner-plus-`FileNameL`;
- exakter `contents_<hash>`-Kanonikschlüssel;
- keine Titel-/BPM-/Artist-Abfrage im Produktionspfad.

### Phase 2 – Analysepfadauflösung

Golden Tests für Windows- und POSIX-Schreibweisen:

- DB-root-relativer führender Slash;
- Backslash/Slash;
- Unicode/URI-decoding;
- Traversal-Ablehnung;
- DAT→EXT/2EX nur letzte Extension;
- Assertion: kein `readdir`, Glob, rekursiver Scan oder PPTH-Index im Deck-Load.

### Phase 3 – Bytegenaue ANLZ-Decoder

Für jeden relevanten Tag ein minimales und ein reales, anonymisiertes Fixture. Erwartungswerte werden zusätzlich mit mindestens einem unabhängigen Parser (Kaitai/crate-digger, pyrekordbox oder rekordcrate) erzeugt.

Tests:

- PMAI- und Taggrenzen;
- unbekanntes Tag wird längengenau übersprungen;
- PQTZ Rohwerte inklusive variablem Tempo;
- PCOB/PCO2 Memory/Hot/Loop, Kommentare und Farben;
- PWAV/PWV2/PWV3/PWV4/PWV5/PWV6/PWV7 Bitfelder;
- PSSI masked/unmasked und alle Rohfelder;
- abgeschnittene/inkonsistente Tags liefern Offsetdiagnose, niemals Ersatzdaten.

### Phase 4 – Provenienz- und Modelltests

- Jeder gerenderte Beat verweist auf exakt einen PQTZ-Entry.
- Jede Waveformspalte verweist auf `{file, tag, entryIndex, rawBytes}`.
- Keine `tailExtended`, `LOCAL_ANALYSIS` oder `GENERATED_FALLBACK`-Quelle in einem `RekordboxTrackBundle`.
- XML- und ANLZ-Cues bleiben getrennt und vergleichbar.
- Serialisierung/Deserialisierung bewahrt Rohinteger und Reihenfolge.

### Phase 5 – Renderer-Contract

- Snapshot/Property-Test: Anzahl der Draw-Primitives entspricht Anzahl sichtbarer echter Quellspalten, nicht Pixelbreite.
- Kein `peakHoldColumn`, Mittelwert, Interpolator oder Glätter.
- Detail-Timing: Entry `i` von PWV3/PWV5/PWV7 liegt exakt bei `i / 150 s`.
- Preview-Timing: Entry `i` liegt proportional in der originalen Previewliste.
- Cue-x entsteht ausschließlich aus ANLZ-`time_ms`.
- Beat-x entsteht ausschließlich aus PQTZ-`time_ms`.
- Ohne passenden Tag: null Waveform-Primitives.

### Phase 6 – End-to-End-Fixture

Für ausgewählte Tracks wird eine Trace-Datei erzeugt:

```text
XML TrackID
→ bestätigtes Joinfeld und djmdContent.ID
→ roher AnalysisDataPath
→ absoluter DAT/EXT/2EX-Pfad
→ Dateihash
→ Tags und Entryzahlen
→ Renderer-Quelltag und Draw-Primitive-Anzahl
```

Akzeptanz ist byte-/wertbezogen, nicht nur ein optisch plausibler Screenshot.

---

## 14. Empfohlene Implementierungsreihenfolge nach Freigabe

1. **Noch nichts am Renderer ändern**, bevor Phase 0 die Identitätsrelation entscheidet.
2. `XmlTrackRecord`, `DesktopContentRecord`, `ParsedAnlzFile` und `RekordboxTrackBundle` als getrennte, immutable Contracts definieren.
3. XML-Defaults und Beatgrid-Erzeugung aus dem Rekordbox-Importpfad entfernen.
4. DB-Locator und exakt bestätigten Join implementieren; Diagnosekette hinzufügen.
5. AnalysisDataPath-Auflösung als kleine pure Funktion mit Golden Tests festschreiben.
6. ANLZ-Parser tagweise gegen unabhängige Fixtures härten und Rohwerte erhalten.
7. ANLZ-Priorität für Cues/Waveform explizit machen, ohne Datenquellen zu vermischen.
8. `tailExtended` und andere Beat-Erzeugung aus der Rekordbox-Pipeline entfernen.
9. Overview-Peak-Hold entfernen; Renderer auf source-indexierte Draw-Primitives umstellen.
10. E2E-Trace und Negativassertionen gegen Scan/PPTH/Audioanalyse/Synthese ergänzen.
11. Erst danach Windows-Build gegen den realen verschobenen DB-Root testen.

---

## 15. Entscheidungspunkte für die gemeinsame Besprechung

Vor Implementierungsbeginn sind nur diese Punkte zu entscheiden:

1. Bereitstellung eines zusammengehörigen, möglichst anonymisierten XML/DB-Fixtures für Phase 0.
2. Geltungsbereich des bewiesenen Joinvertrags: nur die konkret eingesetzte Rekordbox-Version oder mehrere Versionen.
3. Ob Cues im UI standardmäßig aus PCO2 und bei dessen Abwesenheit aus PCOB dargestellt werden sollen; beide Rohquellen bleiben erhalten.
4. Welche echten ANLZ-Varianten pro Modus als verpflichtend gelten (z. B. PWV5 für RGB-Detail und PWV7 für 3Band-Detail), damit ein fehlender Tag als harter Pipelinefehler statt als Wechsel auf eine gröbere echte Variante behandelt wird.

Die technische Grundentscheidung ist dagegen bereits eindeutig: `master.db` adressiert die ANLZ-Datei; ANLZ besitzt die visualisierten Analysewerte; Airdox transportiert und zeichnet diese Werte, analysiert aber kein Audio und erfindet nichts.

---

## Quellen

### Offiziell

1. [rekordbox Developer](https://rekordbox.com/en/support/developer/)
2. [rekordbox XML format specification (PDF)](https://cdn.rekordbox.com/files/20200410160904/xml_format_list.pdf)
3. [AlphaTheta: OneLibrary](https://alphatheta.com/en/onelibrary/)
4. [AlphaTheta: Device Library / OneLibrary compatibility notice](https://alphatheta.com/en/information/important-notice-for-customers-using-usb-devices-with-our-dj-equipment/)

### Unabhängig / reverse-engineered

5. [pyrekordbox: Rekordbox 6 Database Format](https://pyrekordbox.readthedocs.io/en/latest/formats/db6.html)
6. [pyrekordbox: Analysis Files Format](https://pyrekordbox.readthedocs.io/en/latest/formats/anlz.html)
7. [Deep Symmetry: Analysis Files](https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/anlz.html)
8. [Deep Symmetry/crate-digger: rekordbox_anlz.ksy](https://github.com/Deep-Symmetry/crate-digger/blob/main/src/main/kaitai/rekordbox_anlz.ksy)
9. [Deep Symmetry: DeviceSQL Database Exports](https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/exports.html)
10. [rekordcrate ANLZ module](https://holzhaus.github.io/rekordcrate/rekordcrate/anlz/index.html)
11. [pyrekordbox repository: XML, master.db, ANLZ and Device Library Plus implementations](https://github.com/dylanljones/pyrekordbox)
