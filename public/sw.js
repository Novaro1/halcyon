// Halcyon service worker.
// Drops ad/tracker requests with a REAL network error (Response.error) before
// handing anything else to the Scramjet controller — a faked HTTP response
// still "succeeds" as far as a proxied page's fetch is concerned, so only a
// genuine failure actually blocks.
// Base path the app is served under, derived from where THIS worker is served:
// "/sw.js" -> "" (origin root), "/<bucket>/sw.js" -> "/<bucket>" (sub-path host).
// The client sends the matching proxy prefix at init, so routing just works; we
// only need the base here to load the controller + decode proxied URLs correctly.
const BASE = self.location.pathname.replace(/\/sw\.js$/, "");
importScripts(BASE + "/scram/controller.sw.js");

// ---- Games: serve game files SAME-ORIGIN by fetching them from public repos.
// Extension blockers (what most school devices have) block navigations/iframes,
// not subresource fetches — so a game iframe only ever points at THIS origin, and
// the real hosts are merely fetch()ed here, never navigated to. Three routes:
//   BASE/g/<path>       -> Seraph collection via jsDelivr. Seraph games use relative
//                          paths, so mirroring the whole repo makes shared engines
//                          (EmulatorJS/Ruffle/Unity) resolve.
//   BASE/gm/<file>      -> gn-math wrapper HTML (raw.githubusercontent). Each wrapper
//                          carries an absolute <base href> to its own game repo, so
//                          its assets load straight from jsDelivr as subresources.
//   BASE/cover/<id>.png -> gn-math cover art (raw.githubusercontent).
// Fires before the Scramjet handler below.
const SERAPH_SRC   = "https://cdn.jsdelivr.net/gh/pug0806/seraph@main";
const GNMATH_HTML  = "https://raw.githubusercontent.com/gn-math/html/main";
const GNMATH_COVER = "https://raw.githubusercontent.com/gn-math/covers/main";
const G_PREFIX     = BASE + "/g/";
const GM_PREFIX    = BASE + "/gm/";
const COVER_PREFIX = BASE + "/cover/";
const GAMES_MIME = { html:"text/html",htm:"text/html",js:"application/javascript",mjs:"application/javascript",
  css:"text/css",json:"application/json",png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",gif:"image/gif",
  svg:"image/svg+xml",webp:"image/webp",ico:"image/x-icon",wasm:"application/wasm",mp3:"audio/mpeg",
  ogg:"audio/ogg",wav:"audio/wav",woff:"font/woff",woff2:"font/woff2",ttf:"font/ttf",otf:"font/otf",
  swf:"application/x-shockwave-flash",txt:"text/plain" };
function gameFetch(src, pathForExt, forceType) {
  return (async () => {
    try {
      const r = await fetch(src, { cache: "force-cache" });
      const body = await r.arrayBuffer();
      const ext = (pathForExt.split("?")[0].split(".").pop() || "").toLowerCase();
      const ct = forceType || GAMES_MIME[ext] || r.headers.get("content-type") || "application/octet-stream";
      return new Response(body, { status: r.status, headers: { "content-type": ct } });
    } catch (err) { return new Response("game-fetch-fail: " + err.message, { status: 502 }); }
  })();
}
self.addEventListener("fetch", (event) => {
  let u;
  try { u = new URL(event.request.url); } catch { return; }
  if (u.origin !== self.location.origin) return;
  const p = u.pathname;
  if (p.startsWith(G_PREFIX)) {
    event.stopImmediatePropagation();
    let path = p.slice(G_PREFIX.length);
    if (path === "" || path.endsWith("/")) path += "index.html";
    event.respondWith(gameFetch(SERAPH_SRC + "/" + path, path));
  } else if (p.startsWith(GM_PREFIX)) {
    event.stopImmediatePropagation();
    const file = p.slice(GM_PREFIX.length).replace(/[^\w.-]/g, "");   // our own trusted filename, sanitized
    event.respondWith(gameFetch(GNMATH_HTML + "/" + file, "x.html", "text/html"));
  } else if (p.startsWith(COVER_PREFIX)) {
    event.stopImmediatePropagation();
    const id = p.slice(COVER_PREFIX.length).replace(/\.png$/, "").replace(/[^0-9]/g, "");
    event.respondWith(gameFetch(GNMATH_COVER + "/" + id + ".png", "x.png", "image/png"));
  }
});

let ADBLOCK = true;
let blockedCount = 0;
const BLOCK = new Set([
  // Pure ad/telemetry hosts the breakage-averse DNS list omits — always on,
  // and a safety net if the big list ever fails to load.
  "doubleclick.net", "google-analytics.com", "googlesyndication.com",
  "googleadservices.com", "googletagmanager.com", "googletagservices.com",
  "adservice.google.com", "ads.google.com", "ads.youtube.com", "2mdn.net",
  "app-measurement.com", "ads.tiktok.com", "analytics.tiktok.com",
  "samsungads.com", "bugsnag.com", "sentry-cdn.com", "getsentry.com",
  "hotjar.com", "hotjar.io", "scorecardresearch.com", "connect.facebook.net",
  "mc.yandex.ru", "luckyorange.com", "luckyorange.net", "mouseflow.com",
]);

// Allowlist: hosts the SW must NEVER block, even when the blocklist matches them
// — CDNs / auth / push / app APIs that an aggressive list over-blocks. Loaded
// from /allowlist.txt (live-refreshed by the server; anudeepND's whitelist).
const ALLOW = new Set();

// AI content-farm blocklist — its own opt-in toggle (opinionated list). Only
// loaded when AIBLOCK is on. Default on; the toggle pushes the stored pref.
let AIBLOCK = true;
const AI_BLOCK = new Set();

// Load the full ~56k-domain list exactly once. A service worker can be killed
// the moment it goes idle, so a bare fire-and-forget fetch often dies before it
// finishes — we keep the promise and make request handling await it, and load
// it in `install` too so the first activation blocks until it's ready.
// The server live-refreshes this list from the source (see server.js) and sets a
// 1h Cache-Control, so "default" lets a fresh SW pick up updates rather than
// being pinned to the first version forever (which "force-cache" would do).
let blocklistReady = null;
function ensureBlocklist() {
  if (blocklistReady) return blocklistReady;
  blocklistReady = fetch("/blocklist.txt", { cache: "default" })
    .then((r) => (r.ok ? r.text() : ""))
    .then((t) => {
      for (const line of t.split("\n")) {
        const d = line.trim();
        if (d && d[0] !== "#") BLOCK.add(d);
      }
    })
    .catch(() => {
      blocklistReady = null; // allow a retry on the next request
    });
  return blocklistReady;
}
// Same load pattern for the allowlist — live-refreshed, awaited before deciding.
let allowlistReady = null;
function ensureAllowlist() {
  if (allowlistReady) return allowlistReady;
  allowlistReady = fetch("/allowlist.txt", { cache: "default" })
    .then((r) => (r.ok ? r.text() : ""))
    .then((t) => {
      for (const line of t.split("\n")) {
        const d = line.trim();
        if (d && d[0] !== "#") ALLOW.add(d);
      }
    })
    .catch(() => {
      allowlistReady = null;
    });
  return allowlistReady;
}
// AI content-farm list — same load pattern; fetched lazily (only when its
// toggle is on, so it's not downloaded for users who don't want it).
let aiBlocklistReady = null;
function ensureAiBlocklist() {
  if (aiBlocklistReady) return aiBlocklistReady;
  aiBlocklistReady = fetch("/ai-blocklist.txt", { cache: "default" })
    .then((r) => (r.ok ? r.text() : ""))
    .then((t) => {
      for (const line of t.split("\n")) {
        const d = line.trim();
        if (d && d[0] !== "#") AI_BLOCK.add(d);
      }
    })
    .catch(() => {
      aiBlocklistReady = null;
    });
  return aiBlocklistReady;
}
ensureBlocklist();
ensureAllowlist();
self.addEventListener("install", (e) =>
  e.waitUntil(Promise.all([ensureBlocklist(), ensureAllowlist()]))
);

function hostInSet(h, set) {
  if (!h || set.size === 0) return false;
  h = h.toLowerCase();
  if (set.has(h)) return true;
  let i = h.indexOf(".");
  while (i !== -1) {
    if (set.has(h.slice(i + 1))) return true;
    i = h.indexOf(".", i + 1);
  }
  return false;
}
const blockedHost = (h) => hostInSet(h, BLOCK);
const allowedHost = (h) => hostInSet(h, ALLOW);
const aiBlockedHost = (h) => hostInSet(h, AI_BLOCK);

// Decode the real destination URL from a Scramjet-proxied request URL.
// Proxied path: /~/sj/<controller>/<frame>/<encodeURIComponent(realURL)>
function realUrlOf(reqUrl) {
  try {
    const p = new URL(reqUrl).pathname;
    const m = p.match(
      new RegExp("^" + BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/~/sj/[^/]+/[^/]+/(.+)$")
    );
    if (!m) return null;
    return new URL(decodeURIComponent(m[1]));
  } catch {
    return null;
  }
}

self.addEventListener("message", (e) => {
  const d = e.data || {};
  if (typeof d.halcyonAdblock === "boolean") ADBLOCK = d.halcyonAdblock;
  if (typeof d.halcyonAiblock === "boolean") {
    AIBLOCK = d.halcyonAiblock;
    // Proactively load the AI list the moment we learn the toggle is on (the page
    // pushes this pref on every boot), holding the SW alive until it finishes —
    // so `aiDomains` is populated by boot time instead of only after the first
    // proxied request happens to trigger the lazy load (which made a stats read
    // right after boot report 0). Still respects "only fetch when enabled":
    // nothing downloads while the toggle is off.
    if (AIBLOCK) e.waitUntil(ensureAiBlocklist());
  }
  if (d.halcyonQuery === "stats" && e.ports && e.ports[0]) {
    e.ports[0].postMessage({
      enabled: ADBLOCK,
      blocked: blockedCount,
      domains: BLOCK.size,
      allowed: ALLOW.size,
      aiEnabled: AIBLOCK,
      aiDomains: AI_BLOCK.size,
    });
  }
});

self.addEventListener("fetch", (event) => {
  if (!$scramjetController.shouldRoute(event)) return;
  if (!ADBLOCK && !AIBLOCK) {
    event.respondWith($scramjetController.route(event));
    return;
  }
  const real = realUrlOf(event.request.url);
  if (!real) {
    event.respondWith($scramjetController.route(event));
    return;
  }
  // Ensure the lists we need are loaded before deciding (await is a no-op once
  // ready; the AI list is only fetched when its toggle is on). The allowlist
  // always wins — an allowlisted host is never blocked by either list.
  const loads = [];
  if (ADBLOCK) loads.push(ensureBlocklist());
  if (ADBLOCK || AIBLOCK) loads.push(ensureAllowlist());
  if (AIBLOCK) loads.push(ensureAiBlocklist());
  event.respondWith(
    Promise.all(loads).then(() => {
      const host = real.hostname;
      if (!allowedHost(host)) {
        if (ADBLOCK && blockedHost(host)) {
          blockedCount++;
          return Response.error();
        }
        if (AIBLOCK && aiBlockedHost(host)) {
          blockedCount++;
          return Response.error();
        }
      }
      return $scramjetController.route(event);
    })
  );
});
