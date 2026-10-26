/*
 * Card Forge core - turns 5e.tools entries into card data.
 * A line-for-line JavaScript port of cardforge.py (same names, same output) so the website and the
 * Python tool make identical cards.  Runs in the browser (window.CardForgeCore) and in Node (require).
 *
 * Data access is synchronous, like the Python version: Data.get() either returns a file it already has or
 * throws NeedData.  build() catches that, downloads the file, and runs the entry again.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.CardForgeCore = mod;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const VERSION = "2.0";
  const DATA_BASES = [
    "https://5e.tools/data/",
    "https://raw.githubusercontent.com/5etools-mirror-3/5etools-src/main/data/",
    "https://5etools-mirror-3.github.io/data/",
  ];
  const BREW_ROOTS = [
    "https://raw.githubusercontent.com/TheGiddyLimit/homebrew/master/",
    "https://raw.githubusercontent.com/TheGiddyLimit/unearthed-arcana/master/",
  ];
  const SOURCE_ABBR = {};     // lower-case source id -> abbreviation (filled in as homebrew files are loaded)
  const BREW_SCHOOLS = {};    // spell schools defined by homebrew

  // ------------------------------------------------------------------ Python-isms
  const isStr = x => typeof x === "string";
  const isNum = x => typeof x === "number";
  const isList = Array.isArray;
  const isDict = x => x !== null && typeof x === "object" && !Array.isArray(x);
  const has = (o, k) => isDict(o) && Object.prototype.hasOwnProperty.call(o, k);
  /** dict.get(k, d) */
  const get = (o, k, d) => (has(o, k) ? o[k] : d);
  /** Python truthiness */
  const T = x => !(x === undefined || x === null || x === false || x === 0 || x === "" || Number.isNaN(x)
    || (isList(x) && x.length === 0) || (isDict(x) && Object.keys(x).length === 0));
  /** `a or b` */
  const or = (...xs) => { for (const x of xs.slice(0, -1)) if (T(x)) return x; return xs[xs.length - 1]; };
  /** str(x) */
  function pyStr(x) {
    if (x === null || x === undefined) return "None";
    if (x === true) return "True";
    if (x === false) return "False";
    if (isList(x)) return "[" + x.map(pyRepr).join(", ") + "]";
    if (isDict(x)) return "{" + Object.entries(x).map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`).join(", ") + "}";
    return String(x);
  }
  function pyRepr(x) { return isStr(x) ? "'" + x.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'" : pyStr(x); }
  const isCased = ch => ch.toLowerCase() !== ch.toUpperCase();
  /** str.title() */
  function title(s) {
    s = pyStr(s); let out = "", prev = false;
    for (const ch of s) {
      if (isCased(ch)) { out += prev ? ch.toLowerCase() : ch.toUpperCase(); prev = true; } else { out += ch; prev = false; }
    }
    return out;
  }
  /** str.capitalize() */
  const capitalize = s => { s = pyStr(s); return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s; };
  const floorDiv = (a, b) => Math.floor(a / b);
  const commas = n => { const [i, f] = String(n).split("."); return i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f !== undefined ? "." + f : ""); };
  function deepEqual(a, b) {
    if (a === b) return true;
    if (isList(a) && isList(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
    if (isDict(a) && isDict(b)) {
      const ka = Object.keys(a), kb = Object.keys(b);
      return ka.length === kb.length && ka.every(k => has(b, k) && deepEqual(a[k], b[k]));
    }
    if ((a === true || a === false) && isNum(b)) return Number(a) === b;   // Python: True == 1
    if ((b === true || b === false) && isNum(a)) return Number(b) === a;
    return false;
  }
  const inList = (x, arr) => arr.some(y => deepEqual(x, y));
  const deepCopy = x => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  /** urllib.parse.unquote */
  const unquote = s => String(s).replace(/(%[0-9A-Fa-f]{2})+/g, m => { try { return decodeURIComponent(m); } catch (e) { return m; } });
  /** urllib.parse.quote (safe="/") */
  const quote = s => String(s).split("/").map(p => encodeURIComponent(p).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase())).join("/");
  /** str.splitlines() */
  const splitlines = s => { const a = String(s).split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/); if (a.length && a[a.length - 1] === "") a.pop(); return a; };
  /** urllib.parse.urlparse (the parts we use) */
  function urlparse(url) {
    let rest = String(url), fragment = "", query = "";
    const hi = rest.indexOf("#"); if (hi >= 0) { fragment = rest.slice(hi + 1); rest = rest.slice(0, hi); }
    const qi = rest.indexOf("?"); if (qi >= 0) { query = rest.slice(qi + 1); rest = rest.slice(0, qi); }
    let scheme = "", netloc = "", path = rest;
    const m = rest.match(/^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s);
    if (m) { scheme = m[1].toLowerCase(); path = m[2]; }
    if (path.startsWith("//")) { const j = path.indexOf("/", 2); netloc = j < 0 ? path.slice(2) : path.slice(2, j); path = j < 0 ? "" : path.slice(j); }
    return { scheme, netloc, path, query, fragment };
  }
  /** "a_b_c".rsplit("_", 1) */
  const rsplit1 = (s, sep) => { const i = s.lastIndexOf(sep); return i < 0 ? [s] : [s.slice(0, i), s.slice(i + sep.length)]; };
  /** "a:b:c".split(":", 1) */
  const split1 = (s, sep) => { const i = s.indexOf(sep); return i < 0 ? [s] : [s.slice(0, i), s.slice(i + sep.length)]; };
  /** sort by a key that is an array of booleans/numbers (Python tuple keys) */
  const keyCmp = f => (a, b) => { const ka = f(a), kb = f(b); for (let i = 0; i < ka.length; i++) { const d = Number(ka[i]) - Number(kb[i]); if (d) return d; } return 0; };

  // ------------------------------------------------------------------ warnings
  let WARN = [];
  function warn(msg) { WARN.push(String(msg)); }

  /** thrown when a data file is needed that hasn't been downloaded yet */
  class NeedData {
    constructor(req) { this.req = req; this.message = "need " + req.key; }
  }
  const rethrow = e => { if (e instanceof NeedData) throw e; };

  // ------------------------------------------------------------------ data access
  class Data {
    /** store: Map cacheKey -> {ok, value, errors}.  Filled by the async loader (or synchronously in Node). */
    constructor({ extraBase = null, store = new Map(), local = null } = {}) {
      this.bases = (extraBase ? [extraBase] : []).concat(DATA_BASES);
      this.store = store;
      this.local = local;          // optional synchronous loader {data(rel), brewIndex(), brewFile(ref)} (Node tests)
      this.mem = {};
      this._brewIndex = null;
      this._brewFiles = {};
    }
    _download(urls, key, label, optional = false) {
      const s = this.store.get(key);
      if (s === undefined) throw new NeedData({ urls, key, label, optional });
      if (s.ok) return s.value;
      if (optional) return null;
      throw new Error("Could not download " + label + "\n    " + (s.errors || []).join("\n    "));
    }
    get(rel, optional = false) {
      if (has(this.mem, rel)) return this.mem[rel];
      let result = null;
      if (this.local) {
        result = this.local.data(rel);
        if (result === undefined) {
          if (!optional) throw new Error(`${rel} not found in --data-dir`);
          result = null;
        }
      } else {
        result = this._download(this.bases.map(b => b + rel), "data:" + rel, rel, optional);
      }
      this.mem[rel] = result;
      return result;
    }
    brewIndex() {
      if (this._brewIndex === null) {
        const idx = {};
        if (this.local) {
          for (const [k, v] of Object.entries(this.local.brewIndex() || {})) if (!has(idx, k.toLowerCase())) idx[k.toLowerCase()] = ["dir", null, v];
        } else {
          for (const r of BREW_ROOTS) {
            let j;
            try { j = this._download([r + "_generated/index-sources.json"], "brew-index:" + r, r, true) || {}; }
            catch (e) { rethrow(e); j = {}; }
            for (const [k, v] of Object.entries(j)) if (!has(idx, k.toLowerCase())) idx[k.toLowerCase()] = ["url", r, v];
          }
        }
        this._brewIndex = idx;
      }
      return this._brewIndex;
    }
    brew(source) {
      const key = String(source || "").toLowerCase();
      if (!key) return null;
      if (has(this._brewFiles, key)) return this._brewFiles[key];
      let out = null;
      const ref = get(this.brewIndex(), key);
      if (ref) {
        const [kind, r, path] = ref;
        try {
          if (kind === "dir") out = this.local.brewFile(path);
          else out = this._download([r + quote(path)], "brew:" + r + path, path, true);
        } catch (e) { rethrow(e); warn(`couldn't load homebrew file ${path}: ${e.message || e}`); }
      }
      if (T(out)) {
        const meta = or(get(out, "_meta"), {});
        for (const src of or(get(meta, "sources"), [])) {
          if (T(get(src, "json"))) SOURCE_ABBR[src.json.toLowerCase()] = or(get(src, "abbreviation"), src.json);
        }
        for (const [k, v] of Object.entries(or(get(meta, "spellSchools"), {}))) BREW_SCHOOLS[k] = or(get(or(v, {}), "full"), k);
      }
      this._brewFiles[key] = out;
      return out;
    }
  }

  // ------------------------------------------------------------------ text helpers
  const esc = s => pyStr(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const ATK = { "mw": "Melee Weapon Attack:", "rw": "Ranged Weapon Attack:", "mw,rw": "Melee or Ranged Weapon Attack:",
    "ms": "Melee Spell Attack:", "rs": "Ranged Spell Attack:", "ms,rs": "Melee or Ranged Spell Attack:",
    "m": "Melee Attack:", "r": "Ranged Attack:" };
  const ATKR = { "m": "Melee Attack Roll:", "r": "Ranged Attack Roll:", "m,r": "Melee or Ranged Attack Roll:" };
  const ABIL = { "str": "Strength", "dex": "Dexterity", "con": "Constitution", "int": "Intelligence", "wis": "Wisdom", "cha": "Charisma" };
  const TAG_RE = /\{@(\w+)(?: ([^{}]*?))?\}/g;

  function pyInt(v) {   // int(str(v).strip()) or null
    const s = pyStr(v).trim().replace(/_/g, "");
    return /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : null;
  }
  function signed(n) {
    const v = pyInt(n);
    if (v === null) return pyStr(n);
    return v >= 0 ? `+${v}` : `−${Math.abs(v)}`;
  }

  function _tag(tag, text) {
    text = text || "";
    const p = text.split("|");
    const t0 = p[0];
    const disp = p.length > 2 && p[2] ? p[2] : t0;
    if (tag === "b" || tag === "bold") return `<b>${t0}</b>`;
    if (tag === "i" || tag === "italic" || tag === "note") return `<i>${t0}</i>`;
    if (tag === "s" || tag === "strike") return `<s>${t0}</s>`;
    if (tag === "u" || tag === "underline") return `<u>${t0}</u>`;
    if (["sup", "sub", "code", "kbd"].includes(tag)) return `<${tag}>${t0}</${tag}>`;
    if (tag === "h") return "<i>Hit:</i> ";
    if (tag === "m") return "<i>Miss:</i> ";
    if (tag === "hom") return "<i>Hit or Miss:</i> ";
    if (tag === "atk") return `<i>${get(ATK, t0, "Attack:")}</i>`;
    if (tag === "atkr") return `<i>${get(ATKR, t0, "Attack Roll:")}</i>`;
    if (tag === "hit") return signed(t0);
    if (tag === "dc") return `DC ${t0}`;
    if (tag === "dcYourSpellSave") return t0 || "your spell save DC";
    if (tag === "hitYourSpellAttack") return t0 || "your spell attack modifier";
    if (["damage", "dice", "autodice"].includes(tag)) return p.length > 1 && p[1] ? p[1] : t0;
    if (tag === "d20") return p.length > 1 && p[1] ? p[1] : signed(t0);
    if (tag === "scaledamage" || tag === "scaledice") return p.length > 2 ? p[2] : t0;
    if (tag === "recharge") return !t0 || t0 === "6" ? "(Recharge 6)" : `(Recharge ${t0}–6)`;
    if (tag === "chance") return p.length > 1 && p[1] ? p[1] : `${t0} percent`;
    if (tag === "coinflip") return t0 || "flip a coin";
    if (tag === "skillCheck" || tag === "savingThrow") return p.length > 1 ? signed(p[1]) : t0;
    if (tag === "ability") {
      const sc = pyInt(t0.split(" ").pop());
      return sc === null ? t0 : `${sc} (${signed(floorDiv(sc - 10, 2))})`;
    }
    if (tag === "actSave") return `<i>${get(ABIL, t0, title(t0))} Saving Throw:</i>`;
    if (tag === "actSaveFail") return t0 ? `<i>Failure by ${t0} or More:</i>` : "<i>Failure:</i>";
    if (tag === "actSaveSuccess") return "<i>Success:</i>";
    if (tag === "actSaveSuccessOrFail") return "<i>Failure or Success:</i>";
    if (tag === "actTrigger") return "<i>Trigger:</i>";
    if (tag === "actResponse") return "<i>Response:</i>";
    if (tag === "spell") return `<i>${disp}</i>`;
    if (tag === "classFeature") return p.length > 5 && p[5] ? p[5] : t0;
    if (tag === "subclassFeature") return p.length > 7 && p[7] ? p[7] : t0;
    if (tag === "subclass") return p.length > 4 && p[4] ? p[4] : t0;
    if (tag === "deity" || tag === "card") return p.length > 3 && p[3] ? p[3] : t0;
    if (tag === "quickref") return p.length > 4 && p[4] ? p[4] : t0;
    if (["filter", "link", "5etools", "book", "adventure", "footnote", "area", "loader", "homebrew", "unit", "help"].includes(tag)) return t0;
    return disp;
  }

  /** 5etools tagged string -> HTML */
  function tx(s) {
    s = esc(s);
    for (let i = 0; i < 12; i++) {
      const n = s.replace(TAG_RE, (m, tag, text) => _tag(tag, text));
      if (n === s) break;
      s = n;
    }
    return s;
  }
  const plain = s => tx(s).replace(/<[^>]+>/g, "");

  // ------------------------------------------------------------------ entries -> blocks
  let REF_LOOKUP = null;   // while building a class-feature card: fn(kind, uid) -> referenced feature or null
  const _REF_SEEN = new Set();

  class Blocks {
    constructor() { this.out = []; this._sec = null; this._start = false; }
    section() { this._sec = (this._sec || 0) + 1; this._start = true; }
    add(kind, h, extra) {
      const d = { k: kind, h };
      if (this._sec !== null) {
        d.s = this._sec;
        if (this._start) { d.ss = 1; this._start = false; }
      }
      if (extra) Object.assign(d, extra);
      this.out.push(d);
    }
    p(h, cls = "") { this.add("p", cls ? `<p class="${cls}">${h}</p>` : `<p>${h}</p>`); }
  }

  function inline(e) {
    if (e === null || e === undefined) return "";
    if (isStr(e) || isNum(e) || typeof e === "boolean") return tx(e);
    if (isList(e)) return e.map(inline).join(" ");
    if (!isDict(e)) return "";
    const t = get(e, "type");
    if (t === "cell") {
      const r = get(e, "roll", {});
      if (has(r, "exact")) return pyStr(r.exact).padStart(T(get(r, "pad")) ? 2 : 1, "0");
      if (has(r, "min")) { const a = r.min, b = get(r, "max"); return b !== null && b !== undefined ? `${pyStr(a)}–${pyStr(b)}` : `${pyStr(a)}+`; }
      return inline(get(e, "entry"));
    }
    if (t === "dice") {
      const tr = get(e, "toRoll");
      if (isList(tr)) return tr.map(d => `${pyStr(get(d, "number", 1))}d${pyStr(get(d, "faces"))}`).join("+");
      return pyStr(or(tr, ""));
    }
    if (t === "bonus") return signed(get(e, "value", 0));
    if (t === "bonusSpeed") return signed(get(e, "value", 0)) + " ft.";
    if (t === "link") return tx(get(e, "text", ""));
    if (t === "abilityDc" || t === "abilityAttackMod") return ability_line(e);
    if (["refClassFeature", "refSubclassFeature", "refOptionalfeature", "refFeat"].includes(t)) {
      const ref = or(get(e, "classFeature"), get(e, "subclassFeature"), get(e, "optionalfeature"), get(e, "feat"), "");
      return tx(pyStr(ref).split("|")[0]);
    }
    for (const key of ["entries", "items"]) {
      if (has(e, key)) return (T(get(e, "name")) ? `<b>${tx(e.name)}.</b> ` : "") + inline(e[key]);
    }
    if (has(e, "entry")) return (T(get(e, "name")) ? `<b>${tx(e.name)}.</b> ` : "") + inline(e.entry);
    if (has(e, "name")) return tx(e.name);
    return "";
  }

  function ability_line(e) {
    const attrs = get(e, "attributes", []);
    const a = T(attrs) ? attrs.map(x => get(ABIL, x, x)).join(" or ") : "spellcasting ability";
    if (get(e, "type") === "abilityDc") return `<b>${tx(get(e, "name", ""))} save DC</b> = 8 + your proficiency bonus + your ${a} modifier`;
    return `<b>${tx(get(e, "name", ""))} attack modifier</b> = your proficiency bonus + your ${a} modifier`;
  }

  function render_table(e, b) {
    const parts = [];
    if (T(get(e, "caption"))) parts.push(`<caption>${tx(e.caption)}</caption>`);
    const cols = or(get(e, "colLabels"), []);
    const styles = or(get(e, "colStyles"), []);
    if (T(cols)) parts.push("<thead><tr>" + cols.map(c => `<th>${inline(c)}</th>`).join("") + "</tr></thead>");
    const rows = [];
    for (let r of get(e, "rows", [])) {
      if (isDict(r) && get(r, "type") === "row") r = get(r, "row", []);
      if (!isList(r)) r = [r];
      const cells = r.map((c, i) => {
        const st = i < styles.length ? styles[i] : "";
        const cls = pyStr(st).includes("text-center") ? ' class="c"' : "";
        return `<td${cls}>${inline(c)}</td>`;
      });
      rows.push("<tr>" + cells.join("") + "</tr>");
    }
    parts.push("<tbody>" + rows.join("") + "</tbody>");
    b.add("table", "<table>" + parts.join("") + "</table>");
    for (const f of or(get(e, "footnotes", []), [])) b.p(tx(f), "small");
  }

  function render_entries(entries, b, depth = 0) {
    if (entries === null || entries === undefined) return;
    if (!isList(entries)) entries = [entries];
    for (const e of entries) render_entry(e, b, depth);
  }

  function render_entry(e, b, depth = 0) {
    if (isStr(e) || isNum(e) || typeof e === "boolean") { b.p(tx(e)); return; }
    if (!isDict(e)) return;
    const t = get(e, "type", "entries");
    const name = get(e, "name");
    if (["entries", "section", "inset", "insetReadaloud", "variant", "variantSub", "variantInner", "options"].includes(t)) {
      let kids = get(e, "entries", []);
      const cls = ["inset", "insetReadaloud", "variant"].includes(t) ? "inset" : "";
      if (T(name) && T(kids) && isStr(kids[0]) && !(depth === 0 && t === "section")) {
        b.p(`<b><i>${tx(name)}.</i></b> ${tx(kids[0])}`, cls);
        kids = kids.slice(1);
      } else if (T(name)) {
        b.add("h", `<h4 class="${cls}">${tx(name)}</h4>`);
      }
      for (const k of (isList(kids) ? kids : [])) {
        if (isStr(k)) b.p(tx(k), cls);
        else render_entry(k, b, depth + 1);
      }
    } else if (t === "list") {
      for (const it of get(e, "items", [])) {
        if (isStr(it)) b.add("li", `<p class="li">${tx(it)}</p>`);
        else if (isDict(it) && ["item", "itemSub", "itemSpell"].includes(get(it, "type"))) {
          let body = get(it, "entry");
          if (body === null || body === undefined) body = get(it, "entries", []);
          let first, rest;
          if (isList(body)) { first = body.length ? body[0] : ""; rest = body.slice(1); }
          else { first = body; rest = []; }
          const nm = T(get(it, "name")) ? `<b>${tx(get(it, "name", ""))}</b> ` : "";
          b.add("li", `<p class="li">${nm}${inline(first)}</p>`);
          for (const r of rest) {
            if (isStr(r)) b.p(tx(r), "ind");
            else render_entry(r, b, depth + 1);
          }
        } else b.add("li", `<p class="li">${inline(it)}</p>`);
      }
    } else if (t === "table") render_table(e, b);
    else if (t === "tableGroup") { for (const tbl of get(e, "tables", [])) render_table(tbl, b); }
    else if (t === "quote") {
      for (const q of get(e, "entries", [])) b.p(`<i>${inline(q)}</i>`, "quote");
      if (T(get(e, "by"))) b.p(`— ${tx(e.by)}` + (T(get(e, "from")) ? `, <i>${tx(e.from)}</i>` : ""), "quote r");
    } else if (t === "inline" || t === "inlineBlock") b.p(inline(get(e, "entries", [])));
    else if (t === "abilityDc" || t === "abilityAttackMod") b.p(ability_line(e), "c");
    else if (t === "hr") b.add("hr", "<hr>");
    else if (t === "spellcasting") render_spellcasting(e, b);
    else if (["image", "gallery", "statblock", "statblockInline", "flowchart", "flowBlock", "homebrew", "wrapper"].includes(t)) {
      if (t === "flowBlock" || t === "flowchart") render_entries(or(get(e, "entries"), get(e, "blocks")), b, depth + 1);
      return;
    } else if (t === "item") b.p((T(name) ? `<b>${tx(name)}</b> ` : "") + inline(get(e, "entry", get(e, "entries", ""))));
    else if (t === "refClassFeature" || t === "refSubclassFeature") {
      const uid = pyStr(or(get(e, "classFeature"), get(e, "subclassFeature"), ""));
      const feat = REF_LOOKUP ? REF_LOOKUP(t === "refClassFeature" ? "classFeature" : "subclassFeature", uid) : null;
      if (feat === null || feat === undefined || _REF_SEEN.has(uid.toLowerCase())) b.p(`<b>${tx(uid.split("|")[0])}</b>`);
      else {
        _REF_SEEN.add(uid.toLowerCase());
        try { render_entry({ type: "entries", name: get(feat, "name"), entries: get(feat, "entries", []) }, b, depth + 1); }
        finally { _REF_SEEN.delete(uid.toLowerCase()); }
      }
    } else if (t === "refOptionalfeature" || t === "refFeat") b.add("li", `<p class="li">${inline(e)}</p>`);
    else {
      const h = inline(e);
      if (h) b.p(h);
    }
  }

  // ------------------------------------------------------------------ _copy / _mod resolution
  function _walk_str(obj, fn) {
    if (isStr(obj)) return fn(obj);
    if (isList(obj)) return obj.map(x => _walk_str(x, fn));
    if (isDict(obj)) { const o = {}; for (const [k, v] of Object.entries(obj)) o[k] = _walk_str(v, fn); return o; }
    return obj;
  }
  const TEXT_PROPS = ["entries", "trait", "action", "bonus", "reaction", "legendary", "mythic", "spellcasting"];

  function apply_mod(ent, prop, mod) {
    const mode = isDict(mod) ? get(mod, "mode") : mod;
    if (mode === "remove") { delete ent[prop]; return; }
    if (mode === "replaceTxt") {
      const rx = new RegExp(mod.replace, "g" + (pyStr(get(mod, "flags", "")).includes("i") ? "i" : ""));
      const w = pyStr(get(mod, "with", ""));
      let props = prop === "*" ? TEXT_PROPS : [prop];
      if (T(get(mod, "props"))) props = mod.props.filter(p => T(p));
      for (const p of props) if (has(ent, p)) ent[p] = _walk_str(ent[p], s => s.replace(rx, w));
      return;
    }
    if (mode === "scalarAddHit" || mode === "scalarAddDc") {
      const n = pyInt(get(mod, "scalar", 0)) || 0;
      const tag = mode === "scalarAddHit" ? "hit" : "dc";
      const pat = new RegExp("\\{@" + tag + " (-?\\d+)", "g");
      const props = prop === "*" ? TEXT_PROPS : [prop];
      for (const p of props) if (has(ent, p)) ent[p] = _walk_str(ent[p], s => s.replace(pat, (m, g1) => "{@" + tag + ` ${parseInt(g1, 10) + n}`));
      return;
    }
    if (mode === "addSenses") {
      if (!has(ent, "senses")) ent.senses = [];
      const senses = or(ent.senses, []);
      const list = isList(get(mod, "senses")) ? mod.senses : [get(mod, "senses")];
      for (const s of list) if (T(s)) senses.push(`${pyStr(s.type)} ${pyStr(s.range)} ft.`);
      ent.senses = senses;
      return;
    }
    if (mode === "addSkills") {
      if (!has(ent, "skill")) ent.skill = {};
      const sk = or(ent.skill, {});
      const pb = cr_pb(get(ent, "cr"));
      for (const [skill, lvl] of Object.entries(or(get(mod, "skills"), {}))) {
        const abil = get(SKILL_ABIL, skill, "wis");
        sk[skill] = signed(floorDiv(get(ent, abil, 10) - 10, 2) + pb * pyInt(lvl));
      }
      ent.skill = sk;
      return;
    }
    if (mode === "addSpells" || mode === "replaceSpells") {
      for (const sc of or(get(ent, "spellcasting", []), [])) {
        if (mode === "addSpells") {
          for (const k of ["will", "ritual"]) {
            if (T(get(mod, k))) { if (!has(sc, k)) sc[k] = []; sc[k].push(...mod[k]); }
          }
          for (const k of ["daily", "spells"]) {
            for (const [lvl, v] of Object.entries(or(get(mod, k), {}))) {
              if (k === "spells") {
                if (!has(sc, "spells")) sc.spells = {};
                if (!has(sc.spells, lvl)) sc.spells[lvl] = { spells: [] };
                sc.spells[lvl].spells.push(...get(v, "spells", []));
              } else {
                if (!has(sc, "daily")) sc.daily = {};
                if (!has(sc.daily, lvl)) sc.daily[lvl] = [];
                sc.daily[lvl].push(...v);
              }
            }
          }
        }
        break;
      }
      return;
    }
    if (mode === "scalarAddProp" || mode === "scalarMultProp") {
      const target = get(ent, prop);
      const keys = T(get(mod, "prop")) && mod.prop !== "*" ? [mod.prop] : (isDict(target) ? Object.keys(target) : []);
      for (const k of keys) {
        try {
          let v = pyInt(pyStr(target[k]).replace("+", ""));
          if (v === null) throw new Error("not a number");
          v = mode === "scalarAddProp" ? v + pyInt(mod.scalar) : Math.trunc(v * parseFloat(mod.scalar));
          if (Number.isNaN(v)) throw new Error("not a number");
          target[k] = /^[+-]/.test(pyStr(target[k])) ? signed(v) : v;
        } catch (e) { rethrow(e); }
      }
      return;
    }
    // array modes
    let arr = get(ent, prop);
    if (arr === null || arr === undefined) arr = [];
    arr = isList(arr) ? arr.slice() : [arr];
    let items = get(mod, "items", []);
    if (!isList(items)) items = [items];
    const nm = x => (isDict(x) ? get(x, "name") : x);
    if (mode === "appendArr") arr.push(...items);
    else if (mode === "prependArr") arr = items.concat(arr);
    else if (mode === "insertArr") arr.splice(get(mod, "index", 0), 0, ...items);
    else if (mode === "appendIfNotExistsArr") { for (const x of items) if (!inList(x, arr)) arr.push(x); }
    else if (mode === "replaceArr" || mode === "replaceOrAppendArr") {
      const rep = get(mod, "replace");
      let idx = null;
      if (isDict(rep) && has(rep, "index")) idx = rep.index;
      else {
        for (let i = 0; i < arr.length; i++) { if (deepEqual(nm(arr[i]), rep) || deepEqual(arr[i], rep)) { idx = i; break; } }
      }
      if (idx !== null && idx < arr.length) arr.splice(idx, 1, ...items);
      else if (mode === "replaceOrAppendArr") arr.push(...items);
    } else if (mode === "removeArr") {
      let names = or(get(mod, "names"), []);
      if (!isList(names)) names = [names];
      const rem = or(get(mod, "items"), []);
      arr = arr.filter(x => !inList(nm(x), names) && !inList(x, isList(rem) ? rem : [rem]));
    }
    ent[prop] = arr;
  }

  function resolve_copy(ent, finder, depth = 0) {
    const cp = get(ent, "_copy");
    if (!T(cp) || depth > 6) return ent;
    let base = finder(get(cp, "name"), get(cp, "source"));
    if (base === null || base === undefined) {
      warn(`could not find '${pyStr(get(cp, "name"))}' (${pyStr(get(cp, "source"))}) that '${pyStr(get(ent, "name"))}' copies from`);
      const out = Object.assign({}, ent);
      delete out._copy;
      return out;
    }
    base = resolve_copy(deepCopy(base), finder, depth + 1);
    const preserve = or(get(cp, "_preserve"), {});
    for (const k of ["srd", "basicRules", "reprintedAs", "otherSources", "page", "hasFluff", "hasFluffImages", "legendaryGroup", "_versions"]) {
      if (!has(preserve, k)) delete base[k];
    }
    for (const [k, v] of Object.entries(ent)) if (k !== "_copy") base[k] = deepCopy(v);
    for (const [prop, mods] of Object.entries(or(get(cp, "_mod"), {}))) {
      for (const mod of (isList(mods) ? mods : [mods])) {
        try { apply_mod(base, prop, mod); }
        catch (ex) { rethrow(ex); warn(`skipped a modification on ${pyStr(get(ent, "name"))}: ${ex.message || ex}`); }
      }
    }
    return base;
  }
  // ------------------------------------------------------------------ categories
  const ORD = { 1: "1st", 2: "2nd", 3: "3rd" };
  const ordinal = n => get(ORD, n, `${pyStr(n)}th`);
  const SCHOOL = { "A": "Abjuration", "C": "Conjuration", "D": "Divination", "E": "Enchantment", "V": "Evocation",
    "I": "Illusion", "N": "Necromancy", "T": "Transmutation", "P": "Psionic" };
  const SPELL_COLOR = "#3b4a8c";
  const UNIT = { "action": "action", "bonus": "bonus action", "reaction": "reaction", "minute": "minute",
    "hour": "hour", "round": "round", "day": "day", "week": "week", "year": "year", "turn": "turn" };
  const plural = (n, word) => `${pyStr(n)} ${pyStr(word)}` + (n === 1 ? "" : "s");

  function spell_time(times) {
    const out = [];
    for (const t of or(times, [])) {
      let s = plural(get(t, "number", 1), get(UNIT, get(t, "unit"), get(t, "unit", "")));
      if (T(get(t, "condition"))) s += ", " + tx(t.condition);
      if (T(get(t, "note"))) s += ` (${tx(t.note)})`;
      out.push(s);
    }
    return out.join(" or ");
  }
  function dist(d) {
    if (!T(d)) return "";
    const t = get(d, "type");
    if (["self", "touch", "sight", "unlimited", "special"].includes(t))
      return { self: "Self", touch: "Touch", sight: "Sight", unlimited: "Unlimited", special: "Special" }[t];
    const a = get(d, "amount", "");
    const unit = get({ feet: "foot", miles: "mile" }, t, t);
    return t === "feet" || t === "miles" ? `${pyStr(a)} ${pyStr(t)}` : `${pyStr(a)} ${pyStr(unit)}`;
  }
  function spell_range(r) {
    if (!T(r)) return "";
    const t = get(r, "type");
    const d = get(r, "distance", {});
    if (["self", "touch", "sight", "unlimited"].includes(t)) return dist({ type: t });
    if (t === "point") return dist(d);
    if (t === "special") return "Special";
    if (["radius", "sphere", "cone", "line", "cube", "hemisphere", "cylinder", "emanation"].includes(t)) {
      const unit = get({ feet: "foot", miles: "mile" }, get(d, "type"), get(d, "type"));
      return `Self (${pyStr(get(d, "amount"))}-${pyStr(unit)} ${t})`;
    }
    return dist(d);
  }
  function spell_components(c) {
    if (!T(c)) return ["", ""];
    const parts = ["v", "s"].filter(k => T(get(c, k))).map(k => k.toUpperCase());
    let mat = "";
    const m = get(c, "m");
    if (T(m)) { parts.push("M"); mat = isStr(m) ? m : get(m, "text", ""); }
    if (T(get(c, "r"))) parts.push("R");
    return [parts.join(", "), tx(mat)];
  }
  function spell_duration(durs) {
    const out = [];
    for (const d of or(durs, [])) {
      const t = get(d, "type");
      if (t === "instant") out.push("Instantaneous");
      else if (t === "timed") {
        const dd = get(d, "duration", {});
        let s = plural(get(dd, "amount", 1), get(dd, "type", ""));
        if (T(get(dd, "upTo")) || T(get(d, "concentration"))) s = "up to " + s;
        if (T(get(d, "concentration"))) s = "Concentration, " + s;
        out.push(s[0].toUpperCase() + s.slice(1));
      } else if (t === "permanent") {
        const ends = get(d, "ends", []);
        const words = { dispel: "dispelled", trigger: "triggered", discharge: "discharged" };
        out.push(T(ends) ? "Until " + ends.map(e => get(words, e, e)).join(" or ") : "Permanent");
      } else if (t === "special") out.push("Special");
      else out.push(or(t, ""));
    }
    return out.join(" or ");
  }
  function src_line(e) {
    let s = get(e, "source", "");
    s = get(SOURCE_ABBR, pyStr(s).toLowerCase(), s);
    if (T(get(e, "page"))) s += ` p.${pyStr(e.page)}`;
    return s;
  }

  const SCROLL_COLOR = "#7a4a1c";
  const SCROLL_TABLE = { 0: ["common", 13, 5], 1: ["common", 13, 5], 2: ["uncommon", 13, 5], 3: ["uncommon", 15, 7],
    4: ["rare", 15, 7], 5: ["rare", 17, 9], 6: ["very rare", 17, 9], 7: ["very rare", 18, 10],
    8: ["very rare", 18, 10], 9: ["legendary", 19, 11] };

  function build_spell(e, data, scroll = null) {
    const lvl = get(e, "level", 0);
    const school = get(e, "school", "V");
    const sname = or(get(SCHOOL, school), get(BREW_SCHOOLS, school), school);
    const ritual = get(or(get(e, "meta"), {}), "ritual");
    let sub = lvl === 0 ? `${sname} cantrip` : `${ordinal(lvl)}-level ${pyStr(sname).toLowerCase()}`;
    if (T(ritual)) sub += " (ritual)";
    const [comp, mat] = spell_components(get(e, "components"));
    const cells = [["Casting Time", spell_time(get(e, "time"))], ["Range", spell_range(get(e, "range"))],
      ["Components", comp], ["Duration", spell_duration(get(e, "duration"))]];
    let hdr = '<div class="sgrid">' + cells.map(([a, b]) => `<div><span class="lbl">${a}</span>${b}</div>`).join("") + "</div>";
    if (mat) hdr += `<div class="mat">M: ${mat}</div>`;
    const classes = spell_classes(e, data);
    if (classes) hdr += `<div class="cls">${esc(classes)}</div>`;
    const b = new Blocks();
    render_entries(get(e, "entries"), b);
    for (const h of or(get(e, "entriesHigherLevel", []), [])) render_entries([h], b);
    const color = SPELL_COLOR;
    const card = {
      cat: "spell", name: e.name, sub, hdr, blocks: b.out,
      src: src_line(e), color, corner: lvl === 0 ? "C" : pyStr(lvl),
      back: { kind: "spell", label: "Spell", big: pyStr(lvl),
        bigsub: lvl === 0 ? "CANTRIP" : `${ordinal(lvl)} Level`.toUpperCase(),
        line: sname + (T(ritual) ? " • Ritual" : ""), icon: "star", color },
    };
    if (scroll) {
      const sl = scroll.level;
      card.color = SCROLL_COLOR;
      card.sub = "Spell scroll • " + sub;
      card.hdr = `<div class="scrollinfo"><b>Spell Scroll</b> • ${capitalize(scroll.rarity)} • `
        + `Save DC ${pyStr(scroll.dc)} • Attack ${signed(scroll.atk)}</div>` + hdr;
      b.p("<i>Read the scroll to cast the spell if it's on your spell list (no Material components needed); "
        + "the scroll then crumbles to dust.</i>", "small");
      card.blocks = b.out;
      card.corner = sl === 0 ? "C" : pyStr(sl);
      card.back = { kind: "scroll", label: "Spell Scroll", big: pyStr(sl),
        bigsub: sl === 0 ? "CANTRIP" : `${ordinal(sl)} Level`.toUpperCase(),
        line: sname + (T(ritual) ? " • Ritual" : ""), icon: "scroll", color: SCROLL_COLOR };
    }
    return card;
  }

  function spell_classes(e, data) {
    try {
      const srcs = or(data.get("spells/sources.json", true), {});
      const info = get(or(get(srcs, get(e, "source"), {}), {}), e.name, {});
      let names = new Set(get(info, "class", []).map(c => c.name));
      if (!names.size) {
        const cl = or(get(e, "classes"), {});
        names = new Set();
        for (const k of ["fromClassList", "fromClassListVariant"])
          for (const c of or(get(cl, k), [])) if (T(get(c, "name"))) names.add(c.name);
      }
      return [...names].sort().join(", ");
    } catch (ex) { rethrow(ex); return ""; }
  }

  // ----- monsters
  const SIZE = { "F": "Fine", "D": "Diminutive", "T": "Tiny", "S": "Small", "M": "Medium", "L": "Large",
    "H": "Huge", "G": "Gargantuan", "C": "Colossal", "V": "Varies" };
  const AL = { "L": "lawful", "N": "neutral", "C": "chaotic", "G": "good", "E": "evil", "U": "unaligned",
    "A": "any alignment", "NX": "neutral", "NY": "neutral" };
  const XP = { "0": 10, "1/8": 25, "1/4": 50, "1/2": 100, "1": 200, "2": 450, "3": 700, "4": 1100, "5": 1800,
    "6": 2300, "7": 2900, "8": 3900, "9": 5000, "10": 5900, "11": 7200, "12": 8400, "13": 10000,
    "14": 11500, "15": 13000, "16": 15000, "17": 18000, "18": 20000, "19": 22000, "20": 25000,
    "21": 33000, "22": 41000, "23": 50000, "24": 62000, "25": 75000, "26": 90000, "27": 105000,
    "28": 120000, "29": 135000, "30": 155000 };
  const SKILL_ABIL = { "acrobatics": "dex", "animal handling": "wis", "arcana": "int", "athletics": "str",
    "deception": "cha", "history": "int", "insight": "wis", "intimidation": "cha",
    "investigation": "int", "medicine": "wis", "nature": "int", "perception": "wis",
    "performance": "cha", "persuasion": "cha", "religion": "int", "sleight of hand": "dex",
    "stealth": "dex", "survival": "wis" };

  function cr_str(cr) {
    if (isDict(cr)) return get(cr, "cr", "—");
    return cr !== null && cr !== undefined ? cr : "—";
  }
  function cr_num(cr) {
    const c = cr_str(cr);
    try {
      if (pyStr(c).includes("/")) {
        const [a, b] = pyStr(c).split("/");
        const x = pyInt(a), y = pyInt(b);
        if (x === null || y === null || y === 0) return 0;
        return x / y;
      }
      const f = parseFloat(pyStr(c));
      return /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(pyStr(c)) ? f : 0;
    } catch (ex) { rethrow(ex); return 0; }
  }
  function cr_pb(cr) {
    const n = cr_num(cr);
    return n < 5 ? 2 : Math.min(9, 2 + Math.ceil((n - 4) / 4));
  }
  function mon_size(s) {
    s = isList(s) ? s : [s];
    return s.filter(x => T(x)).map(x => get(SIZE, x, x)).join(" or ");
  }
  function mon_type(t) {
    if (isStr(t)) return t;
    if (!isDict(t)) return "";
    let base = get(t, "type");
    if (isDict(base)) base = get(base, "choose", []).join(" or ");
    if (T(get(t, "swarmSize"))) base = `swarm of ${get(SIZE, t.swarmSize, "")} ${pyStr(base)}s`;
    const tags = [];
    for (const g of or(get(t, "tags", []), [])) tags.push(isStr(g) ? g : `${pyStr(get(g, "prefix", ""))} ${pyStr(get(g, "tag", ""))}`.trim());
    return pyStr(base) + (tags.length ? ` (${tags.join(", ")})` : "");
  }
  const setKey = a => [...new Set(a)].sort().join("|");
  const AL_COMBOS = [["L NX C NY G E", "any alignment"], ["L NX C NY E", "any non-good alignment"],
    ["L NX C NY G", "any non-evil alignment"], ["NX C NY G E", "any non-lawful alignment"],
    ["L NX NY G E", "any non-chaotic alignment"], ["C G E NY", "any chaotic alignment"],
    ["L G E NY", "any lawful alignment"], ["L C NX E", "any evil alignment"], ["L C NX G", "any good alignment"]];
  function alignment(al) {
    if (!T(al)) return "";
    if (isDict(al[0])) {
      const parts = [];
      for (const a of al) {
        if (T(get(a, "special"))) parts.push(a.special);
        else {
          const s = alignment(get(a, "alignment", []));
          parts.push(s + (T(get(a, "chance")) ? ` (${pyStr(a.chance)}%)` : ""));
        }
      }
      return parts.join(" or ");
    }
    const k = setKey(al);
    for (const [c, label] of AL_COMBOS) if (setKey(c.split(" ")) === k) return label;
    if ([["N"], ["NX", "NY"], ["N", "N"]].some(x => deepEqual(x, al))) return "neutral";
    return al.map(x => get(AL, x, x)).join(" ");
  }
  function mon_ac(ac) {
    const out = [];
    for (const a of or(ac, [])) {
      if (isDict(a)) {
        if (T(get(a, "special"))) { out.push(tx(a.special)); continue; }
        let s = pyStr(get(a, "ac", ""));
        if (T(get(a, "from"))) s += " (" + a.from.map(f => tx(f)).join(", ") + ")";
        if (T(get(a, "condition"))) s += " " + tx(a.condition);
        out.push(s);
      } else out.push(pyStr(a));
    }
    return out.join(", ");
  }
  function mon_hp(hp) {
    if (!T(hp)) return "";
    if (T(get(hp, "special"))) return tx(hp.special);
    return `${pyStr(get(hp, "average", ""))} (${pyStr(get(hp, "formula", ""))})`;
  }
  function mon_speed(sp) {
    if (!isDict(sp)) return pyStr(or(sp, ""));
    const out = [];
    for (const k of ["walk", "burrow", "climb", "fly", "swim"]) {
      if (!has(sp, k)) continue;
      const v = sp[k];
      let s;
      if (isDict(v)) s = `${pyStr(get(v, "number", ""))} ft.` + (T(get(v, "condition")) ? ` ${tx(v.condition)}` : "");
      else if (v === true) s = "equal to walking speed";
      else s = `${pyStr(v)} ft.`;
      if (k === "fly" && T(get(sp, "canHover")) && !s.includes("hover")) s += " (hover)";
      out.push(k === "walk" ? s : `${k} ${s}`);
    }
    if (T(get(sp, "choose"))) {
      const c = sp.choose;
      out.push(get(c, "from", []).join(" or ") + ` ${pyStr(get(c, "amount", ""))} ft.`);
    }
    return out.join(", ");
  }
  function dmg_list(lst, key) {
    const out = [], kinds = [];
    for (const x of or(lst, [])) {
      if (isStr(x)) { out.push(tx(x)); kinds.push(true); }
      else if (isDict(x)) {
        if (T(get(x, "special"))) { out.push(tx(x.special)); kinds.push(false); continue; }
        const inner = dmg_list(get(x, key, []), key);
        let s = (T(get(x, "preNote")) ? tx(x.preNote) + " " : "") + inner;
        if (T(get(x, "note"))) s += " " + tx(x.note);
        out.push(s); kinds.push(false);
      }
    }
    // Python zips `out` against the original list, which only lines up when every element produced output
    const src = or(lst, []);
    const simple = [], complex_ = [];
    for (let i = 0; i < Math.min(out.length, src.length); i++) (isStr(src[i]) ? simple : complex_).push(out[i]);
    let res = simple.join(", ");
    if (complex_.length) res = (res ? [res] : []).concat(complex_).join("; ");
    return res;
  }
  const spell_list = lst => lst.map(s => (!isDict(s) ? inline(s) : inline(get(s, "entry", "")))).join(", ");
  const FREQ = [["daily", "/day"], ["rest", "/rest"], ["weekly", "/week"], ["monthly", "/month"], ["yearly", "/year"],
    ["restLong", "/long rest"], ["recharge", ""]];

  function render_spellcasting(sc, b) {
    const head = get(sc, "headerEntries", []).map(h => inline(h)).join(" ");
    b.p(`<b><i>${tx(get(sc, "name", "Spellcasting"))}.</i></b> ${head}`);
    if (T(get(sc, "will"))) b.p(`At will: ${spell_list(sc.will)}`, "ind");
    for (const [freq, suf] of FREQ) {
      const ents = Object.entries(or(get(sc, freq), {})).sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
      for (const [k, v] of ents) {
        const each = k.endsWith("e");
        const n = k.replace(/e+$/, "");
        const label = freq !== "recharge" ? `${n}${suf}` + (each ? " each" : "") : `Recharge ${n}`;
        b.p(`${label}: ${spell_list(v)}`, "ind");
      }
    }
    const lv = Object.entries(or(get(sc, "spells"), {})).sort((a, b) => pyInt(a[0]) - pyInt(b[0]));
    for (const [lvl, info] of lv) {
      const l = pyInt(lvl);
      let lab;
      if (l === 0) lab = "Cantrips (at will)";
      else {
        const slots = get(info, "slots");
        lab = `${ordinal(l)} level` + (T(slots) ? ` (${pyStr(slots)} slot${slots !== 1 ? "s" : ""})` : "");
        if (T(get(info, "lower"))) lab = `${ordinal(info.lower)}–${ordinal(l)} level` + (T(slots) ? ` (${pyStr(slots)} ${ordinal(l)}-level slots)` : "");
      }
      b.p(`${lab}: ${spell_list(get(info, "spells", []))}`, "ind");
    }
    for (const f of or(get(sc, "footerEntries", []), [])) b.p(inline(f));
  }

  function named_list(items, b, boxed = false) {
    for (const it of or(items, [])) {
      const t = boxed ? new Blocks() : b;
      if (get(it, "type") === "spellcasting" || has(it, "headerEntries")) render_spellcasting(it, t);
      else {
        const ents = get(it, "entries", []);
        const name = get(it, "name");
        if (T(name) && T(ents) && isStr(ents[0])) {
          t.p(`<b><i>${tx(name)}.</i></b> ${tx(ents[0])}`, "act");
          render_entries(ents.slice(1), t, 1);
        } else {
          if (T(name)) t.p(`<b><i>${tx(name)}.</i></b>`, "act");
          render_entries(ents, t, 1);
        }
      }
      if (boxed && t.out.length) b.add("box", '<div class="mbox">' + t.out.map(x => x.h).join("") + "</div>");
    }
  }

  function mon_init(e) {
    const ini = get(e, "initiative");
    if (ini === null || ini === undefined) return "";
    const dexmod = floorDiv(get(e, "dex", 10) - 10, 2);
    if (typeof ini === "boolean") return "";
    let bonus;
    if (isNum(ini)) bonus = Math.trunc(ini);
    else if (isDict(ini)) {
      if (isNum(get(ini, "initiative"))) bonus = Math.trunc(ini.initiative);
      else {
        const p = pyInt(get(ini, "proficiency", 0));
        bonus = p === null ? dexmod : dexmod + p * cr_pb(get(e, "cr"));
      }
    } else return "";
    return `${signed(bonus)} (${10 + bonus})`;
  }

  function build_monster(e, data) {
    let sub = `${mon_size(get(e, "size"))} ${mon_type(get(e, "type"))}`;
    let al = alignment(get(e, "alignment"));
    if (T(get(e, "alignmentPrefix"))) al = tx(e.alignmentPrefix) + al;
    if (al) sub += ", " + al;
    const score = k => { const v = get(e, k, 10); return Number.isInteger(v) || typeof v === "boolean" ? Number(v) : 10; };
    const abil = ["str", "dex", "con", "int", "wis", "cha"].map(k =>
      `<div><span class="lbl">${k.toUpperCase()}</span>${score(k)} (${signed(floorDiv(score(k) - 10, 2))})</div>`).join("");
    const cells = [`<div><b>AC</b> ${mon_ac(get(e, "ac"))}</div>`];
    const ini = mon_init(e);
    if (ini) cells.push(`<div><b>Initiative</b> ${ini}</div>`);
    cells.push(`<div><b>HP</b> ${mon_hp(get(e, "hp"))}</div>`);
    cells.push(`<div><b>Speed</b> ${mon_speed(get(e, "speed"))}</div>`);
    const hdr = `<div class="mgrid">${cells.join("")}</div><div class="abil">${abil}</div>`;
    const b = new Blocks();
    b.section();
    const stat = (label, val) => { if (T(val)) b.add("box", `<div class="mbox mstat"><b>${label}</b> ${val}</div>`); };
    if (T(get(e, "save"))) stat("Saving Throws", Object.entries(e.save).map(([k, v]) => `${title(k)} ${pyStr(v)}`).join(", "));
    if (T(get(e, "skill"))) {
      const sk = [];
      for (const [k, v] of Object.entries(e.skill)) { if (k === "other") continue; sk.push(`${title(k)} ${pyStr(v)}`); }
      stat("Skills", sk.join(", "));
    }
    stat("Vulnerabilities", dmg_list(get(e, "vulnerable"), "vulnerable"));
    stat("Resistances", dmg_list(get(e, "resist"), "resist"));
    stat("Immunities", dmg_list(get(e, "immune"), "immune"));
    stat("Condition Immunities", dmg_list(get(e, "conditionImmune"), "conditionImmune"));
    const senses = or(get(e, "senses"), []).map(s => tx(s));
    if (get(e, "passive") !== null && get(e, "passive") !== undefined) senses.push(`passive Perception ${pyStr(e.passive)}`);
    stat("Senses", senses.join(", "));
    stat("Languages", or(or(get(e, "languages"), []).map(x => tx(x)).join(", "), "—"));
    const cr = cr_str(get(e, "cr"));
    if (cr !== "—") {
      const xp = get(XP, cr);
      let crs = `${pyStr(cr)}` + (T(xp) ? ` (${commas(xp)} XP)` : "") + `; PB ${signed(cr_pb(get(e, "cr")))}`;
      if (isDict(get(e, "cr")) && T(get(e.cr, "lair"))) crs += ` (${pyStr(e.cr.lair)} in lair)`;
      stat("Challenge", crs);
    }
    const groups = { trait: [], action: [], bonus: [], reaction: [], legendary: [], mythic: [] };
    for (let sc of or(get(e, "spellcasting", []), [])) {
      sc = Object.assign({}, sc, { type: "spellcasting" });
      const da = get(sc, "displayAs", "trait");
      (has(groups, da) ? groups[da] : groups.trait).push(sc);
    }
    const traits = or(get(e, "trait"), []).concat(groups.trait);
    if (traits.length) {
      b.section();
      b.add("h", '<h4 class="sec">Traits</h4>');
      named_list(traits, b, true);
    }
    const sections = [["action", "Actions"], ["bonus", "Bonus Actions"], ["reaction", "Reactions"],
      ["legendary", "Legendary Actions"], ["mythic", "Mythic Actions"]];
    for (const [key, ttl] of sections) {
      const items = or(get(e, key), []).concat(groups[key]);
      if (!items.length) continue;
      b.section();
      b.add("h", `<h4 class="sec">${ttl}</h4>`);
      if (key === "legendary") {
        if (T(get(e, "legendaryHeader"))) {
          for (const h of e.legendaryHeader) b.add("p", `<p>${inline(h)}</p>`, { kn: 1 });
        } else {
          const n = get(e, "legendaryActions", 3);
          let nm = isStr(get(e, "shortName")) ? e.shortName : e.name;
          if (get(e, "isNamedCreature") !== true) nm = "the " + nm.toLowerCase();
          const Nm = nm[0].toUpperCase() + nm.slice(1);
          b.add("p", `<p>${Nm} can take ${pyStr(n)} legendary actions, choosing from the options below. `
            + "Only one legendary action can be used at a time and only at the end of another creature's turn. "
            + `${Nm} regains spent legendary actions at the start of its turn.</p>`, { kn: 1 });
        }
      }
      if (key === "mythic" && T(get(e, "mythicHeader"))) {
        for (const h of e.mythicHeader) b.add("p", `<p>${inline(h)}</p>`, { kn: 1 });
      }
      named_list(items, b, true);
    }
    const typ = get(e, "type");
    const tname = isStr(typ) ? typ : (isDict(typ) && isStr(get(typ, "type")) ? typ.type : "creature");
    const color = "#7a1f1f";
    return {
      cat: "monster", name: e.name, sub, hdr, blocks: b.out, src: src_line(e), color, corner: cr,
      back: { kind: "monster", label: "Creature", big: cr, bigsub: "CHALLENGE",
        line: title(`${mon_size(get(e, "size"))} ${pyStr(tname)}`), icon: "skull", color },
    };
  }

  // ----- items
  const ITEM_TYPE = { "A": "ammunition", "AF": "ammunition", "AT": "artisan's tools", "EM": "eldritch machine",
    "EXP": "explosive", "FD": "food and drink", "G": "adventuring gear", "GS": "gaming set",
    "HA": "heavy armor", "INS": "instrument", "LA": "light armor", "M": "melee weapon",
    "MA": "medium armor", "MNT": "mount", "MR": "master rune", "GV": "generic variant",
    "P": "potion", "R": "ranged weapon", "RD": "rod", "RG": "ring", "S": "shield", "SC": "scroll",
    "SCF": "spellcasting focus", "OTH": "other", "T": "tools", "TAH": "tack and harness",
    "TG": "trade good", "$": "treasure", "$A": "art object", "$C": "coinage", "$G": "gemstone",
    "VEH": "vehicle", "SHP": "vehicle", "AIR": "vehicle", "SPC": "vehicle", "WD": "wand",
    "IDG": "illegal drug", "TB": "trade bar" };
  const DMG = { "A": "acid", "B": "bludgeoning", "C": "cold", "F": "fire", "O": "force", "L": "lightning",
    "N": "necrotic", "P": "piercing", "I": "poison", "Y": "psychic", "R": "radiant", "S": "slashing", "T": "thunder" };
  const PROP = { "A": "ammunition", "AF": "ammunition", "BF": "burst fire", "F": "finesse", "H": "heavy",
    "L": "light", "LD": "loading", "R": "reach", "RLD": "reload", "S": "special", "T": "thrown",
    "2H": "two-handed", "V": "versatile", "Vst": "vestige" };
  const RARITY_COLOR = { "common": "#6e6a62", "uncommon": "#2f7d32", "rare": "#1f5fa8", "very rare": "#6a2fa0",
    "legendary": "#c26a00", "artifact": "#a8201a", "varies": "#5a5a5a", "none": "#7a5a3a",
    "unknown": "#5a5a5a", "unknown (magic)": "#5a5a5a" };

  const code = v => pyStr(or(v, "")).split("|")[0];
  function money(cp) {
    if (cp === null || cp === undefined) return "";
    if (cp >= 100 && cp % 100 === 0) return `${commas(floorDiv(cp, 100))} gp`;
    if (cp >= 100) return `${commas((cp / 100).toFixed(2))} gp`.replace(".00", "");
    if (cp >= 10 && cp % 10 === 0) return `${floorDiv(cp, 10)} sp`;
    return `${pyStr(cp)} cp`;
  }
  function item_icon(e) {
    const t = code(get(e, "type"));
    if (T(get(e, "weapon")) || ["M", "R", "A", "AF"].includes(t)) return "sword";
    if (T(get(e, "armor")) || ["LA", "MA", "HA", "S"].includes(t)) return "shield";
    if (t === "P") return "potion";
    if (t === "RG") return "ring";
    if (t === "SC") return "scroll";
    if (t === "WD" || t === "RD" || T(get(e, "staff"))) return "wand";
    if (t.startsWith("$")) return "gem";
    return "chest";
  }
  function item_typeline(e) {
    const t = code(get(e, "type"));
    const parts = [];
    if (T(get(e, "wondrous"))) parts.push("Wondrous item");
    else if (T(get(e, "staff"))) parts.push("Staff");
    else if (T(get(e, "weapon")) || t === "M" || t === "R") {
      const cat = get(e, "weaponCategory", "");
      const base = or(get(e, "_baseName"), "");
      parts.push(base ? `Weapon (${base.toLowerCase()})` : capitalize(`${T(cat) ? title(cat) + " " : ""}${get(ITEM_TYPE, t, "weapon")}`));
    } else if (["LA", "MA", "HA"].includes(t)) {
      const base = or(get(e, "_baseName"), "");
      parts.push(base ? `Armor (${base.toLowerCase()})` : `Armor (${ITEM_TYPE[t].split(/\s+/)[0]})`);
    } else if (t) parts.push(capitalize(get(ITEM_TYPE, t, t)));
    else if (T(get(e, "tattoo"))) parts.push("Tattoo");
    else parts.push("Item");
    if (T(get(e, "tier"))) parts.push(e.tier);
    const rar = get(e, "rarity");
    let s = parts.map(pyStr).join(", ");
    if (T(rar) && rar !== "none" && rar !== "unknown") s += ", " + (rar === "varies" || rar === "unknown (magic)" ? "rarity varies" : rar);
    const att = get(e, "reqAttune");
    if (att === true) s += " (requires attunement)";
    else if (isStr(att)) s += ` (requires attunement ${tx(att)})`;
    return s;
  }
  function item_stats(e, props_db) {
    const rows = [];
    const t = code(get(e, "type"));
    if (T(get(e, "dmg1"))) {
      let d = `${pyStr(e.dmg1)} ${get(DMG, get(e, "dmgType"), "")}`;
      if (T(get(e, "bonusWeapon"))) d = `${pyStr(e.dmg1)}${pyStr(e.bonusWeapon)} ${get(DMG, get(e, "dmgType"), "")}`;
      rows.push(["Damage", d.trim()]);
    }
    if (["LA", "MA", "HA", "S"].includes(t) && get(e, "ac") !== null && get(e, "ac") !== undefined) {
      const ac = e.ac;
      let s;
      if (t === "S") s = `+${pyStr(ac)}`;
      else if (t === "LA") s = `${pyStr(ac)} + Dex`;
      else if (t === "MA") s = `${pyStr(ac)} + Dex (max 2)`;
      else s = pyStr(ac);
      if (T(get(e, "bonusAc"))) s += ` (${pyStr(e.bonusAc)})`;
      rows.push(["AC", s]);
    }
    const props = [];
    for (const p of or(get(e, "property", []), [])) {
      const pc = code(isStr(p) ? p : get(p, "uid", ""));
      let name = or(get(props_db, pc), get(PROP, pc, pc));
      if (pc === "V" && T(get(e, "dmg2"))) name += ` (${pyStr(e.dmg2)})`;
      if (["T", "A", "AF"].includes(pc) && T(get(e, "range"))) name += ` (range ${pyStr(e.range)})`;
      props.push(name);
    }
    if (props.length) rows.push(["Properties", props.join(", ")]);
    else if (T(get(e, "range"))) rows.push(["Range", e.range]);
    if (T(get(e, "mastery"))) rows.push(["Mastery", e.mastery.map(m => code(isStr(m) ? m : get(m, "uid", ""))).join(", ")]);
    if (T(get(e, "strength"))) rows.push(["Strength", e.strength]);
    if (T(get(e, "stealth"))) rows.push(["Stealth", "Disadvantage"]);
    if (T(get(e, "charges"))) rows.push(["Charges", e.charges]);
    const wv = [];
    if (T(get(e, "weight"))) wv.push(`${pyStr(e.weight)} lb.`);
    if (T(get(e, "value"))) wv.push(money(e.value));
    if (wv.length) rows.push(["Weight/Value", wv.join(", ")]);
    return rows.map(([a, b]) => `<div class="mline"><b>${a}</b> ${tx(b)}</div>`).join("");
  }
  function build_item(e, data, ctx) {
    const b = new Blocks();
    render_entries(get(e, "entries"), b);
    if (T(get(e, "items")) && T(get(e, "_isGroup"))) {
      b.add("h", "<h4>Items</h4>");
      for (const it of e.items) b.add("li", `<p class="li">${tx(pyStr(it).split("|")[0])}</p>`);
    }
    for (const ae of or(get(e, "additionalEntries", []), [])) render_entries([ae], b);
    if (!b.out.length) {
      for (const p of or(get(e, "property", []), [])) {
        const pc = code(isStr(p) ? p : get(p, "uid", ""));
        const pe = get(get(ctx, "prop_entries", {}), pc);
        if (T(pe)) render_entries(pe, b);
      }
    }
    const rar = get(e, "rarity", "none");
    const color = get(RARITY_COLOR, rar, "#7a5a3a");
    const t = code(get(e, "type"));
    const kind = T(get(e, "wondrous")) ? "Wondrous Item"
      : T(get(e, "weapon")) || t === "M" || t === "R" ? "Weapon"
        : ["LA", "MA", "HA", "S"].includes(t) ? "Armor" : title(get(ITEM_TYPE, t, "Item"));
    return {
      cat: "item", name: e.name, sub: item_typeline(e), hdr: item_stats(e, get(ctx, "prop_names", {})),
      blocks: b.out, src: src_line(e), color, corner: "",
      back: { kind: "item", label: rar !== "none" && rar !== "unknown" ? "Magic Item" : "Item",
        big: "", bigsub: (rar !== "none" && rar !== "unknown" && rar !== "unknown (magic)" ? pyStr(rar) : "mundane").toUpperCase(),
        line: kind, icon: item_icon(e), color },
    };
  }

  // ----- everything else
  function prereq(e) {
    const out = [];
    for (const p of or(get(e, "prerequisite", []), [])) {
      const bits = [];
      for (const [k, v] of Object.entries(p)) {
        if (k === "level") {
          const lv = Number.isInteger(v) ? v : get(v, "level");
          const cl = Number.isInteger(v) ? "" : get(or(get(v, "class"), {}), "name", "");
          bits.push(`${ordinal(lv)} level` + (T(cl) ? ` ${pyStr(cl)}` : ""));
        } else if (k === "ability") {
          const ab = [];
          for (const d of v) ab.push(Object.entries(d).map(([a, n]) => `${get(ABIL, a, a)} ${pyStr(n)}+`).join(" or "));
          bits.push(ab.join(" or "));
        } else if (k === "race") bits.push(v.map(r => title(or(get(r, "displayEntry"), r.name))).join(" or "));
        else if (k === "spellcasting" || k === "spellcasting2020") bits.push("The ability to cast at least one spell");
        else if (k === "pact") bits.push(`Pact of the ${pyStr(v)}`);
        else if (k === "patron") bits.push(`${pyStr(v)} patron`);
        else if (k === "spell") bits.push(v.map(s => (isDict(s) ? tx(or(get(s, "entry"), get(s, "entrySummary"), ""))
          : title(tx(pyStr(s).split("#")[0]).split("|")[0]))).join(", "));
        else if (k === "feat") bits.push(v.map(f => title(pyStr(f).split("|")[0])).join(", ") + " feat");
        else if (k === "feature") bits.push(v.join(", "));
        else if (k === "other" || k === "otherSummary") bits.push(tx(isStr(v) ? v : get(v, "entry", "")));
        else if (k === "proficiency") { for (const d of v) for (const [kk, vv] of Object.entries(d)) bits.push(`Proficiency with ${pyStr(vv)} ${kk}`); }
        else if (k === "campaign") bits.push(v.join(", ") + " campaign");
        else if (k === "background") bits.push(v.map(x => x.name).join(" or ") + " background");
      }
      if (bits.length) out.push(bits.join(", "));
    }
    return out.length ? "Prerequisite: " + out.join(" or ") : "";
  }

  const OPT_FEATURE = { "EI": "Eldritch Invocation", "MM": "Metamagic", "MV:B": "Maneuver", "AS": "Arcane Shot",
    "PB": "Pact Boon", "AI": "Artificer Infusion", "ED": "Elemental Discipline", "RN": "Rune Knight Rune",
    "FS:F": "Fighting Style", "FS:B": "Fighting Style", "FS:P": "Fighting Style", "FS:R": "Fighting Style",
    "OTH": "Other", "TT": "Traveler's Trick", "RP": "Renaissance Power", "AF": "Alchemical Formula" };
  const GENERIC = {
    "feats.html": ["feats.json", ["feat"], "Feat", "medal", "#2e5d4b"],
    "backgrounds.html": ["backgrounds.json", ["background"], "Background", "scroll", "#6b4f2a"],
    "races.html": ["races.json", ["race", "subrace"], "Species", "person", "#3c5a8a"],
    "conditionsdiseases.html": ["conditionsdiseases.json", ["condition", "disease", "status"], "Condition", "flame", "#4a4a4a"],
    "optionalfeatures.html": ["optionalfeatures.json", ["optionalfeature"], "Optional Feature", "medal", "#4b5d2e"],
    "rewards.html": ["rewards.json", ["reward"], "Reward", "gem", "#8a6d1a"],
    "trapshazards.html": ["trapshazards.json", ["trap", "hazard"], "Trap / Hazard", "skull", "#5e3a1e"],
    "objects.html": ["objects.json", ["object"], "Object", "chest", "#5a5048"],
    "languages.html": ["languages.json", ["language"], "Language", "scroll", "#3a5f6b"],
    "deities.html": ["deities.json", ["deity"], "Deity", "sun", "#9a7b1a"],
    "actions.html": ["actions.json", ["action"], "Action", "sword", "#3f4f6a"],
    "variantrules.html": ["variantrules.json", ["variantrule"], "Rule", "book", "#3f4f6a"],
    "psionics.html": ["psionics.json", ["psionic"], "Psionic", "star", "#7a3f8a"],
    "charcreationoptions.html": ["charcreationoptions.json", ["charoption"], "Character Option", "person", "#3c5a8a"],
    "cultsboons.html": ["cultsboons.json", ["cult", "boon"], "Cult / Boon", "sun", "#6a2a2a"],
    "senses.html": ["senses.json", ["sense"], "Sense", "eye", "#3a5f6b"],
    "skills.html": ["skills.json", ["skill"], "Skill", "book", "#3f4f6a"],
    "decks.html": ["decks.json", ["card"], "Card", "star", "#4a3a6a"],
  };

  function build_generic(e, page, kind) {
    let [, , label, icon, color] = GENERIC[page];
    const sub_bits = [];
    if (kind === "condition" || kind === "disease" || kind === "status") label = title(kind);
    if (kind === "hazard") label = "Hazard";
    else if (kind === "trap") label = "Trap";
    if (kind === "subrace") label = "Subrace";
    if (page === "optionalfeatures.html") {
      const ft = get(e, "featureType", []);
      label = T(ft) ? get(OPT_FEATURE, ft[0], "Optional Feature") : label;
    }
    if (page === "feats.html" && T(get(e, "category"))) {
      label = get({ "O": "Origin Feat", "G": "General Feat", "FS": "Fighting Style Feat", "EB": "Epic Boon Feat" }, e.category, "Feat");
    }
    sub_bits.push(label);
    const pr = prereq(e);
    let hdr = "";
    if (pr) hdr += `<div class="mline"><i>${pr}</i></div>`;
    if (page === "races.html") {
      if (T(get(e, "size"))) hdr += `<div class="mline"><b>Size</b> ${mon_size(e.size)}</div>`;
      if (T(get(e, "speed"))) {
        const sp = e.speed;
        hdr += `<div class="mline"><b>Speed</b> ${isDict(sp) ? mon_speed(sp) : pyStr(sp) + " ft."}</div>`;
      }
      if (T(get(e, "ability"))) {
        const ab = [];
        for (const a of e.ability) {
          for (const [k, v] of Object.entries(a)) {
            if (k === "choose") ab.push("choose " + pyStr(get(v, "count", 1)) + " +" + pyStr(get(v, "amount", 1)));
            else ab.push(`${title(k)} ${signed(v)}`);
          }
        }
        hdr += `<div class="mline"><b>Ability</b> ${ab.join(", ")}</div>`;
      }
    }
    if (page === "deities.html") {
      for (const [k, lab] of [["title", ""], ["pantheon", "Pantheon"], ["alignment", "Alignment"], ["domains", "Domains"], ["symbol", "Symbol"]]) {
        let v = get(e, k);
        if (!T(v)) continue;
        if (k === "alignment") v = alignment(v);
        else if (isList(v)) v = v.join(", ");
        hdr += `<div class="mline">${lab ? "<b>" + lab + "</b> " : "<i>"}${tx(v)}${lab ? "" : "</i>"}</div>`;
      }
    }
    if (page === "languages.html") {
      for (const [k, lab] of [["type", "Type"], ["typicalSpeakers", "Typical Speakers"], ["script", "Script"]]) {
        const v = get(e, k);
        if (T(v)) hdr += `<div class="mline"><b>${lab}</b> ${tx(isList(v) ? v.join(", ") : title(pyStr(v)))}</div>`;
      }
    }
    if (page === "actions.html" && T(get(e, "time"))) {
      const tm = e.time.map(t => (isDict(t) ? spell_time([t]) : pyStr(t)));
      hdr += `<div class="mline"><b>Time</b> ${tm.join(" or ")}</div>`;
    }
    if (page === "objects.html") {
      if (T(get(e, "ac"))) hdr += `<div class="mline"><b>AC</b> ${pyStr(e.ac)}</div>`;
      if (T(get(e, "hp"))) hdr += `<div class="mline"><b>HP</b> ${pyStr(e.hp)}</div>`;
    }
    if (page === "trapshazards.html" && T(get(e, "trapHazType"))) hdr += `<div class="mline"><i>${pyStr(e.trapHazType)}</i></div>`;
    const b = new Blocks();
    render_entries(or(get(e, "entries"), get(e, "entriesTemplate"), []), b);
    if (T(get(e, "_isSubraceOf"))) sub_bits[0] = `Subrace of ${pyStr(e._isSubraceOf)}`;
    return {
      cat: "other", name: e.name, sub: sub_bits.join(" • "), hdr, blocks: b.out,
      src: src_line(e), color, corner: "",
      back: { kind: "other", label, big: "", bigsub: label.toUpperCase(), line: "", icon, color },
    };
  }

  // ------------------------------------------------------------------ class features
  const _low = v => pyStr(or(v, "")).toLowerCase();
  function _is_official_class_source(d, source) {
    const s = _low(source);
    return ["class", "subclass"].some(k => get(or(d, {}), k, []).some(x => _low(get(x, "source")) === s));
  }
  const CLASS_COLOR = { "artificer": "#8a5a2b", "barbarian": "#9b2c1f", "bard": "#8a3d7a", "cleric": "#7a6a2a",
    "druid": "#3f6b2a", "fighter": "#5a4a3a", "monk": "#2f6f6f", "mystic": "#6a4a8a",
    "paladin": "#a07a1a", "ranger": "#2f5a3a", "rogue": "#3a3a44", "sidekick": "#5a5a5a",
    "sorcerer": "#a82838", "warlock": "#5a2a7a", "wizard": "#2a4f8f" };
  const _int = v => (v === null || v === undefined ? null : pyInt(v));
  function unpack_cf_uid(uid) {
    const p = pyStr(uid).split("|").map(x => x.trim()).concat(["", "", "", "", "", ""]);
    const cs = p[2] || "PHB";
    return { name: p[0], className: p[1], classSource: cs, level: _int(p[3]), source: p[4] || cs };
  }
  function unpack_scf_uid(uid) {
    const p = pyStr(uid).split("|").map(x => x.trim()).concat(["", "", "", "", "", "", "", ""]);
    const cs = p[2] || "PHB", scs = p[4] || "PHB";
    return { name: p[0], className: p[1], classSource: cs, subclassShortName: p[3],
      subclassSource: scs, level: _int(p[5]), source: p[6] || scs };
  }
  function build_class_feature(f, sc = null) {
    const b = new Blocks();
    render_entries(get(f, "entries"), b);
    const level = get(f, "level");
    const cname = get(f, "className", "");
    const color = get(CLASS_COLOR, pyStr(cname).toLowerCase(), "#3f4f6a");
    const is_sub = has(f, "subclassShortName");
    let sub, line;
    if (is_sub) {
      const short = get(f, "subclassShortName", "");
      sub = `${pyStr(or(get(or(sc, {}), "name"), short))} (${pyStr(cname)}) feature • Level ${pyStr(level)}`;
      line = `${pyStr(short)} • ${pyStr(cname)}`;
    } else {
      sub = `${pyStr(cname)} feature • Level ${pyStr(level)}`;
      line = pyStr(cname);
    }
    return {
      cat: "feature", name: get(f, "name", ""), sub: esc(sub), hdr: "", blocks: b.out,
      src: src_line(f), color, corner: pyStr(or(level, "")),
      back: { kind: "feature", label: is_sub ? "Subclass Feature" : "Class Feature",
        big: pyStr(or(level, "")), bigsub: "LEVEL", line, icon: "medal", color },
    };
  }
  // ------------------------------------------------------------------ list cards
  class ListSpec {
    constructor(title_, urls, note = "") { this.title = title_; this.urls = urls; this.note = note; }
    toString() { return `[list] ${this.title} (${this.urls.length})`; }
  }
  const TIME_SHORT = { "action": "A", "bonus": "BA", "reaction": "R", "minute": "min", "hour": "hr", "round": "rd",
    "day": "day", "turn": "turn", "week": "wk", "year": "yr" };
  const RARITY_SHORT = { "common": "Common", "uncommon": "Uncommon", "rare": "Rare", "very rare": "V. rare",
    "legendary": "Legendary", "artifact": "Artifact", "varies": "Varies", "unknown (magic)": "?" };
  const FEAT_CAT = { "O": "Origin", "G": "General", "FS": "Fighting Style", "EB": "Epic Boon", "D": "Dragonmark" };

  function _short_time(times) {
    const out = [];
    for (const t of or(times, [])) {
      const u = get(t, "unit", ""), n = get(t, "number", 1);
      if (["action", "bonus", "reaction"].includes(u)) out.push(n === 1 ? TIME_SHORT[u] : `${pyStr(n)} ${TIME_SHORT[u]}`);
      else out.push(`${pyStr(n)} ${get(TIME_SHORT, u, u)}`);
    }
    return out.join("/");
  }
  function _short_range(r) {
    if (!T(r)) return "";
    const t = get(r, "type"), d = or(get(r, "distance"), {});
    const dt = get(d, "type"), amt = get(d, "amount");
    if (["self", "touch", "sight", "unlimited", "special"].includes(dt)) {
      const base = { self: "Self", touch: "Touch", sight: "Sight", unlimited: "Unlimited", special: "Special" }[dt];
      return t === "point" ? base : `${base} (${pyStr(t)})`;
    }
    const unit = dt === "feet" ? "ft" : dt === "miles" ? "mi" : pyStr(or(dt, ""));
    if (t === "point") return `${pyStr(amt)} ${unit}`.trim();
    if (t === "special") return "Special";
    return `${pyStr(amt)}-${unit} ${pyStr(t)}`;
  }
  const _plain = h => pyStr(or(h, "")).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

  function list_columns(page, ents) {
    if (page === "spells.html") {
      const row = e => {
        const lvl = get(e, "level", 0);
        const nm = e.name + (T(get(or(get(e, "meta"), {}), "ritual")) ? " (R)" : "");
        const school = or(get(SCHOOL, get(e, "school")), get(BREW_SCHOOLS, get(e, "school")), get(e, "school", ""));
        const conc = or(get(e, "duration"), []).some(d => T(get(d, "concentration")));
        return [esc(nm), lvl === 0 ? "C" : pyStr(lvl), _short_time(get(e, "time")), pyStr(school).slice(0, 3), conc ? "C" : "",
          esc(_short_range(get(e, "range")))];
      };
      return [["Name", "Lv", "Time", "Sch.", "C", "Range"], [1, 2, 3, 4], row];
    }
    if (page === "bestiary.html") {
      const row = e => {
        const typ = get(e, "type");
        let base = isStr(typ) ? typ : get(or(typ, {}), "type", "");
        base = isStr(base) ? base : get(or(base, {}), "choose", []).join(" / ");
        const ac = or(get(e, "ac"), [""]);
        const ac0 = isDict(ac[0]) ? get(ac[0], "ac", "") : ac[0];
        const hpd = or(get(e, "hp"), {});
        const hp = get(hpd, "average", get(hpd, "special", ""));
        return [esc(e.name), esc(cr_str(get(e, "cr"))), esc(title(pyStr(base))), esc(pyStr(ac0)), esc(pyStr(hp))];
      };
      return [["Name", "CR", "Type", "AC", "HP"], [1, 3, 4], row];
    }
    if (page === "items.html") {
      const magic = ents.some(e => !["none", "unknown", ""].includes(_low(get(e, "rarity"))));
      const kind = e => {
        const t = code(get(e, "type"));
        if (T(get(e, "wondrous"))) return "Wondrous";
        if (T(get(e, "staff"))) return "Staff";
        if (T(get(e, "weapon")) || t === "M" || t === "R") return "Weapon";
        if (["LA", "MA", "HA"].includes(t)) return "Armor";
        return get({ "S": "Shield", "P": "Potion", "RG": "Ring", "RD": "Rod", "SC": "Scroll", "WD": "Wand",
          "A": "Ammo", "AF": "Ammo", "G": "Gear", "INS": "Instrument", "AT": "Tools", "T": "Tools",
          "GS": "Gaming set", "MNT": "Mount", "TAH": "Tack" }, t, capitalize(get(ITEM_TYPE, t, "Item")));
      };
      if (magic) {
        const row = e => [esc(e.name), kind(e), get(RARITY_SHORT, _low(get(e, "rarity")), "\u2014"), T(get(e, "reqAttune")) ? "\u2713" : ""];
        return [["Name", "Type", "Rarity", "Att."], [1, 2, 3], row];
      }
      const row = e => [esc(e.name), kind(e), T(get(e, "value")) ? money(e.value) : "\u2014",
        T(get(e, "weight")) ? `${pyStr(e.weight)} lb.` : "\u2014"];
      return [["Name", "Type", "Cost", "Weight"], [1, 2, 3], row];
    }
    if (page === "feats.html") {
      const row = e => [esc(e.name), get(FEAT_CAT, get(e, "category"), or(get(e, "category"), "")),
        esc(_plain(prereq(e)).replace("Prerequisite: ", ""))];
      return [["Name", "Category", "Prerequisite"], [1], row];
    }
    if (page === "optionalfeatures.html") {
      const row = e => {
        const ft = or(get(e, "featureType"), [""])[0];
        return [esc(e.name), get(OPT_FEATURE, ft, ft), esc(_plain(prereq(e)).replace("Prerequisite: ", ""))];
      };
      return [["Name", "Type", "Prerequisite"], [1], row];
    }
    if (page === "races.html") {
      const row = e => {
        let sp = get(e, "speed");
        sp = isDict(sp) ? get(sp, "walk", "") : sp;
        return [esc(e.name), mon_size(or(get(e, "size"), [])), sp !== null && sp !== undefined && sp !== "" ? `${pyStr(sp)} ft.` : ""];
      };
      return [["Name", "Size", "Speed"], [1, 2], row];
    }
    if (page === "backgrounds.html") {
      const row = e => {
        const sk = new Set();
        for (const d of or(get(e, "skillProficiencies"), [])) for (const k of Object.keys(d)) if (k !== "choose" && k !== "any") sk.add(title(k));
        return [esc(e.name), esc([...sk].sort().join(", "))];
      };
      return [["Name", "Skills"], [], row];
    }
    if (page === "deities.html") {
      const row = e => [esc(e.name), esc(get(e, "pantheon", "")), esc(T(get(e, "alignment")) ? alignment(e.alignment) : ""),
        esc(or(get(e, "domains"), []).join(", "))];
      return [["Name", "Pantheon", "Alignment", "Domains"], [], row];
    }
    if (page === "conditionsdiseases.html") {
      const row = e => [esc(e.name), title(or(get(e, "__kind"), "condition"))];
      return [["Name", "Type"], [1], row];
    }
    const row = e => [esc(e.name), esc(get(SOURCE_ABBR, _low(get(e, "source")), get(e, "source", "")))];
    return [["Name", "Source"], [1], row];
  }

  const LIST_STYLE = { "spells.html": ["spell", "Spell List", "spells", "star", SPELL_COLOR],
    "items.html": ["item", "Item List", "items", "chest", "#7a5a3a"],
    "bestiary.html": ["monster", "Creature List", "creatures", "skull", "#7a1f1f"] };

  function build_list_card(spec, entries) {
    const page = entries[0][0];
    const ents = entries.map(x => x[1]);
    for (const [, e, k] of entries) e.__kind = k;
    const [heads, nowrap, row] = list_columns(page, ents);
    const cls = i => (nowrap.includes(i) ? ' class="nw"' : "");
    const html_rows = ents.map(e => "<tr>" + row(e).map((c, i) => `<td${cls(i)}>${c}</td>`).join("") + "</tr>").join("");
    const table = '<table class="lst"><thead><tr>' + heads.map((h, i) => `<th${cls(i)}>${h}</th>`).join("")
      + `</tr></thead><tbody>${html_rows}</tbody></table>`;
    let cat, label, noun, icon, color;
    if (has(LIST_STYLE, page)) [cat, label, noun, icon, color] = LIST_STYLE[page];
    else {
      const g = get(GENERIC, page, ["", [], "Entry", "book", "#3f4f6a"]);
      const glabel = g[2]; icon = g[3]; color = g[4];
      const pl = { "Species": "species", "Deity": "deities", "Trap / Hazard": "traps & hazards", "Cult / Boon": "cults & boons",
        "Optional Feature": "features", "Character Option": "options" };
      cat = "other"; label = `${glabel} List`; noun = get(pl, glabel, glabel.toLowerCase() + "s");
    }
    const n = ents.length;
    const srcs = [];
    for (const e of ents) {
      const a = get(SOURCE_ABBR, _low(get(e, "source")), get(e, "source", ""));
      if (T(a) && !srcs.includes(a)) srcs.push(a);
    }
    const sub = `${n} ${n !== 1 ? noun : "entry"}` + (spec.note ? ` \u2022 ${esc(spec.note)}` : "");
    return {
      cat: "list", name: spec.title, sub, hdr: "", blocks: [{ k: "table", h: table }],
      src: srcs.slice(0, 6).join(", ") + (srcs.length > 6 ? " \u2026" : ""), color, corner: pyStr(n),
      isList: true,
      back: { kind: "list", label, big: pyStr(n), bigsub: noun.toUpperCase(), line: spec.title, icon, color },
    };
  }

  // ------------------------------------------------------------------ loot cards
  class LootSpec {
    constructor(title_, note = "") {
      this.title = title_; this.note = note;
      this.coins = []; this.gems = []; this.art = []; this.other = []; this.items = [];   // items: [[url, display name]]
    }
    get urls() { return this.items.map(x => x[0]); }
    toString() { return `[loot] ${this.title}`; }
  }

  function build_loot_card(spec, item_rows) {
    const b = new Blocks();
    if (spec.coins.length) {
      b.add("h", "<h4>Coins</h4>");
      b.p(spec.coins.map(c => esc(c)).join(" \u2022 "));
    }
    const trinkets = new Map();
    for (const t of spec.other) trinkets.set(t, (trinkets.get(t) || 0) + 1);
    const other = [...trinkets].map(([t, n]) => t + (n > 1 ? ` \u00d7${n}` : ""));
    for (const [label, rows] of [["Gemstones", spec.gems], ["Art objects", spec.art], ["Trinkets", other]]) {
      if (rows.length) {
        b.add("h", `<h4>${label}</h4>`);
        for (const r of rows) {
          const i = r.indexOf(": ");
          const head = i < 0 ? r : r.slice(0, i), rest = i < 0 ? "" : r.slice(i + 2);
          b.add("li", rest ? `<p class="li"><b>${esc(head)}:</b> ${esc(rest)}</p>` : `<p class="li">${esc(r)}</p>`);
        }
      }
    }
    if (item_rows.length) {
      const [heads, nowrap, row] = list_columns("items.html", [{ rarity: "rare" }]);
      const cls = i => (nowrap.includes(i) ? ' class="nw"' : "");
      const trs = [];
      for (const [name, e] of item_rows) {
        const cells = e ? row(e) : ["", "", "\u2014", ""];
        cells[0] = esc(name);
        trs.push("<tr>" + cells.map((c, i) => `<td${cls(i)}>${c}</td>`).join("") + "</tr>");
      }
      b.add("h", `<h4>Magic items (${item_rows.length})</h4>`);
      b.add("table", '<table class="lst"><thead><tr>' + heads.map((h, i) => `<th${cls(i)}>${h}</th>`).join("")
        + "</tr></thead><tbody>" + trs.join("") + "</tbody></table>");
    }
    if (!b.out.length) b.p("<i>No loot!</i>");
    const color = "#8a6d1a";
    const n = item_rows.length;
    return {
      cat: "loot", name: spec.title, sub: esc(spec.note || "Treasure"), hdr: "", blocks: b.out,
      src: "Loot Generator", color, corner: n ? pyStr(n) : "", isList: true,
      back: { kind: "loot", label: "Treasure", big: n ? pyStr(n) : "", bigsub: n ? (n === 1 ? "MAGIC ITEM" : "MAGIC ITEMS") : "TREASURE",
        line: spec.title, icon: "chest", color },
    };
  }

  // ------------------------------------------------------------------ lookup
  function ent_hash(e, page = "") {
    if (page === "deities.html") return `${pyStr(get(e, "name", ""))}_${pyStr(get(e, "pantheon", ""))}_${pyStr(get(e, "source", ""))}`.toLowerCase();
    if (page === "races.html" && T(get(e, "raceName"))) return `${pyStr(get(e, "name", ""))} (${pyStr(e.raceName)})_${pyStr(get(e, "source", ""))}`.toLowerCase();
    return `${pyStr(get(e, "name", ""))}_${pyStr(get(e, "source", ""))}`.toLowerCase();
  }
  function parse_link(url) {
    url = String(url).trim();
    const u = urlparse(url);
    const page = u.path.split("/").pop().toLowerCase() || "index.html";
    const frag = unquote(u.fragment.split(",")[0]).trim().toLowerCase();
    return [page, frag, u];
  }
  const nameIs = (x, n) => pyStr(get(x, "name", "")).toLowerCase() === pyStr(or(n, "")).toLowerCase();
  const srcIs = (x, s) => pyStr(get(x, "source", "")).toLowerCase() === pyStr(or(s, "")).toLowerCase();

  // ----- pictures (monster tokens and the artwork 5e.tools shows for monsters and items)
  const IMG_BASE = "https://raw.githubusercontent.com/5etools-mirror-3/5etools-img/main/";

  /** an image href from the 5etools data -> a full address, or null */
  function img_url(href) {
    if (!isDict(href)) return null;
    if (get(href, "type") === "external" && typeof get(href, "url") === "string" && href.url) return href.url;
    if (typeof get(href, "path") === "string" && href.path) return IMG_BASE + quote(href.path);
    return null;
  }
  /** the file name 5e.tools gives a creature's token: accents dropped, Æ spelled out, no quotes */
  function token_name(name) {
    const s = String(name).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return s.replace(/Æ/g, "AE").replace(/æ/g, "ae").replace(/"/g, "");
  }

  class Resolver {
    constructor(data, images = false) {
      this.data = data;
      this.images = images;   // look up pictures for monster and item cards
      this._items = null;
    }

    _indexed(folder, key, source) {
      const idx = this.data.get(`${folder}/index.json`);
      let fn = null;
      for (const [s, f] of Object.entries(idx)) { if (s.toLowerCase() === source.toLowerCase()) { fn = f; break; } }
      if (!fn) return get(or(this.data.brew(source), {}), key, []);
      return get(this.data.get(`${folder}/${fn}`), key, []);
    }
    _finder_indexed(folder, key) {
      return (name, source) => {
        for (const x of this._indexed(folder, key, or(source, ""))) if (pyStr(get(x, "name", "")).toLowerCase() === pyStr(or(name, "")).toLowerCase()) return x;
        return null;
      };
    }

    resolve(url, raw = false) {
      const [page, h, u] = parse_link(url);
      if (page === "classes.html") {
        if (raw) throw new Error("class features can't go in a list card");
        return this.resolve_class_feature(u);
      }
      if (!h || !h.includes("_")) throw new Error("link has no entry selected (the part after # is missing)");
      const src = rsplit1(h, "_")[1];
      if (page === "spells.html") {
        for (let e of this._indexed("spells", "spell", src)) {
          if (ent_hash(e) === h) {
            e = resolve_copy(deepCopy(e), this._finder_indexed("spells", "spell"));
            return raw ? [page, e, "spell"] : build_spell(e, this.data, this._scroll_info(u, e));
          }
        }
      } else if (page === "bestiary.html") {
        for (let e of this._indexed("bestiary", "monster", src)) {
          if (ent_hash(e) === h) {
            e = resolve_copy(deepCopy(e), this._finder_indexed("bestiary", "monster"));
            if (raw) return [page, e, "monster"];
            return this._with_images(build_monster(e, this.data), "monster", e);
          }
        }
      } else if (page === "items.html") {
        const [e, ctx] = this.find_item(h);
        if (e) return raw ? [page, e, "item"] : this._with_images(build_item(e, this.data, ctx), "item", e);
      } else if (has(GENERIC, page)) {
        const [file, keys] = GENERIC[page];
        const d = this.data.get(file);
        let brew = null;
        if (!keys.some(k => get(d, k, []).some(e => ent_hash(e, page) === h))) brew = this.data.brew(src);
        for (const k of keys) {
          const pool = or(get(or(brew, {}), k), []).concat(get(d, k, []));
          for (let e of pool) {
            if (k === "subrace") {
              if (!T(get(e, "name"))) continue;
              e = Object.assign({}, e, { raceName: get(e, "raceName", null), name: pyStr(e.name), _isSubraceOf: get(e, "raceName", null) });
            }
            if (ent_hash(e, page) === h || (k === "subrace" && `${pyStr(e.name)} (${pyStr(get(e, "raceName"))})_${pyStr(get(e, "source"))}`.toLowerCase() === h)) {
              const finder = (n, s) => pool.find(x => nameIs(x, n) && srcIs(x, s)) || null;
              e = resolve_copy(deepCopy(e), finder);
              return raw ? [page, e, k] : build_generic(e, page, k);
            }
          }
        }
      } else {
        throw new Error(`'${page}' pages aren't supported yet (spells, items, bestiary, class features, feats, backgrounds, `
          + "races, conditions, optional features, rewards, traps, objects, deities, languages, actions, rules are)");
      }
      throw new Error("couldn't find that entry in the 5e.tools data, its partnered/homebrew collection or prerelease content");
    }

    // ----- pictures
    _fluff_pool(kind, source) {
      source = or(source, "");
      if (kind === "monster") {
        const idx = or(this.data.get("bestiary/fluff-index.json", true), {});
        const hit = Object.entries(idx).find(([s]) => s.toLowerCase() === source.toLowerCase());
        if (hit) return or(get(or(this.data.get(`bestiary/${hit[1]}`, true), {}), "monsterFluff"), []);
        return or(get(or(this.data.brew(source), {}), "monsterFluff"), []);
      }
      const pool = or(get(or(this.data.get("fluff-items.json", true), {}), "itemFluff"), []);
      if (pool.some(x => pyStr(or(get(x, "source"), "")).toLowerCase() === source.toLowerCase())) return pool;
      return or(get(or(this.data.brew(source), {}), "itemFluff"), []);
    }
    _find_fluff(kind, name, source) {
      const find = (n, s) => this._fluff_pool(kind, s).find(x =>
        pyStr(or(get(x, "name"), "")).toLowerCase() === pyStr(or(n, "")).toLowerCase()
        && pyStr(or(get(x, "source"), "")).toLowerCase() === pyStr(or(s, "")).toLowerCase()) || null;
      const f = find(name, source);
      return f ? resolve_copy(deepCopy(f), find) : null;
    }
    /** {art: artwork address, token: round token address} (either may be null), or null if neither */
    images_for(kind, e) {
      let fl = isDict(get(e, "fluff")) ? e.fluff : null;   // homebrew can carry its pictures inline
      if (!(fl && T(get(fl, "images"))) && T(get(e, "hasFluffImages"))) fl = this._find_fluff(kind, get(e, "name"), get(e, "source"));
      let art = null;
      for (const im of or(get(or(fl, {}), "images"), [])) {
        art = isDict(im) ? img_url(get(im, "href")) : null;
        if (art) break;
      }
      let token = null;
      if (kind === "monster") {
        if (typeof get(e, "tokenUrl") === "string" && e.tokenUrl) token = e.tokenUrl;
        else if (T(get(e, "hasToken"))) {
          const t = isDict(get(e, "token")) ? e.token : {};
          token = IMG_BASE + quote(`bestiary/tokens/${or(get(t, "source"), get(e, "source"))}/${token_name(or(get(t, "name"), e.name))}.webp`);
        }
      }
      return art || token ? { art, token } : null;
    }
    _with_images(card, kind, e) {
      if (this.images) {
        let im = null;
        try { im = this.images_for(kind, e); }
        catch (ex) { rethrow(ex); warn(`couldn't look up the pictures for ${get(e, "name")}: ${ex.message || ex}`); }
        if (im) card.img = im;
      }
      return card;
    }

    _scroll_info(u, spell) {
      const part = u.fragment.split(",").slice(1).find(p => p.toLowerCase().startsWith("cardforge:scroll"));
      if (part === undefined) return null;
      let level = get(spell, "level", 0);
      let [rarity, dc, atk] = get(SCROLL_TABLE, level, SCROLL_TABLE[9]);
      const scroll_hash = part.includes("~") ? unquote(split1(part, "~")[1]).trim().toLowerCase() : "";
      if (scroll_hash) {
        try {
          const [it] = this.find_item(scroll_hash);
          if (it) {
            level = get(it, "spellScrollLevel", level);
            const m = pyStr(get(it, "name", "")).match(/\((\d+)/);
            if (!has(it, "spellScrollLevel") && m) level = parseInt(m[1], 10);
            [rarity, dc, atk] = get(SCROLL_TABLE, level, [rarity, dc, atk]);
            if (![null, undefined, "", "varies", "unknown", "unknown (magic)", "none"].includes(get(it, "rarity"))) rarity = it.rarity;
            const t = JSON.stringify(get(it, "entries", []));
            const m2 = t.match(/save DC is (\d+),? and the attack bonus is (?:\{@hit )?\+?(\d+)/);
            if (m2) { dc = parseInt(m2[1], 10); atk = parseInt(m2[2], 10); }
          }
        } catch (ex) { rethrow(ex); }
      }
      return { level, rarity, dc, atk };
    }

    build_list(spec) {
      const entries = [], missing = [];
      for (const url of spec.urls) {
        try { entries.push(this.resolve(url, true)); }
        catch (e) { rethrow(e); missing.push(`${url} (${e.message || e})`); }
      }
      if (!entries.length) throw new Error("none of the entries in this list could be found");
      const pages = new Set(entries.map(x => x[0]));
      if (pages.size > 1) throw new Error("a list card can only hold entries from one page (e.g. only spells)");
      for (const m of missing.slice(0, 5)) warn(`left out of '${spec.title}': ${m}`);
      if (missing.length > 5) warn(`... and ${missing.length - 5} more left out of '${spec.title}'`);
      return build_list_card(spec, entries);
    }

    build_loot(spec) {
      const rows = [];
      for (let [url, name] of spec.items) {
        let ent = null;
        try {
          const [page, e] = this.resolve(url, true);
          ent = page === "items.html" ? e : null;
          name = name || get(e, "name", "");
        } catch (ex) { rethrow(ex); warn(`'${spec.title}': couldn't look up ${name || url} (${ex.message || ex}) - listed without details`); }
        rows.push([name || title(rsplit1(unquote(url.split("#").pop()), "_")[0]), ent]);
      }
      return build_loot_card(spec, rows);
    }

    // ----- class features
    class_data(class_name) {
      const idx = this.data.get("class/index.json");
      const hit = Object.entries(idx).find(([k]) => k.toLowerCase() === class_name.toLowerCase());
      if (hit) return this.data.get(`class/${hit[1]}`);
      for (const f of Object.values(idx)) {
        const d = this.data.get(`class/${f}`);
        if (get(d, "class", []).some(c => _low(get(c, "name")) === class_name.toLowerCase())) return d;
      }
      throw new ClassMissing(`no class called '${class_name}' in the 5e.tools data`);
    }
    _merge(b, d) { const o = {}; for (const k of ["class", "subclass", "classFeature", "subclassFeature"]) o[k] = or(get(b, k), []).concat(or(get(d, k), [])); return o; }

    _find_via_subclass(want) {
      let d;
      try { d = this.class_data(want.className); } catch (e) { if (!(e instanceof ClassMissing)) throw e; d = {}; }
      const b = !_is_official_class_source(d, want.subclassSource) ? this.data.brew(want.subclassSource) : null;
      if (T(b)) d = this._merge(b, d);
      const norm = x => _low(x).replace(/[^a-z0-9]+/g, "");
      const subs = get(d, "subclass", []).filter(x => _low(get(x, "className")) === _low(want.className)
        && _low(get(x, "shortName")) === _low(want.subclassShortName) && _low(get(x, "source")) === _low(want.subclassSource));
      subs.sort(keyCmp(x => [_low(get(x, "classSource")) !== _low(get(want, "classSource"))]));
      const uids = [];
      for (const sc of subs) {
        for (const ref of get(sc, "subclassFeatures", [])) {
          const uid = isStr(ref) ? ref : get(or(ref, {}), "subclassFeature", "");
          uids.push(uid);
          const top = this._find_feature("subclassFeature", unpack_scf_uid(uid));
          for (const e of get(or(top, {}), "entries", [])) {
            if (isDict(e) && get(e, "type") === "refSubclassFeature") uids.push(get(e, "subclassFeature", ""));
          }
        }
      }
      for (const uid of uids) {
        const u = unpack_scf_uid(uid);
        if (norm(u.name) === norm(want.name) && (!T(get(want, "level")) || u.level === want.level)) return this._find_feature("subclassFeature", u);
      }
      return null;
    }

    _find_feature(kind, want, loose = false) {
      let d;
      try { d = this.class_data(want.className); } catch (e) { if (!(e instanceof ClassMissing)) throw e; d = {}; }
      const brew_src = kind === "subclassFeature" ? get(want, "subclassSource") : get(want, "classSource");
      const b = T(brew_src) && !_is_official_class_source(d, brew_src) ? this.data.brew(brew_src) : null;
      if (T(b)) d = this._merge(b, d);
      const keys = kind === "subclassFeature" ? ["className", "subclassShortName", "subclassSource"] : ["className", "classSource"];
      const pool = get(d, kind, []).filter(f => keys.every(k => _low(get(f, k)) === _low(want[k])));
      let cands = pool.filter(f => _low(get(f, "name")) === _low(want.name));
      if (!cands.length && loose) {
        const norm = x => _low(x).replace(/[^a-z0-9]+/g, "");
        cands = pool.filter(f => norm(get(f, "name")) === norm(want.name));
      }
      if (T(get(want, "level"))) { const c2 = cands.filter(f => get(f, "level") === want.level); if (c2.length) cands = c2; }
      if (!cands.length) return null;
      cands = cands.slice().sort(keyCmp(f => [_low(get(f, "source")) !== _low(get(want, "source")),
        _low(get(f, "classSource")) !== _low(get(want, "classSource"))]));
      let f = cands[0];
      if (T(get(f, "_copy"))) {
        const finder = (n, s) => get(d, kind, []).find(x => _low(get(x, "name")) === _low(n) && _low(get(x, "source")) === _low(s)) || null;
        f = resolve_copy(deepCopy(f), finder);
      }
      return f;
    }

    _ref_lookup(kind, uid) {
      try {
        const want = kind === "classFeature" ? unpack_cf_uid(uid) : unpack_scf_uid(uid);
        return this._find_feature(kind, want);
      } catch (e) { rethrow(e); return null; }
    }

    _class_and_data(cname, csrc) {
      let d;
      try { d = this.class_data(cname); } catch (e) { if (!(e instanceof ClassMissing)) throw e; d = {}; }
      let cls = get(d, "class", []).find(c => _low(get(c, "name")) === cname && _low(get(c, "source")) === csrc) || null;
      if (cls === null) {
        const b = this.data.brew(csrc);
        if (T(b)) {
          cls = or(get(b, "class"), []).find(c => _low(get(c, "name")) === cname) || null;
          d = this._merge(b, d);
        }
      }
      return [cls, d];
    }

    resolve_class_feature(u) {
      const parts = u.fragment.split(",");
      const main = unquote(parts[0]).trim().toLowerCase();
      if (!main.includes("_")) throw new Error("no class selected in that link");
      const [cname, csrc] = rsplit1(main, "_");
      const subs = {};
      for (const part of parts.slice(1)) {
        if (part.includes(":")) { const [k, v] = split1(part, ":"); subs[k.trim().toLowerCase()] = v; }
      }
      const [cls, d] = this._class_and_data(cname, csrc);
      if (cls === null) throw new Error(`couldn't find the class '${cname}' (${csrc.toUpperCase()})`);
      const class_name = cls.name, class_src = cls.source;
      let feat = null, sc = null;
      if (has(subs, "cardforge")) {
        const bits = subs.cardforge.split("~").map(x => unquote(x)).concat(["", "", "", "", ""]);
        const kind = bits[0].toLowerCase();
        if (kind === "cf") {
          feat = this._find_feature("classFeature", { name: bits[1], className: class_name, classSource: class_src,
            level: _int(bits[2]), source: class_src }, true);
        } else if (kind === "scf") {
          const want = { name: bits[1], className: class_name, classSource: class_src, level: _int(bits[2]),
            subclassShortName: bits[3], subclassSource: bits[4], source: bits[4] };
          feat = this._find_feature("subclassFeature", want, true) || this._find_via_subclass(want);
          const b = !_is_official_class_source(d, bits[4]) ? this.data.brew(bits[4]) : null;
          const scs = or(get(or(b, {}), "subclass"), []).concat(get(d, "subclass", []));
          sc = scs.find(x => _low(get(x, "shortName")) === _low(bits[3]) && _low(get(x, "source")) === _low(bits[4])
            && _low(get(x, "className")) === _low(class_name)) || null;
        }
        if (feat === null || feat === undefined) throw new Error(`couldn't find the feature '${bits[1]}' for ${class_name} (${class_src})`);
      } else {
        const state = {};
        for (const kv of pyStr(get(subs, "state", "")).split("~")) {
          if (kv.includes("=")) { const [k, v] = split1(kv, "="); state[k.toLowerCase()] = unquote(v); }
        }
        const m = pyStr(get(state, "feature", "")).match(/^s(\d+)-(\d+)$/);
        if (!m) throw new Error("no feature selected - use the \ud83c\udccf+ button next to a feature on the class page, "
          + "or click a feature's title there to copy its link");
        const ix_lvl = parseInt(m[1], 10), ix_feat = parseInt(m[2], 10);
        const by_level = new Map();
        for (const ref of get(cls, "classFeatures", [])) {
          const uid = isStr(ref) ? ref : get(or(ref, {}), "classFeature", "");
          const want = unpack_cf_uid(uid);
          if (T(want.level)) { if (!by_level.has(want.level)) by_level.set(want.level, []); by_level.get(want.level).push(want); }
        }
        const lst = by_level.get(ix_lvl + 1) || [];
        if (ix_feat >= lst.length) throw new Error(`${class_name} has no feature #${ix_feat + 1} at level ${ix_lvl + 1}`);
        feat = this._find_feature("classFeature", lst[ix_feat]);
        if (feat === null) throw new Error(`couldn't find '${lst[ix_feat].name}' in the ${class_name} data`);
      }
      REF_LOOKUP = (k, uid) => this._ref_lookup(k, uid);
      try { return build_class_feature(deepCopy(feat), sc); }
      finally { REF_LOOKUP = null; }
    }

    // ----- items
    item_db() {
      if (T(this._items)) return this._items;
      const items = this.data.get("items.json");
      const base = this.data.get("items-base.json");
      const mv = or(this.data.get("magicvariants.json", true), {});
      const prop_names = {}, prop_entries = {};
      for (const p of or(get(base, "itemProperty", []), [])) {
        const ab = get(p, "abbreviation");
        let nm = get(p, "name");
        const ents = or(get(p, "entries"), []);
        if (!T(nm) && ents.length && isDict(ents[0])) nm = get(ents[0], "name");
        if (T(ab)) {
          if (!has(prop_names, ab)) prop_names[ab] = pyStr(or(nm, get(PROP, ab, ab))).toLowerCase();
          if (ents.length && !has(prop_entries, ab)) prop_entries[ab] = ents;
        }
      }
      this._items = {
        item: get(items, "item", []), group: get(items, "itemGroup", []),
        base: get(base, "baseitem", []), variants: get(mv, "magicvariant", []),
        ctx: { prop_names, prop_entries },
      };
      return this._items;
    }
    _base_for(ref, bases = null) {
      bases = bases !== null ? bases : this.item_db().base;
      const [n, s] = pyStr(ref).split("|").concat(["phb"]).slice(0, 2);
      for (const b of bases) if (b.name.toLowerCase() === n.toLowerCase() && pyStr(get(b, "source", "")).toLowerCase() === s.toLowerCase()) return b;
      for (const b of bases) if (b.name.toLowerCase() === n.toLowerCase()) return b;
      return null;
    }
    find_item(h) {
      const db = this.item_db();
      let e = this._find_item_in(h, db.item, db.group, db.base, db.variants);
      if (e === null) {
        const b = this.data.brew(rsplit1(h, "_").pop());
        if (T(b)) {
          for (const p of or(get(b, "itemProperty"), [])) {
            if (T(get(p, "abbreviation")) && T(get(p, "name")) && !has(db.ctx.prop_names, p.abbreviation)) db.ctx.prop_names[p.abbreviation] = p.name.toLowerCase();
          }
          e = this._find_item_in(h, or(get(b, "item"), []).concat(db.item), or(get(b, "itemGroup"), []).concat(db.group),
            or(get(b, "baseitem"), []).concat(db.base), or(get(b, "magicvariant"), []).concat(db.variants));
        }
      }
      return T(e) ? [e, db.ctx] : [null, null];
    }
    _find_item_in(h, items, groups, bases, variants) {
      const pools = [["item", items], ["group", groups], ["base", bases]];
      const allpool = items.concat(groups, bases);
      const finder = (n, s) => allpool.find(x => nameIs(x, n) && srcIs(x, s)) || null;
      for (const [kind, pool] of pools) {
        for (let e of pool) {
          if (ent_hash(e) === h) {
            e = resolve_copy(deepCopy(e), finder);
            if (kind === "group") e._isGroup = true;
            if (T(get(e, "baseItem"))) {
              const bi = this._base_for(e.baseItem, bases);
              if (bi) {
                for (const [k, v] of Object.entries(bi)) {
                  if (!has(e, k) && !["entries", "name", "source", "page", "srd", "basicRules", "value", "reprintedAs"].includes(k)) e[k] = deepCopy(v);
                }
                e._baseName = bi.name;
              }
            }
            return e;
          }
        }
      }
      for (const v of variants) {
        const inh = get(v, "inherits", {});
        for (const b of bases) {
          if (!Resolver._variant_applies(v, b)) continue;
          const name = `${pyStr(get(inh, "namePrefix", ""))}${b.name}${pyStr(get(inh, "nameSuffix", ""))}`;
          if (`${name}_${pyStr(get(inh, "source", get(v, "source", "")))}`.toLowerCase() !== h) continue;
          const e = deepCopy(b);
          for (const [k, val] of Object.entries(inh)) if (!["namePrefix", "nameSuffix", "nameRemove"].includes(k)) e[k] = deepCopy(val);
          e.name = name;
          e._baseName = b.name;
          delete e.value;
          const repl = { baseName: b.name, dmgType: get(DMG, get(b, "dmgType"), ""),
            bonusWeapon: get(inh, "bonusWeapon", ""), bonusAc: get(inh, "bonusAc", ""),
            bonusSpellAttack: get(inh, "bonusSpellAttack", ""), bonusSpellSaveDc: get(inh, "bonusSpellSaveDc", "") };
          const sub = (m, g1, g2) => {
            const val = pyStr(get(repl, g1, ""));
            return g2 === "/l" ? val.toLowerCase() : g2 === "/u" ? val.toUpperCase() : val;
          };
          e.entries = _walk_str(get(e, "entries", []), s => s.replace(/\{=(\w+)(\/\w)?\}/g, sub));
          return e;
        }
      }
      return null;
    }
    static _variant_applies(v, b) {
      const reqs = get(v, "requires", []);
      let ok = false;
      for (const r of reqs) {
        if (Object.entries(r).every(([k, val]) => (k === "type" ? code(get(b, k)) === code(val) : deepEqual(get(b, k, null), val)))) { ok = true; break; }
      }
      if (!ok) return false;
      for (const [k, val] of Object.entries(or(get(v, "excludes"), {}))) {
        let bv = get(b, k, null);
        let vals = isList(val) ? val : [val];
        if (k === "type") { bv = code(bv); vals = vals.map(x => code(x)); }
        if (inList(bv, vals) || (isList(bv) && bv.some(x => inList(x, vals)))) return false;
      }
      return true;
    }
  }
  class ClassMissing extends Error {}

  // ------------------------------------------------------------------ input
  const LINE_RE = /^\s*(?:(\d+)\s*[x\u00d7]\s+)?(\S+?)(?:\s+[x\u00d7]\s*(\d+))?(?:\s*\[([^\]]*)\])?\s*(?:#\s.*)?$/i;
  const FORMAT_TAGS = { "card": "card", "fold": "card", "folding": "card", "folding card": "card",
    "card/index": "card-index", "card-index": "card-index", "card or index": "card-index", "card>index": "card-index",
    "index": "3x5", "index card": "3x5", "3x5": "3x5", "5x3": "3x5", "5x8": "5x8", "8x5": "5x8" };

  function parse_line(raw) {
    const m = String(raw).trim().match(LINE_RE);
    if (!m) return null;
    const tag = (m[4] || "").trim().toLowerCase().replace(/\u00d7/g, "x");
    if (tag && !has(FORMAT_TAGS, tag)) warn(`unknown format [${m[4]}] - using the default for: ${m[2]}`);
    return [m[2], parseInt(m[1] || m[3] || "1", 10), get(FORMAT_TAGS, tag, null)];
  }
  const LOOT_START_RE = /^(?:(\d+)\s*[x\u00d7]\s+)?\[loot\]\s*(.*?)\s*(?:\[([^\]]*)\])?\s*(?:#\s*(.*))?$/i;
  const LOOT_LINE_RE = /^(coins|gems|art|other|item)\s*:\s*(.*)$/i;
  const LIST_START_RE = /^(?:(\d+)\s*[x\u00d7]\s+)?\[list\]\s*(.*?)\s*(?:\[([^\]]*)\])?\s*(?:#\s*(.*))?$/i;
  const LIST_END_RE = /^\[(?:end(?:\s*(?:list|loot))?|\/\s*(?:list|loot))\]/i;

  /** the text of a .txt list -> [[link | ListSpec | LootSpec, copies, format or null]] */
  function read_text(text) {
    const links = [];
    let block = null;
    for (let raw of splitlines(String(text).replace(/^\ufeff/, ""))) {
      raw = raw.trim();
      if (!raw || raw.startsWith("#") || raw.startsWith("//") || raw.startsWith(";")) continue;
      const m = raw.match(LIST_START_RE), lm = raw.match(LOOT_START_RE);
      if (m || lm) {
        if (block) links.push(block);
        const mm = m || lm;
        const tag = (mm[3] || "").trim().toLowerCase().replace(/\u00d7/g, "x");
        const spec = m ? new ListSpec(mm[2] || "List", [], (mm[4] || "").trim()) : new LootSpec(mm[2] || "Loot", (mm[4] || "").trim());
        block = [spec, parseInt(mm[1] || "1", 10), get(FORMAT_TAGS, tag, "card")];
        continue;
      }
      if (block && block[0] instanceof LootSpec) {
        if (LIST_END_RE.test(raw)) { links.push(block); block = null; continue; }
        const km = raw.match(LOOT_LINE_RE);
        if (km) {
          const kind = km[1].toLowerCase(), rest = km[2].trim();
          if (kind === "item") {
            const im = rest.match(/^(\S+)\s*(?:#\s*(.*))?$/);
            if (im) block[0].items.push([im[1], (im[2] || "").trim()]);
          } else block[0][kind].push(rest);
        } else if (/^(?:https?:\/\/|[\w.-]+\.html#)/i.test(raw)) {
          const im = raw.match(/^(\S+)\s*(?:#\s*(.*))?$/);
          block[0].items.push([im[1], (im[2] || "").trim()]);
        }
        continue;
      }
      if (LIST_END_RE.test(raw)) { if (block) links.push(block); block = null; continue; }
      const parsed = parse_line(raw);
      if (!parsed) continue;
      if (block) block[0].urls.push(parsed[0]);
      else links.push(parsed);
    }
    if (block) links.push(block);
    return links;
  }

  /** a list downloaded from 5e.tools ("Download Pinned List") -> lines of our list format */
  function pinned_to_text(json) {
    const ft = pyStr(get(json, "fileType", ""));
    const page = (ft.match(/^([a-z0-9]+)-sublist/i) || [])[1];
    const items = get(json, "items", get(get(json, "entity", {}), "items", []));
    if (!page || !isList(items)) return null;
    const lines = [];
    for (const it of items) {
      const h = get(it, "h");
      if (!T(h)) continue;
      const c = pyInt(get(it, "c", 1)) || 1;
      lines.push(`${c > 1 ? c + "x " : ""}https://5e.tools/${page.toLowerCase()}.html#${h}`);
    }
    return lines.join("\n");
  }

  // ------------------------------------------------------------------ printer calibration
  const PAPER_MM = { letter: [215.9, 279.4], a4: [210.0, 297.0] };
  const fmt_mm = v => { let s = (v >= 0 ? "+" : "-") + Math.abs(v).toFixed(1); return s === "+0.0" || s === "-0.0" ? "0" : s; };
  const hesc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
  const fmtD = d => (d === 0 ? "0" : (d > 0 ? "+" : "-") + Math.round(Math.abs(d)));

  function calibration_pages(paper, duplex, offset, howTo = "Type them into the Card Forge page (Printer alignment) - it adds them to the current offset for you.") {
    const [W, H] = PAPER_MM[paper];
    const [dx, dy] = offset;
    const xs = [28, W / 2, W - 28], ys = [40, H / 2, H - 40];
    const font = "font-family='Helvetica, Arial, sans-serif'";
    const f = [`<svg xmlns='http://www.w3.org/2000/svg' width='${W}mm' height='${H}mm' viewBox='0 0 ${W} ${H}'>`];
    for (const x of xs) for (const y of ys) f.push(`<path d='M${x} ${y - 16} V${y + 16} M${x - 16} ${y} H${x + 16}' stroke='#000' stroke-width='0.3'/>`);
    f.push(`<text x='${W / 2}' y='${H / 2 - 40}' text-anchor='middle' font-size='6' font-weight='700' ${font}>FRONT</text>`);
    const lines = [`Card Forge printer alignment test  \u2022  ${paper.toUpperCase()}  \u2022  flip on the ${duplex} edge`
      + `  \u2022  current back offset X ${fmt_mm(dx)} mm, Y ${fmt_mm(dy)} mm`,
    "Print this file at 100% / Actual size (no 'Fit'), the same way you print your cards, then turn the page over."];
    lines.forEach((t, i) => f.push(`<text x='${W / 2}' y='${H / 2 - 30 + i * 6}' text-anchor='middle' font-size='3.4' ${font}>${hesc(t)}</text>`));
    f.push("</svg>");
    const b = [`<svg xmlns='http://www.w3.org/2000/svg' width='${W}mm' height='${H}mm' viewBox='0 0 ${W} ${H}'>`];
    const red = "#c4141c";
    for (const x of xs) {
      for (const y of ys) {
        let bx = duplex === "long" ? W - x : x;
        let by = duplex === "long" ? y : H - y;
        bx += dx; by += dy;
        const ry = by - 9;
        b.push(`<path d='M${bx - 7} ${ry} H${bx + 7}' stroke='${red}' stroke-width='0.15'/>`);
        for (let i = -14; i < 15; i++) {
          const d = i / 2, ln = i === 0 ? 3.2 : i % 2 === 0 ? 2.2 : 1.2;
          b.push(`<path d='M${bx + d} ${ry} V${ry - ln}' stroke='${red}' stroke-width='${i === 0 ? 0.22 : 0.12}'/>`);
          if (i % 4 === 0) b.push(`<text x='${bx + d}' y='${ry - 4}' text-anchor='middle' font-size='1.6' fill='${red}' ${font}>${i === 0 ? "0" : fmtD(d)}</text>`);
        }
        b.push(`<text x='${bx - 8.5}' y='${ry + 0.8}' text-anchor='end' font-size='2.4' font-weight='700' fill='${red}' ${font}>X</text>`);
        const rx = bx + 9;
        b.push(`<path d='M${rx} ${by - 7} V${by + 7}' stroke='${red}' stroke-width='0.15'/>`);
        for (let i = -14; i < 15; i++) {
          const d = i / 2, ln = i === 0 ? 3.2 : i % 2 === 0 ? 2.2 : 1.2;
          b.push(`<path d='M${rx} ${by + d} H${rx + ln}' stroke='${red}' stroke-width='${i === 0 ? 0.22 : 0.12}'/>`);
          if (i % 4 === 0) b.push(`<text x='${rx + 4}' y='${by + d + 0.6}' font-size='1.6' fill='${red}' ${font}>${i === 0 ? "0" : fmtD(d)}</text>`);
        }
        b.push(`<text x='${rx}' y='${by + 10.5}' text-anchor='middle' font-size='2.4' font-weight='700' fill='${red}' ${font}>Y</text>`);
      }
    }
    b.push(`<text x='${W / 2}' y='${H / 2 - 40}' text-anchor='middle' font-size='6' font-weight='700' ${font}>BACK</text>`);
    const steps = [
      "Hold this side up to a bright light or window - the black lines from the front show through.",
      "Read where the vertical black line crosses the red X scale, and where the horizontal line crosses the Y scale (ticks every 0.5 mm).",
      "Middle readings:   X = ______ mm      Y = ______ mm        (0 and 0 means your printer is spot on)",
      howTo,
      `(By hand: new offset = current offset + reading. Current offset ${fmt_mm(dx)}, ${fmt_mm(dy)}; readings +1.5 and -0.5 would give`
      + ` ${fmt_mm(dx + 1.5)},${fmt_mm(dy - 0.5)})`,
      "If the left and right X readings (or top and bottom Y readings) differ, the page is being scaled: print at 100% / Actual size.",
    ];
    steps.forEach((t, i) => b.push(`<text x='${W / 2}' y='${H / 2 + 24 + i * 5.5}' text-anchor='middle' font-size='3.2' ${font}>${hesc(t)}</text>`));
    b.push("</svg>");
    return [f.join(""), b.join("")];
  }
  function calibration_html(paper, duplex, offset, pages) {
    const [W, H] = PAPER_MM[paper];
    const body = pages.map(p => `<div class='pg'>${p}</div>`).join("");
    return `<!doctype html><html><head><meta charset='utf-8'><title>Card Forge - printer alignment test</title><style>`
      + `@page { size: ${W}mm ${H}mm; margin: 0; } html, body { margin: 0; background: #888; }`
      + `.pg { position: relative; width: ${W}mm; height: ${H - 0.5}mm; overflow: hidden; background: #fff; margin: 0 auto 12px; break-after: page; }`
      + `.pg:last-child { break-after: auto; } .pg svg { position: absolute; left: 0; top: 0; }`
      + `@media print { body { background: none; } .pg { margin: 0; } }`
      + `</style></head><body>${body}</body></html>`;
  }

  // ------------------------------------------------------------------ the whole run
  /**
   * Build the cards for a list.
   *   text      the list (our .txt format)
   *   load      async (req) -> {ok, value, errors}: downloads one data file (see Data._download)
   *   onEntry   optional (msg) progress callback
   *   images    true: look up pictures for monster and item cards (card.img = {art, token})
   * -> {cards, log: [{type: "ok"|"warn", text}]}
   */
  async function build(text, { load, onEntry = () => {}, store = new Map(), local = null, maxFetches = 400, images = false } = {}) {
    WARN = [];
    const log = [];
    const flushWarn = () => { for (const w of WARN) log.push({ type: "warn", text: w }); WARN = []; };
    const links = read_text(text);
    flushWarn();
    let extra = null;
    for (const [l0] of links) {
      let l = l0;
      if (l instanceof ListSpec || l instanceof LootSpec) { if (!l.urls.length) continue; l = l.urls[0]; }
      const u = urlparse(l);
      if (u.netloc && !["5e.tools", "www.5e.tools"].includes(u.netloc)) {
        extra = `${u.scheme}://${u.netloc}${rsplit1(u.path, "/")[0]}/data/`;
        break;
      }
    }
    const data = new Data({ extraBase: extra, store, local });
    const res = new Resolver(data, images);
    const cards = [];
    let fetches = 0;
    for (let li = 0; li < links.length; li++) {
      let [link, n, want] = links[li];
      let c = null, err = null;
      for (;;) {
        WARN = [];
        try {
          if (link instanceof ListSpec || link instanceof LootSpec) {
            c = link instanceof ListSpec ? res.build_list(link) : res.build_loot(link);
            c.multiFmt = { "card": "fold", "card-index": "5x8", "3x5": "3x5", "5x8": "5x8" }[want || "card"];
          } else c = res.resolve(link);
          break;
        } catch (e) {
          if (e instanceof NeedData) {
            if (++fetches > maxFetches) { err = new Error("too many data files"); break; }
            if (!load) { err = new Error("data not available: " + e.req.key); break; }
            onEntry(`Downloading ${e.req.label}\u2026`);
            store.set(e.req.key, await load(e.req));
            continue;
          }
          err = e;
          break;
        }
      }
      flushWarn();
      if (c) {
        const w = (link instanceof ListSpec || link instanceof LootSpec) ? (want || "card") : want;
        c.copies = n;
        if (w) c.want = w;
        cards.push(c);
        const info = link instanceof LootSpec ? ` (loot, ${link.items.length} magic item${link.items.length === 1 ? "" : "s"})` : c.isList ? ` (${c.sub.split(" ")[0]} entries)` : "";
        log.push({ type: "ok", text: `${c.name}${info}` + (n > 1 ? `  x${n}` : ""), card: c, i: li });
        onEntry(`+ ${c.name}`);
      } else {
        log.push({ type: "error", text: `${String(link)}\n      ${err && err.message ? err.message : err}`, i: li, reason: err && err.message ? err.message : String(err) });
      }
    }
    return { cards, log };
  }

  return {
    VERSION, DATA_BASES, BREW_ROOTS, SOURCE_ABBR, NeedData, Data, Resolver, build, read_text, parse_line, pinned_to_text,
    ListSpec, LootSpec, FORMAT_TAGS, calibration_pages, calibration_html, PAPER_MM, fmt_mm,
    // building blocks (tests)
    tx, inline, build_spell, build_monster, build_item, build_generic, build_class_feature, build_list_card, build_loot_card,
    parse_link, ent_hash, resolve_copy, warnings: () => WARN.slice(), clearWarnings: () => { WARN = []; },
  };


});
