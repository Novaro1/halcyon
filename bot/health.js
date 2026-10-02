// Halcyon health checks — the "is this mirror actually working?" logic, kept
// separate from Discord so it can be unit-tested without a bot token.
//
// The old check treated ANY HTTP response as "up", so a Caddy 502, a parked
// domain, or a school-filter block page all showed green. A *healthy* Halcyon
// mirror instead answers GET / with 200 and the passphrase login page — one
// response that proves the whole chain (DNS → valid cert → Caddy → the Scramjet
// app) is alive. We look for that page's signature and classify everything else
// as "degraded" (server answered, but it isn't serving Halcyon) or "down"
// (couldn't reach it at all).

// The login page (server.js `loginPage`) always contains the passphrase form.
// Both markers together are specific enough that a block/parked page won't match.
const HALCYON_SIGNATURE = [/action=["']\/login["']/i, /name=["']password["']/i];

export const UP = "up";
export const DEGRADED = "degraded";
export const DOWN = "down";

export const STATE_EMOJI = { [UP]: "🟢", [DEGRADED]: "🟠", [DOWN]: "🔴" };

// Render one confirmed transition as an ops-channel line. Outages (down/
// degraded) get the optional role @mention; recoveries never ping.
export function formatAlert(t, { label, roleId = "" } = {}) {
  const emoji = STATE_EMOJI[t.to] || "⚪";
  const recovered = t.to === UP;
  const verb = recovered ? "recovered" : t.to === DOWN ? "went **DOWN**" : "is **degraded**";
  const mention = !recovered && roleId ? `<@&${roleId}> ` : "";
  const code = t.result?.status ? ` · HTTP ${t.result.status}` : "";
  const lat = Number.isFinite(t.result?.ms) ? ` · ${t.result.ms}ms` : "";
  return `${mention}${emoji} \`${label}\` ${verb}` + (recovered ? "" : ` — ${t.reason}`) + code + lat;
}

// Pure decision function — takes an already-collected sample and returns a
// verdict. Split out from the network so it's trivially testable.
//   sample: { error?: string, status?: number, body?: string }
export function decide(sample) {
  if (sample.error) {
    return { state: DOWN, reason: sample.error };
  }
  const { status, body = "" } = sample;
  if (status === 200 && HALCYON_SIGNATURE.every((rx) => rx.test(body))) {
    return { state: UP, reason: "ok" };
  }
  if (status >= 500) {
    return { state: DEGRADED, reason: "proxy or origin error" };
  }
  if (status === 200) {
    return { state: DEGRADED, reason: "not the Halcyon page (parked or blocked?)" };
  }
  return { state: DEGRADED, reason: "unexpected response" };
}

// Fetch GET <url>/ and classify it. Never throws — a failure is a verdict.
export async function probe(url, { timeoutMs = 8000, fetchImpl = fetch } = {}) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      redirect: "follow",
      signal: ctrl.signal,
      // Ask like a browser: Halcyon sends HTML clients from / → /login (200,
      // passphrase page), which is the signature we match. Without this header
      // the gate just answers a bare 401 and we can't tell it's really Halcyon.
      headers: { "User-Agent": "HalcyonStatusBot/1.0 (+health-check)", Accept: "text/html" },
    });
    // The login page is tiny; cap the read so a misbehaving host can't stream MBs.
    const body = (await res.text()).slice(0, 65536);
    const verdict = decide({ status: res.status, body });
    return { url, ...verdict, status: res.status, ms: Date.now() - started };
  } catch (e) {
    const reason =
      e.name === "AbortError" ? `no response in ${timeoutMs / 1000}s (timeout)` : (e.message || "unreachable");
    return { url, ...decide({ error: reason }), status: null, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// Tracks each host's state across polls and reports only *confirmed* changes, so
// a single blip (one timeout from a flaky free-DNS host or a transient filter
// hiccup) doesn't page staff. A new verdict must repeat `confirmThreshold` times
// in a row before it's committed and a transition is emitted.
export class StatusMonitor {
  constructor({ confirmThreshold = 2 } = {}) {
    this.confirmThreshold = Math.max(1, confirmThreshold);
    this.hosts = new Map(); // key -> { stable, candidate, count }
  }

  // Feed the latest round of results: [{ url, state, reason, ... }].
  // Returns the transitions that just became confirmed:
  //   [{ key, from, to, reason, result }]
  update(results) {
    const transitions = [];
    for (const result of results) {
      const key = result.url;
      const to = result.state;
      let rec = this.hosts.get(key);

      if (!rec) {
        // First time we've seen this host — adopt its state silently (no alert
        // on startup), so we only ever report genuine changes afterwards.
        this.hosts.set(key, { stable: to, candidate: null, count: 0, reason: result.reason });
        continue;
      }

      if (to === rec.stable) {
        rec.candidate = null;
        rec.count = 0;
        rec.reason = result.reason;
        continue;
      }

      if (to === rec.candidate) {
        rec.count += 1;
      } else {
        rec.candidate = to;
        rec.count = 1;
      }

      if (rec.count >= this.confirmThreshold) {
        transitions.push({ key, from: rec.stable, to, reason: result.reason, result });
        rec.stable = to;
        rec.candidate = null;
        rec.count = 0;
        rec.reason = result.reason;
      }
    }
    return transitions;
  }

  // Current committed state for a host (for rendering), or null if unknown.
  stateOf(key) {
    return this.hosts.get(key)?.stable ?? null;
  }
}
