#!/usr/bin/env bash
# Where this machine can be reached from, split by how useful each answer is.
#
# Sourced by scripts/dev.sh and scripts/make_dev_cert.sh. Nothing here sends a
# packet or contacts a service.

# Interfaces that exist for containers and virtual machines. Their addresses are
# real and appear in `hostname -I`, but nothing outside this host can reach them,
# so printing them to someone trying to open a page on a phone is worse than
# printing nothing: they look like plausible answers and they never work.
_is_virtual_interface() {
  case "$1" in
    docker*|br-*|veth*|virbr*|vmnet*|lxcbr*|cni*|flannel*) return 0 ;;
    *) return 1 ;;
  esac
}

# Addresses on this machine's real network interfaces, one per line.
lan_addresses() {
  ip -4 -o addr show scope global 2>/dev/null | while read -r _ iface _ cidr _; do
    _is_virtual_interface "${iface}" && continue
    [[ "${iface}" == tailscale* ]] && continue
    echo "${cidr%%/*}"
  done | sort -u
}

# The tailnet address, if Tailscale is up. Reachable from any device signed into
# the same tailnet, including over mobile data, without opening a single port.
tailscale_ip() {
  command -v tailscale >/dev/null 2>&1 || return 0
  tailscale ip -4 2>/dev/null | head -1
}

# The MagicDNS name, without the trailing dot. This is what a genuine
# certificate from `tailscale cert` is issued for.
tailscale_name() {
  command -v tailscale >/dev/null 2>&1 || return 0
  tailscale status --json 2>/dev/null | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if data.get("BackendState") != "Running":
    sys.exit(0)
name = (data.get("Self") or {}).get("DNSName") or ""
print(name.rstrip("."))
' 2>/dev/null
}

# If `tailscale serve` is already proxying the frontend port, the tailnet URL it
# publishes is the best address there is: a genuine certificate on port 443, no
# warning on the phone, and no certificate of our own to issue.
#
# Prints "<url>|<target-scheme>" for the given local port, or nothing. The
# target scheme matters: serve proxying to http:// while the dev server speaks
# https (or the reverse) answers 502, and the mismatch is invisible from either
# side on its own.
tailscale_serve_for_port() {
  local port="$1"
  command -v tailscale >/dev/null 2>&1 || return 0
  tailscale serve status --json 2>/dev/null | python3 -c '
import json, sys
port = sys.argv[1]
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for host, entry in (data.get("Web") or {}).items():
    for path, handler in (entry.get("Handlers") or {}).items():
        proxy = handler.get("Proxy") or ""
        if not proxy.endswith(":" + port):
            continue
        scheme = proxy.split("://", 1)[0]
        hostname, _, hostport = host.rpartition(":")
        base = f"https://{hostname}" + ("" if hostport == "443" else f":{hostport}")
        print(f"{base.rstrip('"'"'/'"'"')}{path.rstrip('"'"'/'"'"')}|{scheme}")
        sys.exit(0)
' "${port}" 2>/dev/null
}

# Whether anything at all is listening on a port. Deliberately separate from
# naming the holder: a port held by another user shows up here but its process
# is invisible without privileges, and treating "cannot see the owner" as "port
# is free" would hand back the same unhelpful bind error this exists to replace.
port_in_use() {
  local port="$1"
  [[ -n "$(ss -lntH "sport = :${port}" 2>/dev/null)" ]]
}

# Who is listening, as "pid command" lines. May be empty even when the port is
# in use, if the process belongs to someone else.
port_holder() {
  local port="$1" pid cmd
  ss -lptnH "sport = :${port}" 2>/dev/null |
    grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u | while read -r pid; do
      [[ -z "${pid}" ]] && continue
      cmd="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null | cut -c1-70)"
      echo "${pid} ${cmd:-(command not visible)}"
    done
}

# Stop with an explanation if the port is taken. Nothing is started before this.
#
# A port already in use is the most common way starting this goes wrong, and the
# useful thing to say is which process holds it -- almost always an older copy
# of this same app. Naming it turns a puzzle into one command.
require_free_port() {
  local port="$1" what="$2" holder
  port_in_use "${port}" || return 0

  holder="$(port_holder "${port}")"
  echo "Port ${port} is already in use, so the ${what} cannot start." >&2
  echo >&2
  if [[ -n "${holder}" ]]; then
    while read -r line; do
      [[ -n "${line}" ]] && echo "    ${line}" >&2
    done <<< "${holder}"
    echo >&2
    echo "  If that is an older copy of this app, stop it with:" >&2
    echo "      kill $(echo "${holder}" | awk '{print $1}' | tr '\n' ' ')" >&2
  else
    echo "    The process belongs to another user, so it cannot be named here." >&2
    echo "    Try: sudo ss -lptn 'sport = :${port}'" >&2
  fi
  echo "  Or choose other ports:" >&2
  echo "      BACKEND_PORT=8001 FRONTEND_PORT=5174 scripts/dev.sh" >&2
  return 1
}
