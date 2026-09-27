// Halcyon Discord bot — "links via Discord only" distribution + self-serve BYOD.
//
// Slash commands (all reply privately/ephemerally):
//   /links       → the current working domains + the access passphrase
//   /status      → live reachability check of each domain
//   /byod add    → a verified member turns a domain THEY own into a Halcyon mirror
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
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import { resolve4 } from "node:dns/promises";
import { readFile, appendFile } from "node:fs/promises";

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

client.once("ready", () => {
  console.log(`Halcyon bot online as ${client.user.tag}`);
  console.log(
    `BYOD: ${MEMBER_ROLE_ID ? "verified-member-gated" : "any member"}, ` +
      `server IP ${SERVER_IP || "(unknown)"}, ${MAX_PER_DAY}/user/day → ${DOMAINS_FILE}`
  );
});

client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;
  try {
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
      const rows = await Promise.all(
        mirrors.map(async (m) => `${(await ping(m.url)) ? "🟢" : "🔴"} ${m.url}`)
      );
      const embed = new EmbedBuilder()
        .setColor(BRAND)
        .setTitle("Halcyon — link status")
        .setDescription(rows.join("\n") || "_No links configured._");
      await i.editReply({ embeds: [embed] });
    } else if (i.commandName === "byod") {
      if (i.options.getSubcommand() === "add") await handleByodAdd(i);
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
