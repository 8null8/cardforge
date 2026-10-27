# Card Forge - notes for maintainers

Card Forge turns 5e.tools entries into printable cards. Two front ends share one card builder:

- `index.html` + `web/app.js` / `web/app.css`: the website (static; runs entirely in the browser).
- `web/core.js`: card builder for the website. A line-for-line port of `cardforge.py`: same function names,
  same output. Python truthiness, `str()`, `.title()` etc. are emulated with the helpers at the top.
- `cardforge.py`: the offline tool (Python 3.8+, stdlib only; headless Chrome for measuring and PDFs).
- `cardforge_png.py`: the second offline script, card images (one PNG per card, no back). It imports
  `cardforge.py` (`data_for`, `fetch_cards`, `Resolver`, `run_dom`, settings, questions) and only adds the drawing.
- `card_template.html`: layout engine, styles and card backs, used unchanged by both. Image mode (`cfg.png`)
  draws each card as a PNG in the browser (SVG foreignObject -> canvas) for the website's *Make card images*
  button and `cardforge_png.py` alike.
- `5etools-card-list.user.js`: the Tampermonkey list collector. Bump `@version` on every change - installed
  copies update themselves from `https://cards.arcvein.org/5etools-card-list.user.js`. It is also the browser
  extension (Chrome/Edge/Firefox): `python3 tools/build-extension.py` wraps it (GM_getValue/GM_setValue on the
  extension's storage) into `dist/cardforge-collector-{chrome,firefox}-<@version>.zip`; extension updates need a new
  upload to each store (`extension/PUBLISHING.md`). Keep it to GM_getValue/GM_setValue, or extend the wrapper.
- Quick add (search by name): `search_entries` / `search` exist in both `cardforge.py` and `web/core.js` and must
  give identical results; they read 5etools' `search/index.json` (+ `index-partnered.json`) from GitHub.
- `hosting/`: Proxmox LXC installer, nginx setup, the GitHub auto-update mode (`github-setup.sh`) and the
  PDF service (`pdf-service.py`: headless Chromium behind nginx at `/api/pdf`; the site only shows Download PDF
  when `GET api/pdf` answers `{"ok": true}`).

Rules:

- Any change to how cards are built goes into BOTH `cardforge.py` and `web/core.js`, then run
  `CF_DATA=<5etools-src>/data bash tests/parity/run_all.sh` - every card must stay identical.
- `main` is live: the user's container (cards.arcvein.org, Proxmox LXC 102) pulls it every hour. Test before
  pushing. Update now from the Proxmox host: `pct exec 102 -- /usr/local/bin/cardforge-update` (`pct exec`'s
  PATH has no /usr/local/bin, so the short name fails there).
- Keep README.md in step with user-visible changes.
- There are two Python scripts: keep BOTH up to date. A change to the cards, options or settings goes into
  `cardforge.py` and, where it applies to card images, `cardforge_png.py` too (e.g. a new card setting needs its
  question / flag in both); a change to `cardforge.py`'s helpers must not break `cardforge_png.py`. Test both
  scripts before releasing.
- Every change the user asks for also goes into the offline tool where it applies (`cardforge.py`,
  `cardforge_png.py`, and `card_template.html` / the collector, which ship with them), then gets released: bump
  `VERSION` in `cardforge.py` (1.9 -> 1.10 ...) and the `?v=` on the web/ files in `index.html` (so browsers and
  Cloudflare's 4-hour browser cache fetch the new ones), commit, push `main`, write short user-facing release notes and run
  `bash tools/release.sh <version> <notes.md>` (tags `v<version>`, creates the GitHub release with
  `cardforge-offline-<version>.zip`, refreshes `../5e-cardforge.zip`). Website-only changes (page layout,
  `web/app.*`, `index.html`) have no offline counterpart: say so, and release only when the offline files changed.
  When such a change touches `web/` files, still give their `?v=` in `index.html` a new value (e.g. 1.10 -> 1.10.1)
  so browsers fetch them; the next release sets it back to the plain version.
