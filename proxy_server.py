# -*- coding: utf-8 -*-
from flask import (
    Flask,
    abort,
    jsonify,
    redirect,
    render_template_string,
    send_file,
)
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
import sys

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

# TTL кэша (в секундах) — чтобы избегать навечно застрявших ссылок.
CACHE_TTL_SEC = int(os.environ.get("CACHE_TTL_SEC", "900"))  # 15 минут по умолчанию

# Настройки HTTP-сервера Flask
PROXY_HOST = os.environ.get("PROXY_HOST", "0.0.0.0")
PROXY_PORT = int(os.environ.get("PROXY_PORT", "6060"))

# Команды, доступные из веб-интерфейса
PYTHON_BIN = os.environ.get("PYTHON_BIN", sys.executable or "python")


def _script_path(name: str) -> str:
    return os.path.join(BASE_DIR, name)


ACTION_CATALOG: dict[str, dict] = {
    "update-playlists": {
        "label": "Обновить плейлисты",
        "description": "Запускает update_playlist.py, пересобирая M3U-файлы из channels.json",
        "command": [PYTHON_BIN, _script_path("update_playlist.py")],
        "timeout": int(os.environ.get("ACTION_TIMEOUT_UPDATE", "300")),
    },
    "validate-playlists": {
        "label": "Проверить плейлисты",
        "description": "Выполняет тест m3u потоков (test_m3u_playlists.py)",
        "command": [PYTHON_BIN, _script_path("test_m3u_playlists.py")],
        "timeout": int(os.environ.get("ACTION_TIMEOUT_VALIDATE", "420")),
    },
    "python-tests": {
        "label": "Python unit-тесты",
        "description": "Запускает python -m unittest discover",
        "command": [PYTHON_BIN, "-m", "unittest", "discover"],
        "timeout": int(os.environ.get("ACTION_TIMEOUT_PYTEST", "420")),
    },
    "extractor-tests": {
        "label": "JS тесты экстракторов",
        "description": "Выполняет npm test",
        "command": ["npm", "test"],
        "timeout": int(os.environ.get("ACTION_TIMEOUT_JS", "420")),
    },
}

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


def _list_playlists() -> list[str]:
    """Возвращает список файлов плейлистов (без путей)."""
    if not os.path.isdir(M3U_DIR):
        return []
    items = []
    for entry in os.listdir(M3U_DIR):
        if entry.lower().endswith(".m3u"):
            items.append(entry)
    return sorted(items)


def _load_channels_safe() -> dict:
    """Загружает channels.json, не выбрасывая исключения."""
    if not os.path.exists(CHANNELS_FILE):
        return {}
    try:
        with open(CHANNELS_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


DASHBOARD_TEMPLATE = """<!doctype html>
<html lang=\"ru\">
  <head>
    <meta charset=\"utf-8\">
    <title>LunaTV · Панель управления</title>
    <style>
      :root { color-scheme: dark light; }
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
      header { padding: 24px; background: linear-gradient(135deg, #1e293b, #0f172a); box-shadow: 0 4px 18px rgba(15,23,42,0.4); }
      h1 { margin: 0 0 8px 0; font-size: 2.1rem; }
      main { padding: 24px; display: grid; gap: 24px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
      section { background: rgba(15,23,42,0.85); border-radius: 18px; padding: 20px; box-shadow: 0 8px 24px rgba(15,23,42,0.55); border: 1px solid rgba(148, 163, 184, 0.12); backdrop-filter: blur(6px); }
      section h2 { margin-top: 0; font-size: 1.3rem; }
      ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
      li { padding: 12px; border-radius: 12px; border: 1px solid rgba(148, 163, 184, 0.14); background: rgba(30,41,59,0.65); display: flex; flex-direction: column; gap: 8px; }
      button { align-self: flex-start; padding: 8px 16px; border-radius: 999px; border: none; background: #38bdf8; color: #0f172a; font-weight: 600; cursor: pointer; box-shadow: 0 6px 18px rgba(56,189,248,0.4); transition: transform 0.2s ease, box-shadow 0.2s ease; }
      button:hover { transform: translateY(-1px); box-shadow: 0 10px 24px rgba(56,189,248,0.55); }
      button[disabled] { opacity: 0.4; cursor: not-allowed; box-shadow: none; }
      .badge { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.08em; color: rgba(148, 163, 184, 0.7); }
      .output { white-space: pre-wrap; font-family: 'Fira Code', 'SFMono-Regular', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; background: rgba(15,23,42,0.85); padding: 16px; border-radius: 12px; border: 1px solid rgba(148, 163, 184, 0.12); max-height: 320px; overflow: auto; }
      .status-ok { color: #34d399; }
      .status-fail { color: #f87171; }
      .status-running { color: #fbbf24; }
      a { color: #38bdf8; text-decoration: none; }
      a:hover { text-decoration: underline; }
    </style>
  </head>
  <body>
    <header>
      <h1>📺 LunaTV</h1>
      <div class=\"badge\">Панель управления · http://{{ host }}:{{ port }}</div>
    </header>
    <main>
      <section>
        <h2>Быстрые действия</h2>
        <ul id=\"actions\"></ul>
      </section>
      <section>
        <h2>Плейлисты</h2>
        <ul id=\"playlists\"><li>Загрузка…</li></ul>
      </section>
      <section>
        <h2>Каналы</h2>
        <ul id=\"channels\"><li>Загрузка…</li></ul>
      </section>
      <section style=\"grid-column: 1 / -1;\">
        <h2>Вывод последней команды</h2>
        <div id=\"statusLine\" class=\"badge\">Нет запущенных задач</div>
        <pre id=\"commandOutput\" class=\"output\">—</pre>
      </section>
    </main>

    <script>
      const actionListEl = document.getElementById('actions');
      const playlistEl = document.getElementById('playlists');
      const channelEl = document.getElementById('channels');
      const statusEl = document.getElementById('statusLine');
      const outputEl = document.getElementById('commandOutput');

      async function loadMeta() {
        const [actionsResp, playlistsResp, channelsResp] = await Promise.all([
          fetch('/api/actions'),
          fetch('/api/playlists'),
          fetch('/api/channels'),
        ]);
        const actions = await actionsResp.json();
        const playlists = await playlistsResp.json();
        const channels = await channelsResp.json();

        renderActions(actions.items || []);
        renderPlaylists(playlists.items || []);
        renderChannels(channels.items || []);
      }

      function renderActions(items) {
        if (!items.length) {
          actionListEl.innerHTML = '<li>Действия не настроены</li>';
          return;
        }
        actionListEl.innerHTML = '';
        for (const item of items) {
          const li = document.createElement('li');
          const title = document.createElement('div');
          title.innerHTML = `<strong>${item.label}</strong>`;
          const desc = document.createElement('div');
          desc.textContent = item.description;
          const btn = document.createElement('button');
          btn.textContent = 'Запустить';
          btn.disabled = !item.available;
          btn.addEventListener('click', () => runAction(item.id, btn));
          if (!item.available) {
            const hint = document.createElement('div');
            hint.className = 'badge status-fail';
            hint.textContent = 'Недоступно на текущей конфигурации';
            li.appendChild(hint);
          }
          li.appendChild(title);
          li.appendChild(desc);
          li.appendChild(btn);
          actionListEl.appendChild(li);
        }
      }

      function renderPlaylists(items) {
        if (!items.length) {
          playlistEl.innerHTML = '<li>Пока нет файлов .m3u</li>';
          return;
        }
        playlistEl.innerHTML = '';
        for (const name of items) {
          const li = document.createElement('li');
          const link = document.createElement('a');
          link.href = `/playlist/${encodeURIComponent(name)}`;
          link.textContent = name;
          li.appendChild(link);
          playlistEl.appendChild(li);
        }
      }

      function renderChannels(items) {
        if (!items.length) {
          channelEl.innerHTML = '<li>channels.json не найден или пуст</li>';
          return;
        }
        channelEl.innerHTML = '';
        for (const channel of items) {
          const li = document.createElement('li');
          li.innerHTML = `<strong>${channel.slug}</strong>${channel.name ? ' — ' + channel.name : ''}`;
          channelEl.appendChild(li);
        }
      }

      async function runAction(id, btn) {
        btn.disabled = true;
        statusEl.textContent = 'Выполняется…';
        statusEl.className = 'badge status-running';
        outputEl.textContent = '';
        try {
          const resp = await fetch(`/api/actions/${encodeURIComponent(id)}`, { method: 'POST' });
          const data = await resp.json();
          if (data.output) {
            outputEl.textContent = data.output;
          } else if (data.error) {
            outputEl.textContent = data.error;
          } else {
            outputEl.textContent = JSON.stringify(data, null, 2);
          }
          if (data.ok) {
            statusEl.textContent = `Успешно · ${(data.duration || 0).toFixed(1)}s`;
            statusEl.className = 'badge status-ok';
          } else {
            const reason = data.error || `Код ${data.returncode}`;
            statusEl.textContent = `Ошибка · ${reason}`;
            statusEl.className = 'badge status-fail';
          }
        } catch (err) {
          statusEl.textContent = `Ошибка запроса: ${err}`;
          statusEl.className = 'badge status-fail';
          outputEl.textContent = '';
        } finally {
          btn.disabled = false;
          loadMeta();
        }
      }

      loadMeta();
    </script>
  </body>
</html>"""

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
            # Убиваем только процессы, "зависшие" дольше порога.
            # Ранее логика была инвертирована и пропускала старые chrome.
            if _proc_age_sec(pid) < max_age_sec:
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


def _summarize_action(action_id: str, meta: dict) -> dict:
    """Готовит JSON-описание команды для фронтенда."""
    command = meta.get("command", [])
    available = True
    if command:
        bin_name = command[0]
        if os.path.isabs(bin_name):
            available = os.path.exists(bin_name)
        elif bin_name.endswith(".py"):
            available = os.path.exists(bin_name)
        # если команда обращается к скрипту, проверим второй элемент
        if available and len(command) >= 2 and command[0] in {PYTHON_BIN, "python", "python3"}:
            script_path = command[1]
            if script_path != "-m" and script_path.endswith(".py"):
                available = os.path.exists(script_path)
    return {
        "id": action_id,
        "label": meta.get("label", action_id),
        "description": meta.get("description", ""),
        "available": bool(available),
    }


def _run_action(meta: dict) -> dict:
    """Запускает команду и возвращает результат для JSON."""
    command = meta.get("command")
    timeout = int(meta.get("timeout", 300))
    started = time.time()
    if not command:
        return {
            "ok": False,
            "error": "Команда не задана",
        }
    try:
        proc = subprocess.Popen(
            command,
            cwd=BASE_DIR,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
    except FileNotFoundError as exc:
        return {
            "ok": False,
            "error": f"Не найдена команда: {exc}",
        }
    except Exception as exc:
        return {
            "ok": False,
            "error": f"Не удалось запустить процесс: {exc}",
        }

    timed_out = False
    output = ""
    try:
        output, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            proc.kill()
        except Exception:
            pass
        try:
            output, _ = proc.communicate(timeout=5)
        except Exception:
            output = output or ""
    except Exception as exc:
        output = f"Ошибка исполнения: {exc}"

    duration = time.time() - started
    rc = proc.poll()
    return {
        "ok": (rc == 0) and not timed_out,
        "returncode": rc,
        "timedOut": timed_out,
        "duration": duration,
        "output": output,
    }

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
        except Exception as e:
            print(f"[cache] не удалось прочитать {CACHE_FILE}: {e}")
            return {}
    return {}

def save_cache(cache):
    try:
        os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[!] Не удалось сохранить кэш: {e}")


def _cache_entry_is_fresh(entry: dict) -> bool:
    """Проверяет, не протухла ли запись кэша по таймстемпу."""
    if CACHE_TTL_SEC <= 0:
        return True
    if not isinstance(entry, dict):
        return False
    ts = entry.get("timestamp")
    if not ts:
        return False
    try:
        when = datetime.fromisoformat(ts)
    except Exception:
        return False
    age = (datetime.utcnow() - when).total_seconds()
    return age <= CACHE_TTL_SEC

def is_m3u8_alive(url, referer=None):
    try:
        headers = {"User-Agent": USER_AGENT}
        if referer:
            headers["Referer"] = referer
        r = requests.head(url, timeout=5, allow_redirects=True, headers=headers)
        try:
            # HEAD не всегда даёт content-type для HLS; подстрахуемся GET'ом маленького чанка
            if r.status_code == 200 and "mpegurl" in r.headers.get("Content-Type", "").lower():
                return True
        finally:
            r.close()

        # fallback: небольшой GET и проверка сигнатуры
        r2 = requests.get(url, timeout=7, headers=headers, stream=True, allow_redirects=True)
        try:
            chunk = next(r2.iter_content(chunk_size=2048), b"")
        finally:
            r2.close()
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
def dashboard():
    """Главная страница с панелью управления."""
    return render_template_string(
        DASHBOARD_TEMPLATE,
        host=PROXY_HOST,
        port=PROXY_PORT,
    )


@app.route("/playlists")
def list_playlists_page():
    files = _list_playlists()
    if not files:
        return "<h2>Плейлисты</h2><p>Каталог пуст.</p>"
    items = "".join(
        f"<li><a href='/playlist/{f}'>{f}</a></li>" for f in files
    )
    return f"<h2>Плейлисты</h2><ul>{items}</ul>"


@app.route("/api/actions", methods=["GET"])
def api_list_actions():
    payload = [_summarize_action(k, v) for k, v in ACTION_CATALOG.items()]
    return jsonify({"items": payload})


@app.route("/api/actions/<action_id>", methods=["POST"])
def api_run_action(action_id):
    meta = ACTION_CATALOG.get(action_id)
    if not meta:
        return jsonify({"ok": False, "error": f"Неизвестное действие: {action_id}"}), 404
    result = _run_action(meta)
    return jsonify(result)


@app.route("/api/playlists", methods=["GET"])
def api_playlists():
    return jsonify({"items": _list_playlists()})


@app.route("/api/channels", methods=["GET"])
def api_channels():
    items = []
    for slug, meta in _load_channels_safe().items():
        name = ""
        if isinstance(meta, dict):
            name = meta.get("title") or meta.get("name") or ""
        items.append({"slug": slug, "name": name})
    items.sort(key=lambda x: x["slug"])
    return jsonify({"items": items})

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
        if not _cache_entry_is_fresh(cached):
            print("🗑️ Кэш просрочен, нужен новый поток.")
        else:
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
    print(f"\n🚀 Прокси запущен: http://{PROXY_HOST}:{PROXY_PORT}")
    app.run(host=PROXY_HOST, port=PROXY_PORT)
