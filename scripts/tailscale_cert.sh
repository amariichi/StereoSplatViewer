#!/usr/bin/env bash
# A genuine certificate for this machine's tailnet name, via `tailscale cert`.
#
# Unlike the self-signed certificate from make_dev_cert.sh, this one is trusted
# by the phone, so there is no warning to click past and the camera is granted
# without argument. The scene still never leaves your tailnet.
#
# What it costs: the certificate is issued by a public authority, so the name of
# this machine (for example my-laptop.tail1234.ts.net) is written into public
# Certificate Transparency logs, permanently. The name alone is published --
# nothing about the machine, its addresses, or what it serves. If you would
# rather publish nothing, use scripts/dev.sh --https instead and accept the
# warning on the phone.
#
# Prints "<cert>|<key>" on stdout. Certificates are renewed automatically by
# tailscaled well before they expire; re-running this is cheap and idempotent.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib_net.sh
source "${ROOT_DIR}/scripts/lib_net.sh"
CERT_DIR="${ROOT_DIR}/.certs"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "tailscale is not installed. Use scripts/dev.sh --https instead." >&2
  exit 1
fi

name="$(tailscale_name)"
if [[ -z "${name}" ]]; then
  echo "Tailscale is installed but not running, or has no MagicDNS name." >&2
  echo "Start it with 'tailscale up', or use scripts/dev.sh --https instead." >&2
  exit 1
fi

CERT="${CERT_DIR}/${name}.crt"
KEY="${CERT_DIR}/${name}.key"
mkdir -p "${CERT_DIR}"

# Only ask for a new one when what is on disk is missing or close to expiring.
# tailscaled renews in the background, so this is normally a no-op.
if ! openssl x509 -noout -checkend 604800 -in "${CERT}" >/dev/null 2>&1; then
  echo "Requesting a certificate for ${name} ..." >&2
  if ! tailscale cert --cert-file "${CERT}" --key-file "${KEY}" "${name}" >&2; then
    echo >&2
    echo "Could not obtain a certificate. The usual cause is that HTTPS is not" >&2
    echo "enabled for this tailnet: turn it on under DNS in the Tailscale admin" >&2
    echo "console. Falling back is easy -- use scripts/dev.sh --https." >&2
    exit 1
  fi
  chmod 600 "${KEY}"
fi

echo "${CERT}|${KEY}"
