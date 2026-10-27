# Publishing the list collector extension

The extension is the Tampermonkey collector (`5etools-card-list.user.js`) packaged for browser add-on stores.
Build both packages first:

```
python3 tools/build-extension.py
```

This makes `dist/cardforge-collector-chrome-<version>.zip` and `dist/cardforge-collector-firefox-<version>.zip`.
The version is the userscript's `@version`; every update needs a higher one (bump it, rebuild, upload).

## Decide first: public or link-only

A public listing advertises the extension, and with it your Card Forge site (the collector sends lists to
`https://cards.arcvein.org/` unless someone changes the address). Card text belongs to its publishers, and
store reviewers may question an add-on built around 5e.tools. Both stores also offer quieter options:

| | Public | Only people with the link |
|---|---|---|
| Chrome Web Store | *Public* | *Unlisted*: same review, not searchable |
| Firefox | *On this site* (listed on addons.mozilla.org, works on Android) | *On your own*: Mozilla signs the .xpi, you host it (e.g. on a GitHub release); automatic signing, usually within minutes |

## Chrome Web Store (also covers Chrome on any desktop; Edge can install from it too)

1. **Developer account:** go to <https://chrome.google.com/webstore/devconsole>, sign in with a Google account
   that has 2-Step Verification on, pay the one-time US$5 registration fee, and verify your contact email.
   You'll also be asked whether you're a *trader* (EU rules); for a free hobby project, *non-trader*.
2. **New item:** upload `dist/cardforge-collector-chrome-<version>.zip`.
3. **Store listing:**
   - *Description:* see the text at the end of this file.
   - *Category:* Tools. *Language:* English.
   - *Icon:* taken from the package (128 × 128).
   - *Screenshots:* at least one, 1280 × 800 or 640 × 400 PNG/JPEG. Open a spell on 5e.tools with the
     extension installed, click **🃏 Cards**, and take a screenshot showing the panel.
   - *Small promo tile* 440 × 280 (optional).
4. **Privacy practices tab:**
   - *Single purpose:* "Collects 5e.tools entries into a list and sends it to the Card Forge website to make
     printable cards."
   - *Permission justification:* **storage**: "Keeps the user's list and settings between pages and visits."
     **Host permission (5e.tools)**: "Adds the Add button and list panel to 5e.tools pages and reads which
     entry the page shows."
   - *Remote code:* No.
   - *Data usage:* tick nothing (no data is collected), then tick the three certifications.
   - *Privacy policy URL:* `https://github.com/8null8/cardforge/blob/main/PRIVACY.md`
5. **Distribution:** *Public* or *Unlisted*, all regions. **Submit for review.** Reviews usually take a few days;
   add-ons that run on a website can take longer.
6. **Updates:** bump `@version`, rebuild, then *Package > Upload new package* on the item and submit again.

## Firefox (addons.mozilla.org, desktop and Android)

1. **Account:** sign in at <https://addons.mozilla.org/developers/> with a free Mozilla account and accept the
   Firefox Add-on Distribution Agreement.
2. **Submit a New Add-on**, choose *On this site* (listed) or *On your own* (self-distributed), and upload
   `dist/cardforge-collector-firefox-<version>.zip`.
   - *Compatible platforms:* tick **Firefox** and **Firefox for Android** (the collector works on phones there).
   - *Source code:* "No". The code isn't minified or transpiled; `content.js` is the userscript with a small
     wrapper. If a reviewer asks, upload a zip of this repository.
3. **Listing** (listed only): name, summary (up to 250 characters; use the first paragraph below), description,
   category *Other*, a license (*All Rights Reserved* is allowed), and optionally screenshots and the privacy
   policy URL above.
4. **Review:** automatic checks sign it within minutes to hours; listed add-ons may get a human review later.
   For *On your own*, download the signed `.xpi` and put it on a GitHub release or your site; people install
   it by opening that link in Firefox.
5. The add-on ID is `card-forge-collector@arcvein.org` (in `tools/build-extension.py`). It can't change after the
   first upload, so change it before then if you'd like a different one.
6. **Updates:** bump `@version`, rebuild, *Upload New Version*.

## Microsoft Edge Add-ons (optional)

Free account at <https://partner.microsoft.com/dashboard/microsoftedge/>; upload the **Chrome** zip with the same
listing text. Edge users can also install straight from the Chrome Web Store.

## Listing text

> Collect spells, creatures, items and class features on 5e.tools into a list, then send it to Card Forge to make
> printable cards: playing-card size, folding cards or index cards, double- or single-sided.
>
> A 🃏 Cards button appears on 5e.tools. Open any entry and press + Add (or Alt+C); add whole filtered lists as one
> reference card, loot-generator results as a loot card, or class features with the 🃏+ buttons. Set copies and a
> card format per entry, then Send to Card Forge, or export the list as a .txt for the offline tool.
>
> Your list stays in your browser. Nothing is collected or tracked.
