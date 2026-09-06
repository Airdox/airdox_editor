<div align="center">
  <img src="build/icon.png" width="128" alt="Airdox Smart Editor" />

  <h1>Airdox Smart Editor</h1>

  <p><strong>Nicht-destruktiver DJ-Audio-Editor für Rekordbox-Bibliotheken.</strong></p>
</div>

---

## Was die Anwendung macht

Airdox Smart Editor liest eine bestehende Rekordbox-Bibliothek (XML-Collection,
ANLZ-Analysedateien, verschlüsselte `master.db`) ein und stellt die Tracks in
einem Wellenform-Editor im Rekordbox-Stil dar. Alle Bearbeitungen finden in
einem **Edit-Graph** statt: Die Originaldateien werden zu keinem Zeitpunkt
verändert oder überschrieben.

### Kernfunktionen

- **Import** – Rekordbox-XML-Collections, ANLZ-Dateien (`.DAT`/`.EXT`) und
  Rekordbox-6-Datenbanken inklusive Beatgrid, Cue-Punkten, Loops und Phrasen.
- **Nicht-destruktiver Schnitt** – Segmente vom Typ `ORIGINAL`, `INSERT`,
  `REPLACE`, `OVERDUB` und `CUT` bilden die Bearbeitung ab; Undo/Redo über den
  gesamten Verlauf.
- **Palette** – Audio-Schnipsel ablegen, harmonisch tonhöhen- und
  tempo-angepasst wieder einfügen (WSOLA-Time-Stretch, Camelot-Key-Matching).
- **Effekt-Spuren** – Zeitbasierte Effektsegmente (Gain, Lowpass, Echo) über
  eine testbare, reine DSP-Engine (`src/audio/effectEngine.ts`).
- **Render-Inspektor** – Zeigt vor dem Export das reale Schichtenmodell aus den
  Arbeitssegmenten der Spur, nicht etwa Beispielwerte.
- **Export** – WAV-Master, Rekordbox-XML und Projektdatei (JSON).
- **Desktop** – Läuft als Electron-Anwendung (NSIS-Installer und Portable-EXE
  für Windows).

## Originalschutz

Alle Medienreferenzen werden mit `accessMode: 'READ_ONLY'` geführt. Ein
Pfad-Guard (`tests/path-guard.test.mjs`) stellt in der Testsuite sicher, dass
kein Schreibpfad auf eine Originaldatei zeigt. Zusätzlich wird der SHA-256 der
Quelldatei mitgeführt.

## Entwicklung

**Voraussetzung:** Node.js 20 oder neuer.

```bash
npm install      # Abhängigkeiten installieren
npm run dev      # Vite-Dev-Server auf Port 3000
npm test         # Testsuite (Import, DSP, Projektdatei, Pfad-Guard)
npm run build    # Produktions-Build nach dist/
```

### Electron / Windows-Build

```bash
npm run electron:dev    # Electron gegen den Dev-Server
npm run dist:win        # NSIS-Installer + Portable-EXE nach release/
```

Details siehe [BUILD_WINDOWS.md](./BUILD_WINDOWS.md).

## Projektstruktur

```
electron/   Electron Main- und Preload-Prozess
src/
  audio/       Audio-Engine, Pitch-/Tempo-Engine, Effekt-Engine
  components/  React-UI (Titelleiste, Menü, Wellenformen, Modals)
  rekordbox/   XML-, ANLZ- und Datenbank-Reader
  types/       Gemeinsame Datenmodelle
  waveform/    Wellenform-Analyse und -Rendering
tests/      Node-Testsuite (tsx / node)
build/      Anwendungs-Icons
```

## Weitere Dokumente

- [CHANGELOG.md](./CHANGELOG.md) – Änderungen pro Version
- [VERSIONING.md](./VERSIONING.md) – Versionsschema
- [TASKS.md](./TASKS.md) – Offene und erledigte Aufgaben
- [VORHABEN.md](./VORHABEN.md) – Konzept und Zielbild
- [BUILD_WINDOWS.md](./BUILD_WINDOWS.md) – Windows-Build-Anleitung
