# Archivierte Einmal-Reparaturen — nicht Teil des Builds

Diese Dateien stammen aus historischen, manuellen Reparaturversuchen. Sie sind
**keine unterstützten Entwickler- oder Produktivwerkzeuge**. Kein npm-Script und
kein CI-Workflow ruft sie auf. Sie wurden ausschließlich verschoben, nicht
ausgeführt oder inhaltlich geändert; sie bleiben als Audit-/Historienmaterial
erhalten.

## Sicherheitswarnung

Mehrere Skripte führen bei manuellem Start irreversible oder externe Git-Aktionen
aus. Insbesondere enthalten `full_auto_fix.mjs` und
`src-full-auto-fix.mjs` `git fetch origin main`, `git reset --hard origin/main`,
`git commit` und `git push origin main`. Weitere Skripte committen/pushen direkt
auf `main` oder checken dort Dateien aus. **Nicht ausführen**, insbesondere nicht
in einem Arbeitsverzeichnis mit wertvollen Änderungen oder GitHub-Zugang.

## Inhalt / Disposition

- `full_auto_fix.mjs`, `src-full-auto-fix.mjs`, `clean_fix.cjs`,
  `fix_and_force_push.cjs`, `fix_context_syntax.cjs`, `fix-typo.cjs`,
  `final_fix.ps1`, `master-fix-and-push.cjs`, `patch_masterDbGate.ps1`: alte
  Reparatur-/Commit-/Push-Abläufe; `fix_and_force_push.cjs` enthält zusätzlich
  Checkouts älterer bzw. `main`-Versionen vor dem Commit/Push.
- `fix.cjs`: historisches Build-/ASAR-Reparaturskript. Ein Regressionstest prüft
  weiterhin, dass seine archivierte Fassung die erforderlichen ASAR-Muster
  nicht durch eine fest verdrahtete Liste ersetzt.
- `setup-installer-pipeline.cjs`: altes Skript, das Build-Pipeline-Schritte
  vorbereitet und zu anschließendem Commit/Push auffordert.
- `collect_for_claude.ps1`, `diagnose_and_fix.ps1`, `fix_sqlcipher.ps1`:
  manuelle Diagnose-/Hilfsskripte; nicht Bestandteil des aktuellen Setups.
- `fix-package.txt`: zugehörige historische Notiz.

Vor einer Wiederverwendung müssen Zweck, Befehle, Zielbranch und Pfade einzeln
geprüft sowie alle automatischen Git-Schreib-/Netzwerkaktionen entfernt werden.
Ein künftiges, gepflegtes Werkzeug gehört mit Tests und sicherem Dry-Run in
`scripts/` — nicht zurück in den Build-/Produktionspfad.
