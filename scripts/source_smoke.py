#!/usr/bin/env python3
"""Fast live checks for configured LunaTV IPTV sources.

A source is useful only when its extractor returns an HLS candidate within five
seconds and the resulting playlist can be fetched directly by LunaTV's 302 client.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlparse

import requests

ROOT = Path(__file__).resolve().parents[1]
CONFIG_DIR = ROOT / "config"
EXTRACTOR_DIR = ROOT / "extractor"
CHANNELS_PATH = CONFIG_DIR / "channels.json"
SITE_CONTROLLER_PATH = CONFIG_DIR / "site_controller.json"
MAX_EXTRACTOR_SECONDS = 5.0

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
DEFAULT_HOSTS = [
    "smotru.tv",
    "mediamaniya.ru",
    "ip.tivix.co",
    "live.viks.tv",
    "smotrettv.com",
    "telik.live",
    "oneliketv.net",
    "live.domatv.net",
]


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError(f"Expected object in {path}")
    return data


def host_of(url: str) -> str:
    return (urlparse(url).hostname or "").lower().removeprefix("www.")


def group_channels(channels: dict) -> dict[str, list[tuple[str, dict]]]:
    grouped: dict[str, list[tuple[str, dict]]] = defaultdict(list)
    for slug, raw in channels.items():
        if isinstance(raw, str):
            entry = {"url": raw, "name": slug}
        elif isinstance(raw, dict):
            entry = raw
        else:
            continue
        page_url = str(entry.get("url") or "").strip()
        host = host_of(page_url)
        if host:
            grouped[host].append((slug, entry))
    return grouped


def pick_controller(controller: dict, host: str) -> dict:
    cfg = controller.get(host)
    if isinstance(cfg, dict):
        return cfg
    parts = host.split(".")
    if len(parts) >= 2:
        cfg = controller.get(".".join(parts[-2:]))
        if isinstance(cfg, dict):
            return cfg
    cfg = controller.get("default")
    return cfg if isinstance(cfg, dict) else {}


def clean_stream_url(value: str) -> str | None:
    candidate = str(value or "").replace("&amp;", "&").strip().rstrip(",;)}]")
    if not candidate or any(ch.isspace() for ch in candidate):
        return None
    try:
        parsed = urlparse(candidate)
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    if ".m3u8" not in candidate.lower():
        return None
    return candidate


def extract_urls(text: str) -> list[str]:
    found = re.findall(r"https?://[^\s<>\"'\)\]]+", text or "")
    out: list[str] = []
    seen: set[str] = set()
    for value in found:
        candidate = clean_stream_url(value)
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        out.append(candidate)
    return out


def run_extractor(page_url: str, script_name: str, timeout_sec: int) -> tuple[list[str], str]:
    script = EXTRACTOR_DIR / script_name
    if not script.is_file():
        return [], f"missing extractor: {script_name}"

    timeout_sec = max(1.0, min(float(timeout_sec), MAX_EXTRACTOR_SECONDS))
    argv = [os.environ.get("NODE_BIN", "node"), str(script), page_url]
    if script_name != "cdnpotok.js":
        argv.append(f"{timeout_sec:g}")

    started = time.monotonic()
    try:
        proc = subprocess.run(
            argv,
            cwd=str(EXTRACTOR_DIR),
            capture_output=True,
            text=True,
            timeout=MAX_EXTRACTOR_SECONDS + 0.5,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return [], f"too slow: exceeded {MAX_EXTRACTOR_SECONDS:.1f}s"
    except OSError as exc:
        return [], f"extractor launch failed: {exc}"

    elapsed = time.monotonic() - started
    if elapsed > MAX_EXTRACTOR_SECONDS:
        return [], f"too slow: {elapsed:.2f}s > {MAX_EXTRACTOR_SECONDS:.2f}s"

    combined = f"{proc.stdout}\n{proc.stderr}"
    streams: list[str] = []
    try:
        payload = json.loads(proc.stdout.strip())
        if isinstance(payload, list):
            streams.extend(str(item) for item in payload)
        elif isinstance(payload, dict):
            values = payload.get("streams") or payload.get("links") or []
            if isinstance(values, list):
                streams.extend(str(item) for item in values)
    except Exception:
        pass
    streams.extend(extract_urls(combined))

    cleaned: list[str] = []
    seen: set[str] = set()
    for raw in streams:
        candidate = clean_stream_url(raw)
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        cleaned.append(candidate)
    if cleaned:
        return cleaned, f"{elapsed:.2f}s"

    detail = (proc.stderr or proc.stdout or f"exit {proc.returncode}").strip().splitlines()
    suffix = detail[-1][:200] if detail else f"exit {proc.returncode}"
    return [], f"{elapsed:.2f}s; {suffix}"


def _probe_hls_once(url: str, timeout_sec: int, referer: str | None = None) -> tuple[bool, str]:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/vnd.apple.mpegurl,application/x-mpegURL,*/*",
    }
    if referer:
        headers["Referer"] = referer
    try:
        response = requests.get(
            url,
            headers=headers,
            timeout=timeout_sec,
            allow_redirects=True,
            stream=True,
        )
        try:
            status = response.status_code
            if not 200 <= status < 400:
                return False, f"HTTP {status}"
            chunk = next(response.iter_content(chunk_size=4096), b"")
            text = chunk.decode("utf-8", errors="ignore").lstrip("\ufeff\r\n ")
            if text.startswith("#EXTM3U"):
                return True, f"HTTP {status} #EXTM3U"
            content_type = (response.headers.get("content-type") or "").lower()
            if "mpegurl" in content_type:
                return True, f"HTTP {status} {content_type}"
            return False, f"HTTP {status}, body is not HLS"
        finally:
            response.close()
    except requests.RequestException as exc:
        return False, exc.__class__.__name__


def probe_hls(url: str, referer: str, timeout_sec: int) -> tuple[bool, str, bool]:
    direct_ok, direct_detail = _probe_hls_once(url, timeout_sec)
    if direct_ok:
        return True, f"direct {direct_detail}", True
    referer_ok, referer_detail = _probe_hls_once(url, timeout_sec, referer=referer)
    if referer_ok:
        return True, f"referer-only {referer_detail}; direct={direct_detail}", False
    return False, f"direct={direct_detail}; referer={referer_detail}", False


def check_channel(
    requested_host: str,
    slug: str,
    entry: dict,
    controller: dict,
    extractor_override: str | None,
    diagnostic_timeout: int,
) -> bool:
    page_url = str(entry.get("url") or "")
    cfg = pick_controller(controller, requested_host)
    script_name = str(
        extractor_override
        or entry.get("script")
        or cfg.get("script")
        or "universal-playwright-extractor.js"
    )
    configured_timeout = float(entry.get("timeout_sec") or cfg.get("timeout_sec") or diagnostic_timeout)
    timeout_sec = max(1, min(configured_timeout, float(diagnostic_timeout), MAX_EXTRACTOR_SECONDS))

    streams, extraction_detail = run_extractor(page_url, script_name, timeout_sec)
    if not streams:
        print(f"FAIL {requested_host} [{slug}] via {script_name}: {extraction_detail}")
        return False

    probe_detail = ""
    referer_only_seen = False
    for stream in streams[:5]:
        ok, probe_detail, direct_ok = probe_hls(stream, page_url, int(max(1, timeout_sec)))
        if ok and direct_ok:
            stream_host = host_of(stream) or "unknown"
            print(
                f"OK   {requested_host} [{slug}] via {script_name}: "
                f"extract={extraction_detail}, HLS host={stream_host}, {probe_detail}"
            )
            return True
        if ok:
            referer_only_seen = True

    if referer_only_seen:
        print(
            f"WARN {requested_host} [{slug}] via {script_name}: "
            f"extract={extraction_detail}, HLS needs Referer; {probe_detail}"
        )
    else:
        print(
            f"FAIL {requested_host} [{slug}] via {script_name}: "
            f"extract={extraction_detail}, {len(streams)} candidate(s), last probe={probe_detail}"
        )
    return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fast live smoke checks for LunaTV sources")
    parser.add_argument("--hosts", nargs="*", default=DEFAULT_HOSTS)
    parser.add_argument(
        "--timeout",
        type=int,
        default=5,
        help="Per-extractor cap in seconds; values above 5 are clamped (default: 5)",
    )
    parser.add_argument("--samples-per-host", type=int, default=1)
    parser.add_argument("--extractor", help="Override configured extractor")
    args = parser.parse_args(argv)

    channels = load_json(CHANNELS_PATH)
    controller = load_json(SITE_CONTROLLER_PATH)
    grouped = group_channels(channels)

    failed_hosts = 0
    for requested_host in args.hosts:
        candidates = grouped.get(requested_host, [])
        if not candidates:
            print(f"SKIP {requested_host}: no configured channels")
            continue

        sampled = candidates[: max(1, args.samples_per_host)]
        host_successes = 0
        for slug, entry in sampled:
            if check_channel(requested_host, slug, entry, controller, args.extractor, args.timeout):
                host_successes += 1

        print(f"SUMMARY {requested_host}: OK {host_successes}/{len(sampled)} sampled channel(s)")
        if host_successes == 0:
            failed_hosts += 1

    if failed_hosts:
        print(f"\nHosts with no fast 302-compatible sampled channels: {failed_hosts}")
        return 1
    print("\nEvery requested host had at least one fast 302-compatible sampled channel")
    return 0


if __name__ == "__main__":
    sys.exit(main())
