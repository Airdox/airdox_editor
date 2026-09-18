#!/usr/bin/env bash
# =============================================================================
# Change-Risk-Pfad: offizieller CodeCharta gitlogparser + merge
#
# Erzeugt code_analysis_out/airdox_risk.cc.json (Struktur- + Git-Metriken in
# einer Datei). Voraussetzungen: Node >= 20, Java >= 11, npm-Paket
# codecharta-analysis (ccsh).
#
#   npm i -g codecharta-analysis
#   bash tools/code_analysis/run_gitlog_analysis.sh
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."            # Repo-Root
OUT=code_analysis_out
mkdir -p "$OUT"

command -v ccsh >/dev/null 2>&1 || {
  echo "❌ ccsh nicht gefunden. Installation:  npm i -g codecharta-analysis"
  echo "   (benötigt Node >= 20 und Java >= 11 – https://codecharta.com/docs/analysis/codecharta-shell)"
  exit 1
}
command -v java >/dev/null 2>&1 || {
  echo "❌ java nicht gefunden. Bitte Java >= 11 installieren (z. B. Temurin 17)."
  exit 1
}

echo "== 1/3 Git-Metriken parsen (ccsh gitlogparser repo-scan) =="
# -nc = unkomprimiert schreiben (lesbar); erzeugt u. a. numberOfAuthors,
# commitsCount, ageInDays und Datei-Kopplungen aus der Git-Historie.
ccsh gitlogparser repo-scan --repo-path . -o "$OUT/gitmetrics.cc.json" -nc

echo "== 2/3 Struktur- und Git-Map zusammenführen (ccsh merge) =="
[ -f "$OUT/airdox.cc.json" ] || python3 tools/code_analysis/analyze_repo.py
ccsh merge "$OUT/airdox.cc.json" "$OUT/gitmetrics.cc.json" -o "$OUT/airdox_risk.cc.json"

echo "== 3/3 Fertig ✅"
echo "→ $OUT/airdox_risk.cc.json in https://codecharta.com/visualization/ öffnen"
echo "  Empfehlung: Höhe = rloc · Fläche = functions · Farbe = numberOfAuthors"
echo "  (oder commitsCount) → rote Hochburgen = Change-Risk-Hotspots."
echo
echo "Hinweis: Ohne Java liefert analyze_repo.py dieselben Risiko-Metriken"
echo "(commitsCount/authorCount/ageInDays) bereits eingebaut – dann genügt die"
echo "basis-Datei $OUT/airdox.cc.json für die Risk-Färbung."
