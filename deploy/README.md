# Deploying Halcyon as a public unblocker

The model: **one origin (one server/IP) + many domains pointing at it.** Filters
block by *domain*, so when one link gets blocked you hand out another domain on
the same box — no redeploy. Links are given out through your Discord.

This stack runs Halcyon behind **Caddy with on-demand TLS**, so adding a domain
is just a DNS record + one line in `domains.txt` — Caddy issues the certificate
automatically (and only for domains you've allowlisted, so it can't be abused).

## 1. A server with a public IP

Any cheap VPS works (1 shared vCPU / 512MB–1GB is plenty; pick a provider with
generous/unmetered egress — a proxy userbase moves a lot of bytes). Install
Docker + the compose plugin. Open ports **80** and **443**.

> Don't use your **home** connection for a public userbase: your home IP becomes
> the exit (abuse + DMCA land on you) and your upload speed caps every user.

## 2. Bring it up

```bash
git clone https://github.com/Novaro1/halcyon && cd halcyon/deploy
HALCYON_PASSWORD='a-long-shared-passphrase' docker compose up -d --build
```

That starts Halcyon (internal) + Caddy (ports 80/443). The passphrase gates the
whole thing so it's never an open proxy; all the abuse guardrails (web-ports
only, no UDP, SSRF denylist, rate limits) are on by default.

## 3. Point domains at it

1. Grab free subdomains from **[freedns.afraid.org](https://freedns.afraid.org)**
   (or any DNS host). For each, create an **A record → your server's public IP**.
   afraid.org is dynamic-DNS, so if your IP ever changes, its updater keeps the
   records current.
2. Add each domain (one per line) to **`../domains.txt`**. It's read live — no
   restart. The first HTTPS visit to a newly-added domain makes Caddy issue its
   cert on the spot.
3. Mirror the same list into **`../hub/links.json`** so the links hub shows them.

That's it — repeat step 3's "add a domain" whenever a link gets blocked. You
never touch the server, just DNS + two text files.

## Keeping the two lists in sync

`domains.txt` (what the origin will serve) and `hub/links.json` (what the hub
shows) should list the same domains. Regenerate the hub list from `domains.txt`:

```bash
node -e 'const fs=require("fs");const d=fs.readFileSync("domains.txt","utf8").split("\n").map(s=>s.trim()).filter(s=>s&&s[0]!=="#");const j=JSON.parse(fs.readFileSync("hub/links.json","utf8"));j.mirrors=d.map(h=>({name:"Halcyon",url:"https://"+h,host:h}));fs.writeFileSync("hub/links.json",JSON.stringify(j,null,2)+"\n")'
```

## Updating

```bash
cd halcyon && git pull && cd deploy && docker compose up -d --build
```

Issued certificates persist in the `caddy_data` volume across restarts.

## Notes

- **Serve any domain without the allowlist** (drops abuse protection): set
  `HALCYON_DOMAINS=*` in the compose `environment`.
- **HTTPS only** — service workers need a secure context, so hand out `https://`
  links. Caddy redirects `http` → `https` automatically.
- **Disposable mirrors:** treat every domain as replaceable and keep a few spare
  ones ready; that's the whole point of the model.
