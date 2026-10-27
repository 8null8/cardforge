/* Card Forge website: list editing, settings, building and printing. Card data comes from core.js. */
(function () {
  "use strict";
  const C = window.CardForgeCore;
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  // ------------------------------------------------------------------ settings
  const DEFAULTS = { paper: "letter", split: false, duplex: "long", big_spell: "fold", big_monster: "fold", big_item: "fold",
    big_feature: "fold", big_other: "fold", index_stock: false, images: "off", back_offset: [0, 0], min_font: 6.5, gap: 0, data_base: "" };
  const S = Object.assign({}, DEFAULTS, LS.get("cf.settings", {}));
  const saveSettings = () => LS.set("cf.settings", S);
  const BIG_OPTS = [["fold", "Folding card"], ["3x5", "3×5 index card"], ["5x8", "5×8 index card"], ["each", "Ask each time"]];

  function showSettings() {
    const f = $("#settings");
    f.paper.value = S.paper;
    f.split.value = S.split ? "yes" : "no";
    f.duplex.value = S.duplex;
    f.stock.value = S.index_stock ? "yes" : "no";
    f.images.value = S.images;
    $("#images-note").textContent = { off: "",
      back: "A creature's token, or an item's picture, in the round medallion on the back.",
      front: "The picture from 5e.tools under the title. It takes some room, so more cards may grow to two sides." }[S.images] || "";
    for (const sel of f.querySelectorAll(".bigs select")) {
      if (!sel.options.length) for (const [v, t] of BIG_OPTS) sel.append(el("option", { value: v, text: t }));
      sel.value = S["big_" + sel.dataset.cat] || "fold";
    }
    $("#off-x").value = S.back_offset[0];
    $("#off-y").value = S.back_offset[1];
    $("#min-font").value = S.min_font;
    $("#gap").value = S.gap;
    $("#data-base").value = S.data_base || "";
    $("#duplex-legend").textContent = S.split ? "You turn the printed stack over its" : "The paper flips on its";
    $("#split-note").textContent = S.split ? "You'll get a fronts sheet and a backs sheet: print the fronts, put the pages back in the tray, then print the backs." : "";
  }
  function readSettings() {
    const f = $("#settings");
    S.paper = f.paper.value || "letter";
    S.split = f.split.value === "yes";
    S.duplex = f.duplex.value || "long";
    S.index_stock = f.stock.value === "yes";
    S.images = ["back", "front"].includes(f.images.value) ? f.images.value : "off";
    for (const sel of f.querySelectorAll(".bigs select")) S["big_" + sel.dataset.cat] = sel.value;
    const num = (id, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : d; };
    S.back_offset = [Math.round(num("#off-x", 0) * 100) / 100, Math.round(num("#off-y", 0) * 100) / 100];
    S.min_font = Math.min(9, Math.max(5, num("#min-font", 6.5)));
    S.gap = Math.min(0.5, Math.max(0, num("#gap", 0)));
    S.data_base = $("#data-base").value.trim();
    saveSettings();
    showSettings();
  }

  // ------------------------------------------------------------------ the list
  // entry: {kind: "link", url, copies, want, label} | {kind: "list", title, note, urls, copies, want}
  //      | {kind: "loot", title, note, coins, gems, art, other, items: [[url, name]], copies, want}
  let entries = LS.get("cf.list", []);
  let undoEntries = null;
  const status = new Map();   // entry -> {name, error}
  const saveList = () => LS.set("cf.list", entries);
  const TAG = { "card": "card", "card-index": "card/index", "3x5": "3x5", "5x8": "5x8" };
  const FMT_OPTS = [["", "Auto"], ["card", "Card, folding if long"], ["card-index", "Card, else index card"], ["3x5", "3×5 index card"], ["5x8", "5×8 index card"]];
  const LIST_FMT_OPTS = [["card", "Cards, folding if long"], ["card-index", "Card, else 5×8 cards"], ["3x5", "3×5 index cards"], ["5x8", "5×8 index cards"]];

  function parseText(text) {
    const links = C.read_text(text);
    C.clearWarnings();
    const labels = {};
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith("[")) continue;
      const m = line.match(/^(?:\d+\s*[x×]\s+)?(\S+).*?\s#\s+(.*)$/);
      if (m) labels[m[1]] = m[2].trim();
    }
    return links.map(([l, n, want]) => {
      if (l instanceof C.ListSpec) return { kind: "list", title: l.title, note: l.note, urls: l.urls.slice(), copies: n, want: want || "card" };
      if (l instanceof C.LootSpec) return { kind: "loot", title: l.title, note: l.note, coins: l.coins.slice(), gems: l.gems.slice(), art: l.art.slice(),
        other: l.other.slice(), items: l.items.map(x => x.slice()), copies: n, want: want || "card" };
      return { kind: "link", url: l, copies: n, want: want || "", label: labels[l] || "" };
    });
  }
  function toText(list) {
    const out = [`# Card Forge list - ${new Date().toISOString().slice(0, 10)}`, ""];
    for (const e of list) {
      const cp = e.copies > 1 ? `${e.copies}x ` : "";
      const tag = e.want ? ` [${TAG[e.want]}]` : "";
      if (e.kind === "link") out.push(`${cp}${e.url}${tag}` + (e.label ? `   # ${e.label}` : ""));
      else {
        out.push(`${cp}[${e.kind}] ${e.title}${tag}` + (e.note ? `   # ${e.note}` : ""));
        if (e.kind === "list") out.push(...e.urls);
        else {
          for (const k of ["coins", "gems", "art", "other"]) for (const v of e[k]) out.push(`${k}: ${v}`);
          for (const [u, nm] of e.items) out.push(`item: ${u}` + (nm ? `   # ${nm}` : ""));
        }
        out.push(`[end ${e.kind}]`);
      }
    }
    return out.join("\n") + "\n";
  }
  const PAGE_KIND = { "spells.html": "Spell", "bestiary.html": "Creature", "items.html": "Item", "classes.html": "Class feature",
    "feats.html": "Feat", "backgrounds.html": "Background", "races.html": "Species", "conditionsdiseases.html": "Condition",
    "optionalfeatures.html": "Option", "rewards.html": "Reward", "trapshazards.html": "Trap/hazard", "objects.html": "Object",
    "languages.html": "Language", "deities.html": "Deity", "actions.html": "Action", "variantrules.html": "Rule",
    "psionics.html": "Psionic", "charcreationoptions.html": "Character option", "cultsboons.html": "Cult/boon",
    "senses.html": "Sense", "skills.html": "Skill", "decks.html": "Card" };
  const titleCase = s => s.replace(/(^|[\s(\-/])([a-z])/g, (m, a, b) => a + b.toUpperCase());

  function describe(e) {
    const st = status.get(e) || {};
    if (e.kind === "list") return { kind: "List card", name: st.name || e.title, sub: `${e.urls.length} ${e.urls.length === 1 ? "entry" : "entries"}` };
    if (e.kind === "loot") return { kind: "Loot", name: st.name || e.title, sub: e.items.length ? `${e.items.length} magic item${e.items.length === 1 ? "" : "s"}` : "" };
    let page = "", h = "", u = { fragment: "" };
    try { [page, h, u] = C.parse_link(e.url); } catch (x) { /* shown as is */ }
    let kind = PAGE_KIND[page] || "Entry", name = "";
    const lab = e.label.match(/^([^:]{2,30}):\s*(.+)$/);
    if (lab) { kind = lab[1]; name = lab[2]; } else if (e.label) name = e.label;
    if (!name && page === "classes.html") {
      const m = u.fragment.match(/cardforge:s?cf~([^~,]*)/i);
      name = m ? titleCase(decodeURIComponent(m[1])) : "Class feature";
    }
    if (!name) name = h ? titleCase(h.replace(/_[^_]*$/, "")) : e.url;
    if (/,cardforge:scroll/i.test(u.fragment)) kind = "Spell scroll";
    return { kind, name: st.name || name, sub: "" };
  }

  function renderRows() {
    const box = $("#rows");
    box.textContent = "";
    const n = entries.reduce((a, e) => a + (e.copies || 1), 0);
    $("#count").textContent = entries.length ? `${entries.length} ${entries.length === 1 ? "entry" : "entries"}` + (n !== entries.length ? `, ${n} cards` : "") : "";
    $("#btn-save").hidden = $("#btn-clear").hidden = !entries.length;
    if (!entries.length) {
      box.append(el("div", { class: "empty" },
        el("p", { class: "lead", text: "Nothing here yet." }),
        el("p", { text: "Paste links from 5e.tools, or drop a list file anywhere on this card:" }),
        el("p", { text: "a list from the collector script, or a list saved with “Download Pinned List” on 5e.tools." })));
      updateHint();
      return;
    }
    entries.forEach((e, i) => {
      const d = describe(e), st = status.get(e) || {};
      const sel = el("select", { "aria-label": `Format for ${d.name}`, "data-i": i, class: "fmt" });
      for (const [v, t] of (e.kind === "link" ? FMT_OPTS : LIST_FMT_OPTS)) sel.append(el("option", { value: v, text: t }));
      sel.value = e.want || "";
      box.append(el("div", { class: "row" + (st.error ? " bad" : ""), "data-i": i },
        el("span", { class: "kind", text: d.kind, title: d.kind }),
        el("span", { class: "name", title: st.error ? `${d.name}: ${st.error}` : e.url || d.name },
          d.name, d.sub ? el("small", { text: d.sub }) : null, st.error ? el("span", { class: "err", text: shortErr(st.error) }) : null),
        el("label", { class: "copies" }, "×", el("input", { type: "number", min: 1, max: 99, value: e.copies, "data-i": i, class: "cp", "aria-label": `Copies of ${d.name}` })),
        sel,
        el("button", { type: "button", class: "rm", "data-i": i, "aria-label": `Remove ${d.name}`, title: "Remove", text: "×" })));
    });
    updateHint();
  }
  const shortErr = s => (/couldn't find|could not find/i.test(s) ? "not found" : /page.*supported/i.test(s) ? "page not supported" : /no entry selected/i.test(s) ? "no entry in link" : "couldn't make this");

  function setEntries(list, msg) {
    if (entries.length) undoEntries = entries;
    entries = list;
    status.clear();
    saveList(); renderRows();
    if (msg) toast(msg, undoEntries ? "Undo" : null, () => { entries = undoEntries; undoEntries = null; saveList(); renderRows(); });
  }
  function addEntries(list) {
    const have = new Set(entries.filter(e => e.kind === "link").map(e => e.url));
    let added = 0, dup = 0;
    for (const e of list) {
      if (e.kind === "link" && have.has(e.url)) { dup++; continue; }
      entries.push(e); added++;
      if (e.kind === "link") have.add(e.url);
    }
    saveList(); renderRows();
    toast(added ? `Added ${added} ${added === 1 ? "entry" : "entries"}` + (dup ? ` (${dup} already in the list)` : "") : dup ? "Those are already in your list" : "No 5e.tools links found in that");
  }

  // ------------------------------------------------------------------ quick add: search 5e.tools by name
  // 5e.tools' own search index, downloaded on first use and kept for a week like the other data
  let finder = null;
  function searchEntries() {
    if (!finder) {
      finder = (async () => {
        const data = new C.Data({ extraBase: S.data_base ? normBase(S.data_base) : null, store: STORE });
        for (let i = 0; i < 6; i++) {
          try { return C.search_entries(data); }
          catch (e) { if (!(e instanceof C.NeedData)) throw e; STORE.set(e.req.key, await load(e.req)); }
        }
        throw new Error("too many downloads");
      })();
      finder.catch(() => { finder = null; });   // try again next time
    }
    return finder;
  }
  const findEl = $("#find"), hitsEl = $("#find-hits"), noteEl = $("#find-note");
  let hits = [], cur = -1, findTimer = null, findSeq = 0;
  const findNote = t => { noteEl.textContent = t || ""; noteEl.hidden = !t; };
  const inList = url => entries.find(e => e.kind === "link" && e.url === url);
  function renderHits() {
    hitsEl.textContent = "";
    hits.forEach((h, i) => {
      const have = inList(h.url);
      hitsEl.append(el("li", {}, el("button", { type: "button", class: "hit" + (i === cur ? " on" : "") + (have ? " added" : ""), "data-i": i },
        el("span", { class: "hn", text: h.name }), el("span", { class: "hk", text: `${h.kind} · ${h.source}` }),
        el("span", { class: "ha", text: have ? (have.copies > 1 ? `✓ ×${have.copies}` : "✓ Added") : "+ Add" }))));
    });
    hitsEl.hidden = !hits.length;
  }
  async function runSearch() {
    const q = findEl.value, seq = ++findSeq;
    if (!q.trim()) { hits = []; cur = -1; renderHits(); findNote(""); return; }
    let all;
    try {
      if (!finder) findNote("Getting the 5e.tools index…");
      all = await searchEntries();
    } catch (e) {
      if (seq === findSeq) findNote("Couldn't get the 5e.tools index. Check your connection, or paste links instead.");
      return;
    }
    if (seq !== findSeq) return;
    hits = C.search(all, q, 30); cur = hits.length ? 0 : -1;
    findNote(hits.length ? "" : `Nothing called “${q.trim()}”. Official and partnered books are searchable; paste links for homebrew.`);
    renderHits();
  }
  function quickAdd(h) {   // a second tap adds another copy
    const have = inList(h.url);
    if (have) { have.copies = (have.copies || 1) + 1; toast(`${h.name}: ${have.copies} copies`); }
    else {
      entries.push({ kind: "link", url: h.url, copies: 1, want: "", label: `${h.kind.length <= 30 ? h.kind : "Subclass feature"}: ${h.name}` });
      toast(`Added ${h.name}`);
    }
    saveList(); renderRows(); renderHits();
  }
  findEl.addEventListener("focus", () => { searchEntries().catch(() => {}); }, { once: true });   // start the download early
  findEl.addEventListener("input", () => { clearTimeout(findTimer); findTimer = setTimeout(runSearch, 120); });
  findEl.addEventListener("keydown", ev => {
    if (ev.key === "Escape") { findEl.value = ""; runSearch(); return; }
    if (!hits.length) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      cur = (cur + (ev.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length;
      renderHits();
      hitsEl.children[cur].scrollIntoView({ block: "nearest" });
    } else if (ev.key === "Enter") { ev.preventDefault(); if (cur >= 0) quickAdd(hits[cur]); }
  });
  hitsEl.addEventListener("click", ev => { const b = ev.target.closest(".hit"); if (b) quickAdd(hits[+b.dataset.i]); });

  // list editing events
  $("#rows").addEventListener("change", ev => {
    const i = +ev.target.dataset.i;
    if (!entries[i]) return;
    if (ev.target.classList.contains("cp")) entries[i].copies = Math.max(1, Math.min(99, parseInt(ev.target.value, 10) || 1));
    if (ev.target.classList.contains("fmt")) entries[i].want = ev.target.value;
    saveList(); renderRows();
  });
  $("#rows").addEventListener("click", ev => {
    const b = ev.target.closest(".rm");
    if (!b) return;
    const i = +b.dataset.i, gone = entries[i];
    entries.splice(i, 1);
    saveList(); renderRows();
    toast(`Removed ${describe(gone).name}`, "Undo", () => { entries.splice(i, 0, gone); saveList(); renderRows(); });
  });
  $("#btn-add").addEventListener("click", () => { $("#texted").hidden = true; $("#adder").hidden = false; $("#add-text").focus(); });
  $("#add-cancel").addEventListener("click", () => { $("#adder").hidden = true; $("#add-text").value = ""; });
  $("#add-ok").addEventListener("click", () => {
    const list = parseText($("#add-text").value);
    $("#adder").hidden = true; $("#add-text").value = "";
    addEntries(list);
  });
  $("#btn-text").addEventListener("click", () => {
    $("#adder").hidden = true; $("#texted").hidden = false;
    $("#list-text").value = toText(entries);
    $("#list-text").focus();
  });
  $("#text-cancel").addEventListener("click", () => { $("#texted").hidden = true; });
  $("#text-ok").addEventListener("click", () => { $("#texted").hidden = true; setEntries(parseText($("#list-text").value), "List updated"); });
  $("#btn-save").addEventListener("click", () => download(`cardforge-list-${new Date().toISOString().slice(0, 10)}.txt`, toText(entries), "text/plain"));
  $("#btn-clear").addEventListener("click", () => setEntries([], "List cleared"));

  // files: our .txt lists and 5e.tools pinned-list downloads
  async function readFiles(files) {
    const all = [];
    for (const f of files) {
      const text = await f.text();
      let t = text;
      if (/\.json$/i.test(f.name) || /^\s*[{[]/.test(text)) {
        let j = null;
        try { j = JSON.parse(text); } catch (e) { /* not json */ }
        t = j ? C.pinned_to_text(j) : null;
        if (!t) { toast(`${f.name} isn't a list from 5e.tools. Use “Download Pinned List” on a 5e.tools list page.`); continue; }
      }
      all.push(...parseText(t));
    }
    if (all.length) addEntries(all);
  }
  $("#btn-file").addEventListener("click", () => $("#file").click());
  $("#file").addEventListener("change", ev => { readFiles([...ev.target.files]); ev.target.value = ""; });
  const card = $("#listcard");
  let dragDepth = 0;
  card.addEventListener("dragenter", ev => { if ([...ev.dataTransfer.types].includes("Files")) { dragDepth++; card.classList.add("dragging"); ev.preventDefault(); } });
  card.addEventListener("dragover", ev => { if ([...ev.dataTransfer.types].includes("Files")) ev.preventDefault(); });
  card.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; card.classList.remove("dragging"); } });
  card.addEventListener("drop", ev => {
    ev.preventDefault(); dragDepth = 0; card.classList.remove("dragging");
    if (ev.dataTransfer.files.length) readFiles([...ev.dataTransfer.files]);
    else { const t = ev.dataTransfer.getData("text"); if (t) addEntries(parseText(t)); }
  });
  // pasting links anywhere outside a text box adds them
  document.addEventListener("paste", ev => {
    if (ev.target.closest && ev.target.closest("input, textarea, select")) return;
    const t = ev.clipboardData && ev.clipboardData.getData("text");
    if (t && /5e\.tools|\.html#/.test(t)) { ev.preventDefault(); addEntries(parseText(t)); }
  });

  // a list sent by the collector script: #import=<z|t><base64url>
  async function decodeImport(s) {
    const kind = s[0], b64 = s.slice(1).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    if (kind === "z") {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return await new Response(stream).text();
    }
    return new TextDecoder().decode(bytes);
  }
  async function checkImport() {
    const m = location.hash.match(/^#import=([^&]+)/);
    if (!m) return;
    history.replaceState(null, "", location.pathname + location.search);
    try {
      const list = parseText(await decodeImport(decodeURIComponent(m[1])));
      if (!list.length) { toast("The collector sent an empty list"); return; }
      setEntries(list, `Loaded ${list.length} ${list.length === 1 ? "entry" : "entries"} from the collector` + (undoEntries && undoEntries.length ? " (your previous list was replaced)" : ""));
    } catch (e) {
      toast("Couldn't read the list the collector sent. Try Export .txt in the collector and open that file here.");
    }
  }
  window.addEventListener("hashchange", checkImport);

  // ------------------------------------------------------------------ data downloads (cached in the browser for a week)
  // kept in IndexedDB, which (unlike the Cache API) also works when the site is served over plain http on a LAN
  const TTL = 7 * 864e5;
  const STORE = new Map();
  let preferred = LS.get("cf.base", null);
  const badBases = new Set();
  let dbp = null;
  const db = () => dbp || (dbp = new Promise(res => {
    try {
      const r = indexedDB.open("cardforge-data", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("files");
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    } catch (e) { res(null); }
  }));
  async function cacheMatch(url) {
    const d = await db();
    if (!d) return null;
    return new Promise(res => {
      try {
        const q = d.transaction("files").objectStore("files").get(url);
        q.onsuccess = () => res(q.result ? { text: q.result.text, fresh: Date.now() - q.result.time < TTL } : null);
        q.onerror = () => res(null);
      } catch (e) { res(null); }
    });
  }
  async function cachePut(url, text) {
    const d = await db();
    if (!d) return;
    try { d.transaction("files", "readwrite").objectStore("files").put({ text, time: Date.now() }, url); } catch (e) { /* storage full: skip */ }
  }
  async function cacheClear() {
    const d = await db();
    if (!d) return;
    await new Promise(res => { try { const t = d.transaction("files", "readwrite"); t.objectStore("files").clear(); t.oncomplete = t.onerror = () => res(); } catch (e) { res(); } });
  }
  const normBase = b => (b ? b.replace(/\/*$/, "/") : "");
  async function load(req) {
    let urls = req.urls.slice();
    const isData = req.key.startsWith("data:"), rel = isData ? req.key.slice(5) : "";
    if (isData) {
      const known = C.DATA_BASES.concat(urls.map(u => u.slice(0, u.length - rel.length)));
      if (preferred && known.includes(preferred)) urls = [preferred + rel].concat(urls.filter(u => u !== preferred + rel));
      if (S.data_base) urls.unshift(normBase(S.data_base) + rel);
      urls = [...new Set(urls)];
      urls = urls.filter(u => !badBases.has(u.slice(0, u.length - rel.length))).concat(urls.filter(u => badBases.has(u.slice(0, u.length - rel.length))));
    }
    let stale = null;
    for (const u of urls) {
      const c = await cacheMatch(u);
      if (c) { try { const v = JSON.parse(c.text); if (c.fresh) return { ok: true, value: v }; stale = stale || v; } catch (e) { /* bad cache entry */ } }
    }
    const errors = [];
    for (const u of urls) {
      try {
        const r = await fetch(u);
        if (!r.ok) { errors.push(`${u}: HTTP ${r.status}`); continue; }
        const text = await r.text();
        const value = JSON.parse(text);
        cachePut(u, text);
        if (isData) { preferred = u.slice(0, u.length - rel.length); LS.set("cf.base", preferred); }
        return { ok: true, value };
      } catch (e) {
        errors.push(`${u}: ${e.message || e}`);
        if (isData && e instanceof TypeError) badBases.add(u.slice(0, u.length - rel.length));   // blocked / offline
      }
    }
    if (stale) return { ok: true, value: stale };
    return { ok: false, errors };
  }
  $("#btn-forget").addEventListener("click", async () => {
    STORE.clear(); preferred = null; LS.set("cf.base", null); badBases.clear();
    await cacheClear();
    toast("Downloaded data cleared. The next cards fetch fresh copies.");
  });

  // ------------------------------------------------------------------ making cards
  let TEMPLATE = null;
  async function template() {
    if (TEMPLATE) return TEMPLATE;
    const r = await fetch("card_template.html", { cache: "no-cache" });
    if (!r.ok) throw new Error(`card_template.html: HTTP ${r.status}`);
    TEMPLATE = await r.text();
    return TEMPLATE;
  }
  function pageHtml(tpl, cards, extra) {
    const cfg = Object.assign({ paper: S.paper, duplex: S.duplex, minFont: S.min_font, gap: S.gap, backOffset: S.back_offset, images: S.images }, extra);
    const payload = JSON.stringify({ cards, cfg }).replace(/<\//g, "<\\/");
    const size = { letter: "8.5in 11in", a4: "210mm 297mm" }[S.paper];
    return tpl.replace("/*__DATA__*/null", () => payload).replace("__PAGESIZE__", () => size);
  }
  /** lay every card out once in an invisible frame to learn which formats it fits */
  function measure(cards, tpl) {
    return new Promise(resolve => {
      const f = el("iframe", { class: "measure-frame", "aria-hidden": "true", tabindex: "-1", title: "measuring" });
      let timer = null, poll = null;
      const done = v => { clearTimeout(timer); clearInterval(poll); f.remove(); resolve(v); };
      const read = () => {
        try {
          const n = f.contentDocument && f.contentDocument.getElementById("measure-result");
          if (!n) return false;
          const m = n.textContent.match(/@@RESULT@@([\s\S]*?)@@END@@/);
          done(m ? JSON.parse(m[1]) : null);
          return true;
        } catch (e) { done(null); return true; }
      };
      timer = setTimeout(() => done(null), 180000);
      f.addEventListener("load", () => { if (!read()) poll = setInterval(read, 250); });
      f.srcdoc = pageHtml(tpl, cards, { measure: true });
      document.body.append(f);
    });
  }

  const CAT_NAMES = { spell: "Spells", monster: "Creatures", item: "Items", feature: "Class features", other: "Everything else" };
  const BIG_LABEL = { fold: "folding card", "3x5": "3×5 index card", "5x8": "5×8 index card" };
  const FALLBACK = { fold: ["fold", "3x5", "5x8"], "3x5": ["3x5", "5x8", "fold"], "5x8": ["5x8", "fold"] };
  const IDX = f => f === "3x5" || f === "5x8";

  /** port of choose_big_formats() without the questions: returns what's settled and what needs a choice */
  function decide(cards, sizes) {
    const keep = [], notes = [], candidates = {};
    cards.forEach((c, i) => {
      c._i = i;
      const m = sizes ? sizes[i] : null, w = c.want;
      if (w) {
        if (!m) {
          c.order = { "card": ["fold", "3x5", "5x8"], "card-index": ["3x5", "5x8"], "3x5": ["3x5", "5x8"], "5x8": ["5x8"] }[w];
          c.noCard = IDX(w); keep.push(c); return;
        }
        const single = m.single || m.double;
        let pick = null, note = "";
        if (w === "card") {
          if (single) pick = "card";
          else if (m.fold) pick = "fold";
          else if (!c.isList) { pick = ["3x5", "5x8"].find(f => m[f]) || null; note = "too long for one folding card"; }
        } else if (w === "card-index") pick = single ? "card" : (["3x5", "5x8"].find(f => m[f]) || null);
        else if (w === "3x5") {
          if (c.isList) pick = m["3x5"] ? "3x5" : null;
          else { pick = ["3x5", "5x8"].find(f => m[f]) || null; note = pick === "5x8" ? "doesn't fit a 3×5 index card" : ""; }
        } else if (w === "5x8") pick = m["5x8"] ? "5x8" : null;
        if (pick === null && c.multiFmt) {
          const mf = c.multiFmt;
          c.order = [mf]; c.noCard = true; c.multi = true;
          notes.push(`${c.name}: continues over several ${BIG_LABEL[mf]}s.`);
          keep.push(c); return;
        }
        if (pick === null) { notes.push(`${c.name}: too long even for a 5×8 index card, so it was left out.`); return; }
        if (pick !== "card") { c.order = [pick]; c.noCard = IDX(pick); }
        if (note) notes.push(`${c.name}: ${note}, so it's on a ${BIG_LABEL[pick]}.`);
        keep.push(c); return;
      }
      if (!m) { c.order = FALLBACK[S["big_" + c.cat] === "each" ? "fold" : (S["big_" + c.cat] || "fold")]; keep.push(c); return; }
      if (m.single || m.double) keep.push(c);
      else if (m.fold) { (candidates[c.cat] = candidates[c.cat] || []).push({ c, fits: ["fold", "3x5", "5x8"].filter(f => m[f]) }); keep.push(c); }
      else if (m["3x5"] || m["5x8"]) {
        const f = m["3x5"] ? "3x5" : "5x8";
        c.order = [f]; keep.push(c);
        notes.push(`${c.name}: too long for one folding card, so it's on a ${BIG_LABEL[f]}.`);
      } else notes.push(`${c.name}: too long even for a 5×8 index card, so it was left out.`);
    });
    return { keep, notes, candidates };
  }

  function applyChoices(d, choices, each) {
    for (const [cat, lst] of Object.entries(d.candidates)) {
      const pick = choices[cat] || "fold";
      for (const { c, fits } of lst) {
        const want = pick === "each" ? (each.get(c) || fits[0]) : pick;
        const final = FALLBACK[want].find(f => fits.includes(f));
        if (final !== want) d.notes.push(`${c.name}: doesn't fit a ${BIG_LABEL[want]}, so it's on a ${BIG_LABEL[final]}.`);
        c.order = [final];
      }
      if (lst.length > 1 || pick !== "each") S["big_" + cat] = pick;
    }
    saveSettings(); showSettings();
  }

  // ------------------------------------------------------------------ folding cards
  function setFolded(card, folded) {
    card.classList.toggle("folded", folded);
    $(".fold", card).setAttribute("aria-expanded", String(!folded));
    if (card.id === "listcard") LS.set("cf.listFolded", folded);
  }
  for (const b of document.querySelectorAll(".icard .fold")) {
    b.addEventListener("click", () => { const card = b.closest(".icard"); setFolded(card, !card.classList.contains("folded")); });
  }
  if (LS.get("cf.listFolded", false)) setFolded($("#listcard"), true);

  // ------------------------------------------------------------------ result card
  const logBox = $("#log");
  function logLine(type, text) {
    const mark = { ok: "✓", warn: "!", error: "✗", busy: "◌", info: "·" }[type] || "";
    const n = el("div", { class: `line ${type}` }, el("span", { class: "mark", "aria-hidden": "true", text: mark }), el("span", { class: "t", text }));
    logBox.append(n);
    return n;
  }
  let busyLine = null;
  function busy(text) {
    if (!busyLine) busyLine = logLine("busy", text);
    else busyLine.querySelector(".t").textContent = text;
    $("#res-status").textContent = text;
  }
  function endBusy() { if (busyLine) busyLine.remove(); busyLine = null; }

  /** get the list's cards from 5e.tools, logging every entry; null (after explaining) when none could be made */
  async function buildCards() {
    busy(`Getting ${entries.length} ${entries.length === 1 ? "entry" : "entries"} from 5e.tools…`);
    const run = entries.slice();
    const { cards, log } = await C.build(toText(run), { load, store: STORE, images: S.images !== "off", onEntry: msg => { if (msg.startsWith("Downloading")) busy(msg); } });
    endBusy();
    status.clear();
    for (const x of log) {
      if (x.type === "ok") {
        const e = run[x.i];
        if (e) {
          status.set(e, { name: x.card.name });
          if (e.kind === "link") e.label = `${describe(e).kind}: ${x.card.name}`;
        }
        logLine("ok", x.text);
      } else if (x.type === "error") {
        const e = run[x.i];
        if (e) status.set(e, { error: x.reason });
        logLine("error", `${e ? describe(e).name : ""}: ${x.reason}`);
      } else logLine("warn", x.text);
    }
    saveList(); renderRows();
    if (!cards.length) {
      $("#res-status").textContent = "No cards could be made";
      logLine("info", "Check the links: they need to point at one entry, e.g. https://5e.tools/spells.html#fireball_xphb");
      if (log.some(x => x.type === "error" && /Could not download/.test(x.reason))) logLine("info", "The 5e.tools data couldn't be downloaded. Check your connection, or set a data source under More options.");
      return null;
    }
    return cards;
  }

  let running = false;
  /** kind "sheets": print sheets (Make cards); kind "images": one PNG per card (Make card images) */
  async function make(kind) {
    if (running) return;
    readSettings();
    if (!entries.length) { toast("Add some 5e.tools links first"); $("#btn-add").focus(); return; }
    running = true;
    const images = kind === "images";
    const btn = $(images ? "#btn-png" : "#btn-make"), label = btn.textContent;
    $("#btn-make").disabled = $("#btn-png").disabled = true;
    btn.textContent = images ? "Making card images…" : "Making cards…";
    const res = $("#result");
    $("#res-h .fold").textContent = images ? "Card images" : "Print sheets";
    res.hidden = false; setFolded(res, false); logBox.textContent = ""; $("#chooser").hidden = true; $("#outputs").hidden = true;
    $("#res-status").textContent = "";
    res.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    try {
      const tpl = await template();
      const cards = await buildCards();
      if (!cards) return;
      if (images) {
        busy(`Drawing ${cards.length} card image${cards.length === 1 ? "" : "s"}…`);
        const r = await drawImages(cards, tpl);
        endBusy();
        showImages(r);
        return;
      }
      busy("Measuring the cards…");
      const sizes = await measure(cards, tpl);
      endBusy();
      if (!sizes) logLine("warn", "Couldn't measure the cards in this browser; long entries will be sized when the print sheet opens.");
      const d = decide(cards, sizes);
      if (Object.keys(d.candidates).length) showChooser(d, tpl);
      else finish(d, tpl);
    } catch (e) {
      endBusy();
      if (location.protocol === "file:") logLine("error", "Card Forge has to be opened from a web address, not straight from a file. See the README for ways to host it (any web server works).");
      else logLine("error", `Something went wrong: ${e.message || e}`);
      $("#res-status").textContent = "Stopped";
    } finally {
      running = false; $("#btn-make").disabled = $("#btn-png").disabled = false; btn.textContent = label;
      updateHint();
    }
  }
  $("#btn-make").addEventListener("click", () => make("sheets"));
  $("#btn-png").addEventListener("click", () => make("images"));

  // ------------------------------------------------------------------ card images
  /** the card template draws every card as a PNG in an invisible frame -> {images: [{name, w, h, url} | {name, error}], notes} */
  function drawImages(cards, tpl) {
    return new Promise(resolve => {
      const f = el("iframe", { class: "measure-frame", "aria-hidden": "true", tabindex: "-1", title: "drawing" });
      let timer = null, poll = null;
      const done = v => { clearTimeout(timer); clearInterval(poll); f.remove(); resolve(v); };
      const read = () => {
        try {
          const r = f.contentWindow && f.contentWindow.CF_PNG;
          if (!r) return false;
          done(r);
          return true;
        } catch (e) { done(null); return true; }
      };
      timer = setTimeout(() => done(null), 300000);
      f.addEventListener("load", () => { if (!read()) poll = setInterval(read, 250); });
      f.srcdoc = pageHtml(tpl, cards, { png: true, pngScale: 3 });
      document.body.append(f);
    });
  }
  /** a card name as a file name that works everywhere (same rule as cardforge_png.py) */
  const safeName = n => String(n).replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 80) || "card";
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = u8 => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  /** a .zip of [{name, data: Uint8Array}], stored without compression (PNGs are compressed already) */
  function zip(files) {
    const enc = new TextEncoder(), now = new Date(), parts = [], central = [];
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), n = f.data.length;
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);   // 0x0800: UTF-8 name
      h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true);
      h.setUint32(18, n, true); h.setUint32(22, n, true); h.setUint16(26, name.length, true);
      parts.push(h, name, f.data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true);
      c.setUint32(20, n, true); c.setUint32(24, n, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
      central.push(c, name);
      off += 30 + name.length + n;
    }
    const size = central.reduce((a, x) => a + x.byteLength, 0), e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, size, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...central, e], { type: "application/zip" });
  }
  let imageUrls = [];
  function showImages(r) {
    const out = $("#outputs");
    out.textContent = "";
    imageUrls.forEach(u => URL.revokeObjectURL(u)); imageUrls = [];
    if (!r) { $("#res-status").textContent = "Stopped"; logLine("error", "This browser couldn't draw the card images. Try Chrome, Edge or Firefox."); return; }
    for (const n of r.notes || []) logLine("warn", n);
    for (const x of r.images || []) if (x.error) logLine("error", `${x.name}: ${x.error}`);
    const ok = (r.images || []).filter(x => x.url);
    if (!ok.length) { $("#res-status").textContent = "No images could be made"; return; }
    const pad = Math.max(2, String(ok.length).length);
    const files = ok.map((x, i) => ({
      name: `${String(i + 1).padStart(pad, "0")} ${safeName(x.name)}.png`, title: x.name, w: x.w, h: x.h,
      data: Uint8Array.from(atob(x.url.split(",")[1]), ch => ch.charCodeAt(0)),
    }));
    $("#res-status").textContent = `${files.length} card image${files.length === 1 ? "" : "s"} ready`;
    out.append(el("h3", { text: files.length === 1 ? "Your card image is ready" : "Your card images are ready" }));
    if (files.length > 1) {
      out.append(el("div", { class: "sheets" }, el("button", {
        type: "button", class: "btn", text: `Download all ${files.length} (.zip)`,
        onclick: () => download("cardforge-card-images.zip", zip(files), "application/zip"),
      })));
    }
    const gallery = el("div", { class: "gallery" });
    for (const f of files) {
      const url = URL.createObjectURL(new Blob([f.data], { type: "image/png" }));
      imageUrls.push(url);
      gallery.append(el("a", { href: url, download: f.name, class: "thumb", title: `Save ${f.name}` },
        el("img", { src: url, alt: f.title }), el("span", { text: `${f.title} · ${f.w} × ${f.h} px` })));
    }
    out.append(gallery, el("p", { class: "how", text: "Click a card to save it. Each image is the card's front at the size it needs (a standard card is 720 × 1008 px); long entries get extra columns instead of a second card." }));
    out.hidden = false;
    out.focus({ preventScroll: true });
  }

  function showChooser(d, tpl) {
    const box = $("#chooser");
    box.textContent = "";
    const total = Object.values(d.candidates).reduce((a, l) => a + l.length, 0);
    $("#res-status").textContent = "One question first";
    setFolded($("#result"), false);
    box.append(el("h3", { text: `${total} ${total === 1 ? "entry needs" : "entries need"} more than two card sides` }),
      el("p", { class: "note", text: "Choose what to print them on. Your choice is remembered for next time." }));
    const choices = {}, each = new Map();
    for (const cat of Object.keys(CAT_NAMES).filter(k => d.candidates[k])) {
      const lst = d.candidates[cat];
      const sel = el("select", { "aria-label": `Format for long ${CAT_NAMES[cat].toLowerCase()}` });
      for (const [v, t] of BIG_OPTS) if (v !== "each" || lst.length > 1) sel.append(el("option", { value: v, text: t === "Ask each time" ? "Choose for each" : t }));
      const saved = S["big_" + cat] || "fold";
      sel.value = saved === "each" && lst.length < 2 ? "fold" : saved;
      choices[cat] = sel.value;
      const eachBox = el("div", { class: "each" });
      for (const { c, fits } of lst) {
        const s = el("select", { "aria-label": `Format for ${c.name}` });
        for (const f of fits) s.append(el("option", { value: f, text: BIG_LABEL[f][0].toUpperCase() + BIG_LABEL[f].slice(1) }));
        each.set(c, fits[0]);
        s.addEventListener("change", () => each.set(c, s.value));
        eachBox.append(el("span", { text: c.name }), s);
      }
      const names = el("p", { class: "names", text: lst.map(x => x.c.name).join(", ") });
      const sync = () => { choices[cat] = sel.value; eachBox.hidden = sel.value !== "each"; names.hidden = sel.value === "each"; };
      sel.addEventListener("change", sync);
      box.append(el("div", { class: "cat" }, el("div", { class: "cat-head" }, el("strong", { text: CAT_NAMES[cat] }), sel), names, eachBox));
      sync();
    }
    const go = el("button", { type: "button", class: "btn", text: "Make the print sheets" });
    go.addEventListener("click", () => { box.hidden = true; applyChoices(d, choices, each); finish(d, tpl); });
    box.append(el("div", { class: "act" }, go));
    box.hidden = false;
    go.focus({ preventScroll: true });
  }

  function finish(d, tpl) {
    const cards = d.keep.sort((a, b) => a._i - b._i);
    const out = $("#outputs");
    out.textContent = "";
    if (!cards.length) { $("#res-status").textContent = "Nothing left to print"; out.append(el("p", { text: "Every entry was too long to print." }), el("ul", { class: "notes" }, d.notes.map(n => el("li", { text: n })))); out.hidden = false; return; }
    const orders = cards.map(c => (c.order || [null])[0]);
    const stock = S.index_stock && orders.some(IDX);
    let sections = [["main", ""]];
    if (stock) {
      if (orders.includes("3x5")) sections.push(["s35", "3x5"]);
      if (orders.includes("5x8")) sections.push(["s58", "5x8"]);
      if (orders.every(IDX)) sections = sections.filter(s => s[0] !== "main");
    }
    const halves = S.split ? [["fronts", "fronts"], ["backs", "backs"]] : [["", ""]];
    const jobs = [];
    for (const [sec, slabel] of sections) for (const [only, hlabel] of halves) {
      const what = sec === "main" ? "cards" : slabel === "3x5" ? "3×5 index cards" : "5×8 index cards";
      const label = `Print ${what}` + (hlabel ? ` (${hlabel})` : "");
      const pdfLabel = `Download ${what} PDF` + (hlabel ? ` (${hlabel})` : "");
      const file = `cardforge-${sec === "main" ? "cards" : slabel + "-index-cards"}${hlabel ? "-" + hlabel : ""}.html`;
      jobs.push({ label, pdfLabel, file, html: pageHtml(tpl, cards, { only, section: sec, stock }) });
    }
    const copies = cards.reduce((a, c) => a + (c.copies || 1), 0);
    $("#res-status").textContent = `${copies} ${copies === 1 ? "card" : "cards"} ready`;
    out.append(el("h3", { text: "Your print sheets are ready" }));
    const sheets = el("div", { class: "sheets" });
    for (const j of jobs) {
      const b = el("button", { type: "button", class: "btn", text: j.label });
      b.addEventListener("click", () => openHtml(j.html, j.file));
      j.group = el("div", { class: "job" }, b);
      sheets.append(j.group);
    }
    out.append(sheets);
    // the server can turn sheets into PDFs (the Card Forge container can; a plain static host can't)
    pdfAvailable().then(ok => {
      if (!ok) return;
      for (const j of jobs) {
        const b = el("button", { type: "button", class: "btn pdf", text: j.pdfLabel });
        b.addEventListener("click", () => downloadPdf(b, j));
        j.group.prepend(b);
        j.group.querySelector(".btn:not(.pdf)").classList.add("ghost");
      }
      sheets.after(el("p", { class: "how", text: "Download PDF gives you a ready-made PDF file; print it at 100% (Actual size)." }));
    });
    const how = S.split
      ? `Each sheet opens in a new tab; use Print there. Print the fronts, put the printed pages back in the tray turned over the ${S.duplex} edge, then print the backs.`
      : `Each sheet opens in a new tab; use Print there. Print double-sided, flipping on the ${S.duplex} edge.`;
    out.append(el("p", { class: "how", text: how }),
      el("p", { class: "how", text: "Set the scale to 100% (Actual size), margins to None, and turn on Background graphics. To keep a copy, choose Save as PDF as the printer." }));
    if (stock) out.append(el("p", { class: "how", text: "Index-card sheets print one card per page on 3×5 or 5×8 stock." }));
    if (d.notes.length) out.append(el("ul", { class: "notes" }, d.notes.map(n => el("li", { text: n }))));
    const dl = el("p", { class: "dl" }, "Want the files? ");
    jobs.forEach((j, i) => {
      const a = el("a", { href: "#", text: j.file });
      a.addEventListener("click", ev => { ev.preventDefault(); download(j.file, j.html, "text/html"); });
      dl.append(i ? ", " : "", a);
    });
    out.append(dl);
    out.hidden = false;
    out.focus({ preventScroll: true });
  }

  let pdfOk = null;
  async function pdfAvailable() {
    if (pdfOk !== null) return pdfOk;
    try {
      const r = await fetch("api/pdf", { cache: "no-store" });
      pdfOk = r.ok && (await r.json()).ok === true;
    } catch (e) { pdfOk = false; }
    return pdfOk;
  }
  async function downloadPdf(btn, job) {
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = "Making the PDF…";
    try {
      const r = await fetch("api/pdf", { method: "POST", headers: { "Content-Type": "text/html; charset=utf-8", "X-Filename": job.file }, body: job.html });
      if (!r.ok) throw new Error(r.status === 503 ? "the server is busy, try again in a minute" : (await r.text()).slice(0, 120) || `HTTP ${r.status}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = el("a", { href: url, download: job.file.replace(/\.html$/, ".pdf") });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      toast(`Couldn't make the PDF (${e.message || e}). Use ${job.label} and choose Save as PDF instead.`);
    } finally { btn.disabled = false; btn.textContent = label; }
  }

  function openHtml(html, name) {
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const w = window.open(url, "_blank");
    if (!w) { download(name, html, "text/html"); toast("Your browser blocked the new tab, so the sheet was downloaded instead. Open it and print."); }
    setTimeout(() => URL.revokeObjectURL(url), 600000);
  }
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = el("a", { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ------------------------------------------------------------------ printer alignment test
  $("#btn-calib").addEventListener("click", () => {
    readSettings();
    const [front, back] = C.calibration_pages(S.paper, S.duplex, S.back_offset);
    if (S.split) {
      openHtml(C.calibration_html(S.paper, S.duplex, S.back_offset, [front]), "cardforge-test-front.html");
      setTimeout(() => openHtml(C.calibration_html(S.paper, S.duplex, S.back_offset, [back]), "cardforge-test-back.html"), 300);
      toast("Two tabs opened: print the front, put the page back in the tray, then print the back.");
    } else openHtml(C.calibration_html(S.paper, S.duplex, S.back_offset, [front, back]), "cardforge-test.html");
  });
  $("#btn-readings").addEventListener("click", () => {
    const rx = parseFloat($("#read-x").value) || 0, ry = parseFloat($("#read-y").value) || 0;
    readSettings();
    S.back_offset = [Math.round((S.back_offset[0] + rx) * 100) / 100, Math.round((S.back_offset[1] + ry) * 100) / 100];
    saveSettings(); showSettings();
    $("#read-x").value = ""; $("#read-y").value = "";
    toast(`Backs now shift X ${C.fmt_mm(S.back_offset[0])} mm, Y ${C.fmt_mm(S.back_offset[1])} mm. Print the test page again: every scale should read 0.`);
  });

  // ------------------------------------------------------------------ bits
  let toastTimer = null;
  function toast(text, action = null, fn = null) {
    const t = $("#toast"), b = $("#toast-act");
    $("#toast-text").textContent = text;
    b.hidden = !action;
    b.textContent = action || "";
    b.onclick = () => { t.hidden = true; if (fn) fn(); };
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, action ? 9000 : 5500);
  }
  function updateHint() {
    const h = $("#go-hint");
    if (!entries.length) { h.textContent = "Add some entries to get started."; return; }
    h.textContent = S.split ? "You'll get separate fronts and backs sheets." : "You'll get one sheet to print double-sided.";
  }
  $("#settings").addEventListener("change", () => { readSettings(); updateHint(); });
  const addr = location.href.replace(/#.*$/, "");
  $("#site-addr").textContent = addr;
  $("#btn-copy-addr").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(addr); toast("Address copied"); } catch (e) { toast(addr); }
  });

  // ------------------------------------------------------------------ visitor count (sites with the site service)
  (async () => {
    try {   // each browser is counted once; later visits only read the number
      const first = !LS.get("cf.counted", false);
      const r = await fetch("api/visits", { method: first ? "POST" : "GET", cache: "no-store" });
      if (!r.ok) return;
      const n = (await r.json()).count;
      if (!Number.isFinite(n) || n < 1) return;
      if (first) LS.set("cf.counted", true);
      $("#visits").textContent = `${n.toLocaleString()} visitor${n === 1 ? "" : "s"}`;
      $("#visits").hidden = false;
    } catch (e) { /* a static host: no counter */ }
  })();

  showSettings();
  renderRows();
  checkImport();
})();
