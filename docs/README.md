# Dokumentation — Reihenfolge beim Lesen

| Dokument | Wofür | Wer muss es kennen |
| --- | --- | --- |
| [`../AGENTS.md`](../AGENTS.md) | Verbindliche Arbeitsregeln (Originalschutz, Waveform-Herkunft, Arbeitsreihenfolge) | alle |
| [`../REKORDBOX_PIPELINE_ARCHITECTURE.md`](../REKORDBOX_PIPELINE_ARCHITECTURE.md) | Datenfluss Rekordbox → Editor (XML, `master.db`, ANLZ/PWAV/PQTZ, Beatgrid), 30 Kapitel | vor jedem Eingriff in Import/Analyse |
| [`../REKORDBOX_PIPELINE_IMPLEMENTATION_AUDIT.md`](../REKORDBOX_PIPELINE_IMPLEMENTATION_AUDIT.md) | Umsetzungsnachweis je Pipeline-Stufe inkl. Vorkommen-Audit (`analyzeAudioBuffer(`, `PQTZ`, `PWV2..PWV7`, …) | nach jeder Pipeline-Änderung fortschreiben |
| [`../VORHABEN.md`](../VORHABEN.md) | Planungsstand, offene Vorhaben, dokumentierte Abweichungen | bei Scope-Fragen |
| [`../BUILD_WINDOWS.md`](../BUILD_WINDOWS.md) | Windows-Paket bauen (lokal + GitHub Actions), SQLCipher-Modul, Artefakte | vor jedem Release |
| `PROJEKTANALYSE_2026-09-12.md` | Analyse: Refactoring, Performance, Ausgabequalität, Funktionsumfang — priorisiert, mit Belegen | bei der nächsten Planungsrunde |
| `sessions/` | Session-Protokolle (Auftrag, Umsetzung, Erfüllungsgrad, Nacharbeiten) | Übergabe von Session zu Session |

## Testdoku

* `npm test` → `node tests/run-all.mjs`: entdeckt alle Skript-Suiten (`tests/*.test.ts|mjs`, tsx) und lässt zusätzlich vitest (`tests/ui`, `tests/workflow`, `tests/unit`) laufen.
* `npm run test:script` / `npm run test:ui` → jeweils nur eine Messebene (braucht `npm run coverage` für die getrennte V8-Messung).
* `npm run coverage` → beide Ebenen getrennt messen und pro Datei zusammenführen (`coverage/coverage-merged.json`); gemischte Läufe sind ungeeignet, weil tsx und esbuild dieselbe Datei unterschiedlich transformieren.
* `tests/test-registry.test.ts` → Guard: keine Suite ohne Runner, kein Verzeichniseintrag ohne Suite, package.json-Delegation an den Runner.
* Details: [`sessions/2026-09-12-testabdeckung.md`](sessions/2026-09-12-testabdeckung.md).
