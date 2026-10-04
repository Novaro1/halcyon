#!/usr/bin/env bash
# Build a deployable Halcyon front-link bundle — a static site you can drop on any
# host (Cloudflare Pages, GitHub Pages, …). The front serves the app shell + the
# PoW gate; the gate solves the backend's challenge and points the wisp tunnel at
# the backend with ?t=<token>, so all proxy traffic + auth go to the ONE backend
# origin (kept current by the VPS auto-update), while the link lives anywhere.
#
#   deploy/build-front.sh <backend-origin> [out-dir]
#   e.g. deploy/build-front.sh https://api.studybuddy.website dist/front
#
# Deploy the out-dir, e.g.:  npx wrangler pages deploy dist/front
set -euo pipefail

BACKEND="${1:?usage: build-front.sh <backend-origin> [out-dir] [base-path]   e.g. https://api.studybuddy.website dist/front /mybucket}"
OUT="${2:-dist/front}"
BASE="${3:-}"          # "" for an origin root (appspot/Pages); "/<bucket>" for a sub-path host (GCS)
BACKEND="${BACKEND%/}" # strip trailing slash
BASE="${BASE%/}"       # strip trailing slash
[ -n "$BASE" ] && case "$BASE" in /*) ;; *) BASE="/$BASE" ;; esac # ensure a leading slash
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

rm -rf "$OUT"
mkdir -p "$OUT/scram"

# App shell (static, served same-origin on the front).
cp "$ROOT"/public/app.js "$ROOT"/public/proxy.js "$ROOT"/public/style.css \
   "$ROOT"/public/sw.js "$ROOT"/public/icon.svg "$OUT/"
cp -r "$ROOT"/public/assets "$OUT/assets"

# Front gate + shell (shell gets the backend origin substituted in).
cp "$ROOT"/front/gate.js "$OUT/gate.js"
sed -e "s|__HALCYON_BACKEND__|$BACKEND|g" -e "s|__HALCYON_BASE__|$BASE|g" "$ROOT"/front/index.html > "$OUT/index.html"

# Scramjet runtime, bundled same-origin on the front (resolved from node_modules).
ROOT="$ROOT" OUT="$OUT" node -e '
const req=require("module").createRequire(process.env.ROOT+"/server.js");
const {dirname,join}=require("path");const fs=require("fs");
const sj=req("@mercuryworkshop/scramjet/path").scramjetPath;
const ctrl=dirname(req.resolve("@mercuryworkshop/scramjet-controller"));
const lib=dirname(req.resolve("@mercuryworkshop/libcurl-transport"));
const out=process.env.OUT+"/scram/";
const map={"scramjet.js":join(sj,"scramjet.js"),"scramjet.wasm":join(sj,"scramjet.wasm"),"controller.api.js":join(ctrl,"controller.api.js"),"controller.inject.js":join(ctrl,"controller.inject.js"),"controller.sw.js":join(ctrl,"controller.sw.js"),"libcurl.js":join(lib,"index.js")};
for(const[k,v]of Object.entries(map))fs.copyFileSync(v,out+k);
'

echo "Built front for backend $BACKEND -> $OUT"
echo "Deploy it, e.g.:  npx wrangler pages deploy \"$OUT\""
