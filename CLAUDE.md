# Card Forge - notes for maintainers

Card Forge turns 5e.tools entries into printable cards. Two front ends share one card builder:

- `index.html` + `web/app.js` / `web/app.css`: the website (static; runs entirely in the browser).
- `web/core.js`: card builder for the website. A line-for-line port of `cardforge.py`: same function names,
  same output. Python truthiness, `str()`, `.title()` etc. are emulated with the helpers at the top.
- `cardforge.py`: the offline tool (Python 3.8+, stdlib only; headless Chrome for measuring and PDFs).
- `card_template.html`: layout engine, styles and card backs, used unchanged by both.
- `5etools-card-list.user.js`: the Tampermonkey list collector. Bump `@version` on every change - installed
  copies update themselves from `https://cards.arcvein.org/5etools-card-list.user.js`.
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
- Every change the user asks for also goes into the offline tool where it applies (`cardforge.py`, and
  `card_template.html` / the collector, which ship with it), then gets released: bump `VERSION` in `cardforge.py`
  (1.8 -> 1.9 ...), commit, push `main`, write short user-facing release notes and run
  `bash tools/release.sh <version> <notes.md>` (tags `v<version>`, creates the GitHub release with
  `cardforge-offline-<version>.zip`, refreshes `../5e-cardforge.zip`). Website-only changes (page layout,
  `web/app.*`, `index.html`) have no offline counterpart: say so, and release only when the offline files changed.
