# Refaktorisierungsplan – airdox SMART Editor

**Stand:** 04.10.2026  
**Ziel:** Wartbarkeit und Zuverlässigkeit erhöhen; die UI auch bei langen Tracks flüssig halten; CPU- und Speicherverbrauch messbar senken, ohne Audio-, Rekordbox- oder Stem-Verhalten zu verschlechtern.

## Aktueller Umsetzungsstand

Die Umsetzung ist inkrementell gestartet; die folgenden Punkte sind **Teilschritte**, kein Abschluss der jeweiligen Phase:

- **Waveform:** Die Detail-Waveform zeichnet statische Szene und Playhead auf getrennten Canvas-Ebenen. Die Playhead-Ebene liest eine Transport-Ref in einer eigenen RAF; die dauerhafte RAF-Schleife der vollständigen Szene ist entfernt. Ein Track-Revisionstoken invalidiert die statische Ebene auch dann, wenn bestehende Handler Track-Objekte noch direkt mutieren.
- **Transport/MIDI:** Die aktuelle Zeit wird pro Audio-Frame in einer Ref gehalten; React veröffentlicht Zeit höchstens mit 30 Hz und VU-Werte mit 20 Hz. Play-/Seek-Callbacks lesen die Ref; der MIDI-Lifecycle hängt nicht mehr vom UI-Zeitwert ab und reinitialisiert seine Listener deshalb nicht laufend. Der App-Tree rendert bei Transport weiterhin mit der UI-Rate; eine vollständige Subtree-Entkopplung und Messung stehen aus.
- **Quelle/SHA-256:** `loadAudioFile` hasht jetzt die vollständigen Originaldatei-Bytes mit Web Crypto; der irreführende abgetastete FNV-Wert mit `sha256-`-Präfix wurde entfernt. Standardvektoren sind getestet. Ein separater, versionierter Fingerprint der tatsächlich bearbeiteten PCM-Arbeitskopie samt Stem-Cache-Vertrag ist noch offen.
- **Noch offen:** Unveränderliche Track-Updates, App-weite Renderentkopplung und Messung des Canvas-/React-Hot-Paths; echte Formatvalidierung bzw. klare Nichtverfügbarkeit der Exportformate MP3/AAC/OGG/WebM; vollständige Release-, Windows- und Hardware-Gates.
- **Prüfungen dieser Iteration:** `npm run lint`, `npm run build` und `npm test` bestanden. Die Suite meldet 73/73 Tests bestanden und 4 modell-/runtimeabhängige SKIPs (Python ONNX Runtime, PyTorch/Demucs). Stem-Release mit `--fail-on-skip` sowie Windows-/Rekordbox-Hardware- und Paket-Gates sind noch nicht gelaufen. Der Produktionsbuild meldet weiterhin den großen `bundledCollection`-Chunk.

## Kurzempfehlung

Kein Rewrite und keine pauschale Aufteilung in viele Dateien. Bei der Bestandsaufnahme war der größte unmittelbare Performance-Hebel der Renderer: Transport-Frames zeichneten die komplette Canvas-Szene einschließlich Waveform und Grid neu. Die erste Umsetzung trennt den Playhead jetzt ab und begrenzt React-Veröffentlichungen; App-Renderkaskaden und die tatsächliche Frame-Zeit müssen noch gemessen und weiter entkoppelt werden. Der größte Stabilitäts-/Wartbarkeitshebel bleibt die Kopplung aus einem sehr großen `App.tsx`, veränderlichen Track-Objekten und nicht klar getrennten Browser-/Electron-Einstiegspunkten. Beim Audio kommen synchrone Analysen und vollständige PCM-Kopien im Undo-Verlauf hinzu.

Empfohlen ist eine **inkrementelle Refaktorisierung mit Verhaltensverträgen**: zuerst Korrektheit und Messwerte absichern, danach UI- und Audio-Hotspots gezielt entkoppeln und zuletzt Services/Tooling bereinigen. Die bestehenden ANLZ-/Datenbank-Gates, Originalschutz-Regeln, Edit-Kausalität und Stem-Qualitätsprüfungen sind Schutzmechanismen und dürfen nicht zugunsten einer vermeintlich einfacheren Architektur entfernt werden.

## 1. Bestand und konkrete Befunde

| Bereich | Ist-Zustand | Relevanz für die Refaktorisierung |
|---|---|---|
| UI/Anwendungssteuerung | `src/App.tsx`: **4.765 Zeilen**, ungefähr **88 `useState`-Aufrufe**, Import-/Edit-/Transport-/Recorder-/MIDI-/Stem- und Modal-Workflows in einer Komponente. Eine lokale Import-Graph-Auswertung zeigt etwa 49 interne Importziele. | Änderungen an einem Workflow greifen leicht in andere Zustände ein. Hohe Kopplung und viele Props erschweren isolierte Tests und Memoization. |
| Waveform/Transport | `src/components/DetailWaveform.tsx`: **1.408 Zeilen**. Bei der Bestandsaufnahme lief die vollständige Canvas-Szene in einer RAF-Schleife und hing u. a. von `currentTime` ab. Inzwischen sind Playhead und statische Szene getrennt; Transportzeit wird pro Frame in einer Ref gehalten, React-Zeit/VU-Updates sind auf 30/20 Hz begrenzt. | Verhindert die vollständige Canvas-Neuzeichnung pro Transport-Frame; App-Re-Render-Kaskaden und tatsächliche Frame-Zeiten bleiben Mess-/Entkopplungsaufgabe. |
| Audio/DSP | `src/waveform/analyzer.ts::analyzeAudioBuffer` verarbeitet synchron jeden PCM-Sample. Die Funktion wird beim Import und in Edit-/Undo-Pfaden verwendet. Edit-Befehle erzeugen häufig einen vollständigen neuen `AudioBuffer`. | Lange Analysen/Edits können den Renderer blockieren; vollständige Buffer-Materialisierung skaliert mit Tracklänge. |
| Undo/Redo und Zustand | `pushHistorySnapshot` klont `workingAudioBuffer`; der Undo-Verlauf hält bis zu ungefähr 30 Schritte. Mehrere Handler mutieren `activeTrack` direkt und rufen anschließend `setTracks([...tracks])` auf. | PCM-Snapshots sind teuer: fünf Minuten Stereo bei 48 kHz als Float32 entsprechen ca. **110 MiB je Buffer**; 30 zusätzliche Kopien wären bereits über 3 GiB, noch ohne Original, Clip-Puffer und Analyse. Mutationen erschweren außerdem zuverlässige Referenzvergleiche und spätere Memoization. |
| Edit-Domäne | `src/audio/editingEngine.ts`: **1.253 Zeilen** mit Sample-Operationen, Timeline-/Segmentlogik, Cues, Beatgrid, Phrasen und Waveform-Komposition. | Funktional wertvoll und bereits gut durch Edit-Matrix-/Kausalitätstests geschützt, aber Änderungen an einem Aspekt können leicht die übrigen Timeline-Daten inkonsistent machen. |
| Stem-Pipeline | Mehrere große, aber bereits fachlich aufgeteilte Module, u. a. `src/audio/stemEngine.ts` (**1.202 Zeilen**), `stemJobService.ts` (**1.045**), `stemSeparationEngine.ts` (**935**) und `remoteStemJobService.ts` (**1.202**). Browser-HTTP, Electron-IPC, lokale Backends, Installation und Remote-Worker sind beteiligt. | Keine Komplett-Neuimplementierung: Verträge, Profile, Preflight, Cache, Modellprüfung und Qualitäts-Gates sind geschäftskritisch. Sinnvoll ist zuerst die Trennung der Adapter von der bestehenden Domänenlogik. |
| Server/Desktop | `server.ts` (**976 Zeilen**) bündelt Stem-/Remote-Routen, Logs, Chat und Serverstart. `electron/main.cjs` (**915 Zeilen**) bündelt Lifecycle, IPC, Pfadschutz, Rekordbox- und Stem-Anbindung. `electron/preload.cjs` hält bewusst eine enge API-Grenze. | Die Laufzeitgrenzen sind sicherheits- und paketierungsrelevant. Änderungen brauchen Vertrags- und Produktionspfadtests für Browser **und** Electron. |
| Import/Rekordbox | `xmlParser.ts` bietet einen asynchronen 100-Track-Chunk-Parser und es gibt einen 11.000-Track-Test. Der eigentliche XML-DOM-Aufbau geschieht aber vor dem Chunking synchron. ANLZ-/DB-Gate und native SQLCipher-Runtime haben eigene Tests. | Der große XML-Import ist teilweise responsiv, aber Parsing/DOM können weiter den UI-Thread belasten. DB-/ANLZ-Verhalten auf realer Windows-Runtime absichern. |
| Tooling/Tests | 75 Testdateien; ein eigener Runner mit Umgebungs-SKIPs. `npm run lint` führt derzeit `tsc --noEmit` aus und ist kein separater Style-Linter. TypeScript ist nicht auf `strict` geschaltet, `allowJs` ist aktiviert. Die Windows-CI läuft aktuell beim Push auf `main`, nicht als expliziter PR-Check. | Gute Testbasis, aber Performance-Schwellen und UI-Rendermessungen fehlen. Fehlende Spezialumgebung darf bei Freigabetests nicht als „grün“ missverstanden werden. |

### Zwei Korrektheitsbefunde aus Phase 0

1. **Bei der Bestandsaufnahme entdeckter SHA-256-Fehler (Teilbehebung 04.10.2026).** `src/audio/audioEngine.ts::computeBufferChecksum` tastete nur ausgewählte Samples des linken Kanals ab, berechnete einen 32-Bit-FNV-artigen Wert und versah ihn mit dem Präfix `sha256-`. Dieser Pfad wurde entfernt; `loadAudioFile` berechnet nun den echten SHA-256 über die vollständigen Originaldatei-Bytes. Noch offen sind ein separat benannter/versionierter Fingerprint der bearbeiteten PCM-Arbeitskopie und die saubere Trennung dieses Werts vom Quellhash im Stem-Cache.
2. **Audioexporttests prüfen derzeit nicht, ob die Dateien decodierbar sind.** `tests/audio-export.test.ts` prüft im Wesentlichen Mindestlänge und Dateiendung. Die Fallbacks in `encodeMp3`, `encodeAac`, `encodeOgg` und `encodeWebm` legen WAV-Bytes hinter formattypische Header, führen aber keine echte MP3-/AAC-/OGG-/WebM-Codierung durch. Vor einer Export-Optimierung ist daher ein unabhängiger Decode-/Format-Test nötig; nicht unterstützte Formate müssen einen klaren Fehler liefern, statt eine nur scheinbar passende Datei zu erzeugen.

Weitere Befunde: `src/types/rekordbox.ts` exportiert `editAssistant`-Typen zurück, während `src/types/editAssistant.ts` Rekordbox-Typen importiert (statische Typ-Abhängigkeitsschleife, die bei der Entkopplung aufgelöst werden sollte). Die gespeicherten Analysegraphen in `code_analysis_out/` sind vom **18.09.2026** und zeigen beispielsweise eine kleinere `App.tsx` als die aktuelle Datei; diese Metriken vor Nutzung aktualisieren.

## 2. Zielbild

Die Struktur soll fachliche Grenzen sichtbar machen, ohne technische Schichten zu vervielfachen:

```text
React-Ansichten
  └─ stabile Aktionen/Props
       └─ Application: Projekt-Sitzung, Edit-Befehle, Import, Transport, Stem-Jobs
            ├─ Domain: Edit-Timeline, Marker, Provenienz, Validierungsregeln (pur)
            ├─ Audio: PCM-Assets, Analyse-Worker, Render-/Export-Cache
            └─ Ports: Projektdateien, Rekordbox, Stem-Jobs, Logging
                 ├─ Browser: Web Audio, Worker, HTTP, Browser-Dateien
                 └─ Electron: schmale Preload-API → IPC → Main-Services
```

- **Ein klarer Projektzustand:** Track-/Edit-Metadaten und Audio-Assets getrennt halten. Reducer/Commands verändern Track-Objekte unveränderlich. Große `AudioBuffer`-Daten liegen in einem Asset-Store bzw. werden per unveränderlicher Referenz geteilt, nicht in jedem UI-Snapshot kopiert.
- **Eine maßgebliche Edit-Repräsentation:** `EditSegment`/Edit-Commands bleiben Quelle der Timeline-Wahrheit. Dauer, Samples, Cues, Loops, Beatgrid, Phrasen und Waveform-Provenienz werden in einem atomaren Command-Ergebnis aktualisiert. PCM-Mixdowns werden nur bei Bedarf für Playback, Vorschau oder Export materialisiert und nach Revision gecacht.
- **Plattformadapter statt doppelter Fachlogik:** HTTP und IPC sprechen denselben Stem-/Rekordbox-Servicevertrag an. Sicherheitsregeln wie `pathGuard`, Read-only-Zugriff und Quellenregister bleiben im Electron-Main-Prozess.
- **Gezielte Nebenläufigkeit:** teure, reine Analyse-/Hash-Arbeit kann in Worker ausgelagert werden. Nicht jede Operation braucht einen Worker; erst messen, dann den kleinsten geeigneten Hotspot auslagern.

## 3. Umsetzungsphasen

### Phase 0 – Verhalten, Messwerte und Freigabe-Gates (P0)

**Arbeiten**

- Auf einem sauberen Checkout eine wiederholbare Baseline festhalten: `npm ci`, `npm run lint`, `npm run build`, `npm test` und die Stem-Release-Tests mit `--fail-on-skip`. Den Windows-Pfad separat mit `npm run rekordbox:native:ensure`, Runtime-Smoke-Test auf einem passenden Rekordbox-System und Windows-Paketbau prüfen.
- Vor Refaktorierungen Charakterisierungstests ergänzen: Edit-Operationen inklusive Undo/Redo, Audio-Sample-Gleichheit bei Identity-Roundtrips, Dauer-/Marker-Invarianten, Projekt-Roundtrip, ANLZ-Parität und Originaldatei-Unverändertheit. Bestehende Tests wie `edit-command-matrix`, `editing-waveform-causality`, `ripple-delete-original-integrity`, `anlz-structure-parity`, `master-db-gate` und `stem-engine-ipc-contract` als Pflicht-Gates beibehalten.
- [x] Echter SHA-256 für importierte Quelldateien: vollständige Dateibytes, kein Sample des linken PCM-Kanals. Die irreführende `computeBufferChecksum`-Implementierung ist entfernt; Standardvektoren sind getestet.
- [ ] Separaten, versionierten Fingerprint für decodiertes/editiertes PCM und dessen Stem-Cache-Vertrag einführen. Integrationstests müssen Änderungen an rechtem Kanal und zuvor nicht abgetasteten Samples erkennen.
- Export mit einem unabhängigen Decoder/Validator testen. Echte Encoder verwenden oder das Format als nicht verfügbar melden; Header-/Dateigrößen-Tests allein reichen nicht.
- Messpunkte aufnehmen: React-Commits pro Sekunde während Playback, Canvas-Zeichendauer, Long Tasks, Analysezeit pro Audiominute, Importdauer/Heap für 11.000 Tracks, Editlatenz, Peak-RAM mit Undo-Verlauf und Größe der Stem-HTTP-Payloads.
- PR-CI ergänzen: mindestens Typecheck/Build/automatische Tests auf Pull Requests; plattform- oder modellabhängige Tests mit sichtbaren SKIP-Gründen und verpflichtendem `--fail-on-skip` in den jeweils relevanten Release-Jobs.

**Abnahme:** Messbare Baseline für Referenzrechner und repräsentative Dateien; keine ungeprüften Exportformate oder falschen Hash-Aussagen; bisherige Sicherheits- und Kausalitätsverträge sind als Regressionstests ausführbar.

### Phase 1 – `App.tsx` entkoppeln und Zustand normalisieren (P1)

**Reihenfolge**

1. Zuerst Track-Änderungen unveränderlich machen: direkte Mutationen von `activeTrack` und `setTracks([...tracks])` durch fokussierte `updateTrack(id, updater)`-/Reducer-Aktionen ersetzen. So werden Updates nachvollziehbar und Komponenten später sicher memoizierbar.
2. Fachliche Zustandsbereiche schrittweise extrahieren: `useProjectSession`, `useTransport`, `useEditHistory`, `useEditCommands`, `useTrackImport`, `useRecorder`, `useStemJobs` und `useMidiLifecycle`. Dabei zunächst Verhalten/Signaturen erhalten, keine gleichzeitige Neugestaltung der UI.
3. Edit-Handlers zu einem Application-Service bündeln, der Validierung, History-Snapshot, `execute*`, Track-Commit, Auswahl und Telemetrie als einen atomaren Schritt koordiniert. Die reine Sample-/Timeline-Logik bleibt in `editingEngine.ts`.
4. Layout und Dialogauswahl in `App.tsx` belassen; Zustandslogik und Import-/Speicher-/Stem-Abläufe herauslösen. Lange Komponenten (insbesondere `DetailWaveform`, `DatabaseExtractionModal`, `RekordboxXmlImportModal` und Stem-Controls) nach Verantwortlichkeit teilen, nicht nur nach Zeilenzahl.
5. `DetailWaveform`-Callbacks zu einem stabilen, typisierten Aktionsobjekt oder stabilen Handlern gruppieren. `React.memo` erst nach unveränderlichen Track-Updates und Render-Profiling einsetzen.

**Abnahme:** Jeder Edit-Command hat unveränderte Einzel- und Kombinationstests; Auswahl, Cues, Beatgrid, Projektdatei, Undo/Redo und Chatbot-Aktionen bleiben konsistent. Reine Transport-Updates lösen keine unnötigen Re-Renders der Projekt-/Import-/Modalbereiche aus.

### Phase 2 – Waveform und Transport aus dem React-Hot-Path nehmen (P1/P2)

**Arbeiten**

- [x] **Teilumsetzung:** Statische Szene und Playhead liegen auf getrennten Canvas-Ebenen; Transport-Updates lösen keine vollständige Waveform-Neuzeichnung aus. Das Revisionstoken deckt vorerst auch bestehende In-place-Track-Mutationen ab.
- [ ] Drag-Auswahl/Pointer als weitere dynamische Ebene abtrennen; langfristig Track-Updates unveränderlich machen und den Revisionstoken dadurch ersetzen.
- Für die statische Ebene zunächst Offscreen-/Canvas-Cache und viewportbasierte Invalidierung verwenden. `OffscreenCanvas`/Worker-Rendering nur dann ergänzen, wenn Profiling nach dem Caching noch ein UI-Problem zeigt.
- [x] Playhead-Position direkt aus der Transport-Ref lesen und ausschließlich die schmale Canvas-Ebene per eigener `requestAnimationFrame`-Schleife bewegen.
- [x] Zeit-/BPM-nahe UI-Veröffentlichungen auf maximal 30 Hz und VU-Werte auf 20 Hz begrenzen; MIDI-Aktionen verwenden eine stabile Zeit-Ref und reinitialisieren Listener nicht pro Transport-Frame.
- [ ] App-/Komponenten-Renderkaskaden weiter entkoppeln und die Commit-Rate sowie Canvas-Zeiten messen. Die App rendert während des Transports weiterhin mit bis zu 30 Hz; ein 60-fps-Budget ist noch nicht gemessen.
- Beim Zeichnen nur sichtbare Buckets lesen. Farbwerte/Lookup-Tabellen und wiederverwendbare Pixel-/Sample-Zwischenwerte statt wiederholter String- und Farbberechnung pro Spalte evaluieren. Hohe Display-Pixelratio, Zoom, ResizeObserver und Auswahlinteraktion in visuellen Tests berücksichtigen.

**Abnahme:** Bei laufendem Transport wird die volle Waveform nicht pro Frame neu berechnet; statische Canvas-Arbeit erfolgt nur bei relevanter Änderung. Auf dem Referenzgerät liegt die dynamische Zeichenarbeit im 60-fps-Budget (16,7 ms), und Playback verursacht keine laufenden App-weiten Re-Render-Kaskaden.

### Phase 3 – Audioanalyse und Undo speicherschonend machen (P2)

**Arbeiten**

- `analyzeAudioBuffer` zunächst in einen reinen Kernel mit planarisierten `Float32Array`-Eingaben teilen. Worker-Adapter mit Job-ID, Fortschritt, Abbruch, Fehlerantwort und Schutz gegen verspätete Ergebnisse nach Trackwechsel ergänzen; synchrone Fallback-Implementierung für Tests/Umgebungen ohne Worker erhalten.
- Analyse- und BPM-/Fingerprint-Jobs in den Hintergrund verlagern. PCM nur gezielt kopieren/transferieren; `AudioBuffer` selbst ist kein übertragbarer Worker-Puffer. Kopierkosten messen und nicht durch Worker-Übergabe unbemerkt verdoppeln.
- History von vollständigen PCM-Klonen lösen: weil Edit-Commands neue Buffer erzeugen, zunächst unveränderliche Buffer-Referenzen in Snapshots nutzen, sofern alle Mutationsstellen ausgeschlossen sind. Danach Command-/EDL-Snapshots oder Deltas prüfen. Ein konfiguriertes RAM-Budget und begrenzte Cache-Eviction einführen; Undo/Redo muss samplegenau bleiben.
- Analysis-Cache nach belastbarem Audio-Fingerprint plus Analyseversion gestalten. `DataOrigin`/Waveform-Provenienz darf durch Cache-Treffer nicht verfälscht werden.
- PCM-Editierung nicht vorschnell komplett asynchron machen: zuerst Operationen nach Tracklänge profilieren, dann große Mixdown-/Export-Aufgaben in Chunks oder Worker verschieben. Während Jobs korrekte Cancel-/UI-Zustände garantieren.

**Abnahme:** Stresstest für mindestens einen mehrminütigen Stereo-Track mit wiederholten Edits/Undo/Redo; RAM wächst nicht linear um eine vollständige PCM-Kopie pro Undo-Schritt. Keine langen synchronen UI-Blockaden bei Analyse großer Tracks; Audioausgabe und Analysewerte sind vor/nach der Refaktorisierung reproduzierbar.

### Phase 4 – Server-, Electron- und Stem-Grenzen klarziehen (P2)

**Arbeiten**

- `server.ts` zu einem Composition Root verkleinern; Stem-, Remote-, Chat-, Log- und Health-Routen in getrennte Router/Handler mit injizierten Services auslagern. HTTP-Code validiert/parst Requests und mappt Fehler, enthält aber keine zweite Stem-Fachlogik.
- `electron/main.cjs` schrittweise nach Feature-IPC-Registrierungen aufteilen (Rekordbox/Dateien, Stems, Logs, Lifecycle). `preload.cjs`, `src/types/desktop.d.ts`, `src/stems/transportTypes.ts` und IPC-Contract-Tests bilden gemeinsam den öffentlichen Desktop-Vertrag; Renderer erhält keine generische IPC- oder Dateisystem-API.
- Browser-HTTP und Electron-IPC hinter klaren Client-Adaptern vereinheitlichen. Status-, Job- und Fehlerformate sowie Cancel-/Progress-Semantik für beide Wege per Contract-Test sichern.
- Stem-Uploads überprüfen: JSON mit Base64 und Limits bis 500 MB verursachen unnötigen Text- und Buffer-Overhead. Für große Arbeitskopien einen binären/gestreamten Transport mit Metadaten separat evaluieren, ohne Eingabevalidierung, Hashprüfung, Cancel-Verhalten oder bestehende Job-IDs zu brechen.
- Remote-Protokoll für `src/stems/remote/manifest.ts`, `scripts/stem-remote-worker.ts` und `colab/remote_worker.py` durch versionierte, gemeinsame Manifest-Fixtures und Cross-Language-Tests absichern.
- Architekturentscheidung für `native/stem_engine` dokumentieren: Der C++20/ONNX-Code ist laut CMake/README vom Electron-/npm-Build entkoppelte Referenz bzw. späterer Nachfolger, nicht aktuell der integrierte Renderer-Hot-Path. Entweder isoliert als Referenz pflegen oder separat mit verbindlichem Integrationsplan versehen; nicht parallel als bereits gelieferte Performance-Lösung behandeln.

**Abnahme:** Bestehende IPC-/HTTP-/Remote-Verträge und Installer-/Runtime-Gates bestehen. Pfadschutz und Read-only-Garantien bleiben ausschließlich durch die Main-Process-Policy erzwingbar. Große Payloads zeigen messbar weniger Peak-RAM, bevor der Transport umgestellt wird.

### Phase 5 – Typen, Repository-Hygiene und laufende Qualitätsregeln (P3)

- TypeScript-Strenge schrittweise erhöhen: zuerst `useUnknownInCatchVariables`/`noImplicitAny` in neuen bzw. extrahierten Modulen, anschließend `strictNullChecks` und gezielt `noUncheckedIndexedAccess`. Nicht als Big-Bang aktivieren; CJS-/IPC-Grenzen mit schmalen Typverträgen absichern.
- Typabhängigkeiten entwirren: gemeinsame Grundtypen in unabhängige Dateien legen und `import type`/`export type` konsequent verwenden; die festgestellte Rückkopplung zwischen `rekordbox.ts` und `editAssistant.ts` entfernen.
- Einen Paketmanager als maßgeblich festlegen. CI nutzt `npm ci`; zusätzlich vorhandenes `bun.lock` nur behalten, wenn Bun offiziell unterstützt und regelmäßig getestet wird.
- `README.md` von der generischen AI-Studio-Vorlage auf Produktzweck, Browser-/Desktop-Start, Build, Test, Rekordbox-Runtime und Stem-Setup aktualisieren. Architektur-/Datenflussdokumente nach jeder Modulverschiebung auf tatsächliche Pfade prüfen.
- Legacy-/Hilfsdateien inventarisieren, nicht blind löschen: Im Root liegen u. a. zwei 13-MB-ZIPs, alte Fix-/Patch-/Push-Skripte und doppelte Build-/Fix-Dateien. Einige Skripte enthalten direkte Git-Commit-/Push-Befehle auf `main`; sie gehören nicht in einen normalen App-/Build-Workflow. Zweck und Besitzer prüfen, anschließend archivieren/entfernen oder in klar gekennzeichnete, nicht automatisch ausführbare Entwicklerwerkzeuge verschieben. `rekordbox_export2.xml` (ca. 10,5 MB) und Audio-Fixtures sind dagegen produkt- bzw. testrelevant und müssen gesondert bewertet werden.
- Generated code/graphs, Lockfiles, Modell-Platzhalter und Testdaten im Build-Manifest bzw. Ignore-Setup bewusst voneinander abgrenzen.

**Abnahme:** Strenge wächst ohne flächendeckende `any`-Unterdrückung; Standard-README funktioniert als Einstieg; keine automatischen Reparatur-/Push-Skripte werden durch Build oder Tests gestartet; alle bewusst mitgelieferten großen Dateien sind dokumentiert.

## 4. Mess- und Qualitätskriterien für jede Phase

1. **Datenintegrität:** Original-Audio, Rekordbox-XML, ANLZ und Datenbanken werden nie verändert. Kryptografische Integritätsangaben stammen tatsächlich aus SHA-256.
2. **Edit-Kausalität:** Audio-Dauer, EDL-/Segmentgrenzen, Cues, Loops, Beatgrid, Phrasen und Waveform-Provenienz bleiben nach Command, Undo, Redo und Projekt-Roundtrip synchron.
3. **Audioqualität:** Vorher/Nachher-Samplevergleiche für Identity-/No-op-Befehle; deterministische Tests für Resampling/Overdub; Stem-Quality-Gates und Backend-Wahrheit bleiben unverändert.
4. **Responsiveness:** Frame-/Canvas-Zeiten, React-Commit-Rate und Long Tasks während Playback und Analyse werden vor/nach verglichen. Grenzwerte werden nach Baseline festgeschrieben, nicht rückwirkend geschätzt.
5. **Speicher:** Peak-Heap/RSS bei Import, Undo/Redo, Projektladen, Stem-Transport und Export wird mit repräsentativen Mehrminuten-Tracks gemessen.
6. **Import und Runtime:** Der 11.000-Track-XML-Test, ANLZ-Parität, DB-Gate, native SQLCipher-Prüfung, Browser-Fallback und Electron-Paket-Smoke bleiben Teil der Regressionstests.
7. **CI:** Typecheck, Build und automatische Tests laufen auf PRs. Plattform-/Modelltests haben explizite Anforderungen; bei Release-Tests ist unerwartetes Überspringen ein Fehler.

## 5. Nicht-Ziele und Risiken

- Kein Umstieg auf einen neuen State-Manager, Audio-Framework- oder Backend-Stack ohne Messwert und konkrete Lücke. React-Hooks/Reducer und bestehende Services reichen zunächst.
- Keine großflächige Umbenennung/Verschiebung vor stabilen Vertrags- und Golden-Tests. Besonders `masterDbGate`, ANLZ-Parser, `pathGuard` und SQLCipher nicht gleichzeitig mit UI-/Performance-Arbeiten ändern.
- Worker beseitigen nicht automatisch Kopierkosten; Canvas-Offscreen-Rendering ist nicht automatisch schneller. Beides gegen den aktuellen Pfad messen.
- C++-Stem-Engine und Python-/ONNX-Produktionspfad sind unterschiedliche Integrationsstände. Qualitäts-, Packaging- und Laufzeitnachweise müssen pro tatsächlich ausgeliefertem Backend erfolgen.

## 6. Empfohlene Reihenfolge

**P0 → P1 → P2 → P3 → P4 → P5**, jeweils in kleinen PRs und mit Messwerten im PR-Beschrieb. Die ersten zwei schnellen Hebel sind (a) falsche Hash-/Export-Verträge absichern und korrigieren sowie (b) den Playhead ohne vollständige React-/Canvas-Neuzeichnung bewegen. Erst danach lohnt sich eine breitere Neuordnung der Audio- und Service-Schichten.

## Prüfgrenze dieser Bestandsaufnahme

Die ursprüngliche Bestandsaufnahme erfolgte ohne `node_modules`; inzwischen wurden Abhängigkeiten für die erste Implementierungsrunde installiert. Typecheck (`npm run lint`), Produktionsbuild (`npm run build`) und vollständige automatische Testsuite (`npm test`: 73/73 bestanden, 4 explizite Umgebungs-SKIPs) liefen erfolgreich. Stem-Release-Tests mit `--fail-on-skip`, Performance-Baseline sowie Windows-/Rekordbox-Hardware- und Paket-Gates sind weiterhin nicht ausgeführt. Die gespeicherten Code-Analyse-Artefakte sind teilweise älter als der aktuelle Quellstand; vor einer Freigabe müssen die verbleibenden Gates frisch erzeugt werden.
