// Halcyon front as a Gen-2 Cloud Function (→ a *.run.app URL).
// It just serves the static front bundle in ./public/ (built by
// deploy/build-front.sh with the backend baked in). The point is the URL: run.app
// is Google-owned, high-reputation infra — a candidate "golden" domain like
// storage.googleapis.com. All proxy traffic still tunnels to the one backend.
const functions = require("@google-cloud/functions-framework");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "public");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

functions.http("front", (req, res) => {
  let p = decodeURIComponent((req.path || "/").split("?")[0]);
  if (p === "/" || p === "") p = "/index.html";
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) {
    res.status(403).send("Forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.status(404).send("Not found");
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.set("Content-Type", TYPES[ext] || "application/octet-stream");
    if (p === "/sw.js") res.set("Service-Worker-Allowed", "/");
    res.set("Cache-Control", ext === ".html" || p === "/sw.js" ? "no-cache" : "public, max-age=3600");
    // The bundle is built base="" (correct for the run.app root). When reached via
    // cloudfunctions.net the app lives under /<function-name> (that prefix is
    // stripped before we see it), so rewrite index.html's base for that host.
    // Everything else (proxy.js, sw.js) reads the base at runtime, so only
    // index.html needs patching.
    if (p === "/index.html" && String(req.headers.host || "").endsWith("cloudfunctions.net")) {
      data = Buffer.from(
        data
          .toString("utf8")
          .replace(/window\.HALCYON_BASE\s*=\s*""/, 'window.HALCYON_BASE = "/halcyon-front"')
      );
    }
    res.status(200).send(data);
  });
});
