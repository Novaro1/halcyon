# Halcyon Discord server setup

A complete, click-by-click checklist to turn the server into a real, safe, public
unblocker community: role hierarchy, a **verification gate** (rules screening +
button role), locked channels, and **AutoMod**.

Work top to bottom — each phase builds on the last. Enable **Developer Mode**
first (User Settings → Advanced → Developer Mode) so you can right-click → Copy ID
anywhere you need one.

> **Golden rule of a links server:** the only channels an *unverified* person can
> see are `#welcome`, `#rules`, and `#verify`. Everything else — especially
> `#get-links` — is gated behind the **Member** role. Get this wrong in one
> channel and your links leak. The permission model below is built around that.

---

## Phase 0 — Safety baseline (2 min)

**Server Settings → Safety Setup** (and → **Moderation**):

- [ ] **Verification Level → Medium** ("must be registered on Discord for longer
      than 5 minutes"). Bump to **High** (member of *this* server for 10+ min) only
      if you get raided — High is annoying for real users.
- [ ] **DM Spam filter → Filter all members.**
- [ ] **Require 2FA for moderator actions → On.** (You'll need 2FA on your own
      account for this — do it, it protects the whole server.)
- [ ] Default notifications → **Only @mentions** (Server Settings → Overview →
      "Default Notification Settings").

---

## Phase 1 — Enable Community (3 min)

This unlocks Rules Screening, Onboarding, AutoMod, and announcement channels — you
need it for the verification gate.

- [ ] **Server Settings → Enable Community → Get Started.**
- [ ] Check the two safety boxes (verification level + explicit content scan).
- [ ] **Rules channel → `#rules`**, **Community updates channel → `#announcements`**
      (create these two channels first if the wizard needs them — see Phase 3).
- [ ] Default notifications → **Only @mentions**. Finish.

You now have new sections in Server Settings: **Onboarding**, **AutoMod**, and a
**Safety Setup** dashboard. We'll use all three.

---

## Phase 2 — Roles (10 min)

**Server Settings → Roles.** Create these **in this order** (the list order *is*
the hierarchy — higher = more power, and a bot can only manage roles *below*
itself). Give each a color so they read at a glance.

Create from the top down:

| # | Role | Color | Key permissions to enable |
|---|------|-------|---------------------------|
| 1 | **👑 Admin** | red | **Administrator** (only for people you fully trust) |
| 2 | **🛡️ Staff** | orange | Manage Messages, Manage Channels, Kick, Ban, Timeout (Moderate Members), Manage Nicknames, Mute/Deafen Members, View Audit Log. **Not** Administrator. |
| 3 | **🤖 Halcyon / bots** | teal | **Manage Roles**, Manage Messages, Send Messages, Embed Links. (If you use Carl-bot for verification, its role goes here too — see Phase 4.) |
| 4 | **✨ Booster** | pink | cosmetic; leave default perms. Link it under Server Settings → Roles → your existing "Server Booster" role, or just color the built-in one. |
| 5 | **✅ Member** | green | **No** extra perms — leave everything default/off. This is purely the "verified" flag that unlocks channels. |

**@everyone** (the bottom role — edit it, don't create it): turn **OFF** these so
unverified/raiders can't cause damage even in the channels they can see:

- [ ] Create Invite → **Off** (you hand out one controlled invite; Phase 8)
- [ ] Change Nickname → Off
- [ ] Send Messages, Add Reactions, Embed Links, Attach Files, Use External
      Emoji, Mention @everyone → **Off** (they'll get Send back via **Member** in
      the community category)
- [ ] Connect / Speak (voice) → Off
- [ ] Leave **View Channels ON** at the server level — we control visibility
      per-category instead (Phase 3), which is easier to reason about.

> **Bot role position matters:** drag **🤖 Halcyon / bots** *above* **Member** in
> the role list. A bot can only grant a role that sits below its own. If Member is
> above the bot, the verify button will silently fail.

---

## Phase 3 — Categories, channels & the permission matrix (20 min)

Create the categories and channels below. **Set permissions on the *category*,
then create channels inside it with "sync permissions" on** — every channel
inherits the category, so you configure the matrix ~6 times instead of ~20.

For each category: **right-click → Edit Category → Permissions → add the role →
set the overwrites.** A ✓ = allow (green check), ✗ = deny (red x), blank = leave
neutral.

### 📌 Information
Channels: `#welcome`, `#rules`, `#announcements` (Announcement type), `#status`

| Role | View | Send |
|------|:----:|:----:|
| @everyone | ✓ | ✗ |
| Member | ✓ | ✗ |
| Staff | ✓ | ✓ |

Everyone can read; only Staff posts. (`#status` is where you'll post proxy uptime
/ "domain X is blocked, use Y".)

### 🚪 Start Here
Channels: `#verify`

| Role | View | Send |
|------|:----:|:----:|
| @everyone | ✓ | ✗ |
| Member | ✗ | — |
| Staff | ✓ | ✓ |

Unverified people **must** see this. Optionally deny **Member** View here (once
verified they don't need it). Send is off — it's just the button.

### 🔗 Halcyon
Channels: `#get-links` 🔒, `#how-to-use`, `#faq`

| Role | View | Send |
|------|:----:|:----:|
| @everyone | ✗ | — |
| Member | ✓ | ✗ |
| Staff | ✓ | ✓ |

**This is the payoff and the most important lock.** @everyone is denied View at
the category level, so unverified users can't see it at all. Members can read but
**not** send in `#get-links` (only the bot/staff post the links). Let Members chat
in `#faq` if you like (give Member Send ✓ on just that channel).

### 💬 Community
Channels: `#general`, `#off-topic`, `#memes`

| Role | View | Send |
|------|:----:|:----:|
| @everyone | ✗ | — |
| Member | ✓ | ✓ |
| Staff | ✓ | ✓ |

### 🛠️ Support
Channels: `#support`, `#bug-reports`, `#suggestions`, `#domain-requests`

| Role | View | Send |
|------|:----:|:----:|
| @everyone | ✗ | — |
| Member | ✓ | ✓ |
| Staff | ✓ | ✓ |

`#domain-requests` = where members report a blocked domain / ask for a new mirror.
`#bug-reports` and `#suggestions` funnel straight to your GitHub.

### 🔊 Voice
Channels: `General`, `Music`

| Role | View | Connect |
|------|:----:|:-------:|
| @everyone | ✗ | — |
| Member | ✓ | ✓ |
| Staff | ✓ | ✓ |

### 🧑‍💼 Staff 🔒
Channels: `#staff-chat`, `#mod-log`

| Role | View |
|------|:----:|
| @everyone | ✗ |
| Member | ✗ |
| Staff | ✓ |

Point AutoMod alerts + your audit log here (Phase 5).

> **Verify the lock before going public:** create a throwaway alt (or ask a
> friend), join with the invite, and confirm that *before* verifying you can see
> **only** `#welcome`, `#rules`, `#verify` — and nothing in 🔗 Halcyon. Then
> verify and confirm the rest appears. This 2-minute test is worth it.

---

## Phase 4 — Verification (both layers)

### 4a. Rules Screening (the "agree before you can talk" gate)

**Server Settings → Onboarding → "Guidelines" / Rules Screening** (or the
"Server Guide" section, depending on Discord's current UI):

- [ ] Turn on the rules-agreement screen new members see before they can interact.
- [ ] Add short rules (paste from Phase 7's `#rules`). Keep 4–6 punchy lines.

This blocks the laziest bots and forces a click-through on join.

### 4b. Button role → grants **Member**

Rules screening alone doesn't grant a role, so we add a button in `#verify` that
gives **Member** (which unlocks the server). Pick **one** bot to run it:

**Option A — Carl-bot (recommended, no code):**

1. [ ] Invite Carl-bot: <https://carl.gg> → Login → Add to Server → pick your
       server. Give it the perms it asks for (needs **Manage Roles**).
2. [ ] Drag **Carl-bot**'s role *above* **Member** in Server Settings → Roles.
3. [ ] In the Carl dashboard → your server → **Reaction Roles → Buttons** →
       **Create**: channel `#verify`, add a button labeled **"✅ Verify"**, map it
       to the **Member** role, mode **"Normal"** (adds the role on click).
4. [ ] Write the button's message: a short "Read #rules, then click Verify to
       unlock the server." (Phase 7 has copy.)

**Option B — Halcyon bot (keeps it to one bot; needs a redeploy):**

Tell me and I'll add a `/setup-verify` command + button handler to `bot/index.js`
(~15 lines) that posts the verify button and grants **Member** on click. You'd:
set `MEMBER_ROLE_ID` in `bot/.env`, give the Halcyon bot **Manage Roles**, move
its role above Member, and `docker compose up -d --build` on the VPS. Then run
`/setup-verify` once in `#verify`.

Either way, after this: **unverified → sees welcome/rules/verify → clicks Verify →
gets Member → whole server unlocks.** ✅

---

## Phase 5 — AutoMod (10 min)

**Server Settings → AutoMod → Create your own rule** (add each; action = **Block
message**, and for spam also **Send alert to `#mod-log`** + optional timeout):

- [ ] **Spam messages** — enable Discord's built-in "Block Suspected Spam Content"
      and "Block Mention Spam" (set mention limit to **5**).
- [ ] **Invite links** — Keyword rule blocking `discord.gg`, `discord.com/invite`,
      `.gg/` (stops people advertising other servers / raid invites). *Exempt your
      Staff role* so you can still post links.
- [ ] **Bad words** — enable Discord's preset "Commonly Flagged Words" list.
- [ ] **Mass caps / zalgo** (optional) — keyword/regex rule if you get spam.
- [ ] Set all rule **alerts → `#mod-log`**.

---

## Phase 6 — Onboarding & new-member flow (5 min)

**Server Settings → Onboarding:**

- [ ] **Default Channels** new members see: `#welcome`, `#rules`, `#verify`,
      `#announcements`. **Do NOT** add `#get-links` here.
- [ ] (Optional) Add opt-in "customization" channels (e.g. a `#roles` self-assign
      for `he/him`, `she/her`, `they/them` pronoun roles, notification pings).
- [ ] **Server Settings → Welcome Screen** (Community): set a one-line description
      and pin `#rules` + `#verify` as the featured channels.

---

## Phase 7 — Channel content (copy you can paste)

### `#welcome`
```
🌿 **Welcome to Halcyon** — a fast, private, ad-blocking web unblocker.

1️⃣ Read the **#rules**
2️⃣ Click **Verify** in **#verify** to unlock the server
3️⃣ Grab the current working links in **#get-links**

Blocked at school? We keep multiple mirror domains — if one dies, another works.
Links are shared **here only**, so tell a friend to join, not to share the link.
```

### `#rules`
```
**Halcyon — Rules**
1. Be respectful. No harassment, hate, slurs, or NSFW.
2. English in main channels. Keep it civil.
3. No advertising or DM spam. No invite links (staff only).
4. Don't publicly repost our domains outside this server — that's how they get
   blocked. Share the **invite**, not the links.
5. Halcyon is for bypassing web filters, not for anything illegal. No hacking,
   fraud, doxxing, or malware talk.
6. Use the right channels: bugs → #bug-reports, ideas → #suggestions,
   blocked domain → #domain-requests.
7. Staff have final say. Follow Discord's ToS & Community Guidelines.

By clicking Verify you agree to these rules.
```

### `#verify` (button message)
```
✅ **Verify to unlock Halcyon**

By verifying you confirm you've read the **#rules**. Click the button below to get
the **Member** role and access the rest of the server, including **#get-links**.
```

### `#get-links` (pin this)
```
🔗 **Working Halcyon links** — always use the freshest one below.
Run **/links** anytime for the current list + the access passphrase.
If a link is blocked at your school, try another — that's what the mirrors are for.
Report a dead/blocked domain in **#domain-requests**.
```

---

## Phase 8 — Final polish & the invite

- [ ] **Slowmode:** `#general` → 3–5s, `#get-links` → 30s+ (Edit Channel →
      Slowmode). Cuts spam.
- [ ] **Pin** the welcome/verify/get-links messages in their channels.
- [ ] **Server icon:** upload the Halcyon orb (ask me to generate one).
- [ ] **Create the public invite:** right-click server → Invite People → ⚙️ Edit
      invite link → **Expire After: Never**, **Max uses: No limit** → copy.
- [ ] Put that invite in `hub/links.json`'s `"discord"` field and push, so the
      **"Join the Discord"** button appears on the hub:
      ```bash
      cd ~/halcyon && git add hub/links.json && git commit -m "Add Discord invite to hub" && git push
      ```
- [ ] Post the hub URL + passphrase in `#get-links` (and let the bot's `/links`
      carry it going forward).

---

## Quick reference — who sees what

| Channel | Unverified (@everyone) | Member | Staff |
|---------|:---:|:---:|:---:|
| #welcome / #rules / #announcements / #status | read | read | read+post |
| #verify | read+button | — | read+post |
| #get-links | ❌ | read | read+post |
| #how-to-use / #faq | ❌ | read | read+post |
| Community / Support / Voice | ❌ | full | full |
| Staff 🔒 | ❌ | ❌ | full |

When you add a mirror domain, update it in **two** places: `domains.txt` on the
VPS (TLS allowlist) **and** `hub/links.json` (hub + bot read it).
