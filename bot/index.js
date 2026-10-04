// Halcyon Discord bot — "links via Discord only" distribution + self-serve BYOD.
//
// Slash commands (all reply privately/ephemerally):
//   /links       → the current working domains + the access passphrase
//   /status      → live reachability check of each domain
//   /byod add    → a verified member turns a domain THEY own into a Halcyon mirror
//
// It also runs an auto-updating #status board (STATUS_CHANNEL_ID) with a
// "Check a link" button → a modal where anyone pastes a URL and privately gets back
// whether it's a live Halcyon mirror, or whether an arbitrary site works through
// Halcyon (best-effort: reachability + a known-incompatible list). The checker has
// an SSRF guard so it can't be used to probe the server's internal network.
//
// /byod is the automated version of the staff `deploy/add-domain.sh` flow: it only
// works for verified members, only accepts a domain that ALREADY resolves to this
// server (so nobody can allowlist a domain they don't control), is rate-limited per
// user, and appends the domain to domains.txt — which Caddy re-reads live to issue
// the on-demand TLS cert. No restart, no staff step.
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { resolve4 } from "node:dns/promises";
import { readFile, appendFile, writeFile } from "node:fs/promises";
import { probe, StatusMonitor, formatAlert, STATE_EMOJI, UP, DEGRADED, DOWN } from "./health.js";

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID || ""; // set = instant command updates
const LINKS_URL =
  process.env.LINKS_URL || "https://novaro1.github.io/halcyon/links.json";
const PASSPHRASE = process.env.HALCYON_PASSPHRASE || "";
const BRAND = 0x1fd1a3;

// --- BYOD config ---
const MEMBER_ROLE_ID = process.env.MEMBER_ROLE_ID || "";          // require this role
const DOMAINS_FILE = process.env.HALCYON_DOMAINS_FILE || "/data/domains.txt";
const CNAME_TARGET = process.env.HALCYON_CNAME_TARGET || "vps-aef380a6.vps.ovh.us";
const COMMUNITY_CH = process.env.COMMUNITY_LINKS_CHANNEL_ID || "";  // optional
const MAX_PER_DAY = Number(process.env.BYOD_MAX_PER_DAY || 3);
let SERVER_IP = process.env.HALCYON_SERVER_IP || "";

// --- #status board + link checker ---
const STATUS_CHANNEL_ID = process.env.STATUS_CHANNEL_ID || "";
const STATUS_INTERVAL_MIN = Number(process.env.STATUS_INTERVAL_MIN || 5);
// Optional ops channel: the bot posts here only when a mirror's health CHANGES
// (up↔degraded↔down), so staff hear about outages without watching #status.
const STATUS_ALERT_CHANNEL_ID = process.env.STATUS_ALERT_CHANNEL_ID || "";
// Optional role to @mention on an outage (not on recovery). Blank = no ping.
const STATUS_ALERT_ROLE_ID = process.env.STATUS_ALERT_ROLE_ID || "";
// How many polls in a row a new state must hold before it's alerted (anti-flap).
const STATUS_CONFIRM = Number(process.env.STATUS_CONFIRM_THRESHOLD || 2);

// --- Auto-announce new links ---
// When a new link appears in the list, post it to this channel with the filters
// it's unblocked on and @mention the matching "Filter: <name>" roles. Blank = off.
const LINKS_CHANNEL_ID = process.env.LINKS_CHANNEL_ID || "";
// Remembers which link URLs have been announced (persist via a mounted volume; if
// the file is lost, the current list is re-seeded silently — no re-spam).
const ANNOUNCED_FILE = process.env.HALCYON_ANNOUNCED_FILE || "/data/state/announced-links.json";
const GATE_URL =
  process.env.HALCYON_GATE_URL ||
  (() => { try { return new URL(LINKS_URL).origin; } catch { return ""; } })();
// Sites known to not (fully) work through the Scramjet proxy.
const KNOWN_BROKEN = [
  { rx: /(^|\.)youtube\.com$/, note: "YouTube video playback is unreliable through the proxy (SABR streaming)" },
  { rx: /(^|\.)youtu\.be$/, note: "YouTube video playback is unreliable through the proxy (SABR streaming)" },
  { rx: /(^|\.)googlevideo\.com$/, note: "YouTube's video CDN doesn't play through the proxy" },
];

if (!TOKEN || !CLIENT_ID) {
  console.error("Missing DISCORD_TOKEN and/or DISCORD_CLIENT_ID — see bot/README.md");
  process.exit(1);
}

async function detectServerIp() {
  if (SERVER_IP) return;
  try {
    const r = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(5000) });
    SERVER_IP = (await r.text()).trim();
  } catch {
    /* leave blank — /byod will skip the points-here check if we never learn it */
  }
}

async function fetchMirrors() {
  try {
    const r = await fetch(LINKS_URL, { cache: "no-store" });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d.mirrors) ? d.mirrors : [];
  } catch {
    return [];
  }
}

// Add/remove a link by POSTing to the gate's /bot/links (same URL + ?key= as
// LINKS_URL). The gate writes it to KV, read live — so no redeploy, no VPS.
async function writeLink(op, payload) {
  if (!/\/bot\/links/.test(LINKS_URL))
    return { ok: false, error: "LINKS_URL isn't the gate /bot/links endpoint — can't write" };
  try {
    const r = await fetch(LINKS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, ...payload }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: d.error || `HTTP ${r.status}` };
    return { ok: true, ...d };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- Auto-announce new links ----------------------------------------------
// New links in the list get posted to LINKS_CHANNEL_ID with their filter coverage
// (stored per-link as `filters` in LINKS_JSON) and an @mention of each matching
// "Filter: <name>" role, so members only get pinged for links that work on their
// school's filter.
let filterRoleMap = new Map(); // lowercased filter name -> role id
let announced = null; // Set of already-announced link URLs (null until loaded)

async function buildFilterRoleMap() {
  filterRoleMap = new Map();
  if (!GUILD_ID) return;
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const roles = await guild.roles.fetch();
    for (const role of roles.values()) {
      const m = role.name.match(/^Filter:\s*(.+)$/i);
      if (m) filterRoleMap.set(m[1].trim().toLowerCase(), role.id);
    }
    console.log(`[announce] ${filterRoleMap.size} "Filter:" role(s) found`);
  } catch (e) {
    console.error("[announce] couldn't fetch roles:", e.message);
  }
}

async function loadAnnounced() {
  try {
    return new Set(JSON.parse(await readFile(ANNOUNCED_FILE, "utf8")));
  } catch {
    return null; // missing/unreadable → treat as first run
  }
}
async function saveAnnounced() {
  try {
    await writeFile(ANNOUNCED_FILE, JSON.stringify([...announced]));
  } catch (e) {
    console.error("[announce] couldn't save state:", e.message);
  }
}

function announcement(link) {
  const filters = Array.isArray(link.filters) ? link.filters : [];
  const roleIds = [];
  for (const f of filters) {
    const id = filterRoleMap.get(String(f).trim().toLowerCase());
    if (id) roleIds.push(id);
  }
  const lines = ["🔓 **New link added!**", "```", link.url, "```"];
  if (filters.length) lines.push(`Unblocked on: **${filters.join(", ")}**`);
  else lines.push("_Run `/check all` on it in the filter-check channel to see what it clears._");
  if (roleIds.length) lines.push(roleIds.map((id) => `<@&${id}>`).join(" "));
  return { content: lines.join("\n"), allowedMentions: { roles: roleIds } };
}

async function announceNewLinks() {
  if (!LINKS_CHANNEL_ID) return;
  const links = await fetchMirrors();
  if (!links.length) return;
  if (announced === null) {
    const loaded = await loadAnnounced();
    if (loaded === null) {
      // First run: adopt the current list silently so we don't spam-announce every
      // existing link — only links added from here on get announced.
      announced = new Set(links.map((l) => l.url));
      await saveAnnounced();
      console.log(`[announce] seeded ${announced.size} existing links (none announced on first run)`);
      return;
    }
    announced = loaded;
  }
  const fresh = links.filter((l) => l.url && !announced.has(l.url));
  if (!fresh.length) return;
  const ch = await client.channels.fetch(LINKS_CHANNEL_ID).catch(() => null);
  if (!ch || !ch.isTextBased?.()) {
    return console.error("[announce] channel missing/not text — check LINKS_CHANNEL_ID + bot access");
  }
  for (const link of fresh) {
    const ok = await ch
      .send(announcement(link))
      .then(() => true)
      .catch((e) => (console.error("[announce] post failed:", e.message), false));
    if (ok) announced.add(link.url);
  }
  await saveAnnounced();
  console.log(`[announce] announced ${fresh.length} new link(s)`);
}

// Reachable = the server answers with ANY HTTP response (incl. the 401 gate).
async function ping(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    await fetch(url, { redirect: "manual", signal: ctrl.signal });
    clearTimeout(t);
    return true;
  } catch {
    clearTimeout(t);
    return false;
  }
}

// ---------------------------------------------------------------- BYOD utils ---

function normalizeDomain(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "")
    .replace(/\s+/g, "");
}

function isValidDomain(d) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(d)) return false; // not a bare IP
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d);
}

function memberHasRole(member, roleId) {
  const roles = member?.roles;
  if (!roles) return false;
  if (roles.cache) return roles.cache.has(roleId);
  if (Array.isArray(roles)) return roles.includes(roleId);
  return false;
}

async function readAllowlist() {
  try {
    const txt = await readFile(DOMAINS_FILE, "utf8");
    return txt
      .split("\n")
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

async function appendDomain(domain) {
  let prefix = "";
  try {
    const txt = await readFile(DOMAINS_FILE, "utf8");
    if (txt.length && !txt.endsWith("\n")) prefix = "\n";
  } catch {
    /* file may not exist yet */
  }
  await appendFile(DOMAINS_FILE, prefix + domain + "\n");
}

// simple in-memory per-user rate limiter (resets on restart; that's fine)
const rl = new Map(); // userId -> [timestamps ms]
function rateCheck(userId) {
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const hits = (rl.get(userId) || []).filter((t) => now - t < day);
  rl.set(userId, hits);
  if (hits.length >= MAX_PER_DAY) {
    return { ok: false, retryHrs: Math.max(1, Math.ceil((day - (now - hits[0])) / 3600000)) };
  }
  return { ok: true };
}
function rateRecord(userId) {
  const hits = rl.get(userId) || [];
  hits.push(Date.now());
  rl.set(userId, hits);
}

async function handleByodAdd(i) {
  if (!i.inGuild()) {
    return i.reply({ content: "Run this in the server, not a DM.", flags: MessageFlags.Ephemeral });
  }
  if (MEMBER_ROLE_ID && !memberHasRole(i.member, MEMBER_ROLE_ID)) {
    return i.reply({
      content: "🔒 You need to be a **verified member** to add a domain. Verify in the server first, then try again.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const raw = i.options.getString("domain") || "";
  const share = i.options.getBoolean("share") || false;
  const domain = normalizeDomain(raw);

  if (!isValidDomain(domain)) {
    return i.reply({
      content: `❌ \`${raw}\` doesn't look like a valid domain. Example: \`unblock.example.com\``,
      flags: MessageFlags.Ephemeral,
    });
  }

  const rate = rateCheck(i.user.id);
  if (!rate.ok) {
    return i.reply({
      content: `⏳ You've hit the limit of **${MAX_PER_DAY} domains/day**. Try again in ~${rate.retryHrs}h, or ask staff in the BYOD channel.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const allow = await readAllowlist();
  if (allow.includes(domain)) {
    return i.editReply(`✅ \`${domain}\` is already set up — just open it and log in as usual.`);
  }

  let ips = [];
  try {
    ips = await resolve4(domain);
  } catch {
    ips = [];
  }
  if (!ips.length) {
    return i.editReply(
      `❌ \`${domain}\` doesn't resolve yet. Point it at Halcyon, wait a few minutes, then run this again:\n` +
        `• Subdomain → **CNAME** → \`${CNAME_TARGET}\`\n` +
        (SERVER_IP ? `• Root/apex domain → **A record** → \`${SERVER_IP}\`` : "")
    );
  }
  if (SERVER_IP && !ips.includes(SERVER_IP)) {
    return i.editReply(
      `❌ \`${domain}\` points to \`${ips.join(", ")}\`, not Halcyon (\`${SERVER_IP}\`). Fix the DNS record and try again:\n` +
        `• Subdomain → **CNAME** → \`${CNAME_TARGET}\`\n` +
        `• Root/apex domain → **A record** → \`${SERVER_IP}\``
    );
  }

  rateRecord(i.user.id);
  try {
    await appendDomain(domain);
  } catch (e) {
    console.error("[byod] append failed:", e);
    return i.editReply("⚠️ Couldn't save the domain right now — please ping staff in the BYOD channel.");
  }
  console.log(`[byod] ${i.user.tag} (${i.user.id}) added ${domain}`);

  let msg =
    `✅ **\`${domain}\`** is now a working Halcyon mirror!\n` +
    `Give it ~30 seconds for the HTTPS certificate, then open it and log in like normal. 🌿`;

  if (share && COMMUNITY_CH) {
    try {
      const ch = await i.client.channels.fetch(COMMUNITY_CH);
      await ch.send(`🌐 New community mirror added by <@${i.user.id}> — <https://${domain}>`);
      msg += `\nAlso shared it in <#${COMMUNITY_CH}>.`;
    } catch (e) {
      console.error("[byod] share post failed:", e);
    }
  }
  return i.editReply(msg);
}

// -------------------------------------------------------- link checker + status ---

function isPrivateIp(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true; // unparseable = treat as unsafe
  return (
    p[0] === 0 || p[0] === 10 || p[0] === 127 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 192 && p[1] === 168) ||
    p[0] >= 224 // multicast / reserved
  );
}

// Guard so the checker can't be used to probe internal / cloud-metadata addresses.
async function resolvesToPrivate(host) {
  const literal = /^\d+\.\d+\.\d+\.\d+$/.test(host);
  const ips = literal ? [host] : await resolve4(host).catch(() => []);
  return ips.length > 0 && ips.some(isPrivateIp);
}

// Combined: is this one of OUR mirrors (uptime), or does an arbitrary site work?
async function checkLink(raw) {
  const t = String(raw || "").trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) && !/^https?:\/\//i.test(t)) {
    return "❌ I can only check http/https links.";
  }
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(t) ? t : "https://" + t);
  } catch {
    return "❌ That doesn't look like a valid link. Try something like `https://example.com`.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "❌ I can only check http/https links.";
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") ||
    (await resolvesToPrivate(host))
  ) {
    return "❌ I can't check internal or private addresses.";
  }

  const mirrors = await fetchMirrors();
  const mirrorHosts = new Set(
    mirrors.map((m) => { try { return new URL(m.url).hostname.toLowerCase(); } catch { return ""; } })
  );

  // (a) One of our mirrors → real health (serving the Halcyon page, not just
  // answering with some error/parked/block page).
  if (mirrorHosts.has(host)) {
    const r = await probe("https://" + host + "/");
    if (r.state === UP) {
      return `🟢 **${host}** is an official Halcyon mirror and it's **up** — open it and log in as usual.`;
    }
    if (r.state === DEGRADED) {
      return `🟠 **${host}** is an official Halcyon mirror but it's **having trouble** right now (${r.reason}). Try another from **/links**.`;
    }
    return `🔴 **${host}** is an official Halcyon mirror but it's **not responding right now**. Try another from **/links**.`;
  }

  // (b) Any other site → reachability + known-incompatibility hint.
  const reachable = await ping(url.href);
  if (!reachable) {
    return `🔴 **${host}** looks **down or unreachable** right now — Halcyon can only open sites that are actually online.`;
  }
  const broken = KNOWN_BROKEN.find((b) => b.rx.test(host));
  if (broken) {
    return `⚠️ **${host}** is online, but it's **known to have issues** through Halcyon — ${broken.note}. You can try it, but it may not fully work.`;
  }
  return `✅ **${host}** is online and should **work through Halcyon**. Open a mirror from **/links**, log in, and paste the link into the address bar.`;
}

function buildCheckModal() {
  return new ModalBuilder()
    .setCustomId("halcyon_check_modal")
    .setTitle("Check a link")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("url")
          .setLabel("Paste a link (a Halcyon mirror or any site)")
          .setPlaceholder("https://example.com")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(300)
      )
    );
}

async function handleCheckSubmit(i) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await checkLink(i.fields.getTextInputValue("url"));
  await i.editReply(result);
}

// The auto-updating #status board, with the Check-a-link button.
let statusMessage = null;
const monitor = new StatusMonitor({ confirmThreshold: STATUS_CONFIRM });

function hostLabel(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

// One probe sweep of everything we watch — each mirror gets the deep Halcyon
// health check; the login gate gets a plain reachability ping (it's not a
// Halcyon app, so there's no page signature to match). We hit the network once
// per cycle and hand the same results to both the board and the alerter.
async function probeAll() {
  const mirrors = await fetchMirrors();
  const results = await Promise.all(mirrors.map((m) => probe(m.url)));
  let gate = null;
  if (GATE_URL) {
    const up = await ping(GATE_URL);
    gate = { url: GATE_URL, state: up ? UP : DOWN, reason: up ? "ok" : "unreachable", gate: true };
  }
  return { results, gate };
}

// Public board content — an honest summary. A mirror counts as healthy only if
// it's actually serving the Halcyon page; per-host detail is kept for the ops
// channel rather than shown to everyone.
function statusPayload({ results, gate }) {
  const total = results.length;
  const up = results.filter((r) => r.state === UP).length;
  const gateBad = gate && gate.state !== UP;

  const header =
    total === 0
      ? "⚪ **No mirrors configured**"
      : up === total && !gateBad
      ? "🟢 **All systems operational**"
      : up === 0
      ? "🔴 **All mirrors are having trouble**" + (gateBad ? " · login gate issue" : "")
      : `🟠 **${up}/${total} mirrors healthy**` + (gateBad ? " · login gate issue" : "");

  const content =
    "## 🌿 Halcyon — Status\n" +
    `${header} · updated <t:${Math.floor(Date.now() / 1000)}:R>\n\n` +
    "Not sure if a link works? Click **Check a link** and paste it — I'll tell you if it's a live Halcyon " +
    "mirror, or whether a site works through Halcyon. Only you see the result.";

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("halcyon_check").setEmoji("🔎").setLabel("Check a link").setStyle(ButtonStyle.Primary)
  );
  return { content, components: [row] };
}

async function ensureStatusMessage(payload) {
  if (!STATUS_CHANNEL_ID) return;
  const ch = await client.channels.fetch(STATUS_CHANNEL_ID).catch(() => null);
  if (!ch || !ch.isTextBased?.()) {
    return console.error("[status] channel missing or not text — check STATUS_CHANNEL_ID + bot access");
  }
  if (!payload) payload = statusPayload(await probeAll());
  try {
    const recent = await ch.messages.fetch({ limit: 25 });
    statusMessage = recent.find((m) => m.author.id === client.user.id && m.components?.length) || null;
  } catch { /* no read history — just post a fresh one */ }
  if (statusMessage) {
    await statusMessage.edit(payload).catch(async () => { statusMessage = await ch.send(payload); });
  } else {
    statusMessage = await ch.send(payload).catch((e) => { console.error("[status] post failed:", e.message); return null; });
  }
  if (statusMessage) console.log(`[status] board live in #${ch.name}`);
}

// Fire a line in the ops channel for each CONFIRMED health change. Outages
// (down/degraded) optionally @mention the alert role; recoveries never ping.
async function postAlerts(transitions) {
  if (!STATUS_ALERT_CHANNEL_ID || !transitions.length) return;
  const ch = await client.channels.fetch(STATUS_ALERT_CHANNEL_ID).catch(() => null);
  if (!ch || !ch.isTextBased?.()) {
    return console.error("[status] alert channel missing/not text — check STATUS_ALERT_CHANNEL_ID + bot access");
  }
  for (const t of transitions) {
    const label = t.result.gate ? "login gate" : hostLabel(t.key);
    const line = formatAlert(t, { label, roleId: STATUS_ALERT_ROLE_ID });
    await ch.send(line).catch((e) => console.error("[status] alert send failed:", e.message));
  }
}

// One full cycle: probe everything, refresh the board, then detect + alert on
// confirmed state changes.
async function pollCycle() {
  if (!STATUS_CHANNEL_ID) return;
  const snap = await probeAll();
  const payload = statusPayload(snap);
  if (!statusMessage) await ensureStatusMessage(payload);
  else await statusMessage.edit(payload).catch(async () => { statusMessage = null; await ensureStatusMessage(payload); });

  const all = [...snap.results, ...(snap.gate ? [snap.gate] : [])];
  const transitions = monitor.update(all);
  if (transitions.length) {
    console.log("[status] " + transitions.map((t) => `${hostLabel(t.key)} ${t.from}→${t.to}`).join(", "));
    await postAlerts(transitions);
  }
}

// ------------------------------------------------------------------ commands ---

const commands = [
  new SlashCommandBuilder()
    .setName("links")
    .setDescription("Get the current working Halcyon links + passphrase"),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Check which Halcyon links are reachable right now"),
  new SlashCommandBuilder()
    .setName("byod")
    .setDescription("Bring your own domain — turn a domain you own into a Halcyon mirror")
    .addSubcommand((sc) =>
      sc
        .setName("add")
        .setDescription("Add a domain you've already pointed at Halcyon")
        .addStringOption((o) =>
          o.setName("domain").setDescription("e.g. unblock.example.com").setRequired(true)
        )
        .addBooleanOption((o) =>
          o.setName("share").setDescription("Also list it in community-links for everyone?").setRequired(false)
        )
    ),
  new SlashCommandBuilder()
    .setName("addlink")
    .setDescription("Add a Halcyon link to the list (staff)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o.setName("url").setDescription("Full link, e.g. https://storage.googleapis.com/mybucket/index.html").setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("filters")
        .setDescription("Filters it beats, comma-separated, e.g. GoGuardian, Linewize")
        .setRequired(false)
    )
    .addStringOption((o) =>
      o.setName("host").setDescription("Override the host shown (auto-detected from the URL if blank)").setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("removelink")
    .setDescription("Remove a Halcyon link from the list (staff)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o.setName("url").setDescription("The link's URL or host to remove").setRequired(true)
    ),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log(
    `Registered ${commands.length} commands ${GUILD_ID ? "to guild " + GUILD_ID : "globally (may take ~1h)"}.`
  );
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
  console.log(`Halcyon bot online as ${client.user.tag}`);
  console.log(
    `BYOD: ${MEMBER_ROLE_ID ? "verified-member-gated" : "any member"}, ` +
      `server IP ${SERVER_IP || "(unknown)"}, ${MAX_PER_DAY}/user/day → ${DOMAINS_FILE}`
  );
  if (STATUS_CHANNEL_ID) {
    await pollCycle().catch((e) => console.error("[status] first poll failed:", e.message));
    setInterval(() => pollCycle().catch(() => {}), Math.max(1, STATUS_INTERVAL_MIN) * 60000);
    console.log(
      `[status] polling every ${STATUS_INTERVAL_MIN}m, confirm=${STATUS_CONFIRM}, ` +
        (STATUS_ALERT_CHANNEL_ID ? `alerts → channel ${STATUS_ALERT_CHANNEL_ID}` : "alerts off (set STATUS_ALERT_CHANNEL_ID)")
    );
  } else {
    console.log("[status] STATUS_CHANNEL_ID not set — status board + checker disabled");
  }

  if (LINKS_CHANNEL_ID) {
    await buildFilterRoleMap();
    await announceNewLinks().catch((e) => console.error("[announce] first run failed:", e.message));
    setInterval(() => announceNewLinks().catch(() => {}), Math.max(1, STATUS_INTERVAL_MIN) * 60000);
    console.log(`[announce] watching for new links → channel ${LINKS_CHANNEL_ID}`);
  } else {
    console.log("[announce] LINKS_CHANNEL_ID not set — new-link auto-announce disabled");
  }
});

client.on("interactionCreate", async (i) => {
  try {
    if (i.isButton() && i.customId === "halcyon_check") {
      return i.showModal(buildCheckModal());
    }
    if (i.isModalSubmit() && i.customId === "halcyon_check_modal") {
      return handleCheckSubmit(i);
    }
    if (!i.isChatInputCommand()) return;

    if (i.commandName === "links") {
      const mirrors = await fetchMirrors();
      const list = mirrors.length
        ? mirrors.map((m) => `• ${m.url}`).join("\n")
        : "_No links available right now — check back soon._";
      const embed = new EmbedBuilder()
        .setColor(BRAND)
        .setTitle("🌿 Halcyon — working links")
        .setDescription(list)
        .setFooter({
          text: "Blocked at school? Try another — this list is always current.",
        });
      if (PASSPHRASE)
        embed.addFields({ name: "Passphrase", value: "`" + PASSPHRASE + "`" });
      await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } else if (i.commandName === "status") {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const mirrors = await fetchMirrors();
      const results = await Promise.all(mirrors.map((m) => probe(m.url)));
      const rows = results.map((r) => {
        const emoji = STATE_EMOJI[r.state] || "⚪";
        const detail =
          r.state === UP ? ` _(${r.ms}ms)_` : ` — ${r.reason}${r.status ? ` (HTTP ${r.status})` : ""}`;
        return `${emoji} ${hostLabel(r.url)}${detail}`;
      });
      const up = results.filter((r) => r.state === UP).length;
      const embed = new EmbedBuilder()
        .setColor(BRAND)
        .setTitle(`Halcyon — link status (${up}/${results.length} healthy)`)
        .setDescription(rows.join("\n") || "_No links configured._");
      await i.editReply({ embeds: [embed] });
    } else if (i.commandName === "byod") {
      if (i.options.getSubcommand() === "add") await handleByodAdd(i);
    } else if (i.commandName === "addlink") {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const url = i.options.getString("url").trim();
      if (!/^https?:\/\//i.test(url))
        return i.editReply("❌ That doesn't look like a URL — it must start with `https://`.");
      const host = (i.options.getString("host") || "").trim();
      const filters = (i.options.getString("filters") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const link = { url };
      if (host) link.host = host;
      if (filters.length) link.filters = filters;
      const res = await writeLink("add", { link });
      if (!res.ok) return i.editReply(`❌ Couldn't add it: ${res.error}`);
      await i.editReply(
        `✅ Added **${res.link.url}**` +
          (res.link.filters?.length ? `\nBeats: **${res.link.filters.join(", ")}**` : "") +
          `\n_${res.count} link(s) total. It's live now; auto-announce will post it to <#${LINKS_CHANNEL_ID || "the links channel"}> shortly._`
      );
      // post it to #which-link right away instead of waiting for the next sweep
      if (LINKS_CHANNEL_ID) announceNewLinks().catch(() => {});
    } else if (i.commandName === "removelink") {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const url = i.options.getString("url").trim();
      const res = await writeLink("remove", { url });
      if (!res.ok) return i.editReply(`❌ Couldn't remove it: ${res.error}`);
      await i.editReply(
        res.removed
          ? `🗑️ Removed **${url}** (${res.count} link(s) left).`
          : `⚠️ No link matched **${url}** — nothing removed.`
      );
    }
  } catch (err) {
    console.error("interaction error:", err);
    const msg = { content: "Something went wrong — try again.", flags: MessageFlags.Ephemeral };
    if (i.deferred || i.replied) i.editReply(msg).catch(() => {});
    else i.reply(msg).catch(() => {});
  }
});

await detectServerIp();
await registerCommands();
await client.login(TOKEN);
