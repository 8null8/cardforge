#!/usr/bin/env python3
"""
Card Forge card images: one PNG per card instead of print sheets, for virtual tabletops, phones and chat.

Each image is the card's front at whatever size the entry needs (no back, nothing split over several cards);
long entries get a second or third column and a wider image instead of a very tall one.

  python cardforge_png.py list.txt
  python cardforge_png.py "https://5e.tools/bestiary.html#goblin%20warrior_xmm" --images on

Needs cardforge.py next to it (it builds the cards) and Chrome, Edge, Chromium or Brave (it draws them).
"""
import argparse
import base64
import html
import json
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cardforge as cf  # noqa: E402


def safe_name(name):
    """A card name as a file name that works on Windows, macOS and Linux."""
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", str(name))
    s = re.sub(r"[. ]+$", "", re.sub(r"\s+", " ", s).strip())
    return s[:80] or "card"


def ask_images(a):
    """Pictures on creature and item cards: from --images, else asked (and remembered), else the last answer."""
    if a.images:
        return a.images == "on"
    saved = cf.load_settings().get("png_images", "off")
    if not a.no_ask and sys.stdin is not None and sys.stdin.isatty():
        print("\nImage settings (* = current choice, press Enter to keep it):")
        saved = cf.ask("Pictures on creature and item cards?",
                       [("n", "off", "No pictures"), ("y", "on", "Yes, under the title")], saved)
        cf.save_settings({"png_images": saved})
        print()
    return saved == "on"


def draw(cards, browser, pictures, scale):
    """The card template draws every card in the browser; returns {"images": [{name, w, h, url} | {name, error}], "notes"}."""
    cfg = {"png": True, "images": "front" if pictures else "off", "pngScale": scale, "minFont": 6.5, "gap": 0}
    payload = json.dumps({"cards": cards, "cfg": cfg}, ensure_ascii=False).replace("</", "<\\/")
    page = cf.TEMPLATE.read_text(encoding="utf-8").replace("/*__DATA__*/null", payload).replace("__PAGESIZE__", "auto")
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "card-images.html"
        path.write_text(page, encoding="utf-8")
        try:   # wait until the page has drawn every card (pictures and all)
            with cf.Chrome(browser) as c:
                tab = c.open(path.resolve().as_uri())
                c.wait_for(tab, "!!window.CF_PNG", 300)
                return json.loads(c.evaluate(tab, "JSON.stringify(window.CF_PNG)"))
        except Exception as e:
            cf.warn(f"drawing through the browser's DevTools didn't work ({e}); trying its simple mode")
        dom = cf.run_dom(path, browser)
    m = re.search(r"@@PNG@@(.*?)@@END@@", dom, re.S)
    return json.loads(html.unescape(m.group(1))) if m else None


def main(argv=None):
    ap = argparse.ArgumentParser(description="Card Forge: make one PNG image per card (no back, sized to fit).")
    ap.add_argument("inputs", nargs="*", help="5e.tools links and/or .txt list files")
    ap.add_argument("-o", "--out", help="folder for the images. Default: <list>-images next to the list, or ./card-images")
    ap.add_argument("--images", choices=["on", "off"], help="pictures on creature and item cards (asked if not given)")
    ap.add_argument("--scale", type=float, default=3,
                    help="pixels per CSS pixel, 1-6 (default 3: 288 dpi, a standard card is 720 px wide)")
    ap.add_argument("--no-ask", action="store_true", help="never ask questions; use saved/default settings")
    ap.add_argument("--data-dir", help="use a local copy of the 5etools 'data' folder instead of downloading")
    ap.add_argument("--brew-dir", action="append",
                    help="local copy of the homebrew or unearthed-arcana repository (can be given twice)")
    ap.add_argument("--refresh", action="store_true", help="ignore the download cache")
    ap.add_argument("--open", action="store_true", help="open the folder when done")
    a = ap.parse_args(argv)

    inputs, pausing = a.inputs, False
    if not inputs:
        inputs, pausing = cf.interactive(lambda: cf.Data(a.data_dir, a.refresh, brew_dirs=a.brew_dir)), True
        if not inputs:
            return 1
    pictures = ask_images(a)
    links = cf.read_inputs(inputs)
    if not links:
        print("No links found.")
        return 1
    browser = cf.find_browser()
    if not browser:
        print("Drawing the images needs Chrome, Edge, Chromium or Brave, and none was found.")
        return 1

    first_txt = next((Path(x) for x in inputs if x.lower().endswith(".txt") and Path(x).exists()), None)
    out = Path(a.out) if a.out else (first_txt.with_name(first_txt.stem + "-images") if first_txt else Path.cwd() / "card-images")

    data = cf.data_for(links, a.data_dir, a.refresh, a.brew_dir)
    cards = cf.fetch_cards(links, cf.Resolver(data, images=pictures))
    if not cards:
        print("Nothing to make.")
        return 1

    print("Drawing the cards...")
    result = draw(cards, browser, pictures, a.scale)
    if result is None:
        print("The browser couldn't draw the cards.")
        return 1
    for n in result.get("notes") or []:
        cf.warn(n)
    images = [x for x in result.get("images") or [] if x.get("url")]
    for x in result.get("images") or []:
        if x.get("error"):
            cf.warn(f"{x['name']}: {x['error']}")
    if not images:
        print("No images could be made.")
        return 1

    out.mkdir(parents=True, exist_ok=True)
    pad = max(2, len(str(len(images))))
    print()
    for i, x in enumerate(images, 1):
        path = out / f"{i:0{pad}d} {safe_name(x['name'])}.png"
        path.write_bytes(base64.b64decode(x["url"].split(",", 1)[1]))
        print(f"Saved {path.name}  ({x['w']} x {x['h']} px)")
    print(f"\n{len(images)} image{'' if len(images) == 1 else 's'} in {out}")
    if a.open or pausing:
        cf.open_file(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
