# -*- coding: utf-8 -*-
from flask import (
    Flask,
    abort,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
)
from urllib.parse import urlparse
from datetime import datetime, timezone
import re
import json
import os
import time
import glob
import shutil
import subprocess
import signal
import tempfile
import requests
import fnmatch  # ⬅️ для сопоставления масок хостов (*.example.com)
import sys
from typing import Any

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
JS_EXTRACTOR_NAME = os.environ.get("JS_EXTRACTOR", "universal-playwright-extractor.js")
JS_EXTRACTOR_PATH = os.path.join(EXTRACTOR_DIR, JS_EXTRACTOR_NAME)
JS_TIMEOUT_SEC = int(os.environ.get("JS_TIMEOUT_SEC", "10"))

# Очистка мусора Playwright/Chromium
ORPHAN_CHROME_MAX_AGE_SEC = 180
CLEAN_TMP_AFTER_JS = True
TMP_PATTERNS = (
    "/tmp/playwright*",
    "/tmp/.org.chromium.*",
    "/dev/shm/.org.chromium.*",
    "/tmp/ms-playwright*",
)

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
    "run-scanner": {
        "label": "Полный скан каналов",
        "description": "Запускает scaner.py с контроллером сайтов",
        "command": [PYTHON_BIN, _script_path("scaner.py")],
        "timeout": int(os.environ.get("ACTION_TIMEOUT_SCANNER", "900")),
    },
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


def _rebuild_action_commands() -> None:
    ACTION_CATALOG["run-scanner"]["command"] = [PYTHON_BIN, _script_path("scaner.py")]
    ACTION_CATALOG["update-playlists"]["command"] = [
        PYTHON_BIN,
        _script_path("update_playlist.py"),
    ]
    ACTION_CATALOG["validate-playlists"]["command"] = [
        PYTHON_BIN,
        _script_path("test_m3u_playlists.py"),
    ]
    ACTION_CATALOG["python-tests"]["command"] = [
        PYTHON_BIN,
        "-m",
        "unittest",
        "discover",
    ]
    ACTION_CATALOG["extractor-tests"]["command"] = ["npm", "test"]


_rebuild_action_commands()


def _refresh_js_extractor_path() -> None:
    global JS_EXTRACTOR_PATH
    JS_EXTRACTOR_PATH = os.path.join(EXTRACTOR_DIR, JS_EXTRACTOR_NAME)


_refresh_js_extractor_path()


SETTINGS_LAYOUT: list[dict[str, Any]] = [
    {
        "id": "paths",
        "title": "Каталоги и файлы",
        "description": "Указывают расположение конфигурации, экстракторов и готовых плейлистов.",
        "fields": [
            {
                "key": "BASE_DIR",
                "label": "BASE_DIR",
                "type": "text",
                "description": "Корневой каталог проекта. Меняйте только если сервис развёрнут в другом месте (требуется перезапуск).",
                "normalize": "path",
            },
            {
                "key": "EXTRACTOR_DIR",
                "label": "EXTRACTOR_DIR",
                "type": "text",
                "description": "Папка с JS-экстракторами Playwright.",
                "normalize": "path",
            },
            {
                "key": "M3U_DIR",
                "label": "M3U_DIR",
                "type": "text",
                "description": "Каталог, куда сохраняются сгенерированные M3U-плейлисты.",
                "normalize": "path",
            },
            {
                "key": "CONFIG_DIR",
                "label": "CONFIG_DIR",
                "type": "text",
                "description": "Каталог конфигурации (channels.json, site_controller.json, settings.json).",
                "normalize": "path",
            },
        ],
    },
    {
        "id": "proxy",
        "title": "Веб-панель",
        "description": "Параметры сервера управления LunaTV.",
        "fields": [
            {
                "key": "PROXY_HOST",
                "label": "PROXY_HOST",
                "type": "text",
                "description": "IP-адрес или hostname, на котором слушает Flask (по умолчанию 0.0.0.0).",
            },
            {
                "key": "PROXY_PORT",
                "label": "PROXY_PORT",
                "type": "number",
                "description": "Порт веб-панели. При изменении требуется перезапуск службы.",
                "attrs": {"min": 1, "max": 65535, "step": 1},
            },
        ],
    },
    {
        "id": "cache",
        "title": "Кэш потоков",
        "description": "Управляет временем жизни найденных ссылок, чтобы избежать устаревших потоков.",
        "fields": [
            {
                "key": "CACHE_TTL_SEC",
                "label": "CACHE_TTL_SEC",
                "type": "number",
                "description": "Время (в секундах), в течение которого результаты проверки потоков считаются свежими.",
                "attrs": {"min": 0, "step": 30},
                "unit": "сек.",
            },
        ],
    },
    {
        "id": "extractor",
        "title": "JS-экстрактор",
        "description": "Настройки запуска Playwright и скриптов извлечения ссылок.",
        "fields": [
            {
                "key": "NODE_BIN",
                "label": "NODE_BIN",
                "type": "text",
                "description": "Исполняемый файл Node.js, который будет запускать экстракторы.",
            },
            {
                "key": "JS_EXTRACTOR_NAME",
                "label": "JS_EXTRACTOR",
                "type": "text",
                "description": "Файл JS-экстрактора по умолчанию (относительно папки extractor/).",
            },
            {
                "key": "JS_TIMEOUT_SEC",
                "label": "JS_TIMEOUT_SEC",
                "type": "number",
                "description": "Предельное время ожидания Playwright перед прерыванием работы экстрактора.",
                "attrs": {"min": 1, "step": 1},
                "unit": "сек.",
            },
        ],
    },
    {
        "id": "runtime",
        "title": "Очистка и автоматизация",
        "description": "Параметры уборки временных файлов и завершения зависших процессов Chromium.",
        "fields": [
            {
                "key": "CLEAN_TMP_AFTER_JS",
                "label": "CLEAN_TMP_AFTER_JS",
                "type": "boolean",
                "description": "Удалять временные каталоги Playwright после завершения скриптов.",
            },
            {
                "key": "ORPHAN_CHROME_MAX_AGE_SEC",
                "label": "ORPHAN_CHROME_MAX_AGE_SEC",
                "type": "number",
                "description": "Минимальный возраст (в секундах) зависших процессов Chromium, после которого они будут убиты.",
                "attrs": {"min": 0, "step": 30},
                "unit": "сек.",
            },
            {
                "key": "USER_AGENT",
                "label": "USER_AGENT",
                "type": "text",
                "description": "HTTP User-Agent, который используется при обращении к сайтам и потокам.",
            },
        ],
    },
    {
        "id": "actions",
        "title": "Задачи панели",
        "description": "Настройка тайм-аутов доступных действий на панели управления.",
        "fields": [
            {
                "key": "ACTION_TIMEOUT_SCANNER",
                "label": "ACTION_TIMEOUT_SCANNER",
                "type": "number",
                "description": "Тайм-аут запуска полной проверки каналов (run-scanner).",
                "attrs": {"min": 60, "step": 30},
                "unit": "сек.",
            },
            {
                "key": "ACTION_TIMEOUT_UPDATE",
                "label": "ACTION_TIMEOUT_UPDATE",
                "type": "number",
                "description": "Тайм-аут пересборки плейлистов (update_playlist.py).",
                "attrs": {"min": 60, "step": 30},
                "unit": "сек.",
            },
            {
                "key": "ACTION_TIMEOUT_VALIDATE",
                "label": "ACTION_TIMEOUT_VALIDATE",
                "type": "number",
                "description": "Ожидание проверки потоков (test_m3u_playlists.py).",
                "attrs": {"min": 60, "step": 30},
                "unit": "сек.",
            },
            {
                "key": "ACTION_TIMEOUT_PYTEST",
                "label": "ACTION_TIMEOUT_PYTEST",
                "type": "number",
                "description": "Тайм-аут python -m unittest discover.",
                "attrs": {"min": 60, "step": 30},
                "unit": "сек.",
            },
            {
                "key": "ACTION_TIMEOUT_JS",
                "label": "ACTION_TIMEOUT_JS",
                "type": "number",
                "description": "Тайм-аут npm test для экстракторов.",
                "attrs": {"min": 60, "step": 30},
                "unit": "сек.",
            },
        ],
    },
    {
        "id": "system",
        "title": "Системные команды",
        "description": "Используются при запуске фоновых скриптов из панели.",
        "fields": [
            {
                "key": "PYTHON_BIN",
                "label": "PYTHON_BIN",
                "type": "text",
                "description": "Интерпретатор Python, которым запускаются служебные команды.",
            },
        ],
    },
]


FIELD_MAP = {field["key"]: field for group in SETTINGS_LAYOUT for field in group["fields"]}


CURRENT_SETTINGS: dict[str, Any] = {}


def _settings_file_path() -> str:
    return os.path.join(CONFIG_DIR, "settings.json")


def _get_setting_value(key: str) -> Any:
    if key == "BASE_DIR":
        return BASE_DIR
    if key == "EXTRACTOR_DIR":
        return EXTRACTOR_DIR
    if key == "M3U_DIR":
        return M3U_DIR
    if key == "CONFIG_DIR":
        return CONFIG_DIR
    if key == "PROXY_HOST":
        return PROXY_HOST
    if key == "PROXY_PORT":
        return PROXY_PORT
    if key == "CACHE_TTL_SEC":
        return CACHE_TTL_SEC
    if key == "NODE_BIN":
        return NODE_BIN
    if key == "JS_EXTRACTOR_NAME":
        return JS_EXTRACTOR_NAME
    if key == "JS_TIMEOUT_SEC":
        return JS_TIMEOUT_SEC
    if key == "CLEAN_TMP_AFTER_JS":
        return CLEAN_TMP_AFTER_JS
    if key == "ORPHAN_CHROME_MAX_AGE_SEC":
        return ORPHAN_CHROME_MAX_AGE_SEC
    if key == "USER_AGENT":
        return USER_AGENT
    if key == "PYTHON_BIN":
        return PYTHON_BIN
    if key == "ACTION_TIMEOUT_SCANNER":
        return int(ACTION_CATALOG["run-scanner"].get("timeout", 0))
    if key == "ACTION_TIMEOUT_UPDATE":
        return int(ACTION_CATALOG["update-playlists"].get("timeout", 0))
    if key == "ACTION_TIMEOUT_VALIDATE":
        return int(ACTION_CATALOG["validate-playlists"].get("timeout", 0))
    if key == "ACTION_TIMEOUT_PYTEST":
        return int(ACTION_CATALOG["python-tests"].get("timeout", 0))
    if key == "ACTION_TIMEOUT_JS":
        return int(ACTION_CATALOG["extractor-tests"].get("timeout", 0))
    raise KeyError(key)


def _coerce_value(field: dict[str, Any], raw: Any) -> Any:
    ftype = field.get("type", "text")
    if ftype == "number":
        if raw is None or (isinstance(raw, str) and not raw.strip()):
            raise ValueError(f"Параметр {field['label']} не может быть пустым")
        try:
            value = int(raw)
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"Ожидается число для {field['label']}") from exc
    elif ftype == "boolean":
        if isinstance(raw, bool):
            value = raw
        elif isinstance(raw, (int, float)):
            value = bool(raw)
        elif isinstance(raw, str):
            lowered = raw.strip().lower()
            if lowered in {"1", "true", "да", "on", "yes"}:
                value = True
            elif lowered in {"0", "false", "нет", "off", "no"}:
                value = False
            else:
                raise ValueError(f"Ожидается булево значение для {field['label']}")
        else:
            raise ValueError(f"Ожидается булево значение для {field['label']}")
    else:
        value = str(raw or "").strip()
    if field.get("normalize") == "path":
        value = os.path.abspath(value) if value else value
    return value


def _sync_current_settings() -> None:
    for key in FIELD_MAP:
        try:
            CURRENT_SETTINGS[key] = _get_setting_value(key)
        except KeyError:
            continue


def _persist_settings() -> None:
    path = _settings_file_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(CURRENT_SETTINGS, fh, ensure_ascii=False, indent=2, sort_keys=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[settings] не удалось сохранить {path}: {exc}")


def _set_setting_value(key: str, value: Any) -> None:
    global BASE_DIR, EXTRACTOR_DIR, M3U_DIR, CONFIG_DIR, CHANNELS_FILE, CACHE_FILE, SITE_CONTROLLER_FILE
    global NODE_BIN, JS_EXTRACTOR_NAME, JS_TIMEOUT_SEC, CLEAN_TMP_AFTER_JS, ORPHAN_CHROME_MAX_AGE_SEC
    global USER_AGENT, PROXY_HOST, PROXY_PORT, CACHE_TTL_SEC, PYTHON_BIN

    if key == "BASE_DIR":
        BASE_DIR = os.path.abspath(str(value))
        os.environ["BASE_DIR"] = BASE_DIR
        _rebuild_action_commands()
        return
    if key == "EXTRACTOR_DIR":
        EXTRACTOR_DIR = os.path.abspath(str(value))
        os.environ["EXTRACTOR_DIR"] = EXTRACTOR_DIR
        _refresh_js_extractor_path()
        return
    if key == "M3U_DIR":
        M3U_DIR = os.path.abspath(str(value))
        os.environ["M3U_DIR"] = M3U_DIR
        return
    if key == "CONFIG_DIR":
        CONFIG_DIR = os.path.abspath(str(value))
        os.environ["CONFIG_DIR"] = CONFIG_DIR
        CHANNELS_FILE = os.path.join(CONFIG_DIR, "channels.json")
        CACHE_FILE = os.path.join(CONFIG_DIR, "m3u8_cache.json")
        SITE_CONTROLLER_FILE = os.path.join(CONFIG_DIR, "site_controller.json")
        return
    if key == "PROXY_HOST":
        PROXY_HOST = str(value or "")
        os.environ["PROXY_HOST"] = PROXY_HOST
        return
    if key == "PROXY_PORT":
        PROXY_PORT = int(value)
        os.environ["PROXY_PORT"] = str(PROXY_PORT)
        return
    if key == "CACHE_TTL_SEC":
        CACHE_TTL_SEC = int(value)
        os.environ["CACHE_TTL_SEC"] = str(CACHE_TTL_SEC)
        return
    if key == "NODE_BIN":
        NODE_BIN = str(value or "node")
        os.environ["NODE_BIN"] = NODE_BIN
        return
    if key == "JS_EXTRACTOR_NAME":
        JS_EXTRACTOR_NAME = str(value or "")
        os.environ["JS_EXTRACTOR"] = JS_EXTRACTOR_NAME
        _refresh_js_extractor_path()
        return
    if key == "JS_TIMEOUT_SEC":
        JS_TIMEOUT_SEC = int(value)
        os.environ["JS_TIMEOUT_SEC"] = str(JS_TIMEOUT_SEC)
        return
    if key == "CLEAN_TMP_AFTER_JS":
        CLEAN_TMP_AFTER_JS = bool(value)
        os.environ["CLEAN_TMP_AFTER_JS"] = "1" if CLEAN_TMP_AFTER_JS else "0"
        return
    if key == "ORPHAN_CHROME_MAX_AGE_SEC":
        ORPHAN_CHROME_MAX_AGE_SEC = int(value)
        os.environ["ORPHAN_CHROME_MAX_AGE_SEC"] = str(ORPHAN_CHROME_MAX_AGE_SEC)
        return
    if key == "USER_AGENT":
        USER_AGENT = str(value or "")
        os.environ["USER_AGENT"] = USER_AGENT
        return
    if key == "PYTHON_BIN":
        PYTHON_BIN = str(value or "python")
        os.environ["PYTHON_BIN"] = PYTHON_BIN
        _rebuild_action_commands()
        return
    if key == "ACTION_TIMEOUT_SCANNER":
        ACTION_CATALOG["run-scanner"]["timeout"] = int(value)
        os.environ["ACTION_TIMEOUT_SCANNER"] = str(value)
        return
    if key == "ACTION_TIMEOUT_UPDATE":
        ACTION_CATALOG["update-playlists"]["timeout"] = int(value)
        os.environ["ACTION_TIMEOUT_UPDATE"] = str(value)
        return
    if key == "ACTION_TIMEOUT_VALIDATE":
        ACTION_CATALOG["validate-playlists"]["timeout"] = int(value)
        os.environ["ACTION_TIMEOUT_VALIDATE"] = str(value)
        return
    if key == "ACTION_TIMEOUT_PYTEST":
        ACTION_CATALOG["python-tests"]["timeout"] = int(value)
        os.environ["ACTION_TIMEOUT_PYTEST"] = str(value)
        return
    if key == "ACTION_TIMEOUT_JS":
        ACTION_CATALOG["extractor-tests"]["timeout"] = int(value)
        os.environ["ACTION_TIMEOUT_JS"] = str(value)
        return
    raise KeyError(key)


def _apply_settings(values: dict[str, Any], *, persist: bool = True) -> dict[str, Any]:
    if not isinstance(values, dict):
        raise ValueError("Передайте объект со значениями настроек")
    applied: dict[str, Any] = {}
    for key, raw in values.items():
        if key not in FIELD_MAP:
            raise ValueError(f"Неизвестный параметр: {key}")
        field = FIELD_MAP[key]
        coerced = _coerce_value(field, raw)
        _set_setting_value(key, coerced)
        applied[key] = _get_setting_value(key)
    _sync_current_settings()
    if persist:
        _persist_settings()
    return applied


def _describe_settings_groups() -> list[dict[str, Any]]:
    _sync_current_settings()
    groups: list[dict[str, Any]] = []
    for spec in SETTINGS_LAYOUT:
        fields: list[dict[str, Any]] = []
        for field in spec["fields"]:
            key = field["key"]
            data = {
                "key": key,
                "label": field.get("label", key),
                "type": field.get("type", "text"),
                "description": field.get("description", ""),
                "value": CURRENT_SETTINGS.get(key),
            }
            if field.get("unit"):
                data["unit"] = field["unit"]
            if field.get("attrs"):
                data["attrs"] = field["attrs"]
            fields.append(data)
        groups.append(
            {
                "id": spec.get("id"),
                "title": spec.get("title"),
                "description": spec.get("description", ""),
                "fields": fields,
            }
        )
    return groups


def _load_settings_from_file() -> None:
    path = _settings_file_path()
    if not os.path.exists(path):
        return
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return
    except Exception as exc:  # noqa: BLE001
        print(f"[settings] не удалось прочитать {path}: {exc}")
        return
    if isinstance(data, dict) and data:
        try:
            _apply_settings(data, persist=False)
        except ValueError as exc:
            print(f"[settings] не удалось применить настройки из {path}: {exc}")


_sync_current_settings()
_load_settings_from_file()


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


def _ensure_config_dir() -> None:
    """Гарантирует наличие каталога config."""
    os.makedirs(CONFIG_DIR, exist_ok=True)


def _sorted_dict(data: dict) -> dict:
    """Возвращает новый dict с отсортированными ключами."""
    return {key: data[key] for key in sorted(data)}


def _save_channels_map(channels: dict) -> None:
    """Сохраняет карту каналов атомарно."""
    _ensure_config_dir()
    ordered = _sorted_dict(channels)
    fd, tmp_path = tempfile.mkstemp(prefix="channels_", suffix=".json", dir=CONFIG_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(ordered, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp_path, CHANNELS_FILE)
    except Exception:
        # если replace не удался, файл нужно удалить
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
        raise


def _strip(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    return ""


def _coerce_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "on", "да"}
    return False


def _normalize_channel_payload(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("Передайте объект с полями канала.")

    slug = _strip(payload.get("slug")) or _strip(payload.get("id"))
    if not slug:
        raise ValueError("Укажите slug канала (латиница, без пробелов).")

    name = _strip(payload.get("name") or payload.get("title"))
    if not name:
        raise ValueError("Укажите отображаемое название канала.")

    url = _strip(payload.get("url") or payload.get("source") or payload.get("page"))
    if not url:
        raise ValueError("Укажите исходную страницу или поток (поле URL).")

    group = _strip(payload.get("group") or payload.get("category"))
    description = _strip(payload.get("description") or payload.get("summary"))
    logo = _strip(payload.get("logo") or payload.get("icon"))
    epg_id = _strip(
        payload.get("epgId")
        or payload.get("epg_id")
        or payload.get("tvg_id")
        or payload.get("tvgId")
    )
    favorite = _coerce_bool(payload.get("favorite") or payload.get("is_favorite"))

    return {
        "slug": slug,
        "name": name,
        "url": url,
        "group": group,
        "description": description,
        "logo": logo,
        "epg_id": epg_id,
        "favorite": favorite,
    }


def _build_channel_record(existing: Any, fields: dict) -> dict:
    """Собирает словарь канала, комбинируя старые и новые данные."""
    record = {}
    if isinstance(existing, dict):
        record.update(existing)
    elif isinstance(existing, str):
        record["url"] = existing

    # убираем поля, которые мы будем перезаписывать, чтобы не накапливать устаревшие ключи
    for key in (
        "name",
        "title",
        "url",
        "group",
        "category",
        "description",
        "summary",
        "logo",
        "icon",
        "favorite",
        "is_favorite",
        "epg_id",
        "epgId",
        "tvg_id",
        "tvgId",
    ):
        record.pop(key, None)

    record["name"] = fields["name"]
    record["title"] = fields["name"]
    record["url"] = fields["url"]

    if fields["group"]:
        record["group"] = fields["group"]
        record["category"] = fields["group"]
    else:
        record.pop("group", None)
        record.pop("category", None)

    if fields["description"]:
        record["description"] = fields["description"]
    else:
        record.pop("description", None)

    if fields["logo"]:
        record["logo"] = fields["logo"]
    else:
        record.pop("logo", None)

    if fields["favorite"]:
        record["favorite"] = True
        record["is_favorite"] = True
    else:
        record.pop("favorite", None)
        record.pop("is_favorite", None)

    if fields["epg_id"]:
        record["epg_id"] = fields["epg_id"]
        record["epgId"] = fields["epg_id"]
    else:
        record.pop("epg_id", None)
        record.pop("epgId", None)

    return record


def _serialize_channel(slug: str, meta: Any, include_source: bool = False) -> dict:
    name = ""
    url = ""
    group = ""
    description = ""
    favorite = False
    logo = ""
    epg_id = ""
    schedule = []

    if isinstance(meta, dict):
        name = meta.get("title") or meta.get("name") or ""
        url = meta.get("url") or meta.get("page") or meta.get("source") or ""
        group = meta.get("group") or meta.get("category") or ""
        description = meta.get("description") or meta.get("summary") or ""
        logo = meta.get("logo") or meta.get("icon") or ""
        favorite = _coerce_bool(meta.get("favorite") or meta.get("is_favorite"))
        epg_id = (
            _strip(meta.get("epg_id"))
            or _strip(meta.get("epgId"))
            or _strip(meta.get("tvg_id"))
            or _strip(meta.get("tvgId"))
        )
        raw_schedule = meta.get("epg") or meta.get("schedule")
        if isinstance(raw_schedule, list):
            for entry in raw_schedule:
                if isinstance(entry, dict):
                    schedule.append(
                        {
                            "time": entry.get("time") or entry.get("start") or "",
                            "title": entry.get("title") or entry.get("name") or "",
                            "description": entry.get("description") or entry.get("desc") or "",
                            "startIso": entry.get("startIso")
                            or entry.get("start_iso")
                            or entry.get("startAt"),
                            "endIso": entry.get("endIso")
                            or entry.get("end_iso")
                            or entry.get("endAt"),
                        }
                    )
                elif isinstance(entry, str):
                    schedule.append({"time": entry, "title": entry})
    elif isinstance(meta, str):
        url = meta

    entry = {
        "slug": slug,
        "name": name,
        "group": group,
        "description": description,
        "logo": logo,
        "favorite": bool(favorite),
        "epgId": epg_id,
    }
    if schedule:
        entry["epg"] = schedule
    if include_source:
        entry["url"] = url
    return entry


def _render(page: str, **ctx):
    """Рисует HTML-страницу панели с общим контекстом."""
    payload = {
        "host": PROXY_HOST,
        "port": PROXY_PORT,
        "year": datetime.utcnow().year,
    }
    payload.update(ctx)
    return render_template(page, **payload)

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
    Убивает осиротевшие процессы chrome/chromium (обычно оставленные Playwright):
    - ppid == 1,
    - имя/командная строка содержит chrome/chromium,
    - и есть маркеры playwright/headless.
    """
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


def _run_action(meta: dict, *, command_override: list[str] | None = None, extra_env: dict | None = None) -> dict:
    """Запускает команду и возвращает результат для JSON."""
    command = command_override or meta.get("command")
    timeout = int(meta.get("timeout", 300))
    started = time.time()
    if not command:
        return {
            "ok": False,
            "error": "Команда не задана",
        }
    env = None
    if extra_env:
        env = os.environ.copy()
        env.update(extra_env)
    try:
        proc = subprocess.Popen(
            command,
            cwd=BASE_DIR,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=env,
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


def _list_available_extractors() -> list[str]:
    if not os.path.isdir(EXTRACTOR_DIR):
        return []
    names = []
    for entry in os.listdir(EXTRACTOR_DIR):
        path = os.path.join(EXTRACTOR_DIR, entry)
        if os.path.isfile(path) and entry.lower().endswith(".js"):
            names.append(entry)
    # сохраняем порядок, но убираем дубликаты
    seen = set()
    ordered: list[str] = []
    for name in sorted(names):
        if name in seen:
            continue
        seen.add(name)
        ordered.append(name)
    return ordered

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


def _normalize_site_controller_entry(entry: dict, *, allow_default: bool = False) -> tuple[str, dict[str, Any]]:
    if not isinstance(entry, dict):
        raise ValueError("Передайте объект с параметрами сайта")

    host = _strip(entry.get("host") or ("default" if allow_default else ""))
    if not host:
        raise ValueError("Укажите домен или маску сайта")
    if host == "default" and not allow_default:
        raise ValueError("Ключ 'default' зарезервирован — используйте другой хост")

    scripts = _to_list(entry.get("script") or entry.get("scripts") or entry.get("extractor"))
    if not scripts:
        scripts = _to_list(JS_EXTRACTOR_NAME)
    script = _strip(scripts[0]) or JS_EXTRACTOR_NAME

    try:
        timeout = int(entry.get("timeout") or entry.get("timeoutSec") or entry.get("timeout_sec") or JS_TIMEOUT_SEC)
    except Exception:
        timeout = JS_TIMEOUT_SEC
    timeout = max(1, timeout)

    description = _strip(entry.get("description"))

    data: dict[str, Any] = {"script": script, "timeout_sec": timeout}
    if description:
        data["description"] = description
    return host, data


def _serialize_site_controller_entries(sc: dict) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    default_conf = sc.get("default") if isinstance(sc.get("default"), dict) else {}
    default_script = _to_list(default_conf.get("script")) or _to_list(JS_EXTRACTOR_NAME)
    entries.append(
        {
            "id": "default",
            "host": "default",
            "script": default_script[0] if default_script else JS_EXTRACTOR_NAME,
            "timeoutSec": int(default_conf.get("timeout_sec") or default_conf.get("timeout") or JS_TIMEOUT_SEC),
            "description": _strip(default_conf.get("description")),
            "isDefault": True,
        }
    )
    for host, cfg in sorted(sc.items()):
        if host == "default" or not isinstance(cfg, dict):
            continue
        scripts = _to_list(cfg.get("script"))
        script = scripts[0] if scripts else JS_EXTRACTOR_NAME
        entries.append(
            {
                "id": host,
                "host": host,
                "script": script,
                "timeoutSec": int(cfg.get("timeout_sec") or cfg.get("timeout") or JS_TIMEOUT_SEC),
                "description": _strip(cfg.get("description")),
                "isDefault": False,
            }
        )
    return entries


def _save_site_controller_map(controller: dict) -> None:
    _ensure_config_dir()
    fd, tmp_path = tempfile.mkstemp(prefix="site_controller_", suffix=".json", dir=CONFIG_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(controller, fh, ensure_ascii=False, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp_path, SITE_CONTROLLER_FILE)
    except Exception:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
        raise


def _build_site_controller_map(entries: list[dict], default_entry: dict | None) -> dict:
    controller: dict[str, Any] = {}
    host, defaults = _normalize_site_controller_entry(default_entry or {}, allow_default=True)
    controller[host] = defaults

    seen: set[str] = set()
    for entry in entries or []:
        host, cfg = _normalize_site_controller_entry(entry, allow_default=False)
        if host in seen:
            raise ValueError(f"Домен '{host}' указан несколько раз")
        seen.add(host)
        controller[host] = cfg
    return controller


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
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    else:
        when = when.astimezone(timezone.utc)
    age = (datetime.now(timezone.utc) - when).total_seconds()
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
    return _render("dashboard.html", active_page="dashboard")


@app.route("/playlists")
def playlists_page():
    return _render("playlists.html", active_page="playlists")


@app.route("/channels")
def channels_page():
    return _render("channels.html", active_page="channels")


@app.route("/player")
def player_page():
    return render_template("player.html", host=PROXY_HOST, port=PROXY_PORT)


@app.route("/scanner")
def scanner_page():
    return _render("scanner.html", active_page="scanner")


@app.route("/settings")
def settings_page():
    return _render("settings.html", active_page="settings")


@app.route("/api/actions", methods=["GET"])
def api_list_actions():
    payload = [_summarize_action(k, v) for k, v in ACTION_CATALOG.items()]
    return jsonify({"items": payload})


@app.route("/api/actions/<action_id>", methods=["POST"])
def api_run_action(action_id):
    meta = ACTION_CATALOG.get(action_id)
    if not meta:
        return jsonify({"ok": False, "error": f"Неизвестное действие: {action_id}"}), 404

    payload = request.get_json(silent=True) or {}
    command_override = None
    extra_env = None

    if action_id == "run-scanner":
        start_url = (payload.get("startUrl") or "").strip()
        site_tag = (payload.get("siteTag") or "").strip()
        if not start_url:
            return jsonify({"ok": False, "error": "Укажите стартовую страницу для сканера."}), 400
        command_override = list(meta.get("command", [])) + ["--start-url", start_url]
        if site_tag:
            command_override += ["--site-tag", site_tag]

    result = _run_action(meta, command_override=command_override, extra_env=extra_env)
    return jsonify(result)


@app.route("/api/playlists", methods=["GET"])
def api_playlists():
    return jsonify({"items": _list_playlists()})


@app.route("/api/channels", methods=["GET", "POST"])
def api_channels():
    if request.method == "GET":
        include_source = bool(request.args.get("withSource"))
        items = [
            _serialize_channel(slug, meta, include_source=include_source)
            for slug, meta in _load_channels_safe().items()
        ]
        items.sort(key=lambda x: x["slug"])
        return jsonify({"items": items})

    payload = request.get_json(silent=True) or {}
    try:
        fields = _normalize_channel_payload(payload)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400

    channels = _load_channels_safe()
    slug = fields["slug"]
    if slug in channels:
        return (
            jsonify({"ok": False, "error": f"Канал с slug '{slug}' уже существует."}),
            409,
        )

    record = _build_channel_record({}, fields)
    channels[slug] = record
    _save_channels_map(channels)
    return jsonify({"ok": True, "item": _serialize_channel(slug, record, include_source=True)})


@app.route("/api/channels/<slug>", methods=["PUT", "DELETE"])
def api_channel_update(slug):
    channels = _load_channels_safe()

    if request.method == "DELETE":
        if slug not in channels:
            return jsonify({"ok": False, "error": f"Канал '{slug}' не найден."}), 404
        channels.pop(slug, None)
        _save_channels_map(channels)
        return jsonify({"ok": True})

    payload = request.get_json(silent=True) or {}
    try:
        fields = _normalize_channel_payload(payload)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400

    if slug not in channels:
        return jsonify({"ok": False, "error": f"Канал '{slug}' не найден."}), 404

    new_slug = fields["slug"]
    if new_slug != slug and new_slug in channels:
        return (
            jsonify({"ok": False, "error": f"Slug '{new_slug}' уже используется."}),
            409,
        )

    existing = channels.get(slug)
    record = _build_channel_record(existing, fields)
    if new_slug != slug:
        channels.pop(slug, None)
    channels[new_slug] = record
    _save_channels_map(channels)
    return jsonify({"ok": True, "item": _serialize_channel(new_slug, record, include_source=True)})


def _load_json_safe(path: str):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


@app.route("/api/settings", methods=["GET"])
def api_settings():
    site_controller = _load_site_controller()
    search_map = _load_json_safe(os.path.join(CONFIG_DIR, "search.json"))

    controller_summary = []
    if isinstance(site_controller, dict):
        default_cfg = site_controller.get("default", {}) if isinstance(site_controller.get("default"), dict) else {}
        for host, cfg in site_controller.items():
            if host == "default":
                continue
            if not isinstance(cfg, dict):
                continue
            entry = {
                "host": host,
                "script": cfg.get("script") or default_cfg.get("script") or "",
                "timeout": int(cfg.get("timeout_sec") or default_cfg.get("timeout_sec") or 10),
            }
            controller_summary.append(entry)
        controller_summary.sort(key=lambda x: x["host"])

    search_summary = []
    if isinstance(search_map, dict):
        for host, cfg in search_map.items():
            if isinstance(cfg, dict):
                search_summary.append({
                    "host": host,
                    "parser": cfg.get("parser") or "search-generic.js",
                    "timeout": int(cfg.get("timeout_sec") or 10),
                })
        search_summary.sort(key=lambda x: x["host"])

    return jsonify(
        {
            "groups": _describe_settings_groups(),
            "siteController": controller_summary,
            "search": search_summary,
        }
    )


@app.route("/api/settings", methods=["POST"])
def api_settings_update():
    payload = request.get_json(silent=True) or {}
    values = payload.get("values")
    if not isinstance(values, dict):
        return jsonify({"ok": False, "error": "Передайте объект values с изменениями."}), 400
    try:
        applied = _apply_settings(values, persist=True)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    return jsonify({"ok": True, "applied": applied, "groups": _describe_settings_groups()})


@app.route("/api/site-controller", methods=["GET"])
def api_site_controller_state():
    data = _load_site_controller()
    return jsonify(
        {
            "ok": True,
            "entries": _serialize_site_controller_entries(data),
            "availableExtractors": _list_available_extractors(),
            "defaultScript": JS_EXTRACTOR_NAME,
            "defaultTimeout": JS_TIMEOUT_SEC,
        }
    )


@app.route("/api/site-controller", methods=["POST"])
def api_site_controller_update():
    payload = request.get_json(silent=True) or {}
    try:
        controller = _build_site_controller_map(payload.get("entries") or [], payload.get("default"))
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    try:
        _save_site_controller_map(controller)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": f"Не удалось сохранить site_controller.json: {exc}"}), 500
    return jsonify(
        {
            "ok": True,
            "entries": _serialize_site_controller_entries(controller),
            "availableExtractors": _list_available_extractors(),
        }
    )


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
            "timestamp": datetime.now(timezone.utc).isoformat()
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
