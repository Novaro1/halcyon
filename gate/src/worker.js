// Halcyon links gate — a Cloudflare Worker that only reveals the working links to
// people who are (a) logged in with Discord and (b) a verified Member of the
// Halcyon server. Everything is served same-origin from this Worker, so there are
// no cross-site cookie or CORS problems.
//
// Routes:
//   GET /            landing (Login with Discord) OR the links page if verified
//   GET /login       -> Discord OAuth2 authorize
//   GET /callback    OAuth2 redirect target; verifies guild membership + role
//   GET /logout      clears the session
//   GET /bot/links   private JSON for the Discord bot (?key=BOT_LINKS_SECRET)
//
// Config (wrangler.toml [vars]):  DISCORD_CLIENT_ID, GUILD_ID, MEMBER_ROLE_ID
//   (leave MEMBER_ROLE_ID blank to allow ANY server member), DISCORD_INVITE,
//   LINKS_JSON (the links, unless you bind a KV namespace named LINKS).
// Secrets (wrangler secret put):  DISCORD_CLIENT_SECRET, SESSION_SECRET,
//   BOT_LINKS_SECRET.

const API = "https://discord.com/api/v10";
const SESSION_COOKIE = "hg_sess";
const STATE_COOKIE = "hg_state";
const SESSION_TTL = 7 * 24 * 3600; // 7 days
const enc = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/login":
          return login(url, env);
        case "/callback":
          return callback(request, url, env);
        case "/logout":
          return logout(url);
        case "/bot/links":
          return botLinks(url, env);
        case "/":
          return root(request, url, env);
        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (err) {
      return new Response("Gate error: " + err.message, { status: 500 });
    }
  },
};

/* ---------------------------------------------------------------- routes --- */

async function root(request, url, env) {
  const sess = await verifySession(getCookie(request, SESSION_COOKIE), env.SESSION_SECRET);
  if (sess) return htmlResponse(linksPage(await getLinks(env), env));
  return htmlResponse(landingPage(url.searchParams.get("denied"), env));
}

function login(url, env) {
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const auth = new URL("https://discord.com/api/oauth2/authorize");
  auth.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  auth.searchParams.set("redirect_uri", url.origin + "/callback");
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", "identify guilds.members.read");
  auth.searchParams.set("state", state);
  const h = new Headers({ Location: auth.toString() });
  h.append("Set-Cookie", cookie(STATE_COOKIE, state, 600));
  return new Response(null, { status: 302, headers: h });
}

async function callback(request, url, env) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const saved = getCookie(request, STATE_COOKIE);
  if (!code || !state || state !== saved) return redirect("/?denied=state");

  // exchange the code for a user access token (needs the client secret)
  const tokenRes = await fetch(API + "/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: url.origin + "/callback",
    }),
  });
  if (!tokenRes.ok) return redirect("/?denied=token");
  const tok = await tokenRes.json();

  // ask Discord for THIS user's membership + roles in our guild
  const memRes = await fetch(`${API}/users/@me/guilds/${env.GUILD_ID}/member`, {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  });
  if (memRes.status === 404 || memRes.status === 403) return redirect("/?denied=notmember");
  if (!memRes.ok) return redirect("/?denied=member");
  const member = await memRes.json();

  // if a Member role is configured, require it (else membership is enough)
  if (env.MEMBER_ROLE_ID) {
    const roles = Array.isArray(member.roles) ? member.roles : [];
    if (!roles.includes(env.MEMBER_ROLE_ID)) return redirect("/?denied=unverified");
  }

  const uid = (member.user && member.user.id) || "member";
  const token = await makeSession(uid, env.SESSION_SECRET);
  const h = new Headers({ Location: "/" });
  h.append("Set-Cookie", cookie(SESSION_COOKIE, token, SESSION_TTL));
  h.append("Set-Cookie", cookie(STATE_COOKIE, "", 0)); // clear state
  return new Response(null, { status: 302, headers: h });
}

function logout(url) {
  const h = new Headers({ Location: "/" });
  h.append("Set-Cookie", cookie(SESSION_COOKIE, "", 0));
  return new Response(null, { status: 302, headers: h });
}

async function botLinks(url, env) {
  const key = url.searchParams.get("key");
  if (!env.BOT_LINKS_SECRET || key !== env.BOT_LINKS_SECRET)
    return new Response("unauthorized", { status: 401 });
  return new Response(JSON.stringify({ mirrors: await getLinks(env) }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/* --------------------------------------------------------------- links ----- */

async function getLinks(env) {
  if (env.LINKS) {
    const v = await env.LINKS.get("mirrors", "json");
    if (Array.isArray(v)) return v;
  }
  try {
    const v = JSON.parse(env.LINKS_JSON || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------- session ---- */

async function hmac(data, secret) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

async function makeSession(uid, secret) {
  const body = b64urlStr(JSON.stringify({ uid, exp: Math.floor(Date.now() / 1000) + SESSION_TTL }));
  return body + "." + (await hmac(body, secret));
}

async function verifySession(token, secret) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!safeEqual(sig, await hmac(body, secret))) return null;
  let p;
  try { p = JSON.parse(fromB64urlStr(body)); } catch { return null; }
  if (!p.exp || p.exp < Math.floor(Date.now() / 1000)) return null;
  return p;
}

/* --------------------------------------------------------------- utils ----- */

function b64url(buf) {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(str) {
  return b64url(enc.encode(str));
}
function fromB64urlStr(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
function getCookie(req, name) {
  const m = (req.headers.get("Cookie") || "").match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}
function cookie(name, val, maxAge) {
  return `${name}=${encodeURIComponent(val)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}
function redirect(to) {
  return new Response(null, { status: 302, headers: { Location: to } });
}
function htmlResponse(html) {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/* --------------------------------------------------------------- pages ----- */

const STYLE = `
  :root{
    --bg:#071310; --teal:#1fd1a3; --copper:#ff8a4c; --gold:#ffd27a;
    --text:#f4eee1; --muted:#9ba79a; --faint:#66756b;
    --glass:rgba(255,250,240,0.05); --glass-strong:rgba(255,250,240,0.08);
    --stroke-soft:rgba(255,250,240,0.06);
    --grad:linear-gradient(118deg,var(--teal) 0%,var(--gold) 52%,var(--copper) 100%);
    --font-display:"Fraunces",Georgia,"Times New Roman",serif;
    --font-body:"Hanken Grotesk",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    --ok:#1fd1a3; --down:#ff8f8f;
  }
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;
    justify-content:center;gap:22px;padding:8vh 20px 64px;font-family:var(--font-body);
    color:var(--text);text-align:center;background:
      radial-gradient(1100px 620px at 18% -5%, rgba(31,209,163,0.16), transparent 60%),
      radial-gradient(900px 520px at 105% 12%, rgba(255,138,76,0.12), transparent 55%),
      var(--bg)}
  .orb{width:64px;height:64px;border-radius:50%;position:relative;margin:0 auto;
    background:var(--grad);animation:orbGlow 5s ease-in-out infinite alternate}
  .orb::after{content:"";position:absolute;inset:22%;border-radius:50%;
    background:radial-gradient(circle at 35% 30%,rgba(255,255,255,.92),rgba(255,255,255,0) 60%)}
  @keyframes orbGlow{
    from{box-shadow:0 0 14px rgba(31,209,163,.4),0 0 24px rgba(255,138,76,.18),inset 0 0 12px rgba(255,255,255,.3)}
    to{box-shadow:0 0 24px rgba(31,209,163,.68),0 0 44px rgba(255,138,76,.4),inset 0 0 12px rgba(255,255,255,.4)}}
  @media (prefers-reduced-motion:reduce){.orb{animation:none}}
  h1{font-family:var(--font-display);font-optical-sizing:auto;font-weight:900;
    font-size:clamp(44px,10vw,72px);letter-spacing:-1.5px;line-height:1;margin:0;
    background:var(--grad);-webkit-background-clip:text;background-clip:text;
    -webkit-text-fill-color:transparent;color:transparent}
  p{margin:0;color:var(--muted);max-width:34rem;line-height:1.55}
  .muted{color:var(--faint);font-size:13px}
  .btn{display:inline-flex;align-items:center;gap:10px;padding:15px 26px;border-radius:14px;border:0;
    font:inherit;font-weight:800;cursor:pointer;text-decoration:none;color:#04120e}
  .btn.discord{background:#5865f2;color:#fff}
  .btn.teal{background:var(--grad);box-shadow:0 10px 30px rgba(31,209,163,.25)}
  .card{width:100%;max-width:640px;display:flex;flex-direction:column;gap:12px}
  .mirror{display:flex;align-items:center;gap:14px;padding:16px 18px;border-radius:16px;
    background:var(--glass);border:1px solid var(--stroke-soft)}
  .dot{width:11px;height:11px;border-radius:50%;background:var(--faint);flex:none}
  .dot.up{background:var(--ok);box-shadow:0 0 10px rgba(31,209,163,.7)}
  .dot.down{background:var(--down)}
  .mirror .name{font-weight:700}
  .mirror .host{margin-left:auto;color:var(--faint);font-size:12px}
  .mirror a{color:var(--text);text-decoration:none}
  .copy{background:var(--glass-strong);border:0;color:var(--text);border-radius:9px;padding:8px 12px;cursor:pointer;font:inherit}
  .row{display:flex;gap:12px;flex-wrap:wrap;justify-content:center}
  .warn{background:rgba(229,83,61,.14);border:1px solid rgba(229,83,61,.4);color:#ffd9cf;
    padding:12px 16px;border-radius:12px;max-width:34rem}
  a.small{color:var(--faint);font-size:13px}
`;

function shell(inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Halcyon — Links</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,600;0,9..144,900;1,9..144,500&family=Hanken+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${STYLE}</style></head><body>${inner}</body></html>`;
}

function landingPage(denied, env) {
  const invite = env.DISCORD_INVITE || "";
  const messages = {
    notmember: "You're logged in, but you're not in the Halcyon Discord yet. Join the server, then log in again.",
    unverified: "You're in the server but haven't verified yet. Head to #verify in Discord, click Verify, then log in again.",
    state: "Login session expired — please try again.",
    token: "Discord login failed — please try again.",
    member: "Couldn't confirm your membership — please try again.",
  };
  const warn = denied && messages[denied]
    ? `<div class="warn">${messages[denied]}</div>` : "";
  const join = invite
    ? `<a class="btn discord" href="${invite}">Join the Discord</a>` : "";
  return shell(`
    <div class="orb"></div>
    <h1>Halcyon</h1>
    <p>The links are for members only. Log in with Discord to confirm you're a verified member of the server, and your working links will appear here.</p>
    ${warn}
    <div class="row">
      <a class="btn discord" href="/login">Log in with Discord</a>
      ${denied === "notmember" || denied === "unverified" ? join : ""}
    </div>
    <p class="muted">We only check that you're a verified member of the Halcyon server. Nothing is posted and we can't see your messages.</p>
  `);
}

function linksPage(mirrors, env) {
  const rows = (mirrors || []).map((m, i) => `
    <div class="mirror">
      <span class="dot" id="d${i}"></span>
      <div><div class="name"><a href="${m.url}" target="_blank" rel="noopener">${m.name || m.url}</a></div></div>
      <span class="host">${m.host || ""}</span>
      <button class="copy" data-url="${m.url}">Copy</button>
    </div>`).join("") || `<p class="muted">No links available right now — check back soon.</p>`;
  const data = JSON.stringify((mirrors || []).map((m) => m.url));
  return shell(`
    <div class="orb"></div>
    <h1>Halcyon</h1>
    <p>You're verified. Here are the current working links — if one is blocked at school, try another.</p>
    <div class="card">${rows}</div>
    <div class="row"><a class="small" href="/logout">Log out</a></div>
    <script>
      const urls = ${data};
      document.querySelectorAll('.copy').forEach(b=>b.onclick=async()=>{
        try{await navigator.clipboard.writeText(b.dataset.url);b.textContent='Copied';setTimeout(()=>b.textContent='Copy',1200);}catch{}
      });
      urls.forEach((u,i)=>{
        const dot=document.getElementById('d'+i);const c=new AbortController();
        const t=setTimeout(()=>c.abort(),7000);
        fetch(u,{mode:'no-cors',signal:c.signal}).then(()=>{clearTimeout(t);dot.className='dot up';})
          .catch(()=>{clearTimeout(t);dot.className='dot down';});
      });
    </script>
  `);
}
