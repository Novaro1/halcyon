# Halcyon links hub

A tiny standalone page that lists the current **mirror links** and live-checks
which are reachable from the visitor's network. This is the thing users bookmark
— individual proxy domains get blocked or killed, but the hub stays put and
always points at what's working.

## Files

- `links.json` — the single source of truth. Edit this to add/remove mirrors and
  set the Discord invite:
  ```json
  {
    "discord": "https://discord.gg/xxxxxxx",
    "note": "Bookmark this page — it always lists the current working links.",
    "mirrors": [
      { "name": "Halcyon", "url": "https://halcyon-proxy.fly.dev", "host": "fly.io" }
    ]
  }
  ```
- `index.html` — self-contained (inline CSS/JS, no build). Fetches `links.json`
  from the same folder and pings each mirror with a `no-cors` request: a mirror
  that answers (even the 401 gate) shows a **green dot**; one that times out or
  is blocked shows **red**. So the dots reflect reachability *from that visitor*
  — exactly what a blocked-at-school user needs.

## Where to host it

**Host the hub separately from the proxies**, on something cheap and hard to
kill — if it lived on a proxy domain it would get blocked along with it. Good
homes (any static host works, it's just two files):

- **GitHub Pages** — free, resilient, and it's already in this public repo.
- **Cloudflare Pages** — point it at this repo, output directory `hub`.
- **Netlify / any static host / an S3 bucket**, etc.

Give the hub its own memorable domain and put *that* on flyers/bios/Discord — not
a proxy URL, since proxy URLs rotate.

## Workflow

1. Deploy one or more mirrors: `HALCYON_PASSWORD='…' ./deploy/deploy-all.sh app1 app2`
   (see [`../deploy/deploy-all.sh`](../deploy/deploy-all.sh)).
2. Put the working URLs into `links.json`.
3. Push / redeploy the hub. Visitors always see the current, reachable links.
