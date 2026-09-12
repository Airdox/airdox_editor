# airdox_SMART_Editor

Nicht-destruktiver DJ-Audio-Editor für den Rekordbox-Workflow: XML-Bibliothek und `master.db`
werden **lesend** geöffnet, Waveformen stammen aus den echten Rekordbox-Analysedaten
(`ANLZ`/`PWAV`/`PQTZ`), eigene Audiodateien lassen sich importieren, schneiden, neu griden und
als WAV oder Rekordbox-XML wieder ausgeben. Plattform: Electron (Windows) und Browser.

```
npm install
npm run dev          # Vite-Dev-Server, http://localhost:3000
npm run desktop      # gebaut + Electron starten
npm test             # alle Suiten: 25 Skript-Suiten (tsx) + vitest (jsdom)
npm run lint         # tsc --noEmit (prüft auch tests/)
npm run coverage     # Abdeckung beider Messebenen, zusammengeführt: coverage/coverage-merged.json
npm run package:win  # Windows-Setup + portable .exe (siehe BUILD_WINDOWS.md)
```

## Was die App kann

* **Import:** Rekordbox XML (mit Track-Auswahl), `data/master.db` / `exportLibrary.db`
  (optional, braucht das SQLCipher-Modul), WAV/MP3/FLAC per Datei oder Drag & Drop.
* **Waveform:** 3-Band-/RGB-/Blue-Darstellung aus den Rekordbox-Varianten (preview/detail/color),
  echte PQTZ-Beatzeiten, kein Nachberechnen, Glätten oder Mitteln.
* **Editieren:** Auswahl → Palette (Clone), Insert/Replace/Overdub auf der Timeline, Beatgrid
  verschieben, Takt 1.1 setzen, Auto-Align (sichtbar als `USER_EDIT` gekennzeichnet), Undo/Redo,
  Löschen/Clear, Memory Cue / Hot Cue, Quantisierung.
* **Ausgabe:** Master-WAV (16-Bit PCM) über den Mehrschichten-Render-Inspektor, Rekordbox XML,
  Projektdatei `.airdox.json` mit eingebettetem Clip-Audio.
* **Originalschutz:** Zielkollisionen werden abgewiesen (`electron/pathGuard.cjs`), Quelldateien
  bleiben unberührt; Herkunft jeder Welle ist beschriftet
  (`REKORDBOX_ANLZ` / `REKORDBOX_XML` / `USER_EDIT` / `GENERATED_TEST`).

## Struktur

```
src/
  App.tsx                Komposition aller Bereiche (Transport, Import, Edit, Projekt-Persistenz)
  audio/                 AudioEngine (Playback, Slice, WAV-Export), Pitch/Tempo
  waveform/              Analyzer (Buckets), RenderModel (reine Daten, malt nichts)
  rekordbox/             XML-Parser/-Export, ANLZ-Parser, DB-Extractor, Projektdatei
  edit/                  Edit-Modell, Timeline-Projektion, Drop-Planung, Wellenform-Aufrechnung
  dnd/                   Drag-&-Drop-Payloads
  components/            Chrome (Titel-/Menüleiste, Browser, Palette, Deck-Ansichten, Waveforms),
                         components/Modals/ die acht Dialoge
  utils/                 Logger (einzige Log-Senke), Datei-Log-Brücke
electron/                main.cjs (Fenster, IPC, airdox://app-Protokoll), dbReader, pathGuard, logWriter
tests/                   Skript-Suiten (Datenvertrag), ui/ (jsdom), workflow/ (Szenariomatrix),
                         unit/, helpers/, setup/, fixtures/
reference/               Referenz-Screenshots des Rekordbox-EDIT-Views (visuelle Abnahme)
docs/                    Lesereihenfolge, Analyse, Session-Protokolle
```

## Dokumentation

`docs/README.md` listet die Reihenfolge: `AGENTS.md` (Arbeitsregeln) →
`REKORDBOX_PIPELINE_ARCHITECTURE.md` (Datenfluss) →
`REKORDBOX_PIPELINE_IMPLEMENTATION_AUDIT.md` (Umsetzungsnachweis je Stufe) →
`VORHABEN.md` (Planung, dokumentierte Abweichungen) → `BUILD_WINDOWS.md` (Paketbau) →
`docs/PROJEKTANALYSE_2026-09-12.md` (Verbesserungsvorschläge) → `docs/sessions/` (Übergaben).

## Tests

Ein Runner, zwei Messebenen: `node tests/run-all.mjs` entdeckt alle `tests/*.test.ts|mjs` (tsx,
Datenvertrag) und lässt vitest (jsdom: Komponenten, Workflows, Unit) laufen. `npm run coverage`
misst beide Ebenen **getrennt** und führt sie pro Datei zusammen — ein gemischter Lauf wäre
falsch, weil tsx und esbuild dieselbe Datei unterschiedlich transformieren.
`tests/test-registry.test.ts` verhindert, dass eine Suite oder ein Verzeichniseintrag verloren geht.

## Windows-Build

Lokal: `npm run package:win` (kein Visual Studio nötig; ohne C++-Toolchain bleibt der DB-Import
abgeschaltet und wird von der App sauber gemeldet). Automatisiert: GitHub Actions
`.github/workflows/windows-build.yml` baut NSIS + portable, kompiliert das SQLCipher-Modul und
erzeugt bei einem Tag `v*` ein GitHub-Release. Einzelheiten in [`BUILD_WINDOWS.md`](BUILD_WINDOWS.md).
