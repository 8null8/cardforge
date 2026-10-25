#!/usr/bin/env bash
# Makes this machine (normally the Card Forge LXC container) serve Card Forge straight from GitHub and keep
# itself up to date: it checks the repository every hour and updates the website when something changed.
#
# From the Proxmox host shell (container 100 here), one line:
#   pct exec 100 -- bash -c "$(curl -fsSL https://raw.githubusercontent.com/8null8/cardforge/main/hosting/github-setup.sh)"
#
# Inside the container / on any Debian or Ubuntu machine:
#   bash hosting/github-setup.sh
#
# Settings (environment variables, all optional):
#   CF_REPO=8null8/cardforge   CF_BRANCH=main   PORT=80
#   CF_TOKEN=github_pat_...    only for a private repository: a fine-grained token with read-only "Contents" access
#   CF_GIT_URL=...             clone from this address instead of GitHub (e.g. your own Gitea)
#
# Afterwards:  cardforge-update            update now (does nothing if GitHub has no changes)
#              cardforge-update --force    reinstall the current version
#              journalctl -u cardforge-update   what the hourly checks did
set -euo pipefail

REPO="${CF_REPO:-8null8/cardforge}"
BRANCH="${CF_BRANCH:-main}"
PORT="${PORT:-80}"
DIR=/opt/cardforge
CONF=/etc/cardforge

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this as root"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "PORT must be a number"

if ! command -v git >/dev/null 2>&1; then
	say "Installing git"
	apt-get update
	DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ca-certificates
fi

say "Getting Card Forge from ${CF_GIT_URL:-github.com/$REPO} ($BRANCH)"
mkdir -p "$CONF"
chmod 700 "$CONF"
echo "$BRANCH" > "$CONF/branch"
echo "$PORT" > "$CONF/port"
URL="https://github.com/$REPO.git"
if [ -n "${CF_TOKEN:-}" ]; then
	URL="https://x-access-token:${CF_TOKEN}@github.com/$REPO.git"
fi
[ -n "${CF_GIT_URL:-}" ] && URL="$CF_GIT_URL"
if [ -d "$DIR/.git" ]; then
	git -C "$DIR" remote set-url origin "$URL"
else
	rm -rf "$DIR"
	git clone --quiet --depth 1 --branch "$BRANCH" "$URL" "$DIR" \
		|| die "couldn't download github.com/$REPO. If the repository is private, run this again with CF_TOKEN=<read-only token>."
fi
chmod 700 "$DIR/.git"   # the remote URL holds the token for a private repository

say "Installing the cardforge-update command"
cat > /usr/local/bin/cardforge-update <<'UPDATER'
#!/usr/bin/env bash
# Updates the Card Forge website from GitHub when the repository has changed.  --force reinstalls anyway.
set -euo pipefail
DIR=/opt/cardforge
BRANCH="$(cat /etc/cardforge/branch 2>/dev/null || echo main)"
PORT="$(cat /etc/cardforge/port 2>/dev/null || echo 80)"
old="$(git -C "$DIR" rev-parse HEAD 2>/dev/null || echo none)"
git -C "$DIR" fetch --quiet --depth 1 origin "$BRANCH"
git -C "$DIR" reset --quiet --hard FETCH_HEAD
new="$(git -C "$DIR" rev-parse HEAD)"
what="$(git -C "$DIR" log -1 --format='%h  %s  (%cr)')"
if [ "$old" != "$new" ] || [ "${1:-}" = "--force" ] || [ ! -f /var/www/cardforge/index.html ]; then
	SRC="$DIR" PORT="$PORT" bash "$DIR/hosting/container-setup.sh" >/var/log/cardforge-install.log 2>&1 \
		|| { echo "Card Forge update FAILED - see /var/log/cardforge-install.log" >&2; exit 1; }
	echo "Card Forge updated: $what"
else
	echo "Card Forge is up to date: $what"
fi
UPDATER
chmod 755 /usr/local/bin/cardforge-update

say "Checking GitHub for updates every hour"
cat > /etc/systemd/system/cardforge-update.service <<'UNIT'
[Unit]
Description=Update Card Forge from GitHub
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/cardforge-update
UNIT
cat > /etc/systemd/system/cardforge-update.timer <<'UNIT'
[Unit]
Description=Check GitHub for Card Forge updates every hour

[Timer]
OnBootSec=3min
OnUnitActiveSec=1h
RandomizedDelaySec=5min
Persistent=true

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now cardforge-update.timer >/dev/null

say "Installing the website"
/usr/local/bin/cardforge-update --force

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
say "Done"
echo "  Card Forge:   http://${IP:-this-machine}$([ "$PORT" = 80 ] || echo ":$PORT")/"
echo "  Updates:      automatic every hour from github.com/$REPO ($BRANCH)"
echo "  Update now:   cardforge-update     (from the Proxmox host: pct exec <ID> -- cardforge-update)"
echo "  Update log:   journalctl -u cardforge-update"
