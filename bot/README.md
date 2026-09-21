# Halcyon Discord bot

Hands out the current working links + passphrase to your Discord members — the
"links via Discord only" distribution. It reads the **same `links.json` the hub
uses**, so whenever you update your links the bot serves them automatically.

Commands (both reply **privately** to whoever runs them):

- **`/links`** — the current working domains + the access passphrase.
- **`/status`** — a live 🟢/🔴 reachability check of each domain.

The passphrase is a bot secret (`HALCYON_PASSPHRASE`), never in the public
`links.json` — so only people in your server who run `/links` ever see it.

## 1. Create the bot (Discord Developer Portal)

1. Go to **https://discord.com/developers/applications** → **New Application**,
   name it (e.g. "Halcyon").
2. Copy the **Application ID** (General Information page) → that's `DISCORD_CLIENT_ID`.
3. Left sidebar → **Bot** → **Reset Token** → copy it → that's `DISCORD_TOKEN`.
   (Keep this secret — anyone with it controls the bot.)
4. No privileged intents needed — leave them off.

## 2. Invite the bot to your server

Open this URL (replace `CLIENT_ID` with your Application ID):

```
https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot+applications.commands&permissions=2048
```

Pick your server, authorize. (`2048` = Send Messages; slash commands need nothing more.)

## 3. Get your server ID

In Discord: **User Settings → Advanced → Developer Mode ON**, then right-click your
server icon → **Copy Server ID** → that's `DISCORD_GUILD_ID` (setting it makes the
slash commands appear instantly instead of ~1h).

## 4. Run it

On any machine with Docker (the same VPS as the proxy is fine):

```bash
cd bot
cp .env.example .env      # then edit .env with your token, client id, server id, passphrase
docker compose up -d --build
```

Check the logs — you should see `Halcyon bot online as …` and
`Registered 2 commands`:

```bash
docker compose logs -f bot
```

Then type `/links` in your server. 🎉

## Updating links

Edit `hub/links.json`, push, and the bot picks up the new list automatically on
the next `/links` (no restart). Keep `hub/links.json` and the server's
`domains.txt` in sync.
