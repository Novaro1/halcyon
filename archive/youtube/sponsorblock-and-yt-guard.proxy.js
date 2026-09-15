// Extracted from public/proxy.js — SponsorBlock + in-page YouTube ad guard.
// See ../README.md for why this was archived and how to reintegrate.

  // ---- SponsorBlock: skip creator-inserted sponsor segments -----------------
  // Reimplements the core of sponsor.ajay.app: fetch community-submitted segment
  // timestamps for the current video and jump the player past them. This is NOT
  // YouTube's ads — it's the in-video "this video is sponsored by…" spots.
  const SB_CATEGORIES = [
    "sponsor", "selfpromo", "interaction", "intro", "outro", "preview", "music_offtopic",
  ];
  const sbEnabled = () => localStorage.getItem("halcyon:sponsorblock") !== "0";
  let sbVideoId = null;
  let sbSegments = [];

  function videoIdFromUrl(href) {
    try {
      const u = new URL(href);
      if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
      return u.searchParams.get("v");
    } catch {
      return null;
    }
  }

  async function sbSync(href) {
    if (!sbEnabled()) return;
    const id = videoIdFromUrl(href);
    if (id === sbVideoId) return; // same video (or still not a watch page)
    sbVideoId = id;
    sbSegments = [];
    if (!id) return;
    try {
      // Privacy-preserving lookup: send only the first 4 chars of the videoID's
      // SHA-256, then filter the returned set locally (SponsorBlock never learns
      // exactly which video you're watching).
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(id)
      );
      const hex = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const cats = encodeURIComponent(JSON.stringify(SB_CATEGORIES));
      const res = await fetch(
        `https://sponsor.ajay.app/api/skipSegments/${hex.slice(0, 4)}?categories=${cats}`
      );
      if (!res.ok) return;
      const data = await res.json();
      if (id !== sbVideoId) return; // navigated away while fetching
      const match = data.find((v) => v.videoID === id);
      sbSegments = match
        ? match.segments.map((s) => ({ start: s.segment[0], end: s.segment[1], cat: s.category }))
        : [];
      if (sbSegments.length)
        console.log(`[halcyon] SponsorBlock: ${sbSegments.length} segment(s) loaded for ${id}`);
    } catch {
      /* offline / API down — no segments, no harm */
    }
  }

  // In-page YouTube guard: the SW already strips ads from the player API, and
  // this is the safety net — auto-skips any ad that still plays, removes ad DOM,
  // and applies SponsorBlock skips. Runs in the proxied YouTube window.
  const ytGuarded = new WeakSet();
  function startYouTubeGuard(win) {
    if (ytGuarded.has(win)) return;
    ytGuarded.add(win);
    console.log("[halcyon] YouTube ad guard active");
    const enabled = () => localStorage.getItem("halcyon:adblock") !== "0";
    const AD_SELECTORS = [
      ".ytp-ad-overlay-slot", ".ytp-ad-message-container", "#player-ads",
      "#masthead-ad", "ytd-ad-slot-renderer", "ytd-in-feed-ad-layout-renderer",
      ".ytd-companion-slot-renderer", "ytd-banner-promo-renderer",
      "ytd-statement-banner-renderer", "#panels ytd-ads-engagement-panel-content-renderer",
    ];
    let adLogged = false;
    const tick = () => {
      const doc = win.document;
      const video = doc.querySelector("video");
      // Each concern gets its own try so a failure in one never starves another.
      if (enabled()) {
        try {
          // Skippable ad → click skip.
          doc
            .querySelectorAll(
              ".ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-container button"
            )
            .forEach((b) => b.click());
          // Unskippable ad playing → fast-forward past it (only while the player
          // is genuinely in the ad state, to avoid touching the real video).
          const player = doc.querySelector(".html5-video-player");
          if (player && player.classList.contains("ad-showing") && video && isFinite(video.duration) && video.duration > 0) {
            if (!adLogged) { console.log("[halcyon] YouTube ad detected — skipping"); adLogged = true; }
            video.currentTime = video.duration;
            video.muted = true;
          } else {
            adLogged = false;
          }
        } catch {}
        try {
          doc.querySelectorAll(".ytp-ad-overlay-close-button").forEach((b) => b.click());
          AD_SELECTORS.forEach((sel) => doc.querySelectorAll(sel).forEach((e) => e.remove()));
        } catch {}
      }
      // SponsorBlock: jump past any community-marked segment we're inside.
      // Only seek once the element can actually honor it (readyState >= 2 =
      // HAVE_CURRENT_DATA) and isn't mid-seek — otherwise a seek fired during
      // the player's own startup gets silently reset back to 0.
      if (sbEnabled() && sbSegments.length && video && video.readyState >= 2 && !video.seeking) {
        try {
          const t = video.currentTime;
          for (const seg of sbSegments) {
            if (t >= seg.start && t < seg.end - 0.3) {
              video.currentTime = seg.end;
              console.log(`[halcyon] SponsorBlock: skipped ${seg.cat} (${Math.round(seg.start)}s→${Math.round(seg.end)}s)`);
              break;
            }
          }
        } catch {}
      }
    };
    win.setInterval(tick, 300);
  }

  // In emit():  sbSync(url); // refresh SponsorBlock segments when the video changes
  //
  // In UrlWatcher.install(), inside the init.post tap:
  //   const href = (ctx.client && ctx.client.url && ctx.client.url.href) || "";
  //   if (/^https?:\/\/([^/]+\.)?youtube\.com\//.test(href)) {
  //     startYouTubeGuard(ctx.window);
  //   }
