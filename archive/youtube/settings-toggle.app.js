// Extracted from public/app.js — the SponsorBlock toggle wiring.
// Paste back into the settings init to reintegrate.

  // SponsorBlock toggle (client-side; read live by the YouTube guard)
  const sponsorblock = $("#set-sponsorblock");
  if (sponsorblock) {
    sponsorblock.checked = store.get("sponsorblock", "1") !== "0";
    sponsorblock.addEventListener("change", () =>
      store.set("sponsorblock", sponsorblock.checked ? "1" : "0")
    );
  }
