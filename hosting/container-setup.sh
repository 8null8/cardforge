#!/usr/bin/env bash
# Installs (or updates) the Card Forge website with nginx on Debian / Ubuntu:
# an LXC container, a VM, a Raspberry Pi, any small server.
#
#   sudo bash hosting/container-setup.sh          # run from the Card Forge folder
#   sudo PORT=8080 bash hosting/container-setup.sh
#   sudo PDF=0 bash hosting/container-setup.sh     # without the "Download PDF" service (saves ~400 MB)
#
# Run it again after unzipping a newer Card Forge to update the site. Nothing else is needed on the server:
# the cards are made in each visitor's browser, which downloads the game data from 5e.tools itself.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${SRC:-$(dirname "$HERE")}"
PORT="${PORT:-80}"
PDF="${PDF:-1}"
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

# "Download PDF": a small local service that prints the sheets with headless Chromium
PDF_OK=0
if [ "$PDF" = 1 ]; then
	if ! command -v chromium >/dev/null 2>&1 || ! fc-list 2>/dev/null | grep -qi "P052"; then
		say "Installing Chromium for PDF downloads (one-time, about 400 MB)"
		apt-get update || true
		DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends chromium fonts-urw-base35 fonts-dejavu-core python3 \
			|| echo "  ! couldn't install Chromium - the site works without it, but has no Download PDF button" >&2
	fi
	if command -v chromium >/dev/null 2>&1 && [ -f "$SRC/hosting/pdf-service.py" ]; then
		install -D -m 755 "$SRC/hosting/pdf-service.py" /usr/local/lib/cardforge/pdf-service.py
		cat > /etc/systemd/system/cardforge-pdf.service <<'UNIT'
[Unit]
Description=Card Forge PDF service (headless Chromium)
After=network.target

[Service]
ExecStart=/usr/bin/python3 /usr/local/lib/cardforge/pdf-service.py
Restart=on-failure
Nice=10
Environment=CF_PDF_PORT=8090

[Install]
WantedBy=multi-user.target
UNIT
		systemctl daemon-reload || true
		systemctl enable cardforge-pdf >/dev/null 2>&1 || true
		systemctl restart cardforge-pdf || true
		PDF_OK=1
	fi
fi
if [ "$PDF_OK" = 1 ]; then
	PDF_NGINX='	location = /api/pdf {
		proxy_pass http://127.0.0.1:8090;
		proxy_read_timeout 180s;
		client_max_body_size 40m;
		add_header Cache-Control "no-store";
	}'
else
	PDF_NGINX=''
	systemctl disable --now cardforge-pdf >/dev/null 2>&1 || true
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
$PDF_NGINX
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
[ "$PDF_OK" = 1 ] && echo "  PDF downloads: on (give the container at least 1 GB of memory: pct set <ID> --memory 1024)"
echo "  Give that address to the list collector (Send to Card Forge asks for it the first time)."
echo "  To update: unzip a newer Card Forge and run this script again."
