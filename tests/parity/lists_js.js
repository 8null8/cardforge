const fs = require("fs"), path = require("path");
const C = require(path.join(__dirname, "../../web/core.js"));
const D = process.env.CF_DATA.replace(/\/*$/, "/"), B = process.env.CF_BREW ? process.env.CF_BREW.replace(/\/*$/, "/") : "";
const rd = p => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : undefined);
const local = { data: rel => rd(D + rel), brewIndex: () => (B ? rd(B + "_generated/index-sources.json") : {}), brewFile: path => rd(B + path) };
C.build(fs.readFileSync(process.argv[2], "utf8"), { local }).then(({ cards, log }) => {
  fs.writeFileSync(process.argv[3], JSON.stringify({ cards, errors: log.filter(x => x.type === "error").map(x => x.text.split("\n      ").pop()),
    warn: log.filter(x => x.type === "warn").map(x => x.text) }));
});
