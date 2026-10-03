# Halcyon uptime monitor

An **independent** health monitor meant to run on a box **separate from the proxy**
(e.g. a free Google Compute Engine `e2-micro`). Because it lives off the OVH box, it
survives a full backend outage and can still fire the alert — unlike the bot's own
poller, which dies with the box it watches.

It runs the same deep health check as the bot (`../bot/health.js`) against the
**backend** (`api.studybuddy.website`, the tunnel chokepoint) + the **live mirrors**,
and posts to a Discord **webhook** on confirmed state changes. No bot token — just a
webhook URL, so there's nothing sensitive beyond post-access to one channel.

## Deploy on a GCE e2-micro (free tier)

Create the VM (free-tier: `e2-micro`, `pd-standard` ≤30GB, in `us-west1`/`us-central1`/`us-east1`):

```bash
gcloud compute instances create halcyon-monitor \
  --project=studybuddy-726c0 --zone=us-central1-a \
  --machine-type=e2-micro --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-standard
```

On the VM:

```bash
sudo apt-get update && sudo apt-get install -y nodejs git
git clone https://github.com/Novaro1/halcyon.git ~/halcyon

# config (chmod 600 — holds the webhook URL)
cat > ~/halcyon/monitor/monitor.env <<'EOF'
HALCYON_ALERT_WEBHOOK=<#status-alerts webhook URL>
HALCYON_BACKEND=https://api.studybuddy.website
LINKS_URL=https://novaro1.github.io/halcyon/links.json
MONITOR_INTERVAL_MIN=5
MONITOR_CONFIRM=2
STATUS_ALERT_ROLE_ID=1551783975226441779
EOF
chmod 600 ~/halcyon/monitor/monitor.env

# systemd service (%i = your linux user)
sudo cp ~/halcyon/monitor/halcyon-monitor.service /etc/systemd/system/halcyon-monitor@$USER.service
sudo systemctl enable --now halcyon-monitor@$USER
journalctl -u halcyon-monitor@$USER -f    # watch it
```

Update later with `git -C ~/halcyon pull && sudo systemctl restart halcyon-monitor@$USER`.

## Avoid double-alerts

When this monitor owns `#status-alerts`, turn the **bot's** alerting off so you don't
get duplicate posts: unset `STATUS_ALERT_CHANNEL_ID` in `bot/.env` on the proxy box
and rebuild the bot. The bot keeps updating the `#status` board (a nicety that's fine
to lose if OVH is down); this monitor owns the outage alerts (the part that must
survive an outage).

## Cost

`e2-micro` + `pd-standard` ≤30GB in a free-tier region = free. Egress is a few pings
plus the odd alert — far under the 1 GB/month free egress. Effectively $0.
