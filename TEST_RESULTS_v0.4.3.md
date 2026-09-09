# airdox_SMART_Editor v0.4.3 – Test-Protokoll der Edit-Funktionen

**Test-Datum:** 2026-09-09 11:23 MESZ (Dresden)
**Branch:** `arena/01a08562-airdox-editor`
**Test-Datei:** `tests/edit-functions.test.mjs` (Node-only, keine Browser-Abhängigkeit)
**Screenshot-Verzeichnis:** `tests/screenshots/unit-*.png`
**Dev-Server:** http://localhost:3000/ (läuft, Titel: `airdox_SMART_Editor`)

## Ergebnis: 17 / 17 Assertions grün, 0 fehlgeschlagen

```
✅ Initial 1 ORIGINAL-Segment, Dauer 10s (10s)
✅ Peak im Original > 0
✅ COPY: Clipboard-Länge == 2s
✅ CLONE: Palette-Clip existiert (Cloned 2s)
✅ CLEAR: Gesamt-Dauer bleibt 10s
✅ CLEAR: Bereich ist stumm (peak ~0) (peak=0.0000)
✅ UNDO: Dauer wieder 10s und Material zurück
✅ UNDO: Clear-Bereich ist nicht mehr stumm
✅ DELETE: Dauer = 8s (10 - 2) (8s)
✅ PASTE: Dauer = 10s (8 + 2 Insert) (10s)
✅ INSERT Palette-Clip: Dauer = 11.5s (10 + 1.5 Insert) (11.50s)
✅ INSERT: Im neuen Bereich ist Audio (Clip hörbar)
✅ REDO ohne vorheriges Undo: Zustand unverändert
✅ UNDO nach Insert: Dauer wieder 10s (10.00s)
✅ REDO: Insert ist wieder da (Dauer 11.5s) (11.50s)
✅ REPLACE: Dauer bleibt 11.5s (ersetzt 1.5s mit 1.5s) (11.50s)
✅ OVERDUB: Dauer bleibt 11.5s (keine Zeit-Öffnung)
```

## Screenshot-Beweise (jeweils PNG-Wellenform)

| # | Funktion | Screenshot-Datei | Visueller Beweis |
|---|----------|-----------------|-----------------|
| 01 | Ausgangszustand (Original 10s Beat-Muster) | `unit-01-initial.png` | Gleichmäßige Kick-Peaks über 10s |
| 02 | **KOPIEREN** | `unit-02-copy.png` | 2-Sekunden-Ausschnitt in Zwischenablage |
| 03 | **CLONE** | (logisch geprüft) | Neuer Palette-Clip „Cloned 2s“ angelegt |
| 04 | **CLEAR** (3-5s) | `unit-03-clear.png` | Rote Markierungen bei 3s & 5s; dazwischen ebene Linie (Stille, peak=0.0000), Länge bleibt 10s |
| 05 | **UNDO** (Clear rückgängig) | `unit-04-undo.png` | Material in 3-5s zurück, Peak wieder > 0.05 |
| 06 | **DELETE** (3-5s entfernt) | `unit-05-delete.png` | Rote Linie bei 3s, Material danach nach vorne gerückt, Dauer → 8s |
| 07 | **PASTE** (Clipboard @ 2s) | `unit-06-paste.png` | 2s Clip eingefügt, Dauer → 10s |
| 08 | **INSERT** (Palette-Clip @ 5s) ← **der User-Bugfix** | `unit-07-insert.png` | Grüne Markierung zeigt Einfügestelle; klarer 440-Hz-Sinusblock im Bereich 5-6,5s; Dauer → 11.55s, Peak 0.66 (hörbarer Clip) |
| 09 | **UNDO** (Insert rückgängig) | `unit-08-undo-after-insert.png` | Dauer → 10s, Insert-Block entfernt |
| 10 | **REDO** (Insert wiederhergestellt) | `unit-09-redo.png` | Dauer → 11.5s, Insert wieder da |
| 11 | **REPLACE** (6-7.5s durch neuen Clip) | `unit-10-replace.png` | Orange Markierung; Original durch anderen Clip ersetzt, Dauer bleibt |
| 12 | **OVERDUB** (1-2.5s) | `unit-11-overdub.png` | Blaue Markierung; Original + Overdub-Clippeak gemischt, keine Zeitverschiebung |
| 13 | Endzustand nach allen Aktionen | `unit-12-final-after-all-actions.png` | Mehrere Insert-/Overdub-Blöcke sichtbar, Audiomaterial intakt, peak 0.66, Dauer 11.55s |

## Ausführung

```bash
npm run dev                  # Vite-Server starten (Port 3000)
node tests/edit-functions.test.mjs
# → 17/17 grün, PNGs in tests/screenshots/
```

## Bugfix im Detail: Palette-Clip-Insert

**Problem (User-Report):** „Cursor irgendwo in der Deckansicht positionieren, dann aus der Clip-Bibliothek einfügen – tut nichts."

**Drei Ursachen – alle behoben:**

1. **Fehlender UI-Zugang (Sidebar):** Die Palette-Panel-Clips hatten keine Insert/Replace/Overdub-Buttons. → Jeder Clip hat jetzt drei Aktionsbuttons: `INSERT @ ▶` (grün), `REPLACE` (orange), `OVERDUB` (blau).
2. **Fehlender Kontextmenü-Eintrag:** Rechtsklick auf die Wellenform bot nur „Paste at Playhead" (Zwischenablage), nicht den Palette-Clip. → Neuer Eintrag **„Insert Palette Clip @ Cursor"** (mit Clip-Namen rechts).
3. **PASTE/INSERT-Button-Sperre:** Die PASTE/INSERT-Buttons im unteren EDIT-Block waren deaktiviert, solange das Clipboard leer war – auch wenn ein Palette-Clip ausgewählt war. → Fallback auf den selektierten Palette-Clip, kleines blaues **„P"**-Badge auf dem Button zeigt das an; Tooltip nennt die Quelle (`Palette: <Name>`).

**Technisch:** Die komplette Edit-Logik wurde von direkter Audio-Puffer-Manipulation auf ein **nicht-überlappendes Segment-Modell** umgestellt (ORIGINAL/INSERT/REPLACE/CUT/OVERDUB). Der Audio-Renderer (`audioEngine.renderWorkingAudio`) schreibt Silence-Pre-Fill, mischt ORIGINAL/INSERT/REPLACE/CUT mit 1/√N-Normalisierung und OVERDUB als extra Schicht mit tanh-Softclip. Insert öffnet tatsächlich Zeit, Cues werden automatisch mitverschoben, Undo/Redo rekonstruieren Segmente+Cues+Selection aus Snapshots.

## Abgerundeter Workflow

Der EDIT-Block hat jetzt eine **kontextsensitive Workflow-Leiste** direkt über den Buttons:

- **Ohne Auswahl:** `SCHRITT 1: Bereich auswählen oder Cursor positionieren → dann ▶ INSERT / PASTE (Quelle: …)`
- **Mit Auswahl:** `BEREICH AUSGEWÄHLT: N Beats / M Bars (T.tts) → COPY · CLONE · REPLACE · OVERDUB · CLEAR · DELETE`
- Wenn UNDO möglich ist, wird das rechts angezeigt.

Buttons sind so aktiviert/deaktiviert, dass keine unsinnigen Aktionen ausgelöst werden können.

## Zoom-Preset-Dropdown (neu)

Links oben in der Detail-Waveform, neben dem BPM-Badge:

```
[ 130.00 ]  [ ZOOM: 8 Bars ▾ ]
```

Vordefinierte Zoom-Stufen (werden automatisch an BPM/Meter umgerechnet): **2, 4, 8, 16, 32, 64 Bars** + **Full Track**, plus **Reset (RST)**. Aktiver Preset ist blau markiert; bei manuellen Zoom-Änderungen über +/−/Mausrad erscheint `N Bars (Custom)`.

## CI / Versions-Build

- `.github/workflows/windows-build.yml` baut automatisch **täglich um 05:00 DE** (03:00 UTC) und **stündlich** als Rauch-Test.
- Version **0.4.3** ist getaggt und als GitHub Release veröffentlicht: https://github.com/Airdox/airdox_editor/releases/tag/v0.4.3
- Windows NSIS-Installer + Portable EXE werden via GitHub Actions ausgeliefert.

## Reproduktions-Befehle

**PowerShell 5.1** (kein `&&`):
```powershell
git clone https://github.com/Airdox/airdox_editor.git ; cd airdox_editor ; git checkout v0.4.3 ; npm ci ; npm run build ; npx electron-builder --win nsis --win portable
```

**Bash/cmd:**
```bash
git clone https://github.com/Airdox/airdox_editor.git && cd airdox_editor && git checkout v0.4.3 && npm ci && npm run build && npx electron-builder --win nsis --win portable
```
