# airdox_SMART_Editor v0.4.4 – Windows Release

**Veröffentlichung:** 2026-09-09

## Was ist neu gegenüber v0.4.3

### 🎯 Edit-Workflow-Überholung (komplett runder Ablauf)

- **Quelle → Ziel → Operation:** Jede Edit-Aktion folgt jetzt einem klaren 3-Schritt-Modell.
- **Workflow-Leiste** direkt über dem EDIT-Block zeigt immer, was der nächste Schritt ist (Auswahl/Quelle/Aktion).
- **Kontextsensitive Button-Aktivierung:** PASTE/INSERT/REPLACE/OVERDUB sind nur aktiv, wenn eine passende Quelle existiert; DELETE/CLEAR/COPY/CLONE nur bei Auswahl.

### 🐛 Behobener Bug: Palette-Clip-Insert
Wenn der Nutzer den Cursor in der Deck-Ansicht positionierte und einen Clip aus der Bibliothek einfügen wollte, passierte bislang nichts. Jetzt **drei** Wege, einen Palette-Clip einzufügen:

1. **Sidebar-Palette:** Jeder Clip hat drei Aktions-Buttons (`INSERT @ ▶`, `REPLACE`, `OVERDUB`).
2. **Rechtsklick auf die Wellenform:** Neuer Menüpunkt **„Insert Palette Clip @ Cursor"** mit Clip-Namen.
3. **Untere EDIT-Leiste:** PASTE/INSERT fallen automatisch auf den ausgewählten Palette-Clip zurück, wenn das Clipboard leer ist (kleines blaues `P`-Badge auf dem Button; Tooltip zeigt den Clip-Namen).

### 🔍 Neues Zoom-Preset-Dropdown
Links oben in der Detail-Waveform (neben dem BPM-Badge) gibt es jetzt einen Zoom-Dropdown mit vordefinierten Stufen:

- **2 Bars** (Feinbearbeitung einzelner Beats)
- **4 Bars** (Loop-Bearbeitung)
- **8 Bars** (Standard-Phrasenbearbeitung)
- **16 Bars** / **32 Bars** / **64 Bars** (mehr Überblick)
- **Full Track** (gesamter Track in einem Fenster)
- **Reset** (zurück zum Standard-Zoom)

Die Berechnung erfolgt automatisch anhand BPM und Meter; bei manuellem Zoomen über +/−/Mausrad wird `N Bars (Custom)` angezeigt.

### 🧠 Segment-Modell-Refactoring (intern)
- Alle Edit-Handler arbeiten jetzt auf einer sauberen, nicht-überlappenden Segment-Liste (`ORIGINAL` / `INSERT` / `REPLACE` / `CUT` / `OVERDUB`) statt direkt den Audio-Puffer zu manipulieren.
- **Undo/Redo** rekonstruieren Segmente + Cues + Selection vollständig aus Snapshots.
- **Audio-Renderer:** Silence-Pre-Fill, 1/√N-Überlappungsnormalisierung, OVERDUB mit tanh-Soft-Clipping; Insert öffnet tatsächlich Zeit; Cues werden automatisch mitverschoben.
- **CLEAR** erzeugt ein CUT-Segment (Stille, Länge bleibt erhalten).
- **DELETE** entfernt Segmente im Bereich und rückt nachfolgendes Material + Cues nach vorne.

### ✅ Test-Abdeckung (17/17 grün)
Umfassender Node-Unit-Test (`tests/edit-functions.test.mjs`) – keine Browser- oder nativen Abhängigkeiten – mit 12 PNG-Waveform-Screenshots in `tests/screenshots/`:

| # | Funktion | Screenshot |
|---|----------|-----------|
| 01 | Initialzustand | `unit-01-initial.png` |
| 02 | **COPY** | `unit-02-copy.png` |
| 03 | **CLONE** | (logisch geprüft) |
| 04 | **CLEAR** | `unit-03-clear.png` (peak = 0.0000, Dauer 10s) |
| 05 | **UNDO** | `unit-04-undo.png` |
| 06 | **DELETE** | `unit-05-delete.png` (Dauer → 8s) |
| 07 | **PASTE** | `unit-06-paste.png` (Dauer → 10s) |
| 08 | **INSERT** (Palette-Clip) | `unit-07-insert.png` (Dauer → 11.5s, Peak 0.66) |
| 09 | UNDO nach Insert | `unit-08-undo-after-insert.png` |
| 10 | **REDO** | `unit-09-redo.png` |
| 11 | **REPLACE** | `unit-10-replace.png` |
| 12 | **OVERDUB** | `unit-11-overdub.png` |
| 13 | Endzustand | `unit-12-final-after-all-actions.png` |

Ausführen:
```bash
npm run dev
node tests/edit-functions.test.mjs
```

### 🏷️ Metadaten / Name
- App-Name überall auf exakt **`airdox_SMART_Editor`** normalisiert (Unterstriche, Groß-/Kleinschreibung): Fenster-Titel, `package.json`, Electron `productName`, `executableName`, NSIS-Shortcut, EXE-Dateinamen, Meta-Tags.
- `appId`: `info.airdox.smarteditor`

## Herunterladen / Installieren

Die Windows-Binärdateien (NSIS-Installer + Portable EXE) werden automatisch als GitHub-Release-Anhänge von der CI gebaut, wenn dieser Tag gepusht ist:
👉 **https://github.com/Airdox/airdox_editor/releases/tag/v0.4.4**

## Selbst bauen (PowerShell 5.1, kein `&&`)
```powershell
git clone https://github.com/Airdox/airdox_editor.git
cd airdox_editor
git checkout v0.4.4
npm ci
npm run build
npx electron-builder --win nsis --win portable
```
Die fertigen `.exe`-Dateien liegen anschließend unter `release/`.

## Systemvoraussetzungen
- Windows 10 oder neuer (64-Bit)
- ca. 200 MB freier Speicher
- Keine zusätzlichen Runtimes nötig (Electron bringt alles mit)
