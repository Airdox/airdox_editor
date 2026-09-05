# Airdox_intelligents_Editor

Desktop-App (Electron, Windows x64) für die Rekordbox-Bibliothek: XML-Kollektion,
ANLZ-Analysedateien und die SQLCipher-Datenbanken `master.db` (Rekordbox 6/7) bzw.
`exportLibrary.db` (OneLibrary / Device Library Plus) werden **ausschließlich lesend**
ausgewertet. Original-Audio, XML-, ANLZ- und Datenbankdateien werden nie verändert;
eigene Audioberechnungen sind ausdrücklich als Fallback gekennzeichnet.

Am geladenen Arbeits-Sound wird zerstörungsfrei gearbeitet: schneiden, einfügen,
darüberlegen, Bereiche ersetzen, alles rückgängig – und das Ergebnis als Projektdatei
(`.airdoxproj.json`) mit eingebetteter Arbeitskopie speichern und wieder öffnen.
Clips liegen in einer Clip-Bibliothek und lassen sich per Drag & Drop in die
Wellenform oder in den Deck-Spieler ziehen.

Stand und offene Punkte: [VORHABEN.md](VORHABEN.md) · Windows-Build: [BUILD-WINDOWS.md](BUILD-WINDOWS.md) ·
Woher die Wellenform-Daten kommen: [WELLENFORM-DATEN.md](WELLENFORM-DATEN.md)

## Entwicklung

```bash
npm install
npm run dev        # Vite-Dev-Server (Browser-Modus, ohne Read-Only-Bridge)
npm run desktop    # baut dist und startet die Electron-App
npm run lint       # tsc --noEmit
npm test           # XML-, ANLZ-, Last-, SQLCipher-, Edit-, Clip-, Farb- und Projektsuiten
npm run proof:edit-workflow   # Schnitt-Nachweis inklusive WAVs und NACHWEIS.md
npm run proof:clip-library    # Clip-Bibliothek: Konsistenz, Drag & Drop, Ablagezeit
npm run proof:project        # Projektdatei: Speichern, Öffnen, Validierung
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
src/audio/       PCM-Kern, WAV-Ein-/Ausgabe, Schnitt-Operationen, Clip-Bibliothek
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
