#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
THIRD_PARTY_DIR="${ROOT_DIR}/third_party"
ML_SHARP_DIR="${THIRD_PARTY_DIR}/ml-sharp"
BACKEND_VENV_DIR="${ROOT_DIR}/.venv"

echo "StereoSplatViewer setup (Ubuntu/WSL)."

mkdir -p "${THIRD_PARTY_DIR}"

if [[ ! -d "${ML_SHARP_DIR}/.git" ]]; then
  echo "Cloning ml-sharp into ${ML_SHARP_DIR}..."
  git clone https://github.com/apple/ml-sharp.git "${ML_SHARP_DIR}"
else
  echo "ml-sharp already exists. Skipping clone."
fi

if [[ -d "${ML_SHARP_DIR}" ]]; then
  echo "Setting up ml-sharp venv..."
  if [[ ! -d "${ML_SHARP_DIR}/.venv" ]]; then
    if command -v uv >/dev/null 2>&1; then
      uv venv --python 3.13 "${ML_SHARP_DIR}/.venv"
    else
      python3 -m venv "${ML_SHARP_DIR}/.venv"
    fi
  fi
  (
    cd "${ML_SHARP_DIR}"
    if command -v uv >/dev/null 2>&1; then
      uv pip install -r requirements.txt
    else
      ./.venv/bin/pip install -r requirements.txt
    fi
  )
fi

chmod +x "${ROOT_DIR}/scripts/ml_sharp_wrapper.sh"

echo "Setting up backend venv..."
if [[ ! -d "${BACKEND_VENV_DIR}" ]]; then
  if command -v uv >/dev/null 2>&1; then
    uv venv --python 3.13 "${BACKEND_VENV_DIR}"
  else
    python3 -m venv "${BACKEND_VENV_DIR}"
  fi
fi

if command -v uv >/dev/null 2>&1; then
  uv pip install -e "${ROOT_DIR}/backend"
else
  "${BACKEND_VENV_DIR}/bin/pip" install -e "${ROOT_DIR}/backend"
fi

echo "Installing optional splat-transform merge tool (best effort)..."
if command -v npm >/dev/null 2>&1; then
  npm install -g @playcanvas/splat-transform || \
    echo "Warning: splat-transform install failed. Install manually if needed."
else
  echo "Warning: npm not found; cannot install splat-transform automatically."
fi

echo "Setting up frontend dependencies..."
if command -v npm >/dev/null 2>&1; then
  (
    cd "${ROOT_DIR}/frontend"
    echo "Updating supersplat to latest sbs-spike..."
    npm install "github:amariichi/supersplat#sbs-spike"
    npm install
  )
else
  echo "Warning: npm not found; cannot install frontend dependencies automatically."
fi

echo "Setup complete."
echo "You can start the backend with: uvicorn backend.app.main:app --reload"
