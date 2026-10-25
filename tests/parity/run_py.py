import json, copy
import os, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
D = os.environ["CF_DATA"].rstrip("/") + "/"            # the 5etools data folder
B = (os.environ.get("CF_BREW") or "").rstrip("/") + "/" if os.environ.get("CF_BREW") else ""   # optional local homebrew repo
sys.path.insert(0, str(ROOT))
import cardforge as cf
cf.BREW_ROOTS[:] = []
W = []
cf.warn = lambda m: W.append(str(m))
data = cf.Data(D, brew_dirs=[B] if B else [])
res = cf.Resolver(data)
out = open(sys.argv[2], "w", encoding="utf-8")
for u in open(sys.argv[1], encoding="utf-8").read().split("\n"):
    W.clear()
    try:
        r = {"url": u, "card": res.resolve(u)}
    except Exception as e:
        r = {"url": u, "error": f"{type(e).__name__}: {e}"}
    r["warn"] = list(W)
    out.write(json.dumps(r, ensure_ascii=False) + "\n")
