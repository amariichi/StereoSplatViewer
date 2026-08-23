#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
SPLAT_MERGE_CLI="${SPLAT_MERGE_CLI:-}"
# shellcheck source=lib_net.sh
source "${ROOT_DIR}/scripts/lib_net.sh"
USE_HTTPS=0
USE_TAILSCALE=0

for arg in "$@"; do
  case "${arg}" in
    --https) USE_HTTPS=1 ;;
    --tailscale) USE_TAILSCALE=1; USE_HTTPS=1 ;;
    -h|--help)
      cat <<'USAGE'
Usage: scripts/dev.sh [--https | --tailscale]

  (no option)  Plain http, this machine only. Enough for the editor; the
               mobile viewer will load but cannot use the camera, because
               browsers grant it only on a secure origin.

  --https      Serve over HTTPS with a self-signed certificate naming every
               address this machine answers to, including its tailnet address
               if Tailscale is running. The phone warns about the certificate
               once; continue past it. Nothing leaves this machine.

  --tailscale  Serve over HTTPS with a genuine certificate for this machine's
               tailnet name, obtained with `tailscale cert`. No warning on the
               phone, and it works from anywhere signed into your tailnet,
               including over mobile data, without opening a port.

               The cost: certificates are publicly logged, so the name of this
               machine (my-laptop.tail1234.ts.net) is written into Certificate
               Transparency logs permanently. Nothing else about it is. Prefer
               --https if you would rather publish nothing.
USAGE
      exit 0
      ;;
  esac
done

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

# A 360 upload produces six cube faces that are useless until they are merged
# into one scene, and the merge needs this tool. Say so at startup rather than
# letting a ten-minute job end with nothing to look at.
if [[ -z "${SPLAT_MERGE_CLI}" ]]; then
  echo "Warning: splat-transform not found. 360 (*.360.jpg) uploads will produce six" >&2
  echo "         separate face PLYs that cannot be previewed. Install it with:" >&2
  echo "           npm install -g @playcanvas/splat-transform" >&2
  echo "         Ordinary single-image uploads are unaffected." >&2
fi

# Check both ports before starting either server. Without this the backend
# printed "Address already in use" and died while the script carried on and
# printed a banner as though everything had worked.
require_free_port "${BACKEND_PORT}" "backend" || exit 1
require_free_port "${FRONTEND_PORT}" "editor and viewer" || exit 1

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

SCHEME=http
TLS_CERT=""
TLS_KEY=""
if [[ "${USE_TAILSCALE}" == "1" ]]; then
  IFS='|' read -r TLS_CERT TLS_KEY < <("${ROOT_DIR}/scripts/tailscale_cert.sh")
  SCHEME=https
elif [[ "${USE_HTTPS}" == "1" ]]; then
  IFS='|' read -r TLS_CERT TLS_KEY < <("${ROOT_DIR}/scripts/make_dev_cert.sh")
  SCHEME=https
fi

(
  cd "${ROOT_DIR}/frontend"
  SSV_BACKEND_ORIGIN="http://127.0.0.1:${BACKEND_PORT}" \
  SSV_TAILNET_HOST="$(tailscale_name)" \
  SSV_TLS_CERT="${TLS_CERT}" SSV_TLS_KEY="${TLS_KEY}" \
    npm run dev -- --port "${FRONTEND_PORT}" --strictPort
) &
FRONTEND_PID=$!

ts_name="$(tailscale_name)"
ts_ip="$(tailscale_ip)"
IFS='|' read -r serve_url serve_scheme < <(tailscale_serve_for_port "${FRONTEND_PORT}")

echo
echo "  Backend   http://localhost:${BACKEND_PORT}"
echo "  Editor    ${SCHEME}://localhost:${FRONTEND_PORT}"
echo

# An existing `tailscale serve` mapping beats anything this script can set up:
# it terminates TLS with a genuine certificate on 443, so the phone sees no
# warning at all. Say so, and say it first.
if [[ -n "${serve_url}" ]]; then
  if [[ "${serve_scheme}" == "${SCHEME}" ]]; then
    echo "  Tailscale is already serving this port. On a phone, open:"
    echo
    echo "      ${serve_url}/viewer.html"
    echo
    echo "  Genuine certificate, no warning, works over mobile data."
    echo
  else
    echo "  WARNING  tailscale serve is proxying this port to ${serve_scheme}://,"
    echo "           but the dev server is speaking ${SCHEME}://. That mismatch"
    echo "           answers 502, so ${serve_url} will not work."
    echo
    if [[ "${SCHEME}" == "https" ]]; then
      echo "           Either drop --https and let Tailscale do the TLS:"
      echo "               scripts/dev.sh"
      echo "           or point serve at the https port:"
      echo "               tailscale serve --bg --https 443 https+insecure://127.0.0.1:${FRONTEND_PORT}"
    else
      echo "           Point serve at this port again:"
      echo "               tailscale serve --bg --https 443 http://127.0.0.1:${FRONTEND_PORT}"
    fi
    echo
  fi
fi

if [[ "${USE_HTTPS}" != "1" ]]; then
  echo "  Viewer    http://localhost:${FRONTEND_PORT}/viewer.html"
  if [[ -z "${serve_url}" || "${serve_scheme}" != "${SCHEME}" ]]; then
    echo
    echo "  Head tracking needs the camera, and the camera needs HTTPS on any"
    echo "  address but this one. To open the viewer on a phone, restart with:"
    echo "      scripts/dev.sh --https        self-signed, warns once, stays local"
    if [[ -n "${ts_name}" ]]; then
      echo "      scripts/dev.sh --tailscale    genuine certificate, no warning"
    fi
  fi
else
  echo "  Open the viewer on a phone or tablet at:"
  echo
  if [[ "${USE_TAILSCALE}" == "1" ]]; then
    echo "      https://${ts_name}:${FRONTEND_PORT}/viewer.html"
    echo
    echo "  Works from anywhere signed into your tailnet, mobile data included."
  else
    # Tailscale first: it is the address that works from outside this network,
    # and unlike a LAN address it does not change when the machine moves.
    if [[ -n "${ts_name}" ]]; then
      echo "      https://${ts_name}:${FRONTEND_PORT}/viewer.html   (tailnet)"
      [[ -n "${ts_ip}" ]] && echo "      https://${ts_ip}:${FRONTEND_PORT}/viewer.html"
      echo
    fi
    while read -r ip; do
      [[ -n "${ip}" ]] && echo "      https://${ip}:${FRONTEND_PORT}/viewer.html   (this network)"
    done < <(lan_addresses)
    echo
    echo "  The certificate is self-signed, so the phone warns about it once."
    echo "  Continue past the warning; it is this machine vouching for itself."
    if [[ -n "${ts_name}" ]]; then
      echo "  To lose the warning entirely: scripts/dev.sh --tailscale"
    fi
  fi
fi
echo
echo "  Ctrl+C stops both."
echo

wait "${BACKEND_PID}" "${FRONTEND_PID}"
