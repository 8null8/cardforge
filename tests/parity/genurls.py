# Build a big list of test links covering every page type the tool supports.
import json, urllib.parse, random
import os, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
D = os.environ["CF_DATA"].rstrip("/") + "/"            # the 5etools data folder
B = (os.environ.get("CF_BREW") or "").rstrip("/") + "/" if os.environ.get("CF_BREW") else ""   # optional local homebrew repo
sys.path.insert(0, str(ROOT))
import cardforge as cf
J = lambda p: json.load(open(D + p, encoding="utf-8"))
q = lambda s: urllib.parse.quote(s.lower(), safe="")
urls = []
def add(page, name, source, extra=""):
    urls.append(f"https://5e.tools/{page}#{q(name + '_' + source)}{extra}")
for f in J("spells/index.json").values():
    for e in J("spells/" + f).get("spell", []): add("spells.html", e["name"], e["source"])
for f in J("bestiary/index.json").values():
    for e in J("bestiary/" + f).get("monster", []): add("bestiary.html", e["name"], e["source"])
it = J("items.json")
for e in it.get("item", []) + it.get("itemGroup", []): add("items.html", e["name"], e["source"])
base = J("items-base.json")
for e in base.get("baseitem", []): add("items.html", e["name"], e["source"])
# generated magic variants (a sample of every variant applied to fitting base items)
random.seed(3)
mv = J("magicvariants.json").get("magicvariant", [])
for v in mv:
    inh = v.get("inherits", {})
    fits = [b for b in base.get("baseitem", []) if cf.Resolver._variant_applies(v, b)]
    for b in random.sample(fits, min(3, len(fits))):
        add("items.html", f"{inh.get('namePrefix', '')}{b['name']}{inh.get('nameSuffix', '')}", inh.get("source", v.get("source", "")))
for page, (file, keys, *_ ) in cf.GENERIC.items():
    d = J(file)
    for k in keys:
        for e in d.get(k, []):
            if not e.get("name"): continue
            if page == "deities.html":
                urls.append(f"https://5e.tools/{page}#{q(e['name'] + '_' + e.get('pantheon', '') + '_' + e['source'])}")
            elif k == "subrace":
                urls.append(f"https://5e.tools/{page}#{q(e['name'] + ' (' + str(e.get('raceName')) + ')_' + e['source'])}")
            else:
                add(page, e["name"], e["source"])
# class features (userscript-style links + the site's own state links)
for f in J("class/index.json").values():
    d = J("class/" + f)
    for c in d.get("class", []):
        cl = f"https://5e.tools/classes.html#{q(c['name'] + '_' + c['source'])}"
        for lvl in range(20):
            for i in range(4):
                urls.append(f"{cl},state:feature=s{lvl}-{i}")
    for x in d.get("classFeature", []):
        urls.append(f"https://5e.tools/classes.html#{q(x['className'] + '_' + x.get('classSource', 'phb'))},cardforge:cf~{q(x['name'])}~{x.get('level', '')}")
    for x in d.get("subclassFeature", []):
        urls.append(f"https://5e.tools/classes.html#{q(x['className'] + '_' + x.get('classSource', 'phb'))},cardforge:scf~{q(x['name'])}~{x.get('level', '')}~{q(x.get('subclassShortName', ''))}~{q(x.get('subclassSource', ''))}")
# homebrew / partnered (Book of Ebon Tides)
bt = json.load(open(B + "collection/Kobold Press; Book of Ebon Tides.json", encoding="utf-8")) if B and os.path.exists(B + "collection/Kobold Press; Book of Ebon Tides.json") else {}
for k, page in (("spell", "spells.html"), ("monster", "bestiary.html"), ("item", "items.html"), ("feat", "feats.html"), ("race", "races.html"), ("background", "backgrounds.html")):
    for e in bt.get(k, []): add(page, e["name"], e["source"])
for x in bt.get("subclassFeature", [])[:60]:
    urls.append(f"https://5e.tools/classes.html#{q(x['className'] + '_' + x.get('classSource', 'phb'))},cardforge:scf~{q(x['name'])}~{x.get('level', '')}~{q(x.get('subclassShortName', ''))}~{q(x.get('subclassSource', ''))}")
# spell scrolls, odd links
for s in ("fireball_xphb", "magic%20jar_xphb", "fire%20bolt_phb", "wish_phb"):
    urls += [f"https://5e.tools/spells.html#{s},cardforge:scroll~", f"https://5e.tools/spells.html#{s},cardforge:scroll~spell%20scroll_xdmg",
             f"https://5e.tools/spells.html#{s},cardforge:scroll~spell%20scroll%20(6th%20level)_dmg"]
urls += ["https://5e.tools/spells.html", "https://5e.tools/foo.html#x_y", "spells.html#fireball_phb", "https://5e.tools/spells.html#nope_xphb"]
seen = set(); out = []
for u in urls:
    if u not in seen: seen.add(u); out.append(u)
open(sys.argv[1] if len(sys.argv) > 1 else "urls.txt", "w", encoding="utf-8").write("\n".join(out))
print(len(out))
