#!/usr/bin/env python3
"""
Card Forge PDF service: turns a print sheet made by the website into a PDF with headless Chromium,
exactly like the offline tool does.  nginx forwards /api/pdf to it; it only listens on 127.0.0.1.

  GET  /api/pdf   -> {"ok": true} when Chromium is installed (the website then shows "Download PDF")
  POST /api/pdf   body = the sheet's HTML, header X-Filename = name for the download -> application/pdf

The sheet is rendered with all network access blocked (it needs none) and one at a time.
"""
import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("CF_PDF_PORT", "8090"))
MAX_BYTES = 40 * 1024 * 1024
BUSY = threading.Semaphore(1)
JOBS = {}


def chromium():
    for name in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable"):
        path = shutil.which(name)
        if path:
            return path
    return None


def render(html: bytes) -> bytes:
    token = secrets.token_urlsafe(18)
    JOBS[token] = html
    try:
        with tempfile.TemporaryDirectory() as td:
            out = os.path.join(td, "sheet.pdf")
            cmd = [chromium(), "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                   "--disable-extensions", "--disable-background-networking", "--no-pdf-header-footer",
                   "--print-to-pdf-no-header", "--virtual-time-budget=30000",
                   # everything except this service (on loopback) goes to a dead proxy: no network for the page
                   "--proxy-server=http://127.0.0.1:9",
                   f"--print-to-pdf={out}", f"http://127.0.0.1:{PORT}/job/{token}"]
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


class Handler(BaseHTTPRequestHandler):
    server_version = "cardforge-pdf"

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
        m = re.match(r"^/job/([A-Za-z0-9_-]+)$", self.path)
        if m and m.group(1) in JOBS and self.client_address[0] == "127.0.0.1" and "X-Forwarded-For" not in self.headers:
            return self.send(200, JOBS[m.group(1)], "text/html; charset=utf-8")
        self.send(404, b"not found")

    def do_POST(self):
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
    print(f"Card Forge PDF service on 127.0.0.1:{PORT} (Chromium: {chromium() or 'not installed'})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
