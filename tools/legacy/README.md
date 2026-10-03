# tools/legacy – abgelöste Einmal-Skripte

Diese Dateien stammen aus frühen Reparatur- und Analysephasen. Sie werden von
**keinem** Build-, Test- oder Laufzeitpfad mehr referenziert (geprüft über den
Importgraphen von `src`, `electron`, `scripts`, `tests`, `server.ts` und
`package.json`).

Sie liegen hier, statt gelöscht zu werden, weil sie teilweise dokumentieren,
*wie* ein Problem damals gefunden wurde:

| Datei(en) | Ursprünglicher Zweck | Ersetzt durch |
|---|---|---|
| `fix.cjs`, `fix-typo.cjs`, `fix_context_syntax.cjs`, `clean_fix.cjs`, `fix_and_force_push.cjs`, `master-fix-and-push.cjs`, `full_auto_fix.mjs` | Einmalige Quelltext-Reparaturen per Skript (mit hartkodierten Windows-Pfaden) | normale Commits, PR-Review, Test-Suite |
| `diagnose_and_fix.ps1`, `final_fix.ps1`, `patch_masterDbGate.ps1`, `fix_sqlcipher.ps1`, `collect_for_claude.ps1` | PowerShell-Einmalreparaturen (SQLCipher/Native-Build) | `npm run rekordbox:native:ensure`, `npm run rekordbox:doctor` |
| `setup-installer-pipeline.cjs`, `build_installer_only.py`, `build_pipeline.py`, `setup.iss`, `setup_original.iss`, `build.spec` | alter Python-/Inno-Setup-Installerpfad | `electron-builder` (`npm run package:win:nsis`) |
| `rb_probe.py`, `rb_link.py`, `rb_diagnose.py`, `rekordbox_parser.py`, `waveform_renderer.py`, `main.py`, `patch_app.py` | Prototypen der Rekordbox-/ANLZ-Auswertung | `src/rekordbox/*`, `electron/masterDbGate.cjs`, `electron/dbReader.cjs` |
| `analysisPath.cjs` + `analysisPath.test.cjs` | isolierte ANLZ-Pfadauflösung mit eigenem Test **außerhalb** von `tests/` (der Runner hat ihn nie ausgeführt) | `electron/analysisRegistry.cjs` und `electron/masterDbGate.cjs` (dort getestet über `tests/analysis-path-registry.test.mjs`, `tests/master-db-gate.test.mjs`) |
| `metadata.json`, `fix-package.txt`, `anlz-mismatch-diagnose.patch`, `test_analysis.ts` | Begleitdateien dieser Einmalaktionen | – |

**Bitte hier nichts mehr hinzufügen.** Neue Werkzeuge gehören nach `tools/` oder
`scripts/` und müssen über `npm run …` oder einen Test erreichbar sein.
