# Windows-Build – airdox_SMART_Editor

Die App wird mit **Electron + electron-builder** zu einer nativen Windows-App gebaut.
Es entstehen zwei Artefakte im Ordner `release/`:

| Befehl | Artefakt |
| --- | --- |
| `npm run package:win:nsis` | Installer `airdox_SMART_Editor-0.4.13-setup.exe` |
| `npm run package:win:portable` | Portable `.exe` (`airdox_SMART_Editor-0.4.13-portable.exe`) |
| `npm run package:win` | beide Varianten |

## Voraussetzungen (auf dem Windows-Rechner)

1. **Node.js** (LTS, ≥ 20) – https://nodejs.org
2. **Git** (für den Klon aus GitHub)

Der Basis-Build benötigt **kein** Visual Studio: XML-/ANLZ-Import, Audio-Editor
und Export funktionieren vollständig. Das optionale SQLCipher-Modul ist per
`"npmRebuild": false` abgeschaltet, sodass der Build auch in Pfaden **mit
Leerzeichen** und ohne C++-Toolchain durchläuft.

## Bauen (PowerShell – Windows)

```powershell
git clone https://github.com/Airdox/airdox_editor.git
cd airdox_editor
npm ci
npm run package:win
```

Das fertige Setup bzw. die portable `.exe` liegt danach in `release/`.

## Automatischer Build (GitHub Actions)

Der Workflow `.github/workflows/windows-build.yml` baut **auf jedem Push
(alle Branches), auf jedem Pull Request, auf Tags `v*` und einmal täglich
um 03:00 UTC (05:00 DE)** automatisch beide Windows-Artefakte und lädt sie
als Artifact (30 Tage) hoch:

- **Jeder Commit-Push** → frischer Build unter *Actions → Windows-Build →
  Artifacts* (`airdox-smart-editor-windows`), herunterladbar als ZIP mit
  Installer + Portable-`.exe`.
- **Jeder Push auf `main`** → aktualisiert zusätzlich das Rolling-Prerelease
  `latest` unter *Releases*, sodass es dort immer die neueste WIN-App gibt
  – ganz ohne Tag.
- **Tag** (z. B. `git tag v0.4.13 && git push --tags`) → offizielles GitHub
  Release mit den `.exe`-Dateien und generierten Release-Notes.

Laufen bei schnellen Push-Folgen mehrere Builds, wird der ältere automatisch
abgebrochen – es gewinnt immer der neueste Commit.

Der Build ist robust gegen unvollständige Commits: Fehlt die
`package-lock.json` oder ist sie nicht synchron mit der `package.json`
(passiert bei parallelen Branches), schaltet der Workflow automatisch auf
`npm install` ohne Cache um und baut trotzdem – mit einer Warnung im
Build-Protokoll statt eines Abruchs. Die CI nutzt Node.js 22.

Hinweis: Die Qualitäts-Gates (`TypeScript-Prüfung`, `Waveform-Gates`) laufen
bei jedem Build mit und bleiben sichtbar, blockieren den WIN-Build aber
vorerst nicht, bis der Baum wieder vollständig grün ist (siehe
`continue-on-error` im Workflow).

## Optional: Rekordbox-Datenbank-Import (master.db / exportLibrary.db)

Der DB-Import (`better-sqlite3-multiple-ciphers`) ist optional. Ohne ihn bleibt
der XML-/ANLZ-Import voll funktionsfähig; die App meldet den nicht verfügbaren
DB-Import nachvollziehbar. Zum Aktivieren:

1. Visual Studio **Build Tools** mit „Desktopentwicklung mit C++“ installieren.
2. Modul für Electron kompilieren und erneut bauen:
   ```powershell
   npm run rebuild:electron
   npm run package:win
   ```

## Stem-Separation: trainierte Modell-Gewichte (optional)

Die Desktop-App trennt Stems mit zwei Engines:

1. **Interne Heuristik** (`dsp-heuristic-v1`) – läuft ohne Installation immer
   (auch in der Browser-Vorschau) und ist im UI als `DSP-HEURISTIK` markiert.
2. **Trainierte Gewichte** (BS-RoFormer, Mel-Band-RoFormer, MDX-Net, Demucs) –
   benötigt Python und die CLI `audio-separator`:

   ```powershell
   python -m pip install --upgrade pip
   pip install "audio-separator[cpu]"     # NVIDIA-GPU: pip install "audio-separator[gpu]"
   audio-separator --help                  # muss ohne Pfadangabe funktionieren
   ```

   Die App findet die CLI im `PATH`, in den Python-`Scripts`-Ordnern
   (`%APPDATA%/Python/<Version>/Scripts`, `~/.local/bin`) oder über die
   Umgebungsvariable `AIRDOX_AUDIO_SEPARATOR` (voller Pfad zur CLI).

   Modell-Gewichte werden **nicht** mit dem Installer ausgeliefert (Lizenz und
   Größe). Sie liegen zur Laufzeit unter
   `%APPDATA%/airdox_SMART_Editor/stem-models/` und werden entweder über
   **Bearbeiten → Stem-Modelle & Gewichte …** geladen/importiert oder beim
   ersten Trennvorgang von der CLI selbst heruntergeladen
   (`--model_filename … --model_file_dir <Modell-Ordner>`).

   Getrennte Stems landen in `%APPDATA%/airdox_SMART_Editor/separated_stems/`
   (eigener Unterordner pro Quelldatei). Originaldateien werden nie verändert.

   Fehlt die CLI oder ein Modell, bricht die App nicht ab: Sie meldet den Grund
   sichtbar und trennt mit der internen Heuristik (kein stiller Fallback).

## Hinweise

- **Read-Only-Garantie:** Original-Audio, XML, ANLZ und Datenbanken werden
  ausschließlich lesend geöffnet; Exporte/Projektdateien als neue Datei
  gespeichert (`electron/pathGuard.cjs`).
- Die App läuft im Produktionsmodus über ein eigenes privilegiertes Protokoll
  `airdox://app/`, sodass CORS-/File-Probleme (weisser Bildschirm) auch bei
  Installation in Programme-Ordner mit Leerzeichen nicht mehr auftreten.
- Die Build-Artefakte (`dist/`, `release/`) sind per `.gitignore` ausgenommen.
