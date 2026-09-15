// Halcyon proxy runtime — wires up Scramjet + the controller + a Wisp transport
// and exposes a tiny `window.Halcyon` API the UI drives.
(() => {
  const RUNTIME = {
    sw: "/sw.js",
    scramjet: "/scram/scramjet.js",
    controllerApi: "/scram/controller.api.js",
    controllerInject: "/scram/controller.inject.js",
    wasm: "/scram/scramjet.wasm",
    libcurl: "/scram/libcurl.js",
  };

  // Ad/tracker blocking happens in the service worker (see sw.js) — the only
  // place that can return a *real* network failure (Response.error), which is
  // what actually stops a request rather than faking a response that "succeeds".

  // ---- Discord: hide Nitro/boost/promo UI ("ads") in the proxied window -----
  // Discord serves no third-party display ads — its "ads" are cosmetic premium
  // upsells, hidden with CSS. We pull Disblock-Origin's stylesheet live from our
  // OWN origin (server.js fetches + caches it) and inject it into the framed
  // Discord document. Purely cosmetic, so unlike the YouTube effort it has no
  // dependence on the media transport. Toggle: localStorage halcyon:discordblock.
  const dcEnabled = () => localStorage.getItem("halcyon:discordblock") !== "0";
  const dcGuarded = new WeakSet();
  let dcCssPromise = null;
  const loadDiscordCss = () => {
    // Same-origin fetch (not a proxied path, so the SW passes it through).
    if (!dcCssPromise)
      dcCssPromise = fetch("/discord-adblock.css")
        .then((r) => (r.ok ? r.text() : ""))
        .catch(() => "");
    return dcCssPromise;
  };
  function injectDiscordBlocker(win) {
    if (dcGuarded.has(win) || !dcEnabled()) return;
    dcGuarded.add(win);
    loadDiscordCss().then((css) => {
      if (!css) return;
      try {
        const style = win.document.createElement("style");
        style.id = "halcyon-discord-adblock";
        style.textContent = css;
        (win.document.head || win.document.documentElement).appendChild(style);
        console.log("[halcyon] Discord ad-block CSS injected");
      } catch {}
    });
  }

  // ---- Popup / popunder blocker --------------------------------------------
  // Blocks window.open() calls that aren't tied to a genuine, recent user
  // gesture — the mechanism behind pop-ups, pop-unders and tab-redirect ads
  // (the shared core of AdGuard PopupBlocker, schomery/popup-blocker, PopupOff,
  // etc.). Runs in EVERY proxied frame (incl. ad subframes). Legitimate popups
  // still work: a click/keypress within the last second is treated as consent,
  // so OAuth windows and "open in new tab" you actually clicked go through.
  // Toggle: localStorage halcyon:popupblock (default on).
  const popupsEnabled = () => localStorage.getItem("halcyon:popupblock") !== "0";
  const popupGuarded = new WeakSet();
  function installPopupBlocker(win) {
    if (popupGuarded.has(win)) return;
    popupGuarded.add(win);
    try {
      let lastGesture = 0;
      const mark = () => { lastGesture = Date.now(); };
      // capture:true so we still see the gesture if the page stops propagation.
      ["pointerdown", "mousedown", "keydown", "touchstart"].forEach((t) =>
        win.addEventListener(t, mark, { capture: true, passive: true })
      );
      const realOpen = win.open;
      if (typeof realOpen !== "function") return;
      // A harmless stand-in so blocked callers that chain .focus()/.close()/
      // .postMessage() don't throw and break the page's own logic.
      const stub = () => ({
        closed: true, focus() {}, blur() {}, close() {}, postMessage() {},
        moveTo() {}, resizeTo() {}, document: {}, location: {},
      });
      const wrapped = function open() {
        if (!popupsEnabled() || Date.now() - lastGesture < 1000)
          return realOpen.apply(win, arguments);
        console.log("[halcyon] blocked popup → " + (arguments[0] || "(blank)"));
        return stub();
      };
      try {
        Object.defineProperty(win, "open", {
          value: wrapped, writable: true, configurable: true,
        });
      } catch {
        win.open = wrapped;
      }
    } catch {}
  }

  // ---- "Behind the overlay": remove modal overlays on demand ---------------
  // User-triggered (a toolbar button), like the BehindTheOverlay extension —
  // rips out the dark backdrop + modal that traps you on a page and restores
  // scrolling. Manual on purpose: auto-removing would break legitimate dialogs.
  // Only removes elements that (a) are positioned, (b) cover most of the
  // viewport, and (c) carry an explicit z-index ≥ 1 — i.e. real stacking
  // overlays, not the page's own content root (which rarely sets a z-index).
  function killOverlays(win) {
    if (!win || !win.document) return 0;
    const doc = win.document;
    const W = win.innerWidth || doc.documentElement.clientWidth || 0;
    const H = win.innerHeight || doc.documentElement.clientHeight || 0;
    let removed = 0;
    const nodes = doc.body ? Array.from(doc.body.querySelectorAll("*")) : [];
    for (const el of nodes) {
      let cs;
      try { cs = win.getComputedStyle(el); } catch { continue; }
      if (!cs) continue;
      const pos = cs.position;
      if (pos !== "fixed" && pos !== "absolute" && pos !== "sticky") continue;
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0")
        continue;
      const z = parseInt(cs.zIndex, 10);
      if (!(z >= 1)) continue; // needs an explicit stacking order (skips app roots)
      const r = el.getBoundingClientRect();
      const coversMost =
        r.width >= W * 0.85 && r.height >= H * 0.6 && r.width * r.height >= W * H * 0.55;
      if (coversMost) {
        el.remove();
        removed++;
      }
    }
    // Restore scrolling that a modal locked (overflow:hidden / position:fixed).
    [doc.documentElement, doc.body].forEach((n) => {
      if (!n) return;
      n.style.setProperty("overflow", "auto", "important");
      n.style.setProperty("position", "static", "important");
    });
    ["modal-open", "no-scroll", "noscroll", "overflow-hidden", "stop-scrolling"].forEach(
      (c) => {
        doc.documentElement.classList.remove(c);
        if (doc.body) doc.body.classList.remove(c);
      }
    );
    console.log(`[halcyon] removed ${removed} overlay(s), restored scroll`);
    return removed;
  }

  // ---- URL cleaner: strip tracking params (LegitimateURLShortener) ---------
  // Loads the parsed rule set from our own origin (server.js live-fetches +
  // caches DandelionSprout's list) and strips matching query params from URLs
  // you navigate to — so pasting/clicking a link full of utm_*, fbclid, gclid…
  // loads the clean version (and the toolbar shows it clean). Applied at
  // navigation time, not per-subresource, so it never touches Scramjet routing.
  // Toggle: localStorage halcyon:cleanurls (default on).
  const cleanEnabled = () => localStorage.getItem("halcyon:cleanurls") !== "0";
  let cleanRules = { plain: new Set(), regex: [] };
  (function loadCleanRules() {
    fetch("/removeparams.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        cleanRules = {
          plain: new Set(d.plain || []),
          regex: (d.regex || [])
            .map((x) => {
              try {
                return new RegExp(x.source, x.flags);
              } catch {
                return null;
              }
            })
            .filter(Boolean),
        };
      })
      .catch(() => {});
  })();
  function cleanUrl(raw) {
    if (!cleanEnabled()) return raw;
    let u;
    try {
      u = new URL(raw);
    } catch {
      return raw;
    }
    if (![...u.searchParams.keys()].length) return raw;
    let changed = false;
    for (const name of [...u.searchParams.keys()]) {
      if (cleanRules.plain.has(name) || cleanRules.regex.some((re) => re.test(name))) {
        u.searchParams.delete(name);
        changed = true;
      }
    }
    if (changed) console.log("[halcyon] stripped tracking params → " + u.href);
    return changed ? u.href : raw;
  }

  const loadScript = (src) =>
    new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load " + src));
      document.head.appendChild(s);
    });

  async function registerSw() {
    if (!("serviceWorker" in navigator))
      throw new Error("Service workers are not supported in this browser.");
    const reg = await navigator.serviceWorker.register(RUNTIME.sw, {
      type: "classic",
      updateViaCache: "none",
    });
    await navigator.serviceWorker.ready;
    // Wait until the worker is actually *activated*…
    if (!reg.active) {
      const sw = reg.installing || reg.waiting;
      await new Promise((resolve) => {
        const check = () => {
          if (sw.state === "activated") {
            sw.removeEventListener("statechange", check);
            resolve();
          }
        };
        sw.addEventListener("statechange", check);
      });
    }
    // …and then until it actually CONTROLS this page. A freshly-installed SW
    // activates + calls clients.claim(), but `controller` stays null for a beat
    // until the claim propagates (and controllerchange fires). If we let a
    // navigation start in that window, its request escapes the SW and 404s at
    // the server (the "first visit needs a reload" race). Gating boot on this —
    // which the idle prewarm runs long before the first click — makes the first
    // navigation just work. Safety timeout so we never hang if claim never fires.
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => {
        const done = () => {
          navigator.serviceWorker.removeEventListener("controllerchange", done);
          resolve();
        };
        navigator.serviceWorker.addEventListener("controllerchange", done);
        setTimeout(done, 3000);
      });
    }
    return reg.active || navigator.serviceWorker.controller;
  }

  function wispUrl() {
    const stored = localStorage.getItem("halcyon:wisp");
    if (stored) return stored;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/wisp/`;
  }

  let controllerPromise = null;
  let frame = null;
  let activeFrameWin = null; // the current top-level proxied window (for overlay removal)
  const listeners = new Set();
  const emit = (url) => {
    listeners.forEach((fn) => fn(url));
  };

  async function boot() {
    if (controllerPromise) return controllerPromise;
    controllerPromise = (async () => {
      const sw = await registerSw();
      await loadScript(RUNTIME.scramjet);
      await loadScript(RUNTIME.controllerApi);
      await loadScript(RUNTIME.libcurl);

      const { Controller, ManagedPlugin, config } = window.$scramjetController;
      config.scramjetPath = RUNTIME.scramjet;
      config.injectPath = RUNTIME.controllerInject;
      config.wasmPath = RUNTIME.wasm;

      const transport = new window.LibcurlTransport.LibcurlClient({
        wisp: wispUrl(),
      });

      // NOTE: do NOT disable Scramjet's `sourcemaps` flag to "save CPU" — it's
      // not debug-only. It backs the scramtag rewrite-map that makes
      // Function.prototype.toString() return a function's ORIGINAL source, which
      // sites that introspect their own JS depend on (e.g. YouTube's kevlar app,
      // which otherwise throws "Cannot read properties of undefined"). Left on.
      const controller = new Controller({ serviceworker: sw, transport });
      await controller.wait();

      // The SW resets its block flags on restart — push the stored preferences.
      navigator.serviceWorker.controller?.postMessage({
        halcyonAdblock: localStorage.getItem("halcyon:adblock") !== "0",
        halcyonAiblock: localStorage.getItem("halcyon:aiblock") !== "0",
      });

      // Report the real (unproxied) URL of the framed page as it navigates.
      class UrlWatcher extends ManagedPlugin {
        constructor() {
          super("halcyon-url-watcher", []);
        }
        install(f) {
          this.tap(f.hooks.init.post, (ctx) => {
            // Popup blocking applies to every frame, incl. ad subframes.
            installPopupBlocker(ctx.window);
            if (!ctx.isTopLevel) return;
            activeFrameWin = ctx.window; // target for on-demand overlay removal
            const notify = () => emit(ctx.client.url.href);
            notify();
            this.tap(ctx.client.hooks.lifecycle.navigate, (_c, props) =>
              emit(props.url)
            );
            ctx.window.addEventListener("hashchange", notify, { capture: true });
            // Use the *real* URL (ctx.client.url), not ctx.window.location —
            // cross-realm the latter reads the proxy host, not discord.com.
            const href = (ctx.client && ctx.client.url && ctx.client.url.href) || "";
            if (/^https?:\/\/([^/]+\.)?discord(app)?\.com\//.test(href)) {
              injectDiscordBlocker(ctx.window);
            }
          });
        }
      }

      return { controller, UrlWatcher };
    })();
    return controllerPromise;
  }

  function normalizeInput(input) {
    input = input.trim();
    if (!input) return null;
    // Looks like a URL (has a scheme, or a dotted host with no spaces)?
    const isUrl =
      /^https?:\/\//i.test(input) ||
      (/^[^\s]+\.[^\s]{2,}(\/.*)?$/.test(input) && !input.includes(" "));
    if (isUrl) {
      const url = /^https?:\/\//i.test(input) ? input : "https://" + input;
      return cleanUrl(url);
    }
    const engine =
      localStorage.getItem("halcyon:engine") ||
      "https://www.google.com/search?q=%s";
    return engine.replace("%s", encodeURIComponent(input));
  }

  const Halcyon = {
    /** Mount the proxy into an <iframe>, navigating to `input` (URL or search). */
    async go(input, iframeEl) {
      const url = normalizeInput(input);
      if (!url) return null;
      const { controller, UrlWatcher } = await boot();
      if (!frame) {
        frame = controller.createFrame(iframeEl, { plugins: [new UrlWatcher()] });
      }
      frame.go(url);
      return url;
    },
    back() {
      frame?.back();
    },
    forward() {
      frame?.forward();
    },
    reload() {
      frame?.reload();
    },
    /** Remove modal overlays + restore scroll in the current page. Returns count. */
    removeOverlay() {
      try {
        return killOverlays(activeFrameWin);
      } catch {
        return 0;
      }
    },
    /** Strip tracking query params from a URL (LegitimateURLShortener rules). */
    cleanUrl,
    onUrlChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    normalizeInput,
    /** Read ad-blocker stats from the service worker. */
    adblockState() {
      return new Promise((resolve) => {
        const sw = navigator.serviceWorker.controller;
        if (!sw) return resolve(null);
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => resolve(e.data);
        sw.postMessage({ halcyonQuery: "stats" }, [ch.port2]);
        setTimeout(() => resolve(null), 600);
      });
    },
    /** Turn ad blocking on/off (persisted locally, pushed to the SW). */
    setAdblock(on) {
      localStorage.setItem("halcyon:adblock", on ? "1" : "0");
      navigator.serviceWorker.controller?.postMessage({ halcyonAdblock: !!on });
      return this.adblockState();
    },
    /** Turn AI content-farm blocking on/off (persisted locally, pushed to SW). */
    setAiblock(on) {
      localStorage.setItem("halcyon:aiblock", on ? "1" : "0");
      navigator.serviceWorker.controller?.postMessage({ halcyonAiblock: !!on });
    },
    /** Warm up the SW + controller ahead of the first navigation. */
    preboot: boot,
  };

  window.Halcyon = Halcyon;
})();
