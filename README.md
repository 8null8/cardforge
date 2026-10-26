# Card Forge

Turns 5e.tools entries (spells, items, creatures, class features, feats, conditions and more) into printable
playing cards. It comes two ways that make exactly the same cards:

* **The website** (`index.html`): host it once and anyone opens it in a browser next to 5e.tools.
  Nothing to install, works on phones and tablets too. *Start here.*
* **The offline tool** (`cardforge.py`): the same thing as a Python program for Windows and Linux.
  It writes PDFs directly and works from a local copy of the data.

What you get:

* **Fits on one side** → a normal poker-size card (2.5" × 3.5") with a decorative back
  showing the spell level and school, the item's rarity and type, or the creature's CR.
* **Needs two sides** → a normal card with the rest of the text on the back.
* **Needs more** → a double-wide **foldable** card (5" × 3.5"): stats and the start of the text on
  the front, the rest inside and on the back. Very long entries get extra fold cards.

**Index cards instead of folding cards:** for anything too long for a single card you choose
(per category: spells, items, creatures, class features, everything else, or "ask for each") a folding card,
a **3×5** or a **5×8** index card. If something is too long for one folding card it automatically moves
to the smallest index card that fits; if it doesn't even fit a 5×8 card (front and back) it is skipped
and listed. Index cards can be cut from regular paper or printed straight onto index-card stock.

All playing cards share one 3×3 grid per sheet: a foldable card simply takes two side-by-side spots,
and gaps are filled with the next regular card, so no paper is wasted.

## The website

1. **Collect your picks on 5e.tools**, any of three ways:
   * copy entry links from 5e.tools and paste them into Card Forge (or just press Ctrl+V on the page);
   * on a 5e.tools list page, pin entries and use **Download Pinned List**, then open that file in Card Forge
     (or drop it on the list);
   * install the **list collector** (below) and press **Send to Card Forge**: the site opens with your list loaded.
2. **Check the list:** copies and a format per entry (Auto, Card, Card else index card, 3×5, 5×8),
   **Edit as text** for bulk changes, **Save list** to keep a `.txt` (it also works with the offline tool).
   Click the **Your cards** title to fold a long list down to its title bar (the site remembers it); the
   **Print sheets** progress log folds the same way and opens again when you make cards. The finished sheets
   (*Your print sheets are ready* and below) get their own card that always stays open.
3. **Printing settings** (remembered in your browser): paper size, double- or single-sided printer, which edge
   the paper flips on, what long entries go on, index cards on paper or card stock, and the back-side offset.
4. **Make cards.** The site fetches each entry, measures the cards, asks once if some entries need more than
   two sides, and gives you print sheets (one, or fronts and backs for a single-sided printer). Each opens in a
   new tab; print it there, or choose *Save as PDF* to keep a copy. When the site runs on a Card Forge container
   there's also **Download PDF**: the server prints the sheet to a PDF file for you (same engine as the
   offline tool), ready to print at 100%.

The site downloads the game data from 5e.tools itself (or its GitHub copy when 5e.tools won't hand it to other
sites) and keeps it in the browser for a week, so repeat runs are instant. Partnered books (e.g. *Book of Ebon
Tides*), homebrew and Unearthed Arcana load automatically. If none of that is reachable, point
**More options → Data source** at a 5etools mirror's `data/` folder.

### Hosting the website

It's a plain static site (`index.html`, `card_template.html`, the `web/` folder and the collector script);
any web server works. It must be opened through a web address: double-clicking `index.html` won't work,
because browsers don't let a page loaded from a file read its neighbouring files.

**Proxmox (new LXC container), kept up to date from GitHub.** In the Proxmox host shell:
```
bash -c "$(curl -fsSL https://raw.githubusercontent.com/8null8/cardforge/main/hosting/proxmox-install.sh)"
```
Answer the questions (Enter accepts the default: 1 core, 1 GB memory, 4 GB disk, DHCP). It creates an unprivileged
Debian container that starts on boot, installs nginx, clones this repository and prints the address, e.g.
`http://192.168.1.50/`. From then on the container checks GitHub every hour and updates the site when something
changed. To update straight away: `pct exec <container id> -- /usr/local/bin/cardforge-update`
(`journalctl -u cardforge-update` inside the container shows what the hourly checks did).

* **Already have a Card Forge container** (made from the zip)? Switch it to GitHub updates:
  `pct exec <container id> -- bash -c "$(curl -fsSL https://raw.githubusercontent.com/8null8/cardforge/main/hosting/github-setup.sh)"`
* **Private repository:** create a fine-grained GitHub token with read-only *Contents* access to it and put
  `CF_TOKEN=<token>` in front of the command (for the first one: `CF_TOKEN=<token> bash -c "$(curl -fsSL -H "Authorization: token <token>" …)"`).
* **Without GitHub:** copy the unzipped Card Forge folder to the host, run `bash hosting/proxmox-install.sh` there
  and answer *n* to the GitHub question; update later with `bash hosting/proxmox-install.sh update <container id>`.

**Any Debian/Ubuntu machine** (a VM, a Raspberry Pi, an existing container):
`sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/8null8/cardforge/main/hosting/github-setup.sh)"`
for the self-updating GitHub version (`PORT=8080` in front for another port), or `sudo bash hosting/container-setup.sh`
from an unzipped folder (run it again after unzipping a newer version).

**A public address through Cloudflare** (no port forwarding): install `cloudflared` in the container and add a
Cloudflare Tunnel route from your hostname (e.g. `cards.example.org`) to `http://localhost:80`.

**GitHub Pages (free, public address).** Create a repository, upload `index.html`, `card_template.html`,
`5etools-card-list.user.js` and the `web/` folder, then *Settings → Pages → Deploy from a branch*.
Netlify, Cloudflare Pages or any other static host work the same way.

**Just trying it on your PC:** in the Card Forge folder run `python -m http.server 8000` and open
`http://localhost:8000/`.

The collector script updates itself from `https://cards.arcvein.org/5etools-card-list.user.js` (its `@updateURL`)
and sends lists there by default; change both at the top of the script if you host Card Forge somewhere else.

**PDF downloads** come from a small service in the container (`hosting/pdf-service.py`, installed by the setup
scripts together with Chromium, about 400 MB). Give the container at least 1 GB of memory
(`pct set <ID> --memory 1024`). It only listens inside the container; nginx forwards `/api/pdf` to it, and pages are
rendered with all network access blocked. `PDF=0` in front of the setup command leaves it out. On static hosts
(GitHub Pages, Cloudflare Pages) there's no server, so the site simply doesn't show the button.

Good to know: apart from PDF downloads, the server only hands out these files. Every visitor's list, settings and downloaded data stay in
their own browser. Card text belongs to its publishers, so keep a public copy for your group rather than
advertising it.

## The list collector (Tampermonkey, optional)

1. Install the **Tampermonkey** browser extension.
2. On your Card Forge site click **Install the collector** (bottom of the page); Tampermonkey shows its install
   page. Without the site: open `5etools-card-list.user.js`, copy it into a new Tampermonkey script and save.
3. On 5e.tools a **🃏 Cards** button appears bottom-right. Open any spell/item/creature and press
   **+ Add** (or **Alt+C**). Use **+ / −** for copies, then **Send to Card Forge**: the website opens with the
   list loaded. The first time, it asks for your Card Forge address (shown at the bottom of the Card Forge page);
   **change** under the list sets a new one. **Export .txt** saves the list as a file instead (for the offline
   tool, or to open on the site later); **Import .txt** loads one back in so you can keep editing it.
   Each entry has a **format** drop-down, and **New entries** sets the default (Card unless you change it;
   **Apply to all** switches the whole list):

   | Format | What you get |
   |---|---|
   | **Card** | a normal card; two-sided if needed, then a folding card if it still doesn't fit |
   | **Card, else index** | a normal card (one or two sides); if it doesn't fit, the smallest index card that does |
   | **3×5 index card** | always a 3×5 index card (moves up to 5×8 if it doesn't fit) |
   | **5×8 index card** | always a 5×8 index card |
4. **Whole lists:** on Spells, Items, Bestiary, Feats and the other list pages, filter or search the list as usual
   (or pin entries with the site's **p** key). The panel then shows:
   * **📋 As one list card** — one reference card listing every entry with its key details and no descriptions
     (you're asked for a title; the active filters are filled in for you). Long lists carry on over several
     cards of the chosen format: two-sided, then folding cards, or a run of index cards.
   * **➕ Add all as cards** — every entry becomes its own normal card (entries already in your list are skipped).

   | List of | Columns on the list card |
   |---|---|
   | Spells | Name (R = ritual), level, casting time, school, C = concentration, range |
   | Creatures | Name, CR, type, AC, HP |
   | Items | Name, type, rarity, attunement (cost and weight for mundane gear) |
   | Feats / Other features | Name, category or type, prerequisite |
   | Species / Backgrounds / Deities / Conditions | Name plus size and speed / skills / pantheon, alignment, domains / type |
5. **Generated loot:** on the Loot Generator page every rolled result gets two buttons (the panel has the same two
   for the newest result):
   * **🃏 Loot card** — the whole result on one card: coins, gemstones and art objects (with their values),
     dragon-hoard trinkets, and a table of the magic items with type, rarity and attunement.
   * **➕ Items** — each item as its own card. Coins, gems and art objects are left out; a spell scroll adds the
     rolled spell as a **spell scroll card** (see below); an item rolled twice gets two copies.
6. **Spell scrolls:** on a spell's page the panel has **📜 Add as a spell scroll**. A scroll card is easy to tell
   apart from the plain spell: brown instead of the spell colour, a dashed banner under the title with
   *Spell Scroll · rarity · save DC · attack bonus* (from the scroll table for that spell level), a line on how the
   scroll is used, and a back that says **SPELL SCROLL** with the spell level in the medallion. Scrolls from the loot
   generator come out as scroll cards automatically.
7. **Class features:** on a class page every class and subclass feature heading gets a small **🃏+** button
   — subclass features included (pick the subclass at the top of the page to show its features).
   Feature cards show the class and level on the front, and the back is coloured per class with the level in the middle.
   You can also paste the link 5e.tools copies when you click a class feature's title.

## The offline tool (Python)

Needs only Python 3.8+ (no extra packages). Works on Windows and Linux. Download `cardforge-offline-<version>.zip`
from the [Releases page](https://github.com/8null8/cardforge/releases/latest) and unzip it anywhere.


* **Windows:** drag the exported `.txt` onto `make_cards.bat` (or double-click it and paste links).
* **Linux:** `./make_cards.sh cardforge-list-2026-10-23.txt`
Each time it runs it asks three quick questions: **paper size**, **double- or single-sided printer**,
and **which edge the paper flips on** — plus, when some entries are long, how to print those
(folding card, 3×5 or 5×8 index card) and how you'll print index cards. Your answers are remembered, so next time you can just press
Enter to keep them.
* Or directly: `python cardforge.py list.txt` / `python cardforge.py "https://5e.tools/spells.html#fireball_phb"`

You get `<list>-cards.html`, plus `<list>-cards.pdf` when Chrome, Edge, Chromium or Brave is installed.

Options (only needed if you want to skip the questions, e.g. in a script):

| Option | What it does |
|---|---|
| `--split` / `--double` | single-sided printer (separate `-fronts.pdf` and `-backs.pdf`) / double-sided |
| `--paper letter` / `a4` | paper size |
| `--duplex long` / `short` | which edge the paper flips on |
| `--big fold` / `3x5` / `5x8` | format for long entries, all categories (spells, items, monsters, class features, other) |
| `--index-on paper` / `stock` | cut index cards from paper, or print on index-card stock |
| `--no-ask` | don't ask anything; use your last answers |
| `--min-font 7` | smallest text size before a card grows to two sides / foldable (default 6.5pt) |
| `--gap 0.1` | add white space between cards (inches); default 0 = single cuts |
| `-o name` | output file name |
| `--data-dir path` | use a local copy of the 5etools `data` folder (offline) |
| `--refresh` | ignore the 7-day download cache |
| `--calibrate` | print a test page to measure how far your printer shifts the back side |
| `--back-offset X,Y` | shift every back by X,Y mm to match your printer (remembered; `0,0` resets) |
| `--brew-dir path` | local copy of the homebrew / unearthed-arcana repository (offline use) |

## Printing

Print **double-sided** at **100% / actual size**, **margins: none**, **background graphics: on**.
Each front sheet is followed by its back sheet, already mirrored so the backs line up.
Cards touch each other with no white space, and grey cut lines run all the way to the paper edge, so
you can cut a whole row or column in one stroke (a paper trimmer works great: cut the rows first, then
the cards in each row). Double-wide cards have no cut line through their middle; fold them on the dashed line.
If your printer's back side drifts a little, set *Space between cards* to 0.1 (website: More options; offline tool:
`--gap 0.1`) to get a small white border between cards again.

**Single-sided printer:** print the fronts sheet (`…-fronts.pdf` from the offline tool), put the printed stack back in the paper
tray flipped over its long edge, then print the backs sheet. Do one test sheet first to learn which way
your printer wants the pages facing; if the stack comes out in reverse order, tick "reverse order" in the
print dialog for the backs.

If your backs come out upside down, make the cards again with the other flip edge.

## Lining up fronts and backs

The PDFs are laid out so every back sits exactly behind its front (checked to within 0.1 mm for Letter and A4,
long- and short-edge flipping). Most home printers still land the second side 0.5–2 mm off, so measure yours once:

1. Website: **Printing → Lining up the back side → Print the test page**. Offline tool: run `calibrate_printer.bat`
   (Windows) or `./calibrate_printer.sh` (Linux), or `python cardforge.py --calibrate`.
2. Print the test page exactly like your cards (double-sided, or fronts then backs; **100% / Actual size**).
3. Hold the back side up to a light. Read where the front's black lines cross the red **X** and **Y** scales
   in the middle of the page (ticks every 0.5 mm). Website: enter them under *I have readings from the test page*
   and press **Add to the offset**. Offline tool: type them in when asked.
4. Print the test page again: every scale should now read 0.

The correction is remembered and applied to every back from then on (the X/Y boxes on the website; for the
offline tool `--back-offset X,Y` sets it by hand and `--back-offset 0,0` turns it off). If the left and right readings differ, the page is being scaled by the print
dialog — switch it to 100% / Actual size.

## List file format

One link per line. `#` starts a comment. Copies: `3x <link>` or `<link> x3`.
A list card is a block (the userscript writes these too):

```
[list] Wizard 1st-Level Spells [card]   # 1st level · Wizard
https://5e.tools/spells.html#burning%20hands_xphb
https://5e.tools/spells.html#charm%20person_xphb
[end list]
```

A loot card is a block too:

```
[loot] Ancient Dragon's Hoard [card]   # 635,005 gp in coins, gems and art
coins: 170,000 GP
gems: 50 GP gemstones ×3 (150 GP): Sardonyx, Citrine, Quartz
art: 25 GP art objects ×2 (50 GP): Silver ewer ×2
other: A large, noisy wind chime
item: https://5e.tools/items.html#oil%20of%20sharpness_xdmg   # Oil of Sharpness
[end loot]
```

A format in square brackets after the link overrides the questions for that entry:
`[card]`, `[card/index]`, `[3x5]` or `[5x8]` (the userscript writes these for you). Lines without one use the
answers to the "too long for one card" questions.

```
https://5e.tools/spells.html#fireball_phb      # Spell: Fireball
2x https://5e.tools/items.html#potion%20of%20healing_dmg
https://5e.tools/spells.html#wish_xphb [card/index]
```

In a hand-written list, mark a spell link as a scroll by adding `,cardforge:scroll~` to the end of it
(optionally followed by the scroll item, e.g. `,cardforge:scroll~spell%20scroll%20(3rd%20level)_dmg`).

## Supported pages

spells, items (including generated ones like `+1 Longsword`), bestiary, **class and subclass features**,
feats, backgrounds, races/species,
conditions & diseases, optional features (invocations, metamagic…), rewards, traps & hazards, objects,
languages, deities, actions, variant rules, psionics, cults & boons, senses, skills, decks.

## Partnered books, homebrew and Unearthed Arcana

Content that 5e.tools loads on top of the official books — partnered books such as *Book of Ebon Tides*,
homebrew you've loaded, and prerelease/Unearthed Arcana — comes from separate repositories
([homebrew](https://github.com/TheGiddyLimit/homebrew), [unearthed-arcana](https://github.com/TheGiddyLimit/unearthed-arcana)).
When a link's source isn't an official book, Card Forge looks it up there automatically (and caches it like the rest).
With the offline tool you can also point it at local copies with `--brew-dir path/to/homebrew` (repeatable).

## Troubleshooting

* **"Could not download …"** – Card Forge reads the same JSON files the 5e.tools site uses, trying
  5e.tools first and then the GitHub mirror. If both are blocked on your network, use a copy of the 5etools
  source's `data` folder: on the website put its web address under *More options → Data source*; with the
  offline tool use `--data-dir path/to/data`.
* **The website says it has to be opened from a web address** – you opened `index.html` straight from the
  folder. Host it (see *Hosting the website*) or run `python -m http.server 8000` in the folder and open
  `http://localhost:8000/`.
* **Send to Card Forge opens the wrong address** – click **change** under the list in the collector.
* **No PDF** – without Chrome/Edge the tool can't measure cards ahead of time, so it asks per category
  and lists any skipped entries in the bar at the top of the HTML page instead of the terminal.
  Open the `.html` file in your browser and print it with the settings above.
* **A ✂ in a card's footer** – a table was too tall for one panel and got cut off; try `--min-font 6`.

## Creature cards

Every stat (AC, Initiative for 2024 creatures, HP, Speed, each ability score, saves, skills, senses…) and every
trait and action sits in its own outlined, lightly shaded box. The layout keeps those boxes in one piece: an
action that would run from the front onto the back moves to the next side whole instead. When there's room, a whole
section (Traits, Actions, Bonus Actions, Reactions, Legendary Actions) moves to the next side rather than being cut
in half, leaving some white space. The two inside halves of a folding card are read together, so a section may
run across them. The text gets at most 1pt smaller to make this work. If it would need more than that, or a box
is longer than a whole side, the box is split and its edges are dashed where it carries on.

## Card backs

Cards whose text fits on the front get a decorative back. Playing cards show the type and a medallion with the
spell level (0 for cantrips), creature CR, class-feature level, or an icon for items and other entries.
The line under the medallion (a creature's size and type, a loot or list title…) wraps onto a second line when
it's long and is cut short with "…" if two lines aren't enough.
Index cards get their own landscape back: the same medallion on the left and a title plate on the right with the
type, the entry's **name** and its school / size and type / rarity, so they're easy to find in a card box.

## Colours

Spells all use one colour (`SPELL_COLOR` near the top of the spell section in `cardforge.py`), items are coloured by
rarity, creatures are dark red, spell scrolls are brown (`SCROLL_COLOR`), and class features use one colour per class.

## For developers

* `cardforge.py` (offline tool) and `web/core.js` (website) are the same card builder in two languages, kept
  line-for-line alike. Change one, change the other the same way.
* `card_template.html` holds the card layout engine, styles and card backs; both versions use it unchanged.
* `tests/parity/run_all.sh` builds about 17,000 entries with both and checks they come out identical:
  `CF_DATA=/path/to/5etools-src/data bash tests/parity/run_all.sh` (data from
  `git clone --depth 1 https://github.com/5etools-mirror-3/5etools-src`).
* Pushing to `main` is a release: Card Forge containers pick it up within the hour.
