#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CLI для проверки .m3u плейлистов в каталоге m3u/.

Скрипт перебирает все .m3u файлы, извлекает HTTP(S) ссылки
и выполняет быструю проверку доступности потоков.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
from dataclasses import dataclass
import os
import sys
from typing import Iterable, List, Tuple
from urllib.parse import urlparse

import requests

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

DEFAULT_TIMEOUT = 10
DEFAULT_CONCURRENCY = 8
DEFAULT_DIR = os.path.join(os.path.dirname(__file__), "m3u")


@dataclass
class StreamCheckResult:
    url: str
    ok: bool
    details: str
    status: int | None
    playlist: str

    def short_message(self) -> str:
        base = f"[{self.playlist}] {self.url}"
        if self.ok:
            return f"OK     {base} ({self.details})"
        status = f"HTTP {self.status}" if self.status is not None else "ERR"
        return f"FAIL   {base} ({status}: {self.details})"


def iter_m3u_streams(path: str) -> Iterable[str]:
    with open(path, "r", encoding="utf-8", errors="ignore") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.lower().startswith("http://") or line.lower().startswith("https://"):
                yield line


def probe_url(url: str, timeout: int) -> Tuple[bool, str, int | None]:
    headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    head_failure: str | None = None
    head_status: int | None = None
    try:
        resp = requests.head(url, allow_redirects=True, timeout=timeout, headers=headers)
        status = resp.status_code
        head_status = status
        ct = (resp.headers.get("content-type") or "").lower()
        if 200 <= status < 400 and (
            "mpegurl" in ct or urlparse(resp.url).path.lower().endswith(".m3u8")
        ):
            resp.close()
            return True, f"HEAD {status} ({ct or 'no content-type'})", status
        if status >= 400 or status < 200:
            head_failure = f"HEAD returned {status}"
        else:
            head_failure = f"HEAD {status} ({ct or 'no content-type'})"
        resp.close()
    except requests.RequestException as exc:
        head_failure = str(exc)

    # Fallback to GET with stream to detect живость.
    try:
        resp = requests.get(url, allow_redirects=True, timeout=timeout, headers=headers, stream=True)
        status = resp.status_code
        if status >= 400 or status < 200:
            resp.close()
            return False, f"GET returned {status}", status
        ct = (resp.headers.get("content-type") or "").lower()
        ok_hint = "mpegurl" in ct or urlparse(resp.url).path.lower().endswith(".m3u8")
        message = f"GET {status} ({ct or 'no content-type'})"
        if not ok_hint:
            message += "; suspicious content-type"
        # Считываем небольшой фрагмент, чтобы убедиться, что поток живой.
        try:
            next(resp.iter_content(chunk_size=512))
        except StopIteration:
            message += "; empty body"
        except Exception as exc:  # pragma: no cover
            message += f"; read error: {exc}"
        finally:
            resp.close()
        if head_failure:
            message = f"{message}; after {head_failure}"
        return True, message, status
    except requests.RequestException as exc:
        details = str(exc)
        if head_failure:
            details = f"{details}; after {head_failure}"
        return False, details, head_status


def check_playlist(
    path: str,
    timeout: int,
    playlist_name: str,
    concurrency: int,
) -> List[StreamCheckResult]:
    urls = list(dict.fromkeys(iter_m3u_streams(path)))
    results: List[StreamCheckResult] = []
    if not urls:
        return results

    workers = max(1, concurrency)
    with cf.ThreadPoolExecutor(max_workers=workers) as executor:
        future_map = {
            executor.submit(probe_url, url, timeout): url for url in urls
        }
        for future in cf.as_completed(future_map):
            url = future_map[future]
            try:
                ok, details, status = future.result()
            except Exception as exc:  # pragma: no cover - safety guard
                ok, details, status = False, f"internal error: {exc}", None
            results.append(StreamCheckResult(url=url, ok=ok, details=details, status=status, playlist=playlist_name))
    results.sort(key=lambda r: (not r.ok, r.url))
    return results


def find_playlists(directory: str) -> List[str]:
    if not os.path.isdir(directory):
        return []
    return [
        os.path.join(directory, name)
        for name in sorted(os.listdir(directory))
        if name.lower().endswith(".m3u")
    ]


def run(directory: str, timeout: int, concurrency: int) -> int:
    playlists = find_playlists(directory)
    if not playlists:
        print(f"[i] Плейлисты (*.m3u) не найдены в каталоге: {directory}")
        return 0

    overall_failures = 0
    for path in playlists:
        name = os.path.basename(path)
        print(f"\n=== Проверка {name} ===")
        urls = list(dict.fromkeys(iter_m3u_streams(path)))
        if not urls:
            print("[!] Ссылки в плейлисте отсутствуют")
            continue
        print(f"[i] Найдено потоков: {len(urls)}")
        results = check_playlist(path, timeout, name, concurrency)
        for res in results:
            print(res.short_message())
        failures = sum(1 for r in results if not r.ok)
        overall_failures += failures
        ok_count = len(results) - failures
        print(f"[i] Итого по {name}: OK {ok_count}, FAIL {failures}")
    if overall_failures:
        print(f"\n[!] Найдено проблемных потоков: {overall_failures}")
        return 1
    print("\n[i] Все плейлисты прошли проверку")
    return 0


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Проверка HLS потоков из .m3u плейлистов")
    parser.add_argument(
        "--dir",
        default=DEFAULT_DIR,
        help="Каталог с .m3u файлами (по умолчанию ./m3u)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT,
        help=f"Таймаут HTTP запросов, сек. (по умолчанию {DEFAULT_TIMEOUT})",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=DEFAULT_CONCURRENCY,
        help=f"Количество параллельных проверок (по умолчанию {DEFAULT_CONCURRENCY})",
    )
    args = parser.parse_args(argv)
    return run(args.dir, args.timeout, args.workers)


if __name__ == "__main__":
    sys.exit(main())
