# Adding (or removing) a mirror domain

When a domain gets blocked at a school, you swap in a new one that points at the
**same server**. A new domain has to be registered in **three places**. Do them in
order; the whole thing takes a couple of minutes and needs no downtime.

Server IP: **40.160.144.225** · Gate: **halcyon-gate.clarity-hq.workers.dev**

---

## 1. Point the domain at the server (FreeDNS / afraid.org)

1. Grab a free subdomain at <https://freedns.afraid.org> — pick a **public,
   non-wildcarded** shared domain (a wildcarded one like `*.lang.hm` won't route
   to us). Look for plain educational/generic-looking domains.
2. Add an **A record**: the subdomain → **40.160.144.225**.
3. Wait for DNS to propagate (usually a few minutes). Test:
   ```bash
   dig +short <your-new-domain>          # should print 40.160.144.225
   ```

Caddy will issue a Let's Encrypt cert automatically the first time someone hits it
over HTTPS — **but only after step 2 below**, because the TLS allowlist gates it.

## 2. Allowlist it on the server (`domains.txt`)

This is the on-demand-TLS allowlist — Caddy refuses to issue a cert for a domain
that isn't in it (so the box can't be abused to mint certs for random hosts). It's
**live-reloaded within ~10s, no restart needed.**

```bash
ssh ubuntu@40.160.144.225
cd ~/halcyon
nano domains.txt          # add the new domain on its own line; delete any dead ones
```

Now open `https://<your-new-domain>` — you should get the Halcyon gate over a valid
cert. (Keep the repo copy in sync too: edit `domains.txt` locally + push when you
get a chance, so git matches the server.)

## 3. Add it to the links the gate hands out (`gate/wrangler.toml`)

This is what the **gated page** and the **Discord bot** both read. On your Mac:

```bash
cd ~/halcyon/gate
nano wrangler.toml
```

Edit the `LINKS_JSON` line — it's a JSON array; add an object (and drop dead ones):

```toml
LINKS_JSON = '[{"name":"Halcyon","url":"https://<your-new-domain>","host":"afraid.org"}]'
```

Deploy the change:

```bash
npx wrangler deploy
```

That's it — members who run `/links` in Discord or log in on the hub instantly see
the new domain. No hub redeploy needed (the public `hub/links.json` no longer holds
links; it only points at the gate).

---

## Removing a dead domain

Reverse of the above: delete its line from `domains.txt` on the server (step 2) and
remove it from `LINKS_JSON` + `npx wrangler deploy` (step 3). You can leave the
afraid.org record or delete it — once it's out of `domains.txt`, Caddy won't serve
it anyway.

## Quick reference

| Place | What it controls | How to update |
|-------|------------------|---------------|
| afraid.org A record | domain → server IP | freedns.afraid.org dashboard |
| `domains.txt` (on VPS) | TLS cert allowlist | `nano ~/halcyon/domains.txt` (live, ~10s) |
| `gate/wrangler.toml` `LINKS_JSON` | the links members actually get | edit + `npx wrangler deploy` |

> Optional: if you bind a KV namespace named `LINKS` (see `gate/README.md`), step 3
> becomes a one-liner with no redeploy:
> `npx wrangler kv key put --binding=LINKS mirrors '[…]'`.
