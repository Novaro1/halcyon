# Halcyon

A self-hosted web proxy in the style of [dogeub](https://github.com/xorynix/dogeub),
Velara, and StudyCare — built on **Scramjet** (the newest continuous build,
`2.0.67-alpha.2`) with the Scramjet **controller** (`0.0.14`), a **Wisp**
server, and the **libcurl** transport.

It lets you browse any site through your own server: the page is fetched by the
Wisp tunnel and rewritten client-side by Scramjet inside a service worker, so it
renders under your origin.

Source: [github.com/Novaro1/halcyon](https://github.com/Novaro1/halcyon).

## Features

- **Scramjet 2.x engine** — the current controller/frame architecture, not the
  old `ScramjetController` API. Verified against Wikipedia, DuckDuckGo, and more.
- **Homepage** with an omni search/URL bar and quick-launch shortcuts.
- **Apps grid** of common sites, one click to launch.
- **In-proxy toolbar** — back / forward / reload / address bar / open-in-new-tab / home.
- **Built-in ad, tracker & malware blocker** — a ~357k-domain DNS-style
  blocklist, unioned from
  [HaGeZi Multi PRO](https://github.com/hagezi/dns-blocklists) (ads, trackers,
  metrics, telemetry + phishing/malware),
  [FMHY's anti-scam list](https://github.com/fmhy/FMHYFilterlist) (fake/malicious
  site clones), [durablenapkin's scamblocklist](https://github.com/durablenapkin/scamblocklist)
  (scam/phishing), and [HaGeZi's Threat Intelligence Feeds](https://github.com/hagezi/dns-blocklists)
  (malware / phishing / scam / cryptojacking / C2 — the "Malwarebytes" layer; the
  browser-sized *mini* variant), enforced in the service worker: matched requests get a real
  `Response.error()` (a genuine network failure, the way uBlock behaves), so
  they're truly blocked, not faked. Comfortably passes adblock.turtlecute.org.
  Toggle + live counter in Settings; on by default. The list **self-updates**:
  the server refreshes its sources every 12h (cached, any hosts/ABP/wildcard/
  plain-domain list normalized to bare domains), serves the union at
  `/blocklist.txt`, and falls back to the bundled `public/blocklist.txt` snapshot
  if the fetch fails — so blocking never goes dark. `HALCYON_BLOCKLIST_URL`
  accepts a comma-separated list of sources (swap in a lighter HaGeZi tier or
  OISD if PRO ever over-blocks). A live-fetched **allowlist**
  ([anudeepND's whitelist](https://github.com/anudeepND/whitelist) by default,
  `HALCYON_ALLOWLIST_URL` to change) exempts known-good domains — CDNs, auth,
  push, app APIs that aggressive lists over-block (Tubi, Xbox, Twitch, Instagram
  Graph, …) — so an allowlisted host is never blocked even when the blocklist
  matches it, softening PRO's occasional false positives.
- **Block AI content farms** — a separate, opt-in blocker for AI "slop"
  content-farm sites ([alvi-se's list](https://github.com/alvi-se/ai-ublock-blacklist),
  ~2.5k domains, live-refreshed at `/ai-blocklist.txt`, its own bundled fallback).
  Kept apart from the objective ad/security blocklist because it's opinionated
  (blocks whole domains as "AI-generated," a few borderline-legit), with its own
  Settings toggle so you can flip it off when it hits a site you wanted. Enforced
  the same way (real `Response.error()`), still honors the allowlist, and its
  list is only fetched when the toggle is on. Override with
  `HALCYON_AIBLOCKLIST_URL`.
- **Discord upsell hiding** — Discord serves no third-party ads, so this is
  cosmetic: the server live-fetches [Disblock-Origin](https://codeberg.org/AllPurposeMat/Disblock-Origin)'s
  stylesheet (cached 6h, and only the server touches codeberg — not each viewer),
  serves it same-origin at `/discord-adblock.css`, and the runtime injects it into
  the proxied Discord window to hide Nitro/boost upsells, store/gift buttons and
  promo banners. Own toggle in Settings; on by default. Nothing is bundled — if
  the fetch fails it's a silent no-op.
- **Pop-up / pop-under blocker** — the shared core of AdGuard PopupBlocker,
  schomery/popup-blocker, PopupOff & co.: wraps `window.open` in every proxied
  frame (including ad subframes) and drops calls that aren't tied to a genuine
  click/keypress within the last second, killing pop-ups, pop-unders and
  tab-redirect ads. Popups you actually trigger (OAuth logins, "open in new tab")
  still work; blocked calls get a harmless stub window so page scripts don't
  crash. Own toggle in Settings; on by default.
- **Remove overlay** (à la [BehindTheOverlay](https://github.com/NicolaeNMV/BehindTheOverlay))
  — an eye button in the in-proxy toolbar that, on click, rips out the dark
  backdrop + modal trapping you on a page and restores scrolling. Manual on
  purpose (auto-removal would break legit dialogs); conservative heuristic only
  targets positioned, viewport-covering elements with an explicit `z-index` ≥ 1,
  so it spares content roots, sticky headers and small dialogs.
- **Clean tracking links** — strips tracking query params (`utm_*`, `fbclid`,
  `gclid`, `igshid`, …) off URLs you open, using DandelionSprout's
  [LegitimateURLShortener](https://github.com/DandelionSprout/adfilt) list. The
  server live-fetches + parses its global `$removeparam` rules (~1,000 plain
  params + ~120 regexes, cached 12h, refreshed) and serves them at
  `/removeparams.json`; the runtime cleans URLs at navigation time, so a link
  full of tracking cruft loads clean and shows clean in the address bar. Applied
  to navigations (not per-subresource, to avoid touching Scramjet's routing);
  domain-scoped rules are skipped. Own toggle in Settings; on by default.
  Override the source with `HALCYON_REMOVEPARAMS_URL`.
- **Settings** (all stored in `localStorage`):
  - Search engine (Google / DuckDuckGo / Bing / Brave)
  - Custom Wisp server (point at an external backend, or use this site's own)
  - Tab cloak (disguise the tab title + favicon)
  - about:blank cloak (relaunch inside an `about:blank` shell)
  - Panic key — double-tap `Esc` to jump to a safe URL
- **Zero build step.** The Scramjet runtime is served straight out of
  `node_modules`; there is nothing to bundle.

## Run

```bash
npm install
npm start          # → http://localhost:8090 (binds 127.0.0.1)
```

Environment:

- `PORT` / `HOST` — where it listens. **Defaults to `127.0.0.1`** (local only). Set
  `HOST=0.0.0.0` only if you intend to expose it — and set a passphrase first.
- `HALCYON_PASSWORD` — if set, the whole site *and* the Wisp tunnel require a
  passphrase (cookie-gated). Required before exposing Halcyon to anyone else, so
  it can't be abused as an open proxy.
- `HALCYON_DNS` — comma-separated plain-DNS resolver IPs the server uses to look
  up destination hosts (default `1.1.1.1,1.0.0.1`, Cloudflare). Point it at a
  filtering resolver — e.g. `94.140.14.14,94.140.15.15` (AdGuard DNS) or
  `9.9.9.9` (Quad9) — for DNS-level ad/malware blocking on top of the in-browser
  blocklist. Plain IPs only (not DoH/DoT URLs); note DNS-level blocks can't be
  un-blocked by the allowlist.
- `HALCYON_BLOCKLIST_URL` / `HALCYON_ALLOWLIST_URL` / `HALCYON_AIBLOCKLIST_URL` /
  `HALCYON_REMOVEPARAMS_URL` — swap the sources for the blocker, allowlist,
  AI-farm list, and URL-cleaner (see Features). `HALCYON_BLOCKLIST_URL` accepts a
  comma-separated list.

```bash
HALCYON_PASSWORD='something-long' HOST=0.0.0.0 npm start
```

## Security & privacy — what it does and doesn't protect

**What's protected:**

- **End-to-end encryption.** The libcurl transport runs the TLS stack *in your
  browser* and Wisp only carries the encrypted TCP stream. The Halcyon server
  relays bytes it can't read — it never sees the plaintext of HTTPS sites
  (passwords, cookies, page contents). There is **no "bare" server** here that
  would terminate TLS server-side.
- **Not an open relay (when gated).** With `HALCYON_PASSWORD` set, both the site
  and the Wisp endpoint reject unauthenticated requests.
- **No SSRF into the host's network.** Wisp is configured to refuse private and
  loopback destinations, so a proxied page can't make the server reach
  `localhost`/`192.168.x`/etc.
- **Local by default**, hardening headers (`Referrer-Policy: no-referrer`,
  `nosniff`, `X-Frame-Options`), and a **Wipe session data** button (Settings)
  that signs you out of every proxied site and clears cookies/cache/IndexedDB
  from the device.

**What it can't protect (be honest with yourself):**

- **The operator sees metadata.** Whoever runs the server can see *which*
  domains/IPs you connect to (DNS + destination host), just not the encrypted
  contents. If that's you on your own machine, fine. If it's someone else's
  server, trust them accordingly.
- **Scramjet is one browser origin, and is experimental.** Every proxied site
  runs under Halcyon's origin. Scramjet keeps a per-site cookie jar, but it is
  **not a hardened security sandbox** — a malicious site you open could, in
  principle, attack the runtime and reach another site's session in the same
  profile. So: only log into an account you'd be willing to expose to the
  *least* trustworthy site you open in the same session, and hit **Wipe** before
  switching contexts.
- **Don't run high-value accounts through it.** Treat it like a convenience
  proxy, not a vault. Banking / primary email are a bad idea through *any*
  web-based proxy, this one included.
- **Serve it over HTTPS in production.** Service workers require a secure
  context, and only HTTPS/`wss://` hides the connection metadata from your local
  network. Put it behind Caddy or a Cloudflare Tunnel for TLS — don't expose
  plain `http`.

## Known-incompatible sites

- **YouTube** — does not work, and the reasons are **upstream of Halcyon**, in the
  two WASM layers it builds on, so there's nothing to fix in this repo:
  - **Rendering:** Scramjet's `oxc` JS rewriter *panics* (`Unterminated string`)
    on some of YouTube's `eval`'d code, so that script is never rewritten and the
    kevlar app fails to hydrate (it either limps up to the logged-out empty state
    or hangs on a blank screen — non-deterministic per load). Tracked upstream at
    [MercuryWorkshop/scramjet#206](https://github.com/MercuryWorkshop/scramjet/issues/206).
  - **Playback:** even when the page renders, `libcurl.js`'s in-browser TLS stack
    can't complete the handshake to Google's video CDN
    (`googlevideo.com … error code 35: SSL connect error`), so video won't play.
  Wikipedia, DuckDuckGo and most normal sites are unaffected — this is specific to
  YouTube's minified-eval + googlevideo combination. The earlier SponsorBlock
  effort was archived (`archive/youtube/`) for the same underlying reasons.

## How it fits together

```
browser ──▶ service worker (sw.js)
                │  Scramjet controller routes + rewrites the request
                ▼
        Wisp WebSocket  (/wisp/)  ──▶  libcurl transport  ──▶  real site
```

- `server.js` — static host for `public/`, serves the Scramjet/controller/
  transport files under `/scram/*`, and terminates the Wisp upgrade at `/wisp/`.
- `public/sw.js` — hands every fetch to the Scramjet controller.
- `public/proxy.js` — boots the controller + transport and exposes `window.Halcyon`.
- `public/app.js` — the UI (home, apps, settings, proxy toolbar).

## Staying on the newest Scramjet

The runtime is pinned to the GitHub `latest` continuous-build tarballs in
`package.json`:

```
@mercuryworkshop/scramjet             → .../releases/download/latest/…scramjet-2.0.67-alpha.2.tgz
@mercuryworkshop/scramjet-controller  → .../releases/download/latest/…scramjet-controller-0.0.14.tgz
```

To pull a newer build later, re-point those two URLs at the newest tarballs on
the [Scramjet releases page](https://github.com/MercuryWorkshop/scramjet/releases)
and `npm install`. The controller and core must be from the **same** build — the
controller asserts a matching `$scramjet.versionInfo.version` at runtime.

## Contributing

Contributions are welcome — issues and pull requests both. By participating you
agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

- **Bugs / ideas:** open an [issue](https://github.com/Novaro1/halcyon/issues).
  For a site that renders wrong, include the site, what you saw, and the browser
  console output (that's usually where the real cause is). Note that some
  breakage is *upstream* — Scramjet's rewriter or the libcurl transport — rather
  than Halcyon itself; see **Known-incompatible sites** above.
- **Setup:** `npm install`, then `npm start` — there's **no build step**, so a
  change to anything in `public/` is live on the next reload (hard-reload, or use
  Settings → *Wipe session data*, to pick up a changed `public/sw.js`).
- **Pull requests:** keep them focused, match the surrounding style (plain ES
  modules, no framework, the existing comment density), and run `node --check` on
  any file you touch. If you add a runtime feature, say how you verified it —
  ideally a small Node harness or the exact in-proxy steps, since the service
  worker makes automated end-to-end testing awkward.
- **Blocklist changes:** only domain / hosts / `||domain^` lists are drop-in (the
  service worker is DNS-style, with no cosmetic-filter engine); uBlock/AdGuard
  `##`-selector rules can't be used.
- **License:** by contributing you agree your changes are released under the
  project's **AGPL-3.0** license (below).

## License

Halcyon is licensed under the **GNU Affero General Public License v3.0**
(AGPL-3.0) — see [`LICENSE`](LICENSE). This matches its core dependencies
([Scramjet](https://github.com/MercuryWorkshop/scramjet) and the libcurl
transport, both AGPL-3.0): the copyleft carries through, so if you run a modified
Halcyon as a network service you must make your source available to its users.

© Novaro1. Bundled third-party components (Scramjet, Wisp, the libcurl transport,
and the block/allow lists) remain under their own licenses and copyrights.
