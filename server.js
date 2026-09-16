import http from "node:http";
import { createReadStream, existsSync, statSync, readFileSync } from "node:fs";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash, timingSafeEqual } from "node:crypto";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8090;
// Loopback by default — you must opt in to expose Halcyon to your network.
const HOST = process.env.HOST || "127.0.0.1";

// Optional access gate. Set HALCYON_PASSWORD before exposing this server to
// anyone else, so it can't be used as an open proxy (the exit IP is yours).
const PASSWORD = process.env.HALCYON_PASSWORD || "";
const AUTH_TOKEN = PASSWORD
  ? createHash("sha256").update(PASSWORD + "::halcyon-auth").digest("hex")
  : null;

// ---- Wisp: keep it a dumb, locked-down relay ------------------------------
// Content is already end-to-end encrypted (TLS runs in the browser via the
// libcurl transport), so the relay never sees plaintext. These options make
// sure it also can't be steered into the server's own private network (SSRF).
// HALCYON_DNS overrides the resolver(s) used to look up destination hosts —
// comma-separated plain-DNS server IPs (not DoH/DoT URLs). Point it at a
// filtering resolver (e.g. AdGuard DNS 94.140.14.14, Quad9 9.9.9.9) for
// DNS-level ad/malware blocking on top of the in-browser blocklist; note that
// unlike the SW blocklist, DNS-level blocks can't be un-blocked by the allowlist.
const DNS_SERVERS = (process.env.HALCYON_DNS || "1.1.1.1,1.0.0.1")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
logging.set_level(logging.WARN);

// ---- Abuse guardrails (for public exposure) -------------------------------
// A public proxy makes every connection from THIS server's IP, so it must not
// be usable to (a) reach the host's own infra/cloud-metadata (SSRF), or (b) act
// as a general TCP/UDP relay to attack/spam arbitrary services. These options
// keep it a *web* proxy only. All are env-tunable so a self-hoster can loosen
// or tighten them.

// Destination ports the tunnel may reach — web only by default (not a generic
// TCP relay to SMTP:25 spam, SSH, databases, game servers, …).
const ALLOWED_PORTS = (process.env.HALCYON_ALLOWED_PORTS || "80,443")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => n > 0 && n < 65536);

// Hostname denylist (regex, tested against the destination host). Blocks
// localhost/loopback, private-IP literals, cloud metadata, mDNS/.internal, and
// this host's own Fly infra — SSRF defense in depth on top of allow_private_ips.
const DENY_HOSTS = [
  /^localhost$/i,
  /(^|\.)internal$/i, // *.internal (Fly, k8s, cloud)
  /(^|\.)local$/i, //     mDNS .local
  /(^|\.)fly\.dev$/i, //   our own app + Fly edge
  /^metadata\.google\.internal$/i,
  /^169\.254\./, //        link-local incl. 169.254.169.254 cloud metadata
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16-31
  /^0\./,
  /^::1$/,
  /^fe80:/i, //            v6 link-local
  /^f[cd][0-9a-f]{2}:/i, // v6 ULA (incl. Fly 6PN fdaa:)
];
// Operator extras: HALCYON_DENY_HOSTS = comma-separated regex sources.
(process.env.HALCYON_DENY_HOSTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .forEach((s) => {
    try {
      DENY_HOSTS.push(new RegExp(s, "i"));
    } catch {}
  });

Object.assign(wisp.options, {
  allow_private_ips: false,
  allow_loopback_ips: false,
  allow_udp_streams: false, // web is TCP; no UDP relay (DNS amp / QUIC abuse)
  dns_method: "resolve",
  dns_servers: DNS_SERVERS,
  dns_result_order: "ipv4first",
  hostname_blacklist: DENY_HOSTS,
  port_whitelist: ALLOWED_PORTS,
});

// ---- Per-IP rate limiting + connection caps -------------------------------
// The real client IP comes from Cloudflare / Fly headers when fronted, else the
// socket. NOTE: shared NATs (a whole school behind one IP) are the target
// audience, so ceilings are deliberately generous — they stop a runaway
// script/abuser, not a classroom. Login is the exception (brute-force).
function clientIp(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    req.headers["fly-client-ip"] ||
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    (req.socket && req.socket.remoteAddress) ||
    "?"
  );
}
function makeLimiter(max, windowMs) {
  const hits = new Map(); // ip -> { n, reset }
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [ip, v] of hits) if (v.reset <= now) hits.delete(ip);
  }, windowMs);
  timer.unref && timer.unref();
  return (ip) => {
    const now = Date.now();
    let v = hits.get(ip);
    if (!v || v.reset <= now) {
      v = { n: 0, reset: now + windowMs };
      hits.set(ip, v);
    }
    v.n++;
    return v.n <= max;
  };
}
const num = (env, d) => {
  const n = parseInt(process.env[env], 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const httpLimiter = makeLimiter(num("HALCYON_RL_HTTP", 600), 60_000); // req/min/IP
const loginLimiter = makeLimiter(num("HALCYON_RL_LOGIN", 20), 60_000); // strict
const wispLimiter = makeLimiter(num("HALCYON_RL_WISP", 300), 60_000); // upgrades/min/IP
const MAX_WISP_CONCURRENT = num("HALCYON_MAX_CONN", 128); // concurrent tunnels/IP
const wispConns = new Map(); // ip -> live connection count

// ---- Resolve the scramjet runtime files out of node_modules ---------------
const scramjetDist = require("@mercuryworkshop/scramjet/path").scramjetPath;
const controllerDist = dirname(require.resolve("@mercuryworkshop/scramjet-controller"));
const libcurlDist = dirname(require.resolve("@mercuryworkshop/libcurl-transport"));

const runtimeFiles = {
  "/scram/scramjet.js": join(scramjetDist, "scramjet.js"),
  "/scram/scramjet.wasm": join(scramjetDist, "scramjet.wasm"),
  "/scram/controller.api.js": join(controllerDist, "controller.api.js"),
  "/scram/controller.inject.js": join(controllerDist, "controller.inject.js"),
  "/scram/controller.sw.js": join(controllerDist, "controller.sw.js"),
  "/scram/libcurl.js": join(libcurlDist, "index.js"),
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const publicDir = join(__dirname, "public");

// ---- Discord cosmetic ad-block CSS (fetched live, cached) -----------------
// Disblock-Origin is a CSS userstyle that hides Discord's Nitro/boost upsells
// and promo UI (Discord serves no third-party display ads). We fetch it
// server-side — no CORS, and only the server, not each viewer, touches codeberg
// — cache it, and let proxy.js inject it into the proxied Discord window.
// Nothing is bundled: if the fetch fails we serve empty and Discord just shows
// its upsells. Source: https://codeberg.org/AllPurposeMat/Disblock-Origin
const DISCORD_CSS_URL =
  "https://allpurposemat.codeberg.page/Disblock-Origin/DisblockOrigin.theme.css";
const DISCORD_CSS_TTL = 6 * 60 * 60 * 1000; // 6h
let discordCss = { text: "", at: 0 };
async function getDiscordCss() {
  if (discordCss.text && Date.now() - discordCss.at < DISCORD_CSS_TTL) {
    return discordCss.text;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(DISCORD_CSS_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (r.ok) {
      discordCss = { text: await r.text(), at: Date.now() };
    }
  } catch {
    /* offline / upstream down — serve stale cache if we have it, else "" */
  }
  return discordCss.text;
}

// ---- Ad/tracker blocklist (live-fetched, cached, with fallback) -----------
// The SW does DNS-style hostname matching against this list. Instead of a stale
// bundled snapshot, we refresh it from the source(s) on a TTL and cache it; if
// the fetch ever fails we fall back to the bundled public/blocklist.txt so
// blocking never goes dark. Any hosts/ABP/wildcard/plain-domain source works —
// the normalizer reduces every line to a bare domain (what the SW expects).
// HALCYON_BLOCKLIST_URL may be a COMMA-SEPARATED list; all sources are fetched
// and unioned. Defaults: HaGeZi Multi PRO (ads/tracking/metrics/telemetry +
// phishing/malware, © HaGeZi) + FMHY's anti-scam sitelist (fake/malicious site
// clones, © FMHY: https://github.com/fmhy/FMHYFilterlist) + durablenapkin's
// scamblocklist (scam/phishing, © durablenapkin) + HaGeZi TIF mini (threat-intel:
// malware/phishing/scam/cryptojacking/C2 — the "Malwarebytes" layer; the mini
// variant is HaGeZi's browser-recommended size, ~178k vs full's 2.4M).
const BLOCKLIST_URLS = (
  process.env.HALCYON_BLOCKLIST_URL ||
  "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/pro.txt," +
    "https://raw.githubusercontent.com/fmhy/FMHYFilterlist/main/sitelist.txt," +
    "https://raw.githubusercontent.com/durablenapkin/scamblocklist/master/hosts.txt," +
    "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/tif.mini.txt"
)
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
const BLOCKLIST_TTL = 12 * 60 * 60 * 1000; // 12h on success
const BLOCKLIST_RETRY = 30 * 60 * 1000; //   30m after a failure
let blocklist = { text: "", at: 0, ok: false };

function normalizeBlocklist(text) {
  const out = new Set();
  for (let line of text.split("\n")) {
    line = line.trim();
    if (!line || line[0] === "#" || line[0] === "!") continue;
    line = line
      .replace(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1?)\s+/, "") // hosts format
      .replace(/^\|\|/, "") //                                ABP  ||domain^
      .replace(/[\^$].*$/, "") //                             ABP options / anchor
      .replace(/^\*\./, "") //                                wildcard *.domain
      .trim()
      .replace(/\.$/, "")
      .toLowerCase();
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(line)) out.add(line);
  }
  return [...out].join("\n");
}

async function fetchList(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    return r.ok ? normalizeBlocklist(await r.text()) : "";
  } catch {
    clearTimeout(timer);
    return ""; // this source is down — others may still succeed
  }
}

async function getBlocklist() {
  const ttl = blocklist.ok ? BLOCKLIST_TTL : BLOCKLIST_RETRY;
  if (blocklist.text && Date.now() - blocklist.at < ttl) return blocklist.text;
  const results = await Promise.all(BLOCKLIST_URLS.map(fetchList));
  const domains = new Set();
  for (const text of results) {
    if (!text) continue;
    for (const d of text.split("\n")) if (d) domains.add(d);
  }
  // Sanity: a real union, not just error pages / a lone tiny source. (>10k so a
  // partial failure of the big list falls back to the bundled snapshot instead.)
  if (domains.size > 10000) {
    blocklist = { text: [...domains].join("\n"), at: Date.now(), ok: true };
    console.log(
      `  Blocklist refreshed: ${domains.size} domains from ` +
        `${results.filter(Boolean).length}/${BLOCKLIST_URLS.length} sources`
    );
    return blocklist.text;
  }
  // All (or the big) source(s) failed — fall back to the bundled snapshot.
  let text = blocklist.text;
  if (!text) {
    try {
      text = readFileSync(join(publicDir, "blocklist.txt"), "utf8");
    } catch {
      text = "";
    }
  }
  blocklist = { text, at: Date.now(), ok: false }; // retry sooner (BLOCKLIST_RETRY)
  return text;
}

// ---- Allowlist (live-fetched) — exempt known-good domains from blocking -----
// Aggressive blocklists (like HaGeZi PRO) occasionally block a domain a service
// genuinely needs — CDNs, auth, push, app APIs (Tubi, Xbox, Twitch, Instagram
// Graph, …). This curated allowlist un-blocks them: the SW never blocks a host
// on this list even when the blocklist matches it. Default = anudeepND's
// whitelist; override with HALCYON_ALLOWLIST_URL. Same normalizer → bare domains.
// List © anudeepND: https://github.com/anudeepND/whitelist
const ALLOWLIST_URL =
  process.env.HALCYON_ALLOWLIST_URL ||
  "https://raw.githubusercontent.com/anudeepND/whitelist/master/domains/whitelist.txt";
const ALLOWLIST_TTL = 12 * 60 * 60 * 1000;
const ALLOWLIST_RETRY = 30 * 60 * 1000;
let allowlist = { text: "", at: 0, ok: false };

async function getAllowlist() {
  const ttl = allowlist.ok ? ALLOWLIST_TTL : ALLOWLIST_RETRY;
  if (allowlist.text && Date.now() - allowlist.at < ttl) return allowlist.text;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(ALLOWLIST_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (r.ok) {
      const norm = normalizeBlocklist(await r.text()); // reuse bare-domain normalizer
      if (norm.split("\n").length > 20) {
        allowlist = { text: norm, at: Date.now(), ok: true };
        console.log(`  Allowlist refreshed: ${norm.split("\n").length} domains`);
        return norm;
      }
    }
  } catch {
    /* offline / upstream down — fall back to bundled snapshot below */
  }
  let text = allowlist.text;
  if (!text) {
    try {
      text = readFileSync(join(publicDir, "allowlist.txt"), "utf8");
    } catch {
      text = "";
    }
  }
  allowlist = { text, at: Date.now(), ok: false };
  return text;
}

// ---- AI content-farm blocklist (optional, live-fetched) -------------------
// alvi-se's uBlock list of AI "slop" content farms. Opinionated (blocks whole
// domains judged AI-generated, a few of them borderline-legit), so it's its own
// opt-in toggle, kept separate from the objective ad/security blocklist. Same
// normalizer (||domain^$… → bare domain). The SW only fetches this when its
// toggle is on. Override with HALCYON_AIBLOCKLIST_URL.
// List © alvi-se: https://github.com/alvi-se/ai-ublock-blacklist
const AIBLOCKLIST_URL =
  process.env.HALCYON_AIBLOCKLIST_URL ||
  "https://raw.githubusercontent.com/alvi-se/ai-ublock-blacklist/master/list.txt";
const AIBLOCKLIST_TTL = 12 * 60 * 60 * 1000;
const AIBLOCKLIST_RETRY = 30 * 60 * 1000;
let aiBlocklist = { text: "", at: 0, ok: false };

async function getAiBlocklist() {
  const ttl = aiBlocklist.ok ? AIBLOCKLIST_TTL : AIBLOCKLIST_RETRY;
  if (aiBlocklist.text && Date.now() - aiBlocklist.at < ttl) return aiBlocklist.text;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(AIBLOCKLIST_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (r.ok) {
      const norm = normalizeBlocklist(await r.text());
      if (norm.split("\n").length > 100) {
        aiBlocklist = { text: norm, at: Date.now(), ok: true };
        console.log(`  AI content-farm blocklist refreshed: ${norm.split("\n").length} domains`);
        return norm;
      }
    }
  } catch {
    /* offline / upstream down — fall back to bundled snapshot below */
  }
  let text = aiBlocklist.text;
  if (!text) {
    try {
      text = readFileSync(join(publicDir, "ai-blocklist.txt"), "utf8");
    } catch {
      text = "";
    }
  }
  aiBlocklist = { text, at: Date.now(), ok: false };
  return text;
}

// ---- Tracking-param stripping (DandelionSprout LegitimateURLShortener) -----
// A live-fetched AdGuard $removeparam list of tracking query params (utm_*,
// fbclid, gclid, …). We parse the GLOBAL rules — plain param names + global
// /regex/ rules — into JSON and serve them; proxy.js strips these params from
// URLs you navigate to. Domain-scoped and value-pattern rules are skipped for
// now. Override the source with HALCYON_REMOVEPARAMS_URL.
// List © DandelionSprout: https://github.com/DandelionSprout/adfilt
const REMOVEPARAMS_URL =
  process.env.HALCYON_REMOVEPARAMS_URL ||
  "https://raw.githubusercontent.com/DandelionSprout/adfilt/refs/heads/master/LegitimateURLShortener.txt";
const REMOVEPARAMS_TTL = 12 * 60 * 60 * 1000; // 12h (list expires 12h)
const REMOVEPARAMS_RETRY = 30 * 60 * 1000;
let removeparams = { json: "", at: 0, ok: false };

function parseRemoveparams(text) {
  const plain = new Set();
  const regex = [];
  for (let line of text.split("\n")) {
    line = line.trim();
    if (!line || line[0] === "!") continue;
    // Only lines starting with "$" are global option-only rules; anything with
    // a domain/URL-pattern prefix (||foo^…, /?r=…, &uclick=…) is scoped — skip.
    if (line[0] !== "$") continue;
    const opts = line.slice(1);
    const i = opts.indexOf("removeparam=");
    if (i === -1) continue;
    const before = opts.slice(0, i); // options before, e.g. "doc,"
    const tail = opts.slice(i + "removeparam=".length);
    let value, after; // value = string (plain) or {re,flags}; after = trailing options
    if (tail[0] === "/") {
      // regex value: /re/flags, greedy to the last "/" (domains carry no "/")
      const m = tail.match(/^\/(.+)\/([a-z]*)(?:,(.*))?$/);
      if (!m) continue;
      value = { re: m[1], flags: m[2] };
      after = m[3] || "";
    } else {
      const c = tail.indexOf(",");
      value = c === -1 ? tail : tail.slice(0, c);
      after = c === -1 ? "" : tail.slice(c + 1);
    }
    // Skip positively-scoped rules — a domain= (before or after) that isn't
    // all-negation ("everywhere except…", which we treat as global).
    const dom = (before + "," + after).match(/domain=([^,]+)/);
    if (dom && !dom[1].split("|").every((d) => d.startsWith("~"))) continue;
    if (typeof value === "string") {
      if (value && value[0] !== "~" && /^[\w.%-]+$/.test(value)) plain.add(value);
    } else {
      try {
        new RegExp(value.re, value.flags); // validate
        regex.push({ source: value.re, flags: value.flags });
      } catch {}
    }
  }
  return JSON.stringify({ plain: [...plain], regex });
}

async function getRemoveparams() {
  const ttl = removeparams.ok ? REMOVEPARAMS_TTL : REMOVEPARAMS_RETRY;
  if (removeparams.json && Date.now() - removeparams.at < ttl) return removeparams.json;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(REMOVEPARAMS_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (r.ok) {
      const json = parseRemoveparams(await r.text());
      const n = JSON.parse(json).plain.length;
      if (n > 100) {
        removeparams = { json, at: Date.now(), ok: true };
        console.log(`  URL-cleaner rules refreshed: ${n} params + regexes`);
        return json;
      }
    }
  } catch {
    /* offline / upstream down — serve last-known or empty (cleaning no-ops) */
  }
  if (!removeparams.json) removeparams.json = '{"plain":[],"regex":[]}';
  removeparams.at = Date.now();
  removeparams.ok = false;
  return removeparams.json;
}

// Baseline hardening headers for everything WE serve (the shell + runtime).
// Proxied page content is produced by the service worker, not here.
function baseHeaders(res) {
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
}

function sendFile(res, filePath, { immutable = false } = {}) {
  const type = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
  baseHeaders(res);
  res.setHeader("Content-Type", type);
  if (immutable) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  createReadStream(filePath).pipe(res);
}

// ---- Auth helpers ---------------------------------------------------------
function isAuthed(req) {
  if (!AUTH_TOKEN) return true;
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)halcyon_auth=([a-f0-9]{64})/);
  if (!match) return false;
  const a = Buffer.from(match[1]);
  const b = Buffer.from(AUTH_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 4096) req.destroy(); // no big bodies here
    });
    req.on("end", () => resolve(data));
  });
}

function loginPage(error = false) {
  return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex"/><title>Halcyon</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;height:100vh;display:grid;place-items:center;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    color:#f4eee1;background:radial-gradient(1000px 600px at 20% 0%,rgba(31,209,163,.16),transparent 60%),
    radial-gradient(900px 500px at 100% 20%,rgba(255,138,76,.12),transparent 55%),#040b09}
  form{width:320px;padding:34px 30px;border-radius:22px;text-align:center;
    background:rgba(255,250,240,.05);border:1px solid rgba(255,250,240,.12);
    backdrop-filter:blur(20px);box-shadow:0 24px 60px rgba(0,0,0,.5)}
  .orb{width:44px;height:44px;border-radius:50%;margin:0 auto 16px;
    background:linear-gradient(118deg,#1fd1a3,#ffd27a,#ff8a4c);
    box-shadow:0 0 18px rgba(31,209,163,.5)}
  h1{font-size:22px;margin:0 0 4px;letter-spacing:-.5px}
  p{color:#9ba79a;font-size:13px;margin:0 0 22px}
  input{width:100%;padding:13px 15px;border-radius:11px;font-size:15px;
    background:rgba(0,0,0,.3);border:1px solid rgba(255,250,240,.14);color:#f4eee1;outline:none}
  input:focus{border-color:rgba(31,209,163,.7)}
  button{width:100%;margin-top:12px;padding:13px;border:0;border-radius:11px;
    font-size:15px;font-weight:700;color:#0a1a14;cursor:pointer;
    background:linear-gradient(118deg,#1fd1a3,#ffd27a,#ff8a4c)}
  .err{color:#ff8f8f;font-size:12.5px;margin-top:12px;min-height:1em}
</style></head><body>
<form method="POST" action="/login">
  <div class="orb"></div>
  <h1>Halcyon</h1>
  <p>This proxy is private. Enter the passphrase.</p>
  <input type="password" name="password" placeholder="Passphrase" autofocus autocomplete="current-password"/>
  <button type="submit">Unlock</button>
  <div class="err">${error ? "Incorrect passphrase." : ""}</div>
</form></body></html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let path = decodeURIComponent(url.pathname);
    const ip = clientIp(req);

    // General per-IP request ceiling (stops runaway scripts; generous for NATs).
    if (!httpLimiter(ip)) {
      res.writeHead(429, { "Content-Type": "text/plain", "Retry-After": "60" });
      return res.end("Too many requests — slow down.");
    }

    // ---- Access gate ----
    if (AUTH_TOKEN) {
      if (path === "/login") {
        if (req.method === "POST") {
          // Strict limit on login attempts — brute-force defense.
          if (!loginLimiter(ip)) {
            res.writeHead(429, { "Content-Type": "text/plain", "Retry-After": "60" });
            return res.end("Too many attempts — wait a minute.");
          }
          const body = await readBody(req);
          const pw = new URLSearchParams(body).get("password") || "";
          const ok =
            createHash("sha256").update(pw + "::halcyon-auth").digest("hex") === AUTH_TOKEN;
          if (ok) {
            const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
            res.writeHead(303, {
              Location: "/",
              "Set-Cookie": `halcyon_auth=${AUTH_TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure}`,
            });
            return res.end();
          }
          res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
          return res.end(loginPage(true));
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(loginPage(false));
      }
      if (!isAuthed(req)) {
        const wantsHtml = (req.headers.accept || "").includes("text/html");
        if (wantsHtml) {
          res.writeHead(303, { Location: "/login" });
          return res.end();
        }
        res.writeHead(401, { "Content-Type": "text/plain" });
        return res.end("Unauthorized");
      }
    }

    // Runtime files (scramjet / controller / transport).
    if (Object.prototype.hasOwnProperty.call(runtimeFiles, path)) {
      return sendFile(res, runtimeFiles[path], { immutable: true });
    }

    // Discord cosmetic ad-block stylesheet (live-fetched upstream, cached).
    if (path === "/discord-adblock.css") {
      const css = await getDiscordCss();
      baseHeaders(res);
      res.setHeader("Content-Type", "text/css; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=21600"); // 6h, matches TTL
      return res.end(css);
    }

    // Ad/tracker blocklist — live-refreshed from OISD (cached), bundled fallback.
    // Served here (before the static handler) so it self-updates instead of
    // being the frozen public/blocklist.txt snapshot.
    if (path === "/blocklist.txt") {
      const list = await getBlocklist();
      baseHeaders(res);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=3600"); // 1h browser cache
      return res.end(list);
    }

    // Allowlist — domains the SW must never block (overrides the blocklist).
    if (path === "/allowlist.txt") {
      const list = await getAllowlist();
      baseHeaders(res);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.end(list);
    }

    // AI content-farm blocklist (its own opt-in toggle, separate from adblock).
    if (path === "/ai-blocklist.txt") {
      const list = await getAiBlocklist();
      baseHeaders(res);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.end(list);
    }

    // Tracking-param rules (parsed from LegitimateURLShortener, live-refreshed).
    if (path === "/removeparams.json") {
      const json = await getRemoveparams();
      baseHeaders(res);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.end(json);
    }

    // Static site.
    if (path === "/") path = "/index.html";
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(publicDir, safe);
    if (filePath.startsWith(publicDir) && existsSync(filePath) && statSync(filePath).isFile()) {
      // (/blocklist.txt is handled dynamically above; this serves the rest.)
      return sendFile(res, filePath);
    }

    // Proxy-prefixed paths belong to the service worker. If one reaches the
    // server, the SW missed it — 404 rather than leaking the app shell.
    if (path.startsWith("/~/") || path.startsWith("/scram/")) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }

    // SPA fallback for unknown non-asset routes.
    if (!extname(path)) {
      return sendFile(res, join(publicDir, "index.html"));
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Server error");
    console.error(err);
  }
});

// Wisp websocket upgrade — the tunnel the proxy rides on. Gated by the same
// cookie so an exposed instance can't be used as an anonymous relay.
server.on("upgrade", (req, socket, head) => {
  if (AUTH_TOKEN && !isAuthed(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!req.url.endsWith("/wisp/")) {
    socket.end();
    return;
  }
  // Per-IP tunnel guardrails: new-connection rate + concurrent-connection cap,
  // so one client can't open unbounded tunnels (egress blow-up / DoS).
  const ip = clientIp(req);
  if (!wispLimiter(ip) || (wispConns.get(ip) || 0) >= MAX_WISP_CONCURRENT) {
    socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
    socket.destroy();
    return;
  }
  wispConns.set(ip, (wispConns.get(ip) || 0) + 1);
  socket.on("close", () => {
    const n = (wispConns.get(ip) || 1) - 1;
    if (n <= 0) wispConns.delete(ip);
    else wispConns.set(ip, n);
  });
  wisp.routeRequest(req, socket, head);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Halcyon → http://localhost:${PORT}  (bound to ${HOST})`);
  console.log(`  Transport: end-to-end encrypted (libcurl). Relay sees no plaintext.`);
  console.log(`  DNS resolver: ${DNS_SERVERS.join(", ")}`);
  console.log(
    `  Guardrails: ports ${ALLOWED_PORTS.join("/")}, UDP off, ` +
      `${DENY_HOSTS.length} host denies; ≤${MAX_WISP_CONCURRENT} tunnels/IP + rate limits.`
  );
  if (AUTH_TOKEN) {
    console.log(`  Access gate: ON (passphrase required).`);
  } else if (HOST !== "127.0.0.1" && HOST !== "localhost") {
    console.log(
      `  ⚠  WARNING: exposed on ${HOST} with NO passphrase — this is an open proxy.\n` +
        `     Set HALCYON_PASSWORD before exposing it to anyone else.`
    );
  }
  console.log("");
});
