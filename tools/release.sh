#!/usr/bin/env bash
# Publishes the offline tool as a GitHub release with cardforge-offline-<version>.zip attached.
#
#   bash tools/release.sh 1.9 notes.md
#
# Before running: set VERSION = "1.9" in cardforge.py, commit everything and push main.
# Uses the GitHub token git already has saved for github.com (it needs write access to the repository).
set -euo pipefail

REPO=8null8/cardforge
FILES=(cardforge.py cardforge_png.py card_template.html 5etools-card-list.user.js README.md
	make_cards.sh make_cards.bat make_images.sh make_images.bat calibrate_printer.sh calibrate_printer.bat)

die() { printf '\n\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }
cd "$(dirname "${BASH_SOURCE[0]}")/.."

V="${1:-}"; NOTES="${2:-}"
[ -n "$V" ] && [ -f "$NOTES" ] || die "usage: bash tools/release.sh <version> <notes.md>"
grep -q "^VERSION = \"$V\"$" cardforge.py || die "set VERSION = \"$V\" in cardforge.py first"
# the website's files carry ?v=<version> so browsers (and Cloudflare's browser cache) fetch the new ones
[ "$(grep -o 'web/[a-z]*\.[a-z]*?v=[0-9.]*' index.html | grep -vc "?v=$V$")" = 0 ] \
	|| die "set ?v=$V on the web/ files in index.html first"
[ -z "$(git status --porcelain)" ] || die "commit your changes first"
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "push main first (HEAD must match origin/main)"
git rev-parse -q --verify "refs/tags/v$V" >/dev/null && die "tag v$V already exists"

TOK="$(printf 'protocol=https\nhost=github.com\n\n' | GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null | sed -n 's/^password=//p')"
[ -n "$TOK" ] || die "git has no saved GitHub token (push once with a token and credential.helper store)"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
ZIP="$TMP/cardforge-offline-$V.zip"
git archive --format=zip --prefix=cardforge/ -o "$ZIP" HEAD "${FILES[@]}"

git tag "v$V"
git push -q origin "v$V"

python3 - "$V" "$NOTES" > "$TMP/body.json" <<'EOF'
import json, sys
v, notes = sys.argv[1], open(sys.argv[2], encoding="utf-8").read().strip()
print(json.dumps({"tag_name": f"v{v}", "name": f"Card Forge {v} (offline tool)", "body": notes}))
EOF
curl -sS -m 30 -X POST -H "Authorization: Bearer $TOK" -H "Accept: application/vnd.github+json" \
	"https://api.github.com/repos/$REPO/releases" --data-binary @"$TMP/body.json" -o "$TMP/release.json"
ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("id") or "")' "$TMP/release.json")"
[ -n "$ID" ] || die "GitHub didn't create the release: $(cat "$TMP/release.json")"

code="$(curl -sS -m 120 -X POST -H "Authorization: Bearer $TOK" -H "Accept: application/vnd.github+json" \
	-H "Content-Type: application/zip" --data-binary @"$ZIP" -o /dev/null -w '%{http_code}' \
	"https://uploads.github.com/repos/$REPO/releases/$ID/assets?name=cardforge-offline-$V.zip")"
[ "$code" = 201 ] || die "uploading the zip failed (HTTP $code)"

# keep the local copy next to the repository up to date, if there is one
LOCAL="$(dirname "$PWD")/5e-cardforge.zip"
[ -f "$LOCAL" ] && cp "$ZIP" "$LOCAL" && echo "Updated $LOCAL"
echo "Released: https://github.com/$REPO/releases/tag/v$V"
