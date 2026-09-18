# Logging-System (Allumfassende Diagnose & Audit-Protokollierung)

Der airdox_SMART_Editor schreibt seit dieser Version **jedes relevante Ereignis
dauerhaft in Dateien** – nicht mehr nur in die browser-interne Konsole oder
einen flüchtigen Speicherpuffer. Das System besteht aus drei Schichten, die in
gemeinsamen Tagesdateien zusammenlaufen.

## 1. Speicherort der Log-Dateien

| Umgebung | Verzeichnis |
| --- | --- |
| Windows-Desktop (installiert/portabel) | `D:\airdox_SMART_Editor\Data\logs\` (strikt D:, siehe BUILD_WINDOWS.md) |
| macOS-Desktop | `~/Library/Application Support/airdox_SMART_Editor/logs/` |
| Linux-Desktop | `~/.config/airdox_SMART_Editor/logs/` |
| Entwicklung (`npm run dev`) | `<Repository>/logs/` |

Dateiname: `airdox-editor-YYYY-MM-TT.log` (eine Datei pro Tag, UTF-8).

Aufbewahrung: standardmäßig **14 Tage**, danach werden alte Tagesdateien
automatisch gelöscht. Einstellbar über die Umgebungsvariablen:

- `AIRDOX_LOG_LEVEL` – `DEBUG` | `INFO` (Standard) | `WARN` | `ERROR` | `FATAL`
  (Desktop-Entwicklung läuft automatisch auf `DEBUG`.)
- `AIRDOX_LOG_RETENTION_DAYS` – Anzahl Aufbewahrungstage (Standard `14`).

## 2. Drei Protokoll-Schichten

1. **Main-Prozess / Node** – `electron/logger.cjs`
   - Electron-Lifecycle, Fenster-/Prozessabstürze, App-Protokoll (`airdox://`)
   - **automatisches Audit jedes IPC-Kanals** (Aufruf, Argumente als
     kompakte Zusammenfassung, Dauer, Ergebnis, Fehler)
   - Python-/Demucs-Kindprozesse (Preflight, Modell-Checkpoints, Fortschritt,
     Exit-Code, Ausgabe-Tail bei Fehlern)
   - globaler Abfang von `uncaughtException` / `unhandledRejection` / SIGINT/SIGTERM
   - im Dev-Server zusätzlich ein **HTTP-Audit** jeder Anfrage (Methode, Pfad,
     Status, Dauer, Größe)
2. **Renderer (UI)** – `src/utils/logger.ts`
   - Ringpuffer (2.000 Einträge) für das Live-Modal, **plus** Dauerpersistenz
   - Einspeisung in die Datei über eine dedizierte, Sandbox-sichere
     Preload-Brücke (`logs:write`) bzw. im Browser über `POST /api/logs`
   - zusätzliche Sicherung im `localStorage` (übersteht auch ohne Bridge Neuladen)
   - Abfang von `window.error`, `unhandledrejection`, `console.warn/error`
     aus Drittcode sowie `fetch()`/`XMLHttpRequest` (Fehler & langsame Anfragen)
3. **Anwendungslogik** – alle Engine-/Import-/Export-Module nutzen einheitlich
   den Logger (Audio-Engine, Stems, MIDI, Wellenform/BPM, XML-/ANLZ-/DB-Import,
   Projekt-Persistenz, Chatbot, Exporte).

Haupt- und Renderer-Protokoll stehen in **derselben Tagesdatei**; die Quelle ist
an der Kennung `[main/...]`, `[server/...]` bzw. `[renderer/...]` und der
Session-ID in geschweiften Klammern erkennbar. Jeder App-Start schreibt einen
Session-Header mit App-/System-/Versionsinformationen.

## 3. Level & Kategorien

Level: `DEBUG < INFO < WARN < ERROR < FATAL`

Kategorien: `SYSTEM, IPC, NETWORK, PERFORMANCE, UI, AUDIO_ENGINE, STEMS, MIDI,
WAVEFORM, BEATGRID, EDITING, XML_IMPORT, DATABASE, PROJECT, EXPORT, CHATBOT`
(fremde Konsolenmeldungen laufen über `CONSOLE`).

Binärdaten (Audio-/WAV-/ANLZ-Puffer) werden **niemals** ins Log geschrieben,
sondern als `{ __binary, byteLength }` zusammengefasst. API-Keys, Tokens und
Passwörter werden automatisch als `[redacted]` geschwärzt.

## 4. Betrachtung & Export

- **Menü: Hilfe → System-Protokoll…** – Live-Ansicht mit Volltextsuche,
  Level-/Kategoriefilter, Auto-Scroll, Kopieren, JSON-Diagnosebericht und der
  Schaltfläche **„Log-Ordner"**, die das Betriebssystem-Verzeichnis direkt öffnet.
  Die Fußzeile zeigt den exakten Pfad der aktuellen Logdatei und die
  geschriebene Eintragszahl.
- **Diagnosebericht** (JSON) enthält Session-ID, Umgebung, Speicherauslastung,
  den kompletten Ringpuffer und bei Abstürzen den Komponenten-Stacktrace
  (auch direkt aus dem Absturz-Dialog des `ErrorBoundary`).

## 5. Tests

- `tests/file-logger.test.mjs` sichert Dateierzeugung, Session-Header,
  Level-Filter, Renderer-Zusammenführung, Log-Tail-Lesen, Schwärzung/
  Binärzusammenfassung, Aufbewahrung/Löschung, Konsolen-Abfang ohne
  Duplikate und den synchronen Flush beim Prozessende ab.
- Die Testsuite wird über `npm test` ausgeführt; der Logger-Test läuft als
  erster Schritt.
