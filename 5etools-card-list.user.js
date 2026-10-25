// ==UserScript==
// @name         5e.tools → CardForge list
// @namespace    5e-cardforge
// @version      1.7
// @description  Collect spells, items, monsters, class features, filtered lists, generated loot and more on 5e.tools into a list, then send it to your Card Forge site (or export a .txt for cardforge.py)
// @match        https://5e.tools/*
// @match        https://www.5e.tools/*
// @match        https://5etools-mirror-*.github.io/*
// @updateURL    https://cards.arcvein.org/5etools-card-list.user.js
// @downloadURL  https://cards.arcvein.org/5etools-card-list.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";
  const KEY = "cardforge_list_v1";
  const KEY_FMT = "cardforge_default_format";
  const KEY_SITE = "cardforge_site_url";   // where the Card Forge website lives
  const DEFAULT_SITE = "https://cards.arcvein.org/";
  // what each entry is printed on (written to the .txt as [tag] after the link)
  const FORMATS = [
    ["card", "Card", "Normal card; two-sided or a folding card if it needs more room"],
    ["card/index", "Card, else index", "Normal card if it fits on one (front and back), otherwise an index card"],
    ["3x5", "3×5 index card", "Always a 3×5 index card (5×8 if it doesn't fit)"],
    ["5x8", "5×8 index card", "Always a 5×8 index card"],
  ];
  const FORMAT_ALIASES = { "card": "card", "fold": "card", "folding": "card", "card/index": "card/index", "card-index": "card/index",
    "card or index": "card/index", "index": "3x5", "index card": "3x5", "3x5": "3x5", "5x8": "5x8" };
  const defaultFormat = () => { const v = GM_getValue(KEY_FMT, "card"); return FORMATS.some(f => f[0] === v) ? v : "card"; };
  const fmtOptions = sel => FORMATS.map(([v, label, help]) => `<option value="${v}" title="${help}" ${v === sel ? "selected" : ""}>${label}</option>`).join("");
  const SUPPORTED = ["spells", "items", "bestiary", "feats", "backgrounds", "races", "conditionsdiseases",
    "optionalfeatures", "rewards", "trapshazards", "objects", "languages", "deities", "actions",
    "variantrules", "psionics", "charcreationoptions", "cultsboons", "senses", "skills", "decks"];
  const LABEL = { spells: "Spell", items: "Item", bestiary: "Creature", feats: "Feat", backgrounds: "Background",
    races: "Species", conditionsdiseases: "Condition", optionalfeatures: "Feature", rewards: "Reward",
    trapshazards: "Trap", objects: "Object", languages: "Language", deities: "Deity", actions: "Action",
    variantrules: "Rule", psionics: "Psionic", charcreationoptions: "Option", cultsboons: "Boon",
    senses: "Sense", skills: "Skill", decks: "Card" };

  const load = () => { try { return JSON.parse(GM_getValue(KEY, "[]")); } catch (e) { return []; } };
  const save = l => GM_setValue(KEY, JSON.stringify(l));

  // ---------- class pages: every class & subclass feature gets a small 🃏+ button
  const isClassPage = () => /(^|\/)classes\.html$/i.test(location.pathname);
  const LEVEL_RE = /^Level (\d+):\s*/i;
  const enc = s => encodeURIComponent(s);
  const titleCase = s => String(s).replace(/\b\w/g, c => c.toUpperCase());
  const classHash = () => location.hash.slice(1).split(",")[0];

  function headingText(title) {   // visible heading text, without the hidden "Subclass:" prefix and trailing "."
    const c = title.cloneNode(true);
    c.querySelectorAll("[data-subclass-name-prefix], .ve-hidden, .cf-feat-btn").forEach(x => x.remove());
    return c.textContent.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  }

  function featureFromHeading(title) {
    const tr = title.closest("tr"), ch = classHash();
    if (!tr || !ch.includes("_")) return null;
    const text = headingText(title), m = text.match(LEVEL_RE);
    const name = text.replace(LEVEL_RE, "").trim();
    let level = m ? +m[1] : null;
    const base = location.origin + location.pathname + "#" + ch;
    const raw = decodeURIComponent(ch), cls = titleCase(raw.slice(0, raw.lastIndexOf("_")));
    if (tr.dataset.scrollId) {   // class feature: data-scroll-id="<level index>-<feature index>"
      const [L, F] = tr.dataset.scrollId.split("-").map(Number);
      level = level || L + 1;
      return { url: `${base},state:feature=s${L}-${F},cardforge:cf~${enc(name)}~${level}`,
        name, kind: "Class Feature", src: `${cls} · Lv ${level}`, qty: 1 };
    }
    if (tr.dataset.subclassId) { // subclass feature: data-subclass-id="sub_<short name>_<source>"
      const bits = tr.dataset.subclassId.split("_"), scSrc = bits.pop(), scShort = decodeURIComponent(bits.slice(1).join("_"));
      if (!level) {   // the subclass's first heading has no "Level N:" - take it from the class row above
        let prev = tr.previousElementSibling;
        while (prev && !prev.dataset.scrollId) prev = prev.previousElementSibling;
        if (prev) level = +prev.dataset.scrollId.split("-")[0] + 1;
      }
      return { url: `${base},state:${tr.dataset.subclassId}=b1~feature=s${(level || 1) - 1}-0,cardforge:scf~${enc(name)}~${level || ""}~${enc(scShort)}~${enc(scSrc)}`,
        name, kind: "Subclass Feature", src: `${titleCase(scShort)} (${cls}) · Lv ${level || "?"}`, qty: 1 };
    }
    return null;
  }

  function decorateClassPage() {
    if (!isClassPage()) return;
    document.querySelectorAll("#pagecontent tr[data-scroll-id], #pagecontent tr[data-subclass-id]").forEach(tr => {
      tr.querySelectorAll(".entry-title-inner").forEach((title, i) => {
        if (title.dataset.cfDone) return;
        // the row's own heading, plus any "Level N: ..." feature headings nested in it (e.g. a subclass's level-3 features)
        if (i > 0 && !LEVEL_RE.test(headingText(title))) return;
        title.dataset.cfDone = "1";
        const btn = document.createElement("button");
        btn.type = "button"; btn.className = "cf-feat-btn"; btn.textContent = "🃏+";
        btn.title = "Add this feature to your Card Forge list";
        btn.addEventListener("mousedown", e => { e.preventDefault(); e.stopPropagation(); });
        btn.addEventListener("click", e => {
          e.preventDefault(); e.stopPropagation();
          const f = featureFromHeading(title);
          if (f) addItem(f); else flash("Couldn't work out which feature this is");
        });
        title.append(btn);   // stopPropagation above keeps the site's "copy link" click from firing
      });
    });
  }

  // ---------- list cards: the page's filtered (or pinned) list as one compact reference card
  const pageName = () => location.pathname.split("/").pop().replace(".html", "").toLowerCase();
  const isListPage = () => SUPPORTED.includes(pageName());
  const PLURAL = { Species: "species", Deity: "deities", Trap: "traps", Boon: "boons", Feature: "features", Option: "options" };
  const plural = label => PLURAL[label] || (label || "entry").toLowerCase() + "s";
  // most pages have one #list; Items has two (#list-mundane, #list-magic). Pinned entries live in #sublist.
  const LIST_SEL = "#list, .list--stats:not(#sublist)";
  const ROW_SEL = "#list > * > a[href^='#'], .list--stats:not(#sublist) > * > a[href^='#']";
  const PIN_SEL = "#sublist a[href^='#']";
  function listRows(sel) {   // [{hash, name, src}] for the rows currently shown, in page order
    const seen = new Set(), out = [];
    for (const a of document.querySelectorAll(sel)) {
      const hash = (a.getAttribute("href") || "").slice(1).split(",")[0];
      if (!hash.includes("_") || seen.has(hash)) continue;
      seen.add(hash);
      const raw = decodeURIComponent(hash);
      const nameEl = a.querySelector(".ve-bold, .bold");
      const srcEl = a.querySelector("[class*='source__']");
      out.push({ hash, name: (nameEl && nameEl.textContent.trim()) || titleCase(raw.slice(0, raw.lastIndexOf("_"))),
        src: (srcEl && srcEl.textContent.trim()) || raw.split("_").pop().toUpperCase() });
    }
    return out;
  }
  const filteredHashes = () => listRows(ROW_SEL).map(r => r.hash);
  const pinnedHashes = () => listRows(PIN_SEL).map(r => r.hash);
  function filterSummary() {   // the filter "pills" the user set, e.g. "1st level · Wizard · not Reprinted"
    const parts = [...document.querySelectorAll(".ve-fltr__mini-pill, .fltr__mini-pill")]
      .filter(p => p.offsetParent !== null && !/default-(sel|desel)/.test(p.className) && /^(yes|no)$/.test(p.dataset.state || ""))
      .map(p => (p.dataset.state === "no" ? "not " : "") + p.textContent.trim()).filter(Boolean);
    const q = (document.getElementById("lst__search") || {}).value;
    if (q) parts.unshift(`“${q.trim()}”`);
    return parts.join(" · ");
  }
  function hashStr(str) { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

  function makeListItem(page, hashes, title, note, base) {
    return { url: `list:${page}:${hashStr(title + "|" + hashes.join("|"))}`, list: { page, hashes, note, base },
      name: title, kind: `${LABEL[page] || "Entry"} List`, src: `${hashes.length} ${plural(LABEL[page])}`, qty: 1 };
  }

  function saveList(which) {
    const page = pageName(), hashes = which === "pinned" ? pinnedHashes() : filteredHashes();
    if (!hashes.length) { flash(which === "pinned" ? "Nothing is pinned" : "The list is empty"); return; }
    const noun = plural(LABEL[page]), note = which === "pinned" ? "" : filterSummary();
    const Noun = noun[0].toUpperCase() + noun.slice(1);
    const def = which === "pinned" ? `Pinned ${noun}` : note ? `${Noun}: ${note}` : `All ${noun}`;
    const title = prompt(`Name for this list card (${hashes.length} ${noun}, names and key details only):`, def.slice(0, 70));
    if (title === null) return;
    const base = location.origin + location.pathname + "#";
    addItem(makeListItem(page, hashes, title.trim() || def, note, base));
  }

  // every entry of the filtered (or pinned) list as its own card
  function addAll(which) {
    const page = pageName(), rows = listRows(which === "pinned" ? PIN_SEL : ROW_SEL), noun = plural(LABEL[page]);
    if (!rows.length) { flash(which === "pinned" ? "Nothing is pinned" : "The list is empty"); return; }
    if (rows.length > 40 && !confirm(`Add all ${rows.length} ${noun} as separate cards?`)) return;
    const l = load(), base = location.origin + location.pathname + "#", fmt = defaultFormat();
    let added = 0, had = 0;
    for (const r of rows) {
      const url = base + r.hash;
      if (l.some(x => x.url.toLowerCase() === url.toLowerCase())) { had++; continue; }   // already in the list: no extra copy
      l.push({ url, name: r.name, src: r.src, kind: LABEL[page] || page, qty: 1, fmt });
      added++;
    }
    save(l); render();
    flash(`Added ${added} ${added === 1 ? noun.replace(/s$/, "") : noun}` + (had ? ` (${had} already in your list)` : ""));
  }

  // ---------- loot generator: a rolled result as one loot card, and/or its items as separate cards
  const isLootPage = () => /(^|\/)lootgen\.html$/i.test(location.pathname);
  const lootBlocks = () => [...document.querySelectorAll("#lootgen-rhs div.ve-shadow-big")];   // newest first
  const pageOf = href => (href.split("#")[0].split("/").pop() || "").replace(".html", "").toLowerCase();
  const absUrl = href => new URL(href, location.href).href;
  // a spell link marked as "on a spell scroll" (cardforge.py prints it as a scroll card); scrollHash = the scroll item
  const scrollUrl = (spellUrl, scrollHash = "") => `${spellUrl.split(",")[0]},cardforge:scroll~${scrollHash}`;

  function readLoot(blk) {
    const title = ((blk.querySelector("h4 > div") || {}).textContent || "Loot").replace(/\s+/g, " ").trim();
    const out = { title, note: "", coins: [], gems: [], art: [], other: [], items: [] };
    const top = blk.querySelector(":scope > ul");
    if (!top) return out;
    const kindOf = t => /in coinage/i.test(t) ? "coins" : /gemstone/i.test(t) ? "gems" : /art object/i.test(t) ? "art"
      : /mundane item/i.test(t) ? "other" : "items";
    // rows are <li>s that aren't headings (a heading <li> is followed by the <ul> it introduces)
    const leaves = ul => [...ul.querySelectorAll("li")].filter(li => !(li.nextElementSibling && li.nextElementSibling.tagName === "UL"));
    const clean = el => el.textContent.replace(/\s+/g, " ").trim();
    const kids = [...top.children];
    kids.forEach((el, i) => {
      if (el.tagName !== "LI") return;
      const text = clean(el);
      const tot = text.match(/^A total of ([\d,.]+)\s*(\w+)/i);
      if (tot) { out.note = `${tot[1]} ${tot[2].toLowerCase()} in coins, gems and art`; return; }
      const next = kids[i + 1];
      if (!next || next.tagName !== "UL") return;
      const kind = kindOf(text), rows = leaves(next);
      if (kind === "coins") out.coins.push(...rows.map(clean));
      else if (kind === "gems" || kind === "art") {
        const hm = text.match(/^([\d,.]+\s*\w+)\s+(gemstones|art objects)\s*\(×(\d+);\s*worth\s+([\d,.]+\s*\w+)/i);
        const head = hm ? `${hm[1]} ${hm[2]} ×${hm[3]} (${hm[4]})` : text.replace(/:$/, "");
        const names = rows.map(li => {
          const a = li.querySelector("a"), c = clean(li).match(/×(\d+)\s*$/);
          return (a ? a.textContent.trim() : clean(li).split(" (")[0]) + (c ? ` ×${c[1]}` : "");
        });
        out[kind].push(`${head}: ${names.join(", ")}`);
      } else if (kind === "other") out.other.push(...rows.map(clean));
      else rows.forEach(li => {   // a magic item: [generic item link, chosen specific item link] and maybe a rolled spell
        const links = [...li.querySelectorAll("a[href]")].map(a => ({ href: a.getAttribute("href"), text: a.textContent.trim() }))
          .filter(a => a.href.includes("#") && a.href.split("#")[1].split(",")[0].includes("_"));
        const items = links.filter(a => pageOf(a.href) === "items"), spells = links.filter(a => pageOf(a.href) === "spells");
        if (!items.length) return;
        const generic = items[0], chosen = items[items.length - 1];
        const scroll = /^spell scroll/i.test(generic.text) && spells.length ? spells[0] : null;
        out.items.push({ url: absUrl(scroll ? generic.href : chosen.href), name: scroll ? `${generic.text}: ${scroll.text}` : chosen.text,
          // the card for this item on its own: a spell scroll gets the rolled spell's card, marked as a scroll
          card: scroll ? scrollUrl(absUrl(scroll.href), generic.href.split("#")[1].split(",")[0]) : absUrl(chosen.href),
          cardName: scroll ? scroll.text : chosen.text, cardKind: scroll ? "Spell Scroll" : "Item" });
      });
    });
    return out;
  }

  function saveLoot(blk) {
    if (!blk) { flash("Roll some loot first"); return; }
    const loot = readLoot(blk);
    addItem({ url: `loot:${hashStr(JSON.stringify(loot) + Date.now())}`, loot, name: loot.title, kind: "Loot",
      src: `${loot.items.length} magic item${loot.items.length === 1 ? "" : "s"}${loot.coins.length ? " · coins" : ""}${loot.gems.length || loot.art.length ? " · gems/art" : ""}`, qty: 1 });
  }

  function addLootItems(blk) {   // every item on its own card; coins, gems and art objects are left out
    if (!blk) { flash("Roll some loot first"); return; }
    const loot = readLoot(blk);
    if (!loot.items.length) { flash("No items in this loot (coins, gems and art objects aren't added)"); return; }
    const l = load(), fmt = defaultFormat(), counts = new Map();
    loot.items.forEach(it => counts.set(it.card, (counts.get(it.card) || 0) + 1));
    let n = 0;
    for (const it of loot.items) {
      if (!counts.has(it.card)) continue;
      const qty = counts.get(it.card); counts.delete(it.card);
      const ex = l.find(x => x.url.toLowerCase() === it.card.toLowerCase());
      if (ex) ex.qty += qty;   // rolled again: another copy of the card
      else l.push({ url: it.card, name: it.cardName, kind: it.cardKind, qty, fmt,
        src: decodeURIComponent(it.card.split("#")[1] || "").split("_").pop().toUpperCase() });
      n += qty;
    }
    save(l); render(); flash(`Added ${n} item card${n === 1 ? "" : "s"}`);
  }

  function decorateLoot() {   // two small buttons on every generated result
    for (const blk of lootBlocks()) {
      if (blk.dataset.cfDone) continue;
      blk.dataset.cfDone = "1";
      const grp = blk.querySelector("h4 .ve-btn-group") || blk.querySelector("h4");
      if (!grp) continue;
      const mk = (label, title, fn) => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "ve-btn ve-btn-xs ve-btn-default cf-loot-btn"; b.textContent = label; b.title = title;
        b.addEventListener("mousedown", e => e.stopPropagation());
        b.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); fn(blk); });
        return b;
      };
      grp.prepend(mk("🃏 Loot card", "Add this whole result to your Card Forge list as one loot card", saveLoot),
        mk("➕ Items", "Add each item from this result as its own card (coins, gems and art objects are left out)", addLootItems));
    }
  }

  function current() {
    const page = location.pathname.split("/").pop().replace(".html", "");
    if (page === "classes") {   // a feature picked in the class table: #wizard_xphb,state:feature=s0-2
      const m = location.hash.match(/feature=s(\d+)-(\d+)/);
      const title = m && document.querySelector(`#pagecontent tr[data-scroll-id="${m[1]}-${m[2]}"] .entry-title-inner`);
      return title ? featureFromHeading(title) : null;
    }
    const hash = location.hash.slice(1).split(",")[0];
    if (!SUPPORTED.includes(page) || !hash || !hash.includes("_")) return null;
    const url = location.origin + location.pathname + "#" + hash;
    let name = "";
    const h = document.querySelector(".stats__h-name, .stats-name, .rnd-name h1, #pagecontent h1");
    if (h) name = h.textContent.trim();
    if (!name) {
      const raw = decodeURIComponent(hash);
      name = raw.slice(0, raw.lastIndexOf("_")).replace(/\b\w/g, c => c.toUpperCase());
    }
    const src = decodeURIComponent(hash).split("_").pop().toUpperCase();
    return { url, name, src, kind: LABEL[page] || page, qty: 1 };
  }

  // ---------- UI
  const css = `
  #cf-fab{position:fixed;right:18px;bottom:18px;z-index:99999;background:#7a1f1f;color:#fff;border:2px solid #e3c378;
    border-radius:24px;padding:8px 14px;font:600 14px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.4)}
  #cf-fab:hover{filter:brightness(1.15)}
  #cf-panel{position:fixed;right:18px;bottom:64px;z-index:99999;width:400px;max-height:72vh;display:none;flex-direction:column;
    background:#1f1d24;color:#eee;border:1px solid #e3c378;border-radius:10px;font:13px/1.35 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.5)}
  #cf-panel.open{display:flex}
  #cf-panel header{padding:10px 12px;border-bottom:1px solid #444;display:flex;justify-content:space-between;align-items:center}
  #cf-panel header b{color:#e3c378}
  #cf-panel .cf-add{margin:10px 12px 6px;padding:8px;border-radius:6px;border:0;background:#e3c378;color:#222;font-weight:700;cursor:pointer}
  #cf-panel .cf-add:disabled{opacity:.45;cursor:default}
  #cf-panel ul{list-style:none;margin:0;padding:4px 8px;overflow:auto;flex:1}
  #cf-panel li{display:flex;gap:6px;align-items:center;padding:5px 4px;border-bottom:1px solid #333}
  #cf-panel li .n{flex:1;min-width:0}
  #cf-panel li .n a{color:#fff;text-decoration:none}
  #cf-panel li .n small{display:block;color:#aaa}
  #cf-panel li button{background:#333;color:#eee;border:0;border-radius:4px;width:22px;height:22px;cursor:pointer;padding:0}
  #cf-panel li .q{width:22px;text-align:center}
  #cf-panel select{background:#2b2a31;color:#eee;border:1px solid #555;border-radius:4px;font:12px system-ui,sans-serif;padding:2px}
  #cf-panel li select{width:118px}
  #cf-panel .cf-defrow{display:flex;gap:6px;align-items:center;margin:0 12px 6px;color:#bbb;font-size:12px}
  #cf-panel .cf-defrow select{flex:1}
  #cf-panel .cf-listrow{display:flex;gap:6px;margin:0 12px 6px;align-items:center}
  #cf-panel .cf-listrow span.lbl{flex:0 0 66px;color:#bbb;font-size:12px}
  #cf-panel .cf-listrow button{flex:1;background:#2b4a7a;color:#fff;border:0;border-radius:6px;padding:6px 4px;cursor:pointer;font:600 12px system-ui,sans-serif}
  #cf-panel .cf-listrow button.all{background:#3d5f2e}
  #cf-panel .cf-defrow button{background:#444;color:#eee;border:0;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:12px}
  #cf-panel footer{display:flex;gap:6px;padding:10px 12px;border-top:1px solid #444;flex-wrap:wrap}
  #cf-panel footer button{flex:1;padding:7px;border-radius:6px;border:0;cursor:pointer;font-weight:600}
  #cf-panel .cf-exp{background:#2f7d32;color:#fff}
  #cf-panel .cf-send{background:#d4ac55;color:#26221e;font-weight:700}
  #cf-panel .cf-siterow{font-size:11.5px;opacity:.8;margin:2px 0 6px}
  #cf-panel .cf-siterow button{background:none;border:0;color:inherit;text-decoration:underline;padding:0;cursor:pointer;font-size:inherit}
  #cf-panel .cf-imp,#cf-panel .cf-clr{background:#444;color:#eee}
  #cf-panel .empty{padding:14px;color:#999;text-align:center}
  .cf-feat-btn{margin-left:8px;padding:1px 7px;border:1px solid #e3c378;border-radius:10px;background:#7a1f1f;color:#fff;
    font:600 11px/1.5 system-ui,sans-serif;font-variant:normal;cursor:pointer;vertical-align:middle;letter-spacing:0;text-transform:none}
  .cf-feat-btn:hover{filter:brightness(1.2)}
  @media print{.cf-feat-btn,#cf-fab,#cf-panel{display:none!important}}
  #cf-toast{position:fixed;right:18px;bottom:110px;z-index:99999;background:#2f7d32;color:#fff;padding:8px 12px;border-radius:6px;
    font:13px system-ui,sans-serif;opacity:0;transition:opacity .2s;pointer-events:none}`;
  const st = document.createElement("style"); st.textContent = css; document.head.append(st);

  const fab = document.createElement("button"); fab.id = "cf-fab"; fab.title = "Card Forge list (Alt+C adds the current entry)";
  const panel = document.createElement("div"); panel.id = "cf-panel";
  const toast = document.createElement("div"); toast.id = "cf-toast";
  document.body.append(fab, panel, toast);

  function flash(msg) { toast.textContent = msg; toast.style.opacity = 1; clearTimeout(flash.t); flash.t = setTimeout(() => toast.style.opacity = 0, 1400); }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function add() {
    const c = current();
    if (!c) { flash(isClassPage() ? "Use the 🃏+ button next to a feature" : "Open a spell, item, creature… first"); return; }
    addItem(c);
  }

  function addItem(c) {
    const l = load();
    const ex = l.find(x => x.url.toLowerCase() === c.url.toLowerCase());
    if (ex) { ex.qty++; flash(`${c.name} ×${ex.qty}`); } else { l.push({ ...c, fmt: c.fmt || defaultFormat() }); flash(`Added ${c.name}`); }
    save(l); render();
  }

  function render() {
    const l = load(), c = current();
    const total = l.reduce((s, x) => s + x.qty, 0);
    fab.textContent = `🃏 Cards: ${total}`;
    const inList = c && l.some(x => x.url.toLowerCase() === c.url.toLowerCase());
    panel.innerHTML = `
      <header><b>Card Forge list</b><span>${l.length} entr${l.length === 1 ? "y" : "ies"} · ${total} card${total === 1 ? "" : "s"}</span></header>
      <button class="cf-add" ${c ? "" : "disabled"}>${c ? (inList ? "+1 more: " : "+ Add: ") + esc(c.name) : isClassPage() ? "Use the 🃏+ buttons next to each feature" : "Open an entry to add it"}</button>
      ${c && pageName() === "spells" ? `<div class="cf-listrow"><span class="lbl">This spell:</span><button class="cf-asscroll" title="Add this spell as a spell scroll card (its own colour and back, with the scroll's save DC and attack bonus)">📜 Add as a spell scroll</button></div>` : ""}
      <div class="cf-defrow"><span>New entries:</span><select class="cf-def" title="Format for entries you add from now on">${fmtOptions(defaultFormat())}</select>${l.length ? `<button class="cf-all" title="Use this format for every entry in the list">Apply to all</button>` : ""}</div>
      ${isLootPage() ? `<div class="cf-listrow"><span class="lbl">Newest loot:</span>
        <button class="cf-lootcard" title="The most recent result as one loot card">📋 As one loot card</button>
        <button class="cf-lootitems all" title="Each item from the most recent result as its own card (no coins, gems or art objects)">➕ Add items as cards</button></div>` : ""}
      ${isListPage() ? `<div class="cf-listrow"><span class="lbl">Filtered (<span class="cf-nfilt">${filteredHashes().length}</span>):</span>
        <button class="cf-savelist" title="One card listing everything currently shown in the list (as filtered): names and key details, no descriptions">📋 As one list card</button>
        <button class="cf-addall all" title="Add every entry currently shown in the list as its own card">➕ Add all as cards</button></div>
      ${pinnedHashes().length ? `<div class="cf-listrow"><span class="lbl">Pinned (${pinnedHashes().length}):</span>
        <button class="cf-savepin" title="One card listing your pinned entries">📌 As one list card</button>
        <button class="cf-addpin all" title="Add every pinned entry as its own card">➕ Add all as cards</button></div>` : ""}` : ""}
      ${l.length ? "<ul>" + l.map((x, i) => `
        <li data-i="${i}"><span class="n"><a href="${esc(x.loot ? location.origin + "/lootgen.html" : x.list ? (x.list.base || "").split("#")[0] : x.url)}">${esc(x.name)}</a><small>${esc(x.kind)} · ${esc(x.src)}</small></span>
        <select class="cf-fmt" title="Print this entry on…">${fmtOptions(x.fmt || "card")}</select>
        <button data-a="dec">−</button><span class="q">${x.qty}</span><button data-a="inc">+</button>
        <button data-a="del" title="Remove">×</button></li>`).join("") + "</ul>"
        : `<div class="empty">Your list is empty.<br>Open a spell, item or creature and press “Add” (or Alt+C),<br>or use the 🃏+ buttons next to class features.</div>`}
      ${l.length ? `<div class="cf-siterow">${siteUrl() ? `Sends to ${esc(siteUrl().replace(/^https?:\/\//, "").replace(/\/(index\.html)?$/, ""))} ` : "Card Forge site not set yet "}<button class="cf-site">${siteUrl() ? "change" : "set it"}</button></div>` : ""}
      <footer><button class="cf-send" title="Open your Card Forge site with this list loaded">Send to Card Forge</button><button class="cf-exp">Export .txt</button><button class="cf-imp">Import .txt</button><button class="cf-clr">Clear</button></footer>`;
  }

  panel.addEventListener("change", e => {
    if (e.target.classList.contains("cf-def")) { GM_setValue(KEY_FMT, e.target.value); return; }
    if (e.target.classList.contains("cf-fmt")) {
      const l = load(), i = +e.target.closest("li").dataset.i;
      l[i].fmt = e.target.value; save(l);
    }
  });
  panel.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.classList.contains("cf-all")) {
      const f = defaultFormat(), l = load();
      l.forEach(x => x.fmt = f); save(l); render(); flash(`Every entry: ${FORMATS.find(x => x[0] === f)[1]}`); return;
    }
    if (b.classList.contains("cf-add")) return add();
    if (b.classList.contains("cf-exp")) return exportTxt();
    if (b.classList.contains("cf-send")) return sendToSite();
    if (b.classList.contains("cf-site")) { askSite(); render(); return; }
    if (b.classList.contains("cf-savelist")) return saveList("filtered");
    if (b.classList.contains("cf-savepin")) return saveList("pinned");
    if (b.classList.contains("cf-addall")) return addAll("filtered");
    if (b.classList.contains("cf-addpin")) return addAll("pinned");
    if (b.classList.contains("cf-lootcard")) return saveLoot(lootBlocks()[0]);
    if (b.classList.contains("cf-asscroll")) {
      const cur = current();
      if (cur) addItem({ ...cur, url: scrollUrl(cur.url), kind: "Spell Scroll" });
      return;
    }
    if (b.classList.contains("cf-lootitems")) return addLootItems(lootBlocks()[0]);
    if (b.classList.contains("cf-imp")) return importTxt();
    if (b.classList.contains("cf-clr")) { if (confirm("Clear the whole card list?")) { save([]); render(); } return; }
    const li = b.closest("li"); if (!li) return;
    const l = load(), i = +li.dataset.i;
    if (b.dataset.a === "inc") l[i].qty++;
    if (b.dataset.a === "dec") l[i].qty = Math.max(1, l[i].qty - 1);
    if (b.dataset.a === "del") l.splice(i, 1);
    save(l); render();
  });
  fab.addEventListener("click", () => { panel.classList.toggle("open"); render(); });
  document.addEventListener("keydown", e => {
    if (e.altKey && (e.key === "c" || e.key === "C") && !/input|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); add(); }
  });
  window.addEventListener("hashchange", () => setTimeout(() => { render(); decorateClassPage(); }, 150));
  if (isLootPage()) {   // results appear as they're rolled
    let t4 = null;
    new MutationObserver(() => { clearTimeout(t4); t4 = setTimeout(decorateLoot, 200); })
      .observe(document.body, { childList: true, subtree: true });
    decorateLoot();
  }
  if (isListPage()) {   // keep the "Save filtered list (N)" count current while the user filters
    let t2 = null;
    const watch = () => {
      const lists = [...document.querySelectorAll(LIST_SEL)];
      if (!lists.length) return setTimeout(watch, 1000);
      const mo = new MutationObserver(() => {
        clearTimeout(t2);
        t2 = setTimeout(() => { const n = panel.querySelector(".cf-nfilt"); if (n) n.textContent = filteredHashes().length; }, 300);
      });
      lists.forEach(lst => mo.observe(lst, { childList: true }));
      const pins = document.getElementById("sublist");   // pinning/unpinning: redraw the panel so the Pinned row is current
      if (pins) {
        let t3 = null;
        new MutationObserver(() => { clearTimeout(t3); t3 = setTimeout(() => { if (panel.classList.contains("open")) render(); }, 300); })
          .observe(pins, { childList: true, subtree: true });
      }
    };
    watch();
  }
  if (isClassPage()) {   // the class page renders (and re-renders) its features after load
    let t = null;
    new MutationObserver(() => { clearTimeout(t); t = setTimeout(decorateClassPage, 250); })
      .observe(document.body, { childList: true, subtree: true });
    decorateClassPage();
  }

  // ---- sending the list to the Card Forge website: it opens with #import=<z|t><base64url of the .txt>
  const siteUrl = () => GM_getValue(KEY_SITE, "") || DEFAULT_SITE;
  function askSite() {
    const v = prompt("Your Card Forge address (it's shown at the bottom of the Card Forge page):", siteUrl() || "http://");
    if (v === null) return "";
    const url = v.trim();
    if (!/^https?:\/\/[^/]+/i.test(url)) { if (url) alert("That doesn't look like a web address. It should start with http:// or https://"); return ""; }
    GM_setValue(KEY_SITE, url);
    return url;
  }
  async function packList(text) {
    let data = new TextEncoder().encode(text), kind = "t";
    if (typeof CompressionStream !== "undefined") {
      try {
        const st = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"));
        data = new Uint8Array(await new Response(st).arrayBuffer()); kind = "z";
      } catch (e) { /* send it uncompressed */ }
    }
    let bin = "";
    for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
    return kind + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  async function sendToSite() {
    if (!load().length) { flash("Nothing to send"); return; }
    const site = siteUrl() || askSite();
    if (!site) return;
    const url = site.replace(/#.*$/, "") + "#import=" + await packList(listText());
    const w = window.open(url, "_blank");
    if (!w) location.href = url;
    flash("Sent to Card Forge");
  }

  function exportTxt() {
    if (!load().length) { flash("Nothing to export"); return; }
    const d = new Date().toISOString().slice(0, 10);
    const blob = new Blob([listText()], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `cardforge-list-${d}.txt`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    flash("Exported");
  }

  function listText() {
    const l = load();
    const d = new Date().toISOString().slice(0, 10);
    const lines = [`# Card Forge list - exported ${d}`, "# Open this file on your Card Forge site (or give it to cardforge.py / make_cards)", ""];
    for (const x of l) {
      if (x.list) {   // a list card: one block with every entry's link
        const base = x.list.base || `${location.origin}/${x.list.page}.html#`;
        lines.push("", `${x.qty > 1 ? x.qty + "x " : ""}[list] ${x.name} [${x.fmt || "card"}]${x.list.note ? `   # ${x.list.note}` : ""}`);
        x.list.hashes.forEach(h => lines.push(base + h));
        lines.push("[end list]", "");
      } else if (x.loot) {   // a loot card
        const t = x.loot;
        lines.push("", `${x.qty > 1 ? x.qty + "x " : ""}[loot] ${x.name} [${x.fmt || "card"}]${t.note ? `   # ${t.note}` : ""}`);
        t.coins.forEach(c => lines.push(`coins: ${c}`));
        t.gems.forEach(g => lines.push(`gems: ${g}`));
        t.art.forEach(g => lines.push(`art: ${g}`));
        t.other.forEach(g => lines.push(`other: ${g}`));
        t.items.forEach(it => lines.push(`item: ${it.url}   # ${it.name}`));
        lines.push("[end loot]", "");
      } else lines.push(`${x.qty > 1 ? x.qty + "x " : ""}${x.url} [${x.fmt || "card"}]   # ${x.kind}: ${x.name}`);
    }
    return lines.join("\n") + "\n";
  }

  function describe(url) {   // name / type / source for a link read back from a .txt list
    const page = url.split("#")[0].split("/").pop().split(".html")[0].toLowerCase();
    const frag = url.split("#")[1] || "";
    const main = decodeURIComponent(frag.split(",")[0]);
    if (page === "classes") {
      const cls = titleCase(main.slice(0, main.lastIndexOf("_")));
      const cf = (frag.split(",").find(p => p.startsWith("cardforge:")) || "").slice(10).split("~").map(decodeURIComponent);
      if (cf[0] === "scf") return { name: cf[1], kind: "Subclass Feature", src: `${titleCase(cf[3])} (${cls}) · Lv ${cf[2]}` };
      if (cf[0] === "cf") return { name: cf[1], kind: "Class Feature", src: `${cls} · Lv ${cf[2]}` };
      return { name: `${cls} feature`, kind: "Class Feature", src: cls };
    }
    const kind = /,cardforge:scroll/i.test(frag) ? "Spell Scroll" : LABEL[page] || page;
    return { name: main.slice(0, main.lastIndexOf("_")), kind, src: main.split("_").pop().toUpperCase() };
  }

  function importTxt() {
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".txt,text/plain";
    inp.onchange = async () => {
      const text = await inp.files[0].text();
      const l = load(); let n = 0, block = null;
      const finish = b => {
        if (!b || !b.urls.length) return;
        const page = b.urls[0].split("#")[0].split("/").pop().replace(".html", "").toLowerCase();
        const it = makeListItem(page, b.urls.map(u => u.split("#")[1]), b.name, b.note, b.urls[0].split("#")[0] + "#");
        const ex = l.find(x => x.url === it.url);
        if (ex) ex.qty += b.qty; else l.push({ ...it, qty: b.qty, fmt: b.fmt });
        n++;
      };
      let loot = null;
      const finishLoot = () => {
        if (!loot) return;
        const it = { url: `loot:${hashStr(JSON.stringify(loot.data))}`, loot: loot.data, name: loot.data.title, kind: "Loot",
          src: `${loot.data.items.length} magic item${loot.data.items.length === 1 ? "" : "s"}`, qty: loot.qty, fmt: loot.fmt };
        const ex = l.find(x => x.url === it.url);
        if (ex) ex.qty += loot.qty; else l.push(it);
        n++; loot = null;
      };
      for (const raw of text.split(/\r?\n/)) {
        const s = raw.trim(); if (!s || s.startsWith("#")) continue;
        const om = s.match(/^(?:(\d+)\s*[x×]\s+)?\[loot\]\s*(.*?)\s*(?:\[([^\]]*)\])?\s*(?:#\s*(.*))?$/i);
        if (om) {
          finish(block); block = null; finishLoot();
          loot = { qty: +(om[1] || 1), fmt: FORMAT_ALIASES[(om[3] || "").trim().toLowerCase().replace("×", "x")] || defaultFormat(),
            data: { title: om[2] || "Loot", note: (om[4] || "").trim(), coins: [], gems: [], art: [], other: [], items: [] } };
          continue;
        }
        if (loot) {
          if (/^\[end(\s*loot)?\]/i.test(s)) { finishLoot(); continue; }
          const km = s.match(/^(coins|gems|art|other|item)\s*:\s*(.*)$/i);
          if (km && km[1].toLowerCase() === "item") {
            const im = km[2].match(/^(\S+)\s*(?:#\s*(.*))?$/);
            if (im) loot.data.items.push({ url: im[1], name: (im[2] || "").trim() });
          } else if (km) loot.data[km[1].toLowerCase()].push(km[2]);
          continue;
        }
        const lm = s.match(/^(?:(\d+)\s*[x×]\s+)?\[list\]\s*(.*?)\s*(?:\[([^\]]*)\])?\s*(?:#\s*(.*))?$/i);
        if (lm) {
          finish(block);
          block = { qty: +(lm[1] || 1), name: lm[2] || "List", note: (lm[4] || "").trim(), urls: [],
            fmt: FORMAT_ALIASES[(lm[3] || "").trim().toLowerCase().replace("×", "x")] || defaultFormat() };
          continue;
        }
        if (/^\[end(\s*list)?\]/i.test(s)) { finish(block); block = null; continue; }
        if (block) { const u = s.split(/\s+/)[0]; if (/^https?:/.test(u)) block.urls.push(u); continue; }
        const m = s.match(/^(?:(\d+)\s*[x×]\s+)?(\S+)(?:\s+[x×]\s*(\d+))?(?:\s*\[([^\]]*)\])?\s*(?:#\s*(?:([^:]+):\s*)?(.*))?$/i);
        if (!m || !/^https?:/.test(m[2])) continue;
        const url = m[2], qty = +(m[1] || m[3] || 1), d = describe(url);
        const ex = l.find(x => x.url.toLowerCase() === url.toLowerCase());
        if (ex) ex.qty += qty;
        const fmt = FORMAT_ALIASES[(m[4] || "").trim().toLowerCase().replace("×", "x")] || (ex && ex.fmt) || defaultFormat();
        if (ex) ex.fmt = fmt;
        else l.push({ url, qty, fmt, name: m[6] || d.name, src: d.src, kind: m[5] || d.kind });
        n++;
      }
      finish(block); finishLoot();
      save(l); render(); flash(`Imported ${n}`);
    };
    inp.click();
  }

  render();
})();
