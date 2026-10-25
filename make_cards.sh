#!/usr/bin/env bash
# Usage: ./make_cards.sh my-list.txt   (or run with no arguments to paste links)
exec python3 "$(dirname "$(readlink -f "$0")")/cardforge.py" "$@"
