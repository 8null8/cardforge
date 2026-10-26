#!/usr/bin/env bash
# Usage: ./make_images.sh my-list.txt   (one PNG per card; or run with no arguments to paste links)
exec python3 "$(dirname "$(readlink -f "$0")")/cardforge_png.py" "$@"
