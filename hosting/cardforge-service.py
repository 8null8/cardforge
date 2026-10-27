#!/usr/bin/env python3
"""
Card Forge site service: the website's two server-side extras. nginx forwards /api/pdf and /api/visits to it;
it only listens on 127.0.0.1. The site works without it (on a static host it simply hides both).

  GET  /api/pdf     -> {"ok": true} when Chromium is installed (the website then shows "Download PDF")
  POST /api/pdf     body = the sheet's HTML, header X-Filename = name for the download -> application/pdf
  GET  /api/visits  -> {"count": n}, the visitor count shown at the bottom of the site
  POST /api/visits  -> counts a new visitor (the site sends this once per browser), {"count": n}

PDFs are printed like the offline tool does (cardforge.py next to this file: wait for the pictures, then print),
one at a time, with all network access blocked except for the 5etools picture mirror on GitHub.
The visitor count is a single number in /var/lib/cardforge/visits.json. Nothing about visitors is stored; to stop
a reload loop from inflating it, each address counts at most once a day (kept in memory only, as a salted hash).
"""
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import cardforge   # installed next to this file
except Exception:   # older install: print with Chromium's plain --print-to-pdf
    cardforge = None

PORT = int(os.environ.get("CF_PORT") or os.environ.get("CF_PDF_PORT") or "8090")
STATE = os.environ.get("CF_STATE_DIR", "/var/lib/cardforge")
MAX_BYTES = 40 * 1024 * 1024
BUSY = threading.Semaphore(1)
JOBS = {}
# everything except this service (on loopback) and the picture mirror goes to a dead proxy
CHROME_ARGS = ["--disable-extensions", "--disable-background-networking",
               "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=raw.githubusercontent.com"]


def chromium():
    if os.environ.get("CF_NO_PDF"):   # installed with PDF=0
        return None
    for name in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable"):
        path = shutil.which(name)
        if path:
            return path
    return None


def render(html: bytes) -> bytes:
    token = secrets.token_urlsafe(18)
    JOBS[token] = html
    url = f"http://127.0.0.1:{PORT}/job/{token}"
    try:
        with tempfile.TemporaryDirectory() as td:
            if cardforge:
                try:
                    return cardforge.print_page(chromium(), url, CHROME_ARGS, env=dict(os.environ, HOME=td))
                except Exception as e:
                    print(f"DevTools printing failed ({e}); using --print-to-pdf", flush=True)
            out = os.path.join(td, "sheet.pdf")
            cmd = [chromium(), "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                   "--no-pdf-header-footer", "--print-to-pdf-no-header", "--virtual-time-budget=30000",
                   *CHROME_ARGS, f"--print-to-pdf={out}", url]
            if hasattr(os, "geteuid") and os.geteuid() == 0:
                cmd.insert(1, "--no-sandbox")
            try:
                subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=150,
                               env=dict(os.environ, HOME=td))
            except subprocess.TimeoutExpired:
                pass   # some builds keep running after the PDF is written
            if not os.path.exists(out) or os.path.getsize(out) < 1000:
                raise RuntimeError("Chromium didn't produce a PDF")
            with open(out, "rb") as f:
                return f.read()
    finally:
        JOBS.pop(token, None)


# ----- visitor count
VLOCK = threading.Lock()
SALT = secrets.token_bytes(16)   # new on every start: the hashes below can't be linked to an address later
SEEN = {}                        # salted hash of an address -> when it last counted (memory only)


def visits(add=False, who=""):
    path = os.path.join(STATE, "visits.json")
    with VLOCK:
        try:
            with open(path, encoding="utf-8") as f:
                n = int(json.load(f).get("count", 0))
        except Exception:
            n = 0
        if add:
            key, now = hashlib.sha256(SALT + who.encode()).hexdigest(), time.time()
            if now - SEEN.get(key, 0) > 86400:
                SEEN[key] = now
                n += 1
                os.makedirs(STATE, exist_ok=True)
                with open(path + ".tmp", "w", encoding="utf-8") as f:
                    json.dump({"count": n}, f)
                os.replace(path + ".tmp", path)
            if len(SEEN) > 100000:   # forget day-old entries
                for k in [k for k, t in SEEN.items() if now - t > 86400]:
                    del SEEN[k]
        return n


class Handler(BaseHTTPRequestHandler):
    server_version = "cardforge-service"

    def visitor(self):   # behind nginx (and maybe a Cloudflare tunnel) the address arrives in a header
        return (self.headers.get("CF-Connecting-IP") or self.headers.get("X-Real-IP") or self.client_address[0]).strip()

    def log_message(self, fmt, *args):   # one line per request in the journal
        print("%s %s" % (self.address_string(), fmt % args), flush=True)

    def send(self, code, body=b"", ctype="text/plain; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/pdf":
            return self.send(200, json.dumps({"ok": bool(chromium())}).encode(), "application/json")
        if self.path.split("?")[0] == "/api/visits":
            return self.send(200, json.dumps({"count": visits()}).encode(), "application/json")
        m = re.match(r"^/job/([A-Za-z0-9_-]+)$", self.path)
        if m and m.group(1) in JOBS and self.client_address[0] == "127.0.0.1" and "X-Forwarded-For" not in self.headers:
            return self.send(200, JOBS[m.group(1)], "text/html; charset=utf-8")
        self.send(404, b"not found")

    def do_POST(self):
        if self.path.split("?")[0] == "/api/visits":
            return self.send(200, json.dumps({"count": visits(add=True, who=self.visitor())}).encode(), "application/json")
        if self.path.split("?")[0] != "/api/pdf":
            return self.send(404, b"not found")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BYTES:
            return self.send(413, b"sheet missing or too large")
        html = self.rfile.read(length)
        if b'id="sheets"' not in html or b"const DATA" not in html:
            return self.send(400, b"that isn't a Card Forge print sheet")
        if not chromium():
            return self.send(503, b"Chromium isn't installed on the server")
        name = re.sub(r"[^A-Za-z0-9._-]+", "-", self.headers.get("X-Filename", "cardforge-cards"))[:80].strip("-.") or "cardforge-cards"
        name = re.sub(r"\.html?$", "", name) + ".pdf"
        if not BUSY.acquire(timeout=90):
            return self.send(503, b"busy, try again in a minute")
        try:
            pdf = render(html)
        except Exception as e:   # tell the page; it offers printing instead
            return self.send(500, f"couldn't make the PDF: {e}".encode())
        finally:
            BUSY.release()
        self.send(200, pdf, "application/pdf", {"Content-Disposition": f'attachment; filename="{name}"'})


if __name__ == "__main__":
    ThreadingHTTPServer.daemon_threads = True
    print(f"Card Forge service on 127.0.0.1:{PORT} (Chromium for PDFs: {chromium() or 'not installed'}; "
          f"printing via {'cardforge.py' if cardforge else '--print-to-pdf'})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
