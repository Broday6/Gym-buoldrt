#!/usr/bin/env python3
"""Serve the Review Studio for one install-video project.

    python review_server.py <project-folder> [--port 8765] [--no-open]

Opens http://127.0.0.1:8765 in the default browser. The studio lists every version under
<project>/review/, plays its cuts, and saves the user's notes to review/<version>/feedback.json
as they work. The previous feedback.json is kept as feedback.prev.json on every save.

Only this computer can reach it: it listens on 127.0.0.1 and refuses other Host headers. It
serves files from inside the project folder and writes nothing but feedback.json.
Standard library only, Python 3.8+.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import sys
import threading
import webbrowser
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import validate_review as vr  # noqa: E402

CHUNK = 1 << 20
MAX_BODY = 5 << 20
mimetypes.add_type("video/mp4", ".mp4")
mimetypes.add_type("video/webm", ".webm")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("text/markdown", ".md")


def natural_key(s: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def find_studio_html() -> Path:
    here = Path(__file__).resolve().parent
    for p in (here / "studio.html", here.parent / "assets" / "studio.html"):
        if p.exists():
            return p
    raise SystemExit("studio.html not found next to review_server.py or in ../assets/")


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


class Project:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.review = self.root / "review"
        self.lock = threading.Lock()

    def version_dirs(self) -> list[Path]:
        if not self.review.is_dir():
            return []
        dirs = [d for d in self.review.iterdir() if d.is_dir() and (d / "manifest.json").is_file()]
        return sorted(dirs, key=lambda d: natural_key(d.name))

    def version_dir(self, vid: str) -> Path | None:
        for d in self.version_dirs():
            if d.name == vid:
                return d
        return None

    def summary(self) -> dict:
        versions = []
        name = None
        for d in self.version_dirs():
            m = read_json(d / "manifest.json")
            ev = read_json(d / "eval-report.json")
            fb = read_json(d / "feedback.json")
            ok = isinstance(m, dict)
            if ok and m.get("project"):
                name = m["project"]

            def mtime(p: Path):
                try:
                    return p.stat().st_mtime
                except OSError:
                    return None

            versions.append({
                "id": d.name,
                "project": m.get("project") if ok else None,
                "created": m.get("created") if ok else None,
                "previous": m.get("previous") if ok else None,
                "readable": ok,
                "has_eval": isinstance(ev, dict),
                "eval_overall": ev.get("overall") if isinstance(ev, dict) else None,
                "eval_mtime": mtime(d / "eval-report.json"),
                "manifest_mtime": mtime(d / "manifest.json"),
                "has_feedback": isinstance(fb, dict),
                "approved": bool(fb.get("approved")) if isinstance(fb, dict) else False,
                "submitted": bool(fb.get("submitted")) if isinstance(fb, dict) else False,
            })
        return {"name": name or self.root.name, "folder": self.root.name, "versions": versions}

    def version(self, vid: str) -> dict | None:
        d = self.version_dir(vid)
        if d is None:
            return None
        m = read_json(d / "manifest.json")
        res = vr.validate_manifest(m, version_dir=d.name) if m is not None else None
        ev = read_json(d / "eval-report.json")
        fb = read_json(d / "feedback.json")
        return {
            "manifest": m,
            "manifest_errors": res.errors if res else ["manifest.json is not valid JSON"],
            "manifest_warnings": res.warnings if res else [],
            "eval": ev,
            "feedback": fb,
        }

    def save_feedback(self, vid: str, fb) -> tuple[bool, list[str]]:
        d = self.version_dir(vid)
        if d is None:
            return False, [f"no version {vid!r}"]
        m = read_json(d / "manifest.json")
        res = vr.validate_feedback(fb, m)
        if not res.ok:
            return False, res.errors
        fb["updated"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        target = d / "feedback.json"
        tmp = d / "feedback.json.tmp"
        with self.lock:
            tmp.write_text(json.dumps(fb, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            if target.exists():
                os.replace(target, d / "feedback.prev.json")
            os.replace(tmp, target)
        return True, []

    def resolve_file(self, rel: str) -> Path | None:
        rel = rel.lstrip("/")
        if not rel or "\\" in rel or "\x00" in rel:
            return None
        p = (self.root / rel).resolve()
        try:
            p.relative_to(self.root)
        except ValueError:
            return None
        return p if p.is_file() else None


class Handler(BaseHTTPRequestHandler):
    server_version = "EkenaReviewStudio/1"
    project: Project
    studio_html: Path
    allowed_hosts: set
    verbose = False

    def log_message(self, fmt, *args):  # quiet unless --verbose
        if self.verbose:
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _host_ok(self) -> bool:
        return (self.headers.get("Host") or "").lower() in self.allowed_hosts

    def _send_json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status, msg):
        self._send_json({"error": msg}, status)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._host_ok():
            return self._error(HTTPStatus.FORBIDDEN, "unexpected Host header")
        path = unquote(urlsplit(self.path).path)
        try:
            if path in ("/", "/index.html"):
                return self._send_file(self.studio_html, "text/html; charset=utf-8")
            if path == "/api/project":
                return self._send_json(self.project.summary())
            m = re.fullmatch(r"/api/version/([^/]+)", path)
            if m:
                data = self.project.version(m.group(1))
                if data is None:
                    return self._error(HTTPStatus.NOT_FOUND, "no such version")
                return self._send_json(data)
            if path.startswith("/files/"):
                f = self.project.resolve_file(path[len("/files/"):])
                if f is None:
                    return self._error(HTTPStatus.NOT_FOUND, "file not found in the project folder")
                return self._send_file(f)
            return self._error(HTTPStatus.NOT_FOUND, "not found")
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # the browser cancelled a video range request; normal while seeking

    def do_PUT(self):
        if not self._host_ok():
            return self._error(HTTPStatus.FORBIDDEN, "unexpected Host header")
        path = unquote(urlsplit(self.path).path)
        m = re.fullmatch(r"/api/version/([^/]+)/feedback", path)
        if not m:
            return self._error(HTTPStatus.NOT_FOUND, "not found")
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            return self._error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "send JSON")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if not 0 < length <= MAX_BODY:
            return self._error(HTTPStatus.BAD_REQUEST, "missing or oversized body")
        try:
            fb = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return self._error(HTTPStatus.BAD_REQUEST, "body is not JSON")
        ok, errors = self.project.save_feedback(m.group(1), fb)
        if not ok:
            return self._send_json({"error": "feedback rejected", "errors": errors}, HTTPStatus.BAD_REQUEST)
        return self._send_json({"ok": True, "updated": fb["updated"]})

    def _send_file(self, f: Path, ctype: str | None = None):
        size = f.stat().st_size
        ctype = ctype or mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        start, end = 0, size - 1
        status = HTTPStatus.OK
        rng = self.headers.get("Range")
        if rng and size > 0:
            mr = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip())
            if not mr or (not mr.group(1) and not mr.group(2)):
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            if mr.group(1):
                start = int(mr.group(1))
                end = min(int(mr.group(2)), size - 1) if mr.group(2) else size - 1
            else:  # suffix range: last N bytes
                start = max(0, size - int(mr.group(2)))
            if start > end or start >= size:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            status = HTTPStatus.PARTIAL_CONTENT
        length = end - start + 1 if size else 0
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD" or not length:
            return
        with f.open("rb") as fh:
            fh.seek(start)
            left = length
            while left > 0:
                buf = fh.read(min(CHUNK, left))
                if not buf:
                    break
                self.wfile.write(buf)
                left -= len(buf)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", type=Path, help="the project folder (the one holding review/)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-open", action="store_true", help="don't open a browser")
    ap.add_argument("--verbose", action="store_true", help="log every request")
    args = ap.parse_args(argv)

    project = Project(args.project)
    if not project.root.is_dir():
        raise SystemExit(f"{project.root} is not a folder")
    if not project.version_dirs():
        print(f"Note: no versions yet under {project.review} — the studio will pick them up as they appear.")

    server = None
    for port in range(args.port, args.port + 20):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            continue
    if server is None:
        raise SystemExit(f"no free port between {args.port} and {args.port + 19}")
    server.daemon_threads = True
    port = server.server_address[1]
    Handler.project = project
    Handler.studio_html = find_studio_html()
    Handler.allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    Handler.verbose = args.verbose
    url = f"http://127.0.0.1:{port}/"
    print(f"Review Studio for {project.root.name}: {url}  (Ctrl+C to stop)", flush=True)
    if not args.no_open:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
