const fs = require("fs"), path = require("path");
const C = require(path.join(__dirname, "../../web/core.js"));
const D = process.env.CF_DATA.replace(/\/*$/, "/"), B = process.env.CF_BREW ? process.env.CF_BREW.replace(/\/*$/, "/") : "";
const cache = {};
const rd = p => { if (!(p in cache)) cache[p] = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : undefined; return cache[p]; };
const local = { data: rel => rd(D + rel), brewIndex: () => (B ? rd(B + "_generated/index-sources.json") : {}), brewFile: path => rd(B + path) };
const data = new C.Data({ local });
const res = new C.Resolver(data);
const out = [];
for (const u of fs.readFileSync(process.argv[2], "utf8").split("\n")) {
  C.clearWarnings();
  let r;
  try { r = { url: u, card: res.resolve(u) }; }
  catch (e) { r = { url: u, error: `${e.constructor.name}: ${e.message}` }; }
  r.warn = C.warnings();
  out.push(JSON.stringify(r));
}
fs.writeFileSync(process.argv[3], out.join("\n") + "\n");
