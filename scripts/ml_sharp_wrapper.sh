#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ML_SHARP_DIR="${ROOT_DIR}/third_party/ml-sharp"
VENV_PY="${ML_SHARP_DIR}/.venv/bin/python"
VENV_SHARP="${ML_SHARP_DIR}/.venv/bin/sharp"

INPUT_PATH=""
OUTPUT_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input)
      INPUT_PATH="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT_PATH="${2:-}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [[ -z "${INPUT_PATH}" || -z "${OUTPUT_PATH}" ]]; then
  echo "Usage: ml_sharp_wrapper.sh --input <image> --output <scene.ply>" >&2
  exit 2
fi

OUTPUT_DIR="${OUTPUT_PATH}.dir"
INPUT_STEM="$(basename "${INPUT_PATH}")"
INPUT_STEM="${INPUT_STEM%.*}"

if [[ -x "${VENV_SHARP}" ]]; then
  "${VENV_SHARP}" predict -i "${INPUT_PATH}" -o "${OUTPUT_DIR}"
elif [[ -x "${VENV_PY}" ]]; then
  "${VENV_PY}" -m sharp.cli predict -i "${INPUT_PATH}" -o "${OUTPUT_DIR}"
elif command -v sharp >/dev/null 2>&1; then
  sharp predict -i "${INPUT_PATH}" -o "${OUTPUT_DIR}"
elif command -v python3 >/dev/null 2>&1; then
  python3 -m sharp.cli predict -i "${INPUT_PATH}" -o "${OUTPUT_DIR}"
else
  python -m sharp.cli predict -i "${INPUT_PATH}" -o "${OUTPUT_DIR}"
fi

EXPECTED_PLY="${OUTPUT_DIR}/${INPUT_STEM}.ply"
if [[ -f "${EXPECTED_PLY}" ]]; then
  mv "${EXPECTED_PLY}" "${OUTPUT_PATH}"
else
  mapfile -t PLY_FILES < <(find "${OUTPUT_DIR}" -maxdepth 1 -type f -name "*.ply" | sort)
  if [[ ${#PLY_FILES[@]} -eq 1 ]]; then
    mv "${PLY_FILES[0]}" "${OUTPUT_PATH}"
  else
    echo "Expected PLY not found in ${OUTPUT_DIR}" >&2
    exit 3
  fi
fi
