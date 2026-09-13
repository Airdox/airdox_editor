#!/usr/bin/env bash
#
# BS-RoFormer Modell-Einrichtung (Entwicklung / Offline-Tests)
#
# Legt die Referenz-Implementierung (ZFTurbo/Music-Source-Separation-Training)
# und – sofern Netzwerk vorhanden – die trainierten Gewichte ab. Zielverzeichnis
# ist ${AIRODOX_STEM_HOME:-$HOME/.cache/airdox-stems}:
#
#   vendor/msst/     Referenz-Architektur (models.bs_roformer.BSRoformer);
#                    alternativ das offizielle PyPI-Paket `msst`
#   configs/         Checkpoint-Configs (stem_order, chunk_size, …)
#   checkpoints/     Gewichte (.ckpt)
#   manifest.json    was liegt hier, welche Größe, welcher sha256
#
# Die URLs stammen ausschließlich aus src/stems/modelCatalog.json – dieses
# Skript erfindet keine Modellquellen. Es fasst niemals Audio-Dateien an.
#
# Aufruf:
#   bash scripts/setup-bsroformer-model.sh                       # HQ-Modell
#   bash scripts/setup-bsroformer-model.sh --models id1,id2      # Auswahl
#   bash scripts/setup-bsroformer-model.sh --skip-download       # nur Quellen
#   bash scripts/setup-bsroformer-model.sh --skip-vendor         # nur Manifest
#   bash scripts/setup-bsroformer-model.sh --home /pfad --force
#
set -euo pipefail
cd "$(dirname "$0")/.."

REPO_ROOT="$(pwd)"
CATALOG="src/stems/modelCatalog.json"
STEM_HOME="${AIRODOX_STEM_HOME:-$HOME/.cache/airdox-stems}"
MODELS="bsroformer-musdb18hq-4stem-zfturbo"
SKIP_DOWNLOAD=0
SKIP_VENDOR=0
FORCE=0
VENDOR_REF="v1.0.12"
# Offizielles Paket der Referenz-Implementierung (ZFTurbo) – nur Architektur,
# keine Gewichte. --no-deps, damit torch/torchaudio nicht angefasst werden.
MSST_VERSION="0.1.0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --models) MODELS="$2"; shift 2 ;;
    --home) STEM_HOME="$2"; shift 2 ;;
    --skip-download) SKIP_DOWNLOAD=1; shift ;;
    --skip-vendor) SKIP_VENDOR=1; shift ;;
    --force) FORCE=1; shift ;;
    --help|-h) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $1" >&2; exit 2 ;;
  esac
done

VENDOR_DIR="$STEM_HOME/vendor/msst"
CONFIG_DIR="$STEM_HOME/configs"
CHECKPOINT_DIR="$STEM_HOME/checkpoints"
MANIFEST="$STEM_HOME/manifest.json"

say()  { printf '%s\n' "$*"; }
fail() { printf 'FEHLER: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || fail "git fehlt."
[[ -f "$CATALOG" ]] || fail "Modell-Katalog $CATALOG nicht gefunden."

say "═══════════════════════════════════════════════════════════════"
say "  BS-RoFormer Einrichtung (Entwicklung / Offline-Tests)"
say "═══════════════════════════════════════════════════════════════"
say "  Ziel:      $STEM_HOME"
say "  Modelle:   $MODELS"
say "  Katalog:   $CATALOG"

mkdir -p "$CONFIG_DIR" "$CHECKPOINT_DIR" "$STEM_HOME/vendor"

PYTHON_BIN="${AIRODOX_STEM_PYTHON:-}"
if [[ -z "$PYTHON_BIN" ]]; then
  for candidate in "$(pwd)/.venv/bin/python" "$HOME/.venv/bin/python" python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then PYTHON_BIN="$candidate"; break; fi
  done
fi
say "  Python:    ${PYTHON_BIN:-keins gefunden}"


# ── 1. Referenz-Architektur ───────────────────────────────────────────────────
# Der Adapter importiert `models.bs_roformer.BSRoformer`. Drei Bezugsquellen,
# in dieser Reihenfolge – keine davon darf einen vorhandenen Stand löschen:
#   a) AIRODOX_MSST_DIR / bereits vorhandenes vendor/msst (Checkout),
#   b) das offizielle Paket `msst` (pip, ZFTurbo selbst) – <site-packages>/msst,
#   c) frischer git clone.
vendor_ok() { [[ -n "${1:-}" && -f "$1/models/bs_roformer/bs_roformer.py" ]]; }

if vendor_ok "${AIRODOX_MSST_DIR:-}"; then
  VENDOR_DIR="${AIRODOX_MSST_DIR:?}"
  say "  ✓ Referenz-Architektur aus AIRODOX_MSST_DIR: $VENDOR_DIR"
elif vendor_ok "$VENDOR_DIR"; then
  say "  ✓ Referenz-Architektur vorhanden: $VENDOR_DIR"
elif [[ $SKIP_VENDOR -eq 1 ]]; then
  say "  --skip-vendor: Referenz-Architektur wird nicht eingerichtet."
else
  installed_root=""
  if [[ -n "$PYTHON_BIN" ]] && "$PYTHON_BIN" -c "import msst, os; print(os.path.dirname(msst.__file__))" >/dev/null 2>&1; then
    installed_root="$("$PYTHON_BIN" -c "import msst, os; print(os.path.dirname(msst.__file__))")"
  elif [[ -n "$PYTHON_BIN" ]]        && "$PYTHON_BIN" -m pip install --quiet --no-deps "msst==$MSST_VERSION" 2>/dev/null        && installed_root="$("$PYTHON_BIN" -c "import msst, os; print(os.path.dirname(msst.__file__))" 2>/dev/null)"; then
    say "  ✓ Referenz-Architektur als Paket msst==$MSST_VERSION installiert (--no-deps, torch bleibt unangetastet)"
  fi

  if [[ -n "$installed_root" && -f "$installed_root/models/bs_roformer/bs_roformer.py" ]]; then
    VENDOR_DIR="$installed_root"
    say "  ✓ Referenz-Architektur: $VENDOR_DIR"
  else
    say "  Hole ZFTurbo/Music-Source-Separation-Training per git clone …"
    clone_target="$STEM_HOME/vendor/.msst-clone.tmp"
    rm -rf "$clone_target"
    if git clone --quiet --depth 1 --branch "$VENDOR_REF" \
         https://github.com/ZFTurbo/Music-Source-Separation-Training.git "$clone_target" 2>/dev/null \
       || git clone --quiet --depth 1 \
         https://github.com/ZFTurbo/Music-Source-Separation-Training.git "$clone_target" 2>/dev/null; then
      rm -rf "$VENDOR_DIR"
      mv "$clone_target" "$VENDOR_DIR"
      say "  ✓ geklont nach $VENDOR_DIR"
    else
      rm -rf "$clone_target"
      fail "Referenz-Architektur nicht verfügbar. Abhilfe (eine davon):
    $PYTHON_BIN -m pip install --no-deps msst==$MSST_VERSION
    git clone https://github.com/ZFTurbo/Music-Source-Separation-Training.git \$AIRODOX_MSST_DIR"
    fi
  fi
fi

if [[ $SKIP_VENDOR -eq 0 || -n "${AIRODOX_MSST_DIR:-}" ]]; then
  vendor_ok "$VENDOR_DIR" || fail "Referenz-Architektur unvollständig: $VENDOR_DIR/models/bs_roformer/bs_roformer.py fehlt."
  say "  ✓ models/bs_roformer/bs_roformer.py vorhanden"
fi

if [[ $SKIP_DOWNLOAD -eq 1 ]]; then
  say ""
  say "  --skip-download: Gewichte werden nicht geladen."
  say "  Separation ist damit nicht möglich; der Adapter läuft nur mit --allow-random-weights,"
  say "  was ausdrücklich KEINE trainierte Separation ist."
  exit 0
fi

# ── 2. Gewichte + Configs aus dem Katalog ─────────────────────────────────────
download() { # url ziel
  local url="$1" target="$2"
  if [[ -s "$target" && $FORCE -eq 0 ]]; then
    say "    vorhanden: $(basename "$target") ($(du -h "$target" | cut -f1))"
    return 0
  fi
  command -v curl >/dev/null 2>&1 || fail "curl fehlt."
  local partial="$target.part"
  say "    lade $(basename "$target") …"
  if ! curl --fail --location --retry 3 --continue-at - --output "$partial" "$url"; then
    rm -f "$partial"
    say "    FEHLER: Download fehlgeschlagen: $url" >&2
    return 1
  fi
  mv "$partial" "$target"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else echo ""; fi
}

FAILED=""
MANIFEST_ENTRIES=""

IFS=',' read -r -a MODEL_LIST <<< "$MODELS"
for model_id in "${MODEL_LIST[@]}"; do
  say ""
  say "  Modell: $model_id"
  entry="$(node -e '
    const catalog = require("./" + process.argv[1]);
    const id = process.argv[2];
    const model = catalog.models.find((m) => m.id === id);
    if (!model) { console.error("unbekanntes Modell: " + id); process.exit(3); }
    const parts = [
      model.id,
      model.family,
      (model.checkpoint && model.checkpoint.url) || "",
      (model.checkpoint && model.checkpoint.file) || "",
      (model.config && model.config.url) || "",
      (model.config && model.config.file) || "",
      model.modelHash || "unverified",
    ];
    process.stdout.write(parts.join("\u0001"));
  ' "$CATALOG" "$model_id")" || fail "Modell $model_id ist nicht im Katalog."

  IFS=$'\001' read -r m_id m_family m_ckpt_url m_ckpt_file m_cfg_url m_cfg_file m_hash <<< "$entry"

  if [[ "$m_family" == "pipeline_double" ]]; then
    say "    Test-Double, keine Gewichte nötig – übersprungen."
    continue
  fi
  [[ -n "$m_ckpt_url" && -n "$m_ckpt_file" ]] || { say "    kein Checkpoint im Katalog – übersprungen."; continue; }

  ok=1
  [[ -n "$m_cfg_url" && -n "$m_cfg_file" ]] && { download "$m_cfg_url" "$CONFIG_DIR/$m_cfg_file" || ok=0; }
  download "$m_ckpt_url" "$CHECKPOINT_DIR/$m_ckpt_file" || ok=0

  if [[ $ok -eq 0 ]]; then
    FAILED="$FAILED $model_id"
    say "    ✗ unvollständig"
    continue
  fi

  actual="$(sha256_of "$CHECKPOINT_DIR/$m_ckpt_file")"
  if [[ "$m_hash" == "unverified" || -z "$m_hash" ]]; then
    say "    ⚠ Modell-Hash im Katalog nicht hinterlegt – berechne sha256: $actual"
    say "      (in $CATALOG eintragen, damit künftige Läufe ihn prüfen)"
  elif [[ "$actual" != "$m_hash" ]]; then
    say "    ✗ sha256 stimmt nicht: erwartet $m_hash, gefunden $actual" >&2
    FAILED="$FAILED $model_id"
    continue
  else
    say "    ✓ sha256 geprüft"
  fi

  size="$(wc -c < "$CHECKPOINT_DIR/$m_ckpt_file" | tr -d ' ')"
  MANIFEST_ENTRIES="$MANIFEST_ENTRIES{\"id\":\"$m_id\",\"family\":\"$m_family\",\"checkpoint\":\"$m_ckpt_file\",\"config\":\"$m_cfg_file\",\"sha256\":\"$actual\",\"bytes\":$size},"
  say "    ✓ installiert"
done

# ── 3. Manifest ───────────────────────────────────────────────────────────────
MANIFEST_ENTRIES="${MANIFEST_ENTRIES%,}"
printf '{"generatedAt":"%s","home":"%s","vendorRef":"%s","models":[%s]}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STEM_HOME" "$VENDOR_REF" "$MANIFEST_ENTRIES" > "$MANIFEST"

say ""
say "  Manifest: $MANIFEST"
say "  Adapter-Aufruf prüft Referenz-Quellen über AIRODOX_MSST_DIR:"
say "    export AIRODOX_MSST_DIR=$VENDOR_DIR"
say "    export AIRODOX_STEM_CHECKPOINT_DIR=$CHECKPOINT_DIR"
say "  Danach: npm run test:stems:live"

if [[ -n "$FAILED" ]]; then
  say ""
  say "  Nicht vollständig:$FAILED"
  say "  Ohne trainierte Gewichte bleibt TEIL 2 (Stem Isolation Gate) offen."
  exit 1
fi
say ""
say "  ✓ Einrichtung abgeschlossen."
