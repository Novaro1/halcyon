// Halcyon service worker.
// Drops ad/tracker requests with a REAL network error (Response.error) before
// handing anything else to the Scramjet controller — a faked HTTP response
// still "succeeds" as far as a proxied page's fetch is concerned, so only a
// genuine failure actually blocks.
importScripts("/scram/controller.sw.js");

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
    const m = p.match(/^\/~\/sj\/[^/]+\/[^/]+\/(.+)$/);
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
