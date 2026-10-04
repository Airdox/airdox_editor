# airdox SMART Editor

Browser-/Electron-basierter DJ-Audioeditor mit Waveform-Bearbeitung, Rekordbox-Import, Cues/Loops, nicht-destruktiven Edits und optionaler Stem-Separation.

## Lokal starten

**Voraussetzung:** Node.js und npm. Für die Kernfunktionen ist kein API-Schlüssel nötig.

```bash
npm ci
cp .env.example .env   # optional: GEMINI_API_KEY für Gemini-Copilot-Funktionen eintragen
npm run dev
```

Der lokale Express-/Vite-Server startet standardmäßig auf Port `3000`; abweichend mit `PORT=...` (Windows PowerShell: `$env:PORT=3000`). Öffne anschließend `http://localhost:3000`.

Ohne `GEMINI_API_KEY` bleiben Bearbeitung und lokale Copilot-Fallbacks verfügbar; Gemini-gestützte Antworten benötigen einen gültigen Schlüssel. Der Schlüssel gehört nur in die lokale `.env`-Datei bzw. die sichere Laufzeitumgebung, niemals in Renderer-Code oder ins Repository.

## Entwicklung und Tests

```bash
npm run lint   # TypeScript-Prüfung (tsc --noEmit)
npm test       # vollständige Testsuite; optionale Umgebungs-SKIPs werden ausgewiesen
npm run build  # Web-App, Stem-Bridge und Server bauen
npm start      # gebauten Server starten
```

Für die Windows-Desktop-App stehen `npm run desktop` und die Paketziele `npm run package:win`, `npm run package:win:nsis` sowie `npm run package:win:portable` bereit. Native Rekordbox-/SQLCipher- und Hardwareprüfungen müssen auf einem passenden Windows-System mit Rekordbox ausgeführt werden.

## Optionale Stem-Separation

Stem-Modelle und Python-/ONNX-Runtimes sind groß und werden nicht ins Git-Repository eingecheckt. Diagnose, Installation, Offline-Bundling und Release-Gates sind in [`docs/STEM_BUNDLING.md`](docs/STEM_BUNDLING.md), [`docs/STEM_SEPARATION.md`](docs/STEM_SEPARATION.md) und [`docs/STEM_SEPARATION_ENGINE.md`](docs/STEM_SEPARATION_ENGINE.md) beschrieben. Ein übersprungener Qualitäts- oder Plattformtest gilt nicht als Freigabe.

## Oberfläche (UI v2.0 – Drei-Zonen-Architektur)

Die Bedienoberfläche ist in genau drei Zonen geteilt: die permanente Top-Bar mit Menüs, Transport,
aktivem Track, Systemzeit und dem Umschalter **„Max. Platz / Alles einklappen"** (Zone 1), den
primären Viewport mit Wellenform und dynamischem Stem-Center (Zone 2) sowie die standardmäßig
eingeklappten Bearbeitungs-Paletten `BEAT SELECT`, `SELECT`, `EDIT` (Zone 3). Verbindlich sind die
Layout-Regeln, die Farb- und Button-Hierarchie und die Modell-Isolation des Stem-Centers:

- [`docs/UI_V2_DREI_ZONEN.md`](docs/UI_V2_DREI_ZONEN.md) – Master-Layout, Zustände A/B/C, Token-Hierarchie und deren Durchsetzung

## Technische Dokumentation

- [`docs/UI_V2_DREI_ZONEN.md`](docs/UI_V2_DREI_ZONEN.md) – Master-Layout & Workflow der Drei-Zonen-Oberfläche
- [`docs/REFAKTORISIERUNGSPLAN.md`](docs/REFAKTORISIERUNGSPLAN.md) – Befunde, priorisierte Umsetzung und offene Gates
- [`docs/REKORDBOX_DATABASE_FORMAT.md`](docs/REKORDBOX_DATABASE_FORMAT.md) – Rekordbox-Datenbank/ANLZ-Verträge
- [`docs/LOGGING.md`](docs/LOGGING.md) – Logging und Diagnose
