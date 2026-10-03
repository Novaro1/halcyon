// Halcyon independent uptime monitor.
//
// Runs OFF the proxy box (e.g. a free GCE e2-micro) so it survives a backend
// outage and can still alert — unlike the bot's own poller, which dies with the
// box it watches. It runs the SAME deep health check as the bot (../bot/health.js)
// against the backend + the live mirrors, and posts to a Discord WEBHOOK on
// confirmed state changes (no bot token needed — just the webhook URL).
//
// Egress is tiny (a few pings + the occasional alert), so it stays inside the GCE
// free tier. Config via env:
//   HALCYON_ALERT_WEBHOOK  (required) Discord webhook URL for #status-alerts
//   HALCYON_BACKEND        the backend origin to always check, e.g.
//                          https://api.studybuddy.website  (the tunnel chokepoint)
//   LINKS_URL              where to read the current mirrors (same as the bot);
//                          default is the public hub links.json
//   MONITOR_INTERVAL_MIN   minutes between sweeps (default 5)
//   MONITOR_CONFIRM        polls a new state must hold before alerting (default 2)
//   STATUS_ALERT_ROLE_ID   optional role to @mention on an outage (never on recovery)
import { probe, StatusMonitor, formatAlert, UP } from "../bot/health.js";

const WEBHOOK = process.env.HALCYON_ALERT_WEBHOOK || "";
const BACKEND = (process.env.HALCYON_BACKEND || "").replace(/\/+$/, "");
const LINKS_URL = process.env.LINKS_URL || "https://novaro1.github.io/halcyon/links.json";
const INTERVAL_MS = Math.max(1, Number(process.env.MONITOR_INTERVAL_MIN || 5)) * 60_000;
const CONFIRM = Math.max(1, Number(process.env.MONITOR_CONFIRM || 2));
const ROLE_ID = process.env.STATUS_ALERT_ROLE_ID || "";

if (!WEBHOOK) {
  console.error("Missing HALCYON_ALERT_WEBHOOK — set it to the #status-alerts Discord webhook URL.");
  process.exit(1);
}

const monitor = new StatusMonitor({ confirmThreshold: CONFIRM });
const BACKEND_URL = BACKEND ? BACKEND + "/" : "";
const hostLabel = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
};

async function fetchMirrors() {
  try {
    const r = await fetch(LINKS_URL, { cache: "no-store" });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d.mirrors) ? d.mirrors.map((m) => m.url).filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function postAlert(line) {
  try {
    const r = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: line, allowed_mentions: { parse: ["roles"] } }),
    });
    if (!r.ok) console.error("[monitor] webhook returned", r.status);
  } catch (e) {
    console.error("[monitor] webhook post failed:", e.message);
  }
}

async function cycle() {
  const targets = [];
  if (BACKEND_URL) targets.push(BACKEND_URL);
  for (const u of await fetchMirrors()) if (u !== BACKEND_URL) targets.push(u);
  if (!targets.length) {
    console.error("[monitor] nothing to check (no backend + no mirrors)");
    return;
  }
  const results = await Promise.all(targets.map((u) => probe(u)));
  const transitions = monitor.update(results);
  for (const t of transitions) {
    const label = t.key === BACKEND_URL ? `backend (${hostLabel(BACKEND)})` : hostLabel(t.key);
    const line = formatAlert(t, { label, roleId: ROLE_ID });
    console.log("[monitor] ALERT:", line);
    await postAlert(line);
  }
  const up = results.filter((r) => r.state === UP).length;
  console.log(`${new Date().toISOString()} checked ${results.length}, ${up} up`);
}

console.log(
  `Halcyon monitor up — every ${INTERVAL_MS / 60000}m, confirm=${CONFIRM}` +
    (BACKEND ? `, backend ${BACKEND}` : "") +
    (ROLE_ID ? ", role-ping on" : "")
);
cycle();
setInterval(() => cycle().catch((e) => console.error("[monitor] cycle error:", e.message)), INTERVAL_MS);
