import json
import os, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
D = os.environ["CF_DATA"].rstrip("/") + "/"            # the 5etools data folder
B = (os.environ.get("CF_BREW") or "").rstrip("/") + "/" if os.environ.get("CF_BREW") else ""   # optional local homebrew repo
sys.path.insert(0, str(ROOT))
import cardforge as cf
cf.BREW_ROOTS[:] = []
W = []; cf.warn = lambda m: W.append(str(m))
data = cf.Data(D, brew_dirs=[B] if B else [])
res = cf.Resolver(data)
links = cf.read_inputs([sys.argv[1]])
cards, log = [], []
for link, n, want in links:
    try:
        if isinstance(link, (cf.ListSpec, cf.LootSpec)):
            c = res.build_list(link) if isinstance(link, cf.ListSpec) else res.build_loot(link)
            c["multiFmt"] = {"card": "fold", "card-index": "5x8", "3x5": "3x5", "5x8": "5x8"}[want or "card"]
            want = want or "card"
        else:
            c = res.resolve(link)
        c["copies"] = n
        if want: c["want"] = want
        cards.append(c)
    except Exception as e:
        log.append(str(e))
json.dump({"cards": cards, "errors": log, "warn": W}, open(sys.argv[2], "w"), ensure_ascii=False)
