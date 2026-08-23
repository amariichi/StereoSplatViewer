#!/usr/bin/env bash
# A certificate for the development server, so a phone can use its camera.
#
# Browsers only grant the camera on a secure origin, and a plain http:// address
# on a local network is not one. This issues a self-signed certificate naming
# every address this machine can be reached by. The phone warns about it once.
#
# If you use Tailscale, prefer `tailscale cert`: it produces a genuine
# certificate, so there is no warning, and the scene stays inside your tailnet.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib_net.sh
source "${ROOT_DIR}/scripts/lib_net.sh"
CERT_DIR="${ROOT_DIR}/.certs"
CERT="${CERT_DIR}/dev.crt"
KEY="${CERT_DIR}/dev.key"
# Safari rejects a server certificate valid for more than 398 days.
DAYS=365

san="DNS:localhost,IP:127.0.0.1"
while read -r ip; do
  [[ -n "${ip}" ]] && san="${san},IP:${ip}"
done < <(lan_addresses)

# The tailnet address and name, so the same certificate also works when the
# phone reaches this machine over Tailscale rather than the local network.
ts_ip="$(tailscale_ip)"
[[ -n "${ts_ip}" ]] && san="${san},IP:${ts_ip}"
ts_name="$(tailscale_name)"
[[ -n "${ts_name}" ]] && san="${san},DNS:${ts_name}"

# A common name alone has not been accepted for years. Without a matching
# subject alternative name the phone refuses outright rather than offering to
# continue, so the certificate is reissued whenever the address set changes.
needs_new=1
if [[ -f "${CERT}" && -f "${KEY}" ]]; then
  present="$(openssl x509 -noout -ext subjectAltName -in "${CERT}" 2>/dev/null | tr -d ' ' || true)"
  needs_new=0
  IFS=',' read -ra wanted <<< "${san}"
  for entry in "${wanted[@]}"; do
    kind="${entry%%:*}"; value="${entry#*:}"
    token="DNS:${value}"
    [[ "${kind}" == "IP" ]] && token="IPAddress:${value}"
    if [[ "${present}" != *"${token}"* ]]; then needs_new=1; break; fi
  done
  # A certificate about to expire would fail on the phone partway through.
  openssl x509 -noout -checkend 86400 -in "${CERT}" >/dev/null 2>&1 || needs_new=1
fi

if [[ "${needs_new}" == "1" ]]; then
  mkdir -p "${CERT_DIR}"
  openssl req -x509 -newkey rsa:2048 -nodes -days "${DAYS}" \
    -keyout "${KEY}" -out "${CERT}" \
    -subj "/CN=StereoSplatViewer development" \
    -addext "subjectAltName=${san}" >/dev/null 2>&1
  chmod 600 "${KEY}"
  echo "Issued a self-signed certificate for ${san}" >&2
fi

echo "${CERT}|${KEY}"
