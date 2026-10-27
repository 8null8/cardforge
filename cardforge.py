#!/usr/bin/env python3
"""
5e CardForge - turn 5e.tools links into printable playing cards.

Usage:
    python cardforge.py my-list.txt                 # a list exported by the userscript
    python cardforge.py "https://5e.tools/spells.html#fireball_phb" ...
    python cardforge.py                             # interactive: paste links

Works on Windows and Linux with Python 3.8+ and no extra packages.
Output: <name>.html (open & print) and, if Chrome/Edge/Chromium is found, <name>.pdf.
"""
import argparse
import copy
import html
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

VERSION = "1.12"
SCRIPT_DIR = Path(__file__).resolve().parent
TEMPLATE = SCRIPT_DIR / "card_template.html"

DATA_BASES = [
    "https://5e.tools/data/",
    "https://raw.githubusercontent.com/5etools-mirror-3/5etools-src/main/data/",
    "https://5etools-mirror-3.github.io/data/",
]
# 5e.tools loads homebrew (incl. partnered books like Book of Ebon Tides) and prerelease/Unearthed Arcana
# content from these repositories; each has _generated/index-sources.json mapping a source to its file
BREW_ROOTS = [
    "https://raw.githubusercontent.com/TheGiddyLimit/homebrew/master/",
    "https://raw.githubusercontent.com/TheGiddyLimit/unearthed-arcana/master/",
]
SOURCE_ABBR = {}     # lower-case source id -> abbreviation (filled in as homebrew files are loaded)
BREW_SCHOOLS = {}    # spell schools defined by homebrew

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36 5e-cardforge/" + VERSION)


def warn(msg):
    print("  ! " + msg, file=sys.stderr)


# --------------------------------------------------------------------------- data access

def cache_dir():
    if os.name == "nt":
        root = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:
        root = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    d = root / "5e-cardforge"
    d.mkdir(parents=True, exist_ok=True)
    return d


class Data:
    def __init__(self, data_dir=None, refresh=False, extra_base=None, max_age_days=7, brew_dirs=None):
        self.data_dir = Path(data_dir) if data_dir else None
        self.refresh = refresh
        self.max_age = max_age_days * 86400
        self.bases = ([extra_base] if extra_base else []) + DATA_BASES
        self.brew_dirs = [Path(x) for x in (brew_dirs or [])]
        self.mem = {}
        self._brew_index = None
        self._brew_files = {}

    def _download(self, urls, cache_name, label, optional=False):
        """First URL that works wins; results are cached for a week (a stale copy is used if all fail)."""
        cp = cache_dir() / cache_name
        if cp.exists() and not self.refresh and time.time() - cp.stat().st_mtime < self.max_age:
            return json.loads(cp.read_text(encoding="utf-8"))
        errors = []
        for url in urls:
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=40) as r:
                    raw = r.read().decode("utf-8")
                result = json.loads(raw)
                cp.write_text(raw, encoding="utf-8")
                return result
            except Exception as e:  # try the next mirror
                errors.append(f"{url}: {e}")
        if cp.exists():  # stale cache beats nothing
            return json.loads(cp.read_text(encoding="utf-8"))
        if optional:
            return None
        raise RuntimeError("Could not download " + label + "\n    " + "\n    ".join(errors))

    def get(self, rel, optional=False):
        if rel in self.mem:
            return self.mem[rel]
        result = None
        if self.data_dir:
            p = self.data_dir / rel
            if p.exists():
                result = json.loads(p.read_text(encoding="utf-8"))
            elif not optional:
                raise FileNotFoundError(f"{p} not found in --data-dir")
        else:
            result = self._download([base + rel for base in self.bases], rel.replace("/", "__"), rel, optional)
        self.mem[rel] = result
        return result

    def search_file(self, name, optional=False):
        """A file from 5etools' search/ folder, which sits next to data/ (the quick-add search index)."""
        rel = "search/" + name
        if rel in self.mem:
            return self.mem[rel]
        result = None
        if self.data_dir:
            p = self.data_dir.parent / "search" / name
            if p.exists():
                result = json.loads(p.read_text(encoding="utf-8"))
            elif not optional:
                raise FileNotFoundError(f"{p} not found next to --data-dir")
        else:
            urls = [b[:b.rindex("/data/")] + "/" + rel for b in self.bases if "/data/" in b]
            result = self._download(urls, rel.replace("/", "__"), rel, optional)
        self.mem[rel] = result
        return result

    # ----- homebrew / partnered / prerelease content
    def brew_index(self):
        if self._brew_index is None:
            idx = {}
            for d in self.brew_dirs:   # local copies of the homebrew repos (--brew-dir)
                p = d / "_generated" / "index-sources.json"
                if p.exists():
                    for k, v in json.loads(p.read_text(encoding="utf-8")).items():
                        idx.setdefault(k.lower(), ("dir", d, v))
            for root in BREW_ROOTS:
                name = "brew-index__" + re.sub(r"\W+", "_", root.split("//", 1)[-1]).strip("_") + ".json"
                try:
                    j = self._download([root + "_generated/index-sources.json"], name, root, optional=True) or {}
                except Exception:
                    j = {}
                for k, v in j.items():
                    idx.setdefault(k.lower(), ("url", root, v))
            self._brew_index = idx
        return self._brew_index

    def brew(self, source):
        """The homebrew/partnered/prerelease file that defines `source`, or None."""
        key = (source or "").lower()
        if not key:
            return None
        if key in self._brew_files:
            return self._brew_files[key]
        out = None
        ref = self.brew_index().get(key)
        if ref:
            kind, root, path = ref
            try:
                if kind == "dir":
                    out = json.loads((root / path).read_text(encoding="utf-8"))
                else:
                    out = self._download([root + urllib.parse.quote(path)],
                                         "brew__" + re.sub(r"[^\w.-]+", "_", path), path, optional=True)
            except Exception as e:
                warn(f"couldn't load homebrew file {path}: {e}")
        if out:
            meta = out.get("_meta") or {}
            for src in meta.get("sources") or []:
                if src.get("json"):
                    SOURCE_ABBR[src["json"].lower()] = src.get("abbreviation") or src["json"]
            for k, v in (meta.get("spellSchools") or {}).items():
                BREW_SCHOOLS[k] = (v or {}).get("full") or k
        self._brew_files[key] = out
        return out


# --------------------------------------------------------------------------- text helpers

def esc(s):
    return html.escape(str(s), quote=False)


ATK = {"mw": "Melee Weapon Attack:", "rw": "Ranged Weapon Attack:", "mw,rw": "Melee or Ranged Weapon Attack:",
       "ms": "Melee Spell Attack:", "rs": "Ranged Spell Attack:", "ms,rs": "Melee or Ranged Spell Attack:",
       "m": "Melee Attack:", "r": "Ranged Attack:"}
ATKR = {"m": "Melee Attack Roll:", "r": "Ranged Attack Roll:", "m,r": "Melee or Ranged Attack Roll:"}
ABIL = {"str": "Strength", "dex": "Dexterity", "con": "Constitution",
        "int": "Intelligence", "wis": "Wisdom", "cha": "Charisma"}
TAG_RE = re.compile(r"\{@(\w+)(?: ([^{}]*?))?\}")


def signed(n):
    try:
        n = int(str(n).strip())
    except ValueError:
        return str(n)
    return f"+{n}" if n >= 0 else f"−{abs(n)}"


def _tag(m):
    tag, text = m.group(1), m.group(2) or ""
    p = text.split("|")
    t0 = p[0]
    disp = p[2] if len(p) > 2 and p[2] else t0
    if tag in ("b", "bold"):
        return f"<b>{t0}</b>"
    if tag in ("i", "italic", "note"):
        return f"<i>{t0}</i>"
    if tag in ("s", "strike"):
        return f"<s>{t0}</s>"
    if tag in ("u", "underline"):
        return f"<u>{t0}</u>"
    if tag in ("sup", "sub", "code", "kbd"):
        return f"<{tag}>{t0}</{tag}>"
    if tag == "h":
        return "<i>Hit:</i> "
    if tag == "m":
        return "<i>Miss:</i> "
    if tag == "hom":
        return "<i>Hit or Miss:</i> "
    if tag == "atk":
        return f"<i>{ATK.get(t0, 'Attack:')}</i>"
    if tag == "atkr":
        return f"<i>{ATKR.get(t0, 'Attack Roll:')}</i>"
    if tag == "hit":
        return signed(t0)
    if tag == "dc":
        return f"DC {t0}"
    if tag == "dcYourSpellSave":
        return t0 or "your spell save DC"
    if tag == "hitYourSpellAttack":
        return t0 or "your spell attack modifier"
    if tag in ("damage", "dice", "autodice"):
        return p[1] if len(p) > 1 and p[1] else t0
    if tag == "d20":
        return p[1] if len(p) > 1 and p[1] else signed(t0)
    if tag in ("scaledamage", "scaledice"):
        return p[2] if len(p) > 2 else t0
    if tag == "recharge":
        return "(Recharge 6)" if not t0 or t0 == "6" else f"(Recharge {t0}–6)"
    if tag == "chance":
        return p[1] if len(p) > 1 and p[1] else f"{t0} percent"
    if tag == "coinflip":
        return t0 or "flip a coin"
    if tag in ("skillCheck", "savingThrow"):
        return signed(p[1]) if len(p) > 1 else t0
    if tag == "ability":
        try:
            sc = int(t0.split(" ")[-1])
            return f"{sc} ({signed((sc - 10) // 2)})"
        except ValueError:
            return t0
    if tag == "actSave":
        return f"<i>{ABIL.get(t0, t0.title())} Saving Throw:</i>"
    if tag == "actSaveFail":
        return f"<i>Failure by {t0} or More:</i>" if t0 else "<i>Failure:</i>"
    if tag == "actSaveSuccess":
        return "<i>Success:</i>"
    if tag == "actSaveSuccessOrFail":
        return "<i>Failure or Success:</i>"
    if tag == "actTrigger":
        return "<i>Trigger:</i>"
    if tag == "actResponse":
        return "<i>Response:</i>"
    if tag == "spell":
        return f"<i>{disp}</i>"
    if tag == "classFeature":       # name|class|classSource|level|source|display
        return p[5] if len(p) > 5 and p[5] else t0
    if tag == "subclassFeature":    # name|class|classSource|subclass|subclassSource|level|source|display
        return p[7] if len(p) > 7 and p[7] else t0
    if tag == "subclass":           # shortName|class|classSource|source|display
        return p[4] if len(p) > 4 and p[4] else t0
    if tag in ("deity", "card"):    # name|pantheon-or-deck|source|display
        return p[3] if len(p) > 3 and p[3] else t0
    if tag == "quickref":
        return p[4] if len(p) > 4 and p[4] else t0
    if tag in ("filter", "link", "5etools", "book", "adventure", "footnote", "area", "loader", "homebrew", "unit", "help"):
        return t0
    return disp


def tx(s):
    """5etools tagged string -> HTML."""
    s = esc(s)
    for _ in range(12):
        n = TAG_RE.sub(_tag, s)
        if n == s:
            break
        s = n
    return s


def plain(s):
    return re.sub(r"<[^>]+>", "", tx(s))


# --------------------------------------------------------------------------- entries -> blocks

REF_LOOKUP = None   # while building a class-feature card: fn(kind, uid) -> referenced feature dict or None
_REF_SEEN = set()

class Blocks:
    """Collects body blocks: {'k': kind, 'h': html}.  Kinds p/li/stat are word-splittable, table row-splittable,
    box is kept whole when it fits on the next side (split only as a last resort).
    After section() every block also carries 's' (section number) and the first one 'ss': the layout tries to
    keep a whole section on one side.  'kn' = keep with the next block (a section's lead-in line)."""

    def __init__(self):
        self.out = []
        self._sec = None
        self._start = False

    def section(self):
        self._sec = (self._sec or 0) + 1
        self._start = True

    def add(self, kind, h, **extra):
        d = {"k": kind, "h": h}
        if self._sec is not None:
            d["s"] = self._sec
            if self._start:
                d["ss"] = 1
                self._start = False
        d.update(extra)
        self.out.append(d)

    def p(self, h, cls=""):
        self.add("p", f'<p class="{cls}">{h}</p>' if cls else f"<p>{h}</p>")


def inline(e):
    """Flatten an entry to one line of HTML."""
    if e is None:
        return ""
    if isinstance(e, (str, int, float)):
        return tx(e)
    if isinstance(e, list):
        return " ".join(inline(x) for x in e)
    t = e.get("type")
    if t == "cell":
        r = e.get("roll", {})
        if "exact" in r:
            return str(r["exact"]).zfill(2 if r.get("pad") else 1)
        if "min" in r:
            a, b = r["min"], r.get("max")
            return f"{a}–{b}" if b is not None else f"{a}+"
        return inline(e.get("entry"))
    if t == "dice":
        tr = e.get("toRoll")
        if isinstance(tr, list):
            return "+".join(f"{d.get('number', 1)}d{d.get('faces')}" for d in tr)
        return str(tr or "")
    if t == "bonus":
        return signed(e.get("value", 0))
    if t == "bonusSpeed":
        return signed(e.get("value", 0)) + " ft."
    if t == "link":
        return tx(e.get("text", ""))
    if t in ("abilityDc", "abilityAttackMod"):
        return ability_line(e)
    if t in ("refClassFeature", "refSubclassFeature", "refOptionalfeature", "refFeat"):
        ref = e.get("classFeature") or e.get("subclassFeature") or e.get("optionalfeature") or e.get("feat") or ""
        return tx(ref.split("|")[0])
    for key in ("entries", "items"):
        if key in e:
            return (f"<b>{tx(e['name'])}.</b> " if e.get("name") else "") + inline(e[key])
    if "entry" in e:
        return (f"<b>{tx(e['name'])}.</b> " if e.get("name") else "") + inline(e["entry"])
    if "name" in e:
        return tx(e["name"])
    return ""


def ability_line(e):
    attrs = e.get("attributes", [])
    a = " or ".join(ABIL.get(x, x) for x in attrs) if attrs else "spellcasting ability"
    if e.get("type") == "abilityDc":
        return f"<b>{tx(e.get('name', ''))} save DC</b> = 8 + your proficiency bonus + your {a} modifier"
    return f"<b>{tx(e.get('name', ''))} attack modifier</b> = your proficiency bonus + your {a} modifier"


def render_table(e, b):
    parts = []
    if e.get("caption"):
        parts.append(f"<caption>{tx(e['caption'])}</caption>")
    cols = e.get("colLabels") or []
    styles = e.get("colStyles") or []
    if cols:
        parts.append("<thead><tr>" + "".join(f"<th>{inline(c)}</th>" for c in cols) + "</tr></thead>")
    rows = []
    for r in e.get("rows", []):
        if isinstance(r, dict) and r.get("type") == "row":
            r = r.get("row", [])
        if not isinstance(r, list):
            r = [r]
        cells = []
        for i, c in enumerate(r):
            st = styles[i] if i < len(styles) else ""
            cls = ' class="c"' if "text-center" in st else ""
            cells.append(f"<td{cls}>{inline(c)}</td>")
        rows.append("<tr>" + "".join(cells) + "</tr>")
    parts.append("<tbody>" + "".join(rows) + "</tbody>")
    b.add("table", "<table>" + "".join(parts) + "</table>")
    for f in e.get("footnotes", []) or []:
        b.p(tx(f), "small")


def render_entries(entries, b, depth=0):
    if entries is None:
        return
    if not isinstance(entries, list):
        entries = [entries]
    for e in entries:
        render_entry(e, b, depth)


def render_entry(e, b, depth=0):
    if isinstance(e, (str, int, float)):
        b.p(tx(e))
        return
    if not isinstance(e, dict):
        return
    t = e.get("type", "entries")
    name = e.get("name")
    if t in ("entries", "section", "inset", "insetReadaloud", "variant", "variantSub", "variantInner", "options"):
        kids = e.get("entries", [])
        cls = "inset" if t in ("inset", "insetReadaloud", "variant") else ""
        if name and kids and isinstance(kids[0], str) and not (depth == 0 and t == "section"):
            b.p(f"<b><i>{tx(name)}.</i></b> {tx(kids[0])}", cls)
            kids = kids[1:]
        elif name:
            b.add("h", f'<h4 class="{cls}">{tx(name)}</h4>')
        for k in kids:
            if isinstance(k, str):
                b.p(tx(k), cls)
            else:
                render_entry(k, b, depth + 1)
    elif t == "list":
        for it in e.get("items", []):
            if isinstance(it, str):
                b.add("li", f'<p class="li">{tx(it)}</p>')
            elif isinstance(it, dict) and it.get("type") in ("item", "itemSub", "itemSpell"):
                body = it.get("entry")
                if body is None:
                    body = it.get("entries", [])
                if isinstance(body, list):
                    first = body[0] if body else ""
                    rest = body[1:]
                else:
                    first, rest = body, []
                nm = f"<b>{tx(it.get('name', ''))}</b> " if it.get("name") else ""
                b.add("li", f'<p class="li">{nm}{inline(first)}</p>')
                for r in rest:
                    if isinstance(r, str):
                        b.p(tx(r), "ind")
                    else:
                        render_entry(r, b, depth + 1)
            else:
                b.add("li", f'<p class="li">{inline(it)}</p>')
    elif t == "table":
        render_table(e, b)
    elif t == "tableGroup":
        for tbl in e.get("tables", []):
            render_table(tbl, b)
    elif t == "quote":
        for q in e.get("entries", []):
            b.p(f"<i>{inline(q)}</i>", "quote")
        if e.get("by"):
            b.p(f"— {tx(e['by'])}" + (f", <i>{tx(e['from'])}</i>" if e.get("from") else ""), "quote r")
    elif t in ("inline", "inlineBlock"):
        b.p(inline(e.get("entries", [])))
    elif t in ("abilityDc", "abilityAttackMod"):
        b.p(ability_line(e), "c")
    elif t == "hr":
        b.add("hr", "<hr>")
    elif t == "spellcasting":
        render_spellcasting(e, b)
    elif t in ("image", "gallery", "statblock", "statblockInline", "flowchart", "flowBlock", "homebrew", "wrapper"):
        if t == "flowBlock" or t == "flowchart":
            render_entries(e.get("entries") or e.get("blocks"), b, depth + 1)
        return
    elif t == "item":
        b.p((f"<b>{tx(name)}</b> " if name else "") + inline(e.get("entry", e.get("entries", ""))))
    elif t in ("refClassFeature", "refSubclassFeature"):
        uid = e.get("classFeature") or e.get("subclassFeature") or ""
        feat = REF_LOOKUP("classFeature" if t == "refClassFeature" else "subclassFeature", uid) if REF_LOOKUP else None
        if feat is None or uid.lower() in _REF_SEEN:
            b.p(f"<b>{tx(uid.split('|')[0])}</b>")
        else:
            _REF_SEEN.add(uid.lower())
            render_entry({"type": "entries", "name": feat.get("name"), "entries": feat.get("entries", [])}, b, depth + 1)
            _REF_SEEN.discard(uid.lower())
    elif t in ("refOptionalfeature", "refFeat"):
        b.add("li", f'<p class="li">{inline(e)}</p>')
    else:
        h = inline(e)
        if h:
            b.p(h)


# --------------------------------------------------------------------------- _copy / _mod resolution

def _walk_str(obj, fn):
    if isinstance(obj, str):
        return fn(obj)
    if isinstance(obj, list):
        return [_walk_str(x, fn) for x in obj]
    if isinstance(obj, dict):
        return {k: _walk_str(v, fn) for k, v in obj.items()}
    return obj


TEXT_PROPS = ["entries", "trait", "action", "bonus", "reaction", "legendary", "mythic", "spellcasting"]


def apply_mod(ent, prop, mod):
    mode = mod.get("mode") if isinstance(mod, dict) else mod
    if mode == "remove":
        ent.pop(prop, None)
        return
    if mode == "replaceTxt":
        flags = re.I if "i" in mod.get("flags", "") else 0
        rx = re.compile(mod["replace"], flags)
        w = re.sub(r"\$(\d)", r"\\\1", mod.get("with", ""))
        props = TEXT_PROPS if prop == "*" else [prop]
        if mod.get("props"):
            props = [p for p in mod["props"] if p]
        for p in props:
            if p in ent:
                ent[p] = _walk_str(ent[p], lambda s: rx.sub(w, s))
        return
    if mode in ("scalarAddHit", "scalarAddDc"):
        n = int(mod.get("scalar", 0))
        tag = "hit" if mode == "scalarAddHit" else "dc"
        pat = re.compile(r"\{@" + tag + r" (-?\d+)")
        props = TEXT_PROPS if prop == "*" else [prop]
        for p in props:
            if p in ent:
                ent[p] = _walk_str(ent[p], lambda s: pat.sub(lambda m: "{@" + tag + f" {int(m.group(1)) + n}", s))
        return
    if mode == "addSenses":
        senses = ent.setdefault("senses", []) or []
        for s in (mod.get("senses") if isinstance(mod.get("senses"), list) else [mod.get("senses")]):
            if s:
                senses.append(f"{s['type']} {s['range']} ft.")
        ent["senses"] = senses
        return
    if mode == "addSkills":
        sk = ent.setdefault("skill", {}) or {}
        pb = cr_pb(ent.get("cr"))
        for skill, lvl in (mod.get("skills") or {}).items():
            abil = SKILL_ABIL.get(skill, "wis")
            sk[skill] = signed((ent.get(abil, 10) - 10) // 2 + pb * int(lvl))
        ent["skill"] = sk
        return
    if mode in ("addSpells", "replaceSpells"):
        for sc in ent.get("spellcasting", []) or []:
            if mode == "addSpells":
                for k in ("will", "ritual"):
                    if mod.get(k):
                        sc.setdefault(k, []).extend(mod[k])
                for k in ("daily", "spells"):
                    for lvl, v in (mod.get(k) or {}).items():
                        if k == "spells":
                            sc.setdefault("spells", {}).setdefault(lvl, {"spells": []})["spells"].extend(v.get("spells", []))
                        else:
                            sc.setdefault("daily", {}).setdefault(lvl, []).extend(v)
            break
        return
    if mode in ("scalarAddProp", "scalarMultProp"):
        target = ent.get(prop)
        keys = [mod["prop"]] if mod.get("prop") and mod["prop"] != "*" else (list(target.keys()) if isinstance(target, dict) else [])
        for k in keys:
            try:
                v = int(str(target[k]).replace("+", ""))
                v = v + int(mod["scalar"]) if mode == "scalarAddProp" else int(v * float(mod["scalar"]))
                target[k] = signed(v) if str(target[k]).startswith(("+", "-")) else v
            except Exception:
                pass
        return
    # array modes
    arr = ent.get(prop)
    if arr is None:
        arr = []
    arr = list(arr) if isinstance(arr, list) else [arr]
    items = mod.get("items", [])
    if not isinstance(items, list):
        items = [items]

    def nm(x):
        return x.get("name") if isinstance(x, dict) else x

    if mode == "appendArr":
        arr.extend(items)
    elif mode == "prependArr":
        arr = items + arr
    elif mode == "insertArr":
        i = mod.get("index", 0)
        arr[i:i] = items
    elif mode == "appendIfNotExistsArr":
        arr.extend(x for x in items if x not in arr)
    elif mode in ("replaceArr", "replaceOrAppendArr"):
        rep = mod.get("replace")
        idx = None
        if isinstance(rep, dict) and "index" in rep:
            idx = rep["index"]
        else:
            for i, x in enumerate(arr):
                if nm(x) == rep or x == rep:
                    idx = i
                    break
        if idx is not None and idx < len(arr):
            arr[idx:idx + 1] = items
        elif mode == "replaceOrAppendArr":
            arr.extend(items)
    elif mode == "removeArr":
        names = mod.get("names") or []
        if not isinstance(names, list):
            names = [names]
        rem_items = mod.get("items") or []
        if not isinstance(rem_items, list):   # e.g. {"mode": "removeArr", "items": "cold"}
            rem_items = [rem_items]
        arr = [x for x in arr if nm(x) not in names and x not in rem_items]
    ent[prop] = arr


def resolve_copy(ent, finder, depth=0):
    cp = ent.get("_copy")
    if not cp or depth > 6:
        return ent
    base = finder(cp.get("name"), cp.get("source"))
    if base is None:
        warn(f"could not find '{cp.get('name')}' ({cp.get('source')}) that '{ent.get('name')}' copies from")
        out = dict(ent)
        out.pop("_copy", None)
        return out
    base = resolve_copy(copy.deepcopy(base), finder, depth + 1)
    preserve = cp.get("_preserve") or {}
    for k in ("srd", "basicRules", "reprintedAs", "otherSources", "page", "hasFluff", "hasFluffImages", "legendaryGroup", "_versions"):
        if k not in preserve:
            base.pop(k, None)
    for k, v in ent.items():
        if k != "_copy":
            base[k] = copy.deepcopy(v)
    for prop, mods in (cp.get("_mod") or {}).items():
        for mod in (mods if isinstance(mods, list) else [mods]):
            try:
                apply_mod(base, prop, mod)
            except Exception as ex:
                warn(f"skipped a modification on {ent.get('name')}: {ex}")
    return base


# --------------------------------------------------------------------------- categories

ORD = {1: "1st", 2: "2nd", 3: "3rd"}


def ordinal(n):
    return ORD.get(n, f"{n}th")


SCHOOL = {"A": "Abjuration", "C": "Conjuration", "D": "Divination", "E": "Enchantment", "V": "Evocation",
          "I": "Illusion", "N": "Necromancy", "T": "Transmutation", "P": "Psionic"}
SPELL_COLOR = "#3b4a8c"   # every spell card uses this colour (front frame and back)
SCHOOL_COLOR = {"A": "#2f6f9f", "C": "#a0651e", "D": "#5c7c8a", "E": "#a1457a", "V": "#b53a26",
                "I": "#6b4fa3", "N": "#3c4a3a", "T": "#3f7d3a", "P": "#8a5a9a"}
UNIT = {"action": "action", "bonus": "bonus action", "reaction": "reaction", "minute": "minute",
        "hour": "hour", "round": "round", "day": "day", "week": "week", "year": "year", "turn": "turn"}


def plural(n, word):
    return f"{n} {word}" + ("" if n == 1 else "s")


def spell_time(times):
    out = []
    for t in times or []:
        s = plural(t.get("number", 1), UNIT.get(t.get("unit"), t.get("unit", "")))
        if t.get("condition"):
            s += ", " + tx(t["condition"])
        if t.get("note"):
            s += f" ({tx(t['note'])})"
        out.append(s)
    return " or ".join(out)


def dist(d):
    if not d:
        return ""
    t = d.get("type")
    if t in ("self", "touch", "sight", "unlimited", "special"):
        return {"self": "Self", "touch": "Touch", "sight": "Sight", "unlimited": "Unlimited", "special": "Special"}[t]
    a = d.get("amount", "")
    unit = {"feet": "foot", "miles": "mile"}.get(t, t)
    return f"{a} {t}" if t in ("feet", "miles") else f"{a} {unit}"


def spell_range(r):
    if not r:
        return ""
    t = r.get("type")
    d = r.get("distance", {})
    if t in ("self", "touch", "sight", "unlimited"):
        return dist({"type": t})
    if t == "point":
        return dist(d)
    if t == "special":
        return "Special"
    if t in ("radius", "sphere", "cone", "line", "cube", "hemisphere", "cylinder", "emanation"):
        unit = {"feet": "foot", "miles": "mile"}.get(d.get("type"), d.get("type"))
        return f"Self ({d.get('amount')}-{unit} {t})"
    return dist(d)


def spell_components(c):
    if not c:
        return "", ""
    parts = [k.upper() for k in ("v", "s") if c.get(k)]
    mat = ""
    m = c.get("m")
    if m:
        parts.append("M")
        mat = m if isinstance(m, str) else m.get("text", "")
    if c.get("r"):
        parts.append("R")
    return ", ".join(parts), tx(mat)


def spell_duration(durs):
    out = []
    for d in durs or []:
        t = d.get("type")
        if t == "instant":
            out.append("Instantaneous")
        elif t == "timed":
            dd = d.get("duration", {})
            s = plural(dd.get("amount", 1), dd.get("type", ""))
            if dd.get("upTo") or d.get("concentration"):
                s = "up to " + s
            if d.get("concentration"):
                s = "Concentration, " + s
            out.append(s[0].upper() + s[1:])
        elif t == "permanent":
            ends = d.get("ends", [])
            words = {"dispel": "dispelled", "trigger": "triggered", "discharge": "discharged"}
            out.append("Until " + " or ".join(words.get(e, e) for e in ends) if ends else "Permanent")
        elif t == "special":
            out.append("Special")
        else:
            out.append(t or "")
    return " or ".join(out)


def src_line(e):
    s = e.get("source", "")
    s = SOURCE_ABBR.get(s.lower(), s)
    if e.get("page"):
        s += f" p.{e['page']}"
    return s


SCROLL_COLOR = "#7a4a1c"   # spells printed as a spell scroll
# Spell Scroll table (same in the 2014 and 2024 DMG): scroll level -> (rarity, save DC, attack bonus)
SCROLL_TABLE = {0: ("common", 13, 5), 1: ("common", 13, 5), 2: ("uncommon", 13, 5), 3: ("uncommon", 15, 7),
                4: ("rare", 15, 7), 5: ("rare", 17, 9), 6: ("very rare", 17, 9), 7: ("very rare", 18, 10),
                8: ("very rare", 18, 10), 9: ("legendary", 19, 11)}


def build_spell(e, data, scroll=None):
    """scroll: {"level", "rarity", "dc", "atk"} when this spell is on a spell scroll."""
    lvl = e.get("level", 0)
    school = e.get("school", "V")
    sname = SCHOOL.get(school) or BREW_SCHOOLS.get(school) or school
    ritual = (e.get("meta") or {}).get("ritual")
    sub = f"{sname} cantrip" if lvl == 0 else f"{ordinal(lvl)}-level {sname.lower()}"
    if ritual:
        sub += " (ritual)"
    comp, mat = spell_components(e.get("components"))
    cells = [("Casting Time", spell_time(e.get("time"))), ("Range", spell_range(e.get("range"))),
             ("Components", comp), ("Duration", spell_duration(e.get("duration")))]
    hdr = '<div class="sgrid">' + "".join(
        f'<div><span class="lbl">{a}</span>{b}</div>' for a, b in cells) + "</div>"
    if mat:
        hdr += f'<div class="mat">M: {mat}</div>'
    classes = spell_classes(e, data)
    if classes:
        hdr += f'<div class="cls">{esc(classes)}</div>'
    b = Blocks()
    render_entries(e.get("entries"), b)
    for h in e.get("entriesHigherLevel", []) or []:
        render_entries([h], b)
    color = SPELL_COLOR
    card = {
        "cat": "spell", "name": e["name"], "sub": sub, "hdr": hdr, "blocks": b.out,
        "src": src_line(e), "color": color, "corner": "C" if lvl == 0 else str(lvl),
        "back": {"kind": "spell", "label": "Spell", "big": str(lvl),
                 "bigsub": "CANTRIP" if lvl == 0 else f"{ordinal(lvl)} Level".upper(),
                 "line": sname + (" • Ritual" if ritual else ""), "icon": "star", "color": color},
    }
    if scroll:   # a spell on a spell scroll: its own colour, a scroll back, and the scroll's numbers up front
        sl = scroll["level"]
        card["color"] = SCROLL_COLOR
        card["sub"] = "Spell scroll \u2022 " + sub
        card["hdr"] = (f'<div class="scrollinfo"><b>Spell Scroll</b> \u2022 {scroll["rarity"].capitalize()} \u2022 '
                       f'Save DC {scroll["dc"]} \u2022 Attack {signed(scroll["atk"])}</div>' + hdr)
        b.p("<i>Read the scroll to cast the spell if it's on your spell list (no Material components needed); "
            "the scroll then crumbles to dust.</i>", "small")
        card["blocks"] = b.out
        card["corner"] = "C" if sl == 0 else str(sl)
        card["back"] = {"kind": "scroll", "label": "Spell Scroll", "big": str(sl),
                        "bigsub": "CANTRIP" if sl == 0 else f"{ordinal(sl)} Level".upper(),
                        "line": sname + (" • Ritual" if ritual else ""), "icon": "scroll", "color": SCROLL_COLOR}
    return card


def spell_classes(e, data):
    try:
        srcs = data.get("spells/sources.json", optional=True) or {}
        info = (srcs.get(e.get("source"), {}) or {}).get(e["name"], {})
        names = {c["name"] for c in info.get("class", [])}
        if not names:   # homebrew spells list their classes on the spell itself
            cl = e.get("classes") or {}
            names = {c.get("name") for k in ("fromClassList", "fromClassListVariant") for c in cl.get(k) or [] if c.get("name")}
        return ", ".join(sorted(names))
    except Exception:
        return ""


# ----- monsters

SIZE = {"F": "Fine", "D": "Diminutive", "T": "Tiny", "S": "Small", "M": "Medium", "L": "Large",
        "H": "Huge", "G": "Gargantuan", "C": "Colossal", "V": "Varies"}
AL = {"L": "lawful", "N": "neutral", "C": "chaotic", "G": "good", "E": "evil", "U": "unaligned",
      "A": "any alignment", "NX": "neutral", "NY": "neutral"}
XP = {"0": 10, "1/8": 25, "1/4": 50, "1/2": 100, "1": 200, "2": 450, "3": 700, "4": 1100, "5": 1800,
      "6": 2300, "7": 2900, "8": 3900, "9": 5000, "10": 5900, "11": 7200, "12": 8400, "13": 10000,
      "14": 11500, "15": 13000, "16": 15000, "17": 18000, "18": 20000, "19": 22000, "20": 25000,
      "21": 33000, "22": 41000, "23": 50000, "24": 62000, "25": 75000, "26": 90000, "27": 105000,
      "28": 120000, "29": 135000, "30": 155000}
SKILL_ABIL = {"acrobatics": "dex", "animal handling": "wis", "arcana": "int", "athletics": "str",
              "deception": "cha", "history": "int", "insight": "wis", "intimidation": "cha",
              "investigation": "int", "medicine": "wis", "nature": "int", "perception": "wis",
              "performance": "cha", "persuasion": "cha", "religion": "int", "sleight of hand": "dex",
              "stealth": "dex", "survival": "wis"}


def cr_str(cr):
    if isinstance(cr, dict):
        return cr.get("cr", "—")
    return cr if cr is not None else "—"


def cr_num(cr):
    c = cr_str(cr)
    try:
        if "/" in c:
            a, b = c.split("/")
            return int(a) / int(b)
        return float(c)
    except Exception:
        return 0


def cr_pb(cr):
    n = cr_num(cr)
    return 2 if n < 5 else min(9, 2 + math.ceil((n - 4) / 4))


def mon_size(s):
    s = s if isinstance(s, list) else [s]
    return " or ".join(SIZE.get(x, x) for x in s if x)


def mon_type(t):
    if isinstance(t, str):
        return t
    if not isinstance(t, dict):
        return ""
    base = t.get("type")
    if isinstance(base, dict):
        base = " or ".join(base.get("choose", []))
    if t.get("swarmSize"):
        base = f"swarm of {SIZE.get(t['swarmSize'], '')} {base}s"
    tags = []
    for g in t.get("tags", []) or []:
        tags.append(g if isinstance(g, str) else f"{g.get('prefix', '')} {g.get('tag', '')}".strip())
    return base + (f" ({', '.join(tags)})" if tags else "")


def alignment(al):
    if not al:
        return ""
    if isinstance(al[0], dict):
        parts = []
        for a in al:
            if a.get("special"):
                parts.append(a["special"])
            else:
                s = alignment(a.get("alignment", []))
                parts.append(s + (f" ({a['chance']}%)" if a.get("chance") else ""))
        return " or ".join(parts)
    st = set(al)
    combos = {frozenset("L NX C NY G E".split()): "any alignment",
              frozenset("L NX C NY E".split()): "any non-good alignment",
              frozenset("L NX C NY G".split()): "any non-evil alignment",
              frozenset("NX C NY G E".split()): "any non-lawful alignment",
              frozenset("L NX NY G E".split()): "any non-chaotic alignment",
              frozenset("C G E NY".split()): "any chaotic alignment",
              frozenset("L G E NY".split()): "any lawful alignment",
              frozenset("L C NX E".split()): "any evil alignment",
              frozenset("L C NX G".split()): "any good alignment"}
    if frozenset(st) in combos:
        return combos[frozenset(st)]
    if al in (["N"], ["NX", "NY"], ["N", "N"]):
        return "neutral"
    return " ".join(AL.get(x, x) for x in al)


def mon_ac(ac):
    out = []
    for a in ac or []:
        if isinstance(a, dict):
            if a.get("special"):
                out.append(tx(a["special"]))
                continue
            s = str(a.get("ac", ""))
            if a.get("from"):
                s += " (" + ", ".join(tx(f) for f in a["from"]) + ")"
            if a.get("condition"):
                s += " " + tx(a["condition"])
            out.append(s)
        else:
            out.append(str(a))
    return ", ".join(out)


def mon_hp(hp):
    if not hp:
        return ""
    if hp.get("special"):
        return tx(hp["special"])
    return f"{hp.get('average', '')} ({hp.get('formula', '')})"


def mon_speed(sp):
    if not isinstance(sp, dict):
        return str(sp or "")
    out = []
    for k in ("walk", "burrow", "climb", "fly", "swim"):
        if k not in sp:
            continue
        v = sp[k]
        if isinstance(v, dict):
            s = f"{v.get('number', '')} ft." + (f" {tx(v['condition'])}" if v.get("condition") else "")
        elif v is True:
            s = "equal to walking speed"
        else:
            s = f"{v} ft."
        if k == "fly" and sp.get("canHover") and "hover" not in s:
            s += " (hover)"
        out.append(s if k == "walk" else f"{k} {s}")
    if sp.get("choose"):
        c = sp["choose"]
        out.append(" or ".join(c.get("from", [])) + f" {c.get('amount', '')} ft.")
    return ", ".join(out)


def dmg_list(lst, key):
    out = []
    for x in lst or []:
        if isinstance(x, str):
            out.append(tx(x))
        elif isinstance(x, dict):
            if x.get("special"):
                out.append(tx(x["special"]))
                continue
            inner = dmg_list(x.get(key, []), key)
            s = (tx(x["preNote"]) + " " if x.get("preNote") else "") + inner
            if x.get("note"):
                s += " " + tx(x["note"])
            out.append(s)
    # damage types joined by commas; groups with notes by semicolons
    simple = [o for o, x in zip(out, lst or []) if isinstance(x, str)]
    complex_ = [o for o, x in zip(out, lst or []) if not isinstance(x, str)]
    res = ", ".join(simple)
    if complex_:
        res = "; ".join(([res] if res else []) + complex_)
    return res


def spell_list(lst):
    return ", ".join(inline(s) if not isinstance(s, dict) else inline(s.get("entry", "")) for s in lst)


FREQ = {"daily": "/day", "rest": "/rest", "weekly": "/week", "monthly": "/month", "yearly": "/year",
        "restLong": "/long rest", "recharge": ""}


def render_spellcasting(sc, b):
    head = " ".join(inline(h) for h in sc.get("headerEntries", []))
    b.p(f"<b><i>{tx(sc.get('name', 'Spellcasting'))}.</i></b> {head}")
    if sc.get("will"):
        b.p(f"At will: {spell_list(sc['will'])}", "ind")
    for freq, suf in FREQ.items():
        for k, v in sorted((sc.get(freq) or {}).items(), reverse=True):
            each = k.endswith("e")
            n = k.rstrip("e")
            label = f"{n}{suf}" + (" each" if each else "") if freq != "recharge" else f"Recharge {n}"
            b.p(f"{label}: {spell_list(v)}", "ind")
    for lvl, info in sorted((sc.get("spells") or {}).items(), key=lambda kv: int(kv[0])):
        lv = int(lvl)
        if lv == 0:
            lab = "Cantrips (at will)"
        else:
            slots = info.get("slots")
            lab = f"{ordinal(lv)} level" + (f" ({slots} slot{'s' if slots != 1 else ''})" if slots else "")
            if info.get("lower"):
                lab = f"{ordinal(info['lower'])}–{ordinal(lv)} level" + (f" ({slots} {ordinal(lv)}-level slots)" if slots else "")
        b.p(f"{lab}: {spell_list(info.get('spells', []))}", "ind")
    for f in sc.get("footerEntries", []) or []:
        b.p(inline(f))


def named_list(items, b, boxed=False):
    """Traits / actions.  boxed=True puts each one in its own outlined box (kept whole across sides)."""
    for it in items or []:
        t = Blocks() if boxed else b
        if it.get("type") == "spellcasting" or "headerEntries" in it:
            render_spellcasting(it, t)
        else:
            ents = it.get("entries", [])
            name = it.get("name")
            if name and ents and isinstance(ents[0], str):
                t.p(f"<b><i>{tx(name)}.</i></b> {tx(ents[0])}", "act")
                render_entries(ents[1:], t, 1)
            else:
                if name:
                    t.p(f"<b><i>{tx(name)}.</i></b>", "act")
                render_entries(ents, t, 1)
        if boxed and t.out:
            b.add("box", '<div class="mbox">' + "".join(x["h"] for x in t.out) + "</div>")


def mon_init(e):
    """2024 creatures: initiative bonus (score), e.g. '+12 (22)'."""
    ini = e.get("initiative")
    if ini is None:
        return ""
    dexmod = (e.get("dex", 10) - 10) // 2
    if isinstance(ini, bool):
        return ""
    if isinstance(ini, (int, float)):
        bonus = int(ini)
    elif isinstance(ini, dict):
        if isinstance(ini.get("initiative"), (int, float)):
            bonus = int(ini["initiative"])
        else:
            try:
                bonus = dexmod + int(ini.get("proficiency", 0)) * cr_pb(e.get("cr"))
            except Exception:
                bonus = dexmod
    else:
        return ""
    return f"{signed(bonus)} ({10 + bonus})"


def build_monster(e, data):
    sub = f"{mon_size(e.get('size'))} {mon_type(e.get('type'))}"
    al = alignment(e.get("alignment"))
    if e.get("alignmentPrefix"):
        al = tx(e["alignmentPrefix"]) + al
    if al:
        sub += ", " + al
    def score(k):
        v = e.get(k, 10)
        return v if isinstance(v, int) else 10
    abil = "".join(
        f'<div><span class="lbl">{k.upper()}</span>{score(k)} ({signed((score(k) - 10) // 2)})</div>'
        for k in ("str", "dex", "con", "int", "wis", "cha"))
    # every stat in its own outlined box; the boxes wrap onto as many rows as they need
    cells = [f'<div><b>AC</b> {mon_ac(e.get("ac"))}</div>']
    ini = mon_init(e)
    if ini:
        cells.append(f'<div><b>Initiative</b> {ini}</div>')
    cells.append(f'<div><b>HP</b> {mon_hp(e.get("hp"))}</div>')
    cells.append(f'<div><b>Speed</b> {mon_speed(e.get("speed"))}</div>')
    hdr = f'<div class="mgrid">{"".join(cells)}</div><div class="abil">{abil}</div>'
    b = Blocks()
    b.section()

    def stat(label, val):
        if val:
            b.add("box", f'<div class="mbox mstat"><b>{label}</b> {val}</div>')

    if e.get("save"):
        stat("Saving Throws", ", ".join(f"{k.title()} {v}" for k, v in e["save"].items()))
    if e.get("skill"):
        sk = []
        for k, v in e["skill"].items():
            if k == "other":
                continue
            sk.append(f"{k.title()} {v}")
        stat("Skills", ", ".join(sk))
    stat("Vulnerabilities", dmg_list(e.get("vulnerable"), "vulnerable"))
    stat("Resistances", dmg_list(e.get("resist"), "resist"))
    stat("Immunities", dmg_list(e.get("immune"), "immune"))
    stat("Condition Immunities", dmg_list(e.get("conditionImmune"), "conditionImmune"))
    senses = [tx(s) for s in e.get("senses") or []]
    if e.get("passive") is not None:
        senses.append(f"passive Perception {e['passive']}")
    stat("Senses", ", ".join(senses))
    stat("Languages", ", ".join(tx(x) for x in e.get("languages") or []) or "—")
    cr = cr_str(e.get("cr"))
    if cr != "—":
        xp = XP.get(cr)
        crs = f"{cr}" + (f" ({xp:,} XP)" if xp else "") + f"; PB {signed(cr_pb(e.get('cr')))}"
        if isinstance(e.get("cr"), dict) and e["cr"].get("lair"):
            crs += f" ({e['cr']['lair']} in lair)"
        stat("Challenge", crs)

    groups = {"trait": [], "action": [], "bonus": [], "reaction": [], "legendary": [], "mythic": []}
    for sc in e.get("spellcasting", []) or []:
        sc = dict(sc, type="spellcasting")
        da = sc.get("displayAs", "trait")
        groups.get(da if da in groups else "trait").append(sc)
    traits = (e.get("trait") or []) + groups["trait"]
    if traits:
        b.section()
        b.add("h", '<h4 class="sec">Traits</h4>')
        named_list(traits, b, boxed=True)
    sections = [("action", "Actions"), ("bonus", "Bonus Actions"), ("reaction", "Reactions"),
                ("legendary", "Legendary Actions"), ("mythic", "Mythic Actions")]
    for key, title in sections:
        items = (e.get(key) or []) + groups[key]
        if not items:
            continue
        b.section()
        b.add("h", f'<h4 class="sec">{title}</h4>')
        if key == "legendary":
            if e.get("legendaryHeader"):
                for h in e["legendaryHeader"]:
                    b.add("p", f"<p>{inline(h)}</p>", kn=1)
            else:
                n = e.get("legendaryActions", 3)
                nm = e.get("shortName") if isinstance(e.get("shortName"), str) else e["name"]
                if e.get("isNamedCreature") is not True:
                    nm = "the " + nm.lower()
                b.add("p", f"<p>{nm[0].upper() + nm[1:]} can take {n} legendary actions, choosing from the options below. "
                      f"Only one legendary action can be used at a time and only at the end of another creature's turn. "
                      f"{nm[0].upper() + nm[1:]} regains spent legendary actions at the start of its turn.</p>", kn=1)
        if key == "mythic" and e.get("mythicHeader"):
            for h in e["mythicHeader"]:
                b.add("p", f"<p>{inline(h)}</p>", kn=1)
        named_list(items, b, boxed=True)
    typ = e.get("type")
    tname = typ if isinstance(typ, str) else (typ.get("type") if isinstance(typ, dict) and isinstance(typ.get("type"), str) else "creature")
    color = "#7a1f1f"
    return {
        "cat": "monster", "name": e["name"], "sub": sub, "hdr": hdr, "blocks": b.out, "src": src_line(e),
        "color": color, "corner": cr,
        "back": {"kind": "monster", "label": "Creature", "big": cr, "bigsub": "CHALLENGE",
                 "line": f"{mon_size(e.get('size'))} {tname}".title(), "icon": "skull", "color": color},
    }


# ----- items

ITEM_TYPE = {"A": "ammunition", "AF": "ammunition", "AT": "artisan's tools", "EM": "eldritch machine",
             "EXP": "explosive", "FD": "food and drink", "G": "adventuring gear", "GS": "gaming set",
             "HA": "heavy armor", "INS": "instrument", "LA": "light armor", "M": "melee weapon",
             "MA": "medium armor", "MNT": "mount", "MR": "master rune", "GV": "generic variant",
             "P": "potion", "R": "ranged weapon", "RD": "rod", "RG": "ring", "S": "shield", "SC": "scroll",
             "SCF": "spellcasting focus", "OTH": "other", "T": "tools", "TAH": "tack and harness",
             "TG": "trade good", "$": "treasure", "$A": "art object", "$C": "coinage", "$G": "gemstone",
             "VEH": "vehicle", "SHP": "vehicle", "AIR": "vehicle", "SPC": "vehicle", "WD": "wand",
             "IDG": "illegal drug", "TB": "trade bar"}
DMG = {"A": "acid", "B": "bludgeoning", "C": "cold", "F": "fire", "O": "force", "L": "lightning",
       "N": "necrotic", "P": "piercing", "I": "poison", "Y": "psychic", "R": "radiant", "S": "slashing",
       "T": "thunder"}
PROP = {"A": "ammunition", "AF": "ammunition", "BF": "burst fire", "F": "finesse", "H": "heavy",
        "L": "light", "LD": "loading", "R": "reach", "RLD": "reload", "S": "special", "T": "thrown",
        "2H": "two-handed", "V": "versatile", "Vst": "vestige"}
RARITY_COLOR = {"common": "#6e6a62", "uncommon": "#2f7d32", "rare": "#1f5fa8", "very rare": "#6a2fa0",
                "legendary": "#c26a00", "artifact": "#a8201a", "varies": "#5a5a5a", "none": "#7a5a3a",
                "unknown": "#5a5a5a", "unknown (magic)": "#5a5a5a"}


def code(v):
    return (v or "").split("|")[0]


def money(cp):
    if cp is None:
        return ""
    if cp >= 100 and cp % 100 == 0:
        return f"{cp // 100:,} gp"
    if cp >= 100:
        return f"{cp / 100:,.2f} gp".replace(".00", "")
    if cp >= 10 and cp % 10 == 0:
        return f"{cp // 10} sp"
    return f"{cp} cp"


def item_icon(e):
    t = code(e.get("type"))
    if e.get("weapon") or t in ("M", "R", "A", "AF"):
        return "sword"
    if e.get("armor") or t in ("LA", "MA", "HA", "S"):
        return "shield"
    if t == "P":
        return "potion"
    if t == "RG":
        return "ring"
    if t == "SC":
        return "scroll"
    if t in ("WD", "RD") or e.get("staff"):
        return "wand"
    if t.startswith("$"):
        return "gem"
    return "chest"


def item_typeline(e):
    t = code(e.get("type"))
    parts = []
    if e.get("wondrous"):
        parts.append("Wondrous item")
    elif e.get("staff"):
        parts.append("Staff")
    elif e.get("weapon") or t in ("M", "R"):
        cat = e.get("weaponCategory", "")
        base = e.get("_baseName") or ""
        parts.append(f"Weapon ({base.lower()})" if base else f"{cat.title() + ' ' if cat else ''}{ITEM_TYPE.get(t, 'weapon')}".capitalize())
    elif t in ("LA", "MA", "HA"):
        base = e.get("_baseName") or ""
        parts.append(f"Armor ({base.lower()})" if base else f"Armor ({ITEM_TYPE[t].split()[0]})")
    elif t:
        parts.append(ITEM_TYPE.get(t, t).capitalize())
    elif e.get("tattoo"):
        parts.append("Tattoo")
    else:
        parts.append("Item")
    if e.get("tier"):
        parts.append(e["tier"])
    rar = e.get("rarity")
    s = ", ".join(parts)
    if rar and rar not in ("none", "unknown"):
        s += ", " + ("rarity varies" if rar in ("varies", "unknown (magic)") else rar)
    att = e.get("reqAttune")
    if att is True:
        s += " (requires attunement)"
    elif isinstance(att, str):
        s += f" (requires attunement {tx(att)})"
    return s


def item_stats(e, props_db):
    rows = []
    t = code(e.get("type"))
    if e.get("dmg1"):
        d = f"{e['dmg1']} {DMG.get(e.get('dmgType'), '')}"
        if e.get("bonusWeapon"):
            d = f"{e['dmg1']}{e['bonusWeapon']} {DMG.get(e.get('dmgType'), '')}"
        rows.append(("Damage", d.strip()))
    if t in ("LA", "MA", "HA", "S") and e.get("ac") is not None:
        ac = e["ac"]
        if t == "S":
            s = f"+{ac}"
        elif t == "LA":
            s = f"{ac} + Dex"
        elif t == "MA":
            s = f"{ac} + Dex (max 2)"
        else:
            s = str(ac)
        if e.get("bonusAc"):
            s += f" ({e['bonusAc']})"
        rows.append(("AC", s))
    props = []
    for p in e.get("property", []) or []:
        pc = code(p if isinstance(p, str) else p.get("uid", ""))
        name = props_db.get(pc) or PROP.get(pc, pc)
        if pc == "V" and e.get("dmg2"):
            name += f" ({e['dmg2']})"
        if pc in ("T", "A", "AF") and e.get("range"):
            name += f" (range {e['range']})"
        props.append(name)
    if props:
        rows.append(("Properties", ", ".join(props)))
    elif e.get("range"):
        rows.append(("Range", e["range"]))
    if e.get("mastery"):
        rows.append(("Mastery", ", ".join(code(m if isinstance(m, str) else m.get("uid", "")) for m in e["mastery"])))
    if e.get("strength"):
        rows.append(("Strength", e["strength"]))
    if e.get("stealth"):
        rows.append(("Stealth", "Disadvantage"))
    if e.get("charges"):
        rows.append(("Charges", e["charges"]))
    wv = []
    if e.get("weight"):
        wv.append(f"{e['weight']} lb.")
    if e.get("value"):
        wv.append(money(e["value"]))
    if wv:
        rows.append(("Weight/Value", ", ".join(wv)))
    return "".join(f'<div class="mline"><b>{a}</b> {tx(b)}</div>' for a, b in rows)


def build_item(e, data, ctx):
    b = Blocks()
    render_entries(e.get("entries"), b)
    if e.get("items") and e.get("_isGroup"):
        b.add("h", "<h4>Items</h4>")
        for it in e["items"]:
            b.add("li", f'<p class="li">{tx(it.split("|")[0])}</p>')
    for ae in e.get("additionalEntries", []) or []:
        render_entries([ae], b)
    if not b.out:  # mundane item: show property rules
        for p in e.get("property", []) or []:
            pc = code(p if isinstance(p, str) else p.get("uid", ""))
            pe = ctx.get("prop_entries", {}).get(pc)
            if pe:
                render_entries(pe, b)
    rar = e.get("rarity", "none")
    color = RARITY_COLOR.get(rar, "#7a5a3a")
    t = code(e.get("type"))
    kind = ("Wondrous Item" if e.get("wondrous") else
            "Weapon" if e.get("weapon") or t in ("M", "R") else
            "Armor" if t in ("LA", "MA", "HA", "S") else ITEM_TYPE.get(t, "Item").title())
    return {
        "cat": "item", "name": e["name"], "sub": item_typeline(e), "hdr": item_stats(e, ctx.get("prop_names", {})),
        "blocks": b.out, "src": src_line(e), "color": color, "corner": "",
        "back": {"kind": "item", "label": "Magic Item" if rar not in ("none", "unknown") else "Item",
                 "big": "", "bigsub": (rar if rar not in ("none", "unknown", "unknown (magic)") else "mundane").upper(),
                 "line": kind, "icon": item_icon(e), "color": color},
    }


# ----- everything else

def prereq(e):
    out = []
    for p in e.get("prerequisite", []) or []:
        bits = []
        for k, v in p.items():
            if k == "level":
                lv = v if isinstance(v, int) else v.get("level")
                cl = "" if isinstance(v, int) else (v.get("class") or {}).get("name", "")
                bits.append(f"{ordinal(lv)} level" + (f" {cl}" if cl else ""))
            elif k == "ability":
                ab = []
                for d in v:
                    ab.append(" or ".join(f"{ABIL.get(a, a)} {n}+" for a, n in d.items()))
                bits.append(" or ".join(ab))
            elif k == "race":
                bits.append(" or ".join((r.get("displayEntry") or r["name"]).title() for r in v))
            elif k == "spellcasting" or k == "spellcasting2020":
                bits.append("The ability to cast at least one spell")
            elif k == "pact":
                bits.append(f"Pact of the {v}")
            elif k == "patron":
                bits.append(f"{v} patron")
            elif k == "spell":   # "eldritch blast#c", or {"entry": "a Warlock Cantrip That Deals Damage", ...} (2024)
                bits.append(", ".join(tx(s.get("entry") or s.get("entrySummary") or "") if isinstance(s, dict)
                                      else tx(s.split("#")[0]).split("|")[0].title() for s in v))
            elif k == "feat":
                bits.append(", ".join(f.split("|")[0].title() for f in v) + " feat")
            elif k == "feature":
                bits.append(", ".join(v))
            elif k == "other" or k == "otherSummary":
                bits.append(tx(v if isinstance(v, str) else v.get("entry", "")))
            elif k == "proficiency":
                for d in v:
                    for kk, vv in d.items():
                        bits.append(f"Proficiency with {vv} {kk}")
            elif k == "campaign":
                bits.append(", ".join(v) + " campaign")
            elif k == "background":
                bits.append(" or ".join(x["name"] for x in v) + " background")
        if bits:
            out.append(", ".join(bits))
    return "Prerequisite: " + " or ".join(out) if out else ""


OPT_FEATURE = {"EI": "Eldritch Invocation", "MM": "Metamagic", "MV:B": "Maneuver", "AS": "Arcane Shot",
               "PB": "Pact Boon", "AI": "Artificer Infusion", "ED": "Elemental Discipline", "RN": "Rune Knight Rune",
               "FS:F": "Fighting Style", "FS:B": "Fighting Style", "FS:P": "Fighting Style", "FS:R": "Fighting Style",
               "OTH": "Other", "TT": "Traveler's Trick", "RP": "Renaissance Power", "AF": "Alchemical Formula"}

GENERIC = {
    # page: (file, keys, label, icon, color)
    "feats.html": ("feats.json", ["feat"], "Feat", "medal", "#2e5d4b"),
    "backgrounds.html": ("backgrounds.json", ["background"], "Background", "scroll", "#6b4f2a"),
    "races.html": ("races.json", ["race", "subrace"], "Species", "person", "#3c5a8a"),
    "conditionsdiseases.html": ("conditionsdiseases.json", ["condition", "disease", "status"], "Condition", "flame", "#4a4a4a"),
    "optionalfeatures.html": ("optionalfeatures.json", ["optionalfeature"], "Optional Feature", "medal", "#4b5d2e"),
    "rewards.html": ("rewards.json", ["reward"], "Reward", "gem", "#8a6d1a"),
    "trapshazards.html": ("trapshazards.json", ["trap", "hazard"], "Trap / Hazard", "skull", "#5e3a1e"),
    "objects.html": ("objects.json", ["object"], "Object", "chest", "#5a5048"),
    "languages.html": ("languages.json", ["language"], "Language", "scroll", "#3a5f6b"),
    "deities.html": ("deities.json", ["deity"], "Deity", "sun", "#9a7b1a"),
    "actions.html": ("actions.json", ["action"], "Action", "sword", "#3f4f6a"),
    "variantrules.html": ("variantrules.json", ["variantrule"], "Rule", "book", "#3f4f6a"),
    "psionics.html": ("psionics.json", ["psionic"], "Psionic", "star", "#7a3f8a"),
    "charcreationoptions.html": ("charcreationoptions.json", ["charoption"], "Character Option", "person", "#3c5a8a"),
    "cultsboons.html": ("cultsboons.json", ["cult", "boon"], "Cult / Boon", "sun", "#6a2a2a"),
    "senses.html": ("senses.json", ["sense"], "Sense", "eye", "#3a5f6b"),
    "skills.html": ("skills.json", ["skill"], "Skill", "book", "#3f4f6a"),
    "decks.html": ("decks.json", ["card"], "Card", "star", "#4a3a6a"),
}


def build_generic(e, page, kind):
    file, keys, label, icon, color = GENERIC[page]
    sub_bits = []
    if kind == "condition" or kind == "disease" or kind == "status":
        label = kind.title()
    if kind == "hazard":
        label = "Hazard"
    elif kind == "trap":
        label = "Trap"
    if kind == "subrace":
        label = "Subrace"
    if page == "optionalfeatures.html":
        ft = e.get("featureType", [])
        label = OPT_FEATURE.get(ft[0], "Optional Feature") if ft else label
    if page == "feats.html" and e.get("category"):
        label = {"O": "Origin Feat", "G": "General Feat", "FS": "Fighting Style Feat",
                 "EB": "Epic Boon Feat"}.get(e["category"], "Feat")
    sub_bits.append(label)
    pr = prereq(e)
    hdr = ""
    if pr:
        hdr += f'<div class="mline"><i>{pr}</i></div>'
    if page == "races.html":
        if e.get("size"):
            hdr += f'<div class="mline"><b>Size</b> {mon_size(e["size"])}</div>'
        if e.get("speed"):
            sp = e["speed"]
            hdr += f'<div class="mline"><b>Speed</b> {mon_speed(sp) if isinstance(sp, dict) else str(sp) + " ft."}</div>'
        if e.get("ability"):
            ab = []
            for a in e["ability"]:
                for k, v in a.items():
                    if k == "choose":
                        ab.append("choose " + str(v.get("count", 1)) + " +" + str(v.get("amount", 1)))
                    else:
                        ab.append(f"{k.title()} {signed(v)}")
            hdr += f'<div class="mline"><b>Ability</b> {", ".join(ab)}</div>'
    if page == "deities.html":
        for k, lab in (("title", ""), ("pantheon", "Pantheon"), ("alignment", "Alignment"), ("domains", "Domains"), ("symbol", "Symbol")):
            v = e.get(k)
            if not v:
                continue
            if k == "alignment":
                v = alignment(v)
            elif isinstance(v, list):
                v = ", ".join(v)
            hdr += f'<div class="mline">{"<b>" + lab + "</b> " if lab else "<i>"}{tx(v)}{"" if lab else "</i>"}</div>'
    if page == "languages.html":
        for k, lab in (("type", "Type"), ("typicalSpeakers", "Typical Speakers"), ("script", "Script")):
            v = e.get(k)
            if v:
                hdr += f'<div class="mline"><b>{lab}</b> {tx(", ".join(v) if isinstance(v, list) else str(v).title())}</div>'
    if page == "actions.html" and e.get("time"):
        tm = [spell_time([t]) if isinstance(t, dict) else str(t) for t in e["time"]]
        hdr += f'<div class="mline"><b>Time</b> {" or ".join(tm)}</div>'
    if page == "objects.html":
        if e.get("ac"):
            hdr += f'<div class="mline"><b>AC</b> {e["ac"]}</div>'
        if e.get("hp"):
            hdr += f'<div class="mline"><b>HP</b> {e["hp"]}</div>'
    if page == "trapshazards.html" and e.get("trapHazType"):
        hdr += f'<div class="mline"><i>{e["trapHazType"]}</i></div>'
    b = Blocks()
    render_entries(e.get("entries") or e.get("entriesTemplate") or [], b)
    if e.get("_isSubraceOf"):
        sub_bits[0] = f"Subrace of {e['_isSubraceOf']}"
    return {
        "cat": "other", "name": e["name"], "sub": " • ".join(sub_bits), "hdr": hdr, "blocks": b.out,
        "src": src_line(e), "color": color, "corner": "",
        "back": {"kind": "other", "label": label, "big": "", "bigsub": label.upper(), "line": "",
                 "icon": icon, "color": color},
    }


# --------------------------------------------------------------------------- class features

def _is_official_class_source(d, source):
    """True if `source` is one of the books already in the official class file `d`."""
    s = _low(source)
    return any(_low(x.get("source")) == s for k in ("class", "subclass") for x in (d or {}).get(k, []))


CLASS_COLOR = {"artificer": "#8a5a2b", "barbarian": "#9b2c1f", "bard": "#8a3d7a", "cleric": "#7a6a2a",
               "druid": "#3f6b2a", "fighter": "#5a4a3a", "monk": "#2f6f6f", "mystic": "#6a4a8a",
               "paladin": "#a07a1a", "ranger": "#2f5a3a", "rogue": "#3a3a44", "sidekick": "#5a5a5a",
               "sorcerer": "#a82838", "warlock": "#5a2a7a", "wizard": "#2a4f8f"}


def _int(v):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return None


def unpack_cf_uid(uid):
    """name|className|classSource|level|source  (5etools classFeature reference)"""
    p = [x.strip() for x in str(uid).split("|")] + [""] * 6
    cs = p[2] or "PHB"
    return {"name": p[0], "className": p[1], "classSource": cs, "level": _int(p[3]), "source": p[4] or cs}


def unpack_scf_uid(uid):
    """name|className|classSource|subclassShortName|subclassSource|level|source"""
    p = [x.strip() for x in str(uid).split("|")] + [""] * 8
    cs, scs = p[2] or "PHB", p[4] or "PHB"
    return {"name": p[0], "className": p[1], "classSource": cs, "subclassShortName": p[3],
            "subclassSource": scs, "level": _int(p[5]), "source": p[6] or scs}


def _low(v):
    return str(v or "").lower()


def build_class_feature(f, sc=None):
    b = Blocks()
    render_entries(f.get("entries"), b)
    level = f.get("level")
    cname = f.get("className", "")
    color = CLASS_COLOR.get(cname.lower(), "#3f4f6a")
    is_sub = "subclassShortName" in f
    if is_sub:
        short = f.get("subclassShortName", "")
        sub = f"{(sc or {}).get('name') or short} ({cname}) feature \u2022 Level {level}"
        line = f"{short} \u2022 {cname}"
    else:
        sub = f"{cname} feature \u2022 Level {level}"
        line = cname
    return {
        "cat": "feature", "name": f.get("name", ""), "sub": esc(sub), "hdr": "", "blocks": b.out,
        "src": src_line(f), "color": color, "corner": str(level or ""),
        "back": {"kind": "feature", "label": "Subclass Feature" if is_sub else "Class Feature",
                 "big": str(level or ""), "bigsub": "LEVEL", "line": line, "icon": "medal", "color": color},
    }


# --------------------------------------------------------------------------- list cards
# A "list card" is a filtered list from a 5e.tools page (e.g. all 1st-level Wizard spells) as a compact table:
# one row per entry with its key details, no descriptions.

class ListSpec:
    def __init__(self, title, urls, note=""):
        self.title, self.urls, self.note = title, urls, note

    def __repr__(self):
        return f"[list] {self.title} ({len(self.urls)})"


TIME_SHORT = {"action": "A", "bonus": "BA", "reaction": "R", "minute": "min", "hour": "hr", "round": "rd",
              "day": "day", "turn": "turn", "week": "wk", "year": "yr"}
RARITY_SHORT = {"common": "Common", "uncommon": "Uncommon", "rare": "Rare", "very rare": "V. rare",
                "legendary": "Legendary", "artifact": "Artifact", "varies": "Varies", "unknown (magic)": "?"}
FEAT_CAT = {"O": "Origin", "G": "General", "FS": "Fighting Style", "EB": "Epic Boon", "D": "Dragonmark"}


def _short_time(times):
    out = []
    for t in times or []:
        u, n = t.get("unit", ""), t.get("number", 1)
        if u in ("action", "bonus", "reaction"):
            out.append(TIME_SHORT[u] if n == 1 else f"{n} {TIME_SHORT[u]}")
        else:
            out.append(f"{n} {TIME_SHORT.get(u, u)}")
    return "/".join(out)


def _short_range(r):
    if not r:
        return ""
    t, d = r.get("type"), r.get("distance") or {}
    dt, amt = d.get("type"), d.get("amount")
    if dt in ("self", "touch", "sight", "unlimited", "special"):
        base = {"self": "Self", "touch": "Touch", "sight": "Sight", "unlimited": "Unlimited", "special": "Special"}[dt]
        return base if t == "point" else f"{base} ({t})"
    unit = "ft" if dt == "feet" else "mi" if dt == "miles" else (dt or "")
    if t == "point":
        return f"{amt} {unit}".strip()
    if t == "special":
        return "Special"
    return f"{amt}-{unit} {t}"


def _plain(h):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", h or "")).strip()


def list_columns(page, ents):
    """(column headers, which columns stay on one line, row function) for a page's list card."""
    if page == "spells.html":
        def row(e):
            lvl = e.get("level", 0)
            nm = e["name"] + (" (R)" if (e.get("meta") or {}).get("ritual") else "")
            school = SCHOOL.get(e.get("school")) or BREW_SCHOOLS.get(e.get("school")) or e.get("school", "")
            conc = any(d.get("concentration") for d in e.get("duration") or [])
            return [esc(nm), "C" if lvl == 0 else str(lvl), _short_time(e.get("time")), school[:3], "C" if conc else "",
                    esc(_short_range(e.get("range")))]
        return ["Name", "Lv", "Time", "Sch.", "C", "Range"], [1, 2, 3, 4], row
    if page == "bestiary.html":
        def row(e):
            typ = e.get("type")
            base = typ if isinstance(typ, str) else (typ or {}).get("type", "")
            base = base if isinstance(base, str) else " / ".join((base or {}).get("choose", []))
            ac = e.get("ac") or [""]
            ac0 = ac[0].get("ac", "") if isinstance(ac[0], dict) else ac[0]
            hp = (e.get("hp") or {}).get("average", (e.get("hp") or {}).get("special", ""))
            return [esc(e["name"]), esc(cr_str(e.get("cr"))), esc(str(base).title()), esc(str(ac0)), esc(str(hp))]
        return ["Name", "CR", "Type", "AC", "HP"], [1, 3, 4], row
    if page == "items.html":
        magic = any(_low(e.get("rarity")) not in ("none", "unknown", "") for e in ents)

        def kind(e):
            t = code(e.get("type"))
            if e.get("wondrous"):
                return "Wondrous"
            if e.get("staff"):
                return "Staff"
            if e.get("weapon") or t in ("M", "R"):
                return "Weapon"
            if t in ("LA", "MA", "HA"):
                return "Armor"
            return {"S": "Shield", "P": "Potion", "RG": "Ring", "RD": "Rod", "SC": "Scroll", "WD": "Wand",
                    "A": "Ammo", "AF": "Ammo", "G": "Gear", "INS": "Instrument", "AT": "Tools", "T": "Tools",
                    "GS": "Gaming set", "MNT": "Mount", "TAH": "Tack"}.get(t, ITEM_TYPE.get(t, "Item").capitalize())
        if magic:
            def row(e):
                return [esc(e["name"]), kind(e), RARITY_SHORT.get(_low(e.get("rarity")), "\u2014"), "\u2713" if e.get("reqAttune") else ""]
            return ["Name", "Type", "Rarity", "Att."], [1, 2, 3], row

        def row(e):
            return [esc(e["name"]), kind(e), money(e.get("value")) if e.get("value") else "\u2014",
                    f"{e['weight']} lb." if e.get("weight") else "\u2014"]
        return ["Name", "Type", "Cost", "Weight"], [1, 2, 3], row
    if page == "feats.html":
        def row(e):
            return [esc(e["name"]), FEAT_CAT.get(e.get("category"), e.get("category") or ""),
                    esc(_plain(prereq(e)).replace("Prerequisite: ", ""))]
        return ["Name", "Category", "Prerequisite"], [1], row
    if page == "optionalfeatures.html":
        def row(e):
            ft = (e.get("featureType") or [""])[0]
            return [esc(e["name"]), OPT_FEATURE.get(ft, ft), esc(_plain(prereq(e)).replace("Prerequisite: ", ""))]
        return ["Name", "Type", "Prerequisite"], [1], row
    if page == "races.html":
        def row(e):
            sp = e.get("speed")
            sp = sp.get("walk", "") if isinstance(sp, dict) else sp
            return [esc(e["name"]), mon_size(e.get("size") or []), f"{sp} ft." if sp not in (None, "") else ""]
        return ["Name", "Size", "Speed"], [1, 2], row
    if page == "backgrounds.html":
        def row(e):
            sk = sorted({k.title() for d in e.get("skillProficiencies") or [] for k in d if k not in ("choose", "any")})
            return [esc(e["name"]), esc(", ".join(sk))]
        return ["Name", "Skills"], [], row
    if page == "deities.html":
        def row(e):
            return [esc(e["name"]), esc(e.get("pantheon", "")), esc(alignment(e.get("alignment")) if e.get("alignment") else ""),
                    esc(", ".join(e.get("domains") or []))]
        return ["Name", "Pantheon", "Alignment", "Domains"], [], row
    if page == "conditionsdiseases.html":
        def row(e):
            return [esc(e["name"]), (e.get("__kind") or "condition").title()]
        return ["Name", "Type"], [1], row

    def row(e):
        return [esc(e["name"]), esc(SOURCE_ABBR.get(_low(e.get("source")), e.get("source", "")))]
    return ["Name", "Source"], [1], row


LIST_STYLE = {"spells.html": ("spell", "Spell List", "spells", "star", SPELL_COLOR),
              "items.html": ("item", "Item List", "items", "chest", "#7a5a3a"),
              "bestiary.html": ("monster", "Creature List", "creatures", "skull", "#7a1f1f")}


def build_list_card(spec, entries):
    """entries: [(page, entity, kind)] in list order."""
    page = entries[0][0]
    ents = [e for _, e, _ in entries]
    for (_, e, k) in entries:
        e["__kind"] = k
    heads, nowrap, row = list_columns(page, ents)
    cls = lambda i: ' class="nw"' if i in nowrap else ""
    html_rows = "".join("<tr>" + "".join(f"<td{cls(i)}>{c}</td>" for i, c in enumerate(row(e))) + "</tr>" for e in ents)
    table = ('<table class="lst"><thead><tr>' + "".join(f"<th{cls(i)}>{h}</th>" for i, h in enumerate(heads)) +
             f"</tr></thead><tbody>{html_rows}</tbody></table>")
    if page in LIST_STYLE:
        cat, label, noun, icon, color = LIST_STYLE[page]
    else:
        _, _, glabel, icon, color = GENERIC.get(page, ("", [], "Entry", "book", "#3f4f6a"))
        plural = {"Species": "species", "Deity": "deities", "Trap / Hazard": "traps & hazards", "Cult / Boon": "cults & boons",
                  "Optional Feature": "features", "Character Option": "options"}
        cat, label, noun = "other", f"{glabel} List", plural.get(glabel, glabel.lower() + "s")
    n = len(ents)
    srcs = []
    for e in ents:
        a = SOURCE_ABBR.get(_low(e.get("source")), e.get("source", ""))
        if a and a not in srcs:
            srcs.append(a)
    sub = f"{n} {noun if n != 1 else 'entry'}" + (f" \u2022 {esc(spec.note)}" if spec.note else "")
    return {
        "cat": "list", "name": spec.title, "sub": sub, "hdr": "", "blocks": [{"k": "table", "h": table}],
        "src": ", ".join(srcs[:6]) + (" \u2026" if len(srcs) > 6 else ""), "color": color, "corner": str(n),
        "isList": True,
        "back": {"kind": "list", "label": label, "big": str(n), "bigsub": noun.upper(), "line": spec.title,
                 "icon": icon, "color": color},
    }


# --------------------------------------------------------------------------- loot cards
# A result from the 5e.tools Loot Generator: coins, gems, art objects, trinkets and magic items on one card.

class LootSpec:
    def __init__(self, title, note=""):
        self.title, self.note = title, note
        self.coins, self.gems, self.art, self.other, self.items = [], [], [], [], []   # items: [(url, display name)]

    @property
    def urls(self):
        return [u for u, _ in self.items]

    def __repr__(self):
        return f"[loot] {self.title}"


def build_loot_card(spec, item_rows):
    """item_rows: [(display name, entity or None)]"""
    b = Blocks()
    if spec.coins:
        b.add("h", "<h4>Coins</h4>")
        b.p(" \u2022 ".join(esc(c) for c in spec.coins))
    trinkets = {}
    for t in spec.other:   # the same trinket rolled several times -> "... ×3"
        trinkets[t] = trinkets.get(t, 0) + 1
    other = [t + (f" \u00d7{n}" if n > 1 else "") for t, n in trinkets.items()]
    for label, rows in (("Gemstones", spec.gems), ("Art objects", spec.art), ("Trinkets", other)):
        if rows:
            b.add("h", f"<h4>{label}</h4>")
            for r in rows:
                head, _, rest = r.partition(": ")
                b.add("li", f'<p class="li"><b>{esc(head)}:</b> {esc(rest)}</p>' if rest else f'<p class="li">{esc(r)}</p>')
    if item_rows:
        heads, nowrap, row = list_columns("items.html", [{"rarity": "rare"}])   # the magic-item columns
        cls = lambda i: ' class="nw"' if i in nowrap else ""
        trs = []
        for name, e in item_rows:
            cells = row(e) if e else ["", "", "\u2014", ""]
            cells[0] = esc(name)
            trs.append("<tr>" + "".join(f"<td{cls(i)}>{c}</td>" for i, c in enumerate(cells)) + "</tr>")
        b.add("h", f"<h4>Magic items ({len(item_rows)})</h4>")
        b.add("table", '<table class="lst"><thead><tr>' + "".join(f"<th{cls(i)}>{h}</th>" for i, h in enumerate(heads)) +
              "</tr></thead><tbody>" + "".join(trs) + "</tbody></table>")
    if not b.out:
        b.p("<i>No loot!</i>")
    color = "#8a6d1a"
    n = len(item_rows)
    return {
        "cat": "loot", "name": spec.title, "sub": esc(spec.note or "Treasure"), "hdr": "", "blocks": b.out,
        "src": "Loot Generator", "color": color, "corner": str(n) if n else "", "isList": True,
        "back": {"kind": "loot", "label": "Treasure", "big": str(n) if n else "", "bigsub": ("MAGIC ITEM" if n == 1 else "MAGIC ITEMS") if n else "TREASURE",
                 "line": spec.title, "icon": "chest", "color": color},
    }


# --------------------------------------------------------------------------- lookup

def ent_hash(e, page=""):
    if page == "deities.html":
        return f"{e.get('name', '')}_{e.get('pantheon', '')}_{e.get('source', '')}".lower()
    if page == "races.html" and e.get("raceName"):
        return f"{e.get('name', '')} ({e.get('raceName')})_{e.get('source', '')}".lower()
    return f"{e.get('name', '')}_{e.get('source', '')}".lower()


def parse_link(url):
    """Return (page, hash) where hash is 'name_source' lowercased and unquoted."""
    url = url.strip()
    u = urllib.parse.urlparse(url)
    page = u.path.rsplit("/", 1)[-1].lower() or "index.html"
    # split off ",state:..." parts before decoding: a name's own commas are encoded as %2C
    frag = urllib.parse.unquote(u.fragment.split(",")[0]).strip().lower()
    return page, frag, u


# ----- pictures (monster tokens and the artwork 5e.tools shows for monsters and items)

IMG_BASE = "https://raw.githubusercontent.com/5etools-mirror-3/5etools-img/main/"


def img_url(href):
    """An image href from the 5etools data -> a full address, or None."""
    if not isinstance(href, dict):
        return None
    if href.get("type") == "external" and isinstance(href.get("url"), str) and href["url"]:
        return href["url"]
    if isinstance(href.get("path"), str) and href["path"]:
        return IMG_BASE + urllib.parse.quote(href["path"])
    return None


def token_name(name):
    """The file name 5e.tools gives a creature's token: accents dropped, Æ spelled out, no quotes."""
    s = re.sub("[\u0300-\u036f]", "", unicodedata.normalize("NFD", name))
    return s.replace("Æ", "AE").replace("æ", "ae").replace('"', "")


class Resolver:
    def __init__(self, data, images=False):
        self.data = data
        self.images = images   # look up pictures for monster and item cards
        self._items = None

    def _indexed(self, folder, key, source):
        idx = self.data.get(f"{folder}/index.json")
        fn = None
        for s, f in idx.items():
            if s.lower() == source.lower():
                fn = f
                break
        if not fn:   # not an official source: homebrew / partnered / prerelease
            return (self.data.brew(source) or {}).get(key, [])
        return self.data.get(f"{folder}/{fn}").get(key, [])

    def _finder_indexed(self, folder, key):
        def find(name, source):
            for x in self._indexed(folder, key, source or ""):
                if x.get("name", "").lower() == (name or "").lower():
                    return x
            return None
        return find

    def resolve(self, url, raw=False):
        page, h, u = parse_link(url)
        if page == "classes.html":
            if raw:
                raise ValueError("class features can't go in a list card")
            return self.resolve_class_feature(u)
        if not h or "_" not in h:
            raise ValueError("link has no entry selected (the part after # is missing)")
        src = h.rsplit("_", 1)[1]
        if page == "spells.html":
            for e in self._indexed("spells", "spell", src):
                if ent_hash(e) == h:
                    e = resolve_copy(copy.deepcopy(e), self._finder_indexed("spells", "spell"))
                    return (page, e, "spell") if raw else build_spell(e, self.data, self._scroll_info(u, e))
        elif page == "bestiary.html":
            for e in self._indexed("bestiary", "monster", src):
                if ent_hash(e) == h:
                    e = resolve_copy(copy.deepcopy(e), self._finder_indexed("bestiary", "monster"))
                    if raw:
                        return page, e, "monster"
                    return self._with_images(build_monster(e, self.data), "monster", e)
        elif page == "items.html":
            e, ctx = self.find_item(h)
            if e:
                return (page, e, "item") if raw else self._with_images(build_item(e, self.data, ctx), "item", e)
        elif page in GENERIC:
            file, keys, *_ = GENERIC[page]
            d = self.data.get(file)
            brew = None
            if not any(ent_hash(e, page) == h for k in keys for e in d.get(k, [])):
                brew = self.data.brew(src)   # homebrew / partnered / prerelease entry
            for k in keys:
                pool = ((brew or {}).get(k) or []) + d.get(k, [])
                for e in pool:
                    if k == "subrace":
                        if not e.get("name"):
                            continue
                        e = dict(e, raceName=e.get("raceName"), name=f"{e['name']}", _isSubraceOf=e.get("raceName"))
                    if ent_hash(e, page) == h or (k == "subrace" and f"{e['name']} ({e.get('raceName')})_{e.get('source')}".lower() == h):
                        finder = lambda n, s, pool=pool: next((x for x in pool if x.get("name", "").lower() == (n or "").lower() and x.get("source", "").lower() == (s or "").lower()), None)
                        e = resolve_copy(copy.deepcopy(e), finder)
                        return (page, e, k) if raw else build_generic(e, page, k)
        else:
            raise ValueError(f"'{page}' pages aren't supported yet (spells, items, bestiary, class features, feats, backgrounds, "
                             f"races, conditions, optional features, rewards, traps, objects, deities, languages, actions, rules are)")
        raise ValueError("couldn't find that entry in the 5e.tools data, its partnered/homebrew collection or prerelease content")

    # ----- pictures
    def _fluff_pool(self, kind, source):
        source = source or ""
        if kind == "monster":
            idx = self.data.get("bestiary/fluff-index.json", optional=True) or {}
            fn = next((f for s, f in idx.items() if s.lower() == source.lower()), None)
            if fn:
                return (self.data.get(f"bestiary/{fn}", optional=True) or {}).get("monsterFluff") or []
            return (self.data.brew(source) or {}).get("monsterFluff") or []
        pool = (self.data.get("fluff-items.json", optional=True) or {}).get("itemFluff") or []
        if any((x.get("source") or "").lower() == source.lower() for x in pool):
            return pool
        return (self.data.brew(source) or {}).get("itemFluff") or []

    def _find_fluff(self, kind, name, source):
        def find(n, s):
            return next((x for x in self._fluff_pool(kind, s)
                         if (x.get("name") or "").lower() == (n or "").lower()
                         and (x.get("source") or "").lower() == (s or "").lower()), None)
        f = find(name, source)
        return resolve_copy(copy.deepcopy(f), find) if f else None

    def images_for(self, kind, e):
        """{"art": artwork address, "token": round token address} (either may be None), or None if neither."""
        fl = e.get("fluff") if isinstance(e.get("fluff"), dict) else None   # homebrew can carry its pictures inline
        if not (fl and fl.get("images")) and e.get("hasFluffImages"):
            fl = self._find_fluff(kind, e.get("name"), e.get("source"))
        art = None
        for im in (fl or {}).get("images") or []:
            art = img_url(im.get("href")) if isinstance(im, dict) else None
            if art:
                break
        token = None
        if kind == "monster":
            if isinstance(e.get("tokenUrl"), str) and e["tokenUrl"]:
                token = e["tokenUrl"]
            elif e.get("hasToken"):
                t = e.get("token") if isinstance(e.get("token"), dict) else {}
                token = IMG_BASE + urllib.parse.quote(
                    f"bestiary/tokens/{t.get('source') or e.get('source')}/{token_name(t.get('name') or e['name'])}.webp")
        return {"art": art, "token": token} if art or token else None

    def _with_images(self, card, kind, e):
        if self.images:
            try:
                im = self.images_for(kind, e)
            except Exception as ex:
                im = None
                warn(f"couldn't look up the pictures for {e.get('name')}: {ex}")
            if im:
                card["img"] = im
        return card

    # ----- spell scrolls: a spell link with ",cardforge:scroll~<scroll item hash>" (the hash may be empty)
    def _scroll_info(self, u, spell):
        part = next((p for p in u.fragment.split(",")[1:] if p.lower().startswith("cardforge:scroll")), None)
        if part is None:
            return None
        level = spell.get("level", 0)
        rarity, dc, atk = SCROLL_TABLE.get(level, SCROLL_TABLE[9])
        scroll_hash = urllib.parse.unquote(part.split("~", 1)[1]).strip().lower() if "~" in part else ""
        if scroll_hash:
            try:
                it, _ = self.find_item(scroll_hash)
                if it:
                    level = it.get("spellScrollLevel", level)
                    m = re.search(r"\((\d+)", it.get("name", ""))
                    if "spellScrollLevel" not in it and m:
                        level = int(m.group(1))
                    rarity, dc, atk = SCROLL_TABLE.get(level, (rarity, dc, atk))
                    if it.get("rarity") not in (None, "", "varies", "unknown", "unknown (magic)", "none"):
                        rarity = it["rarity"]
                    t = json.dumps(it.get("entries", []))
                    m = re.search(r"save DC is (\d+),? and the attack bonus is (?:\{@hit )?\+?(\d+)", t)
                    if m:
                        dc, atk = int(m.group(1)), int(m.group(2))
            except Exception:
                pass
        return {"level": level, "rarity": rarity, "dc": dc, "atk": atk}

    # ----- list cards
    def build_list(self, spec):
        entries, missing = [], []
        for url in spec.urls:
            try:
                entries.append(self.resolve(url, raw=True))
            except Exception as e:
                missing.append(f"{url} ({e})")
        if not entries:
            raise ValueError("none of the entries in this list could be found")
        pages = {p for p, _, _ in entries}
        if len(pages) > 1:
            raise ValueError("a list card can only hold entries from one page (e.g. only spells)")
        for m in missing[:5]:
            warn(f"left out of '{spec.title}': {m}")
        if len(missing) > 5:
            warn(f"... and {len(missing) - 5} more left out of '{spec.title}'")
        return build_list_card(spec, entries)

    def build_loot(self, spec):
        rows = []
        for url, name in spec.items:
            ent = None
            try:
                page, e, _ = self.resolve(url, raw=True)
                ent = e if page == "items.html" else None
                name = name or e.get("name", "")
            except Exception as ex:
                warn(f"'{spec.title}': couldn't look up {name or url} ({ex}) - listed without details")
            rows.append((name or urllib.parse.unquote(url.split("#")[-1]).rsplit("_", 1)[0].title(), ent))
        return build_loot_card(spec, rows)

    # ----- class features
    def class_data(self, class_name):
        idx = self.data.get("class/index.json")
        fn = next((f for k, f in idx.items() if k.lower() == class_name.lower()), None)
        if fn:
            return self.data.get(f"class/{fn}")
        for f in idx.values():   # e.g. the three sidekick classes share class-sidekick.json
            d = self.data.get(f"class/{f}")
            if any(_low(c.get("name")) == class_name.lower() for c in d.get("class", [])):
                return d
        raise ValueError(f"no class called '{class_name}' in the 5e.tools data")

    def _find_via_subclass(self, want):
        """Some subclasses reuse another subclass's features; follow the subclass's own feature list."""
        try:
            d = self.class_data(want["className"])
        except ValueError:
            d = {}
        b = self.data.brew(want["subclassSource"]) if not _is_official_class_source(d, want["subclassSource"]) else None
        if b:
            d = {k: (b.get(k) or []) + (d.get(k) or []) for k in ("class", "subclass", "classFeature", "subclassFeature")}
        norm = lambda x: re.sub(r"[^a-z0-9]+", "", _low(x))
        subs = [x for x in d.get("subclass", []) if _low(x.get("className")) == _low(want["className"])
                and _low(x.get("shortName")) == _low(want["subclassShortName"]) and _low(x.get("source")) == _low(want["subclassSource"])]
        subs.sort(key=lambda x: _low(x.get("classSource")) != _low(want.get("classSource")))
        uids = []
        for sc in subs:
            for ref in sc.get("subclassFeatures", []):
                uid = ref if isinstance(ref, str) else (ref or {}).get("subclassFeature", "")
                uids.append(uid)
                top = self._find_feature("subclassFeature", unpack_scf_uid(uid))
                for e in (top or {}).get("entries", []):   # features nested in the subclass's intro feature
                    if isinstance(e, dict) and e.get("type") == "refSubclassFeature":
                        uids.append(e.get("subclassFeature", ""))
        for uid in uids:
            u = unpack_scf_uid(uid)
            if norm(u["name"]) == norm(want["name"]) and (not want.get("level") or u["level"] == want["level"]):
                return self._find_feature("subclassFeature", u)
        return None

    def _find_feature(self, kind, want, loose=False):
        """kind: classFeature | subclassFeature; want: unpacked uid (level/source may be None)."""
        try:
            d = self.class_data(want["className"])
        except ValueError:
            d = {}
        brew_src = want.get("subclassSource") if kind == "subclassFeature" else want.get("classSource")
        b = self.data.brew(brew_src) if brew_src and not _is_official_class_source(d, brew_src) else None
        if b:   # homebrew / partnered subclass (or class): search its file too
            d = {k: (b.get(k) or []) + (d.get(k) or []) for k in ("class", "subclass", "classFeature", "subclassFeature")}
        # subclass features stay filed under the class edition they were written for (e.g. a 2014 subclass shown
        # on the 2024 class page), so for those the class source is only a preference
        keys = ["className", "subclassShortName", "subclassSource"] if kind == "subclassFeature" else ["className", "classSource"]
        pool = [f for f in d.get(kind, []) if all(_low(f.get(k)) == _low(want[k]) for k in keys)]
        cands = [f for f in pool if _low(f.get("name")) == _low(want["name"])]
        if not cands and loose:   # headings can differ slightly from the data, e.g. punctuation
            norm = lambda x: re.sub(r"[^a-z0-9]+", "", _low(x))
            cands = [f for f in pool if norm(f.get("name")) == norm(want["name"])]
        if want.get("level"):
            cands = [f for f in cands if f.get("level") == want["level"]] or cands
        if not cands:
            return None
        cands.sort(key=lambda f: (_low(f.get("source")) != _low(want.get("source")),
                                  _low(f.get("classSource")) != _low(want.get("classSource"))))
        f = cands[0]
        if f.get("_copy"):
            finder = lambda n, s: next((x for x in d.get(kind, []) if _low(x.get("name")) == _low(n) and _low(x.get("source")) == _low(s)), None)
            f = resolve_copy(copy.deepcopy(f), finder)
        return f

    def _ref_lookup(self, kind, uid):
        try:
            want = unpack_cf_uid(uid) if kind == "classFeature" else unpack_scf_uid(uid)
            return self._find_feature(kind, want)
        except Exception:
            return None

    def _class_and_data(self, cname, csrc):
        """(class entry, data dict) for an official or homebrew class."""
        try:
            d = self.class_data(cname)
        except ValueError:
            d = {}
        cls = next((c for c in d.get("class", []) if _low(c.get("name")) == cname and _low(c.get("source")) == csrc), None)
        if cls is None:
            b = self.data.brew(csrc)
            if b:
                cls = next((c for c in b.get("class", []) if _low(c.get("name")) == cname), None)
                d = {k: (b.get(k) or []) + (d.get(k) or []) for k in ("class", "subclass", "classFeature", "subclassFeature")}
        return cls, d

    def resolve_class_feature(self, u):
        """classes.html links: '#wizard_xphb,state:feature=s0-2' (the site's own feature links) or the
        ',cardforge:cf~<name>~<level>' / ',cardforge:scf~<name>~<level>~<subclass>~<source>' part the userscript adds."""
        global REF_LOOKUP
        parts = u.fragment.split(",")
        main = urllib.parse.unquote(parts[0]).strip().lower()
        if "_" not in main:
            raise ValueError("no class selected in that link")
        cname, csrc = main.rsplit("_", 1)
        subs = {}
        for part in parts[1:]:
            if ":" in part:
                k, v = part.split(":", 1)
                subs[k.strip().lower()] = v
        cls, d = self._class_and_data(cname, csrc)
        if cls is None:
            raise ValueError(f"couldn't find the class '{cname}' ({csrc.upper()})")
        class_name, class_src = cls["name"], cls["source"]

        feat, sc = None, None
        if "cardforge" in subs:
            bits = [urllib.parse.unquote(x) for x in subs["cardforge"].split("~")] + [""] * 5
            kind = bits[0].lower()
            if kind == "cf":
                feat = self._find_feature("classFeature", {"name": bits[1], "className": class_name, "classSource": class_src,
                                                           "level": _int(bits[2]), "source": class_src}, loose=True)
            elif kind == "scf":
                want = {"name": bits[1], "className": class_name, "classSource": class_src, "level": _int(bits[2]),
                        "subclassShortName": bits[3], "subclassSource": bits[4], "source": bits[4]}
                feat = self._find_feature("subclassFeature", want, loose=True) or self._find_via_subclass(want)
                b = self.data.brew(bits[4]) if not _is_official_class_source(d, bits[4]) else None
                scs = ((b or {}).get("subclass") or []) + d.get("subclass", [])
                sc = next((x for x in scs if _low(x.get("shortName")) == _low(bits[3])
                           and _low(x.get("source")) == _low(bits[4]) and _low(x.get("className")) == _low(class_name)), None)
            if feat is None:
                raise ValueError(f"couldn't find the feature '{bits[1]}' for {class_name} ({class_src})")
        else:
            state = {}
            for kv in subs.get("state", "").split("~"):
                if "=" in kv:
                    k, v = kv.split("=", 1)
                    state[k.lower()] = urllib.parse.unquote(v)
            m = re.match(r"s(\d+)-(\d+)$", state.get("feature", ""))
            if not m:
                raise ValueError("no feature selected - use the 🃏+ button next to a feature on the class page, "
                                 "or click a feature's title there to copy its link")
            ix_lvl, ix_feat = int(m.group(1)), int(m.group(2))
            by_level = {}
            for ref in cls.get("classFeatures", []):
                uid = ref if isinstance(ref, str) else (ref or {}).get("classFeature", "")
                want = unpack_cf_uid(uid)
                if want["level"]:
                    by_level.setdefault(want["level"], []).append(want)
            lst = by_level.get(ix_lvl + 1, [])
            if ix_feat >= len(lst):
                raise ValueError(f"{class_name} has no feature #{ix_feat + 1} at level {ix_lvl + 1}")
            feat = self._find_feature("classFeature", lst[ix_feat])
            if feat is None:
                raise ValueError(f"couldn't find '{lst[ix_feat]['name']}' in the {class_name} data")

        REF_LOOKUP = self._ref_lookup
        try:
            return build_class_feature(copy.deepcopy(feat), sc)
        finally:
            REF_LOOKUP = None

    # ----- items
    def item_db(self):
        if self._items:
            return self._items
        items = self.data.get("items.json")
        base = self.data.get("items-base.json")
        mv = self.data.get("magicvariants.json", optional=True) or {}
        prop_names, prop_entries = {}, {}
        for p in base.get("itemProperty", []) or []:
            ab = p.get("abbreviation")
            nm = p.get("name")
            ents = p.get("entries") or []
            if not nm and ents and isinstance(ents[0], dict):
                nm = ents[0].get("name")
            if ab:
                prop_names.setdefault(ab, (nm or PROP.get(ab, ab)).lower())
                if ents:
                    prop_entries.setdefault(ab, ents)
        self._items = {
            "item": items.get("item", []), "group": items.get("itemGroup", []),
            "base": base.get("baseitem", []), "variants": mv.get("magicvariant", []),
            "ctx": {"prop_names": prop_names, "prop_entries": prop_entries},
        }
        return self._items

    def _base_for(self, ref, bases=None):
        bases = bases if bases is not None else self.item_db()["base"]
        n, s = (ref.split("|") + ["phb"])[:2]
        for b in bases:
            if b["name"].lower() == n.lower() and b.get("source", "").lower() == s.lower():
                return b
        for b in bases:
            if b["name"].lower() == n.lower():
                return b
        return None

    def find_item(self, h):
        db = self.item_db()
        e = self._find_item_in(h, db["item"], db["group"], db["base"], db["variants"])
        if e is None:   # homebrew / partnered / prerelease item
            b = self.data.brew(h.rsplit("_", 1)[-1])
            if b:
                for p in b.get("itemProperty") or []:
                    if p.get("abbreviation") and p.get("name"):
                        db["ctx"]["prop_names"].setdefault(p["abbreviation"], p["name"].lower())
                e = self._find_item_in(h, (b.get("item") or []) + db["item"], (b.get("itemGroup") or []) + db["group"],
                                       (b.get("baseitem") or []) + db["base"], (b.get("magicvariant") or []) + db["variants"])
        return (e, db["ctx"]) if e else (None, None)

    def _find_item_in(self, h, items, groups, bases, variants):
        pools = [("item", items), ("group", groups), ("base", bases)]
        allpool = items + groups + bases
        finder = lambda n, s: next((x for x in allpool if x.get("name", "").lower() == (n or "").lower() and x.get("source", "").lower() == (s or "").lower()), None)
        for kind, pool in pools:
            for e in pool:
                if ent_hash(e) == h:
                    e = resolve_copy(copy.deepcopy(e), finder)
                    if kind == "group":
                        e["_isGroup"] = True
                    if e.get("baseItem"):
                        bi = self._base_for(e["baseItem"], bases)
                        if bi:
                            for k, v in bi.items():
                                if k not in e and k not in ("entries", "name", "source", "page", "srd", "basicRules", "value", "reprintedAs"):
                                    e[k] = copy.deepcopy(v)
                            e["_baseName"] = bi["name"]
                    return e
        # generated magic variants like "+1 Longsword"
        for v in variants:
            inh = v.get("inherits", {})
            for b in bases:
                if not self._variant_applies(v, b):
                    continue
                name = f"{inh.get('namePrefix', '')}{b['name']}{inh.get('nameSuffix', '')}"
                if f"{name}_{inh.get('source', v.get('source', ''))}".lower() != h:
                    continue
                e = copy.deepcopy(b)
                for k, val in inh.items():
                    if k not in ("namePrefix", "nameSuffix", "nameRemove"):
                        e[k] = copy.deepcopy(val)
                e["name"] = name
                e["_baseName"] = b["name"]
                e.pop("value", None)
                repl = {"baseName": b["name"], "dmgType": DMG.get(b.get("dmgType"), ""),
                        "bonusWeapon": inh.get("bonusWeapon", ""), "bonusAc": inh.get("bonusAc", ""),
                        "bonusSpellAttack": inh.get("bonusSpellAttack", ""), "bonusSpellSaveDc": inh.get("bonusSpellSaveDc", "")}

                def sub(m):
                    val = str(repl.get(m.group(1), ""))
                    return val.lower() if m.group(2) == "/l" else val.upper() if m.group(2) == "/u" else val
                e["entries"] = _walk_str(e.get("entries", []), lambda s: re.sub(r"\{=(\w+)(/\w)?\}", sub, s))
                return e
        return None

    @staticmethod
    def _variant_applies(v, b):
        if b.get("source", "") in ("UA",) or b.get("age"):
            pass
        reqs = v.get("requires", [])
        ok = False
        for r in reqs:
            if all((code(b.get(k)) == code(val) if k == "type" else b.get(k) == val) for k, val in r.items()):
                ok = True
                break
        if not ok:
            return False
        for k, val in (v.get("excludes") or {}).items():
            bv = b.get(k)
            vals = val if isinstance(val, list) else [val]
            if k == "type":
                bv = code(bv)
                vals = [code(x) for x in vals]
            if bv in vals or (isinstance(bv, list) and any(x in vals for x in bv)):
                return False
        return True


# --------------------------------------------------------------------------- input

LINE_RE = re.compile(r"^\s*(?:(\d+)\s*[x×]\s+)?(\S+?)(?:\s+[x×]\s*(\d+))?(?:\s*\[([^\]]*)\])?\s*(?:#\s.*)?$", re.I)

# format tags written by the userscript (or typed by hand)
#   card        normal card -> two-sided -> folding card if needed (default)
#   card/index  normal card (one or two sides); if it doesn't fit, the smallest index card that does
#   3x5 / 5x8   always an index card of that size (3x5 moves up to 5x8 if it doesn't fit)
FORMAT_TAGS = {"card": "card", "fold": "card", "folding": "card", "folding card": "card",
               "card/index": "card-index", "card-index": "card-index", "card or index": "card-index", "card>index": "card-index",
               "index": "3x5", "index card": "3x5", "3x5": "3x5", "5x3": "3x5", "5x8": "5x8", "8x5": "5x8"}


def parse_line(raw):
    """-> (link, copies, format or None) or None"""
    m = LINE_RE.match(raw.strip())
    if not m:
        return None
    tag = (m.group(4) or "").strip().lower().replace("×", "x")
    if tag and tag not in FORMAT_TAGS:
        warn(f"unknown format [{m.group(4)}] - using the default for: {m.group(2)}")
    return m.group(2), int(m.group(1) or m.group(3) or 1), FORMAT_TAGS.get(tag)


LOOT_START_RE = re.compile(r"^(?:(\d+)\s*[x×]\s+)?\[loot\]\s*(.*?)\s*(?:\[([^\]]*)\])?\s*(?:#\s*(.*))?$", re.I)
LOOT_LINE_RE = re.compile(r"^(coins|gems|art|other|item)\s*:\s*(.*)$", re.I)
LIST_START_RE = re.compile(r"^(?:(\d+)\s*[x×]\s+)?\[list\]\s*(.*?)\s*(?:\[([^\]]*)\])?\s*(?:#\s*(.*))?$", re.I)
LIST_END_RE = re.compile(r"^\[(?:end(?:\s*(?:list|loot))?|/\s*(?:list|loot))\]", re.I)


def read_inputs(args):
    """-> [(link or ListSpec, copies, format or None)]"""
    links = []
    for a in args:
        p = Path(a)
        if p.suffix.lower() in (".txt", ".list") and p.exists():
            block = None   # (ListSpec, copies, format) while inside [list] ... [end list]
            for raw in p.read_text(encoding="utf-8-sig").splitlines():
                raw = raw.strip()
                if not raw or raw.startswith(("#", "//", ";")):
                    continue
                m = LIST_START_RE.match(raw)
                lm = LOOT_START_RE.match(raw)
                if m or lm:
                    if block:
                        links.append(block)
                    mm = m or lm
                    tag = (mm.group(3) or "").strip().lower().replace("×", "x")
                    spec = (ListSpec(mm.group(2) or "List", [], (mm.group(4) or "").strip()) if m
                            else LootSpec(mm.group(2) or "Loot", (mm.group(4) or "").strip()))
                    block = (spec, int(mm.group(1) or 1), FORMAT_TAGS.get(tag, "card"))
                    continue
                if block and isinstance(block[0], LootSpec):
                    if LIST_END_RE.match(raw):
                        links.append(block)
                        block = None
                        continue
                    km = LOOT_LINE_RE.match(raw)
                    if km:
                        kind, rest = km.group(1).lower(), km.group(2).strip()
                        if kind == "item":
                            im = re.match(r"^(\S+)\s*(?:#\s*(.*))?$", rest)
                            if im:
                                block[0].items.append((im.group(1), (im.group(2) or "").strip()))
                        else:
                            {"coins": block[0].coins, "gems": block[0].gems, "art": block[0].art, "other": block[0].other}[kind].append(rest)
                    elif re.match(r"^(?:https?://|[\w.-]+\.html#)", raw, re.I):   # a plain link = a magic item
                        im = re.match(r"^(\S+)\s*(?:#\s*(.*))?$", raw)
                        block[0].items.append((im.group(1), (im.group(2) or "").strip()))
                    continue
                if LIST_END_RE.match(raw):
                    if block:
                        links.append(block)
                    block = None
                    continue
                parsed = parse_line(raw)
                if not parsed:
                    continue
                if block:
                    block[0].urls.append(parsed[0])
                else:
                    links.append(parsed)
            if block:
                links.append(block)
        else:
            links.append(parse_line(a) or (a, 1, None))
    return links


# --------------------------------------------------------------------------- quick add: find entries by name
# 5e.tools' own search index (search/index.json, and index-partnered.json for partnered books). The numbers are
# 5etools' Parser.CAT_ID_* categories; only the kinds Card Forge can make a card of are kept.
SEARCH_CATS = {
    1: ("bestiary.html", "Creature"), 2: ("spells.html", "Spell"), 3: ("backgrounds.html", "Background"),
    4: ("items.html", "Item"), 6: ("conditionsdiseases.html", "Condition"), 7: ("feats.html", "Feat"),
    8: ("optionalfeatures.html", "Eldritch Invocation"), 9: ("psionics.html", "Psionic"), 10: ("races.html", "Species"),
    11: ("rewards.html", "Reward"), 12: ("variantrules.html", "Rule"), 14: ("deities.html", "Deity"),
    15: ("objects.html", "Object"), 16: ("trapshazards.html", "Trap"), 17: ("trapshazards.html", "Hazard"),
    19: ("cultsboons.html", "Cult"), 20: ("cultsboons.html", "Boon"), 21: ("conditionsdiseases.html", "Disease"),
    22: ("optionalfeatures.html", "Metamagic"), 23: ("optionalfeatures.html", "Maneuver"),
    26: ("optionalfeatures.html", "Maneuver"), 27: ("optionalfeatures.html", "Arcane Shot"),
    28: ("optionalfeatures.html", "Optional Feature"), 29: ("optionalfeatures.html", "Fighting Style"),
    30: ("classes.html", "Class Feature"), 32: ("optionalfeatures.html", "Pact Boon"),
    33: ("optionalfeatures.html", "Elemental Discipline"), 34: ("optionalfeatures.html", "Artificer Infusion"),
    37: ("optionalfeatures.html", "Rune"), 38: ("optionalfeatures.html", "Alchemical Formula"),
    39: ("optionalfeatures.html", "Maneuver"), 41: ("classes.html", "Subclass Feature"), 42: ("actions.html", "Action"),
    43: ("languages.html", "Language"), 47: ("charcreationoptions.html", "Character Option"),
    49: ("conditionsdiseases.html", "Status"), 50: ("skills.html", "Skill"), 51: ("senses.html", "Sense"),
}
SEARCH_FIRST = (1, 2, 4)   # creatures, spells and items come before other kinds with the same name


def search_norm(s):
    """Lower case, no accents, words separated by single spaces."""
    s = re.sub("[\u0300-\u036f]", "", unicodedata.normalize("NFD", str(s).lower()))
    return " ".join(re.sub(r"[^a-z0-9]+", " ", s).split())


def search_entries(data):
    """Everything in the search index Card Forge can make a card of: [{name, kind, source, url, key, words, rank}].
    rank orders equal matches: official books before partnered ones, creatures / spells / items before other kinds,
    then the newest printing (dR = reprinted since)."""
    out = []
    for fn in ("index.json", "index-partnered.json"):
        idx = data.search_file(fn, optional=fn != "index.json")
        if not isinstance(idx, dict):
            continue
        srcs = {v: k for k, v in ((idx.get("m") or {}).get("s") or {}).items()}
        abbr = {k.lower(): k for k in srcs.values()}
        for e in idx.get("x") or []:
            cat = SEARCH_CATS.get(e.get("c"))
            if not cat or not e.get("u") or not e.get("n"):
                continue
            page, kind = cat
            name, source = str(e["n"]), srcs.get(e.get("s"), "")
            if page == "classes.html":   # "Fighter 2; Action Surge" -> the collector's exact-feature link
                if not e.get("uh") or "; " not in name:
                    continue
                head, name = name.split("; ", 1)
                p = [urllib.parse.unquote(x) for x in str(e["u"]).split("_")]
                q = lambda x: urllib.parse.quote(x, safe="")
                if e["c"] == 30 and len(p) >= 5:
                    url = f"https://5e.tools/classes.html#{e['uh']},cardforge:cf~{q(name)}~{p[-2]}"
                elif e["c"] == 41 and len(p) >= 7:
                    url = f"https://5e.tools/classes.html#{e['uh']},cardforge:scf~{q(name)}~{p[-2]}~{q(p[-4])}~{q(p[-3])}"
                else:
                    continue
                kind, source = f"{head} feature", abbr.get(p[-1], p[-1].upper())
            else:
                url = f"https://5e.tools/{page}#{e['u']}"
            key = search_norm(name)
            out.append({"name": name, "kind": kind, "source": source, "url": url, "key": key, "words": key.split(" "),
                        "rank": (4 if fn != "index.json" else 0) + (0 if e["c"] in SEARCH_FIRST else 2) + (1 if e.get("dR") else 0)})
    return out


def search(entries, query, limit=30):
    """Best matches first: the whole name, the start of it, the start of a word, every word's start, anywhere."""
    q = search_norm(query)
    if not q:
        return []
    qw = q.split(" ")
    hits = []
    for i, e in enumerate(entries):
        k = e["key"]
        if k == q:
            sc = 0
        elif k.startswith(q):
            sc = 1
        elif (" " + k).find(" " + q) >= 0:
            sc = 2
        elif all(any(w.startswith(x) for w in e["words"]) for x in qw):
            sc = 3
        elif q in k:
            sc = 4
        else:
            continue
        hits.append((sc, e["rank"], len(k), i))
    hits.sort()
    return [entries[h[3]] for h in hits[:limit]]


def pick_by_name(entries, text):
    """The paste prompt's name search: a link for the entry the user picks (with its copies), or None."""
    m = re.match(r"^(\d+)\s*[x×]\s+(.+)$", text)
    copies, query = (int(m.group(1)), m.group(2)) if m else (1, text)
    hits = search(entries, query, 9)
    if not hits:
        print(f"  no match for '{query}'")
        return None
    if len(hits) > 1:
        for i, h in enumerate(hits, 1):
            print(f"   {i}. {h['name']} ({h['kind']}, {h['source']})")
        try:
            ans = input("   Which one? (number, Enter = 1, n = none) ").strip().lower()
        except EOFError:
            ans = "n"
        if ans.startswith("n"):
            return None
        hits = [hits[int(ans) - 1]] if ans.isdigit() and 1 <= int(ans) <= len(hits) else hits[:1]
    print(f"  + {hits[0]['name']} ({hits[0]['kind']}, {hits[0]['source']})" + (f"  x{copies}" if copies > 1 else ""))
    return (f"{copies}x " if copies > 1 else "") + hits[0]["url"]


def interactive(make_data=None):
    """Read links, list files or (with make_data) names to search for, until an empty line."""
    print(f"5e CardForge {VERSION}")
    print("Paste 5e.tools links (one per line) or the path to a .txt list" + (", or type a name to search for it" if make_data else "")
          + ". Empty line to finish.\n")
    lines, entries = [], None
    while True:
        try:
            s = input("> ").strip().strip('"').strip("'")
        except EOFError:
            break
        if not s:
            break
        if make_data and "://" not in s and ".html#" not in s and not s.startswith("[") and not Path(s).exists():
            if entries is None:
                print("  (getting the 5e.tools index...)")
                try:
                    entries = search_entries(make_data())
                except Exception as e:
                    print(f"  ! couldn't get the 5e.tools index: {e}")
                    entries = []
            link = pick_by_name(entries, s)
            if link:
                lines.append(link)
            continue
        lines.append(s)
    return lines


# --------------------------------------------------------------------------- output

def find_browser():
    names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge",
             "microsoft-edge-stable", "brave-browser", "chrome", "msedge"]
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    if os.name == "nt":
        roots = [os.environ.get(k) for k in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")]
        rels = [r"Google\Chrome\Application\chrome.exe", r"Microsoft\Edge\Application\msedge.exe",
                r"BraveSoftware\Brave-Browser\Application\brave.exe", r"Chromium\Application\chrome.exe"]
        for r in roots:
            for rel in rels:
                if r and Path(r, rel).exists():
                    return str(Path(r, rel))
    for p in ("/usr/bin/chromium", "/snap/bin/chromium", "/opt/google/chrome/chrome", "/usr/bin/google-chrome"):
        if Path(p).exists():
            return p
    return None


class Chrome:
    """A headless Chrome / Edge / Chromium driven over the DevTools protocol, stdlib only: open a page, wait until it
    says it's done, then print it or read from it. (Chrome's plain --print-to-pdf can't wait for a page that is still
    working, e.g. on its pictures.) Talks over pipes on Linux and macOS, over a local WebSocket on Windows."""

    def __init__(self, exe, args=(), env=None):
        import tempfile
        self.dir = tempfile.mkdtemp(prefix="cardforge-chrome-")
        cmd = [exe, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
               f"--user-data-dir={self.dir}", *args]
        if os.name != "nt" and hasattr(os, "geteuid") and os.geteuid() == 0:
            cmd.insert(1, "--no-sandbox")   # Chrome refuses to run as root otherwise
        self.seq, self.buf, self.sock = 0, bytearray(), None
        if os.name != "nt" and not os.environ.get("CF_CDP_WEBSOCKET"):
            r_ours, w_chrome = os.pipe()
            r_chrome, w_ours = os.pipe()

            def fds():   # Chrome reads commands from fd 3 and writes replies to fd 4
                a, b = os.dup(r_chrome), os.dup(w_chrome)
                os.dup2(a, 3)
                os.dup2(b, 4)
                os.set_inheritable(3, True)
                os.set_inheritable(4, True)
            self.proc = subprocess.Popen(cmd + ["--remote-debugging-pipe", "about:blank"], preexec_fn=fds, close_fds=False,
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
            os.close(r_chrome)
            os.close(w_chrome)
            self.rfd, self.wfd = r_ours, w_ours
        else:
            self.proc = subprocess.Popen(cmd + ["--remote-debugging-port=0", "about:blank"],
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
            port_file, end = Path(self.dir) / "DevToolsActivePort", time.time() + 30
            while not (port_file.exists() and len(port_file.read_text().split()) >= 2):
                if time.time() > end or self.proc.poll() is not None:
                    raise RuntimeError("the browser didn't open its DevTools port")
                time.sleep(0.1)
            port, path = port_file.read_text().split()[:2]
            self._ws_open("127.0.0.1", int(port), path)

    # ----- transport: NUL-terminated JSON on the pipes, or WebSocket text frames
    def _ws_open(self, host, port, path):
        import base64
        import socket
        self.sock = socket.create_connection((host, port), timeout=30)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                           f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        while b"\r\n\r\n" not in self.buf:
            self._more(30)
        head, rest = bytes(self.buf).split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n")[0] + b" ":
            raise RuntimeError("the browser refused the DevTools connection")
        self.buf = bytearray(rest)

    def _more(self, timeout):
        import select
        src = self.sock if self.sock else self.rfd
        if not select.select([src], [], [], max(0.0, timeout))[0]:
            raise TimeoutError("the browser stopped answering")
        chunk = self.sock.recv(1 << 16) if self.sock else os.read(self.rfd, 1 << 16)
        if not chunk:
            raise RuntimeError("the browser closed")
        self.buf += chunk

    def _take(self, n, end):
        while len(self.buf) < n:
            self._more(end - time.time())
        out = bytes(self.buf[:n])
        del self.buf[:n]
        return out

    def _send(self, text):
        data = text.encode()
        if not self.sock:
            data += b"\0"
            while data:
                data = data[os.write(self.wfd, data):]
            return
        n, mask = len(data), os.urandom(4)
        head = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + n.to_bytes(2, "big") if n < 65536
                                else bytes([0x80 | 127]) + n.to_bytes(8, "big"))
        self.sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _receive(self, end):
        if not self.sock:
            while b"\0" not in self.buf:
                self._more(end - time.time())
            i = self.buf.index(b"\0")
            msg = bytes(self.buf[:i])
            del self.buf[:i + 1]
            return msg
        msg = b""
        while True:
            b1, b2 = self._take(2, end)
            n = b2 & 127
            if n >= 126:
                n = int.from_bytes(self._take(2 if n == 126 else 8, end), "big")
            mask = self._take(4, end) if b2 & 128 else None
            payload = self._take(n, end)
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if b1 & 15 == 8:
                raise RuntimeError("the browser closed")
            if b1 & 15 in (9, 10):   # ping / pong
                continue
            msg += payload
            if b1 & 128:
                return msg

    # ----- DevTools commands
    def call(self, method, params=None, session=None, timeout=60):
        self.seq += 1
        msg = {"id": self.seq, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        self._send(json.dumps(msg))
        end = time.time() + timeout
        while True:
            m = json.loads(self._receive(end))
            if m.get("id") == self.seq:
                if "error" in m:
                    raise RuntimeError(f"{method}: {m['error'].get('message')}")
                return m.get("result", {})

    def open(self, url):
        """A new tab showing url -> its session id."""
        target = self.call("Target.createTarget", {"url": url})["targetId"]
        return self.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]

    def evaluate(self, session, expr, timeout=60):
        r = self.call("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True}, session, timeout)
        if r.get("exceptionDetails"):
            raise RuntimeError(r["exceptionDetails"].get("text", "script error"))
        return r.get("result", {}).get("value")

    def wait_for(self, session, expr, timeout=90):
        end = time.time() + timeout
        while not self.evaluate(session, expr):
            if time.time() > end:
                raise TimeoutError("the page didn't finish in time")
            time.sleep(0.2)

    def pdf(self, session):
        import base64
        r = self.call("Page.printToPDF", {"printBackground": True, "preferCSSPageSize": True, "marginTop": 0,
                                          "marginBottom": 0, "marginLeft": 0, "marginRight": 0}, session, timeout=180)
        return base64.b64decode(r["data"])

    def close(self):
        try:
            self.call("Browser.close", timeout=5)
        except Exception:
            pass
        try:
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()
        for fd in (getattr(self, "rfd", None), getattr(self, "wfd", None)):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
        if self.sock:
            self.sock.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


# a print sheet is done once its pictures have their solid backgrounds (card_template.html); any other page once loaded
# (a new tab shows about:blank for a moment before the page itself)
PAGE_DONE = ("document.URL !== 'about:blank' && document.readyState === 'complete' && (!document.getElementById('sheets') "
             "|| document.body.dataset.pictures === '1')")


def print_page(browser, url, args=(), env=None, timeout=120):
    """url -> PDF bytes, printed once the page is done (also used by hosting/cardforge-service.py)."""
    with Chrome(browser, args, env) as c:
        tab = c.open(url)
        c.wait_for(tab, PAGE_DONE, timeout)
        return c.pdf(tab)


def make_pdf(html_path, pdf_path, browser):
    pdf_path = Path(pdf_path).resolve()
    if pdf_path.exists():
        pdf_path.unlink()
    try:
        pdf_path.write_bytes(print_page(browser, Path(html_path).resolve().as_uri()))
        return True
    except Exception as e:
        warn(f"printing through the browser's DevTools didn't work ({e}); trying its simple print mode")
    cmd = [browser, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
           "--no-pdf-header-footer", "--print-to-pdf-no-header", "--virtual-time-budget=15000",
           f"--print-to-pdf={pdf_path}", Path(html_path).resolve().as_uri()]
    if os.name != "nt" and hasattr(os, "geteuid") and os.geteuid() == 0:
        cmd.insert(1, "--no-sandbox")  # Chrome refuses to run as root otherwise
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
    except subprocess.TimeoutExpired:
        pass  # some builds keep running after writing the PDF
    except Exception as e:
        warn(f"PDF export failed: {e}")
        return False
    return pdf_path.exists() and pdf_path.stat().st_size > 1000


SETTINGS_DEFAULT = {"paper": "letter", "split": False, "duplex": "long", "images": "off", "back_offset": [0.0, 0.0]}

PAPER_MM = {"letter": (215.9, 279.4), "a4": (210.0, 297.0)}


def fmt_mm(v):
    return f"{v:+.1f}".replace("+0.0", "0").replace("-0.0", "0")


def calibration_pages(paper, duplex, offset):
    """(front svg, back svg) for the printer alignment test. All units are millimetres.
    Front: nine crosshairs. Back: X and Y rulers exactly behind them (after the flip, plus the current offset)."""
    W, H = PAPER_MM[paper]
    dx, dy = offset
    xs, ys = (28, W / 2, W - 28), (40, H / 2, H - 40)
    font = "font-family='Helvetica, Arial, sans-serif'"

    f = [f"<svg xmlns='http://www.w3.org/2000/svg' width='{W}mm' height='{H}mm' viewBox='0 0 {W} {H}'>"]
    for x in xs:
        for y in ys:
            f.append(f"<path d='M{x} {y - 16} V{y + 16} M{x - 16} {y} H{x + 16}' stroke='#000' stroke-width='0.3'/>")
    f.append(f"<text x='{W / 2}' y='{H / 2 - 40}' text-anchor='middle' font-size='6' font-weight='700' {font}>FRONT</text>")
    lines = [f"Card Forge printer alignment test  \u2022  {paper.upper()}  \u2022  flip on the {duplex} edge"
             f"  \u2022  current back offset X {fmt_mm(dx)} mm, Y {fmt_mm(dy)} mm",
             "Print this file at 100% / Actual size (no 'Fit'), the same way you print your cards, then turn the page over."]
    for i, t in enumerate(lines):
        f.append(f"<text x='{W / 2}' y='{H / 2 - 30 + i * 6}' text-anchor='middle' font-size='3.4' {font}>{html.escape(t)}</text>")
    f.append("</svg>")

    b = [f"<svg xmlns='http://www.w3.org/2000/svg' width='{W}mm' height='{H}mm' viewBox='0 0 {W} {H}'>"]
    red = "#c4141c"
    for x in xs:
        for y in ys:
            bx = (W - x) if duplex == "long" else x
            by = y if duplex == "long" else (H - y)
            bx, by = bx + dx, by + dy
            # X ruler: horizontal, 9 mm above the crossing point - the front's vertical line crosses it
            ry = by - 9
            b.append(f"<path d='M{bx - 7} {ry} H{bx + 7}' stroke='{red}' stroke-width='0.15'/>")
            for i in range(-14, 15):
                d = i / 2
                ln = 3.2 if i == 0 else 2.2 if i % 2 == 0 else 1.2
                b.append(f"<path d='M{bx + d} {ry} V{ry - ln}' stroke='{red}' stroke-width='{0.22 if i == 0 else 0.12}'/>")
                if i % 4 == 0:
                    b.append(f"<text x='{bx + d}' y='{ry - 4}' text-anchor='middle' font-size='1.6' fill='{red}' {font}>{'0' if i == 0 else f'{d:+.0f}'}</text>")
            b.append(f"<text x='{bx - 8.5}' y='{ry + 0.8}' text-anchor='end' font-size='2.4' font-weight='700' fill='{red}' {font}>X</text>")
            # Y ruler: vertical, 9 mm right of the crossing point - the front's horizontal line crosses it
            rx = bx + 9
            b.append(f"<path d='M{rx} {by - 7} V{by + 7}' stroke='{red}' stroke-width='0.15'/>")
            for i in range(-14, 15):
                d = i / 2
                ln = 3.2 if i == 0 else 2.2 if i % 2 == 0 else 1.2
                b.append(f"<path d='M{rx} {by + d} H{rx + ln}' stroke='{red}' stroke-width='{0.22 if i == 0 else 0.12}'/>")
                if i % 4 == 0:
                    b.append(f"<text x='{rx + 4}' y='{by + d + 0.6}' font-size='1.6' fill='{red}' {font}>{'0' if i == 0 else f'{d:+.0f}'}</text>")
            b.append(f"<text x='{rx}' y='{by + 10.5}' text-anchor='middle' font-size='2.4' font-weight='700' fill='{red}' {font}>Y</text>")
    b.append(f"<text x='{W / 2}' y='{H / 2 - 40}' text-anchor='middle' font-size='6' font-weight='700' {font}>BACK</text>")
    steps = [
        "Hold this side up to a bright light or window - the black lines from the front show through.",
        "Read where the vertical black line crosses the red X scale, and where the horizontal line crosses the Y scale (ticks every 0.5 mm).",
        "Middle readings:   X = ______ mm      Y = ______ mm        (0 and 0 means your printer is spot on)",
        "Type them into calibrate_printer.bat / calibrate_printer.sh when it asks - it adds them to the current offset for you.",
        f"(By hand: --back-offset = current offset + reading. Current offset {fmt_mm(dx)}, {fmt_mm(dy)}; readings +1.5 and -0.5 would give"
        f" --back-offset {fmt_mm(dx + 1.5)},{fmt_mm(dy - 0.5)})",
        "If the left and right X readings (or top and bottom Y readings) differ, the page is being scaled: print at 100% / Actual size.",
    ]
    for i, t in enumerate(steps):
        b.append(f"<text x='{W / 2}' y='{H / 2 + 24 + i * 5.5}' text-anchor='middle' font-size='3.2' {font}>{html.escape(t)}</text>")
    b.append("</svg>")
    return "".join(f), "".join(b)


def calibration_html(paper, duplex, offset, pages):
    W, H = PAPER_MM[paper]
    body = "".join(f"<div class='pg'>{p}</div>" for p in pages)
    return (f"<!doctype html><html><head><meta charset='utf-8'><title>Card Forge - printer alignment test</title><style>"
            f"@page {{ size: {W}mm {H}mm; margin: 0; }} html, body {{ margin: 0; background: #888; }}"
            f".pg {{ position: relative; width: {W}mm; height: {H - 0.5}mm; overflow: hidden; background: #fff; margin: 0 auto 12px; break-after: page; }}"
            f".pg:last-child {{ break-after: auto; }} .pg svg {{ position: absolute; left: 0; top: 0; }}"
            f"@media print {{ body {{ background: none; }} .pg {{ margin: 0; }} }}"
            f"</style></head><body>{body}</body></html>")


def parse_offset(text):
    """'1.5,-0.5' -> [1.5, -0.5]; also accepts '1.5 -0.5' or '1.5;-0.5'."""
    parts = [p for p in re.split(r"[,;\s]+", str(text).strip()) if p]
    if len(parts) != 2:
        raise ValueError("give two numbers in millimetres, e.g. 1.5,-0.5")
    return [round(float(parts[0]), 2), round(float(parts[1]), 2)]


def run_calibration(a):
    saved = load_settings()
    off = list(saved.get("back_offset") or [0.0, 0.0])
    br = find_browser()
    front, back = calibration_pages(a.paper, a.duplex, off)
    out = Path(a.out).with_suffix("") if a.out else Path.cwd() / "cardforge-printer-test"
    jobs = ([(out.with_name(out.name + "-fronts"), [front]), (out.with_name(out.name + "-backs"), [back])]
            if a.split else [(out, [front, back])])
    print()
    made = []
    for base, pages in jobs:
        hp = base.with_suffix(".html")
        hp.write_text(calibration_html(a.paper, a.duplex, off, pages), encoding="utf-8")
        target = hp
        if br and not a.no_pdf and make_pdf(hp, base.with_suffix(".pdf"), br):
            target = base.with_suffix(".pdf")
        made.append(target)
        print(f"Saved {target}")
    print(f"\nCurrent back offset: X {fmt_mm(off[0])} mm, Y {fmt_mm(off[1])} mm")
    if a.split:
        print("Print the FRONTS file, put the sheet back in the tray (flipped over its "
              f"{a.duplex} edge) and print the BACKS file - exactly as you do for cards.")
    else:
        print(f"Print it double-sided (flip on the {a.duplex} edge) at 100% / Actual size, the same way you print your cards.")
    print("Then hold the back up to a light and read the middle X and Y scales where the black lines cross them.")
    if a.open:
        open_file(made[0])
    if a.no_ask or not (sys.stdin and sys.stdin.isatty()):
        print("When you have the readings: python cardforge.py --back-offset X,Y  (current offset + readings)")
        return 0
    try:
        rx = input("\nX reading in mm (e.g. 1.5 or -0.5; Enter to stop here): ").strip()
        if not rx:
            return 0
        ry = input("Y reading in mm: ").strip() or "0"
        new = [round(off[0] + float(rx.replace(",", ".")), 2), round(off[1] + float(ry.replace(",", ".")), 2)]
    except (ValueError, EOFError):
        print("Not a number - nothing changed.")
        return 1
    save_settings({"back_offset": new})
    print(f"Saved: backs will now be shifted X {fmt_mm(new[0])} mm, Y {fmt_mm(new[1])} mm. "
          "Run the test again to check - every scale should read 0.")
    return 0


def data_for(links, data_dir=None, refresh=False, brew_dirs=None):
    """The data source for these links: links from a 5etools mirror read that mirror's data first."""
    extra = None
    for l, _, _ in links:
        if isinstance(l, (ListSpec, LootSpec)):
            if not l.urls:
                continue
            l = l.urls[0]
        u = urllib.parse.urlparse(l)
        if u.netloc and u.netloc not in ("5e.tools", "www.5e.tools"):
            extra = f"{u.scheme}://{u.netloc}{u.path.rsplit('/', 1)[0]}/data/"
            break
    return Data(data_dir, refresh, extra, brew_dirs=brew_dirs)


def fetch_cards(links, res):
    """A card for every link (also used by cardforge_png.py); entries that fail are reported and left out."""
    cards = []
    print(f"Fetching {len(links)} entr{'y' if len(links) == 1 else 'ies'}...")
    for link, n, want in links:
        try:
            if isinstance(link, (ListSpec, LootSpec)):
                c = res.build_list(link) if isinstance(link, ListSpec) else res.build_loot(link)
                # a list that's too long for one card carries on over several cards of this kind
                c["multiFmt"] = {"card": "fold", "card-index": "5x8", "3x5": "3x5", "5x8": "5x8"}[want or "card"]
                want = want or "card"
            else:
                c = res.resolve(link)
            c["copies"] = n
            if want:
                c["want"] = want
            cards.append(c)
            extra_info = (f" (loot, {len(link.items)} magic items)" if isinstance(link, LootSpec)
                          else f" ({c['sub'].split(' ')[0]} entries)" if c.get("isList") else "")
            print(f"  + {c['name']}{extra_info}" + (f"  x{n}" if n > 1 else ""))
        except Exception as e:
            warn(f"{link}\n      {e}")
    return cards


def ask(question, options, default):
    """options: list of (key, value, label). Enter keeps the default."""
    labels = "  ".join(f"[{k}] {lab}{' *' if v == default else ''}" for k, v, lab in options)
    while True:
        try:
            ans = input(f"{question}\n   {labels}\n   > ").strip().lower()
        except EOFError:
            return default
        if not ans:
            return default
        for k, v, _ in options:
            if ans == k or ans == str(v).lower():
                return v
        print("   Please type one of: " + ", ".join(k for k, _, _ in options))


def ask_print_settings(a):
    """Ask for anything not given on the command line; remember the answers for next time."""
    path = cache_dir() / "settings.json"
    try:
        saved = {**SETTINGS_DEFAULT, **json.loads(path.read_text(encoding="utf-8"))}
    except Exception:
        saved = dict(SETTINGS_DEFAULT)
    interactive_ok = not a.no_ask and sys.stdin is not None and sys.stdin.isatty()
    missing = [k for k in ("paper", "split", "duplex", "images") if getattr(a, k, None) is None]
    if missing and interactive_ok:
        print("\nPrint settings (* = current choice, press Enter to keep it):")
        if a.paper is None:
            a.paper = ask("Paper size?", [("l", "letter", "US Letter"), ("a", "a4", "A4")], saved["paper"])
        if a.split is None:
            a.split = ask("What kind of printer?",
                          [("d", False, "Double-sided (one file)"),
                           ("s", True, "Single-sided (separate fronts & backs files)")], saved["split"])
        if a.duplex is None:
            q = ("When you put the printed fronts back in the tray, which edge do you flip the stack over?"
                 if a.split else "Which edge does your printer flip the paper on?")
            a.duplex = ask(q, [("l", "long", "Long edge (most common)"), ("s", "short", "Short edge")], saved["duplex"])
        if getattr(a, "images", None) is None:
            a.images = ask("Pictures on creature and item cards?",
                           [("n", "off", "No pictures"),
                            ("b", "back", "On the back, in the round medallion"),
                            ("f", "front", "On the front, under the title (leaves less room for text)")], saved["images"])
        save_settings({"paper": a.paper, "split": a.split, "duplex": a.duplex, "images": a.images})
        print()
    for k in ("paper", "split", "duplex", "images"):
        if getattr(a, k, None) is None:
            setattr(a, k, saved[k])


def run_dom(html_path, browser):
    cmd = [browser, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
           "--virtual-time-budget=60000", "--dump-dom", Path(html_path).resolve().as_uri()]
    if os.name != "nt" and hasattr(os, "geteuid") and os.geteuid() == 0:
        cmd.insert(1, "--no-sandbox")
    try:
        r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=300)
        return r.stdout.decode("utf-8", "replace")
    except Exception:
        return ""


def measure_cards(cards, browser, render):
    """Lay every card out in the browser once to learn which formats it fits."""
    import tempfile
    print("Measuring card layouts...")
    with tempfile.TemporaryDirectory() as td:
        path = render(Path(td) / "measure.html", cards, {"measure": True})
        dom = run_dom(path, browser)
    m = re.search(r"@@RESULT@@(.*?)@@END@@", dom, re.S)
    if not m:
        warn("couldn't measure the cards in the browser; long entries will be sized automatically.")
        return None
    return json.loads(html.unescape(m.group(1)))


CAT_NAMES = {"spell": "Spells", "item": "Items", "monster": "Monsters", "feature": "Class features",
             "other": "Other (feats, conditions…)"}
BIG_LABEL = {"fold": "folding card", "3x5": "3x5 index card", "5x8": "5x8 index card"}
FALLBACK = {"fold": ["fold", "3x5", "5x8"], "3x5": ["3x5", "5x8", "fold"], "5x8": ["5x8", "fold"]}


def load_settings():
    try:
        return {**SETTINGS_DEFAULT, **json.loads((cache_dir() / "settings.json").read_text(encoding="utf-8"))}
    except Exception:
        return dict(SETTINGS_DEFAULT)


def save_settings(upd):
    st = load_settings()
    st.update(upd)
    try:
        (cache_dir() / "settings.json").write_text(json.dumps(st), encoding="utf-8")
    except Exception:
        pass


def choose_big_formats(cards, sizes, a):
    """Decide fold / 3x5 / 5x8 for entries too long for one playing card.
    Returns (cards to make, print index cards on stock?)."""
    saved = load_settings()
    can_ask = not a.no_ask and sys.stdin is not None and sys.stdin.isatty()
    keep, notes = [], []
    candidates = {}   # cat -> [(card, fits)]
    for i, c in enumerate(cards):
        c["_i"] = i   # keep the list order whatever gets decided

    chosen = [c for c in cards if c.get("want")]   # format picked per entry (userscript / [tag] in the list)
    if chosen:
        if sizes is None:
            for c in chosen:
                w = c["want"]
                c["order"] = {"card": ["fold", "3x5", "5x8"], "card-index": ["3x5", "5x8"],
                              "3x5": ["3x5", "5x8"], "5x8": ["5x8"]}[w]
                c["noCard"] = w in ("3x5", "5x8")
        else:
            for c, m in zip(cards, sizes):
                w = c.get("want")
                if not w:
                    continue
                single = m.get("single") or m.get("double")
                pick, note = None, ""
                if w == "card":
                    if single:
                        pick = "card"
                    elif m.get("fold"):
                        pick = "fold"
                    elif c.get("isList"):
                        pick = None
                    else:
                        pick = next((f for f in ("3x5", "5x8") if m.get(f)), None)
                        note = "too long for one folding card"
                elif w == "card-index":
                    if single:
                        pick = "card"
                    else:
                        pick = next((f for f in ("3x5", "5x8") if m.get(f)), None)
                elif w == "3x5":
                    if c.get("isList"):   # a list stays on 3x5 cards, carrying on over several if needed
                        pick = "3x5" if m.get("3x5") else None
                    else:
                        pick = next((f for f in ("3x5", "5x8") if m.get(f)), None)
                        note = "doesn't fit a 3x5 index card" if pick == "5x8" else ""
                elif w == "5x8":
                    pick = "5x8" if m.get("5x8") else None
                if pick is None and c.get("multiFmt"):   # long list: several cards in a row
                    mf = c["multiFmt"]
                    c["order"], c["noCard"], c["multi"] = [mf], True, True
                    notes.append(f"  > {c['name']}: {len(c['blocks'][0]['h'].split('<tr>')) - 2} entries - continues over several {BIG_LABEL[mf]}s.")
                    continue
                if pick is None:
                    notes.append(f"  x {c['name']}: too long even for a 5x8 index card - SKIPPED.")
                    c["skip"] = True
                    continue
                if pick != "card":
                    c["order"] = [pick]
                    c["noCard"] = pick in ("3x5", "5x8")
                if note:
                    notes.append(f"  > {c['name']}: {note} - using a {BIG_LABEL[pick]}.")
        keep.extend(c for c in chosen if not c.get("skip"))
        cards_left = [c for c in cards if not c.get("want")]
        sizes = None if sizes is None else [m for c, m in zip(cards, sizes) if not c.get("want")]
        cards = cards_left
        if not cards:   # every entry had its own format: nothing to ask
            if notes:
                print()
                for n in notes:
                    print(n)
            uses_index = any(c.get("order", [None])[0] in ("3x5", "5x8") or c.get("want") in ("card-index", "3x5", "5x8") for c in keep)
            uses_index = uses_index or any(c.get("multi") and c.get("multiFmt") in ("3x5", "5x8") for c in keep)
            keep.sort(key=lambda c: c["_i"])
            return keep, ask_stock(a, saved, can_ask) if uses_index else False

    if sizes is None:
        # no browser to measure with: ask per category; the page sizes things itself
        cats = sorted({c["cat"] for c in cards}, key=list(CAT_NAMES).index)
        choice = {}
        for cat in cats:
            if a.big:
                choice[cat] = a.big
            elif can_ask:
                choice[cat] = ask(f"{CAT_NAMES[cat]} too long for one card - print them on:",
                                  [("f", "fold", "Folding card"), ("3", "3x5", "3x5 index"), ("5", "5x8", "5x8 index")],
                                  saved.get("big_" + cat, "fold") if saved.get("big_" + cat) != "each" else "fold")
            else:
                choice[cat] = saved.get("big_" + cat, "fold") if saved.get("big_" + cat) != "each" else "fold"
        if can_ask and not a.big:
            save_settings({"big_" + k: v for k, v in choice.items()})
        for c in cards:
            c["order"] = FALLBACK[choice[c["cat"]]]
        uses_index = any(v != "fold" for v in choice.values()) or any(c.get("want") not in (None, "card") for c in keep)
        print("(Entries that don't fit even a 5x8 card will be listed in the bar at the top of the HTML page.)")
        return sorted(keep + cards, key=lambda c: c["_i"]), ask_stock(a, saved, can_ask) if uses_index else False

    for c, m in zip(cards, sizes):
        if m.get("single") or m.get("double"):
            keep.append(c)
        elif m.get("fold"):
            fits = [f for f in ("fold", "3x5", "5x8") if m.get(f)]
            candidates.setdefault(c["cat"], []).append((c, fits))
            keep.append(c)
        elif m.get("3x5") or m.get("5x8"):
            f = "3x5" if m.get("3x5") else "5x8"
            c["order"] = [f]
            keep.append(c)
            notes.append(f"  > {c['name']}: too long for one folding card - using a {BIG_LABEL[f]}.")
        else:
            notes.append(f"  x {c['name']}: too long even for a 5x8 index card - SKIPPED.")

    if candidates:
        print(f"\n{sum(len(v) for v in candidates.values())} entr{'y needs' if sum(len(v) for v in candidates.values()) == 1 else 'ies need'} "
              "more than one card side. Choose how to print them (* = current choice, Enter keeps it):")
        newsave = {}
        for cat in [k for k in CAT_NAMES if k in candidates]:
            lst = candidates[cat]
            print(f"\n{CAT_NAMES[cat]}: " + ", ".join(c["name"] for c, _ in lst))
            default = saved.get("big_" + cat, "fold")
            if a.big:
                pick = a.big
            elif can_ask:
                opts = [("f", "fold", "Folding card"), ("3", "3x5", "3x5 index"), ("5", "5x8", "5x8 index")]
                if len(lst) > 1:
                    opts.append(("e", "each", "Ask for each"))
                elif default == "each":
                    default = "fold"
                pick = ask(f"Print {CAT_NAMES[cat].split(' (')[0].lower()} on:", opts, default)
                newsave["big_" + cat] = pick
            else:
                pick = default if default != "each" else "fold"
            for c, fits in lst:
                want = pick
                if pick == "each":
                    opts = [(k, f, BIG_LABEL[f].capitalize()) for k, f in (("f", "fold"), ("3", "3x5"), ("5", "5x8")) if f in fits]
                    want = ask(f"  {c['name']}:", opts, "fold")
                final = next(f for f in FALLBACK[want] if f in fits)
                if final != want:
                    notes.append(f"  > {c['name']}: doesn't fit a {BIG_LABEL[want]} - using a {BIG_LABEL[final]}.")
                c["order"] = [final]
        if newsave:
            save_settings(newsave)
    if notes:
        print()
        for n in notes:
            print(n)
    uses_index = any(c.get("order", [None])[0] in ("3x5", "5x8") for c in keep)
    keep.sort(key=lambda c: c["_i"])
    return keep, ask_stock(a, saved, can_ask) if uses_index else False


def ask_stock(a, saved, can_ask):
    if a.index_on:
        return a.index_on == "stock"
    if not can_ask:
        return bool(saved.get("index_stock", False))
    v = ask("\nHow will you print the index cards?",
            [("p", False, "Cut out of regular paper"), ("c", True, "Directly on index card stock (one card per page)")],
            bool(saved.get("index_stock", False)))
    save_settings({"index_stock": v})
    return v


def open_file(path):
    try:
        if os.name == "nt":
            os.startfile(str(path))
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def main(argv=None):
    ap = argparse.ArgumentParser(description="Make printable cards from 5e.tools links.")
    ap.add_argument("inputs", nargs="*", help="5e.tools links and/or .txt list files")
    ap.add_argument("-o", "--out", help="output file name (without extension). Default: next to the list, or ./cards")
    ap.add_argument("--paper", choices=["letter", "a4"], help="paper size (asked if not given)")
    ap.add_argument("--duplex", choices=["long", "short"],
                    help="which edge the paper is flipped on (asked if not given)")
    ap.add_argument("--min-font", type=float, default=6.5, help="smallest font (pt) before a card grows (default 6.5)")
    ap.add_argument("--gap", type=float, default=0.0, help="space between cards on the sheet, inches (default 0 = share cut lines)")
    sides = ap.add_mutually_exclusive_group()
    sides.add_argument("--split", dest="split", action="store_true", default=None,
                       help="single-sided printer: separate FRONTS and BACKS files (asked if not given)")
    sides.add_argument("--double", dest="split", action="store_false",
                       help="double-sided printer: one file with fronts and backs interleaved")
    ap.add_argument("--images", choices=["off", "back", "front"],
                    help="pictures on creature and item cards: off, on the back (in the medallion) or on the front (asked if not given)")
    ap.add_argument("--no-ask", action="store_true", help="never ask questions; use saved/default settings")
    ap.add_argument("--calibrate", action="store_true",
                    help="make a printer alignment test page, then enter what you read to correct the back side")
    ap.add_argument("--back-offset", metavar="X,Y",
                    help="shift the back side by X,Y mm (as read on the --calibrate page) and remember it; 0,0 resets")
    ap.add_argument("--big", choices=["fold", "3x5", "5x8"],
                    help="format for entries too long for one card, for every category (asked if not given)")
    ap.add_argument("--index-on", choices=["paper", "stock"],
                    help="print index cards cut from regular paper, or directly on index card stock (asked)")
    ap.add_argument("--no-measure", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--no-pdf", action="store_true", help="only write the HTML file")
    ap.add_argument("--data-dir", help="use a local copy of the 5etools 'data' folder instead of downloading")
    ap.add_argument("--brew-dir", action="append",
                    help="local copy of the homebrew (or unearthed-arcana) repository, for offline use; can be repeated")
    ap.add_argument("--refresh", action="store_true", help="ignore the download cache")
    ap.add_argument("--open", action="store_true", help="open the result when done")
    a = ap.parse_args(argv)

    if a.back_offset is not None:
        try:
            off = parse_offset(a.back_offset)
        except ValueError as e:
            print(f"--back-offset: {e}")
            return 1
        save_settings({"back_offset": off})
        print(f"Back side offset saved: X {fmt_mm(off[0])} mm, Y {fmt_mm(off[1])} mm (used for every print from now on).")
        if not a.inputs and not a.calibrate:
            return 0
    if a.calibrate:
        if a.images is None:   # no cards on a test page, so don't ask about pictures
            a.images = load_settings().get("images", "off")
        ask_print_settings(a)
        return run_calibration(a)

    inputs = a.inputs
    pausing = False
    if not inputs:
        inputs = interactive(lambda: Data(a.data_dir, a.refresh, brew_dirs=a.brew_dir))
        pausing = True
        if not inputs:
            return 1
    ask_print_settings(a)
    links = read_inputs(inputs)
    if not links:
        print("No links found.")
        return 1

    first_txt = next((Path(x) for x in inputs if x.lower().endswith(".txt") and Path(x).exists()), None)
    out = Path(a.out) if a.out else (first_txt.with_name(first_txt.stem + "-cards") if first_txt else Path.cwd() / "cards")
    out = out.with_suffix("") if out.suffix.lower() in (".html", ".pdf") else out

    data = data_for(links, a.data_dir, a.refresh, a.brew_dir)
    cards = fetch_cards(links, Resolver(data, images=a.images != "off"))
    if not cards:
        print("Nothing to make.")
        return 1

    tpl = TEMPLATE.read_text(encoding="utf-8")
    page = {"letter": "8.5in 11in", "a4": "210mm 297mm"}[a.paper]
    br = None if a.no_pdf and a.no_measure else find_browser()

    def render(path, cards_, extra_cfg):
        cfg = {"paper": a.paper, "duplex": a.duplex, "minFont": a.min_font, "gap": a.gap, "images": a.images,
               "backOffset": load_settings().get("back_offset") or [0, 0], **extra_cfg}
        payload = json.dumps({"cards": cards_, "cfg": cfg}, ensure_ascii=False).replace("</", "<\\/")
        path.write_text(tpl.replace("/*__DATA__*/null", payload).replace("__PAGESIZE__", page), encoding="utf-8")
        return path

    # ---- work out which cards need a big format, and ask how to print them
    sizes = measure_cards(cards, br, render) if br and not a.no_measure else None
    cards, stock = choose_big_formats(cards, sizes, a)
    if not cards:
        print("Nothing left to make.")
        return 1

    # ---- write the files
    sections = [("main", "")]
    if stock:
        orders = [c.get("order", [None])[0] for c in cards]
        if sizes is None or "3x5" in orders:
            sections.append(("s35", "-3x5-index-cards"))
        if sizes is None or "5x8" in orders:
            sections.append(("s58", "-5x8-index-cards"))
        if sizes is not None and all(o in ("3x5", "5x8") for o in orders):
            sections = [x for x in sections if x[0] != "main"]
    halves = [("fronts", "-fronts"), ("backs", "-backs")] if a.split else [("", "")]
    jobs = []
    for sec, ssuf in sections:
        for only, osuf in halves:
            jobs.append(render(out.with_name(out.name + ssuf + osuf + ".html"), cards,
                               {"only": only, "section": sec, "stock": stock}))
    print()
    for j in jobs:
        print(f"Saved {j}")
    result = jobs[0]
    if not a.no_pdf:
        if br:
            for j in jobs:
                pdf_path = j.with_suffix(".pdf")
                if make_pdf(j, pdf_path, br):
                    print(f"Saved {pdf_path}")
                    if j is jobs[0]:
                        result = pdf_path
                else:
                    warn("PDF export didn't work; open the HTML file and print it instead.")
        else:
            print("(No Chrome/Edge/Chromium found for PDF export - open the HTML and print it.)")
    if a.split:
        print("Single-sided printing: print each FRONTS file, put the printed stack back in the tray\n"
              f"(flipped over its {a.duplex} edge), then print the matching BACKS file. 100% scale, margins 'None'.")
    else:
        print("Print at 100% scale, margins 'None', background graphics ON, double-sided "
              f"(flip on {a.duplex} edge).")
    if stock:
        print("Index-card files are sized to the card itself: load index cards in the printer's manual/card tray.")
    off = load_settings().get("back_offset") or [0, 0]
    if any(off):
        print(f"Back side shifted X {fmt_mm(off[0])} mm, Y {fmt_mm(off[1])} mm to match your printer (--back-offset 0,0 resets).")
    if a.open or pausing:
        try:
            if os.name == "nt":
                os.startfile(str(result))
            elif sys.platform == "darwin":
                subprocess.Popen(["open", str(result)])
            else:
                subprocess.Popen(["xdg-open", str(result)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
