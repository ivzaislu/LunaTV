#!/usr/bin/env python3
"""Live diagnostics for configured CDN endpoints.

Tests a few browser-like HTTP header profiles against channel `cdn` URLs and reports
status/timing/content markers without printing stream URLs or response bodies.
This is diagnostic only; production extractors still have the <=5s SLA.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from urllib.parse import urlparse

import requests

ROOT = Path(__file__).resolve().parents[1]
CHANNELS_PATH = ROOT / "config" / "channels.json"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
DEFAULT_SLUGS = [
    "dom-kino-smotru",
    "tv-1000-oneliketv",
    "russkii-roman-telik",
]


def origin(url: str) -> str:
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}"


def safe_host(url: str) -> str:
    return (urlparse(url).hostname or "unknown").lower()


def profiles(referer: str) -> list[tuple[str, dict[str, str]]]:
    base = {
        "User-Agent": UA,
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
        "Referer": referer,
    }
    return [
        (
            "navigation",
            {
                **base,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Upgrade-Insecure-Requests": "1",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "cross-site",
                "Sec-Fetch-User": "?1",
            },
        ),
        (
            "referer-origin",
            {
                **base,
                "Origin": origin(referer),
                "Accept": "text/html,application/vnd.apple.mpegurl,application/x-mpegURL,*/*;q=0.8",
            },
        ),
        (
            "xhr",
            {
                **base,
                "Origin": origin(referer),
                "Accept": "*/*",
                "X-Requested-With": "XMLHttpRequest",
                "Sec-Fetch-Dest": "empty",
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Site": "cross-site",
            },
        ),
    ]


def probe(cdn_url: str, referer: str, timeout: float) -> None:
    for profile_name, headers in profiles(referer):
        started = time.monotonic()
        try:
            response = requests.get(
                cdn_url,
                headers=headers,
                timeout=timeout,
                allow_redirects=True,
                stream=True,
            )
            try:
                chunk = next(response.iter_content(chunk_size=16384), b"")
                elapsed = time.monotonic() - started
                text = chunk.decode("utf-8", errors="ignore")
                lower = text.lower()
                markers = []
                if text.lstrip("\ufeff\r\n ").startswith("#EXTM3U"):
                    markers.append("EXTM3U")
                if ".m3u8" in lower:
                    markers.append("m3u8")
                if "playerjs" in lower:
                    markers.append("PlayerJS")
                if "file" in lower:
                    markers.append("file")
                ctype = (response.headers.get("content-type") or "-").split(";", 1)[0]
                print(
                    f"  {profile_name:14} status={response.status_code} "
                    f"time={elapsed:.2f}s final_host={safe_host(response.url)} "
                    f"type={ctype} bytes={len(chunk)} markers={','.join(markers) or '-'}"
                )
            finally:
                response.close()
        except requests.RequestException as exc:
            elapsed = time.monotonic() - started
            print(f"  {profile_name:14} error={exc.__class__.__name__} time={elapsed:.2f}s")


def main() -> int:
    parser = argparse.ArgumentParser(description="Live CDN header-profile diagnostics")
    parser.add_argument("slugs", nargs="*", default=DEFAULT_SLUGS)
    parser.add_argument("--timeout", type=float, default=1.5)
    args = parser.parse_args()

    channels = json.loads(CHANNELS_PATH.read_text(encoding="utf-8"))
    for slug in args.slugs:
        entry = channels.get(slug)
        if not isinstance(entry, dict):
            print(f"SKIP {slug}: missing channel")
            continue
        referer = str(entry.get("url") or "")
        cdn_url = str(entry.get("cdn") or "")
        if not referer or not cdn_url:
            print(f"SKIP {slug}: no configured CDN")
            continue
        print(f"DIAG {slug}: page_host={safe_host(referer)} cdn_host={safe_host(cdn_url)}")
        probe(cdn_url, referer, max(0.2, args.timeout))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
