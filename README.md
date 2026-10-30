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

Stem-Modelle und Python-/ONNX-Runtimes sind groß und werden nicht ins Git-Repository eingecheckt. Diagnose, Installation, Offline-Bundling und Release-Gates sind in [`docs/STEM_BUNDLING.md`](docs/STEM_BUNDLING.md), [`docs/STEM_SEPARATION.md`](docs/STEM_SEPARATION.md) und [`docs/STEM_SEPARATION_ENGINE.md`](docs/STEM_SEPARATION_ENGINE.md) beschrieben. Ein übersprungener Qualitäts- oder Plattformtest gilt nicht als Freigabe. Wer die externe Zerlegung (Google Drive + Google Colab) nutzt, findet den Datenfluss Station für Station – inklusive der einen nicht messbaren Station – in [`docs/FERN_JOB_DATENFLUSS.md`](docs/FERN_JOB_DATENFLUSS.md) beschrieben.

### Schneller lokaler DJ-Pfad

Für `PREVIEW` wird SCNet als kompakter Vier-Stem-Pfad bevorzugt. Das checksum-geprüfte ONNX-Modell ist 12,9 MB groß; die App lädt es einmalig in den Modellordner und verwendet danach den lokalen Cache. SCNet verarbeitet den Track intern in überlappenden 11-Sekunden-Fenstern und meldet Fortschritt; Audio-Chunks werden nicht als Zwischen-Dateien abgelegt. Die UI bleibt währenddessen bedienbar. `PREVIEW` nutzt 50 %, `BALANCED` 40 % Fenster-Schrittweite, um wiederholte Inferenz zu begrenzen. Auf Geräten ohne nutzbaren GPU-Provider läuft es auf der CPU.

Auf dem Core i3-7020U (2 Kerne/4 Threads, Intel HD 620, 20 GB RAM) brauchte ein vollständiger 5-Minuten-CPU-Lauf mit synthetischem Testsignal im PREVIEW-Modus 10:09. BALANCED maß bei 60 Sekunden 181 s; linear hochgerechnet sind das 15:07 für fünf Minuten. Das sind Hardwaremessungen mit synthetischem Signal, keine Qualitätsmessung echter Musik. Die MUSDB18-HQ-Werte des Modellautors (Median 9,88 dB Vocals / 9,44 dB Drums / 8,35 dB Bass / 6,14 dB Other) wurden mit 25 % Schrittweite gemessen und gelten nicht als Qualitätsmessung für die schnelleren DJ-Einstellungen. Das vorhandene HT-Demucs-ONNX-Modell bleibt als Alternative verfügbar. Modellquellen, SCNet-Lizenzhinweise und Algorithmusdetails stehen in [`docs/STEM_SCNET.md`](docs/STEM_SCNET.md).

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
- [`docs/FERN_JOB_DATENFLUSS.md`](docs/FERN_JOB_DATENFLUSS.md) – Laufzettel der externen Zerlegung: Stationen, Belege, nicht messbare Schritte
- [`docs/LOGGING.md`](docs/LOGGING.md) – Logging und Diagnose
