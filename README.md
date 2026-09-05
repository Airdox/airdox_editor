# Rekordbox Desktop Import

Desktop-App (Electron, Windows x64) für die Rekordbox-Bibliothek: XML-Kollektion,
ANLZ-Analysedateien und die SQLCipher-Datenbanken `master.db` (Rekordbox 6/7) bzw.
`exportLibrary.db` (OneLibrary / Device Library Plus) werden **ausschließlich lesend**
ausgewertet. Original-Audio, XML-, ANLZ- und Datenbankdateien werden nie verändert;
eigene Audioberechnungen sind ausdrücklich als Fallback gekennzeichnet.

Stand und offene Punkte: [VORHABEN.md](VORHABEN.md) · Windows-Build: [BUILD-WINDOWS.md](BUILD-WINDOWS.md)

## Entwicklung

```bash
npm install
npm run dev        # Vite-Dev-Server (Browser-Modus, ohne Read-Only-Bridge)
npm run desktop    # baut dist und startet die Electron-App
npm run lint       # tsc --noEmit
npm test           # XML-, ANLZ-, Last- und SQLCipher-Tests
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
electron/       Hauptprozess: Read-Only-Bridge, SQLCipher-Codec, Datenbankleser
src/            React-Editor (Decks, Waveform, Beatgrid, Cues, Import-Dialoge)
src/rekordbox/  XML-Parser, ANLZ-Parser, Datenbank-Mapping, Fallback-Datensätze
tests/          Test-Suiten + synthetic erzeugte SQLCipher-Fixtures
tools/          Fixture-Erzeugung, Windows-Diagnose, Cleaning
```

## Hinweis zu API-Schlüsseln

`GEMINI_API_KEY` wird nur für optionale KI-Hilfsfunktionen aus dem
AI-Studio-Grundgerüst benötigt (`.env.example`); für die Desktop-Importpfade ist
kein Netzwerkzugriff nötig.
