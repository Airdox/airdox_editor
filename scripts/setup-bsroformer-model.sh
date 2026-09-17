#!/usr/bin/env bash
#
# Laedt den trainierten BS-RoFormer-Checkpoint (4 Stems, MUSDB18HQ) herunter.
#
# WICHTIG: Dieses Skript laedt NUR herunter. Es bundelt keine Gewichte und
# committet nichts ins Repository. Die Gewichte sind Eigentum ihrer Autoren,
# siehe LIZENZ-Hinweis am Ende der Ausgabe.
#
# In der Arena-/CI-Sandbox schlaegt der Download fehl: die Hosts
# release-assets.githubusercontent.com und huggingface.co sind dort nicht
# erreichbar. Das Skript ist fuer die lokale Entwicklermaschine gedacht.
#
# Aufruf:
#   bash scripts/setup-bsroformer-model.sh [zielverzeichnis]
#
# Umgebungsvariablen:
#   STEM_MODEL_DIR     Zielverzeichnis (Default: ./models/bsroformer)
#   STEM_MODEL_SHA256  Erwarteter sha256 des Checkpoints. Wenn gesetzt, wird
#                      hart dagegen geprueft und bei Abweichung abgebrochen.
#
set -euo pipefail

RELEASE="https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/download/v1.0.12"
CKPT_NAME="model_bs_roformer_ep_17_sdr_9.6568.ckpt"
CONFIG_NAME="config_bs_roformer_384_8_2_485100.yaml"

TARGET_DIR="${1:-${STEM_MODEL_DIR:-models/bsroformer}}"
CKPT_PATH="${TARGET_DIR}/${CKPT_NAME}"
CONFIG_PATH="${TARGET_DIR}/${CONFIG_NAME}"

mkdir -p "${TARGET_DIR}"

fetch() {
  local url="$1" out="$2" name
  name="$(basename "${out}")"
  if [ -s "${out}" ]; then
    echo "  vorhanden, wird uebersprungen: ${name}"
    return 0
  fi
  echo "  lade ${name} ..."
  # --fail: HTTP-Fehler sind Fehler, nicht stillschweigend eine HTML-Seite.
  # Erst in eine .part-Datei, damit ein Abbruch keine halbe Datei hinterlaesst.
  if ! curl --fail --location --progress-bar --retry 3 --retry-delay 2 \
            --connect-timeout 20 -o "${out}.part" "${url}"; then
    rm -f "${out}.part"
    echo ""
    echo "FEHLER: Download von ${name} fehlgeschlagen." >&2
    echo "Haeufigste Ursache: Netzwerk blockt release-assets.githubusercontent.com." >&2
    echo "Pruefen mit:  curl -sIL '${url}' | head -1" >&2
    return 1
  fi
  mv "${out}.part" "${out}"
}

echo "Zielverzeichnis: ${TARGET_DIR}"
fetch "${RELEASE}/${CONFIG_NAME}" "${CONFIG_PATH}"
fetch "${RELEASE}/${CKPT_NAME}" "${CKPT_PATH}"

# Integritaet. Ohne erwarteten Hash wird der berechnete nur ausgegeben
# (trust on first use) - eine Behauptung "verifiziert" waere hier gelogen.
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "${CKPT_PATH}" | cut -d' ' -f1)"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "${CKPT_PATH}" | cut -d' ' -f1)"
else
  ACTUAL=""
  echo "WARNUNG: weder sha256sum noch shasum gefunden, keine Pruefsumme berechnet." >&2
fi

if [ -n "${STEM_MODEL_SHA256:-}" ] && [ -n "${ACTUAL}" ]; then
  if [ "${ACTUAL}" != "${STEM_MODEL_SHA256}" ]; then
    echo "FEHLER: sha256 stimmt nicht ueberein." >&2
    echo "  erwartet: ${STEM_MODEL_SHA256}" >&2
    echo "  erhalten: ${ACTUAL}" >&2
    echo "Datei wird geloescht, um einen korrupten Checkpoint zu vermeiden." >&2
    rm -f "${CKPT_PATH}"
    exit 1
  fi
  echo "sha256 verifiziert: ${ACTUAL}"
elif [ -n "${ACTUAL}" ]; then
  echo "sha256 (unverifiziert, bitte einmalig gegen die Quelle pruefen und"
  echo "danach als STEM_MODEL_SHA256 pinnen):"
  echo "  ${ACTUAL}"
fi

cat <<EOF

Fertig.
  Checkpoint: ${CKPT_PATH}
  Config:     ${CONFIG_PATH}

Naechster Schritt: Das Verzeichnis als modelStoreDir an die Engine geben und
den Live-Gate-Lauf starten. Ohne angebundenen Inferenz-Adapter bleibt die
Release-Entscheidung weiterhin TECHNICAL_PASS_QUALITY_FAIL.

LIZENZ / HERKUNFT
  Architektur: lucidrains/BS-RoFormer (MIT)
  Training/Release: ZFTurbo/Music-Source-Separation-Training (Code MIT)
  Gewichte: (c) ZFTurbo, trainiert auf MUSDB18-HQ.
  Fuer die GEWICHTE selbst hat ZFTurbo keine ausdrueckliche Lizenz publiziert.
  Die MIT-Lizenz des Repos deckt den Code, nicht zwingend die Checkpoints.
  MUSDB18-HQ ist ein forschungsorientierter Datensatz.
  => Fuer reine Entwicklung/Evaluierung unproblematisch. Vor einer
     kommerziellen Auslieferung ist eine schriftliche Klaerung mit dem Autor
     noetig. Gewichte NICHT ins Repo committen.
EOF
