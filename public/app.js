// Halcyon UI controller.
(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  const store = {
    get: (k, d) => localStorage.getItem("halcyon:" + k) ?? d,
    set: (k, v) => localStorage.setItem("halcyon:" + k, v),
    del: (k) => localStorage.removeItem("halcyon:" + k),
  };

  // Tiny transient toast (inline-styled so it needs no CSS).
  let toastEl = null, toastT = 0;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.style.cssText =
        "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;" +
        "padding:10px 16px;border-radius:12px;font:600 13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
        "color:#0a1a14;background:linear-gradient(118deg,#1fd1a3,#ffd27a);box-shadow:0 10px 30px rgba(0,0,0,.4);" +
        "opacity:0;transition:opacity .18s ease;pointer-events:none";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.opacity = "1";
    clearTimeout(toastT);
    toastT = setTimeout(() => (toastEl.style.opacity = "0"), 1600);
  }

  // ---- Shortcuts data ----
  const SITES = [
    { name: "YouTube", url: "https://www.youtube.com", color: "#ff0033", label: "YT" },
    { name: "Discord", url: "https://discord.com/app", color: "#5865f2", label: "D" },
    { name: "Reddit", url: "https://www.reddit.com", color: "#ff4500", label: "R" },
    { name: "TikTok", url: "https://www.tiktok.com", color: "#111", label: "T" },
    { name: "Spotify", url: "https://open.spotify.com", color: "#1db954", label: "S" },
    { name: "Twitch", url: "https://www.twitch.tv", color: "#9146ff", label: "Tv" },
    { name: "GitHub", url: "https://github.com", color: "#24292e", label: "Gh" },
    { name: "Wikipedia", url: "https://en.wikipedia.org", color: "#636466", label: "W" },
    { name: "Google", url: "https://www.google.com", color: "#4285f4", label: "G" },
    { name: "Gmail", url: "https://mail.google.com", color: "#ea4335", label: "M" },
    { name: "Instagram", url: "https://www.instagram.com", color: "#e1306c", label: "Ig" },
    { name: "X", url: "https://x.com", color: "#000", label: "X" },
    { name: "Netflix", url: "https://www.netflix.com", color: "#e50914", label: "N" },
    { name: "Amazon", url: "https://www.amazon.com", color: "#ff9900", label: "A" },
    { name: "Pinterest", url: "https://www.pinterest.com", color: "#e60023", label: "P" },
    { name: "SoundCloud", url: "https://soundcloud.com", color: "#ff5500", label: "Sc" },
  ];
  const QUICK = ["YouTube", "Discord", "Reddit", "TikTok", "Spotify", "GitHub"];

  // ---- Navigation between views ----
  function show(view) {
    $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === view));
    $$(".nav-btn[data-nav]").forEach((b) =>
      b.classList.toggle("active", b.dataset.nav === view)
    );
  }
  $$("[data-nav]").forEach((el) =>
    el.addEventListener("click", () => show(el.dataset.nav))
  );

  // ---- Render shortcuts ----
  const tile = (s, cls) => {
    const el = document.createElement("button");
    el.className = cls;
    el.style.setProperty("--glow", s.color);
    el.innerHTML =
      cls === "ql"
        ? `<span class="ico" style="background:${s.color}">${s.label}</span>${s.name}`
        : `<span class="tile" style="background:${s.color}">${s.label}</span><span class="card-name">${s.name}</span>`;
    el.addEventListener("click", () => launch(s.url));
    // Warm the engine the moment the pointer lands on a tile, so the click
    // that follows navigates a hot runtime instead of cold-booting it.
    el.addEventListener("pointerenter", () => Halcyon.preboot().catch(() => {}), {
      once: true,
    });
    return el;
  };
  const qlWrap = $("#quicklinks");
  QUICK.forEach((n) => qlWrap.appendChild(tile(SITES.find((s) => s.name === n), "ql")));
  const grid = $("#apps-grid");
  SITES.forEach((s) => grid.appendChild(tile(s, "card")));

  // ---- Games (built in; served SAME-ORIGIN by the SW, which fetches the files
  // from public repos — not proxied, so they don't break). Two sources merged:
  //   s:"seraph" -> plays at g/games/<slug>/index.html (Seraph via jsDelivr)
  //   s:"gnmath" -> plays at gm/<file> (gn-math wrapper via raw.githubusercontent)
  // Thumbnail: g.cover (a gn-math cover id) -> cover/<id>.png; else a Seraph
  // screenshot; else the title tile (.no-thumb). ----
  const gamesGrid = $("#games-grid");
  const gamesFeatured = $("#games-featured");
  const gamesPopular = $("#games-popular");
  const featuredWrap = $("#featured-wrap");
  const popularWrap = $("#popular-wrap");
  const allHead = $("#all-head");
  const gamesEmpty = $("#games-empty");
  const gamePlay = $("#game-play");
  const gameFrame = $("#game-frame");

  // Curated shelves. FEATURED = the "full games" people sit down and sink time
  // into (sandbox / RPG / sim), shown as big hero cards (a cover is required so
  // they look good). POPULAR = the trending quick-play ports. Both are matched to
  // the catalog by normalized title at load, so a title that isn't present (or,
  // for featured, has no cover) is simply skipped.
  const FEATURED = ["Minecraft", "Terraria", "Stardew Valley", "Pokemon Emerald", "Geometry Dash",
    "Five Nights at Freddy's", "Cuphead", "Plants vs Zombies", "Super Mario 64", "Getting Over It"];
  const POPULAR = ["Slope", "Subway Surfers", "Moto X3M", "Crossy Road", "Bowmasters", "OvO", "1v1.LOL",
    "Temple Run 2", "Tunnel Rush", "Stickman Hook", "Jetpack Joyride", "Basket Random", "Run 3",
    "Snow Rider 3D", "Getaway Shootout", "Rooftop Snipers", "Magic Tiles 3", "Block Blast", "Sprunki",
    "Idle Breakout", "2048", "Supreme Duelist", "Basketball Stars", "Happy Wheels"];
  const gnorm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  let gamesLoaded = false;
  function gameTile(g, variant) {
    const b = document.createElement("button");
    b.className = "game-tile" + (variant ? " " + variant : "");
    b.dataset.title = (g.title || g.slug || "").toLowerCase();
    const thumb = document.createElement("figure");
    thumb.className = "thumb";
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "";
    if (g.cover != null) img.src = "cover/" + g.cover + ".png";          // gn-math pro cover
    else if (g.slug) img.src = "g/images/thumbnails/" + g.slug + ".jpg"; // Seraph screenshot
    else b.classList.add("no-thumb");
    img.onerror = () => b.classList.add("no-thumb");                     // missing/broken -> title tile
    const play = document.createElement("span");
    play.className = "play";
    play.textContent = "▶";
    const fb = document.createElement("span");                          // shown only when no-thumb
    fb.className = "fallback";
    fb.textContent = g.title || g.slug || "";
    thumb.append(img, play, fb);
    if (variant === "featured") {
      const ft = document.createElement("span");
      ft.className = "feat-title";
      ft.textContent = g.title || g.slug || "";
      thumb.append(ft);
      b.append(thumb);                                                  // title overlaid, no label row
    } else {
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = g.title || g.slug || "";
      b.append(thumb, label);
    }
    b.addEventListener("click", () => playGame(g));
    return b;
  }
  async function loadGames() {
    if (gamesLoaded || !gamesGrid) return;
    gamesLoaded = true;
    requestPersist();   // keep game saves from being evicted under storage pressure
    try {
      const res = await fetch("games.json", { cache: "force-cache" });
      const games = await res.json();
      // Build a normalized-title lookup for resolving the curated shelves.
      const byTitle = new Map();
      for (const g of games) { const k = gnorm(g.title || g.slug); if (k && !byTitle.has(k)) byTitle.set(k, g); }
      const resolve = (name) => {
        const k = gnorm(name);
        if (byTitle.has(k)) return byTitle.get(k);
        for (const [tk, g] of byTitle) if (tk.startsWith(k)) return g;  // e.g. "Geometry Dash Lite (REMAKE)"
        return null;
      };
      // Featured row (cover required) + popular row (de-duped against featured).
      const used = new Set();
      const featFrag = document.createDocumentFragment();
      for (const name of FEATURED) {
        const g = resolve(name);
        if (!g || g.cover == null) continue;
        used.add(g); featFrag.appendChild(gameTile(g, "featured"));
      }
      const popFrag = document.createDocumentFragment();
      for (const name of POPULAR) {
        const g = resolve(name);
        if (!g || used.has(g)) continue;
        used.add(g); popFrag.appendChild(gameTile(g, "pop"));
      }
      if (gamesFeatured && featFrag.childNodes.length) { gamesFeatured.appendChild(featFrag); featuredWrap.hidden = false; featuredWrap.dataset.has = "1"; }
      if (gamesPopular && popFrag.childNodes.length) { gamesPopular.appendChild(popFrag); popularWrap.hidden = false; popularWrap.dataset.has = "1"; }
      // Full library grid (everything — search filters this, so it must hold them all).
      const frag = document.createDocumentFragment();
      for (const g of games) frag.appendChild(gameTile(g));
      gamesGrid.appendChild(frag);
    } catch (e) {
      gamesGrid.textContent = "Couldn't load the game list — try again.";
    }
  }
  function playGame(g) {
    gameFrame.src = g.s === "gnmath"
      ? "gm/" + g.file                            // gn-math wrapper (same-origin; SW serves it)
      : "g/games/" + g.slug + "/index.html";      // Seraph game (same-origin; SW serves it)
    gamePlay.hidden = false;
  }
  // ---- Fullscreen: blow the game player up to the whole screen (over the nav
  // rail), via the Fullscreen API on the player container so the controls stay. ----
  const gameFullLabel = $("#game-full-label");
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
  function exitFs() { try { (document.exitFullscreen || document.webkitExitFullscreen)?.call(document); } catch (_) {} }
  function enterFs() { try { (gamePlay.requestFullscreen || gamePlay.webkitRequestFullscreen)?.call(gamePlay); } catch (_) {} }
  function syncFsLabel() { if (gameFullLabel) gameFullLabel.textContent = fsEl() ? "⛶ Exit full screen" : "⛶ Fullscreen"; }
  $("#game-full")?.addEventListener("click", () => { fsEl() ? exitFs() : enterFs(); });
  document.addEventListener("fullscreenchange", syncFsLabel);
  document.addEventListener("webkitfullscreenchange", syncFsLabel);
  function closeGame() {
    if (fsEl()) exitFs();            // drop out of fullscreen before hiding the player
    gamePlay.hidden = true;
    gameFrame.src = "about:blank";
  }
  $("#game-back")?.addEventListener("click", closeGame);

  // ---- Game saves ----
  // Games run in same-origin iframes, so their localStorage + IndexedDB live on
  // THIS origin and already persist between visits. We (1) ask the browser to KEEP
  // that storage (persist, so it isn't evicted under pressure) and (2) let the
  // player export/import a backup. The backup is scoped to GAME data only — the
  // app's own settings ("halcyon:" localStorage keys) and the proxy's cookie jar
  // ("scramjet*" IndexedDB) are excluded, so a shared backup never leaks browsing.
  const isAppKey = (k) => !k || k.indexOf("halcyon:") === 0;
  const isProxyDb = (n) => !n || /scramjet/i.test(n);   // matches "scramjet*" and "__scramjet_controller"
  const savesNote = $("#saves-note");
  async function requestPersist() {
    try {
      if (!navigator.storage || !navigator.storage.persist) return;
      const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      if (!already) await navigator.storage.persist();  // best-effort; browser may still grant later
    } catch (_) {}
  }
  // Binary-safe (de)serialization — emulator save-states are ArrayBuffers / typed
  // arrays / Blobs that JSON can't carry, so we base64 them behind a type tag.
  const B64 = {
    enc(buf) { const b = new Uint8Array(buf); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); },
    dec(str) { const s = atob(str); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; },
  };
  async function encVal(v) {
    if (v == null || typeof v !== "object") return v;
    if (v instanceof ArrayBuffer) return { __b: "ab", d: B64.enc(v) };
    if (ArrayBuffer.isView(v)) return { __b: "ta", c: v.constructor.name, d: B64.enc(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) };
    if (v instanceof Blob) return { __b: "blob", t: v.type, d: B64.enc(await v.arrayBuffer()) };
    if (Array.isArray(v)) { const a = []; for (const x of v) a.push(await encVal(x)); return a; }
    const o = {}; for (const k of Object.keys(v)) o[k] = await encVal(v[k]); return o;
  }
  function decVal(v) {
    if (v == null || typeof v !== "object") return v;
    if (v.__b === "ab") return B64.dec(v.d).buffer;
    if (v.__b === "ta") { const C = self[v.c] || Uint8Array; return new C(B64.dec(v.d).buffer); }
    if (v.__b === "blob") return new Blob([B64.dec(v.d)], { type: v.t });
    if (Array.isArray(v)) return v.map(decVal);
    const o = {}; for (const k of Object.keys(v)) o[k] = decVal(v[k]); return o;
  }
  async function dumpGameIDB() {
    const out = {};
    let dbs = [];
    try { dbs = (indexedDB.databases ? await indexedDB.databases() : []) || []; } catch (_) { return out; }
    for (const info of dbs) {
      const name = info.name;
      if (isProxyDb(name)) continue;                         // skip the proxy's cookie jar
      let db;
      try { db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(0); }); }
      catch (_) { continue; }
      const dump = { version: db.version, stores: {} };
      for (const sn of Array.from(db.objectStoreNames)) {
        await new Promise((res) => {
          let st; try { st = db.transaction(sn, "readonly").objectStore(sn); } catch (_) { return res(); }
          const meta = { keyPath: st.keyPath, autoIncrement: st.autoIncrement, recs: [] };
          const kr = st.getAllKeys(), vr = st.getAll();
          let keys, vals, got = 0;
          const done = async () => {
            if (++got < 2) return;
            for (let i = 0; i < vals.length; i++) meta.recs.push({ k: st.keyPath != null ? undefined : await encVal(keys[i]), v: await encVal(vals[i]) });
            dump.stores[sn] = meta; res();
          };
          kr.onsuccess = () => { keys = kr.result; done(); };
          vr.onsuccess = () => { vals = vr.result; done(); };
          kr.onerror = vr.onerror = () => res();
        });
      }
      db.close();
      out[name] = dump;
    }
    return out;
  }
  async function restoreGameIDB(data) {
    for (const name of Object.keys(data)) {
      if (isProxyDb(name)) continue;
      const d = data[name];
      await new Promise((res) => { const dr = indexedDB.deleteDatabase(name); dr.onsuccess = dr.onerror = dr.onblocked = () => res(); });
      let db;
      try {
        db = await new Promise((res, rej) => {
          const r = indexedDB.open(name, d.version || 1);
          r.onupgradeneeded = () => { const idb = r.result; for (const sn of Object.keys(d.stores)) { const m = d.stores[sn]; const opts = {}; if (m.keyPath != null) opts.keyPath = m.keyPath; if (m.autoIncrement) opts.autoIncrement = true; try { idb.createObjectStore(sn, opts); } catch (_) {} } };
          r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        });
      } catch (_) { continue; }
      for (const sn of Object.keys(d.stores)) {
        const m = d.stores[sn];
        await new Promise((res) => {
          let st; try { st = db.transaction(sn, "readwrite").objectStore(sn); } catch (_) { return res(); }
          for (const rec of m.recs) { try { const val = decVal(rec.v); if (m.keyPath != null) st.put(val); else st.put(val, decVal(rec.k)); } catch (_) {} }
          st.transaction.oncomplete = () => res(); st.transaction.onerror = () => res();
        });
      }
      db.close();
    }
  }
  function dumpGameLS() { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (!isAppKey(k)) o[k] = localStorage.getItem(k); } return o; }
  function restoreGameLS(o) { for (const k of Object.keys(o)) { if (isAppKey(k)) continue; try { localStorage.setItem(k, o[k]); } catch (_) {} } }
  // ---- OPFS: some games (Stardew Valley & other .NET/Unity ports) save to the
  // Origin Private File System as flat .tar files at the OPFS root, NOT to
  // localStorage/IndexedDB. Back those up too — but skip the re-downloadable game
  // content packs (Content.tar / anything very large), only the saves + prefs. ----
  const opfsSkip = (name, size) => /content/i.test(name) || size > 30 * 1024 * 1024;
  async function dumpOPFS() {
    const out = {};
    try {
      const root = await navigator.storage.getDirectory();
      for await (const [name, h] of root.entries()) {
        if (h.kind !== "file") continue;
        const f = await h.getFile();
        if (opfsSkip(name, f.size)) continue;
        out[name] = B64.enc(await f.arrayBuffer());
      }
    } catch (_) {}
    return out;
  }
  async function writeOPFS(name, bytes) {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle(name, { create: true });
    const w = await h.createWritable(); await w.write(bytes); await w.close();
  }
  async function restoreOPFS(obj) {
    for (const name of Object.keys(obj)) { try { await writeOPFS(name, B64.dec(obj[name]).buffer); } catch (_) {} }
  }

  // ---- Import a backup from ANOTHER site (e.g. Obsidian) and convert it. Those
  // are gzipped tarballs; we stream-gunzip and pull out just the game-save parts
  // (opfs/*.tar saves + data/ls.json localStorage), skipping the huge content
  // packs. A converted save only resurfaces for a game Halcyon ALSO has in the
  // same build (Stardew Valley, etc.) — same storage layout, so it just works. ----
  async function tarExtract(stream, want) {
    const reader = stream.getReader();
    let buf = new Uint8Array(0), done = false;
    const out = {};
    const octal = (b) => parseInt((new TextDecoder().decode(b).replace(/\0.*$/, "").trim() || "0"), 8) || 0;
    const push = (c) => { const n = new Uint8Array(buf.length + c.length); n.set(buf); n.set(c, buf.length); buf = n; };
    const ensure = async (n) => { while (buf.length < n && !done) { const r = await reader.read(); if (r.done) { done = true; break; } push(r.value); } return buf.length >= n; };
    while (await ensure(512)) {
      const header = buf.slice(0, 512); buf = buf.slice(512);
      if (header.every((x) => x === 0)) break;                          // end-of-archive
      const name = new TextDecoder().decode(header.slice(0, 100)).replace(/\0.*$/, "");
      const size = octal(header.slice(124, 136));
      const total = size + ((512 - (size % 512)) % 512);
      if (want(name)) { await ensure(total); out[name] = buf.slice(0, size); buf = buf.slice(total); }
      else {                                                            // skip without buffering (Content.tar is ~66MB)
        let rem = total; const fromBuf = Math.min(rem, buf.length); buf = buf.slice(fromBuf); rem -= fromBuf;
        while (rem > 0 && !done) { const r = await reader.read(); if (r.done) { done = true; break; } if (r.value.length <= rem) rem -= r.value.length; else { buf = r.value.slice(rem); rem = 0; } }
      }
    }
    try { reader.releaseLock(); } catch (_) {}
    return out;
  }
  async function importForeign(file) {
    if (!confirm("Import this backup from another site? Matching game saves (e.g. Stardew Valley) will be added to Halcyon; a game you already have a save for will be overwritten.")) return;
    flashSaves("Importing… this can take a moment for large files.");
    try {
      if (!("DecompressionStream" in self)) { flashSaves("This browser can't unpack that file.", false); return; }
      const stream = file.stream().pipeThrough(new DecompressionStream("gzip"));
      const want = (n) => (n.startsWith("opfs/") && !/content/i.test(n)) || n === "data/ls.json";
      const found = await tarExtract(stream, want);
      let saves = 0;
      for (const [name, bytes] of Object.entries(found)) {
        if (name.startsWith("opfs/")) {
          const base = name.slice(5).replace(/\/.*$/, "");             // flat tar at OPFS root
          if (base) { await writeOPFS(base, bytes.buffer); if (/save/i.test(base)) saves++; }
        } else if (name === "data/ls.json") {
          try { const ls = JSON.parse(new TextDecoder().decode(bytes)); for (const k of Object.keys(ls)) if (!isAppKey(k)) localStorage.setItem(k, ls[k]); } catch (_) {}
        }
      }
      if (!Object.keys(found).length) { flashSaves("No importable game saves found in that file.", false); return; }
      flashSaves("Imported ✓ — open the game and your save will be under Load.");
    } catch (e) { flashSaves("Import failed — " + (e && e.message || "try again"), false); }
  }

  function flashSaves(msg, ok) { if (!savesNote) return; savesNote.textContent = msg; savesNote.classList.toggle("flash", ok !== false); }
  async function backupSaves(btn) {
    if (btn) btn.disabled = true;
    flashSaves("Collecting your saves…");
    try {
      const payload = { halcyon: "game-saves", v: 1, when: new Date().toISOString(), origin: location.origin,
        localStorage: dumpGameLS(), idb: await dumpGameIDB(), opfs: await dumpOPFS() };
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url; a.download = "halcyon-game-saves-" + new Date().toISOString().slice(0, 10) + ".json";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      flashSaves("Backup downloaded ✓");
    } catch (_) { flashSaves("Backup failed — try again.", false); }
    finally { if (btn) btn.disabled = false; }
  }
  async function restoreSaves(file) {
    // Peek at the first bytes: a gzip magic (1f 8b) means it's another site's
    // tarball backup (e.g. Obsidian) -> convert it instead of a Halcyon restore.
    let head;
    try { head = new Uint8Array(await file.slice(0, 2).arrayBuffer()); } catch { head = new Uint8Array(); }
    if (head[0] === 0x1f && head[1] === 0x8b) return importForeign(file);
    let data; try { data = JSON.parse(await file.text()); } catch { flashSaves("That file isn't a valid backup.", false); return; }
    if (data.halcyon !== "game-saves" && !confirm("This doesn't look like a Halcyon save backup. Restore anyway?")) return;
    if (!confirm("Restore games from this backup? Saves currently on this device will be overwritten.")) return;
    flashSaves("Restoring…");
    try {
      if (data.localStorage) restoreGameLS(data.localStorage);
      if (data.idb) await restoreGameIDB(data.idb);
      if (data.opfs) await restoreOPFS(data.opfs);
      location.reload();
    } catch (_) { flashSaves("Restore failed — try again.", false); }
  }
  $("#saves-backup")?.addEventListener("click", (e) => backupSaves(e.currentTarget));
  $("#saves-restore")?.addEventListener("click", () => $("#saves-file")?.click());
  $("#saves-file")?.addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; if (f) restoreSaves(f); e.target.value = ""; });

  // Search collapses the curated shelves and filters the full library; empty
  // query restores the browse layout.
  $("#games-search")?.addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    const browsing = !q;
    // Show a shelf only while browsing AND it actually has content.
    if (featuredWrap) featuredWrap.hidden = !browsing || featuredWrap.dataset.has !== "1";
    if (popularWrap) popularWrap.hidden = !browsing || popularWrap.dataset.has !== "1";
    if (allHead) allHead.textContent = browsing ? "All games" : "Results";
    let shown = 0;
    gamesGrid.querySelectorAll(".game-tile").forEach((t) => {
      const match = browsing || t.dataset.title.includes(q);
      t.style.display = match ? "" : "none";
      if (match) shown++;
    });
    if (gamesEmpty) gamesEmpty.hidden = browsing || shown > 0;
  });
  // Load the merged catalog (~1,200 games) the first time the Games view is opened.
  $$('[data-nav="games"]').forEach((el) => el.addEventListener("click", loadGames));
  // Clicking ANY nav button also exits a running game (the overlay sits above views).
  $$("[data-nav]").forEach((el) => el.addEventListener("click", () => {
    if (gamePlay && !gamePlay.hidden) closeGame();
  }));

  // ---- Proxy tabs + launch flow ----
  const loader = $("#frame-loader");
  const tbInput = $("#tb-input");
  const tabstrip = $("#tabstrip");
  Halcyon.initTabs($("#frames"));

  let lastActiveUrl = "";

  // Render the tab strip and drive the address bar + loader from tab state.
  Halcyon.onTabs((state) => {
    const active = state.tabs.find((t) => t.active) || null;
    lastActiveUrl = active?.url || "";
    if (active && document.activeElement !== tbInput) tbInput.value = active.url || "";
    loader.classList.toggle("hidden", !(active && active.loading));

    tabstrip.style.display = state.tabs.length ? "" : "none";
    tabstrip.innerHTML = "";
    for (const t of state.tabs) {
      const chip = document.createElement("div");
      chip.className = "tab" + (t.active ? " active" : "");
      chip.title = t.url || "New tab";
      const title = document.createElement("span");
      title.className = "t-title";
      title.textContent = t.title || "New Tab";
      const close = document.createElement("button");
      close.className = "t-close";
      close.type = "button";
      close.innerHTML = "&times;";
      close.title = "Close tab";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        Halcyon.closeTab(t.id);
        // Follow the new active tab: show its page, or home if it's a fresh
        // tab (or there are none left).
        const st = Halcyon.tabsState();
        const act = st.tabs.find((x) => x.active);
        show(act && act.url ? "proxy" : "home");
      });
      chip.append(title, close);
      chip.addEventListener("click", () => {
        Halcyon.switchTab(t.id);
        show(t.url ? "proxy" : "home");
      });
      tabstrip.appendChild(chip);
    }
    const plus = document.createElement("button");
    plus.className = "tab-new";
    plus.type = "button";
    plus.innerHTML = "+";
    plus.title = "New tab";
    plus.addEventListener("click", () => {
      Halcyon.newTab();
      show("home");
    });
    tabstrip.appendChild(plus);
  });

  // Navigate the active tab (creating one if none exist).
  async function launch(input) {
    if (!input) return;
    show("proxy");
    loader.classList.remove("hidden");
    tbInput.value = Halcyon.normalizeInput(input) || input;
    try {
      await Halcyon.go(input);
    } catch (err) {
      console.error(err);
      loader.classList.add("hidden");
      alert("Failed to start the proxy: " + err.message);
    }
  }

  // Search bar on home
  $("#search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    launch($("#search-input").value);
    $("#search-input").value = "";
  });
  // Warm the runtime up as soon as the user focuses the box.
  $("#search-input").addEventListener("focus", () => Halcyon.preboot().catch(() => {}), { once: true });
  // …and, regardless of how they enter, prewarm once the page goes idle, so the
  // very first navigation (a tile click, a shortcut) rides a hot SW + controller
  // instead of paying the full cold-boot (SW register + script loads + WASM
  // compile + Wisp connect) on the click. preboot() is idempotent, so the
  // earlier focus/hover warmers just no-op if this already ran.
  const prewarmIdle = () => Halcyon.preboot().catch(() => {});
  if ("requestIdleCallback" in window) {
    requestIdleCallback(prewarmIdle, { timeout: 3000 });
  } else {
    setTimeout(prewarmIdle, 1500);
  }

  // Proxy top bar
  $("#tb-form").addEventListener("submit", (e) => {
    e.preventDefault();
    launch(tbInput.value);
  });
  $("#tb-back").addEventListener("click", () => Halcyon.back());
  $("#tb-forward").addEventListener("click", () => Halcyon.forward());
  $("#tb-reload").addEventListener("click", () => Halcyon.reload());
  $("#tb-home").addEventListener("click", () => {
    Halcyon.goHome();
    show("home");
  });
  $("#tb-newtab").addEventListener("click", () => {
    if (lastActiveUrl) window.open(lastActiveUrl, "_blank");
  });
  // "Behind the overlay" — dismiss modal overlays + restore scroll on demand.
  $("#tb-overlay")?.addEventListener("click", () => {
    const n = Halcyon.removeOverlay();
    toast(n > 0 ? `Removed ${n} overlay${n > 1 ? "s" : ""}` : "Scroll unlocked — no overlay found");
  });

  // ---- Bookmarks & History (localStorage; never leaves this browser) --------
  const hostLabel = (url) => {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
  };
  const avatarLetter = (url) => (hostLabel(url)[0] || "?").toUpperCase();
  const avatarColor = (url) => {
    const h = hostLabel(url);
    let n = 0;
    for (const c of h) n = (n * 31 + c.charCodeAt(0)) >>> 0;
    return `hsl(${n % 360} 58% 46%)`;
  };
  const timeAgo = (ts) => {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  };

  // -- Bookmarks --
  const Bookmarks = {
    all() { try { return JSON.parse(store.get("bookmarks", "[]")); } catch { return []; } },
    save(a) { store.set("bookmarks", JSON.stringify(a)); },
    has(url) { return this.all().some((b) => b.url === url); },
    add(url, title) {
      if (!url || this.has(url)) return;
      const a = this.all();
      a.unshift({ url, title: title || hostLabel(url), at: Date.now() });
      this.save(a);
    },
    remove(url) { this.save(this.all().filter((b) => b.url !== url)); },
  };
  const bmRow = $("#bookmarks");
  const bmLabel = $("#bookmarks-label");
  const starBtn = $("#tb-bookmark");

  function renderBookmarks() {
    const list = Bookmarks.all();
    bmLabel.hidden = bmRow.hidden = list.length === 0;
    bmRow.innerHTML = "";
    for (const b of list) {
      const el = document.createElement("button");
      el.className = "ql";
      el.style.setProperty("--glow", avatarColor(b.url));
      const ico = document.createElement("span");
      ico.className = "ico";
      ico.style.background = avatarColor(b.url);
      ico.textContent = avatarLetter(b.url);
      const name = document.createTextNode(b.title || hostLabel(b.url));
      const x = document.createElement("span");
      x.className = "bm-x";
      x.innerHTML = "&times;";
      x.title = "Remove bookmark";
      x.addEventListener("click", (e) => { e.stopPropagation(); Bookmarks.remove(b.url); renderBookmarks(); });
      el.append(ico, name, x);
      el.addEventListener("click", () => launch(b.url));
      bmRow.appendChild(el);
    }
  }

  const activeTab = () => Halcyon.tabsState().tabs.find((t) => t.active) || null;
  const activeHttpUrl = () => {
    const a = activeTab();
    return a && /^https?:/.test(a.url) ? a.url : "";
  };
  function updateStar() {
    const url = activeHttpUrl();
    starBtn.classList.toggle("active", !!url && Bookmarks.has(url));
  }
  starBtn.addEventListener("click", () => {
    const url = activeHttpUrl();
    if (!url) return;
    const a = activeTab();
    if (Bookmarks.has(url)) Bookmarks.remove(url);
    else Bookmarks.add(url, a && a.title);
    renderBookmarks();
    updateStar();
    toast(Bookmarks.has(url) ? "Bookmarked" : "Bookmark removed");
  });

  // -- History --
  const History = {
    all() { try { return JSON.parse(store.get("history", "[]")); } catch { return []; } },
    save(a) { store.set("history", JSON.stringify(a)); },
    record(url, title) {
      if (!url || !/^https?:/.test(url)) return;
      let a = this.all().filter((h) => h.url !== url);
      a.unshift({ url, title: title || hostLabel(url), at: Date.now() });
      if (a.length > 300) a = a.slice(0, 300);
      this.save(a);
      renderHistory();
    },
    touchTitle(url, title) {
      if (!title) return;
      const a = this.all();
      const it = a.find((h) => h.url === url);
      if (it && it.title !== title) { it.title = title; this.save(a); renderHistory(); }
    },
    clear() { this.save([]); renderHistory(); },
  };
  const histList = $("#history-list");
  const histEmpty = $("#history-empty");

  function renderHistory() {
    const list = History.all();
    histEmpty.hidden = list.length > 0;
    histList.innerHTML = "";
    for (const h of list) {
      const row = document.createElement("div");
      row.className = "hist-item";
      const ico = document.createElement("span");
      ico.className = "hist-ico";
      ico.style.background = avatarColor(h.url);
      ico.textContent = avatarLetter(h.url);
      const main = document.createElement("span");
      main.className = "hist-main";
      const title = document.createElement("span");
      title.className = "hist-title";
      title.textContent = h.title || hostLabel(h.url);
      const url = document.createElement("span");
      url.className = "hist-url";
      url.textContent = h.url;
      main.append(title, url);
      const time = document.createElement("span");
      time.className = "hist-time";
      time.textContent = timeAgo(h.at);
      const x = document.createElement("button");
      x.className = "hist-x";
      x.type = "button";
      x.innerHTML = "&times;";
      x.title = "Remove";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        History.save(History.all().filter((v) => v.url !== h.url));
        renderHistory();
      });
      row.append(ico, main, time, x);
      row.addEventListener("click", () => launch(h.url));
      histList.appendChild(row);
    }
  }
  $("#history-clear").addEventListener("click", () => {
    if (confirm("Clear all browsing history from this device?")) History.clear();
  });

  // Record visits + keep the star in sync as tabs navigate. Only record once a
  // tab has actually LOADED (loading === false) — otherwise the optimistic
  // pre-navigation URL set on go() (e.g. the typed "wikipedia.org", pre-redirect)
  // gets logged as a separate entry from the resolved page.
  const histSeen = new Map();
  Halcyon.onTabs((state) => {
    for (const t of state.tabs) {
      if (t.url && !t.loading && /^https?:/.test(t.url)) {
        if (histSeen.get(t.id) !== t.url) {
          histSeen.set(t.id, t.url);
          History.record(t.url, t.title);
        } else {
          History.touchTitle(t.url, t.title);
        }
      }
    }
    updateStar();
  });

  renderBookmarks();
  renderHistory();
  updateStar();

  // ---- Settings ----
  const engineSel = $("#set-engine");
  const wispIn = $("#set-wisp");
  const cloakTitle = $("#set-cloak-title");
  const cloakIcon = $("#set-cloak-icon");
  const cloakPreset = $("#set-cloak-preset");
  const aboutBlank = $("#set-aboutblank");
  const panicUrl = $("#set-panic-url");

  // Ad blocker toggle + live count (server-side blocking)
  const adblock = $("#set-adblock");
  const adblockCount = $("#adblock-count");
  if (adblock) {
    adblock.checked = store.get("adblock", "1") !== "0";
    const render = (state) => {
      if (!state) return;
      adblock.checked = state.enabled;
      if (adblockCount) {
        adblockCount.textContent = state.blocked
          ? `Blocked ${state.blocked.toLocaleString()} requests · ${state.domains.toLocaleString()} domains on the list.`
          : `${state.domains.toLocaleString()} domains on the list.`;
      }
    };
    Halcyon.adblockState().then(render);
    adblock.addEventListener("change", () => Halcyon.setAdblock(adblock.checked).then(render));
    setInterval(() => Halcyon.adblockState().then(render), 1500);
  }

  // AI content-farm blocker toggle (server-side blocking, separate list + pref)
  const aiblock = $("#set-aiblock");
  if (aiblock) {
    aiblock.checked = store.get("aiblock", "1") !== "0";
    aiblock.addEventListener("change", () => Halcyon.setAiblock(aiblock.checked));
  }

  // Discord ad-block toggle (client-side; read live by the Discord injector)
  const discordblock = $("#set-discordblock");
  if (discordblock) {
    discordblock.checked = store.get("discordblock", "1") !== "0";
    discordblock.addEventListener("change", () =>
      store.set("discordblock", discordblock.checked ? "1" : "0")
    );
  }

  // Popup / popunder blocker toggle (client-side; read live in every frame)
  const popupblock = $("#set-popupblock");
  if (popupblock) {
    popupblock.checked = store.get("popupblock", "1") !== "0";
    popupblock.addEventListener("change", () =>
      store.set("popupblock", popupblock.checked ? "1" : "0")
    );
  }

  // Tracking-link cleaner toggle (client-side; read live by cleanUrl)
  const cleanurls = $("#set-cleanurls");
  if (cleanurls) {
    cleanurls.checked = store.get("cleanurls", "1") !== "0";
    cleanurls.addEventListener("change", () =>
      store.set("cleanurls", cleanurls.checked ? "1" : "0")
    );
  }

  engineSel.value = store.get("engine", "https://www.google.com/search?q=%s");
  wispIn.value = store.get("wisp", "");
  cloakTitle.value = store.get("cloakTitle", "");
  cloakIcon.value = store.get("cloakIcon", "");
  aboutBlank.checked = store.get("aboutblank", "0") === "1";
  panicUrl.value = store.get("panicUrl", "https://classroom.google.com");

  engineSel.addEventListener("change", () => store.set("engine", engineSel.value));
  wispIn.addEventListener("change", () => {
    wispIn.value.trim() ? store.set("wisp", wispIn.value.trim()) : store.del("wisp");
    alert("Wisp server saved. Reload the page to apply.");
  });
  panicUrl.addEventListener("change", () => store.set("panicUrl", panicUrl.value.trim()));
  aboutBlank.addEventListener("change", () => {
    store.set("aboutblank", aboutBlank.checked ? "1" : "0");
    if (aboutBlank.checked) openInAboutBlank();
  });

  // ---- Tab cloak (presets + custom title & favicon) ----
  const CLOAK_PRESETS = [
    { name: "Google Classroom", title: "Home", icon: "classroom.google.com" },
    { name: "Google Docs", title: "Google Docs", icon: "docs.google.com" },
    { name: "Google Drive", title: "My Drive - Google Drive", icon: "drive.google.com" },
    { name: "Google Slides", title: "Google Slides", icon: "slides.google.com" },
    { name: "Google Sheets", title: "Google Sheets", icon: "sheets.google.com" },
    { name: "Gmail", title: "Inbox", icon: "mail.google.com" },
    { name: "Google", title: "Google", icon: "google.com" },
    { name: "Canvas", title: "Dashboard", icon: "instructure.com" },
    { name: "Schoology", title: "Home | Schoology", icon: "schoology.com" },
    { name: "Clever", title: "Clever | Portal", icon: "clever.com" },
    { name: "Khan Academy", title: "Dashboard | Khan Academy", icon: "khanacademy.org" },
    { name: "Desmos", title: "Desmos | Scientific Calculator", icon: "desmos.com" },
    { name: "Wikipedia", title: "Wikipedia, the free encyclopedia", icon: "wikipedia.org" },
  ];
  CLOAK_PRESETS.forEach((p, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = p.name;
    cloakPreset.appendChild(o);
  });

  // Plain document glyph used when a title is cloaked but no icon is chosen.
  const NEUTRAL_FAVICON =
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="4" fill="%23fff"/><path d="M7 4h7l4 4v12H7z" fill="%23ccc"/></svg>'
    );

  // Resolve an icon value to a favicon href: a direct image/data URL is used as
  // is; anything else is treated as a site and resolved via Google's favicon
  // service (so any domain works without us shipping the image).
  function faviconFor(v) {
    v = (v || "").trim();
    if (!v) return "";
    if (/^data:/i.test(v)) return v;
    if (/^https?:\/\/\S+\.(png|ico|svg|jpe?g|gif|webp)(\?\S*)?$/i.test(v)) return v;
    const domain = v.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").trim();
    return "https://www.google.com/s2/favicons?sz=64&domain=" + encodeURIComponent(domain);
  }

  function applyCloak() {
    const t = store.get("cloakTitle", "").trim();
    const ic = store.get("cloakIcon", "").trim();
    document.title = t || "Halcyon";
    const fav = document.querySelector("link[rel=icon]");
    if (!fav) return;
    if (ic) fav.href = faviconFor(ic);
    else if (t) fav.href = NEUTRAL_FAVICON;
    else fav.href = "/assets/icon.svg";
  }

  // Keep the preset dropdown reflecting the current fields (→ "Custom…" once the
  // user edits either one away from a preset).
  function syncCloakPreset() {
    const t = cloakTitle.value.trim();
    const ic = cloakIcon.value.trim();
    const idx = CLOAK_PRESETS.findIndex((p) => p.title === t && p.icon === ic);
    cloakPreset.value = idx >= 0 ? String(idx) : "";
  }

  cloakPreset.addEventListener("change", () => {
    if (cloakPreset.value === "") return; // "Custom…" — leave the fields alone
    const p = CLOAK_PRESETS[+cloakPreset.value];
    cloakTitle.value = p.title;
    cloakIcon.value = p.icon;
    store.set("cloakTitle", p.title);
    store.set("cloakIcon", p.icon);
    applyCloak();
  });
  cloakTitle.addEventListener("input", () => {
    cloakTitle.value.trim() ? store.set("cloakTitle", cloakTitle.value) : store.del("cloakTitle");
    syncCloakPreset();
    applyCloak();
  });
  cloakIcon.addEventListener("input", () => {
    cloakIcon.value.trim() ? store.set("cloakIcon", cloakIcon.value) : store.del("cloakIcon");
    syncCloakPreset();
    applyCloak();
  });
  syncCloakPreset();
  applyCloak();

  // ---- about:blank cloak ----
  function openInAboutBlank() {
    const win = window.open("about:blank", "_blank");
    if (!win) {
      alert("Popup blocked — allow popups to use about:blank cloak.");
      return;
    }
    const iframe = win.document.createElement("iframe");
    iframe.style.cssText = "position:fixed;inset:0;border:none;width:100%;height:100%";
    iframe.src = location.href;
    win.document.body.style.margin = "0";
    win.document.title = store.get("cloakTitle", "").trim() || "Google";
    win.document.body.appendChild(iframe);
    location.replace("https://www.google.com");
  }

  // ---- Panic key (double Esc) ----
  let lastEsc = 0;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const now = Date.now();
      if (now - lastEsc < 500) {
        location.href = store.get("panicUrl", "https://classroom.google.com");
      }
      lastEsc = now;
    }
  });
  $("#panic-btn").addEventListener("click", () => {
    location.href = store.get("panicUrl", "https://classroom.google.com");
  });

  // ---- Wipe session data (sign out of everything, clear all traces) ----
  $("#wipe-btn")?.addEventListener("click", async () => {
    if (!confirm("Sign out of all proxied sites and erase browsing data from this device?"))
      return;
    try {
      // Service workers (Scramjet controller lives here).
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      // Cache storage.
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      // IndexedDB — the Scramjet cookie jar + controller state live here. Only
      // wipe those (scramjet*); leave game saves on other DBs intact.
      if (indexedDB.databases) {
        const dbs = await indexedDB.databases();
        await Promise.all(dbs.map((d) => d.name && /scramjet/i.test(d.name) && indexedDB.deleteDatabase(d.name)));
      }
    } catch (e) {
      console.warn("wipe:", e);
    }
    location.reload();
  });

  // ---- Theme (day / night) ----
  (function theme() {
    const root = document.documentElement;
    const btn = $("#theme-btn");
    const apply = (t) => {
      if (t === "light") root.setAttribute("data-theme", "light");
      else root.removeAttribute("data-theme");
      store.set("theme", t);
    };
    const initial =
      store.get("theme") ||
      (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    apply(initial);
    btn?.addEventListener("click", () =>
      apply(root.getAttribute("data-theme") === "light" ? "dark" : "light")
    );
  })();

  // ---- Greeting ----
  (function greet() {
    const el = $("#greeting");
    if (!el) return;
    const h = new Date().getHours();
    const part =
      h < 5 ? "Late night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
    el.textContent = `${part} — the horizon is clear.`;
  })();

  // ---- Rotating placeholder ----
  (function placeholders() {
    const input = $("#search-input");
    if (!input) return;
    const hints = [
      "Search the web, or paste a link",
      "Try youtube.com",
      "Ask anything…",
      "wikipedia.org/wiki/Kingfisher",
      "Where do you want to go?",
    ];
    let i = 0;
    setInterval(() => {
      if (input.value || document.activeElement === input) return;
      i = (i + 1) % hints.length;
      input.style.opacity = "0";
      setTimeout(() => {
        input.placeholder = hints[i];
        input.style.opacity = "1";
      }, 260);
    }, 4200);
    input.style.transition = "opacity 0.26s ease";
  })();

  // ---- Starfield canvas ----
  (function starfield() {
    const canvas = document.getElementById("stars");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let stars = [];
    let w, h, dpr;

    function resize() {
      dpr = Math.min(devicePixelRatio || 1, 2);
      w = canvas.width = innerWidth * dpr;
      h = canvas.height = innerHeight * dpr;
      canvas.style.width = innerWidth + "px";
      canvas.style.height = innerHeight + "px";
      const count = Math.round((innerWidth * innerHeight) / 9000);
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        r: (Math.random() * 1.2 + 0.3) * dpr,
        a: Math.random() * 0.6 + 0.15,
        tw: Math.random() * 0.02 + 0.004,
        dir: Math.random() < 0.5 ? 1 : -1,
        vy: (Math.random() * 0.12 + 0.02) * dpr,
        warm: Math.random() < 0.45,
      }));
    }

    function frame() {
      ctx.clearRect(0, 0, w, h);
      // Stars belong to the night — skip drawing in daytime mode.
      if (document.documentElement.getAttribute("data-theme") === "light") {
        return requestAnimationFrame(frame);
      }
      for (const s of stars) {
        s.a += s.tw * s.dir;
        if (s.a <= 0.12 || s.a >= 0.8) s.dir *= -1;
        s.y += s.vy;
        if (s.y > h) s.y = 0;
        ctx.globalAlpha = s.a;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = s.warm ? "#ffdca0" : "#eafff6";
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      requestAnimationFrame(frame);
    }

    resize();
    addEventListener("resize", resize);
    if (!reduce) frame();
  })();
})();
