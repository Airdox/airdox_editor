# airdox_SMART_Editor v0.4.3 – Edit-Workflow-Überholung & Palette-Insert-Bugfix

**Datum:** 2026-09-09

## Zusammenfassung

Diese Version behebt drei schwerwiegende Probleme, die nach v0.4.0 auftraten:
1. Der berichtete White-Screen beim Start (behoben in v0.4.1/v0.4.2 durch `base: './'` + Notfall-Body-CSS; weiterhin stabil).
2. **Palette-Insert-Bug:** Cursor an eine beliebige Stelle in der Deck-Ansicht setzen, dann in der Clip-Palette auf "Einfügen" klicken – bislang passierte **nichts**. Jetzt funktioniert das Einfügen zuverlässig.
3. Edit-Aktionen (Copy/Cut/Paste/Insert/Delete/Clear/Replace/Overdub/Undo/Redo) arbeiteten teils direkt auf dem Audio-Puffer und zerstörten sich dadurch gegenseitig; Undo/Redo waren unvollständig. Sie wurden auf ein sauberes **nicht-überlappendes Segment-Modell** umgestellt, das die gesamte Edit-Historie zuverlässig rekonstruieren kann.

## App-Name

Der Name wurde überall auf exakt **`airdox_SMART_Editor`** (mit Unterstrichen, Groß-/Kleinschreibung) normalisiert:

- `package.json` → `name`, `build.productName`, `build.executableName`
- Electron-Build-NSIS: `shortcutName`, `artifactName`
- `<title>` und Meta-Tags in `index.html`
- Titelleiste, About-Dialog, Release-Artefakte

## Segment-Modell (Kern-Refactoring)

Jeder Track wird intern als sortierte Liste nicht-überlappender Segmente geführt:

| Typ        | Bedeutung                                                                              |
|------------|----------------------------------------------------------------------------------------|
| `ORIGINAL` | Unveränderter Original-Audio-Bereich (nur referenziert, nie kopiert).                   |
| `INSERT`   | An Playhead/Position eingefügter Clip; öffnet Zeit, verschiebt folgende Segmente + Cues.|
| `REPLACE`  | Ersetzt einen markierten Bereich; nachfolgende Cues im Ersatzbereich werden entfernt,   |
|            | außerhalb wird die Zeitdifferenz korrigiert.                                           |
| `CUT`      | Stummgeschalteter Bereich (Clear); Länge bleibt erhalten, Beatgrid synchron.            |
| `OVERDUB`  | Clip wird über Auswahl gemischt (tanh-Soft-Clipping + 1/√N Normalisierung);              |
|            | Länge unverändert.                                                                     |

Vorteile:
- Keine Direkt-Manipulation am `AudioBuffer` mehr – jede Änderung geht ausschließlich über `workingSegments`.
- `rerenderFromSegments(track)` baut den Working-Buffer inkl. Analyse neu auf.
- Undo/Redo-Snapshots bestehen aus `segments + cues + selection` und werden durch einfaches Zuweisen + Re-Render wiederhergestellt – kein Datenverlust mehr.
- Cues werden beim Insert/Replace/Delete automatisch mitverschoben bzw. im ersetzten Bereich entfernt.

## Audio-Renderer (`src/audio/audioEngine.ts`)

`renderWorkingAudio` wurde neu geschrieben mit folgenden Korrekturen:
- **Silence-Pre-Fill** vor dem ersten Segment.
- ORIGINAL/INSERT/REPLACE/CUT werden zuerst sauber gemischt, Überlappungen mit `1/√N`-Normalisierung, keine Artefakte an Segmentgrenzen.
- OVERDUB wird als zusätzliche Schicht darüber gemischt (tanh-Soft-Clipping gegen Übersteuerung).
- Die Gesamtdauer wird auf das Ende des letzten Segments gesetzt – Insert öffnet tatsächlich Zeit.

## UI-Verbesserungen

### Sidebar `PalettePanel`
- Jeder Clip hat jetzt drei Aktions-Buttons:
  - **INSERT @ ▶** (grün) – fügt den Clip an die aktuelle Playhead-Position ein (der Kern-Bugfix!).
  - **REPLACE** (orange, nur aktiv bei Auswahl) – ersetzt den markierten Bereich.
  - **OVERDUB** (blau, nur aktiv bei Auswahl) – mischt den Clip über die Auswahl.
- Buttons stoppen ggf. laufende Preview vor dem Einsetzen.
- Kleines Legenden-Band erklärt die drei Aktionen.

### `BottomControlBlock`
- **PASTE / INSERT / REPLACE / OVERDUB** haben jetzt **Fallback auf den ausgewählten Palette-Clip**, falls die Zwischenablage leer ist.
- Ein kleines "P"-Badge auf PASTE/INSERT zeigt an, wenn der Palette-Clip statt des Clipboards verwendet wird.
- Die Buttons sind deaktiviert, wenn weder Clipboard noch Palette-Clip verfügbar sind.
- Tooltip zeigt die jeweils aktive Quelle (`Zwischenablage` oder `Palette: <Clip-Name>`).

### Undo/Redo
- Stellen jetzt Segmente, Cues und Auswahl exakt wieder her und rendern den Buffer neu.
- Beide Stacks werden korrekt geleert/befüllt.

## Edit-Funktionen im Überblick

| Aktion    | Tastatur     | Verhalten                                                                 |
|-----------|--------------|---------------------------------------------------------------------------|
| CLONE     |              | Kopiert Auswahl als neuen Palette-Clip.                                   |
| COPY      | `Ctrl+C`     | Kopiert Auswahl in Zwischenablage (keine Segmente ändern).                |
| CUT       | `Ctrl+X`     | COPY + DELETE.                                                             |
| PASTE     | `Ctrl+V`     | Fügt Inhalt an Playhead ein (Quelle: Clipboard → Palette-Fallback).       |
| INSERT    |              | Wie PASTE, mit explizitem Feedback "Zeit öffnet sich".                    |
| REPLACE   |              | Ersetzt Auswahl durch Quelle (Quelle: Palette-Clip).                      |
| OVERDUB   |              | Mischt Quelle über Auswahl (Original bleibt).                             |
| DELETE    | `Entf`       | Entfernt Bereich, schiebt folgende Segmente + Cues nach vorne.            |
| CLEAR     |              | Schaltet Bereich stumm (CUT-Segment); Länge + Beatgrid bleiben.           |
| UNDO      | `Ctrl+Z`     | Stellt vorherigen Zustand aus Snapshot wieder her.                        |
| REDO      | `Ctrl+Y`     | Stellt letzten UNDO-Schritt wieder her.                                   |

## Tests / Screenshot-Beweise

Playwright-Test: `tests/edit-workflow.test.mjs`

Der Test öffnet die App, führt alle 8 Edit-Aktionen plus Palette-Insert systematisch durch und legt 13 Screenshots in `tests/screenshots/` ab:

1. `01_initial.png` – App-Start
2. `02_selection_8beat.png` – 8-Beat-Selection
3. `03_copy.png` – COPY aktiviert Clipboard
4. `04_clone.png` – CLONE fügt Palette-Clip hinzu
5. `05_palette_insert.png` – **Palette-INSERT @ Playhead** (der Hauptbugfix!)
6. `06_clear.png` – CLEAR erzeugt Stummblock
7. `07_delete.png` – DELETE rückt Material nach vorne
8. `08_paste.png` – PASTE an Playhead
9. `09_insert.png` – INSERT mit Cue-Verschiebung
10. `10_replace.png` – REPLACE mit Palette-Clip
11. `11_overdub.png` – OVERDUB-Überlagerung
12. `12_undo.png` – UNDO
13. `13_redo.png` – REDO

Ausführen:
```bash
npm run dev &                                  # Vite-Server starten
npx playwright install chromium
node tests/edit-workflow.test.mjs
```

## CI / Geplanter Build

`.github/workflows/windows-build.yml`:
- Trigger: push auf `main`, `release/**`, `arena/**`; Tags `v*`; Pull Requests; manuell.
- **Geplante Builds:**
  - `0 3 * * *` – täglich um 03:00 UTC (05:00 DE), baut `main`.
  - `37 * * * *` – stündlicher Build (Rauch-Test, ob der neueste Stand baut).
- Erzeugt Windows-Installer (NSIS) und Portable EXE, lädt sie als Artefakt hoch, erstellt bei Tags ein GitHub-Release.

## Klonen und bauen

**PowerShell 5.1** (kein `&&`):
```powershell
git clone https://github.com/Airdox/airdox_editor.git ; cd airdox_editor ; git checkout v0.4.3 ; npm ci ; npm run build ; npx electron-builder --win nsis --win portable
```

**Bash/cmd:**
```bash
git clone https://github.com/Airdox/airdox_editor.git && cd airdox_editor && git checkout v0.4.3 && npm ci && npm run build && npx electron-builder --win nsis --win portable
```

Die fertigen `.exe`-Dateien liegen anschließend unter `release/`.
