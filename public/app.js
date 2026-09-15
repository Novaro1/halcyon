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

  // ---- Proxy launch flow ----
  const iframe = $("#frame");
  const loader = $("#frame-loader");
  const tbInput = $("#tb-input");

  Halcyon.onUrlChange((url) => {
    if (document.activeElement !== tbInput) tbInput.value = url;
    loader.classList.add("hidden");
    lastRealUrl = url;
  });
  let lastRealUrl = "";

  async function launch(input) {
    if (!input) return;
    show("proxy");
    loader.classList.remove("hidden");
    tbInput.value = Halcyon.normalizeInput(input) || input;
    try {
      await Halcyon.go(input, iframe);
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
  $("#tb-reload").addEventListener("click", () => {
    loader.classList.remove("hidden");
    Halcyon.reload();
    setTimeout(() => loader.classList.add("hidden"), 1500);
  });
  $("#tb-home").addEventListener("click", () => show("home"));
  $("#tb-newtab").addEventListener("click", () => {
    if (lastRealUrl) window.open(lastRealUrl, "_blank");
  });
  // "Behind the overlay" — dismiss modal overlays + restore scroll on demand.
  $("#tb-overlay")?.addEventListener("click", () => {
    const n = Halcyon.removeOverlay();
    toast(n > 0 ? `Removed ${n} overlay${n > 1 ? "s" : ""}` : "Scroll unlocked — no overlay found");
  });

  // ---- Settings ----
  const engineSel = $("#set-engine");
  const wispIn = $("#set-wisp");
  const cloakTitle = $("#set-cloak-title");
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

  // ---- Tab cloak ----
  function applyCloak() {
    const t = store.get("cloakTitle", "").trim();
    document.title = t || "Halcyon";
    const fav = document.querySelector("link[rel=icon]");
    if (t) {
      // Neutral favicon (a document glyph) when cloaked.
      fav.href =
        "data:image/svg+xml," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="4" fill="%23fff"/><path d="M7 4h7l4 4v12H7z" fill="%23ccc"/></svg>'
        );
    } else {
      fav.href = "/assets/icon.svg";
    }
  }
  cloakTitle.addEventListener("input", () => {
    cloakTitle.value.trim() ? store.set("cloakTitle", cloakTitle.value) : store.del("cloakTitle");
    applyCloak();
  });
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
      // IndexedDB — the Scramjet cookie jar + controller state live here.
      if (indexedDB.databases) {
        const dbs = await indexedDB.databases();
        await Promise.all(dbs.map((d) => d.name && indexedDB.deleteDatabase(d.name)));
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
