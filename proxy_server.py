# -*- coding: utf-8 -*-
from flask import Flask, redirect, abort, send_file
from urllib.parse import urlparse
from datetime import datetime
import re
import json
import os
import time
import glob
import shutil
import subprocess
import signal
import requests
import fnmatch  # ⬅️ для сопоставления масок хостов (*.example.com)

app = Flask(__name__)

# ------------------ НАСТРОЙКИ ПУТЕЙ ------------------

# Базовая директория проекта (по умолчанию — текущая)
BASE_DIR = os.path.abspath(os.environ.get("BASE_DIR", "."))

# Каталоги по новой структуре
EXTRACTOR_DIR = os.path.abspath(os.environ.get("EXTRACTOR_DIR", os.path.join(BASE_DIR, "extractor")))
M3U_DIR       = os.path.abspath(os.environ.get("M3U_DIR",       os.path.join(BASE_DIR, "m3u")))
CONFIG_DIR    = os.path.abspath(os.environ.get("CONFIG_DIR",    os.path.join(BASE_DIR, "config")))

# Файлы конфигурации в каталоге config
CHANNELS_FILE        = os.path.join(CONFIG_DIR, "channels.json")
CACHE_FILE           = os.path.join(CONFIG_DIR, "m3u8_cache.json")
SITE_CONTROLLER_FILE = os.path.join(CONFIG_DIR, "site_controller.json")

# ------------------ ПРОЧИЕ НАСТРОЙКИ ------------------

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

# JS-экстрактор (Node) — дефолт на случай отсутствия site_controller.json
NODE_BIN = os.environ.get("NODE_BIN", "node")  # укажи абсолютный путь, если нужно
JS_EXTRACTOR_NAME = os.environ.get("JS_EXTRACTOR", "smotru-m3u-one-stealth.js")
JS_EXTRACTOR_PATH = os.path.join(EXTRACTOR_DIR, JS_EXTRACTOR_NAME)
JS_TIMEOUT_SEC = int(os.environ.get("JS_TIMEOUT_SEC", "10"))

# Очистка мусора Puppeteer/Chromium
ORPHAN_CHROME_MAX_AGE_SEC = 180
CLEAN_TMP_AFTER_JS = True
TMP_PATTERNS = ("/tmp/puppeteer_*", "/tmp/.org.chromium.*", "/dev/shm/.org.chromium.*")

# ------------------ УТИЛИТЫ ЧИСТКИ ------------------

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
    """
    Убивает осиротевшие процессы chrome/chromium (обычно оставленные Puppeteer):
    - ppid == 1,
    - имя/командная строка содержит chrome/chromium,
    - и есть маркеры puppeteer/headless.
    """
    victims = 0
    name_mark = ("chrome", "chromium", "chromium-browser")
    puppet_mark = ("puppeteer", "/tmp/puppeteer_", ".org.chromium", "--remote-debugging", "--headless")
    for pid in list(_list_pids() or []):
        try:
            if _proc_ppid(pid) != 1:
                continue
            comm = _proc_comm(pid).lower()
            cmd = _proc_cmdline(pid).lower()
            if not any(m in comm or m in cmd for m in name_mark):
                continue
            if not any(m in cmd for m in puppet_mark):
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

# ------------------ SITE CONTROLLER ------------------

def _load_site_controller() -> dict:
    """Читает config/site_controller.json и возвращает dict (или {})."""
    try:
        with open(SITE_CONTROLLER_FILE, "r", encoding="utf-8") as f:
            data = json.load(f) or {}
            if isinstance(data, dict):
                return data
    except Exception as e:
        print(f"[site_controller] не удалось прочитать {SITE_CONTROLLER_FILE}: {e}")
    return {}

def _to_list(v):
    if v is None:
        return []
    if isinstance(v, (list, tuple)):
        return [str(x) for x in v if str(x).strip()]
    s = str(v).strip()
    return [s] if s else []

def _abs_in_extractor_dir(names_or_paths):
    """Преобразует имена скриптов в абсолютные пути из extractor/."""
    out = []
    for name in names_or_paths:
        p = name
        if not os.path.isabs(p) and os.path.dirname(p) == "":
            p = os.path.join(EXTRACTOR_DIR, p)
        out.append(os.path.abspath(p))
    return out

def _pick_host_conf(sc: dict, host: str) -> dict:
    """
    Выбор секции в site_controller.json по host:
      1) точное совпадение host
      2) apex-домен (example.com)
      3) ключи-маски (*.example.com) через fnmatch
      4) 'default'
    """
    if not host:
        return sc.get("default") or {}
    if host in sc and isinstance(sc[host], dict):
        return sc[host]
    parts = host.split(".")
    if len(parts) >= 2:
        apex = ".".join(parts[-2:])
        if apex in sc and isinstance(sc[apex], dict):
            return sc[apex]
    for key, val in sc.items():
        if key == "default":
            continue
        if isinstance(val, dict) and ("*" in key or "?" in key):
            if fnmatch.fnmatch(host, key):
                return val
    return sc.get("default") or {}

def resolve_extractors_and_timeout_for_url(referer_url: str):
    """
    Возвращает (список_путей_скриптов, timeout_sec) для данного URL
    на основе config/site_controller.json, с дефолтом на переменные окружения.
    """
    sc = _load_site_controller()
    try:
        host = urlparse(referer_url).hostname or ""
    except Exception:
        host = ""
    conf = _pick_host_conf(sc, host)
    scripts = _to_list(conf.get("script")) or _to_list(JS_EXTRACTOR_NAME)
    timeout = int(conf.get("timeout_sec") or JS_TIMEOUT_SEC)
    return _abs_in_extractor_dir(scripts), max(1, timeout)

# ------------------ JS-ЭКСТРАКТОР ------------------

def run_js_extractor(page_url: str, script_path: str, timeout_sec: int) -> list:
    """
    node <script_path> <page_url> [<timeout_sec>]
    - для cdnpotok.js передаем ТОЛЬКО <page_url> (это referer),
      он сам найдет запись в channels.json и вернет финальную ссылку
    """
    script_path = os.path.abspath(script_path)
    if not os.path.isfile(script_path):
        print(f"⛔ JS-скрипт не найден: {script_path}")
        return []

    argv = [NODE_BIN, script_path]
    if os.path.basename(script_path) == "cdnpotok.js":
        argv += [page_url]                     # только реферер!
    else:
        argv += [page_url, str(max(1, int(timeout_sec)))]

    proc = None
    stdout = stderr = ""
    try:
        proc = subprocess.Popen(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
            cwd=os.path.dirname(script_path) or None,  # для относительных require и __dirname
        )
        try:
            stdout, stderr = proc.communicate(timeout=timeout_sec + 2)
        except subprocess.TimeoutExpired:
            try: os.killpg(proc.pid, signal.SIGKILL)
            except Exception: 
                try: proc.kill()
                except Exception: pass
            stdout, stderr = proc.communicate()
        except Exception:
            try: os.killpg(proc.pid, signal.SIGKILL)
            except Exception:
                try: proc.kill()
                except Exception: pass
            try: stdout, stderr = proc.communicate(timeout=1)
            except Exception: stdout, stderr = "", ""
    finally:
        cleanup_tmp()
        killed = kill_orphan_chrome()
        if killed: print(f"  🧹 Убито осиротевших Chrome: {killed}")
        try:
            if proc and proc.poll() is None: proc.kill()
        except Exception: pass
        try:
            if proc and proc.stdout: proc.stdout.close()
            if proc and proc.stderr: proc.stderr.close()
        except Exception: pass

    text = ((stdout or "") + "\n" + (stderr or "")).strip()
    if not text:
        return []

    # 1) пробуем JSON
    try:
        j = json.loads(text)
        if isinstance(j, list):
            streams = [str(x) for x in j]
        elif isinstance(j, dict):
            arr = j.get("streams") or j.get("links") or j.get("m3u8") or []
            if isinstance(arr, list):
                streams = [str(x) for x in arr]
            else:
                streams = []
        else:
            streams = []
    except Exception:
        # 2) fallback: ловим любые URL и фильтруем по .m3u8
        urls = re.findall(r'https?://[^\s<>"\'\)\]]+', text)
        streams = [u for u in urls if ".m3u8" in u.lower()]

    # уникализируем, сохраняем порядок
    uniq, seen = [], set()
    for u in streams:
        if u not in seen:
            seen.add(u)
            uniq.append(u)
    return uniq


def try_extract_with_any(page_url: str, extractor_paths: list[str], timeout_sec: int) -> str | None:
    """Пробует список экстракторов по очереди, возвращает первый успешный .m3u8."""
    seen = set()
    for path in extractor_paths:
        if path in seen:
            continue
        seen.add(path)
        streams = run_js_extractor(page_url, path, timeout_sec)
        if streams:
            print(f"✅ Экстрактор сработал: {os.path.basename(path)} (timeout={timeout_sec}s)")
            return streams[0]
        else:
            print(f"➡️  Нет результата от: {os.path.basename(path)}")
    return None

# ------------------ ДОМЕННАЯ ЛОГИКА ------------------

def get_live_stream_url(channel_url, extractor_paths: list[str], timeout_sec: int, slug=None):
    """
    Вместо Selenium:
      - запускает JS-экстрактор(ы) для channel_url,
      - возвращает ПЕРВУЮ найденную .m3u8,
      - при неудаче — сохраняет HTML исходной страницы в error/{slug}.html (для отладки).
    """
    print(f"🟡 Загрузка потока для: {channel_url}")
    try:
        stream = try_extract_with_any(channel_url, extractor_paths, timeout_sec)
        if stream:
            return stream
    except Exception as e:
        print(f"[!] Ошибка работы экстрактора(ов): {e}")

    # Резервный дамп HTML, чтобы было что разбирать руками
    if slug:
        try:
            os.makedirs("error", exist_ok=True)
            headers = {"User-Agent": USER_AGENT, "Accept": "text/html,*/*"}
            r = requests.get(channel_url, headers=headers, timeout=15, allow_redirects=True)
            if r.ok:
                with open(f"error/{slug}.html", "w", encoding="utf-8", errors="ignore") as f:
                    f.write(r.text)
        except Exception:
            pass

    return None

def load_cache():
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

def save_cache(cache):
    try:
        os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[!] Не удалось сохранить кэш: {e}")

def is_m3u8_alive(url, referer=None):
    try:
        headers = {"User-Agent": USER_AGENT}
        if referer:
            headers["Referer"] = referer
        r = requests.head(url, timeout=5, allow_redirects=True, headers=headers)
        # HEAD не всегда даёт content-type для HLS; подстрахуемся GET'ом маленького чанка
        if r.status_code == 200 and "mpegurl" in r.headers.get("Content-Type", "").lower():
            return True
        # fallback: небольшой GET и проверка сигнатуры
        r2 = requests.get(url, timeout=7, headers=headers, stream=True, allow_redirects=True)
        chunk = next(r2.iter_content(chunk_size=2048), b"")
        txt = ""
        try:
            txt = chunk.decode("utf-8", errors="ignore")
        except Exception:
            pass
        return txt.startswith("#EXTM3U")
    except Exception:
        return False

# ------------------ HTTP-РОУТЫ ------------------

@app.route("/")
def index():
    try:
        files = []
        if os.path.isdir(M3U_DIR):
            files = sorted([f for f in os.listdir(M3U_DIR) if f.endswith(".m3u")])
        links = "\n".join([f"<li><a href='/playlist/{f}'>{f}</a></li>" for f in files]) or "<li>(пусто)</li>"
        return f"<h2>📺 Доступные плейлисты (из каталога m3u):</h2><ul>{links}</ul>"
    except Exception as e:
        return f"<h2>Ошибка чтения каталога плейлистов:</h2><pre>{e}</pre>"

@app.route("/playlist/<filename>")
def serve_playlist(filename):
    # защита от обхода путей
    safe_name = os.path.basename(filename)
    if not safe_name.endswith(".m3u"):
        safe_name += ".m3u"
    path = os.path.join(M3U_DIR, safe_name)
    if not os.path.exists(path):
        print(f"❌ Плейлист не найден: {path}")
        return abort(404, f"Плейлист {safe_name} не найден.")
    return send_file(path, mimetype="application/x-mpegURL")

@app.route("/stream/<channel_slug>")
def proxy(channel_slug):
    # читаем базу каналов из config/channels.json
    try:
        with open(CHANNELS_FILE, "r", encoding="utf-8") as f:
            channel_map = json.load(f)
    except FileNotFoundError:
        print(f"❌ Файл {CHANNELS_FILE} не найден.")
        return abort(500, "Файл channels.json не найден в каталоге config.")
    except Exception as e:
        print(f"❌ Ошибка чтения {CHANNELS_FILE}: {e}")
        return abort(500, "Ошибка чтения channels.json.")

    if channel_slug not in channel_map:
        print(f"❌ Не найден в базе: {channel_slug}")
        return abort(404, f"Канал '{channel_slug}' не найден в базе.")

    entry = channel_map[channel_slug]
    referer_url = entry["url"] if isinstance(entry, dict) else entry

    # --- выбор экстрактора и таймаута по site_controller.json ---
    extractor_paths, eff_timeout = resolve_extractors_and_timeout_for_url(referer_url)

    cache = load_cache()

    # Проверка кэша
    cached = cache.get(channel_slug)
    if cached:
        stream_url = cached.get("url")
        print(f"📁 Проверка кэшированной ссылки: {stream_url}")
        if stream_url and is_m3u8_alive(stream_url, referer=referer_url):
            print("✅ Используется кэш.")
            return redirect(stream_url, code=302)
        else:
            print("❌ Кэш устарел, пробуем заново.")

    # Получение новой ссылки через JS-экстрактор(ы)
    print(f"🔵 Запрос к каналу: {channel_slug}")
    stream_url = get_live_stream_url(referer_url, extractor_paths, eff_timeout, slug=channel_slug)

    if stream_url:
        # Сохраняем в кэш
        cache[channel_slug] = {
            "url": stream_url,
            "timestamp": datetime.utcnow().isoformat()
        }
        save_cache(cache)
        return redirect(stream_url, code=302)
    else:
        print(f"⚠️ Не удалось получить поток для: {channel_slug}")
        return abort(404, f"Не удалось получить поток для канала: {channel_slug}")

# ------------------ MAIN ------------------

if __name__ == "__main__":
    print("\n🚀 Прокси запущен: http://127.0.0.1:6060")
    app.run(host="127.0.0.1", port=6060)
