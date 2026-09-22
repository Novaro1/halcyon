# Halcyon links gate

A tiny Cloudflare Worker that makes the links page **members-only**: a visitor has
to log in with Discord and be a **verified member** of the Halcyon server before
any links are shown. The links live in the Worker (not in a public file), so there
is nothing to bypass by opening a URL directly.

```
Landing (Log in with Discord)  →  Discord approves  →  /callback (holds the secret)
   →  "is this user in our guild AND do they have the Member role?"
        yes → signed 7-day cookie → links page
        no  → "join / verify first" + invite
```

The Discord **bot** reads the same links through a private endpoint (`/bot/links`),
so `/links` distribution and the web page stay in sync.

---

## One-time setup

You'll need the [`wrangler`](https://developers.cloudflare.com/workers/wrangler/)
CLI and a (free) Cloudflare account.

```bash
cd gate
npm install
npx wrangler login          # opens the browser, authorizes your Cloudflare account
```

### 1. Discord app: get the secret + add the redirect URL

1. <https://discord.com/developers/applications> → your **Halcyon** app → **OAuth2**.
2. **Reset Secret** → copy it (this is `DISCORD_CLIENT_SECRET`).
3. Under **Redirects**, add — you'll know the exact host after the first deploy, so
   deploy once (step 3), note the `…workers.dev` URL it prints, then come back and add:
   ```
   https://halcyon-gate.<your-subdomain>.workers.dev/callback
   ```
   Save. (If you later add a custom domain, add its `/callback` here too.)

### 2. Set the three secrets

```bash
npx wrangler secret put DISCORD_CLIENT_SECRET   # paste the Discord secret
npx wrangler secret put SESSION_SECRET          # paste any long random string
npx wrangler secret put BOT_LINKS_SECRET        # paste another long random string
```

Generate random strings with: `openssl rand -hex 32`

### 3. Deploy

```bash
npx wrangler deploy
```

It prints your Worker URL (e.g. `https://halcyon-gate.abc.workers.dev`). Do step 1.3
now if you haven't (add `<that URL>/callback` as a Discord redirect).

### 4. Require the verified Member role (recommended)

Until `MEMBER_ROLE_ID` is set, **any** server member gets in. Once your **Member**
role exists in Discord:

- Developer Mode on → Server Settings → Roles → right-click **Member** → **Copy Role ID**.
- Put it in `wrangler.toml` → `MEMBER_ROLE_ID = "…"`, then `npx wrangler deploy`.

### 5. Point the bot at the gate

The bot can't read the public file anymore. In `bot/.env` set:

```
LINKS_URL=https://halcyon-gate.<your-subdomain>.workers.dev/bot/links?key=<BOT_LINKS_SECRET>
```

…using the same `BOT_LINKS_SECRET` from step 2, then on the VPS:
`cd ~/halcyon/bot && docker compose up -d --build`.

### 6. Cut the public hub over to the gate

So the old public list stops working:

- `hub/links.json` → set `"mirrors": []` (leave `discord`). This empties the public file.
- `hub/index.html` → point the main button at the gate (`https://halcyon-gate.…workers.dev/`)
  instead of listing links. (Ask Claude to do this edit once you have the Worker URL.)
- Commit + push. Now the **only** ways to get links are the gated page and the bot's `/links`.

---

## Updating the links later

**Quick way (current):** edit `LINKS_JSON` in `wrangler.toml`, then `npx wrangler deploy`.

**No-redeploy way (optional KV):** follow the KV steps commented in `wrangler.toml`,
then update anytime with:
```bash
npx wrangler kv key put --binding=LINKS mirrors '[{"name":"Halcyon","url":"https://…","host":"afraid.org"}]'
```

Keep the gate's link list and the VPS `domains.txt` (TLS allowlist) in sync when you
add or drop a domain.

---

## How the membership check works

- Scopes: `identify guilds.members.read`.
- After login the Worker calls `GET /users/@me/guilds/{GUILD_ID}/member` with the
  user's token. A 404/403 means "not in the server". If `MEMBER_ROLE_ID` is set, the
  returned `roles` must include it.
- The session is a signed (HMAC-SHA256) cookie — no database. `SESSION_SECRET` signs
  it; rotating that secret logs everyone out.
- The Worker never stores messages or profile data and asks for no write scopes.

## Local dev

```bash
npx wrangler dev
```
For a full end-to-end test you need the real Discord secret + a redirect URL that
matches your dev URL; easiest is to just test against the deployed Worker.
