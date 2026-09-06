# Airdox_intelligents_Editor

Desktop-App (Electron, Windows x64) für die Rekordbox-Bibliothek: XML-Kollektion,
ANLZ-Analysedateien und die SQLCipher-Datenbanken `master.db` (Rekordbox 6/7) bzw.
`exportLibrary.db` (OneLibrary / Device Library Plus) werden **ausschließlich lesend**
ausgewertet. Original-Audio, XML-, ANLZ- und Datenbankdateien werden nie verändert;
eigene Audioberechnungen sind ausdrücklich als Fallback gekennzeichnet.

Am geladenen Arbeits-Sound wird zerstörungsfrei gearbeitet: schneiden, einfügen,
darüberlegen, Bereiche ersetzen, alles rückgängig – und das Ergebnis als Projektdatei
(`.airdoxproj.json`) mit eingebetteter Arbeitskopie speichern und wieder öffnen.
Clips liegen in einer Clip-Bibliothek: per Drag & Drop in die Wellenform oder in den
Deck-Spieler ziehen, oder über das Rechtsklick-Menü (einfügen, ersetzen, darüberlegen,
in den Deck-Spieler, duplizieren, umbenennen, neu ordnen, als WAV exportieren,
entfernen). Vor jedem Einfügen in eine Spur wird der Clip pegelangepasst – Ziel ist
ein Spitzenpegel von −1 dBFS, höchstens +12 dB Boost, nichts über 0,999; beim
Darüberlegen senkt der Headroom-Mischer den zugeführten Clip so weit ab, dass die
Summe die Obergrenze nicht überschreitet.

Landet der Clip in einer Spur mit anderem Tempo, wird seine Dauer auf das Zielraster
gerechnet (`speed = Ziel-BPM / Quellen-BPM`) – standardmäßig mit gehaltener Tonhöhe
(Phasenvocoder, entspricht Master Tempo mit Key-Lock); mit der Checkbox „Tonhöhe folgt
dem Tempo“ wandert sie im gleichen Verhältnis mit (Neusampling, Key-Lock aus). Beide
Schalter sitzen in der Leiste der Clip-Bibliothek und in deren Rechtsklick-Menü, die
sich zu einer vollständigen Deck-Ansicht ausklappen lässt: Wellenform mit Playhead,
Ein-/Ausstieg, Schleife, Vorschau mit oder ohne Angleichung, Einfügen in die
aktive Spur – derselbe Spieler, der unten im Kontrollblock läuft.

Stand und offene Punkte: [VORHABEN.md](VORHABEN.md) · Windows-Build: [BUILD-WINDOWS.md](BUILD-WINDOWS.md) ·
Maßstab für jede Daten-Änderung: Rekordbox ist die Analyse-Engine – Beatgrid,
Tempo, Cues und alle Wellenform-Auflösungen werden eingelesen und dargestellt,
nichts davon wird neu erfunden. Ausnahmen sind am Wert beschriftet
(`origin`, `recomputed`) und im Editor sichtbar. Nachweis:
`npm run proof:source-of-truth`. Details in [WELLENFORM-DATEN.md](WELLENFORM-DATEN.md) ·
Stem-Dateien (Recherche, nichts gebaut): [STEMS-RECHERCHE.md](STEMS-RECHERCHE.md)

## Entwicklung

```bash
npm install
npm run dev        # Vite-Dev-Server (Browser-Modus, ohne Read-Only-Bridge)
npm run desktop    # baut dist und startet die Electron-App
npm run lint       # tsc --noEmit
npm test           # XML-, ANLZ-, Last-, SQLCipher-, Edit-, Clip-, Farb-, Tempo-, Projekt- und Workflow-Suiten
npm run proof:workflow-real  # Nachweis des echten Workflows: 8 Takte ausschneiden → als Clip
                             # einfügen (mit Pegelangleichung) → Ende nach vorne → Undo → Projekt
npm run proof:tempo-pitch    # Nachweis Tempo- und Tonhöhenanpassung (Phasenvocoder, Key-Lock)
npm run proof:edit-workflow  # Schnitt-Nachweis inklusive WAVs und NACHWEIS.md
npm run proof:clip-library   # Clip-Bibliothek: Pegel, Konsistenz, Drag & Drop, Ablagezeit
npm run proof:waveform-colors # Farbtreue der Wellenform (AMBER, BLUE, RGB, 3BAND)
npm run proof:project        # Projektdatei: Speichern, Öffnen, Validierung
npm run proof:source-of-truth  # Nachweis: alle Werte kommen aus ANLZ/DB, Eigenrechnung nur als ausgewiesener Ausnahmefall
```

## Windows-Paket (ohne Visual Studio)

```bat
npm ci
npm run package:win
```

Ergebnis in `release\`: NSIS-Installer und eine Portable-EXE. Der Datenbank-Import
nutzt im Paket den reinen JavaScript-Leser (SQLCipher-Entschlüsselung mit
`node:crypto` + SQLite als WebAssembly), es ist kein natives Modul und kein
C-Compiler erforderlich. Details, Fehlersuche und der optionale native Pfad stehen
in [BUILD-WINDOWS.md](BUILD-WINDOWS.md).

## Struktur

```
electron/        Hauptprozess: Read-Only-Bridge, datei:*-Kanäle, SQLCipher, DB-Leser
src/             React-Editor (Deck, Wellenform, Beatgrid, Cues, Clip-Bibliothek)
src/audio/       PCM-Kern, WAV-Ein-/Ausgabe, Schnitt-Operationen, Clip-Bibliothek und Pegelregeln
src/waveform/    Peaks/Bänder-Analyse und Farbrechnung (AMBER, BLUE, RGB, 3BAND)
src/projects/    Projektformat und Datei-Ein-/Ausgabe
src/rekordbox/   XML-Parser, ANLZ-Parser, Datenbank-Mapping, Fallback-Datensätze
tests/           Test-Suiten, Beweis-WAVs und synthetic erzeugte SQLCipher-Fixtures
tools/           Fixture-Erzeugung, Windows-Diagnose, Cleaning
```

## Hinweis zu API-Schlüsseln

`GEMINI_API_KEY` wird nur für optionale KI-Hilfsfunktionen aus dem
AI-Studio-Grundgerüst benötigt (`.env.example`); für die Desktop-Importpfade ist
kein Netzwerkzugriff nötig.
