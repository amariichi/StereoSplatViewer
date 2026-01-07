#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
SPLAT_MERGE_CLI="${SPLAT_MERGE_CLI:-}"

if [[ ! -d "${ROOT_DIR}/.venv" ]]; then
  echo "Backend venv not found at ${ROOT_DIR}/.venv. Run scripts/setup_wsl.sh first." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found. Install Node.js/npm before running the dev script." >&2
  exit 1
fi

if [[ -z "${SPLAT_MERGE_CLI}" ]]; then
  if command -v splat-transform >/dev/null 2>&1; then
    SPLAT_MERGE_CLI="$(command -v splat-transform)"
  elif [[ -x "${ROOT_DIR}/.venv/bin/splat-transform" ]]; then
    SPLAT_MERGE_CLI="${ROOT_DIR}/.venv/bin/splat-transform"
  fi
fi

cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]]; then
    kill "${BACKEND_PID}" 2>/dev/null || true
  fi
  if [[ -n "${FRONTEND_PID:-}" ]]; then
    kill "${FRONTEND_PID}" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

(
  cd "${ROOT_DIR}"
  source .venv/bin/activate
  SPLAT_MERGE_CLI="${SPLAT_MERGE_CLI}" \
  ML_SHARP_CLI="${ROOT_DIR}/scripts/ml_sharp_wrapper.sh" \
    uvicorn backend.app.main:app --reload --port "${BACKEND_PORT}"
) &
BACKEND_PID=$!

(
  cd "${ROOT_DIR}/frontend"
  VITE_API_BASE="http://localhost:${BACKEND_PORT}" npm run dev -- --port "${FRONTEND_PORT}"
) &
FRONTEND_PID=$!

echo "Backend:  http://localhost:${BACKEND_PORT}"
echo "Frontend: http://localhost:${FRONTEND_PORT}"
echo "Press Ctrl+C to stop both."

wait "${BACKEND_PID}" "${FRONTEND_PID}"
