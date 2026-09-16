#!/usr/bin/env bash
#
# Deploy Halcyon to multiple Fly.io apps at once — one app per mirror, each on
# its own <app>.fly.dev. Mirrors are disposable: when a school blocks one
# domain, the others (and any custom domains) keep working. The links hub
# (hub/index.html) is what users bookmark; update hub/links.json with the URLs
# this prints.
#
# Usage:
#   HALCYON_PASSWORD='your-shared-passphrase' ./deploy/deploy-all.sh app1 app2 app3
#
# With no args it deploys just the default app (halcyon-proxy). The passphrase
# is set as a Fly secret on every app so none is an open proxy. All the abuse
# guardrails (server.js) apply automatically.
#
# Run from the repo root (needs the local fly.toml + Dockerfile). Fly builds on
# its remote builder, so local Docker doesn't need to be running.

set -euo pipefail
cd "$(dirname "$0")/.."

: "${HALCYON_PASSWORD:?Set HALCYON_PASSWORD to the shared passphrase (never commit it).}"

apps=("$@")
if [ ${#apps[@]} -eq 0 ]; then
  apps=(halcyon-proxy)
fi

echo "Deploying ${#apps[@]} mirror(s): ${apps[*]}"
echo

for app in "${apps[@]}"; do
  echo "=== $app ==="
  # Create the app if it doesn't exist yet (ignore "already exists").
  flyctl apps create "$app" 2>/dev/null || echo "  (app already exists)"
  # Set the shared passphrase secret (staged; applied on deploy).
  flyctl secrets set HALCYON_PASSWORD="$HALCYON_PASSWORD" -a "$app" >/dev/null
  # Deploy this repo to the app (overrides fly.toml's app name via --app).
  flyctl deploy --app "$app"
  echo "  → https://$app.fly.dev"
  echo
done

echo "Done. Put the working URLs into hub/links.json and redeploy the hub."
echo "For domain diversity beyond *.fly.dev, add custom / FreeDNS domains with:"
echo "  flyctl certs add yourdomain.example -a <app>"
