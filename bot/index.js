// Halcyon Discord bot — the "links via Discord only" distribution.
//
// Reads the SAME links.json the hub uses (so it's always current), and hands the
// working links + passphrase to members via slash commands:
//   /links   → the current working domains + the access passphrase (private reply)
//   /status  → live reachability check of each domain
//
// The passphrase is a BOT env var (HALCYON_PASSPHRASE), never in the public
// links.json — so only people in your server who run /links ever see it.
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID || ""; // set = instant command updates
const LINKS_URL =
  process.env.LINKS_URL || "https://novaro1.github.io/halcyon/links.json";
const PASSPHRASE = process.env.HALCYON_PASSPHRASE || "";
const BRAND = 0x1fd1a3;

if (!TOKEN || !CLIENT_ID) {
  console.error("Missing DISCORD_TOKEN and/or DISCORD_CLIENT_ID — see bot/README.md");
  process.exit(1);
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

const commands = [
  new SlashCommandBuilder()
    .setName("links")
    .setDescription("Get the current working Halcyon links + passphrase"),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Check which Halcyon links are reachable right now"),
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

client.once("ready", () => console.log(`Halcyon bot online as ${client.user.tag}`));

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
    }
  } catch (err) {
    console.error("interaction error:", err);
    const msg = { content: "Something went wrong — try again.", flags: MessageFlags.Ephemeral };
    if (i.deferred || i.replied) i.editReply(msg).catch(() => {});
    else i.reply(msg).catch(() => {});
  }
});

await registerCommands();
await client.login(TOKEN);
