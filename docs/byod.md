# BYOD — bring your own domain

Let members add **their own** domain as a Halcyon mirror. They point a domain at
the server; a staffer verifies it actually resolves here and allowlists it with one
command; Caddy issues the cert automatically. Because every mirror is just another
domain pointing at the one origin, BYOD costs you nothing and gives the community a
way to keep making fresh links when old ones get blocked.

Server IP: **40.160.144.225** · CNAME target: **vps-aef380a6.vps.ovh.us**

---

## Discord setup (one-time)

1. Create a **`#byod`** channel (under the Halcyon/links category). **Lock it to
   the Member role** (verified members only) — you don't want the server IP in a
   fully public channel, and you only want real members adding domains.
2. Optionally create **`#community-links`** — a read-only channel where you post
   BYOD domains whose owner chose "share with everyone."
3. Paste the message below into `#byod` and **pin it**.

### 📌 Paste into `#byod`

```
🌐 **Bring Your Own Domain**

Got a domain that isn't blocked at your school? Point it at Halcyon and it becomes
your own private working link. Here's how:

**1. Get a domain**
• Free: make an account at https://freedns.afraid.org and grab a subdomain on a
  **public, non-wildcarded** shared domain, OR
• Use a domain you already own.

**2. Point it at Halcyon**
• Subdomain (recommended) → **CNAME** → `vps-aef380a6.vps.ovh.us`
• Root/apex domain → **A record** → `40.160.144.225`

**3. Wait a few minutes** for DNS to propagate.

**4. Request it below** with this template:
> **Domain:** yourdomain.example
> **Record:** A or CNAME
> **Share it?:** just me / share with everyone

Staff will confirm it points here, add it, and it'll work over HTTPS automatically
(you'll still log in through the normal members gate). 🌿

⚠️ Only submit a domain **you** control and have pointed at us. Don't share your
domain publicly outside this server — that's how they get blocked.
```

---

## Staff approval workflow (~30 seconds)

When someone requests a domain in `#byod`:

1. **Get the helper onto the VPS** (once): it ships in the repo, so on the server
   `cd ~/halcyon && git pull` gives you `deploy/add-domain.sh`.
2. **Add it** — the script refuses anything that doesn't already resolve to this
   server, so you can't be tricked into allowlisting a domain the requester doesn't
   actually control:
   ```bash
   cd ~/halcyon && ./deploy/add-domain.sh add their-domain.example
   ```
   Expected tail: `✓ Added … Caddy issues its cert on the first HTTPS hit`.
   If it says the domain doesn't point here, tell them to fix their DNS and wait.
3. **Confirm** it serves:
   ```bash
   curl -sI https://their-domain.example | head -1     # HTTP/2 401 = the gate, working
   ```
4. Reply in `#byod`: "✅ live — log in as usual."

Other commands: `./deploy/add-domain.sh list` and `./deploy/add-domain.sh remove <domain>`.

### If they chose "share with everyone"

A BYOD domain works the moment it's allowlisted — sharing is a separate, optional
step (adds it to what the hub + `/links` bot hand out to everyone):

1. Add it to the gate's link list — on your Mac, edit `gate/wrangler.toml`
   `LINKS_JSON` (append `{"name":"Halcyon","url":"https://their-domain.example","host":"byod"}`)
   then `cd ~/halcyon/gate && npx wrangler deploy`.
2. Post it in `#community-links`.

(See [`adding-a-domain.md`](adding-a-domain.md) for the full three-places picture.)

---

## Notes & limits

- **IP-block risk:** every mirror resolves to the one IP, so a school that blocks
  the *IP* kills them all at once. Keeping the IP to a Member-only `#byod` channel
  slows that down. The durable fix is putting the origin behind Cloudflare
  (proxied) so the IP is hidden and members CNAME to a Cloudflare hostname — a
  future hardening, see the README "Going public" section.
- **Abuse:** `add` only allowlists domains that already point at this server, and
  Caddy's on-demand TLS only issues certs for allowlisted hosts (via `/_tls-check`),
  so BYOD can't be used to mint certs for domains people don't control.
- **Automating it later:** this is the staff-approved version. A `/byod add
  <domain>` bot command (verified-member-only, rate-limited, same "must resolve
  here" check, writing to `domains.txt`) is the natural next step if volume grows.
