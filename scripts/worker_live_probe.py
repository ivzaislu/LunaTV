#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from urllib.parse import urlparse

import requests

ROOT = Path(__file__).resolve().parents[1]
CHANNELS_PATH = ROOT / "config" / "channels.json"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"


def load_channels() -> dict:
    with CHANNELS_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def probe_hls(url: str, timeout: float = 1.5) -> tuple[bool, str]:
    try:
        response = requests.get(
            url,
            timeout=timeout,
            allow_redirects=True,
            stream=True,
            headers={
                "User-Agent": UA,
                "Accept": "application/vnd.apple.mpegurl,application/x-mpegURL,*/*",
            },
        )
        status = response.status_code
        final_host = urlparse(response.url).hostname or ""
        chunk = next(response.iter_content(chunk_size=1024), b"")
        text = chunk.decode("utf-8", errors="ignore").lstrip("\ufeff \t\r\n")
        ok = 200 <= status < 300 and text.startswith("#EXTM3U")
        return ok, f"HTTP {status} host={final_host} extm3u={text.startswith('#EXTM3U')}"
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Live probe through persistent universal extractor worker")
    parser.add_argument("slugs", nargs="+")
    parser.add_argument("--worker", default="http://127.0.0.1:6071")
    parser.add_argument("--timeout", type=float, default=5.0)
    args = parser.parse_args()

    channels = load_channels()
    failures = 0

    for slug in args.slugs:
        entry = channels.get(slug)
        if not isinstance(entry, dict) or not entry.get("url"):
            print(f"FAIL {slug}: missing channel/url")
            failures += 1
            continue

        started = time.monotonic()
        try:
            response = requests.post(
                f"{args.worker.rstrip('/')}/extract",
                json={"url": entry["url"], "timeout_ms": min(args.timeout, 5.0) * 1000},
                timeout=args.timeout + 0.5,
            )
            elapsed = time.monotonic() - started
            payload = response.json()
        except Exception as exc:
            print(f"FAIL {slug}: worker error after {time.monotonic() - started:.2f}s: {type(exc).__name__}: {exc}")
            failures += 1
            continue

        streams = payload.get("streams") if isinstance(payload, dict) else None
        if response.status_code != 200 or not isinstance(streams, list) or not streams:
            detail = payload.get("error") if isinstance(payload, dict) else payload
            print(f"FAIL {slug}: extract={elapsed:.2f}s worker_ms={payload.get('elapsed_ms') if isinstance(payload, dict) else '?'} no HLS; {detail or '-'}")
            failures += 1
            continue

        if elapsed > args.timeout:
            print(f"FAIL {slug}: extract too slow {elapsed:.2f}s > {args.timeout:.2f}s")
            failures += 1
            continue

        stream = str(streams[0])
        ok, detail = probe_hls(stream)
        stream_host = urlparse(stream).hostname or ""
        if ok:
            print(f"OK   {slug}: extract={elapsed:.2f}s worker_ms={payload.get('elapsed_ms')} HLS host={stream_host}; {detail}")
        else:
            print(f"FAIL {slug}: extract={elapsed:.2f}s worker_ms={payload.get('elapsed_ms')} HLS host={stream_host}; {detail}")
            failures += 1

    print(f"Worker live probe failures: {failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
