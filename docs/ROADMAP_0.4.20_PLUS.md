# Airdox SMART Editor – Produkt- und Implementierungsplan ab 0.4.20

Stand: 2026-09-10  
Ziel: mit möglichst wenig Aufwand zuerst die Zuverlässigkeit und den wahrgenommenen Nutzen erhöhen, ohne den Rekordbox-Originaldatenvertrag zu verletzen.

## 1. Produktpositionierung

Airdox sollte nicht versuchen, Rekordbox, Serato und VirtualDJ gleichzeitig zu kopieren. Die stärkste Position ist:

> **Ein nachweisbar quelltreuer Rekordbox-Editor für sichere, reversible Audio-Edits – mit echter ANLZ-Waveform, transparenter Herkunft und schneller Clip-/Snippet-Produktion.**

Das unterscheidet Airdox von allgemeinen Performance-DJs: Die Originaldatei und die Analyse bleiben geschützt, während die Arbeitskopie bearbeitet und als neues Ergebnis exportiert wird.

## 2. Was vergleichbare Produkte vormachen

- **Rekordbox:** Dual Player zum direkten Kompatibilitäts- und Mixpoint-Vergleich, Playlist-/Cloud-Management, STEMS, automatische Cue-Konfiguration, Export bearbeiteter Tracks und Aufnahme von DJ-Mixes. Quelle: [Rekordbox Overview](https://rekordbox.com/en/feature/overview/) und [Professional System](https://rekordbox.com/en/feature/professional/).
- **Serato DJ Pro:** vier Decks, dynamische Waveforms, Hot Cues, Loops, Beat Jump, Quantize, Sampler, Recording, Stems und breite Hardware-Unterstützung. Quelle: [Serato DJ Pro](https://serato.com/dj/pro).
- **VirtualDJ:** Echtzeit-Stems, Smart Sync, quantisierte Cues, Performance Pads, Smart Filters, Smart Automix, Sample-Editor und Track-/BPM-/Tag-Editor. Quelle: [VirtualDJ Features](https://virtualdj.com/products/virtualdj/features.html).

### Ableitung für Airdox

| Beobachtung | Airdox-Antwort | Aufwand | Nutzen |
|---|---|---:|---:|
| Alle Produkte machen Herkunft/Analyse im UI sichtbar | Provenance-Panel mit ANLZ-/PPTH-/PWV-Nachweis | klein | sehr hoch |
| Alle Produkte beschleunigen Vorbereitung | Smart-Analyse-Queue, Batch-Cues und Filter | mittel | sehr hoch |
| Stems sind ein starkes Kreativmerkmal | optionaler, klar getrenntes Stem-Modul | groß | hoch |
| Automix/Kompatibilität erzeugt schnellen Wert | Mix-Vorschau und Kompatibilitäts-Score | mittel | hoch |
| Sampler/Clips sind sofort verständlich | Palette 2.0 mit echter Quell-Waveform und Aktionen | klein/mittel | hoch |
| Cloud/HW sind wichtig, aber teuer | erst nach lokalem Stabilitätsfundament | groß | mittel/hoch |

## 3. Leitprinzipien für jede weitere Funktion

1. **Source of Truth:** Rekordbox-Track-Waveforms und Beatgrids kommen aus ANLZ/DB/XML. Eine eigene Audioanalyse darf nur für lokale Dateien oder explizit erzeugte Projekt-Assets verwendet werden.
2. **Arbeitskopie getrennt vom Original:** Edits ändern nie die Originaldatei und ersetzen nie still die Originalanalyse.
3. **Provenance first:** Jede Analyse, Cue, Grid-Änderung und Palette-Waveform trägt eine Herkunft (`REKORDBOX_ANLZ`, `REKORDBOX_DB`, `PROJECT`, `USER_EDIT`).
4. **Reversibel:** Jede Timeline-Operation besitzt einen serialisierbaren Undo-/Redo-Zustand.
5. **No silent fallback:** Fehlende ANLZ-Daten werden sichtbar gemeldet; kein synthetischer Ersatz wird als Rekordbox-Daten ausgegeben.
6. **Gate before feature:** Neue Funktionen werden nur ausgeliefert, wenn Quellen-, Modell-, Renderer- und Build-Gates grün sind.

## 4. Priorisierte Roadmap

### Phase A – 0.4.20.x: Vertrauensfundament (sofort)

**Ziel:** XML laden, Datenbank auf D:/G:/ finden, echte Waveform zeigen, Fehler erklären.

- Datenbank-Locator mit konfigurierbarem Root und sichtbarem gefundenem Pfad.
- ANLZ-Rescan-Button und „Quelle wählen…“-Fallback.
- Provenance-Status im TrackHeader:
  - Datenbankpfad
  - AnalysisDataPath
  - aufgelöster ANLZ-Pfad
  - DAT/EXT
  - PPTH-Match-Tier
  - PWV-Tag und Bucket-Anzahl
- Ein Diagnoseexport pro Track, nicht nur ein allgemeiner Logdump.
- Regressionstest mit verschachteltem `USBANLZ` und Datenbank auf D:.
- Palette-Waveform immer aus dem Analysebereich des Quelltracks; Fallback nur mit sichtbarer Herkunft.

**Gate:** Ein echter Testdatensatz muss `ANLZ → PWV → Renderer → Palette` beweisen. Ohne diesen Nachweis kein Release.

### Phase B – 0.4.21: Editiermodell und Marker-Konsistenz

**Ziel:** Keine Divergenz zwischen hörbarem Ergebnis, Timeline, Markern und Waveform-Provenance.

- Zentraler `EditTimeline`-Service statt Logik in einzelnen React-Handlern.
- Operationen als reine Funktionen: `insert`, `delete`, `replace`, `overdub`, `clear`, `move`.
- Gemeinsame Markertransformation für Cues, Loops, Phrase Sections und Beatgrid.
- Property-Tests:
  - `undo(redo(x)) = x`
  - Insert/Delete erhalten die Audio-/Timeline-Länge korrekt.
  - Marker an Grenzpunkten werden deterministisch behandelt.
- Persistenzversion für Projekte und Migration alter Projektdateien.

**Gate:** Jede Edit-Operation erhält einen Audio-, Timeline-, Marker- und Undo-Test.

### Phase C – 0.4.22: Vorbereitung mit hohem Impact

**Ziel:** Große Sammlungen schnell vorbereiten.

- Library-Index mit Volltextsuche.
- Smart Filter: BPM, Tonart, Genre, Rating, Cue-Anzahl, Waveform-Status, ANLZ-Status.
- „Fehlende Analyse“-Ansicht mit Aktionen: Rescan, Datei wählen, überspringen.
- Doppelte Tracks über normalisierten Pfad, Hash und Metadaten erkennen.
- Batch-Ansicht für Cue-/Loop-Prüfung.
- Kompatibilitäts-Score für BPM, Tonart, Lautheit und Beatgrid-Sicherheit.

**Gate:** 10.000+ Collection-Einträge ohne UI-Blockade laden; Status jedes Eintrags erklärbar.

### Phase D – 0.4.23: Mix-Vorschau und Palette 2.0

**Ziel:** Die stärksten kreativen Funktionen mit überschaubarem Aufwand.

- Zwei synchronisierte Player mit A/B-Waveform und Mixpoint-Vorschau.
- Drag & Drop mit Drop-Vorschau, Zielposition und Operationstyp.
- Palette-Clip-Aktionen: Insert, Replace, Overdub, Duplicate, Trim, Rename, Color.
- Clip-Waveform mit Source-Badge und Start-/Endbereich.
- Non-destructive Crossfades und kurze Equal-Power-Fades an Schnittgrenzen.
- Export-Vorschau: „genau dieser Bereich wird exportiert“.

**Gate:** Jede Drop-Aktion muss dieselbe Operation aus Button, Kontextmenü und Tastatur auslösen.

### Phase E – 0.4.24: Automatisierte Vorbereitung

**Ziel:** Zeit sparen, nicht Daten erfinden.

- Cue-Vorschläge nur als Vorschläge, niemals still speichern.
- Vocal-/Downbeat-Marker optional aus vorhandener Analyse oder separatem Modell.
- Batch-Review mit „Akzeptieren / Ablehnen / später“.
- Automatische Mix-Reihenfolge nach BPM, Tonart, Energie und Phrase.
- Exportierbarer Review-Bericht.

**Gate:** Vorschläge besitzen Confidence, Quelle, Modellversion und Undo. Keine automatische Änderung ohne Bestätigung.

### Phase F – danach: Kreativ- und Plattformausbau

Nur nach stabilem Fundament:

- optionale Stem-Separation als eigener, klar markierter `PROJECT_DSP`-Datensatz
- Stem-Sampler und Palette-Layer
- VST-/Plugin-Integration
- MIDI-/Controller-Mapping
- Cloud-Synchronisierung mit Konfliktauflösung
- USB-/CDJ-Exportprofile
- Video-/Visual-Modul

Diese Phase ist bewusst später angesetzt: Sie erzeugt viel Marketingwirkung, löst aber nicht das aktuelle Kernproblem der zuverlässigen Analysezuordnung.

## 5. Agenten-Orchestrierung und Release-Gates

Der Gatekeeper in `scripts/waveform-gates.mjs` ist der Prototyp für ein allgemeines Agentensystem. Künftig soll jeder Agent ein standardisiertes Ergebnis liefern:

```ts
type GateResult = {
  agent: string;
  gate: string;
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  evidence: string[];
  reason?: string;
  nextAction?: string;
};
```

### Agentenrollen

- **Importer-Agent:** XML/DB/AnalysisDataPath, Laufwerkspfade, D:-Datenbank.
- **ANLZ-Agent:** PPTH, DAT/EXT, PQTZ, PWV und Match-Tier.
- **Model-Agent:** Provenance und unveränderte Originaldaten.
- **Edit-Agent:** Timeline-/Marker-/Undo-Invarianten.
- **Renderer-Agent:** sichtbare Herkunft und Zoom-Varianten.
- **Palette-Agent:** Clip-Ausschnitt und Quell-Waveform.
- **UX-Agent:** verständliche Status- und Fehlertexte.
- **Performance-Agent:** große Collections, Scanzeiten, Speicher.
- **Release-Agent:** Lint, Tests, Build, Windows-Artefakte.
- **Gatekeeper-Agent:** sammelt Ergebnisse, fordert bei FAIL eine Begründung und konkrete nächste Aktion an; blockiert Release bei fehlender Evidenz.

### Regel für Nichterreichung

Ein Agent darf nicht einfach „grün“ melden, wenn das Ziel nicht erreicht wurde. Er muss melden:

1. welche Invariante verletzt ist,
2. welche Evidenz fehlt,
3. ob die Ursache reproduzierbar ist,
4. welcher Agent als Nächstes übernehmen soll,
5. ob ein sicherer Blocker oder nur ein Warnhinweis vorliegt.

### Gatebericht, Retry und Eskalation (umgesetzt, Stage 1 ab 0.4.20.1)

Der Gatekeeper in `scripts/waveform-gates.mjs` liefert jede Gate-Run als
strukturierten JSON-Bericht (Schema `airdox.waveform-gate-report` v1):

- `release/gate-report.json` — pro Gate ein `GateResult` mit `agent`, `gate`,
  `status`, `evidence`, `attempts`, `retried`, `durationMs`; finale Fehlschläge
  zusätzlich mit `reason` und `nextAction`. Laufmetadaten (Zeitstempel,
  App-Version, Plattform, Node, Commit) machen den Bericht reproduzierbar.
- **Ein automatischer Retry:** jede fehlgeschlagene Gate wird genau einmal
  wiederholt (`attempts: 2`, `retried: true`), bevor das Ergebnis als final
  gilt. Ein Retry-„Pass“ bleibt ein Pass — aber mit transparenter Evidenz.
- **Eskalation:** finale Fehlschläge erzeugen `escalations[]` im JSON-Bericht
  (Grund, verantwortlicher Agent, konkrete nächste Aktion) plus
  `release/gate-escalation.md`. Grün-Läufe entfernen eine alte
  Eskalationsdatei.
- **CI-Artefakt:** der Bericht wird zusammen mit dem Windows-Build im
  Artefakt `airdox-smart-editor-windows` hochgeladen — auch bei BLOCKED, wenn
  keine `.exe` gebaut wurde.

Der Gatekeeper und sein Bericht sind reine Prüf- und Reporting-Infrastruktur:
Sie lesen und verändern keine Rekordbox-Daten (ANLZ/PPTH/PWV, DB, XML, Audio)
— sie dokumentieren nur, was die Quellen tatsächlich liefern.

## 6. Messbare Produktziele

- 100 % der Rekordbox-Waveforms zeigen nachvollziehbare ANLZ-/PWV-Herkunft.
- 0 stille synthetische Fallbacks im Rekordbox-Pfad.
- 100 % der Edit-Operationen sind undo-/redo-fähig.
- 95 % der XML-Tracks mit vorhandenem ANLZ werden automatisch zugeordnet.
- Collection-Import von 100.000 Tracks ohne Renderer-Blockade.
- Palette-Clip-Erstellung unter 100 ms für den UI-Teil; Audio-DSP darf asynchron folgen.
- Jeder Release enthält Gates, Testbericht und reproduzierbare Artefakte.

## 7. Reihenfolge mit maximalem Impact

1. D:-Datenbank und ANLZ-Zuordnung sichtbar und zuverlässig machen.
2. Waveform-/Provenance-Gates dauerhaft in CI erzwingen.
3. EditTimeline zentralisieren und Marker-Konsistenz testen.
4. Palette 2.0 und Mix-Vorschau ausbauen.
5. Library-Suche, Smart Filter und Batch Review.
6. Erst danach Stems, Cloud, Hardware und Video.
