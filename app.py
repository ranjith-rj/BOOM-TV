"""GTV IPTV Player - Flask backend.

Endpoints
    /                 Main application (HTML)
    /api/channels     Parsed channel list (add ?refresh=1 to bypass the cache)
    /api/playlist     Raw M3U playlist, as served by the IPTV server
    /api/health       Server status (add ?deep=1 to probe the IPTV server)
    /api/stream       Optional same-origin stream proxy (avoids CORS problems)

Configuration (environment variables, all optional)
    GTV_PLAYLIST_URL  M3U playlist URL   (default https://iptv-org.github.io/iptv/index.m3u)
    GTV_HOST          Bind address       (default 127.0.0.1)
    GTV_PORT          Bind port          (default 8787)
    GTV_CACHE_TTL     Playlist cache, s  (default 300)
    GTV_TIMEOUT       Read timeout, s    (default 15)
    GTV_DEBUG         "1" enables Flask debug mode
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import threading
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote, urljoin, urlparse

import requests
from flask import Flask, Response, jsonify, render_template, request, stream_with_context

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #
PLAYLIST_URL = os.environ.get("GTV_PLAYLIST_URL", "https://iptv-org.github.io/iptv/index.m3u")
HOST = os.environ.get("GTV_HOST", "127.0.0.1")
PORT = int(os.environ.get("GTV_PORT", "8787"))
CACHE_TTL = int(os.environ.get("GTV_CACHE_TTL", "300"))
READ_TIMEOUT = float(os.environ.get("GTV_TIMEOUT", "15"))
CONNECT_TIMEOUT = 5.0
DEBUG = os.environ.get("GTV_DEBUG", "0") == "1"
USER_AGENT = "GTV-IPTV-Player/1.0"
DEFAULT_GROUP = "Uncategorised"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(message)s")
log = logging.getLogger("gtv")

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["JSON_SORT_KEYS"] = False
app.json.sort_keys = False  # type: ignore[attr-defined]


# --------------------------------------------------------------------------- #
# M3U parsing
# --------------------------------------------------------------------------- #
class PlaylistError(Exception):
    """Raised when the playlist cannot be fetched or is not valid M3U."""


ATTR_RE = re.compile(r'([\w\-.]+)\s*=\s*"([^"]*)"')


def _split_extinf(line: str) -> tuple[str, str]:
    """Split '#EXTINF:-1 a="b,c" ,Name' into (metadata, display name).

    The display name follows the first comma that is *not* inside quotes.
    """
    body = line[len("#EXTINF:"):]
    in_quotes = False
    for i, ch in enumerate(body):
        if ch == '"':
            in_quotes = not in_quotes
        elif ch == "," and not in_quotes:
            return body[:i], body[i + 1:].strip()
    return body, ""


def parse_m3u(text: str) -> list[dict[str, Any]]:
    """Parse M3U/M3U8 text into a list of channel dictionaries.

    Supports #EXTINF attributes (tvg-id, tvg-name, tvg-logo, group-title),
    #EXTGRP, and ignores other directives such as #EXTVLCOPT. Malformed
    entries are skipped instead of failing the whole playlist.
    """
    text = text.lstrip("\ufeff")
    lines = [ln.strip() for ln in text.splitlines()]
    if not any(ln.upper().startswith(("#EXTM3U", "#EXTINF")) for ln in lines):
        raise PlaylistError("Response is not a valid M3U playlist (no #EXTM3U / #EXTINF found).")

    channels: list[dict[str, Any]] = []
    seen_ids: dict[str, int] = {}
    pending: dict[str, str] | None = None
    ext_group = ""
    skipped = 0

    for line in lines:
        if not line:
            continue
        if line.upper().startswith("#EXTINF:"):
            meta, name = _split_extinf(line)
            attrs = {k.lower(): v.strip() for k, v in ATTR_RE.findall(meta)}
            name = name or attrs.get("tvg-name", "")
            pending = {
                "name": name,
                "logo": attrs.get("tvg-logo", ""),
                "group": attrs.get("group-title", ""),
                "tvg_id": attrs.get("tvg-id", ""),
            }
            continue
        if line.upper().startswith("#EXTGRP:"):
            ext_group = line.split(":", 1)[1].strip()
            continue
        if line.startswith("#"):
            continue

        # A non-comment line is a stream URL.
        if pending is None:
            pending = {"name": "", "logo": "", "group": "", "tvg_id": ""}
        scheme = urlparse(line).scheme.lower()
        if scheme not in ("http", "https", "rtmp", "rtsp", "udp"):
            skipped += 1
            pending, ext_group = None, ""
            continue

        name = pending["name"] or urlparse(line).path.rsplit("/", 1)[-1] or "Unnamed channel"
        group = pending["group"] or ext_group or DEFAULT_GROUP
        base_id = hashlib.sha1(f"{name}|{line}".encode("utf-8")).hexdigest()[:10]
        n = seen_ids.get(base_id, 0)
        seen_ids[base_id] = n + 1
        channels.append(
            {
                "id": base_id if n == 0 else f"{base_id}-{n}",
                "name": name,
                "url": line,
                "logo": pending["logo"],
                "group": group,
                "tvg_id": pending["tvg_id"],
            }
        )
        pending, ext_group = None, ""

    if skipped:
        log.warning("Skipped %d playlist entries with unsupported/invalid URLs", skipped)
    return channels


def build_categories(channels: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counts: dict[str, int] = {}
    for ch in channels:
        counts[ch["group"]] = counts.get(ch["group"], 0) + 1
    return [{"name": n, "count": c} for n, c in sorted(counts.items(), key=lambda kv: kv[0].lower())]


# --------------------------------------------------------------------------- #
# Playlist fetching + cache
# --------------------------------------------------------------------------- #
class PlaylistCache:
    """Thread-safe playlist cache with stale-on-error fallback."""

    def __init__(self, url: str, ttl: int) -> None:
        self.url = url
        self.ttl = ttl
        self._lock = threading.Lock()
        self.raw: str = ""
        self.channels: list[dict[str, Any]] = []
        self.fetched_at: float = 0.0
        self.last_error: str | None = None

    def _download(self) -> str:
        try:
            resp = requests.get(
                self.url,
                headers={"User-Agent": USER_AGENT},
                timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
            )
            resp.raise_for_status()
        except requests.exceptions.ConnectTimeout as exc:
            raise PlaylistError(f"Timed out connecting to the IPTV server ({self.url}).") from exc
        except requests.exceptions.ReadTimeout as exc:
            raise PlaylistError("The IPTV server took too long to send the playlist.") from exc
        except requests.exceptions.ConnectionError as exc:
            raise PlaylistError(f"Cannot reach the IPTV server ({self.url}). Is it running and on the same network?") from exc
        except requests.exceptions.HTTPError as exc:
            raise PlaylistError(f"IPTV server returned HTTP {exc.response.status_code} for the playlist.") from exc
        except requests.exceptions.RequestException as exc:
            raise PlaylistError(f"Playlist request failed: {exc}") from exc
        return resp.content.decode("utf-8", errors="replace")

    def get(self, force: bool = False) -> dict[str, Any]:
        """Return the playlist state, refreshing it when stale or forced.

        If a refresh fails but older data exists, the old data is returned
        with ``stale=True``. If there is no data at all, PlaylistError is raised.
        """
        with self._lock:
            fresh = self.channels and (time.time() - self.fetched_at) < self.ttl
            if fresh and not force:
                return self._snapshot(stale=False)
            try:
                raw = self._download()
                channels = parse_m3u(raw)
            except PlaylistError as exc:
                self.last_error = str(exc)
                log.error("Playlist refresh failed: %s", exc)
                if self.channels:
                    return self._snapshot(stale=True)
                raise
            self.raw, self.channels = raw, channels
            self.fetched_at = time.time()
            self.last_error = None
            log.info("Playlist loaded: %d channels", len(channels))
            return self._snapshot(stale=False)

    def _snapshot(self, stale: bool) -> dict[str, Any]:
        return {
            "raw": self.raw,
            "channels": list(self.channels),
            "fetched_at": self.fetched_at,
            "stale": stale,
            "warning": self.last_error if stale else None,
        }

    def known_hosts(self) -> set[str]:
        hosts = {urlparse(self.url).netloc.lower()}
        hosts.update(urlparse(c["url"]).netloc.lower() for c in self.channels)
        return hosts


playlist = PlaylistCache(PLAYLIST_URL, CACHE_TTL)


def _iso(ts: float) -> str | None:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat() if ts else None


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/channels")
def api_channels():
    force = request.args.get("refresh") in ("1", "true", "yes")
    try:
        snap = playlist.get(force=force)
    except PlaylistError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 502
    channels = snap["channels"]
    return jsonify(
        {
            "ok": True,
            "count": len(channels),
            "categories": build_categories(channels),
            "channels": channels,
            "fetched_at": _iso(snap["fetched_at"]),
            "stale": snap["stale"],
            "warning": snap["warning"],
        }
    )


@app.route("/api/playlist")
def api_playlist():
    force = request.args.get("refresh") in ("1", "true", "yes")
    try:
        snap = playlist.get(force=force)
    except PlaylistError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 502
    return Response(
        snap["raw"],
        mimetype="audio/x-mpegurl",
        headers={"Content-Disposition": 'inline; filename="playlist.m3u"', "Cache-Control": "no-cache"},
    )


@app.route("/api/health")
def api_health():
    body: dict[str, Any] = {
        "status": "ok",
        "time": _iso(time.time()),
        "playlist_url": PLAYLIST_URL,
        "channels_cached": len(playlist.channels),
        "playlist_fetched_at": _iso(playlist.fetched_at),
        "last_error": playlist.last_error,
    }
    if request.args.get("deep") in ("1", "true", "yes"):
        try:
            requests.head(PLAYLIST_URL, headers={"User-Agent": USER_AGENT}, timeout=(CONNECT_TIMEOUT, 5), allow_redirects=True)
            body["playlist_reachable"] = True
        except requests.exceptions.RequestException as exc:
            body["playlist_reachable"] = False
            body["playlist_error"] = str(exc)
    return jsonify(body)


# ---- Optional stream proxy ------------------------------------------------- #
_dynamic_hosts: set[str] = set()  # hosts discovered inside proxied manifests
_URI_ATTR_RE = re.compile(r'URI="([^"]*)"')


def _proxy_url(absolute: str) -> str:
    _dynamic_hosts.add(urlparse(absolute).netloc.lower())
    if len(_dynamic_hosts) > 500:  # keep memory bounded
        _dynamic_hosts.clear()
    return "/api/stream?url=" + quote(absolute, safe="")


def rewrite_manifest(text: str, base_url: str) -> str:
    """Rewrite every URI in an HLS manifest so it goes through /api/stream."""
    out: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            out.append(line)
        elif stripped.startswith("#"):
            out.append(_URI_ATTR_RE.sub(lambda m: f'URI="{_proxy_url(urljoin(base_url, m.group(1)))}"', line))
        else:
            out.append(_proxy_url(urljoin(base_url, stripped)))
    return "\n".join(out) + "\n"


@app.route("/api/stream")
def api_stream():
    """Same-origin pass-through for streams. Only hosts from the playlist are allowed."""
    target = request.args.get("url", "")  # Flask already percent-decodes query values
    parsed = urlparse(target)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return jsonify({"ok": False, "error": "Invalid stream URL."}), 400

    if not playlist.channels:
        try:
            playlist.get()
        except PlaylistError:
            pass
    allowed = playlist.known_hosts() | _dynamic_hosts
    if parsed.netloc.lower() not in allowed:
        return jsonify({"ok": False, "error": "Host is not part of the configured playlist."}), 403

    headers = {"User-Agent": USER_AGENT}
    if request.headers.get("Range"):
        headers["Range"] = request.headers["Range"]
    try:
        upstream = requests.get(target, headers=headers, stream=True, timeout=(CONNECT_TIMEOUT, READ_TIMEOUT), allow_redirects=True)
    except requests.exceptions.RequestException as exc:
        return jsonify({"ok": False, "error": f"Upstream stream error: {exc}"}), 502

    ctype = upstream.headers.get("Content-Type", "")
    is_manifest = ".m3u8" in urlparse(upstream.url).path.lower() or "mpegurl" in ctype.lower()
    if is_manifest:
        try:
            text = upstream.content.decode("utf-8", errors="replace")
        finally:
            upstream.close()
        return Response(
            rewrite_manifest(text, upstream.url),
            status=upstream.status_code,
            mimetype="application/vnd.apple.mpegurl",
            headers={"Cache-Control": "no-cache"},
        )

    def generate():
        try:
            for chunk in upstream.iter_content(chunk_size=64 * 1024):
                if chunk:
                    yield chunk
        except requests.exceptions.RequestException:
            pass
        finally:
            upstream.close()

    passthrough = {k: v for k, v in upstream.headers.items() if k.lower() in ("content-type", "content-range", "accept-ranges")}
    passthrough["Cache-Control"] = "no-cache"
    return Response(stream_with_context(generate()), status=upstream.status_code, headers=passthrough)


@app.errorhandler(404)
def not_found(_exc):
    if request.path.startswith("/api/"):
        return jsonify({"ok": False, "error": "Unknown API endpoint."}), 404
    return render_template("index.html"), 200


@app.errorhandler(500)
def server_error(exc):
    log.exception("Unhandled error: %s", exc)
    return jsonify({"ok": False, "error": "Internal server error."}), 500


if __name__ == "__main__":
    log.info("GTV IPTV Player running at http://localhost:%d  (playlist: %s)", PORT, PLAYLIST_URL)
    app.run(host=HOST, port=PORT, debug=DEBUG, threaded=True, use_reloader=DEBUG)
