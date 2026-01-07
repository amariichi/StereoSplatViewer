#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
SESSION_NAME="stereosplatviewer"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found. Install it or use scripts/dev.sh instead." >&2
  exit 1
fi

if [[ ! -d "${ROOT_DIR}/.venv" ]]; then
  echo "Backend venv not found at ${ROOT_DIR}/.venv. Run scripts/setup_wsl.sh first." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found. Install Node.js/npm before running the dev script." >&2
  exit 1
fi

if tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
  echo "tmux session '${SESSION_NAME}' already exists. Attach with: tmux attach -t ${SESSION_NAME}" >&2
  exit 1
fi

tmux new-session -d -s "${SESSION_NAME}" -c "${ROOT_DIR}" \
  "bash -lc 'source .venv/bin/activate && uvicorn backend.app.main:app --reload --port ${BACKEND_PORT}'"
tmux split-window -h -t "${SESSION_NAME}" -c "${ROOT_DIR}/frontend" \
  "bash -lc 'VITE_API_BASE=http://localhost:${BACKEND_PORT} npm run dev -- --port ${FRONTEND_PORT}'"
tmux select-layout -t "${SESSION_NAME}" even-horizontal

echo "tmux session '${SESSION_NAME}' started."
echo "Attach with: tmux attach -t ${SESSION_NAME}"
echo "Stop with:   tmux kill-session -t ${SESSION_NAME}"
