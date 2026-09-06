#!/usr/bin/env python3
"""Fetch mope.io game files from the Wayback Machine.

The live mope.io site only serves the latest build, so to obtain the
game files as they were around a specific date we pull them from the
Internet Archive's Wayback Machine, choosing the archived snapshot whose
timestamp is closest to the requested date (default: 2021-06-21).

What it fetches:
  * the homepage HTML for that snapshot
  * every same-host <script> and stylesheet it references
  * <img>/<link rel=icon> resources on the page
  * any url(...) assets referenced by the downloaded stylesheets
"""

import argparse
import json
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

PAGE_URL = "https://mope.io/"
WAYBACK_CDX = "https://web.archive.org/cdx/search/cdx"
WAYBACK_WEB = "https://web.archive.org/web"
DEFAULT_TARGET = "2021-06-21"
USER_AGENT = "mope-archive-fetcher/1.0 (+https://archive.org)"

# Hosts/prefixes never worth fetching from the archived page.
SKIP_HOSTS = {
    "apis.google.com", "superawesome.tv", "cloudflareinsights.com",
    "web.archive.org", "a.pub.network", "doubleclick.net", "googletagmanager.com",
    "google-analytics.com", "pub.network", "facebook.com", "twitter.com",
    "ads.superawesome.tv",
}
SKIP_PREFIXES = ("/cdn-cgi/",)

SRC_RE = re.compile(r"""<script[^>]+src=["']([^"']+)["']""", re.I)
CSS_RE = re.compile(r"""<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']""", re.I)
ICON_RE = re.compile(r"""<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']+)["']""", re.I)
IMG_RE = re.compile(r"""<img[^>]+src=["']([^"']+)["']""", re.I)
CSS_URL_RE = re.compile(r"""url\(\s*['"]?([^'")]+)['"]?\s*\)""", re.I)

OPEN_TIMEOUT = 60
RETRIES = 8
WINDOW_DAYS = 400  # CDX from/to window around the target date

# Caps the number of simultaneous HTTP connections to web.archive.org.
# Sized to the --concurrency value in main().
CONN_LIMIT = threading.BoundedSemaphore(1)
_LOG_LOCK = threading.Lock()


def set_concurrency(n):
    """Set the maximum number of in-flight HTTP requests."""
    global CONN_LIMIT
    CONN_LIMIT = threading.BoundedSemaphore(n)


def log(msg):
    with _LOG_LOCK:
        print("[fetch-mope] " + msg, flush=True)


def http_request(url, timeout=OPEN_TIMEOUT):
    """GET *url* and return (final_url, raw_bytes). Retries with backoff."""
    last_exc = None
    for attempt in range(RETRIES):
        try:
            with CONN_LIMIT:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    return resp.geturl(), resp.read()
        except Exception as exc:  # noqa: BLE001 - any network error is retryable
            last_exc = exc
            time.sleep(min(60, 2.0 * (2 ** attempt)))
    raise RuntimeError("GET %s failed: %s" % (url, last_exc))


def parse_target_date(text):
    """Turn a user-supplied date (any common format) into UTC midnight datetime."""
    digits = re.sub(r"\D", "", text)
    if len(digits) == 8:            # 20210621 or 2021-06-21
        year, month, day = int(digits[0:4]), int(digits[4:6]), int(digits[6:8])
    elif len(digits) >= 14:         # full ISO timestamp
        year, month, day = int(digits[0:4]), int(digits[4:6]), int(digits[6:8])
    else:
        raise ValueError("cannot parse date: %r (use YYYY-MM-DD)" % text)
    return datetime(year, month, day, tzinfo=timezone.utc)


def target_wayback_ts(target_dt):
    return target_dt.strftime("%Y%m%d%H%M%S")


def parse_wayback_ts(ts):
    return datetime.strptime(ts, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)


def cdx_query(url, match_type="prefix", limit=2000, window_days=WINDOW_DAYS, target_dt=None):
    """Query the Wayback CDX API, returning rows of [timestamp, original, status, mimetype, digest, length].

    Bounds the search to a window around *target_dt* (default: WINDOW_DAYS on
    either side) so that old captures never crowd out the ones we want.
    """
    if target_dt is None:
        target_dt = parse_target_date(DEFAULT_TARGET)
    frm = (target_dt - timedelta(days=window_days)).strftime("%Y%m%d%H%M%S")
    to = (target_dt + timedelta(days=window_days)).strftime("%Y%m%d%H%M%S")
    params = {
        "url": url,
        "matchType": match_type,
        "output": "json",
        "limit": str(limit),
        "from": frm,
        "to": to,
        "filter": "statuscode:200",
        "collapse": "timestamp:8",  # at most one capture per url per day
        "fl": "timestamp,original,statuscode,mimetype,digest,length",
    }
    qs = urllib.parse.urlencode(params)
    _, body = http_request(WAYBACK_CDX + "?" + qs)
    if not body.strip():
        return []
    rows = json.loads(body)
    if not rows or not isinstance(rows[0], list):
        return []
    return rows[1:]  # skip header row


def closest_snapshot(url, target_dt, match_type="prefix"):
    """Return (timestamp, original_url) of the capture closest to *target_dt*.

    Prefers status 200 captures; falls back to revisits when needed.
    """
    rows = cdx_query(url, match_type, target_dt=target_dt)
    if not rows:
        return None
    best = None
    best_gap = timedelta.max
    for ts, original, status, _mime, _digest, _length in rows:
        if status and status != "200":
            continue
        try:
            gap = abs(parse_wayback_ts(ts) - target_dt)
        except ValueError:
            continue
        if gap < best_gap:
            best_gap = gap
            best = (ts, original)
    return best


def same_host(raw_url):
    resolved = urllib.parse.urljoin(PAGE_URL, raw_url)
    parsed = urllib.parse.urlparse(resolved)
    if parsed.scheme not in ("http", "https"):
        return False
    host = (parsed.hostname or "").lower()
    if host not in ("mope.io", "www.mope.io"):
        return False
    if parsed.path.startswith(SKIP_PREFIXES):
        return False
    return True


def extract_page_assets(html):
    assets = []
    for pat in (SRC_RE, CSS_RE, ICON_RE, IMG_RE):
        for m in pat.finditer(html):
            assets.append(m.group(1))
    seen, out = set(), []
    for raw in assets:
        raw = raw.strip()
        if not raw or raw.startswith("data:"):
            continue
        full = urllib.parse.urljoin(PAGE_URL, raw)
        parsed = urllib.parse.urlparse(full)
        host = (parsed.hostname or "").lower()
        if host in SKIP_HOSTS or full in seen:
            continue
        if not same_host(raw):
            continue
        seen.add(full)
        out.append(full)
    return out


def extract_css_urls(css_text):
    out = []
    for m in CSS_URL_RE.finditer(css_text):
        url = m.group(1).strip()
        if not url or url.startswith(("data:", "#")):
            continue
        if not same_host(url):
            continue
        out.append(urllib.parse.urljoin(PAGE_URL, url))
    return out


def to_cdx_url(full_url):
    """Convert an absolute http(s) URL into a CDX-style query key (host without scheme)."""
    parsed = urllib.parse.urlparse(full_url)
    path = parsed.path if parsed.path else "/"
    qs = "?" + parsed.query if parsed.query else ""
    return (parsed.hostname or "") + path + qs


def safe_path(full_url):
    """Map a URL to a filesystem path that is safe and readable."""
    parsed = urllib.parse.urlparse(full_url)
    path = parsed.path.strip("/")
    if not path:
        path = "index.html"
    parts = [re.sub(r"[^A-Za-z0-9._-]", "_", p) for p in path.split("/")]
    if parsed.query:
        qsafe = re.sub(r"[^A-Za-z0-9._-]", "_", parsed.query)
        parts[-1] = "%s_%s" % (parts[-1], qsafe)
    return os.path.join(*parts)


def download_snapshot(original_url, ts, out_root):
    """Download one archived file, returning (local_path, size)."""
    wayback_url = "%s/%sid_/%s" % (WAYBACK_WEB, ts, original_url)
    rel = safe_path(original_url)
    dest = os.path.join(out_root, rel)
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        log("already have %s" % rel)
        return rel, os.path.getsize(dest)
    final_url, body = http_request(wayback_url)
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    with open(dest, "wb") as fh:
        fh.write(body)
    log("saved %s (%d bytes) <- %s" % (rel, len(body), final_url))
    return rel, len(body)


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument("--date", default=DEFAULT_TARGET,
                    help="target date, closest snapshot is used (default: %s)" % DEFAULT_TARGET)
    ap.add_argument("-o", "--output", default="mope_snapshot",
                    help="output directory (default: mope_snapshot)")
    ap.add_argument("--delay", type=float, default=1.0,
                    help="politeness delay between Wayback requests in seconds "
                         "(default: 1.0; ignored when --concurrency > 1)")
    ap.add_argument("--concurrency", type=int, default=1,
                    help="number of parallel download workers (default: 1)")
    ap.add_argument("--no-css-recursion", action="store_true",
                    help="do not follow url() references inside downloaded CSS files")
    args = ap.parse_args()
    if args.concurrency < 1:
        ap.error("--concurrency must be >= 1")
    set_concurrency(args.concurrency)

    out_root = os.path.abspath(args.output)
    os.makedirs(out_root, exist_ok=True)

    target_dt = parse_target_date(args.date)
    target_ts = target_wayback_ts(target_dt)
    log("target date: %s (wayback ts %s)" % (target_dt.date().isoformat(), target_ts))
    log("concurrency: %d" % args.concurrency)

    page_snap = closest_snapshot("mope.io/", target_dt, match_type="exact")
    if page_snap is None:
        sys.exit("no archived snapshot of mope.io found near %s" % target_dt.date().isoformat())
    page_ts, page_url = page_snap
    log("closest homepage snapshot: %s (%s)" % (page_ts, page_url))

    manifest = {"target_date": target_dt.date().isoformat(), "files": []}
    fetched_urls = {}
    state_lock = threading.Lock()
    serial_mode = args.concurrency == 1

    def snapshot_and_fetch(full_url):
        with state_lock:
            if full_url in fetched_urls:
                return fetched_urls[full_url]
        if serial_mode and args.delay > 0:
            time.sleep(args.delay)
        snap = closest_snapshot(to_cdx_url(full_url), target_dt, match_type="prefix")
        if snap is None:
            log("no archive capture for %s" % full_url)
            return None
        ts, original = snap
        rel, size = download_snapshot(original, ts, out_root)
        record = {
            "url": full_url, "archived_from": original,
            "timestamp": ts, "local_path": rel, "size": size,
        }
        with state_lock:
            fetched_urls[full_url] = record
            manifest["files"].append(record)
        return record

    def run_fetch(urls):
        urls = [u for u in urls if u not in fetched_urls]
        if not urls:
            return
        with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
            futures = [ex.submit(snapshot_and_fetch, u) for u in urls]
            for fut in as_completed(futures):
                try:
                    fut.result()
                except Exception as exc:  # noqa: BLE001 - report, keep going
                    log("error: %s" % exc)

    # 1. Homepage HTML.
    if args.delay > 0:
        time.sleep(args.delay)
    page_rel, _ = download_snapshot(page_url, page_ts, out_root)
    manifest["files"].append({
        "url": PAGE_URL, "archived_from": page_url,
        "timestamp": page_ts, "local_path": page_rel,
    })
    page_html = open(os.path.join(out_root, page_rel), "rb").read().decode("utf-8", "replace")

    # 2. Page-referenced assets.
    assets = extract_page_assets(page_html)
    if assets:
        log("page references %d same-host assets" % len(assets))
        run_fetch(assets)

    # 3. CSS-referenced assets (one level deep).
    if not args.no_css_recursion:
        css_files = [e for e in manifest["files"]
                     if e["url"].endswith(".css") or "css" in e["url"]]
        css_urls = set()
        for entry in css_files:
            css_path = os.path.join(out_root, entry["local_path"])
            if not os.path.exists(css_path):
                continue
            css_text = open(css_path, "rb").read().decode("utf-8", "replace")
            css_urls.update(extract_css_urls(css_text))
        if css_urls:
            log("stylesheets reference %d same-host url() assets" % len(css_urls))
            run_fetch(sorted(css_urls))

    # 4. Manifest.
    manifest["files"].sort(key=lambda e: e["url"])
    manifest_path = os.path.join(out_root, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, sort_keys=True)
    log("done. %d files in %s (manifest: %s)"
        % (len(manifest["files"]), out_root, manifest_path))


if __name__ == "__main__":
    main()
