# -*- coding: utf-8 -*-
"""
Обновление m3u-плейлистов на основе channels.json с извлечением потоков через JS-экстрактор
и кэшем m3u8 (config/m3u8_cache.json).

Каталоги:
- extractor/ : JS-экстракторы (Node)
- m3u/       : результирующие .m3u файлы
- config/    : channels.json, site_controller.json, m3u8_cache.json
- error/     : дампы HTML при неудачной экстракции (для отладки)
"""

import re
import json
import os
import time
import glob
import shutil
import subprocess
import signal
import requests

from urllib.parse import urlparse
from collections import defaultdict

# ------------------ НАСТРОЙКИ ------------------

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
EXTRACTOR_DIR = os.path.abspath(os.environ.get("EXTRACTOR_DIR", os.path.join(BASE_DIR, "extractor")))
M3U_DIR       = os.path.abspath(os.environ.get("M3U_DIR",       os.path.join(BASE_DIR, "m3u")))
CONFIG_DIR    = os.path.abspath(os.environ.get("CONFIG_DIR",    os.path.join(BASE_DIR, "config")))
ERROR_DIR     = os.path.abspath(os.environ.get("ERROR_DIR",     os.path.join(BASE_DIR, "error")))
DEBUG_DIR     = os.path.abspath(os.environ.get("DEBUG_DIR",     os.path.join(BASE_DIR, "debug")))

os.makedirs(M3U_DIR, exist_ok=True)
os.makedirs(ERROR_DIR, exist_ok=True)

# JS-экстрактор (Node)
NODE_BIN = os.environ.get("NODE_BIN", "node")
_JS_DEF = os.environ.get("JS_EXTRACTOR", "universal-playwright-extractor.js")
JS_TIMEOUT_SEC = int(os.environ.get("JS_TIMEOUT_SEC", "10"))

# Контроллер сайтов и каналы
SITE_CONTROLLER_PATH = os.path.join(CONFIG_DIR, os.environ.get("SITE_CONTROLLER_FILE", "site_controller.json"))
CHANNELS_PATH        = os.path.join(CONFIG_DIR, "channels.json")
M3U8_CACHE_PATH      = os.path.join(CONFIG_DIR, "m3u8_cache.json")

# Очистка мусора Playwright/Chromium
ORPHAN_CHROME_MAX_AGE_SEC = 180
CLEAN_TMP_AFTER_JS = True
TMP_PATTERNS = (
    "/tmp/playwright*",
    "/tmp/.org.chromium.*",
    "/dev/shm/.org.chromium.*",
    "/tmp/ms-playwright*",
)

# ------------------ УТИЛИТЫ ОС/ПРОЦЕССЫ ------------------

def _resolve_script_path(script_name_or_path: str) -> str:
    if not script_name_or_path:
        return os.path.join(EXTRACTOR_DIR, _JS_DEF)
    if os.path.isabs(script_name_or_path):
        return script_name_or_path
    return os.path.join(EXTRACTOR_DIR, script_name_or_path)

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

def _read_file(path: str) -> str:
    try:
        with open(path, "r") as f:
            return f.read()
    except Exception:
        return ""

def _list_pids():
    try:
        for name in os.listdir("/proc"):
            if name.isdigit():
                yield int(name)
    except Exception:
        return

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
    for pid in list(_list_pids() or []):
        try:
            if _proc_ppid(pid) != 1:
                continue
            comm = _proc_comm(pid).lower()
            cmd = _proc_cmdline(pid).lower()
            if not any(m in comm or m in cmd for m in name_mark):
                continue
            if not any(m in cmd for m in automation_mark):
                continue
            age = _proc_age_sec(pid)
            if max_age_sec > 0 and age < max_age_sec:
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

# ------------------ SITE CONTROLLER ------------------

def _domain_from_url(u: str) -> str:
    host = urlparse(u).netloc.lower()
    return host[4:] if host.startswith("www.") else host

def load_site_controller(path: str = SITE_CONTROLLER_PATH) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        norm = {}
        for k, v in data.items():
            dom = str(k).lower().lstrip(".")
            if dom.startswith("www."):
                dom = dom[4:]
            norm[dom] = v or {}
        return norm
    except FileNotFoundError:
        print(f"[i] site_controller.json не найден ({path}) — используем глобальные JS_EXTRACTOR/JS_TIMEOUT_SEC.")
        return {}
    except Exception as e:
        print(f"[!] Ошибка чтения {path}: {e} — используем значения по умолчанию.")
        return {}

SITE_CONTROLLER = load_site_controller()

def pick_js_for_url(page_url: str) -> tuple[str, int]:
    domain = _domain_from_url(page_url)
    conf = SITE_CONTROLLER.get(domain) or {}
    script = conf.get("script", _JS_DEF)
    timeout = int(conf.get("timeout_sec", JS_TIMEOUT_SEC))
    return _resolve_script_path(script), timeout

# ------------------ M3U8 CACHE ------------------
from datetime import datetime, timezone

_m3u8_cache = {}

def load_m3u8_cache(path: str = M3U8_CACHE_PATH) -> dict:
    """
    Загружает config/m3u8_cache.json формата:
    {
      "slug": {"url": "https://.../index.m3u8", "timestamp": "2025-09-04T16:18:54.804732+00:00"},
      ...
    }
    Также понимает старые варианты: {"slug": "https://..." } или {"slug": {"m3u8": "...", "checked_at": 123...}}
    Внутреннее представление: {"url": str, "timestamp": iso8601, "source_url": Optional[str]}
    """
    global _m3u8_cache
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        _m3u8_cache = {}
        return _m3u8_cache
    except Exception as e:
        print(f"[!] Ошибка чтения m3u8_cache.json: {e}")
        _m3u8_cache = {}
        return _m3u8_cache

    cache = {}
    if isinstance(raw, dict):
        for slug, v in raw.items():
            if isinstance(v, str):
                cache[slug] = {
                    "url": v,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "source_url": None
                }
            elif isinstance(v, dict):
                url = v.get("url") or v.get("m3u8") or v.get("link")
                # преобразуем возможный checked_at(int) -> ISO8601
                ts = v.get("timestamp")
                if not ts:
                    ca = v.get("checked_at")
                    if ca:
                        try:
                            ts = datetime.fromtimestamp(int(ca), tz=timezone.utc).isoformat()
                        except Exception:
                            ts = None
                cache[slug] = {
                    "url": url,
                    "timestamp": ts or datetime.now(timezone.utc).isoformat(),
                    "source_url": v.get("source_url") or v.get("page") or None
                }
    _m3u8_cache = {k: v for k, v in cache.items() if v.get("url")}
    return _m3u8_cache

def save_m3u8_cache(path: str = M3U8_CACHE_PATH) -> None:
    """
    Сохраняем в том же простом формате: {"slug": {"url": "...", "timestamp": "..."}}
    (source_url не обязателен — опускаем, чтобы не менять привычный вид файла)
    """
    tmp = path + ".tmp"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        out = {slug: {"url": v.get("url"), "timestamp": v.get("timestamp")}
               for slug, v in _m3u8_cache.items() if v.get("url")}
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except Exception as e:
        print(f"[!] Не удалось сохранить кэш {path}: {e}")

def cache_get(slug: str):
    return _m3u8_cache.get(slug)

def cache_set(slug: str, m3u8_url: str, source_url: str | None = None):
    _m3u8_cache[slug] = {
        "url": m3u8_url,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "source_url": source_url
    }

def validate_m3u8_url(m3u8_url: str, timeout: int = 8) -> bool:
    headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    try:
        r = requests.head(m3u8_url, headers=headers, timeout=timeout, allow_redirects=True)
        if 200 <= r.status_code < 300:
            ct = (r.headers.get("Content-Type") or "").lower()
            if ("mpegurl" in ct) or ("vnd.apple.mpegurl" in ct) or ("octet-stream" in ct) or m3u8_url.lower().endswith(".m3u8"):
                return True
        # некоторые CDN не любят HEAD: проверим GET
        r = requests.get(m3u8_url, headers=headers, timeout=timeout, allow_redirects=True, stream=True)
        if 200 <= r.status_code < 300:
            ct = (r.headers.get("Content-Type") or "").lower()
            if ("mpegurl" in ct) or ("vnd.apple.mpegurl" in ct) or ("octet-stream" in ct) or m3u8_url.lower().endswith(".m3u8"):
                try:
                    chunk = next(r.iter_content(chunk_size=512))
                    return bool(chunk)
                except Exception:
                    return True
        return False
    except Exception:
        return False


# ------------------ JS-ЭКСТРАКТОР ------------------

def run_js_extractor(page_url: str, script_path: str, timeout_sec: int) -> list:
    script_path = _resolve_script_path(script_path)
    if not os.path.isfile(script_path):
        print(f"⛔ JS-скрипт не найден: {script_path}")
        return []

    cmd = [NODE_BIN, script_path, page_url, str(max(1, int(timeout_sec)))]
    proc = None
    stdout = stderr = ""
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
            cwd=os.path.dirname(script_path) or EXTRACTOR_DIR,
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
        killed = kill_orphan_chrome()
        if killed:
            print(f"  🧹 Убито осиротевших Chrome: {killed}")
        try:
            if proc and proc.poll() is None:
                proc.kill()
        except Exception:
            pass
        try:
            if proc and proc.stdout:
                proc.stdout.close()
            if proc and proc.stderr:
                proc.stderr.close()
        except Exception:
            pass
        time.sleep(0.05)

    text = ((stdout or "") + "\n" + (stderr or "")).strip()
    if not text:
        return []

    streams = []
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

# ------------------ ПОИСК ПОТОКА (КЭШ -> JS) ------------------

def get_live_stream_url(channel_url, slug=None, script_path=None, timeout_sec=None):
    """
    Порядок:
      1) если в кэше есть m3u8 и он рабочий — вернуть его (без запуска JS);
      2) иначе выбрать JS по site_controller.json и запустить его;
         при успехе — обновить кэш;
      3) при неудаче — сохранить HTML в error/{slug}.html и вернуть None.
    """
    # 1) кэш
    if slug:
        entry = cache_get(slug)
        if entry and entry.get("m3u8"):
            m3u8 = entry["m3u8"]
            if validate_m3u8_url(m3u8):
                # обновим отметку проверки
                cache_set(slug, m3u8, entry.get("source_url"))
                return m3u8

    # 2) JS
    if script_path is None or timeout_sec is None:
        site_script, site_timeout = pick_js_for_url(channel_url)
        script_path = script_path or site_script
        timeout_sec = timeout_sec or site_timeout

    script_path = _resolve_script_path(script_path)
    timeout_sec = int(timeout_sec)

    try:
        streams = run_js_extractor(channel_url, script_path, timeout_sec)
        if streams:
            first = streams[0]
            if slug:
                cache_set(slug, first, source_url=channel_url)
                save_m3u8_cache()
            return first
    except Exception as e:
        print(f"[!] Ошибка JS-экстрактора для {channel_url}: {e}")

    # 3) дамп HTML для отладки
    if slug:
        try:
            headers = {"User-Agent": USER_AGENT, "Accept": "text/html,*/*"}
            r = requests.get(channel_url, headers=headers, timeout=15, allow_redirects=True)
            if r.ok:
                with open(os.path.join(ERROR_DIR, f"{slug}.html"), "w", encoding="utf-8", errors="ignore") as f:
                    f.write(r.text)
        except Exception:
            pass

    return None

# ------------------ M3U УТИЛИТЫ ------------------

STREAM_LINE_RE = re.compile(
    r'^(?:https?://)?127\.0\.0\.1:5000/stream/([^\s/#?]+)\s*$',
    re.IGNORECASE
)

def read_existing_slugs(m3u_path: str) -> set:
    if not os.path.exists(m3u_path) or os.stat(m3u_path).st_size == 0:
        return set()
    try:
        with open(m3u_path, "r", encoding="utf-8", errors="ignore") as f:
            data = f.read().splitlines()
        slugs = set()
        for line in data:
            m = STREAM_LINE_RE.match(line.strip())
            if m:
                slugs.add(m.group(1))
        return slugs
    except Exception:
        return set()

def ensure_header(m3u_path: str):
    if not os.path.exists(m3u_path) or os.stat(m3u_path).st_size == 0:
        os.makedirs(os.path.dirname(m3u_path), exist_ok=True)
        with open(m3u_path, "a", encoding="utf-8") as f:
            f.write("#EXTM3U\n")
        return
    try:
        with open(m3u_path, "r+", encoding="utf-8", errors="ignore") as f:
            head = f.read(16)
            if "#EXTM3U" not in head:
                f.seek(0)
                rest = head + f.read()
                f.seek(0)
                f.write("#EXTM3U\n" + rest)
    except Exception:
        pass

def sync_extinf_names(m3u_path: str, slug_to_name: dict) -> int:
    if not os.path.exists(m3u_path) or os.stat(m3u_path).st_size == 0:
        return 0
    try:
        with open(m3u_path, "r", encoding="utf-8", errors="ignore") as f:
            lines = f.readlines()
    except Exception:
        return 0

    changed = 0
    n = len(lines)
    for i in range(n):
        line = lines[i].strip()
        m = STREAM_LINE_RE.match(line)
        if not m:
            continue
        slug = m.group(1)
        new_name = slug_to_name.get(slug)
        if not new_name:
            continue
        j = i - 1
        while j >= 0 and lines[j].strip() == "":
            j -= 1
        if j < 0:
            continue
        if not lines[j].startswith("#EXTINF:-1"):
            continue
        new_extinf = f'#EXTINF:-1 tvg-name="{new_name}" group-title="OnlineTV",{new_name}\n'
        if lines[j] != new_extinf:
            lines[j] = new_extinf
            changed += 1

    if changed:
        try:
            with open(m3u_path, "w", encoding="utf-8") as f:
                f.writelines(lines)
        except Exception:
            return 0
    return changed

def prune_missing_slugs(m3u_path: str, allowed_slugs: set) -> int:
    if not os.path.exists(m3u_path) or os.stat(m3u_path).st_size == 0:
        return 0
    try:
        with open(m3u_path, "r", encoding="utf-8", errors="ignore") as f:
            lines = f.readlines()
    except Exception:
        return 0

    new_lines = []
    i = 0
    removed = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        m = STREAM_LINE_RE.match(line.strip())
        if m:
            slug = m.group(1)
            if slug not in allowed_slugs:
                while new_lines and new_lines[-1].strip() == "":
                    new_lines.pop()
                if new_lines and new_lines[-1].startswith("#EXTINF:-1"):
                    new_lines.pop()
                i += 1
                while i < n and lines[i].strip() == "":
                    i += 1
                removed += 1
                continue
        new_lines.append(line)
        i += 1

    if removed:
        try:
            with open(m3u_path, "w", encoding="utf-8") as f:
                f.writelines(new_lines)
        except Exception:
            return 0
    return removed

# ------------------ ОСНОВНОЙ ПАЙПЛАЙН ------------------

def update_playlist():
    """
    - Синхронизация m3u с config/channels.json:
        * удаление отсутствующих каналов;
        * обновление #EXTINF по именам;
        * дозаполнение недостающих каналов в m3u/<domain>.m3u.
      Поиск потока: сначала m3u8_cache.json (валидация), затем JS из site_controller.json.
    """
    if not os.path.exists(CHANNELS_PATH):
        print(f"[X] channels.json не найден: {CHANNELS_PATH}")
        return
    try:
        with open(CHANNELS_PATH, "r", encoding="utf-8") as f:
            channel_map = json.load(f)
    except Exception as e:
        print(f"[!] Ошибка чтения channels.json: {e}")
        return

    load_m3u8_cache()  # поднимем кэш

    valid_slugs = set(channel_map.keys())

    # domain -> list of (slug, name, url, script_path, timeout)
    by_domain = defaultdict(list)
    for slug, entry in channel_map.items():
        name = entry["name"]
        url = entry["url"]
        domain = _domain_from_url(url)
        script_path, timeout = pick_js_for_url(url)
        # опциональный оверрайд из channels.json
        if "script" in entry:
            script_path = _resolve_script_path(entry["script"])
        if "timeout_sec" in entry:
            try:
                timeout = int(entry["timeout_sec"])
            except Exception:
                pass
        by_domain[domain].append((slug, name, url, script_path, timeout))

    domain_files = { os.path.join(M3U_DIR, f"{d}.m3u") for d in by_domain.keys() }
    for fname in [p for p in os.listdir(M3U_DIR) if p.endswith(".m3u")]:
        domain_files.add(os.path.join(M3U_DIR, fname))

    for m3u_path in sorted(domain_files):
        ensure_header(m3u_path)

        removed = prune_missing_slugs(m3u_path, valid_slugs)
        if removed:
            print(f"• {os.path.basename(m3u_path)}: удалено устаревших каналов: {removed}")

        domain = os.path.splitext(os.path.basename(m3u_path))[0]
        rows = by_domain.get(domain, [])

        slug_to_name = {slug: name for slug, name, *_ in rows}
        renamed = sync_extinf_names(m3u_path, slug_to_name)
        if renamed:
            print(f"• {os.path.basename(m3u_path)}: обновлено имён EXTINF: {renamed}")

        present_slugs = read_existing_slugs(m3u_path)
        to_add = [(slug, name, url, script, timeout)
                  for (slug, name, url, script, timeout) in rows
                  if slug not in present_slugs]

        if not to_add:
            if not removed and not renamed:
                print(f"• {os.path.basename(m3u_path)}: всё уже актуально, изменений нет.")
            continue

        print(f"• {os.path.basename(m3u_path)}: новых каналов: {len(to_add)}")
        appended = 0
        with open(m3u_path, "a", encoding="utf-8") as f:
            for slug, name, url, script, timeout in to_add:
                print(f"  → Добавляем: {name} ({slug})")
                stream = get_live_stream_url(url, slug=slug, script_path=script, timeout_sec=timeout)
                if stream:
                    f.write(f'#EXTINF:-1 tvg-name="{name}" group-title="OnlineTV",{name}\n')
                    f.write(f"http://127.0.0.1:5000/stream/{slug}\n\n")
                    appended += 1
                    print("    ✓ Добавлено")
                else:
                    print("    ⚠ Поток не найден, пропущено (дамп в error/)")
        if appended:
            print(f"  ✔ В {os.path.basename(m3u_path)} добавлено записей: {appended}")

    # финально — сохранить кэш, на случай если обновляли где-то ещё
    save_m3u8_cache()

# ------------------ Точка входа ------------------

if __name__ == "__main__":
    print("🔧 Обновление плейлистов на основе config/channels.json...")
    SITE_CONTROLLER = load_site_controller()  # перезагрузка на случай правок
    update_playlist()
    print("✅ Готово.")
