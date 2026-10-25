#!/usr/bin/env bash
# Checks that the website (web/core.js) and the offline tool (cardforge.py) make identical cards.
#   CF_DATA=/path/to/5etools-src/data [CF_BREW=/path/to/homebrew] bash tests/parity/run_all.sh
set -euo pipefail
: "${CF_DATA:?set CF_DATA to a copy of the 5etools data folder (git clone https://github.com/5etools-mirror-3/5etools-src)}"
cd "$(dirname "$0")"
OUT="$(mktemp -d)"
python3 genurls.py "$OUT/urls.txt" >/dev/null
python3 run_py.py "$OUT/urls.txt" "$OUT/py.jsonl"
node run_js.js "$OUT/urls.txt" "$OUT/js.jsonl"
python3 compare.py "$OUT/py.jsonl" "$OUT/js.jsonl"
python3 lists_py.py lists.txt "$OUT/lp.json" && node lists_js.js lists.txt "$OUT/lj.json"
python3 -c "import json,sys; a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2])); ok=a==b; print('list file:', 'identical' if ok else 'DIFFERENT'); sys.exit(0 if ok else 1)" "$OUT/lp.json" "$OUT/lj.json"
rm -rf "$OUT"
