# Refaktorisierungsplan – airdox SMART Editor

**Stand:** 04.10.2026

**Ziel:** Wartbarkeit und Zuverlässigkeit erhöhen; die UI auch bei langen Tracks flüssig halten; CPU- und Speicherverbrauch messbar senken, ohne Audio-, Rekordbox- oder Stem-Verhalten zu verschlechtern.

## Aktueller Umsetzungsstand

Die Umsetzung ist inkrementell gestartet; die folgenden Punkte sind **Teilschritte**, kein Abschluss der jeweiligen Phase:

- **Waveform:** Die statische Szene, die ref-/RAF-gesteuerte Auswahl-/Snap-Ebene und der Playhead liegen auf getrennten Canvas-Ebenen. Hover bewegt keinen React-State mehr; Selektions-Updates werden pro Animation-Frame gebündelt. Die statische Waveform hängt an immutable `TrackModel`-Referenzen statt an einem künstlichen Revisionstoken.
- **Transport/MIDI:** Die aktuelle Zeit wird pro Audio-Frame in einer Ref gehalten; React veröffentlicht Zeit höchstens mit 30 Hz und VU-Werte mit 20 Hz. Play-/Seek-Callbacks lesen die Ref; der MIDI-Lifecycle hängt nicht mehr vom UI-Zeitwert ab und reinitialisiert seine Listener deshalb nicht laufend. Der App-Tree rendert bei Transport weiterhin mit der UI-Rate; eine vollständige Subtree-Entkopplung und Messung stehen aus.
- **Quelle/PCM-Fingerprints:** `loadAudioFile` hasht mit Web Crypto die vollständigen Originaldatei-Bytes; der irreführende abgetastete FNV-Wert mit `sha256-`-Präfix wurde entfernt. Die Stem-Separation bildet zusätzlich `stem-pcm-wav-v1:sha256:<hex>` über exakt die vollständige kanonische Stereo-Float-WAV-Arbeitskopie. `TrackStems.originalSha256` bleibt der Quellhash; Stem-Caches binden Track, PCM-Fingerprint, Separationstyp und Profil-/Modellparameter und sind als LRU auf 512 MiB PCM begrenzt. Änderungen an der Arbeitskopie können Quell-Stems nicht wiederverwenden; übergroße Ergebnisse werden zurückgegeben, aber nicht im Renderer-Cache gehalten.
- **Audioexport:** WAV (16-/24-Bit-PCM, 32-Bit-Float) ist aktuell das einzige unterstützte Audioformat. Nicht implementierte MP3/FLAC/AAC/OGG/WebM-Exporte werden im Exporter abgelehnt und in Export-/Recorder-UIs deaktiviert. RIFF-/WAVE-Struktur und PCM-Werte sind getestet.
- **Zustand/History/MIDI:** `useProjectSession`, `useTransport`, `useEditHistory` und `useMidiLifecycle` kapseln jetzt erste fachliche Zustandsbereiche. Track-Updates und `applyExecutionToTrack` sind immutable; Undo/Redo ist pro Track getrennt, hält AudioBuffer-Referenzen statt PCM-Kopien, snapshotet Segmente/Cues/Loops/Beatgrid/Phrasen nach Wert und begrenzt die globalen Stacks auf 30 Einträge.
- **Remote-Abbruch:** Wiederholte Klicks werden je Job dedupliziert. Angenommene Anfragen bleiben bis zum terminalen Status gesperrt; bei Ablehnung oder Transportfehler greift ein 5-s-Cooldown. Die Oberfläche deaktiviert die Schaltfläche währenddessen und protokolliert Annahme/Ablehnung samt Status.
- **Stem-Backenddiagnosen:** strukturierte Fehlerfelder aus dem JSON-Lines-Protokoll werden als JSON statt `[object Object]` ausgegeben; fehlgeschlagene Prozesse behalten den stderr-/Log-Schwanz für die Ursache. Der Fern-Job-Start protokolliert Status, Phase und Fortschritt, auch wenn ein idempotenter vorhandener Job zurückgegeben wird.
- **Noch offen:** weitere App-Renderentkopplung und Messung des Canvas-/React-Hot-Paths; Edit-Command-Service, Import-/Recorder-/Stem-Hooks und weitere MIDI-UI-Kapselung; Analyse-Worker; unabhängige Decoderprüfung und echte Encoder vor Freigabe weiterer Formate; vollständige Release-, Windows- und Hardware-Gates.
- **Prüfungen dieser Iteration:** `npm run lint`, gezielte Waveform-/Remote-/ASAR-Tests, `npm test`, `npm run build`, `npm run test:stems:release`, `npm run test:package` und `git diff --check` bestanden. Die vollständige Suite meldet **78/78 bestanden, 4 explizite Umgebungs-SKIPs, 0 fehlgeschlagen**; der portable Stem-Release-Lauf mit `--fail-on-skip` besteht **30/30 ohne SKIPs**. Der Produktionsbuild gelingt, warnt aber weiterhin vor `bundledCollection` mit ca. **10,6 MB**. Das echte Checkpoint-/PyTorch-Qualitätsgate (in der Basissuite wegen fehlendem PyTorch übersprungen), unabhängige Codec-/WAV-Decoderprüfung (`ffmpeg`/`ffprobe` fehlen), ein sauberer `npm ci`-Lauf sowie Windows-/Rekordbox-Hardware- und Paket-Gates bleiben offen.

## Kurzempfehlung

Kein Rewrite und keine pauschale Aufteilung in viele Dateien. Der ursprüngliche Renderer-Hot-Path wurde entschärft, indem Playhead und statische Canvas-Szene getrennt, UI-Veröffentlichungen begrenzt und Track-Updates unveränderlich gemacht wurden. Übrig bleiben App-weite Renderkaskaden und fehlende Frame-/React-Messwerte. Projekt-, Transport- und History-Zustand sind als erste Hooks extrahiert; `App.tsx` bündelt aber weiterhin Edit-, Import-, Recorder-, MIDI-, Stem- und Dialog-Workflows. Undo/Redo hält PCM-Referenzen statt Kopien; synchrone Analyse und vollständige Buffer-Materialisierung bei Edits bleiben zu profilieren.

Empfohlen ist eine **inkrementelle Refaktorisierung mit Verhaltensverträgen**: zuerst Korrektheit und Messwerte absichern, danach UI- und Audio-Hotspots gezielt entkoppeln und zuletzt Services/Tooling bereinigen. Die bestehenden ANLZ-/Datenbank-Gates, Originalschutz-Regeln, Edit-Kausalität und Stem-Qualitätsprüfungen sind Schutzmechanismen und dürfen nicht zugunsten einer vermeintlich einfacheren Architektur entfernt werden.

## 1. Bestand und konkrete Befunde

| Bereich | Ist-Zustand | Relevanz für die Refaktorisierung |
|---|---|---|
| UI/Anwendungssteuerung | `src/App.tsx`: aktuell **4.620 Zeilen** und **74 `useState`-Aufrufe**; Import-/Edit-/Recorder-/Stem- und Modal-Workflows bleiben gebündelt. Projekt-Sitzung, Transport, Edit-History und MIDI-Lifecycle liegen inzwischen in Hooks. | Zustandskopplung ist teilweise reduziert; weitere Feature-Hooks und stabile Aktions-/Prop-Grenzen fehlen weiterhin und erschweren isolierte Tests sowie sichere Memoization. |
| Waveform/Transport | `src/components/DetailWaveform.tsx`: aktuell **1.378 Zeilen**. Bei der Bestandsaufnahme lief die vollständige Canvas-Szene in einer RAF-Schleife und hing u. a. von `currentTime` ab. Inzwischen sind statische Szene, Auswahl-/Snap-Ebene und Playhead getrennt; Transportzeit wird pro Frame in einer Ref gehalten, React-Zeit/VU-Updates sind auf 30/20 Hz begrenzt und der Transportzustand liegt in `useTransport`. | Verhindert vollständige Waveform-Neuzeichnungen durch Transport und Selection/Hover; App-Re-Render-Kaskaden und tatsächliche Frame-Zeiten bleiben Mess-/Entkopplungsaufgabe. |
| Audio/DSP | `src/waveform/analyzer.ts::analyzeAudioBuffer` verarbeitet synchron jeden PCM-Sample. Die Funktion wird beim Import und in Edit-/Undo-Pfaden verwendet. Edit-Befehle erzeugen häufig einen vollständigen neuen `AudioBuffer`. | Lange Analysen/Edits können den Renderer blockieren; vollständige Buffer-Materialisierung skaliert mit Tracklänge. |
| Undo/Redo und Zustand | `useProjectSession`, `useTransport`, `useEditHistory` und `useMidiLifecycle` kapseln erste Zustandsbereiche. Track-Updates ersetzen Track und Liste unveränderlich; History-Einträge snapshoten kleine Metadaten und halten `AudioBuffer`-Referenzen. | PCM-Klone pro History-Eintrag und frühere direkte Track-Mutationen sind entfernt. Der globale Stack ist auf 30 Einträge begrenzt; alte Buffer-Versionen bleiben für Undo referenziert, daher fehlen Peak-RAM-/Stresstest und weitere App-Entkopplung weiterhin. |
| Edit-Domäne | `src/audio/editingEngine.ts`: aktuell **1.256 Zeilen** mit Sample-Operationen, Timeline-/Segmentlogik, Cues, Beatgrid, Phrasen und Waveform-Komposition; `applyExecutionToTrack` ist jetzt eine pure immutable Transformation. | Funktional wertvoll und durch Edit-Matrix-/Kausalitätstests geschützt, aber ein übergreifender Application-Service und klare Unterdomänen fehlen weiterhin. |
| Stem-Pipeline | Mehrere große, aber bereits fachlich aufgeteilte Module, u. a. `src/audio/stemEngine.ts` (**1.337 Zeilen**), `stemJobService.ts` (**1.045**), `stemSeparationEngine.ts` (**935**) und `remoteStemJobService.ts` (**1.202**). Browser-HTTP, Electron-IPC, lokale Backends, Installation und Remote-Worker sind beteiligt. | Keine Komplett-Neuimplementierung: Verträge, Profile, Preflight, Cache, Modellprüfung und Qualitäts-Gates sind geschäftskritisch. Sinnvoll ist zuerst die Trennung der Adapter von der bestehenden Domänenlogik. |
| Server/Desktop | `server.ts` (**976 Zeilen**) bündelt Stem-/Remote-Routen, Logs, Chat und Serverstart. `electron/main.cjs` (**915 Zeilen**) bündelt Lifecycle, IPC, Pfadschutz, Rekordbox- und Stem-Anbindung. `electron/preload.cjs` hält bewusst eine enge API-Grenze. | Die Laufzeitgrenzen sind sicherheits- und paketierungsrelevant. Änderungen brauchen Vertrags- und Produktionspfadtests für Browser **und** Electron. |
| Import/Rekordbox | `xmlParser.ts` bietet einen asynchronen 100-Track-Chunk-Parser und es gibt einen 11.000-Track-Test. Der eigentliche XML-DOM-Aufbau geschieht aber vor dem Chunking synchron. ANLZ-/DB-Gate und native SQLCipher-Runtime haben eigene Tests. | Der große XML-Import ist teilweise responsiv, aber Parsing/DOM können weiter den UI-Thread belasten. DB-/ANLZ-Verhalten auf realer Windows-Runtime absichern. |
| Tooling/Tests | Eigener Runner mit derzeit **77 bestandenen und 4 expliziten Umgebungs-SKIPs** (insgesamt 81 Testmodule). `npm run lint` führt `tsc --noEmit` aus und ist kein separater Style-Linter. TypeScript ist nicht auf `strict` geschaltet, `allowJs` ist aktiviert. Die Windows-CI prüft nun Pushes und Pull Requests gegen `main` mit Typecheck, Build, Tests und Paketierung. | Gute Testbasis, aber Performance-Schwellen und UI-Rendermessungen fehlen. Fehlende Spezialumgebung darf bei Freigabetests nicht als „grün“ missverstanden werden. |

### Zwei Korrektheitsbefunde aus Phase 0

1. **Bei der Bestandsaufnahme entdeckter SHA-256-Fehler (behoben am 04.10.2026).** `src/audio/audioEngine.ts::computeBufferChecksum` tastete nur ausgewählte Samples des linken Kanals ab, berechnete einen 32-Bit-FNV-artigen Wert und versah ihn mit dem Präfix `sha256-`. Der Pfad wurde entfernt; `loadAudioFile` berechnet den echten SHA-256 über alle Originaldatei-Bytes. Stem-Eingaben erhalten separat `stem-pcm-wav-v1:sha256:<hex>` über alle Bytes der kanonischen Arbeitskopie. Der In-Memory-Cache trennt Original- und PCM-Fingerprint und schließt geänderte Samples sowie lokale/ferne oder andere Profil-/Modellläufe aus.
2. **Audioexporttests prüften zunächst nur Mindestlänge und Dateiendung.** Die früheren Fallbacks legten WAV-Bytes hinter MP3/AAC/OGG/WebM-Bezeichnungen; der FLAC-Pfad war nicht unabhängig validiert. Diese Pfade geben jetzt keine Datei mehr zurück: nicht unterstützte Formate werfen `AudioExportFormatUnavailableError` und sind in der UI deaktiviert. `tests/audio-export.test.ts` prüft jetzt WAV-Header, Chunk-Größen, PCM-Interleaving, Bit-Tiefen und Samplewerte. `ffmpeg`/`ffprobe` sind in dieser Umgebung nicht installiert; eine unabhängige Decoderprüfung bleibt Voraussetzung, bevor weitere Codecs aktiviert werden.

Weitere Befunde: Die in der Bestandsaufnahme festgestellte Typ-Rückkopplung zwischen `src/types/rekordbox.ts` und `src/types/editAssistant.ts` ist beseitigt; `SelectionRange` liegt in `src/types/selection.ts`. Die gespeicherten Analysegraphen in `code_analysis_out/` sind vom **18.09.2026** und zeigen beispielsweise eine kleinere `App.tsx` als die aktuelle Datei; diese Metriken vor Nutzung aktualisieren.

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
- [x] Separater Fingerprint der tatsächlich an die Stem-Engine gesendeten PCM-Arbeitskopie: versionspräfixierte SHA-256 über die vollständige kanonische Stereo-Float-WAV-Eingabe. Cache-Schlüssel trennen PCM-Revision, Track, lokalen/fernen Pfad und Separationseinstellungen; ein 512-MiB-LRU begrenzt gehaltene Stem-PCM-Daten. Tests ändern ausschließlich den rechten Kanal bzw. ein mittleres Sample und erwarten einen Cache-Miss.
- [x] Nicht implementierte Audio-Codecs fail-closed behandeln: MP3/FLAC/AAC/OGG/WebM deaktiviert und Exporter wirft einen klaren Fehler. WAV-Header, RIFF-Längen und reale PCM-Werte werden getestet.
- [ ] WAV mit unabhängigem Decoder/Validator in einem Release-Setup prüfen; `ffmpeg`/`ffprobe` fehlen in dieser Umgebung. Weitere Formate erst nach echter Encoder-Integration und unabhängiger Validierung aktivieren.
- [x] Reproduzierbaren ersten Analyse-Kernel-Messpunkt ergänzen (`npm run bench:audio-analysis -- 300`): Node v22.22.3, synthetischer 5-Minuten-Stereo-Buffer bei 48 kHz, 60.000 Buckets, 107,3 ms nach Warm-up (≈268,5 Mio. Samples/s; `arrayBuffers` 111,3 → 112,6 MiB). Das misst nur `analyzeAudioBuffer`, nicht Browser-Worker, AudioBuffer-Kopien oder UI-Blockade.
- [ ] Weitere Referenzmesspunkte aufnehmen: React-Commits pro Sekunde während Playback, Canvas-Zeichendauer, Long Tasks, Analysezeit pro Audiominute in Browsern, Importdauer/Heap für 11.000 Tracks, Editlatenz, Peak-RAM mit Undo-Verlauf und Größe der Stem-HTTP-Payloads.
- [x] PR-CI ergänzt: `.github/workflows/windows-build.yml` läuft für Pushes und Pull Requests gegen `main` und führt Typecheck, Build, Tests sowie den Windows-Paketbau aus. Der Test-Runner zeigt Umgebungs-SKIPs samt Ursache sichtbar an.
- [x] Windows-CI richtet Python 3.12 für die TypeScript-/Python-Remote-Protokoll-Fixture ein und führt `npm run test:stems:release` mit `--fail-on-skip` aus. [ ] Echte Checkpoint-/Plattform- und Rekordbox-Hardware-Gates zusätzlich auf passenden Runnern ausführen.

**Abnahme:** Messbare Baseline für Referenzrechner und repräsentative Dateien; keine ungeprüften Exportformate oder falschen Hash-Aussagen; bisherige Sicherheits- und Kausalitätsverträge sind als Regressionstests ausführbar.

### Phase 1 – `App.tsx` entkoppeln und Zustand normalisieren (P1)

**Reihenfolge**

1. [x] Track-Änderungen unveränderlich machen: direkte Mutationen von `activeTrack` und `setTracks([...tracks])` im App-Pfad durch fokussierte `updateTrack(id, updater)`-Aktionen ersetzen. `applyExecutionToTrack` liefert ein neues Modell zurück; bestehende Mutationsmuster wurden per Quelltextsuche geprüft.
2. **Teilweise erledigt:** `useProjectSession`, `useTransport`, `useEditHistory` und `useMidiLifecycle` sind extrahiert. `useEditCommands`, `useTrackImport`, `useRecorder` und `useStemJobs` bleiben offen. Dabei zunächst Verhalten/Signaturen erhalten, keine gleichzeitige Neugestaltung der UI.
3. Edit-Handlers zu einem Application-Service bündeln, der Validierung, History-Snapshot, `execute*`, Track-Commit, Auswahl und Telemetrie als einen atomaren Schritt koordiniert. Die reine Sample-/Timeline-Logik bleibt in `editingEngine.ts`.
4. Layout und Dialogauswahl in `App.tsx` belassen; Zustandslogik und Import-/Speicher-/Stem-Abläufe herauslösen. Lange Komponenten (insbesondere `DetailWaveform`, `DatabaseExtractionModal`, `RekordboxXmlImportModal` und Stem-Controls) nach Verantwortlichkeit teilen, nicht nur nach Zeilenzahl.
5. `DetailWaveform`-Callbacks zu einem stabilen, typisierten Aktionsobjekt oder stabilen Handlern gruppieren. `React.memo` erst nach unveränderlichen Track-Updates und Render-Profiling einsetzen.

**Abnahme:** Jeder Edit-Command hat unveränderte Einzel- und Kombinationstests; Auswahl, Cues, Beatgrid, Projektdatei, Undo/Redo und Chatbot-Aktionen bleiben konsistent. Reine Transport-Updates lösen keine unnötigen Re-Renders der Projekt-/Import-/Modalbereiche aus.

### Phase 2 – Waveform und Transport aus dem React-Hot-Path nehmen (P1/P2)

**Arbeiten**

- [x] **Teilumsetzung:** Statische Szene und Playhead liegen auf getrennten Canvas-Ebenen; Transport-Updates lösen keine vollständige Waveform-Neuzeichnung aus. Track-Änderungen liefern jetzt neue `TrackModel`-Referenzen; das zuvor nötige Revisionstoken ist entfernt.
- [x] Drag-Auswahl/Snap-Guide als transparente dynamische Ebene abtrennen; Pointer-Hover nutzt Refs und RAF, Selektions-Callbacks werden pro Frame zusammengefasst. Statische Szene wird dadurch bei Selection-/Hover-Updates nicht neu gezeichnet. Automatisierte Bounds-/Overlay-Zeichen-Tests ergänzen.
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
- [x] History von vollständigen PCM-Klonen lösen: Edit-Commands liefern neue Buffer; Snapshots halten die immutable Buffer-Referenz, während Track-ID, Segmente/Cues/Loops/Beatgrid/Phrasen nach Wert gesichert werden. Undo/Redo ist pro Track getrennt und beide globalen Stacks sind auf 30 Schritte begrenzt; gezielte Tests decken Referenzverhalten, Wiederherstellung und Branches ab.
- [ ] Danach Speicher unter langem Undo/Redo messen, ein konfiguriertes RAM-Budget/Eviction für alte Audio-Referenzen bewerten und Command-/EDL-Snapshots oder Deltas nur bei nachgewiesenem Bedarf prüfen; Undo/Redo muss samplegenau bleiben.
- Analysis-Cache nach belastbarem Audio-Fingerprint plus Analyseversion gestalten. `DataOrigin`/Waveform-Provenienz darf durch Cache-Treffer nicht verfälscht werden.
- PCM-Editierung nicht vorschnell komplett asynchron machen: zuerst Operationen nach Tracklänge profilieren, dann große Mixdown-/Export-Aufgaben in Chunks oder Worker verschieben. Während Jobs korrekte Cancel-/UI-Zustände garantieren.

**Abnahme:** Stresstest für mindestens einen mehrminütigen Stereo-Track mit wiederholten Edits/Undo/Redo; RAM wächst nicht linear um eine vollständige PCM-Kopie pro Undo-Schritt. Keine langen synchronen UI-Blockaden bei Analyse großer Tracks; Audioausgabe und Analysewerte sind vor/nach der Refaktorisierung reproduzierbar.

### Phase 4 – Server-, Electron- und Stem-Grenzen klarziehen (P2)

**Arbeiten**

- `server.ts` zu einem Composition Root verkleinern; Stem-, Remote-, Chat-, Log- und Health-Routen in getrennte Router/Handler mit injizierten Services auslagern. HTTP-Code validiert/parst Requests und mappt Fehler, enthält aber keine zweite Stem-Fachlogik.
- `electron/main.cjs` schrittweise nach Feature-IPC-Registrierungen aufteilen (Rekordbox/Dateien, Stems, Logs, Lifecycle). `preload.cjs`, `src/types/desktop.d.ts`, `src/stems/transportTypes.ts` und IPC-Contract-Tests bilden gemeinsam den öffentlichen Desktop-Vertrag; Renderer erhält keine generische IPC- oder Dateisystem-API.
- Browser-HTTP und Electron-IPC hinter klaren Client-Adaptern vereinheitlichen. Status-, Job- und Fehlerformate sowie Cancel-/Progress-Semantik für beide Wege per Contract-Test sichern.
- Stem-Uploads überprüfen: JSON mit Base64 und Limits bis 500 MB verursachen unnötigen Text- und Buffer-Overhead. Für große Arbeitskopien einen binären/gestreamten Transport mit Metadaten separat evaluieren, ohne Eingabevalidierung, Hashprüfung, Cancel-Verhalten oder bestehende Job-IDs zu brechen.
- [x] Remote-Protokoll für `src/stems/remote/manifest.ts` und `colab/remote_worker.py` mit gemeinsamer v1-JSON-Fixture plus TypeScript- und Python-Vertragstests absichern. Die Fixture wird in `tests/fixtures/stem-remote-manifest-v1.json` versioniert. UI-Abbruchanforderungen werden je aktivem Job dedupliziert; bei Ablehnung/Transportfehlern verhindert ein 5-s-Cooldown weitere Anfrage-/Log-Stürme, und die Schaltfläche zeigt den Sperrzustand.
- [x] Architekturentscheidung zu `native/stem_engine` dokumentieren: `native/stem_engine/README.md` und `CMakeLists.txt` weisen den C++20/ONNX-Code als vom Electron-/npm-Build entkoppelte Referenz bzw. möglichen späteren Nachfolger aus, nicht als integrierten Renderer-Hot-Path.

**Abnahme:** Bestehende IPC-/HTTP-/Remote-Verträge und Installer-/Runtime-Gates bestehen. Pfadschutz und Read-only-Garantien bleiben ausschließlich durch die Main-Process-Policy erzwingbar. Große Payloads zeigen messbar weniger Peak-RAM, bevor der Transport umgestellt wird.

### Phase 5 – Typen, Repository-Hygiene und laufende Qualitätsregeln (P3)

- TypeScript-Strenge schrittweise erhöhen: zuerst `useUnknownInCatchVariables`/`noImplicitAny` in neuen bzw. extrahierten Modulen, anschließend `strictNullChecks` und gezielt `noUncheckedIndexedAccess`. Nicht als Big-Bang aktivieren; CJS-/IPC-Grenzen mit schmalen Typverträgen absichern.
- [x] Die Typ-Rückkopplung zwischen `rekordbox.ts` und `editAssistant.ts` auflösen: `SelectionRange` liegt in `src/types/selection.ts` und wird von beiden Modulen per Typimport genutzt; `rekordbox.ts` re-exportiert den Vertrag rückwärtskompatibel.
- [x] npm als maßgeblichen Paketmanager festlegen: `package.json` deklariert `npm@10.9.8`, CI/README nutzen `npm`; die ungenutzte Bun-Lockdatei wurde entfernt.
- [x] `README.md` von der generischen AI-Studio-Vorlage auf Produktzweck, Browser-/Desktop-Start, Build, Test, Rekordbox-Runtime und Stem-Setup aktualisieren; `.env.example` auf lokale optionale Gemini-Konfiguration korrigieren. Architektur-/Datenflussdokumente nach jeder Modulverschiebung auf tatsächliche Pfade prüfen.
- [x] Historische Einmal-Reparaturen aus dem Root und `src/` nach `legacy-tools/one-off-repairs/` archivieren, ohne sie auszuführen oder inhaltlich zu verändern. `README.md` benennt die direkten `git reset/commit/push origin main`-Risiken; Paket-/CI-Einstiegspunkte führen diese Dateien nicht aus, und der ASAR-Regressionstest liest die archivierten Fassungen explizit. Die zwei 13-MB-ZIPs und Analysegraphen bleiben unverändert, bis Inhalt, Zweck und Besitzer geklärt sind. `rekordbox_export2.xml` (ca. 10,5 MB) und Audio-Fixtures bleiben als produkt-/testrelevant gesondert erhalten.
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

Die ursprüngliche Bestandsaufnahme erfolgte ohne `node_modules`; in dieser Iteration wurde weiter die vorhandene Installation verwendet und `npm ci` nicht ausgeführt. Aktuell bestanden `npm run lint`, `npm run test:package`, gezielte Waveform-/Remote-/ASAR-Tests, `npm test`, `npm run build`, `npm run test:stems:release` und `git diff --check`. Die Suite meldet **77/77 ausgeführte Tests bestanden, vier explizite Umgebungs-SKIPs und null Fehler**; neu abgesichert wird eine gemeinsame versionierte Manifest-Fixture in TypeScript und Python. Der portable Stem-Release-Lauf besteht **29/29** mit `--fail-on-skip`. Der synthetische Analyse-Kernel-Benchmark (Node v22.22.3, 5 Minuten Stereo/48 kHz) ergab 107,3 ms nach Warm-up; er ersetzt keine Browser-/React-/Canvas-Messung. Nicht ausgeführt werden konnten das echte Checkpoint-/PyTorch-Qualitätsgate, die unabhängige Decoderprüfung (`ffmpeg`/`ffprobe` fehlen), ein sauberer `npm ci`-Lauf sowie Windows-/Rekordbox-Hardware- und Installer-Gates. Der Produktionsbuild war erfolgreich, warnt aber vor dem sehr großen `bundledCollection`-Chunk (ca. 10,6 MB). Die gespeicherten Code-Analyse-Artefakte sind teilweise älter als der aktuelle Quellstand; vor einer Freigabe müssen die verbleibenden Gates frisch erzeugt werden.
