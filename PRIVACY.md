# Card Forge privacy policy

Applies to the Card Forge website, the offline tools and the *Card Forge list collector* (browser extension and
Tampermonkey script).

**Card Forge collects no personal data.** There are no accounts, no analytics, no ads and no tracking.

- **Your list** (the 5e.tools entries you collect, their copies and formats) and your settings are stored only on
  your own device: in the browser's local storage, the extension's storage, or a file you save.
- **Send to Card Forge** opens the Card Forge website with your list in the address's `#` part, which browsers never
  send to a server; the website reads it in your browser.
- **Game data and pictures** are downloaded straight from 5e.tools and the 5etools mirror on GitHub
  (`raw.githubusercontent.com`) and kept in your browser for a week. Those sites see an ordinary request from your
  browser, as when you visit them.
- **Download PDF** (only on Card Forge sites that offer it) sends the print sheet to that site's server to be turned
  into a PDF. The sheet is kept only in memory while the PDF is made and is deleted as soon as it has been sent back.
- **The visitor count** at the bottom of a Card Forge site is a single number on its server. Your browser keeps a
  "counted" mark so it's only counted once; to stop the number being inflated, the server also remembers, in memory
  only and for a day, a scrambled (salted hash) form of the address that was counted. Nothing else is stored.
- Like any web server, a Card Forge site's server keeps ordinary access logs (the visitor's IP address, the time and
  the page requested). They are not shared or used for anything else.
- The browser extension asks for one permission, *storage*, to keep your list, and only runs on 5e.tools.

Questions: open an issue at https://github.com/8null8/cardforge/issues.
