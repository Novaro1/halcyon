#!/usr/bin/env bash
# Halcyon domain / BYOD helper — safely add, remove, or list allowlisted mirror
# domains. Run this on the VPS. It edits domains.txt, which Caddy re-reads live
# (~10s) to decide which hosts it will issue an on-demand TLS cert for.
#
#   ./add-domain.sh add <domain>      # verify it points here, then allowlist it
#   ./add-domain.sh remove <domain>   # stop serving it
#   ./add-domain.sh list              # show current allowlist
#
# `add` REFUSES a domain that doesn't already resolve to THIS server — that's the
# abuse guard: people can only add domains they actually control and have pointed
# at us (nobody can allowlist someone else's domain to mint a cert for it).
set -euo pipefail

DOMAINS_FILE="${HALCYON_DOMAINS_FILE:-$HOME/halcyon/domains.txt}"

server_ip() {
  curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null \
    || curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || true
}

resolve_ips() {
  local d="$1"
  if command -v dig >/dev/null 2>&1; then
    dig +short A "$d" | grep -E '^[0-9.]+$' || true
  else
    getent ahostsv4 "$d" 2>/dev/null | awk '{print $1}' | sort -u || true
  fi
}

normalize() {
  echo "$1" | tr 'A-Z' 'a-z' | sed -E 's#^https?://##; s#/.*$##; s#:[0-9]+$##; s#\.$##; s/[[:space:]]//g'
}

cmd="${1:-}"; arg="${2:-}"

case "$cmd" in
  list)
    echo "Allowlisted domains ($DOMAINS_FILE):"
    grep -vE '^[[:space:]]*(#|$)' "$DOMAINS_FILE" 2>/dev/null | sed 's/^/  /' || echo "  (none)"
    ;;

  remove)
    d="$(normalize "$arg")"
    [ -n "$d" ] || { echo "usage: $0 remove <domain>"; exit 1; }
    if grep -qxF "$d" "$DOMAINS_FILE"; then
      grep -vxF "$d" "$DOMAINS_FILE" > "$DOMAINS_FILE.tmp" && mv "$DOMAINS_FILE.tmp" "$DOMAINS_FILE"
      echo "✓ Removed $d — Caddy stops serving it within ~10s."
    else
      echo "· $d is not in the allowlist."
    fi
    ;;

  add)
    d="$(normalize "$arg")"
    [ -n "$d" ] || { echo "usage: $0 add <domain>"; exit 1; }
    echo "$d" | grep -qE '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' \
      || { echo "✗ '$d' doesn't look like a valid domain."; exit 1; }

    ip="$(server_ip)"
    echo "This server's public IP: ${ip:-<could not detect>}"
    echo "Resolving $d …"
    ips="$(resolve_ips "$d")"
    if [ -z "$ips" ]; then
      echo "✗ $d doesn't resolve yet. Ask them to add the DNS record and wait for propagation, then retry."
      exit 1
    fi
    echo "$d currently resolves to:"; echo "$ips" | sed 's/^/   /'
    if [ -n "$ip" ] && ! grep -qxF "$ip" <<<"$ips"; then
      echo "⚠️  $d does NOT point at this server ($ip)."
      echo "    Don't add it until they point the A/CNAME record here — otherwise it won't work anyway."
      exit 1
    fi
    if grep -qxF "$d" "$DOMAINS_FILE"; then
      echo "✓ $d is already allowlisted — nothing to do."
      exit 0
    fi
    echo "$d" >> "$DOMAINS_FILE"
    echo "✓ Added $d. Caddy issues its cert on the first HTTPS hit (~10s allowlist reload)."
    echo "  Test:  curl -sI https://$d | head -1     (expect: HTTP/2 401 — the gate)"
    ;;

  *)
    echo "Halcyon domain allowlist helper"
    echo "usage: $0 add <domain> | remove <domain> | list"
    exit 1
    ;;
esac
