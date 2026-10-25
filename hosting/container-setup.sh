#!/usr/bin/env bash
# Installs (or updates) the Card Forge website with nginx on Debian / Ubuntu:
# an LXC container, a VM, a Raspberry Pi, any small server.
#
#   sudo bash hosting/container-setup.sh          # run from the Card Forge folder
#   sudo PORT=8080 bash hosting/container-setup.sh
#
# Run it again after unzipping a newer Card Forge to update the site. Nothing else is needed on the server:
# the cards are made in each visitor's browser, which downloads the game data from 5e.tools itself.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${SRC:-$(dirname "$HERE")}"
PORT="${PORT:-80}"
WEB=/var/www/cardforge
FILES=(index.html card_template.html 5etools-card-list.user.js README.md web)

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this as root (sudo bash $0)"
for f in "${FILES[@]}"; do [ -e "$SRC/$f" ] || die "can't find $f in $SRC - run this from the Card Forge folder (or set SRC=/path/to/cardforge)"; done
[[ "$PORT" =~ ^[0-9]+$ ]] || die "PORT must be a number"

if ! command -v nginx >/dev/null 2>&1; then
	say "Installing nginx"
	apt-get update
	DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nginx
fi

say "Copying the site to $WEB"
mkdir -p "$(dirname "$WEB")"
NEW="$(mktemp -d "$(dirname "$WEB")/.cardforge-new-XXXX")"
for f in "${FILES[@]}"; do cp -r "$SRC/$f" "$NEW/"; done
chmod -R a+rX "$NEW"
rm -rf "$WEB.old"
[ -d "$WEB" ] && mv "$WEB" "$WEB.old"
mv "$NEW" "$WEB"
rm -rf "$WEB.old"

say "Configuring nginx (port $PORT)"
cat > /etc/nginx/sites-available/cardforge <<NGINX
server {
	listen $PORT default_server;
	listen [::]:$PORT default_server;
	server_name _;
	root $WEB;
	index index.html;
	charset utf-8;

	gzip on;
	gzip_types text/css application/javascript text/javascript application/json text/plain image/svg+xml;

	location / {
		try_files \$uri \$uri/ =404;
		# always check for a newer version, so updates show up straight away
		add_header Cache-Control "no-cache";
	}
}
NGINX
ln -sf /etc/nginx/sites-available/cardforge /etc/nginx/sites-enabled/cardforge
rm -f /etc/nginx/sites-enabled/default   # it would also claim default_server on port 80
nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl restart nginx

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
URL="http://${IP:-this-machine}$([ "$PORT" = 80 ] || echo ":$PORT")/"
say "Card Forge is running at $URL"
echo "  Give that address to the list collector (Send to Card Forge asks for it the first time)."
echo "  To update: unzip a newer Card Forge and run this script again."
