#!/usr/bin/env bash
# Creates a small Debian LXC container on this Proxmox VE host and puts the Card Forge website in it.
# Run as root in the Proxmox host shell.
#
# Straight from GitHub (no download needed; the container then updates itself from GitHub every hour):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/8null8/cardforge/main/hosting/proxmox-install.sh)"
#
# From an unzipped Card Forge folder:
#   bash hosting/proxmox-install.sh               # new container (asks a few questions; Enter = default)
#   bash hosting/proxmox-install.sh github 105    # switch existing container 105 to automatic updates from GitHub
#   bash hosting/proxmox-install.sh update 105    # copy this folder's Card Forge into container 105 (no GitHub)
#
# CF_REPO=owner/repo and CF_BRANCH=branch pick another repository; CF_TOKEN=<read-only token> for a private one.
set -euo pipefail

CF_REPO="${CF_REPO:-8null8/cardforge}"
CF_BRANCH="${CF_BRANCH:-main}"
CF_TOKEN="${CF_TOKEN:-}"
RAW="https://raw.githubusercontent.com/$CF_REPO/$CF_BRANCH"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null && pwd || pwd)"
ROOT="$(dirname "$HERE")"
LOCAL=0
[ -f "$ROOT/index.html" ] && [ -f "$ROOT/web/core.js" ] && [ -f "$HERE/container-setup.sh" ] && LOCAL=1
say()  { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }
ask()  { local q="$1" def="$2" ans; read -r -p "$q [$def]: " ans </dev/tty; echo "${ans:-$def}"; }

[ "$(id -u)" -eq 0 ] || die "run this as root on the Proxmox host"
command -v pct >/dev/null && command -v pveam >/dev/null || die "pct/pveam not found - run this on the Proxmox VE host itself"

github_script() {   # the github-setup.sh script, from this folder or from GitHub
	if [ "$LOCAL" = 1 ] && [ -f "$HERE/github-setup.sh" ]; then cat "$HERE/github-setup.sh"; return; fi
	if [ -n "$CF_TOKEN" ]; then curl -fsSL -H "Authorization: token $CF_TOKEN" "$RAW/hosting/github-setup.sh"
	else curl -fsSL "$RAW/hosting/github-setup.sh"; fi
}
use_github() {   # make container $1 serve Card Forge from GitHub and update itself
	local ctid="$1" script
	script="$(github_script)" || die "couldn't download the setup script from github.com/$CF_REPO (private repository? run again with CF_TOKEN=<token>)"
	pct exec "$ctid" -- env CF_REPO="$CF_REPO" CF_BRANCH="$CF_BRANCH" CF_TOKEN="$CF_TOKEN" CF_GIT_URL="${CF_GIT_URL:-}" bash -c "$script"
}

push_site() {   # copy the site from this folder into container $1 and (re)install it there
	local ctid="$1" bundle
	[ "$LOCAL" = 1 ] || die "run this from an unzipped Card Forge folder (or use: github <container id>)"
	bundle="$(mktemp /tmp/cardforge-XXXX.tgz)"
	tar -C "$ROOT" -czf "$bundle" index.html card_template.html 5etools-card-list.user.js README.md web hosting/container-setup.sh hosting/pdf-service.py
	pct push "$ctid" "$bundle" /root/cardforge-site.tgz
	rm -f "$bundle"
	pct exec "$ctid" -- bash -c "set -e; rm -rf /root/cardforge-site; mkdir -p /root/cardforge-site; tar -xzf /root/cardforge-site.tgz -C /root/cardforge-site; SRC=/root/cardforge-site bash /root/cardforge-site/hosting/container-setup.sh"
}

if [ "${1:-}" = "update" ] || [ "${1:-}" = "github" ]; then
	CTID="${2:-}"
	[ -n "$CTID" ] || die "usage: bash hosting/proxmox-install.sh $1 <container id>"
	pct status "$CTID" >/dev/null 2>&1 || die "there's no container $CTID"
	pct status "$CTID" | grep -q running || pct start "$CTID"
	if [ "$1" = "github" ]; then
		say "Switching container $CTID to automatic updates from github.com/$CF_REPO"
		use_github "$CTID"
	else
		say "Updating Card Forge in container $CTID"
		push_site "$CTID"
	fi
	exit 0
fi

echo "Card Forge - Proxmox LXC installer"
echo "----------------------------------"
CTID=$(ask "Container ID" "$(pvesh get /cluster/nextid)")
pct status "$CTID" >/dev/null 2>&1 && die "container $CTID already exists (to update it: bash hosting/proxmox-install.sh update $CTID)"
CT_HOSTNAME=$(ask "Hostname" "cardforge")

mapfile -t ROOT_STORES < <(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 && $3=="active" {print $1}')
[ ${#ROOT_STORES[@]} -gt 0 ] || die "no active storage that can hold container disks"
STORAGE=$(ask "Storage for the container disk (${ROOT_STORES[*]})" "${ROOT_STORES[0]}")
mapfile -t TPL_STORES < <(pvesm status -content vztmpl 2>/dev/null | awk 'NR>1 && $3=="active" {print $1}')
[ ${#TPL_STORES[@]} -gt 0 ] || die "no active storage that can hold container templates (enable 'Container template' on e.g. 'local')"
TPL_STORE="${TPL_STORES[0]}"

DISK=$(ask "Disk size in GB" "4")
CORES=$(ask "CPU cores" "1")
RAM=$(ask "Memory in MB (1024 for PDF downloads)" "1024")
BRIDGE=$(ask "Network bridge" "vmbr0")
IP=$(ask "IPv4 address: 'dhcp' or e.g. 192.168.1.50/24" "dhcp")
NET="name=eth0,bridge=$BRIDGE,ip=$IP"
if [ "$IP" != "dhcp" ]; then
	GW=$(ask "Gateway" "$(ip route | awk '/^default/ {print $3; exit}')")
	NET="$NET,gw=$GW"
fi
VLAN=$(ask "VLAN tag (blank for none)" "")
[ -n "$VLAN" ] && NET="$NET,tag=$VLAN"
PW=$(ask "Root password for the container (blank = none; use 'pct enter $CTID')" "")
if [ "$LOCAL" = 1 ]; then
	GH=$(ask "Keep it updated automatically from github.com/$CF_REPO? (Y/n)" "y")
else
	GH=y
fi

say "Finding the latest Debian container template"
pveam update >/dev/null || true
TEMPLATE=$(pveam available --section system | awk '{print $2}' | grep -E '^debian-[0-9]+-standard_.*_amd64\.tar\.(zst|gz|xz)$' | sort -V | tail -1)
[ -n "$TEMPLATE" ] || die "couldn't find a Debian template with 'pveam available'"
if ! pveam list "$TPL_STORE" | grep -q "$TEMPLATE"; then
	say "Downloading $TEMPLATE to $TPL_STORE"
	pveam download "$TPL_STORE" "$TEMPLATE"
fi

say "Creating container $CTID ($CT_HOSTNAME)"
CREATE_ARGS=(
	"$CTID" "$TPL_STORE:vztmpl/$TEMPLATE"
	--hostname "$CT_HOSTNAME"
	--cores "$CORES" --memory "$RAM" --swap 256
	--rootfs "$STORAGE:$DISK"
	--net0 "$NET"
	--unprivileged 1 --features nesting=1
	--onboot 1 --ostype debian
	--description "Card Forge website (printable cards from 5e.tools)."
)
[ -n "$PW" ] && CREATE_ARGS+=(--password "$PW")
pct create "${CREATE_ARGS[@]}"
pct start "$CTID"

say "Waiting for the container's network"
for _ in $(seq 1 60); do
	if pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then break; fi
	sleep 2
done
pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 || die "container $CTID can't reach the internet (check bridge/IP/DNS); fix that, then: bash hosting/proxmox-install.sh github $CTID"

say "Installing Card Forge inside the container"
if [[ "$GH" =~ ^[Yy] ]]; then use_github "$CTID"; else push_site "$CTID"; fi

CT_IP=$(pct exec "$CTID" -- hostname -I | awk '{print $1}')
say "All done"
echo "  Card Forge:  http://$CT_IP/"
echo "  Console:     pct enter $CTID"
if [[ "$GH" =~ ^[Yy] ]]; then
	echo "  Updates:     automatic every hour from github.com/$CF_REPO; right now: pct exec $CTID -- cardforge-update"
else
	echo "  Update:      unzip a newer Card Forge on this host, then: bash hosting/proxmox-install.sh update $CTID"
fi
