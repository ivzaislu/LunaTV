# -*- coding: utf-8 -*-
"""
Сканер/валидатор с «контролёром» сайтов + поддержка search.json:
- JS-экстракторы лежат в ./extractor
- M3U-файлы пишутся в ./m3u (stream.m3u)
- site_controller.json, m3u8_cache.json, channels.json, search.json — в ./config

Логика:
- Если домен стартового URL присутствует в config/search.json — сначала запускается JS-парсер страниц
  (например, extractor/search-generic.js), который возвращает JSON-массив URL страниц-кандидатов.
  Затем по каждой странице запускается обычный JS-экстрактор (из site_controller.json) и валидируются .m3u8.
- Если домена нет в search.json — работаем по старой схеме: crawl_links() + экстрактор.

Зависимости:
  pip install requests beautifulsoup4 unidecode
"""

import argparse
import os
import re
import json
import time
import glob
import shutil
import subprocess
import signal
import sys
from typing import List, Dict, Optional, Tuple
from collections import OrderedDict
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup
from unidecode import unidecode
from urllib.parse import urlparse, urljoin, urlsplit, urlunsplit

# ------------------ ПУТИ И БАЗОВЫЕ НАСТРОЙКИ ------------------
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))

EXTRACTORS_DIR = os.path.join(ROOT_DIR, "extractor")
M3U_DIR        = os.path.join(ROOT_DIR, "m3u")
CONFIG_DIR     = os.path.join(ROOT_DIR, "config")

os.makedirs(EXTRACTORS_DIR, exist_ok=True)
os.makedirs(M3U_DIR, exist_ok=True)
os.makedirs(CONFIG_DIR, exist_ok=True)

M3U_FILENAME    = os.path.join(M3U_DIR, "stream.m3u")
CHANNELS_JSON   = os.path.join(CONFIG_DIR, "channels.json")
M3U8_CACHE      = os.path.join(CONFIG_DIR, "m3u8_cache.json")
CONTROLLER_FILE = os.path.join(CONFIG_DIR, "site_controller.json")
SEARCH_JSON     = os.path.join(CONFIG_DIR, "search.json")

ORPHAN_CHROME_MAX_AGE_SEC = 180

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

REQUEST_TIMEOUT = 15
VALIDATION_TIMEOUT = 12

NODE_BIN = "node"  # при необходимости абсолютный путь

CLEAN_TMP_AFTER_JS = True
TMP_PATTERNS = (
    "/tmp/playwright*",
    "/tmp/.org.chromium.*",
    "/dev/shm/.org.chromium.*",
    "/tmp/ms-playwright*",
)

BASE_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "*/*",
    "Accept-Language": "ru,en;q=0.9",
    "Connection": "keep-alive",
}

WRITTEN_M3U_KEYS: set = set()

# ------------------ ХЕЛПЕРЫ ------------------

def slugify(name: str) -> str:
    return re.sub(r"[^\w]+", "-", unidecode(name or "").lower()).strip("-")

def clean_channel_name(name: str) -> str:
    name = (name or "").strip()

    # убираем служебные слова и фразы
    junk_words = [
        "онлайн", "прямой эфир", "телеканал",
        "смотреть", ",online", "бесплатно"
    ]
    low = name.lower()
    for word in junk_words:
        low = low.replace(word, "")
    name = low

    # убираем кавычки, дефисы, пробелы с краёв
    name = name.strip(" \u00a0:-«»\"'“”‘’")

    # нормализация регистра
    return name.title() or "Без названия"



def normalize_url(u: str) -> str:
    """Канонизирует URL для сравнения."""
    try:
        s = urlsplit((u or "").strip())
        scheme = (s.scheme or "http").lower()
        host = (s.hostname or "").lower()
        if not host:
            return (u or "").strip()
        if s.port and not ((scheme == "http" and s.port == 80) or (scheme == "https" and s.port == 443)):
            netloc = f"{host}:{s.port}"
        else:
            netloc = host
        path = re.sub(r"/+", "/", s.path or "/").rstrip("/") or "/"
        return urlunsplit((scheme, netloc, path, s.query or "", ""))
    except Exception:
        return (u or "").strip()

def save_to_m3u(name: str, stream_url: str, referer: str, filename: str = M3U_FILENAME):
    key = (name.strip(), stream_url.strip(), (referer or "").strip())
    if key in WRITTEN_M3U_KEYS:
        return
    WRITTEN_M3U_KEYS.add(key)

    is_new = not os.path.exists(filename)
    with open(filename, "a", encoding="utf-8") as f:
        if is_new:
            f.write("#EXTM3U\n")
        f.write(f"#EXTINF:-1 tvg-id=\"\" tvg-name=\"{name}\" group-title=\"AutoDetected\",{name}\n")
        f.write(f"#EXTVLCOPT:http-user-agent={USER_AGENT}\n")
        if referer:
            f.write(f"#EXTVLCOPT:http-referrer={referer}\n")
        f.write(f"{stream_url}\n\n")

def cleanup_tmp():
    if not CLEAN_TMP_AFTER_JS:
        return
    for patt in TMP_PATTERNS:
        for path in glob.glob(patt):
            try:
                if os.path.isdir(path):
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    os.remove(path)
            except Exception:
                pass

def load_json_ordered(path: str) -> "OrderedDict[str, Dict]":
    """Безопасно читает JSON-файл в OrderedDict."""
    try:
        if not os.path.isfile(path):
            return OrderedDict()
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return OrderedDict(data)
    except Exception:
        pass
    return OrderedDict()

def load_json_safe(path: str):
    """Безопасно читает JSON-файл, на ошибки возвращает пустой dict."""
    try:
        if not os.path.isfile(path):
            return {}
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

# ------------------ КОНТРОЛЁР ------------------

def load_controller(path: str) -> Dict:
    if not os.path.isfile(path):
        raise FileNotFoundError(f"Не найден контролёр: {path}")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def choose_site_cfg(ctrl: Dict, url: str) -> Dict:
    """Подбирает конфиг по домену (самое длинное совпадение по суффиксу netloc)."""
    netloc = urlparse(url).netloc.split(":")[0].lower()
    winner = None
    win_len = -1
    for key in ctrl.keys():
        if key == "default":
            continue
        if netloc.endswith(key.lower()):
            if len(key) > win_len:
                winner = key
                win_len = len(key)
    if winner:
        cfg = ctrl[winner].copy()
        cfg["_matched"] = winner
        return cfg
    cfg = ctrl.get("default", {}).copy()
    cfg["_matched"] = "default"
    return cfg

def compile_patterns(cfg: Dict) -> Tuple[List[re.Pattern], List[re.Pattern], List[re.Pattern]]:
    allows = [re.compile(p) for p in cfg.get("url_allow_re", []) if p]
    denys  = [re.compile(p) for p in cfg.get("url_deny_re", []) if p]
    atext  = [re.compile(p) for p in cfg.get("anchor_text_deny_re", []) if p]
    return allows, denys, atext

def accept_link(href: str, anchor_text: str, start_url: str, allows, denys, atext) -> bool:
    if not href:
        return False
    if href.startswith(("javascript:", "mailto:", "#")):
        return False
    full = href
    if allows and not any(r.search(full) for r in allows):
        return False
    if denys and any(r.search(full) for r in denys):
        return False
    if anchor_text and atext and any(r.search(anchor_text) for r in atext):
        return False
    return True

# ------------------ СТАРТОВАЯ: CRAWL ------------------

def fetch_html(url: str, timeout: int = REQUEST_TIMEOUT) -> str:
    headers = {"User-Agent": USER_AGENT, "Accept": "text/html,*/*"}
    r = requests.get(url, headers=headers, timeout=timeout, allow_redirects=True)
    r.raise_for_status()
    return r.text

def crawl_links(start_url: str, ctrl: Dict) -> List[str]:
    """Собирает ссылки, применяя правила контролёра для КАЖДОГО кандидата."""
    try:
        html = fetch_html(start_url)
    except Exception as e:
        print(f"❌ Не удалось загрузить стартовую: {e}")
        return []
    soup = BeautifulSoup(html, "html.parser")

    parsed = urlparse(start_url)
    base = f"{parsed.scheme}://{parsed.netloc}"
    cfg = choose_site_cfg(ctrl, start_url)
    allows, denys, atext = compile_patterns(cfg)

    out = []
    seen = set()
    for a in soup.find_all("a", href=True):
        href_raw = (a.get("href") or "").strip()
        if not href_raw:
            continue
        href = urljoin(base if href_raw.startswith("/") else start_url, href_raw)
        if not href.startswith(("http://", "https://")):
            continue
        href = normalize_url(href)
        text = a.get_text(" ", strip=True) or ""
        if not accept_link(href, text, start_url, allows, denys, atext):
            continue
        if href in seen:
            continue
        seen.add(href)
        out.append(href)

    print(f"🔎 Контролёр: {cfg['_matched']} | Допущено ссылок: {len(out)}")
    return out

# ------------------ /proc helpers ------------------

def _read_file(path: str) -> str:
    try:
        with open(path, "r") as f:
            return f.read()
    except Exception:
        return ""

def _list_pids():
    for name in os.listdir("/proc"):
        if name.isdigit():
            yield int(name)

def _proc_comm(pid: int) -> str:
    return _read_file(f"/proc/{pid}/comm").strip()

def _proc_cmdline(pid: int) -> str:
    raw = _read_file(f"/proc/{pid}/cmdline")
    return raw.replace("\x00", " ").strip()

def _proc_ppid(pid: int) -> int:
    try:
        parts = _read_file(f"/proc/{pid}/stat").split()
        if len(parts) >= 4:
            return int(parts[3])
    except Exception:
        pass
    return -1

def _get_uptime_sec() -> float:
    try:
        return float(_read_file("/proc/uptime").split()[0])
    except Exception:
        return 0.0

def _get_clk_tck() -> int:
    try:
        return os.sysconf(os.sysconf_names["SC_CLK_TCK"])
    except Exception:
        return 100

def _proc_age_sec(pid: int) -> float:
    try:
        stat = _read_file(f"/proc/{pid}/stat").split()
        if len(stat) < 22:
            return 0.0
        start_ticks = int(stat[21])
        hz = _get_clk_tck()
        started = start_ticks / hz
        return max(0.0, _get_uptime_sec() - started)
    except Exception:
        return 0.0

def kill_orphan_chrome(max_age_sec: int = ORPHAN_CHROME_MAX_AGE_SEC) -> int:
    victims = 0
    name_mark = ("chrome", "chromium", "chromium-browser")
    automation_mark = ("playwright", "/tmp/playwright", "ms-playwright", ".org.chromium", "--remote-debugging", "--headless")

    for pid in list(_list_pids()):
        try:
            if _proc_ppid(pid) != 1:
                continue
            comm = _proc_comm(pid).lower()
            cmd = _proc_cmdline(pid).lower()

            if not any(m in comm or m in cmd for m in name_mark):
                continue
            if not any(m in cmd for m in automation_mark):
                continue

            if _proc_age_sec(pid) > max_age_sec:
                continue

            try:
                os.kill(pid, signal.SIGKILL)
                victims += 1
            except ProcessLookupError:
                pass
            except Exception:
                pass
        except Exception:
            continue

    return victims

# ------------------ JS: ВСПОМОГАТЕЛЬНОЕ ------------------

def _resolve_script_path(script_name: str) -> str:
    """Возвращает абсолютный путь к JS-скрипту. Относительные ищутся в ./extractor."""
    if not script_name:
        return ""
    if os.path.isabs(script_name):
        return script_name
    return os.path.abspath(os.path.join(EXTRACTORS_DIR, script_name))

def run_js_extractor(page_url: str, script_path: str, timeout_sec: int) -> List[str]:
    """Запуск указанного JS-экстрактора. Возвращает список m3u8."""
    if not os.path.isfile(script_path):
        print(f"⛔ JS-скрипт не найден: {script_path}")
        return []

    cmd = [NODE_BIN, script_path, page_url, str(max(1, int(timeout_sec)))]
    proc = None
    stdout = stderr = ""
    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, start_new_session=True,
            cwd=os.path.dirname(script_path) or None,
        )
        try:
            stdout, stderr = proc.communicate(timeout=timeout_sec + 2)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
            stdout, stderr = proc.communicate()
        except Exception:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
            try:
                stdout, stderr = proc.communicate(timeout=1)
            except Exception:
                stdout, stderr = "", ""
    finally:
        cleanup_tmp()
        k = kill_orphan_chrome()
        if k:
            print(f"  🧹 Убито осиротевших Chrome: {k}")
        try:
            if proc and proc.poll() is None:
                proc.kill()
        except Exception:
            pass
        try:
            if proc and proc.stdout: proc.stdout.close()
            if proc and proc.stderr: proc.stderr.close()
        except Exception:
            pass
        time.sleep(0.05)

    text = ((stdout or "") + "\n" + (stderr or "")).strip()
    if not text:
        return []

    streams: List[str] = []
    try:
        j = json.loads(text)
        if isinstance(j, list):
            streams = [str(x) for x in j]
        elif isinstance(j, dict):
            arr = j.get("streams") or j.get("links") or j.get("m3u8") or []
            if isinstance(arr, list):
                streams = [str(x) for x in arr]
    except Exception:
        urls = re.findall(r'https?://[^\s<>"\'\)\]]+', text)
        streams = [u for u in urls if ".m3u8" in u.lower()]

    uniq, seen = [], set()
    for u in streams:
        if u not in seen:
            seen.add(u)
            uniq.append(u)
    return uniq

def run_js_pages_parser(start_url: str, parser_script: str, timeout_sec: int, patterns_cfg: Dict) -> List[str]:
    """
    Запускает JS-парсер страниц (например, extractor/search-generic.js).
    Паттерны allow/deny/anchor_text передаём в ENV как JSON-массивы.
    Возвращает список URL-страниц.
    """
    if not os.path.isfile(parser_script):
        print(f"⛔ JS-парсер не найден: {parser_script}")
        return []

    env = os.environ.copy()
    env["SEARCH_ALLOW_RE"] = json.dumps(patterns_cfg.get("url_allow_re", []) or [])
    env["SEARCH_DENY_RE"]  = json.dumps(patterns_cfg.get("url_deny_re", []) or [])
    env["SEARCH_ATEXT_RE"] = json.dumps(patterns_cfg.get("anchor_text_deny_re", []) or [])

    try:
        out = subprocess.check_output(
            [NODE_BIN, parser_script, start_url, str(max(1, int(timeout_sec)))],
            cwd=os.path.dirname(parser_script) or None,
            env=env, text=True, timeout=timeout_sec + 2
        )
        try:
            arr = json.loads(out)
            if isinstance(arr, list):
                return [str(u) for u in arr if isinstance(u, str)]
        except Exception:
            pass
    except subprocess.TimeoutExpired:
        pass
    except Exception:
        pass
    return []

# ------------------ ВАЛИДАЦИЯ ------------------

def _looks_like_hls(text: str) -> bool:
    if not text:
        return False
    t = text.strip()
    return t.startswith("#EXTM3U") and ("#EXT-X-" in t or "#EXTINF" in t)

def validate_stream(stream_url: str, referer: Optional[str]) -> bool:
    headers = dict(BASE_HEADERS)
    if referer:
        headers["Referer"] = referer
    try:
        r = requests.get(stream_url, headers=headers, timeout=VALIDATION_TIMEOUT,
                         stream=True, allow_redirects=True)
        if r.status_code >= 400:
            return False
        chunk = next(r.iter_content(chunk_size=2048), b"")
        text = ""
        try:
            text = chunk.decode("utf-8", errors="ignore")
        except Exception:
            pass
        return _looks_like_hls(text)
    except Exception:
        return False

def _infer_site_tag(start_url: str) -> str:
    d = urlparse(start_url).netloc.replace("www.", "").split(":")[0]
    return slugify(d.split(".")[0])


def main(argv: Optional[List[str]] = None) -> int:
    """CLI-точка входа с поддержкой аргументов и non-interactive запуска."""

    parser = argparse.ArgumentParser(description="Запуск сканера каналов LunaTV")
    parser.add_argument("--start-url", dest="start_url", help="Стартовая страница сканирования")
    parser.add_argument("--site-tag", dest="site_tag", help="Короткий тег площадки")
    args = parser.parse_args(argv)

    start_url = (args.start_url or os.environ.get("SCANNER_START_URL", "")).strip()
    site_tag = (args.site_tag or os.environ.get("SCANNER_SITE_TAG", "")).strip().lower()

    interactive = sys.stdin.isatty()

    if not start_url and interactive:
        start_url = input("🔗 Введите стартовую страницу: ").strip()

    if not start_url:
        print("⛔ Не задана стартовая страница. Используйте --start-url или переменную SCANNER_START_URL.")
        return 2

    if not site_tag and interactive:
        site_tag = input("📛 Короткий тег сайта (например: smotru, viks, tivix): ").strip().lower()

    if not site_tag:
        site_tag = _infer_site_tag(start_url)

    try:
        controller = load_controller(CONTROLLER_FILE)
    except Exception as e:
        print(f"⛔ Ошибка чтения контролёра: {e}")
        return 1

    search_map = load_json_safe(SEARCH_JSON)

    channels_map: "OrderedDict[str, Dict[str, object]]" = load_json_ordered(CHANNELS_JSON)
    m3u8_cache: "OrderedDict[str, Dict[str, str]]" = load_json_ordered(M3U8_CACHE)

    known_urls_norm = {
        normalize_url(v.get("url", "")) for v in channels_map.values() if isinstance(v, dict)
    }

    host = urlparse(start_url).netloc.split(":")[0].lower()
    matched = None
    if isinstance(search_map, dict):
        for key in search_map.keys():
            if host.endswith(str(key).lower()):
                if not matched or len(key) > len(matched):
                    matched = key

    if matched:
        parser_name = (search_map.get(matched) or {}).get("parser") or "search-generic.js"
        parser_timeout = int((search_map.get(matched) or {}).get("timeout_sec") or 10)
        parser_path = _resolve_script_path(parser_name)
        patterns_cfg = choose_site_cfg(controller, start_url)
        links = run_js_pages_parser(start_url, parser_path, parser_timeout, patterns_cfg)
        print(f"🔎 search.json: {matched} | Парсер: {os.path.basename(parser_path)} | Найдено ссылок: {len(links)}")
    else:
        links = crawl_links(start_url, controller)

    before = len(links)
    links = [u for u in links if normalize_url(u) not in known_urls_norm]
    skipped = before - len(links)
    if skipped:
        print(f"🧠 Пропущено уже известных ссылок из {CHANNELS_JSON}: {skipped}")

    print("\n🚀 Извлечение потоков с учётом контролёра...\n")

    for url in links:
        cfg = choose_site_cfg(controller, url)
        script_name = cfg.get("script") or controller.get("default", {}).get("script") or "universal-playwright-extractor.js"
        timeout_sec = int(cfg.get("timeout_sec") or controller.get("default", {}).get("timeout_sec") or 10)
        script_path = _resolve_script_path(script_name)

        print(f"▶ [{cfg['_matched']}] JS={os.path.basename(script_path)} T={timeout_sec}s | {url}")

        try:
            html = fetch_html(url)
            soup = BeautifulSoup(html, "html.parser")
            h1 = soup.find("h1") or soup.title
            name = clean_channel_name(h1.get_text(strip=True) if h1 else "Без названия")
        except Exception:
            name = "Без названия"

        streams = run_js_extractor(url, script_path, timeout_sec)

        valid = []
        for s in streams:
            ok = validate_stream(s, referer=url)
            print(f"    • {('✅ OK' if ok else '❌ BAD')}  {s}")
            if ok:
                valid.append(s)
                save_to_m3u(name, s, referer=url)

        slug = f"{slugify(name)}-{slugify(site_tag)}"

        if not valid:
            print("  ⚠️ Ничего валидного не найдено. Канал пропущен.")
            time.sleep(0.05)
            continue

        url_norm = normalize_url(url)

        if slug in channels_map:
            print(f"  🔁 Канал '{slug}' уже есть в channels.json — пропускаю добавление.")
        elif url_norm in known_urls_norm:
            print(f"  🔁 URL уже встречался в channels.json — пропускаю добавление.")
        else:
            channels_map[slug] = {"name": name, "url": url}
            known_urls_norm.add(url_norm)
            print(f"  ➕ Добавлен канал '{slug}'")

        if slug in m3u8_cache:
            print(f"  🔁 Поток для '{slug}' уже есть в m3u8_cache.json — пропускаю добавление.")
        else:
            m3u8_cache[slug] = {"url": valid[0], "timestamp": datetime.now(timezone.utc).isoformat()}

        time.sleep(0.05)

    with open(CHANNELS_JSON, "w", encoding="utf-8") as f:
        json.dump(channels_map, f, ensure_ascii=False, indent=2)

    with open(M3U8_CACHE, "w", encoding="utf-8") as f:
        json.dump(m3u8_cache, f, ensure_ascii=False, indent=2)

    print(f"\n🎉 Готово.")
    print(f"📁 Каналы: {os.path.abspath(CHANNELS_JSON)}")
    print(f"📁 Плейлист: {os.path.abspath(M3U_FILENAME)}")
    print(f"📁 Кэш m3u8: {os.path.abspath(M3U8_CACHE)}")
    return 0


if __name__ == "__main__":  # pragma: no cover - прямой запуск
    raise SystemExit(main())
