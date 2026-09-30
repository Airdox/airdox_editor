# Rekordbox-Import: Quelldaten und Umsetzung

**Stand:** 30.09.2026  
**Repository/Branch:** `Airdox/airdox_editor` · `arena/01a0ef2d-airdox-editor`

> **Ergänzung:** Der formatgenaue Abgleich von Datenbank-Aufbau (Byteblöcke/Seiten),
> Tabellen-Einträgen und unseren SQL-Abfragen samt kleiner Test-Datenbankumgebung
> steht in [`docs/REKORDBOX_DATABASE_FORMAT.md`](./REKORDBOX_DATABASE_FORMAT.md)
> (u. a. Korrektur der Einheit `Length` = ganze Sekunden).

## Kurzbefund

Die im Repository-Root vorhandene Originaldatei `rekordbox_export2.xml` ist jetzt als Ressource in die App eingebettet. Der Button **Track-Import** öffnet nach dem einmaligen Parsen die bestehende Such-, Sortier- und Cue-Auswahl. Ein ausgewählter Track wird nur dann ins Deck geladen, wenn sowohl die passende Original-Audiodatei als auch eine echte Rekordbox-ANLZ-Waveform read-only erreichbar und die Quellenzuordnung plausibel sind.

Fehlende oder nicht passende Quellen führen zu einer verständlichen Fehlermeldung in der Auswahl. Es gibt in diesem Track-Import keinen synthetischen Audio-, lokalen Analyse- oder Waveform-Fallback. Der externe XML-Dateidialog, die XML-Uploadkarte im Dateninspektor, der XML-Dropimport, der Demo-Track-Pfad und dessen Fortschrittsmodal wurden entfernt. XML-Parser, Rekordbox-XML-Export, Datenbank-/ANLZ-Inspektor und das Track-Auswahlfenster bleiben erhalten.

## Verifizierte Original-XML

- Quelle: GitHub-`main`, Commit `e07b041b7b96318bd2f3ac373cfb0d34d8d4442a`.
- Dateiname/Größe: `rekordbox_export2.xml`, **10.476.624 Byte**.
- SHA-256: `35506c196ddbb8c057153b3a102db4f8704e4596908211468611880d36a98390`.
- Wurzelelement `DJ_PLAYLISTS`, Version `1.0.0`; ein `COLLECTION` mit **10.767 echten Einträgen**, alle mit `TrackID` und `Location`.
- Zusätzlich enthält der Export **1.479 `<TRACK Key="…">`-Referenzen** unter Playlist-`NODE`s. Diese sind keine Medieneinträge: Sie haben weder `TrackID` noch `Location` oder `Kind` und werden deshalb nicht als auswählbare Tracks fehlinterpretiert. Insgesamt existieren 12.246 XML-Elemente namens `TRACK`.
- Alle 10.767 Medieneinträge enthalten `file://localhost`-Locations. `Kind`-Verteilung der Medieneinträge: 6.003 MP3, 4.029 FLAC, 22 M4A, 17 WAV, 601 MP4, 95 unbekannt.
- Der Export enthält außerdem TEMPO- und POSITION_MARK-Daten; diese liefern Rekordbox-Metadaten/Marker, aber **keine dekodierten ANLZ-Waveform-Buckets**.

Der Parser berücksichtigt direkt unter `<COLLECTION>` liegende Track-Einträge und ignoriert die Key-Referenzen unter `<PLAYLISTS>`. `tests/bundled-rekordbox-xml.test.ts` prüft Dateihash, Schema, Eintragszahl und vollständige Locations.

## Neuer Track-Import-Pfad

1. `src/rekordbox/bundledCollection.ts` bindet die unveränderte Root-Datei per Vite-`?raw`-Import ein.
2. **Track-Import** lädt und parst die Sammlung einmalig pro App-Sitzung und öffnet anschließend `RekordboxXmlImportModal`. Der erste Track wird nicht automatisch ins Deck geladen.
3. Vor dem Öffnen der Auswahl versucht die Desktop-App, lokale Rekordbox-Datenbanken read-only zu finden und deren `AnalysisDataPath`-Zuordnungen in den app-eigenen, kleinen Pfadindex zu übernehmen. Es werden weder Datenbankkopien noch Audiodaten gespeichert. Ein bereits vorhandener Index kann weiterverwendet werden.
4. Beim expliziten Auswählen verlangt der Lader:
   - eine XML-`Location` für das Original-Audio;
   - eine ANLZ-Zuordnung über **exakten normalisierten Medienpfad** — Track-ID/Titel/Interpret allein reichen im strikten Pfad nicht;
   - soweit im ANLZ vorhanden, einen `PPTH`-Pfad, der zur selben Originaldatei passt;
   - eine erfolgreiche read-only ANLZ-Decodierung mit nichtleerer Waveform und `DataOrigin.REKORDBOX_ANLZ`;
   - ein erfolgreiches read-only Öffnen/Decodieren des Original-Audios, dessen aufgelöster Pfad ebenfalls mit der XML-Location übereinstimmt.
5. Erst nachdem beide Quellen validiert sind, wird der Original-AudioBuffer ins Deck gesetzt. Die Waveform-Buckets stammen aus ANLZ; XML-Tempo/Cues bleiben Rekordbox-Metadaten. PSSI-Phrasen werden nur angezeigt, wenn sie tatsächlich aus einer Rekordbox-Quelle vorliegen.
6. Schlägt eine Prüfung fehl, bleibt die Auswahl offen und zeigt den Grund. Es wird kein Ersatztrack geladen und die Originaldatei wird nicht verändert.

Die automatische Datenbanksuche ist kein Garant für vorhandene lokale Daten: XML und ANLZ-Dateien sind zwei getrennte Quellen. Eine passende Datenbank/ANLZ-Datei muss auf dem Zielsystem tatsächlich verfügbar und lesbar sein.

## Entfernte bzw. beibehaltene Pfade

**Entfernt:** versteckter `.xml`-Dateidialog, Menü-/Browser-/Waveform-XML-Uploadaktionen, XML-Dateiimport im Dateninspektor, XML-Datei-Drag-and-drop als Import, Demo-Lader mit synthetischem Audio, nur dafür benötigtes `ImportProgressModal`.

**Beibehalten:** das vorhandene such-/sortierbare Track-Auswahlfenster; XML-Parser und `buildBeatGridFromTempo`; Rekordbox-XML-Export im `ExportModal`; read-only Datenbank-/ANLZ-Inspektor; unabhängiger Audioimport. Ein gedropptes externes `.xml` wird nicht eingelesen und verweist auf den integrierten Track-Import.

## Read-only-Grenzen

- Das gebündelte XML wird im Renderer nur gelesen; es existiert kein Schreibpfad zu dieser Ressource.
- Original-Audio und ANLZ werden nur über die bestehende Desktop-Bridge read-only geöffnet.
- Die Rekordbox-Datenbank wird über den read-only Reader gelesen. Lokal persistiert wird lediglich die app-eigene Zuordnung zwischen Medienpfad und ANLZ-Pfad.
- Projekt-/Audio-/XML-Export bleibt getrennt. Die Originalquellen werden nicht als Exportziel überschrieben.

## Prüfstatus und offene Ende-zu-Ende-Verifikation

In dieser Sandbox war die XML vorhanden; **`master.db`/OneLibrary, Original-Audio und passende `.DAT`/`.EXT`/`.2EX`-Dateien waren nicht vorhanden**. Deshalb konnte hier kein nativer Track in einem echten Electron-Lauf geladen und kein ehrlicher Screenshot der originalen Rekordbox-Waveform erstellt werden. Ein XML- oder synthetischer Screenshot wäre kein Beleg für ANLZ.

Abgeschlossen und verifiziert:

- `npm run lint` — TypeScript ohne Fehler.
- `npm run build` — erfolgreich; das gebündelte XML liegt im Renderer-Bundle.
- `npm test` — **63/63 bestanden, 5 umgebungsabhängige Tests übersprungen, 0 fehlgeschlagen**.
- Neuer XML-Regressionstest bestätigt den SHA-256 der Originaldatei und 10.767 importierbare Collection-Einträge.
- Pfadindex-Regressionstest bestätigt Windows-`file://`-Normalisierung und verweigert im strikten Modus ID-/Titel-/Interpret-Fallbacks.

Für den vollständigen Abnahmescreenshot auf dem Zielrechner braucht es die passende Rekordbox-Datenbank, die zu den XML-Locations gehörenden Original-Audiodateien und die referenzierten nativen ANLZ-Dateien. Dann müssen Track-Header/Waveform-Herkunft `REKORDBOX_ANLZ` sowie eine nichtleere native Bucket-Zahl belegt werden; ohne diese Quelldateien wird kein 100%-Nachweis behauptet.
