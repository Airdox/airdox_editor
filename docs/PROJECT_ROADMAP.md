# airdox SMART Editor – Bestandsaufnahme und Zukunftsplan

Stand: 13.09.2026

## Kurzfazit

Das Projekt besitzt bereits einen ungewöhnlich vollständigen Import- und Editierkern: XML, Rekordbox-Datenbanken, ANLZ, Cues, Beatgrid, Projektdateien, Read-only-Quellen, Export-Schutz und eine eigene kausale Audio-Engine. Der größte Qualitätshebel liegt deshalb nicht in weiteren Buttons, sondern in einer klareren Arbeitsoberfläche und einer strengeren Trennung zwischen **Quelle, Edit-Entscheidung und gerendertem Ergebnis**.

Die Wellenform wird jetzt als kontinuierliche Hüllkurve gezeichnet. Es gibt keine edit-spezifischen Balken und keinen synthetischen Beat-Fallback mehr. Original- und bearbeitetes Material durchlaufen denselben Renderer; dadurch ist die Darstellung nicht anhand von Insert-/Replace-Grenzen unterscheidbar.

## Projektanalyse

### Bereits stark

- Nicht-destruktiver Datenpfad: Original-Audio, XML, ANLZ und Datenbanken werden nur gelesen.
- Kausale Editieroperationen mit Sample-Transformation, Marker-Verschiebung und erneuter Analyse: Copy, Cut, Delete, Clear, Insert, Paste, Replace, Overdub.
- Undo/Redo enthält Audio, Cues, Segmente, Dauer, Auswahl und Analyse.
- Importpfad mit Priorität Rekordbox-Datenbank/ANLZ vor lokalen Schätzungen.
- Projektformat referenziert Originaldateien und schützt Quellpfade beim Export.
- Tests decken bereits viele Kombinationen und 11.000-Track-Importe ab.

### Technische Risiken

1. `App.tsx` ist ein großer Orchestrator. State-Änderungen, Dateizugriff, Audio-Editierung und UI-Aktionen sollten schrittweise in `useProject`, `useTransport` und `useEditCommands` getrennt werden.
2. Die Engine hält derzeit sowohl einen gerenderten Arbeitsbuffer als auch Edit-Segmente. Diese zwei Wahrheiten müssen durch Invarianten abgesichert werden: `duration`, Segmentgrenzen, Cues und Analyse müssen nach jeder Operation identisch sein.
3. `analyzeAudioBuffer` berechnet sehr viele Buckets. Bei langen Tracks sollte die Analyse in Worker/Chunking verschoben und visuell zwischengespeichert werden.
4. Für echte Rekordbox-Dateien fehlen noch reproduzierbare Geräte-/Versionsfixtures. Die vorhandenen Format-Tests sollten um anonymisierte Golden Files ergänzt werden.
5. Browser- und Electron-Pfade brauchen weiterhin dieselben Verträge. Jede Desktop-Funktion sollte einen Browser-Fallback und eine klare Fehlermeldung behalten.

## Vergleich mit vergleichbaren Editoren

| Bereich | airdox SMART Editor | Rekordbox EDIT | Audacity/DAW-Ansatz | Empfohlene Konsequenz |
|---|---|---|---|---|
| Rekordbox-Treue | XML, DB und ANLZ als primäre Quellen | nativ, aber proprietär | keine Rekordbox-Daten | diesen Vorsprung mit Golden Files sichern |
| Clip-/Palette-Workflow | Palette und Deck-Ansicht | schnelle DJ-orientierte Auswahl | meist generische Clip-/Track-Ansicht | eine primäre Clip-Aktion, sekundäre Varianten im Menü |
| Editiermodell | sample-genaue Engine plus Segmente | DJ-typische schnelle Operationen | starke Timeline-/Destruktivwerkzeuge | Command-Plan und Invarianten sichtbar machen |
| Waveform | mehrbandig und Beatgrid-orientiert | sehr klare kontinuierliche Darstellung | eher technisch/neutral | eine Renderer-Pipeline, keine Edit-Balken |
| Sicherheit | Read-only und Export-Guard | an Bibliothek gebunden | abhängig vom Dateimodell | Schutzprüfung auch bei Batch- und Projekt-Exporten |
| Erweiterbarkeit | React/Electron, TypeScript | geschlossen | plugin-/hostabhängig | Engine/UI/IO als stabile Schichten definieren |

## Empfohlene Prioritäten

### P0 – Stabilität und Kausalität

- Eine zentrale `EditCommand`-Beschreibung für alle Befehle: Eingabe, Auswahl, resultierende Dauer, Cue-Regel, Segment-Regel und Analyse.
- Property-/Kombinationstests für Insert→Delete, Replace→Undo→Redo, Clear→Overdub, Cut→Paste und Insert an Cue-Grenzen.
- Explizite Randregel für Marker exakt auf `start`/`end` einer Auswahl.
- Golden-File-Test: gleiche Audiodaten ergeben vor/nach einer Projekt-Runde dieselbe Analyse.

### P1 – Bedienoberfläche

- Datei-/Projektbefehle ausschließlich im Datei-Menü; Transport ausschließlich in der Transportleiste.
- Eine primäre Palette-Aktion je Vorgang: **Einfügen**, **Ersetzen**, **Überlagern**. Varianten bleiben im Kontextmenü.
- Panels nur an einer Stelle ein-/ausblenden. Die redundanten Projekt- und Panel-Icons in der Transportleiste wurden entfernt.
- Deutliche Zustände für Auswahl, Zwischenablage und fehlendes Original-Audio; keine dekorativen Status-Badges ohne Aktion.
- Tastatur-Fokus, sichtbare Shortcuts und vollständige ARIA-Labels ergänzen.

### P2 – Performance und Audioqualität

- Analyse in Worker auslagern und Analyse-Cache nach Audio-Hash speichern.
- Viewport-basierte Waveform-Auflösung: grob bei Full Track, fein beim Zoom.
- Edit-Segmente als Quelle des Renderings etablieren; Audio-Mixdown nur für Playback/Export erzeugen.
- Crossfades/Zero-Crossing-Option für Insert, Replace und Overdub, damit Klicks an Schnittgrenzen vermieden werden.
- Audio-Resampling und Pitch/Tempo mit messbaren Qualitätsgrenzen und Offline-Vorschau testen.

### P3 – Funktionsausbau

- Mehrspur-/Deck-Ansicht mit explizitem Routing.
- Batch-Analyse und Batch-Export mit Dry-Run.
- Projekt-Recovery und autosave mit atomischem Schreiben.
- Export-Presets für Rekordbox-kompatible WAV/XML-Projekte.
- Optional: A/B-Vergleich von Original und Arbeitsfassung, ohne die gemeinsame Waveform-Darstellung zu verändern.

## Definition of Done für die nächsten Iterationen

- Keine Operation verändert eine geschützte Originalquelle.
- Jede Edit-Operation hat mindestens einen Einzeltest und einen Kombinationstest.
- Nach jeder Operation stimmen Audio-Dauer, Segmente, Cues, Beatgrid und Analyse überein.
- Die Wellenform verwendet immer dieselbe kontinuierliche Darstellung; keine Balken-Fallbacks.
- Jede Funktion ist über Menü, Tastatur oder eindeutig sichtbare Primäraktion erreichbar – nicht doppelt ohne Mehrwert.
- Import, Export, Projekt-Roundtrip und Undo/Redo laufen auf Browser-Fallback und Electron-Pfad durch dieselben Verträge.
