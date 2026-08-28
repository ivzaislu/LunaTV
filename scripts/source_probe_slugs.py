#!/usr/bin/env python3
"""Run LunaTV live source checks for exact configured channel slugs."""
from __future__ import annotations

import argparse
import sys

from source_smoke import (
    CHANNELS_PATH,
    SITE_CONTROLLER_PATH,
    check_channel,
    host_of,
    load_json,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Probe exact LunaTV channel slugs")
    parser.add_argument("slugs", nargs="+", help="Configured slugs from config/channels.json")
    parser.add_argument("--timeout", type=int, default=5, help="Extractor SLA cap in seconds (default: 5)")
    parser.add_argument("--extractor", help="Override configured extractor for diagnostics")
    args = parser.parse_args(argv)

    channels = load_json(CHANNELS_PATH)
    controller = load_json(SITE_CONTROLLER_PATH)
    failures = 0

    for slug in args.slugs:
        raw = channels.get(slug)
        if raw is None:
            print(f"FAIL {slug}: not found in {CHANNELS_PATH}")
            failures += 1
            continue

        entry = {"url": raw, "name": slug} if isinstance(raw, str) else raw
        if not isinstance(entry, dict):
            print(f"FAIL {slug}: invalid channel entry")
            failures += 1
            continue

        page_url = str(entry.get("url") or "")
        host = host_of(page_url)
        if not host:
            print(f"FAIL {slug}: missing/invalid URL")
            failures += 1
            continue

        if not check_channel(host, slug, entry, controller, args.extractor, max(1, args.timeout)):
            failures += 1

    if failures:
        print(f"\nTargeted live probe failures: {failures}")
        return 1
    print("\nAll targeted live probes passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
