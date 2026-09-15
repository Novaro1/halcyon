// Extracted from public/sw.js — YouTube player-API ad stripping.
// See ../README.md for why this was archived and how to reintegrate.

// ---- YouTube: strip ads from the player API response ----------------------
function isYouTubePlayer(u) {
  return (
    /(^|\.)youtube\.com$|(^|\.)youtubei\.googleapis\.com$/.test(u.hostname) &&
    (u.pathname.endsWith("/youtubei/v1/player") ||
      u.pathname.endsWith("/youtubei/v1/next") ||
      u.pathname.includes("/get_video_info"))
  );
}
function stripYouTubeAds(json) {
  // Removing these fields stops ads from ever being scheduled by the player.
  if (json.adPlacements) json.adPlacements = [];
  if (json.playerAds) json.playerAds = [];
  if (json.adSlots) json.adSlots = [];
  if (json.adBreakHeartbeatParams) delete json.adBreakHeartbeatParams;
  if (json.playerConfig && json.playerConfig.adConfig) delete json.playerConfig.adConfig;
  return json;
}
async function youtubeStripped(event) {
  const resp = await $scramjetController.route(event);
  try {
    const text = await resp.clone().text();
    const json = JSON.parse(text);
    const hadAds =
      (json.adPlacements && json.adPlacements.length) ||
      (json.playerAds && json.playerAds.length) ||
      (json.adSlots && json.adSlots.length);
    const cleaned = JSON.stringify(stripYouTubeAds(json));
    const headers = new Headers(resp.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    console.log("[halcyon] YouTube player response rewritten, hadAds=" + !!hadAds);
    return new Response(cleaned, {
      status: resp.status,
      statusText: resp.statusText,
      headers,
    });
  } catch (e) {
    // Response wasn't parseable JSON (e.g. still compressed) — leave it alone.
    console.warn("[halcyon] YouTube strip skipped: " + (e && e.message));
    return resp; // clone kept the original body intact
  }
}

// In the fetch handler, before the blocklist check:
//   if (isYouTubePlayer(real)) {
//     event.respondWith(youtubeStripped(event));
//     return;
//   }
