#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# =======================
#  Глобальные настройки
# =======================
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PLAYWRIGHT_VER="${PLAYWRIGHT_VER:-1.55.0}"
PYTHON_BIN="${PYTHON_BIN:-$(command -v python3 || true)}"

# Proxy (systemd)
SERVICE_NAME="${SERVICE_NAME:-proxy_server}"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
SCRIPT_PATH="${SCRIPT_PATH:-${SCRIPT_DIR}/proxy_server.py}"
WORK_DIR="${WORK_DIR:-${SCRIPT_DIR}}"
SERVICE_USER="${SERVICE_USER:-root}"

# One-shot скрипты
PLAYLIST_SCRIPT_PATH="${PLAYLIST_SCRIPT_PATH:-${SCRIPT_DIR}/update_playlist.py}"
PLAYLIST_WORK_DIR="${PLAYLIST_WORK_DIR:-${SCRIPT_DIR}}"
SCANNER_SCRIPT_PATH="${SCANNER_SCRIPT_PATH:-${SCRIPT_DIR}/scaner.py}"
SCANNER_WORK_DIR="${SCANNER_WORK_DIR:-${SCRIPT_DIR}}"

# =======================
#  Утилиты
# =======================
have_cmd(){ command -v "$1" >/dev/null 2>&1; }
need_root(){
  if [[ $EUID -ne 0 ]]; then
    echo "❌ Нужны права root. Запусти: sudo $0 $*" >&2; exit 1
  fi
}
require_python(){
  [[ -n "${PYTHON_BIN:-}" && -x "$PYTHON_BIN" ]] || { echo "❌ python3 не найден."; exit 1; }
}
require_path(){
  local kind="$1" path="$2"
  [[ -e "$path" ]] || { echo "❌ ${kind} не найден: $path"; exit 1; }
}
require_dir(){
  local path="$1"
  [[ -d "$path" ]] || { echo "❌ Рабочий каталог не найден: $path"; exit 1; }
}

# =======================
#  deps
# =======================
deps_install(){
  local TARGET_DIR="${1:-.}"; shift || true
  local -a EXTRAS=()
  if [[ ${1:-} == "--extras" ]]; then shift; EXTRAS=("$@"); fi

  have_cmd node || { echo "❌ Нужен Node.js 18+."; exit 1; }
  have_cmd npm  || { echo "❌ npm не найден."; exit 1; }

  echo "Node: $(node -v)"
  echo "npm:  $(npm -v)"
  mkdir -p "$TARGET_DIR"; cd "$TARGET_DIR"

  if [[ ! -f package.json ]]; then
    local NAME; NAME="$(basename "$TARGET_DIR" | tr -cd '[:alnum:]._-' || echo app)"
    cat > package.json <<JSON
{
  "name": "${NAME}",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "playwright": "${PLAYWRIGHT_VER}",
    "playwright-core": "${PLAYWRIGHT_VER}"
  }
}
JSON
  fi

  echo "📦 Устанавливаю зависимости..."
  if [[ -f package-lock.json ]]; then
    npm ci --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi
  [[ ${#EXTRAS[@]} -gt 0 ]] && npm install --no-audit --no-fund "${EXTRAS[@]}"

  echo "🧩 Устанавливаю системные библиотеки Chromium (Ubuntu/Debian)..."
  if [[ $EUID -eq 0 ]]; then
    npx playwright-core install-deps chromium
  else
    echo "⚠️  Не root: пропускаю install-deps. Если Chromium не стартует, выполни:"
    echo "    sudo npx playwright-core install-deps chromium"
  fi

  echo "🌐 Загружаю браузер Chromium через Playwright..."
  echo "   Если интернет медленный, это может занять несколько минут; прогресс загрузки будет показан ниже."
  PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT="${PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT:-120000}" \
    npx playwright-core install chromium

  echo "🔎 Проверяю импорт..."
  node --input-type=module -e "import('playwright-core').then(()=>console.log('  playwright-core OK')).catch(e=>{console.error(e);process.exit(1)})"
  echo "✅ Готово."; npm ls playwright-core || true
}

# =======================
#  proxy (systemd)
# =======================
svc_file(){ echo "/etc/systemd/system/${1}.service"; }

proxy_install(){
  need_root proxy install
  have_cmd systemctl || { echo "❌ systemctl не найден."; exit 1; }
  require_python
  require_path "Файл proxy_server.py" "$SCRIPT_PATH"
  require_dir "$WORK_DIR"
  cat > "$(svc_file "$SERVICE_NAME")" <<EOF
[Unit]
Description=${SERVICE_NAME}
After=network.target

[Service]
ExecStart=${PYTHON_BIN} ${SCRIPT_PATH}
WorkingDirectory=${WORK_DIR}
Restart=always
User=${SERVICE_USER}
Environment=PYTHONUNBUFFERED=1
Environment=BASE_DIR=${WORK_DIR}

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl reset-failed "$SERVICE_NAME" || true
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
  echo "✅ Служба установлена и запущена."
  systemctl status "$SERVICE_NAME" --no-pager || true
}
proxy_remove(){
  need_root proxy remove
  have_cmd systemctl || { echo "❌ systemctl не найден."; exit 1; }
  systemctl stop "$SERVICE_NAME" || true
  systemctl disable "$SERVICE_NAME" || true
  rm -f "$(svc_file "$SERVICE_NAME")"
  systemctl daemon-reload
  echo "✅ Служба удалена."
}
proxy_logs(){ have_cmd journalctl || { echo "❌ journalctl не найден."; exit 1; }; journalctl -u "$SERVICE_NAME" -n 50 --no-pager || true; }
proxy_status(){ have_cmd systemctl || { echo "❌ systemctl не найден."; exit 1; }; systemctl status "$SERVICE_NAME" || true; }
proxy_restart(){ need_root proxy restart; have_cmd systemctl || { echo "❌ systemctl не найден."; exit 1; }; systemctl restart "$SERVICE_NAME"; echo "✅ Перезапущено."; }

proxy_menu(){
  echo "Что вы хотите сделать?"
  select choice in \
    "Установить proxy_server.py как службу" \
    "Удалить службу proxy_server.py" \
    "Посмотреть логи" \
    "Статус службы" \
    "Рестарт службы" \
    "Назад"; do
    case $REPLY in
      1) proxy_install; break ;;
      2) proxy_remove; break ;;
      3) proxy_logs; break ;;
      4) proxy_status; break ;;
      5) proxy_restart; break ;;
      6) break ;;
      *) echo "Неверный выбор. Повторите." ;;
    esac
  done
}

# =======================
#  one-shot: playlist / scanner
# =======================
playlist_run(){
  require_python
  require_path "Файл update_playlist.py" "$PLAYLIST_SCRIPT_PATH"
  require_dir "$PLAYLIST_WORK_DIR"
  ( cd "$PLAYLIST_WORK_DIR" && "$PYTHON_BIN" "$PLAYLIST_SCRIPT_PATH" )
}
scanner_run(){
  require_python
  require_path "Файл scaner.py" "$SCANNER_SCRIPT_PATH"
  require_dir "$SCANNER_WORK_DIR"
  ( cd "$SCANNER_WORK_DIR" && "$PYTHON_BIN" "$SCANNER_SCRIPT_PATH" )
}

playlist_menu(){
  echo "Обновление плейлиста (one-shot)"
  select choice in "Запуск один раз" "Назад"; do
    case $REPLY in
      1) playlist_run; break ;;
      2) break ;;
      *) echo "Неверный выбор. Повторите." ;;
    esac
  done
}
scanner_menu(){
  echo "Сканер (one-shot)"
  select choice in "Запуск один раз" "Назад"; do
    case $REPLY in
      1) scanner_run; break ;;
      2) break ;;
      *) echo "Неверный выбор. Повторите." ;;
    esac
  done
}

deps_menu(){
  echo "Установка JS-зависимостей"
  read -r -p "Каталог (по умолчанию .): " d; d="${d:-.}"
  echo "Доп.пакеты (через пробел, можно пусто):"
  read -r extras || true
  if [[ -n "${extras:-}" ]]; then
    deps_install "$d" --extras ${extras}
  else
    deps_install "$d"
  fi
}

# =======================
#  Главный МЕНЮ-режим
# =======================
main_menu(){
  while true; do
    echo "Выберите действие:"
    select main_choice in \
      "Управление Proxy (systemd)" \
      "Обновить плейлист (one-shot)" \
      "Запустить сканер (one-shot)" \
      "Установить JS-зависимости (Playwright)" \
      "Выход"; do
      case $REPLY in
        1) proxy_menu; break ;;
        2) playlist_menu; break ;;
        3) scanner_menu; break ;;
        4) deps_menu; break ;;
        5) echo "Выход..."; return 0 ;;
        *) echo "Неверный выбор. Повторите."; ;;
      esac
    done
  done
}

# =======================
#  CLI режим (по желанию)
# =======================
usage(){
  cat <<EOF
Объединённый инструмент: меню по умолчанию.
CLI (необязательно):
  $(basename "$0") deps [TARGET_DIR=.] [--extras pkg1 pkg2 ...]
  $(basename "$0") proxy   [install|remove|logs|status|restart]
  $(basename "$0") playlist run
  $(basename "$0") scanner  run
EOF
}

main(){
  case "${1:-}" in
    "") main_menu ;;
    deps) shift || true; deps_install "$@" ;;
    proxy)
      shift || true
      case "${1:-}" in
        install) proxy_install ;;
        remove)  proxy_remove ;;
        logs)    proxy_logs ;;
        status)  proxy_status ;;
        restart) proxy_restart ;;
        *) proxy_menu ;;
      esac
      ;;
    playlist) playlist_run ;;
    scanner)  scanner_run ;;
    -h|--help) usage ;;
    *) echo "Неизвестная команда"; usage; exit 1 ;;
  esac
}
main "$@"
