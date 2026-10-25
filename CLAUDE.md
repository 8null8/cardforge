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
- `main` is live: the user's container (cards.arcvein.org) pulls it every hour. Test before pushing.
- Keep README.md in step with user-visible changes.
