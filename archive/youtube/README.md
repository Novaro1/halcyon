# YouTube ad-handling — archived (inert)

This folder holds the YouTube-specific code that was removed from Halcyon on
2026-09-13. It is **not served and not loaded** — it lives here only so the work
isn't lost if we ever revisit it.

## Why it was removed

All three pieces below worked *as written* — but produced no visible effect,
because YouTube playback through the Scramjet + libcurl proxy is unreliable:

- Media requests to `googlevideo.com/videoplayback` fail at the TLS layer
  (`libcurl … error code 35: SSL connect error`), so the video never streams as
  a stable, seekable timeline.
- Scramjet's cookie sync intermittently deadlocks
  (`timed out waiting for set cookie response (deadlock?)`).

SponsorBlock fetched segments and fired its skip correctly every time
(`SponsorBlock: skipped …` appeared in the console), but `video.currentTime = …`
can't move a playhead when the bytes at that position can't be fetched — the
seek snaps back. The ad-guard had the same underlying problem. The fault is the
proxy transport vs. Google's hardened CDN, not this code.

## What's here

- `sponsorblock-and-yt-guard.proxy.js` — the SponsorBlock lookup/skip and the
  in-page YouTube ad-guard that lived in `public/proxy.js`.
- `youtube-ad-strip.sw.js` — the `/youtubei/v1/player` ad-field stripping that
  lived in `public/sw.js`.
- `settings-toggle.html` — the "Skip sponsor segments" settings card from
  `public/index.html`.
- `settings-toggle.app.js` — the toggle wiring from `public/app.js`.

## How to reintegrate

1. In `public/proxy.js`: paste the SponsorBlock block back near the top of the
   IIFE, call `sbSync(url)` from `emit`, and call `startYouTubeGuard(ctx.window)`
   from `UrlWatcher.install` when the framed URL matches youtube.com (use
   `ctx.client.url.href`, NOT `ctx.window.location`).
2. In `public/sw.js`: paste the strip helpers back and add the
   `if (isYouTubePlayer(real)) { event.respondWith(youtubeStripped(event)); return; }`
   branch to the fetch handler, before the blocklist check.
3. Paste the settings card back into `public/index.html` and the toggle wiring
   back into `public/app.js`.

None of it will do anything useful until the `googlevideo` TLS failures and the
cookie deadlock in the transport layer are solved.

## Reference implementations (if we revisit)

Every one of these lives **at or above the SponsorBlock skip layer**, and our
blocker is **below** it (the transport can't fetch YouTube's media, so there's
no seekable video for any skipper to act on). They don't fix our problem — but
they're the best references if the transport ever gets sorted:

- **sb.js** — https://github.com/mchangrh/sb.js — the canonical *minimal*
  SponsorBlock (fetch segments + seek the `<video>`), from a SponsorBlock
  maintainer. Leaner than our archived version; **preferred base for a rewrite.**
- **Simple Sponsor Skipper** —
  https://greasyfork.org/en/scripts/453320-simple-sponsor-skipper — another
  client-side userscript, same fetch-and-seek approach.
- **SponsorBlock 3rd-party ports** —
  https://github.com/ajayyy/SponsorBlock/wiki/3rd-Party-Ports — directory of
  ports across platforms (mobile, TV, etc.). Discovery, not code.
- **sb.ltn.fi** — https://sb.ltn.fi — SponsorBlock browser/stats site; look up a
  video's segments in the DB. Handy for **finding test videos/timestamps.**
- **CastSponsorSkip** — https://github.com/gabe565/CastSponsorSkip — a Go daemon
  that skips sponsors on physical Chromecasts via the local Cast API. Different
  architecture (network-side control of a cast device); not applicable to an
  in-browser proxy, listed only for completeness.
