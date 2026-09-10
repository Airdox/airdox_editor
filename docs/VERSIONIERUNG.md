# Versions-Schema – airdox_SMART_Editor (einheitlich)

Stand: 2026-09-10

## Die Regel

**Jede neue Version erhält eine neue Versionsnummer.** Es gibt genau eine
Quelle der Wahrheit für die Version — alles andere leitet sich ab:

| Was | Woher |
| --- | --- |
| Versionsnummer | `version` in `package.json` (**einzige Stelle zum Ändern**) |
| UI (Titelleiste, Track-Header, Info-Modal) | Vite injiziert `__APP_VERSION__` beim Build aus `package.json` (`vite.config.ts` → `src/utils/appVersion.ts`) |
| Exe-Namen (`airdox_SMART_Editor-…-setup.exe` / `-portable.exe`) | electron-builder `${version}` |
| Gatebericht (`release/gate-report.json`) | `appVersion` aus `package.json` |
| GitHub-Release-Name | Tag-Name `vX.Y.Z` |
| Tag | `v` + Versionsnummer |

## Format

Striktes Semver: **`MAJOR.MINOR.PATCH`** (z. B. `0.5.0`), keine Suffixe,
keine Präfixe. Tag = `v` + Version (z. B. `v0.5.0`).

## Wann wird welche Stelle erhöht?

| Änderung | Bump | Beispiel |
| --- | --- | --- |
| Bugfix, kleine Anpassung, Docs | **PATCH** +1 | `0.5.0 → 0.5.1` |
| Neue Funktion / neues Feature (z. B. Mix Lab, Originalschutz-Agent) | **MINOR** +1 (PATCH wird 0) | `0.4.20 → 0.5.0` |
| Grundlegende Änderung / inkompatibler Bruch | **MAJOR** +1 (Minor/Patch werden 0) | `0.5.0 → 1.0.0` |

## Release-Prozess (so einfach wie möglich)

```bash
# 1) Version erhöhen — Script macht Commit + Tag in einem Schritt:
npm run release:patch     # oder release:minor / release:major
#    (Optionen: --message "Kurzbeschreibung", --no-tag)

# 2) Hochladen — der Tag triggert den Windows-Build + das GitHub-Release:
git push origin <branch>
git push origin vX.Y.Z
```

Das Release-Script (`scripts/release.mjs`) erzwingt dabei die Regeln
automatisch:

- genau **eine** Versionsänderung pro Release-Commit,
- striktes Semver-Format,
- **Versionen werden nie wiederverwendet** (existierendes Tag → Abbruch),
- Commit `chore(release): vX.Y.Z` + Tag in einem Schritt.

## Verboten (und durch Gates abgesichert)

- Manuelle Versions-Änderungen in anderen Dateien (UI, Docs, Exe-Namen) —
  sie leiten sich alle aus `package.json` ab.
- Versionsnummern ohne Tag veröffentlichen (Drift wie bei v0.4.15–v0.4.19 —
  passiert 2026-09, deshalb diese Regel).
- Zwei Bumps in einem Release-Commit.
- Wiederverwenden einer freigegebenen Nummer.

## Schutzmechanismen

- **`npm run check:version`** (= `node tests/version-schema.test.mjs`,
  Cases V1–V5): validiert Format, Vite-Injection, Pass-Through-Modul,
  veraltete Versionsnummern in README/BUILD_WINDOWS.md und `${version}`
  in den Artefakt-Namen. Läuft in der Testkette (`npm test`) und als Gate
  „Version schema consistency (single source of truth)“ im Gatekeeper
  (`npm run verify:waveform`) — also in jedem CI-Run.
- **CI** (`.github/workflows/windows-build.yml`): baut bei Tag `v*` die
  Windows-Pakete und erzeugt das GitHub-Release „airdox_SMART_Editor
  vX.Y.Z“ mit den `.exe`-Dateien.

## Historie der Vereinheitlichung

- Bis v0.4.14: Tags vorhanden, aber ab v0.4.15 driftete `package.json`
  weiter, ohne dass Tags/Releases erzeugt wurden (Stand: 0.4.20 ohne
  Tag).
- v0.5.0 (2026-09-10): einheitliches Schema eingeführt — dieses Dokument,
  Release-Script, Consistency-Gates; erste Version, die nach dem Schema
  released wird (Mix Lab + Originalschutz-Agent).
