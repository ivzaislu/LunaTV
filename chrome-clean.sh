#!/usr/bin/env bash
set -euo pipefail

# Chrome/Chromium Cleaner
# Поддержка: Linux (~/.config) и macOS (~/Library/Application Support)
# По умолчанию чистит только кэш и временные каталоги. Для куки/истории используйте флаги.

########## ПАРАМЕТРЫ ПО УМОЛЧАНИЮ ##########
BROWSER="chrome"        # chrome | chromium
TARGETS=("cache")       # cache | deep-cache | cookies | history | site-data | all
PROFILES=()             # например: "Default" "Profile 1"
DRYRUN=false
ASSUME_YES=false
BACKUP_DIR="$HOME/chrome-clean-backups"
KILL_RUNNING=false

########## УТИЛИТЫ ##########
err(){ echo "[-] $*" >&2; }
info(){ echo "[*] $*"; }
ok(){ echo "[+] $*"; }

confirm(){
  $ASSUME_YES && return 0
  read -r -p "$* [y/N]: " ans
  [[ "${ans:-}" =~ ^[Yy]$ ]]
}

is_macos(){ [[ "$(uname -s)" == "Darwin" ]]; }
is_linux(){ [[ "$(uname -s)" == "Linux" ]]; }

detect_root(){
  if is_macos; then
    case "$BROWSER" in
      chrome) echo "$HOME/Library/Application Support/Google/Chrome" ;;
      chromium) echo "$HOME/Library/Application Support/Chromium" ;;
      *) err "Неизвестный браузер: $BROWSER"; exit 1 ;;
    esac
  elif is_linux; then
    case "$BROWSER" in
      chrome) echo "$HOME/.config/google-chrome" ;;
      chromium) echo "$HOME/.config/chromium" ;;
      *) err "Неизвестный браузер: $BROWSER"; exit 1 ;;
    esac
  else
    err "Неподдерживаемая ОС."; exit 1
  fi
}

list_profiles(){
  local root="$1"
  if [[ ${#PROFILES[@]} -eq 0 ]]; then
    # Автоматический поиск профилей
    if [[ -d "$root" ]]; then
      find "$root" -maxdepth 1 -type d \( -name "Default" -o -name "Profile "* -o -name "Guest Profile" \) -printf "%f\n" 2>/dev/null || \
      find "$root" -maxdepth 1 -type d -name "Profile *" -exec basename {} \; 2>/dev/null || true
      [[ -d "$root/Default" ]] && echo "Default"
    fi
  else
    printf "%s\n" "${PROFILES[@]}"
  fi
}

need_sqlite(){
  for t in "${TARGETS[@]}"; do
    [[ "$t" == "cookies" ]] && return 0
    [[ "$t" == "history" ]] && return 0
  done
  return 1
}

ensure_closed(){
  local patt
  if [[ "$BROWSER" == "chrome" ]]; then
    patt="Google Chrome|chrome"
  else
    patt="Chromium"
  fi

  if pgrep -if "$patt" >/dev/null 2>&1; then
    if $KILL_RUNNING; then
      info "Найден запущенный процесс ($patt). Завершаю..."
      pkill -9 -if "$patt" || true
      sleep 1
    else
      err "Похоже, $BROWSER запущен. Закройте его или используйте --kill."
      exit 1
    fi
  fi
}

backup_path(){
  local ts
  ts="$(date +%Y-%m-%d_%H-%M-%S)"
  mkdir -p "$BACKUP_DIR"
  echo "$BACKUP_DIR/${BROWSER}_backup_${ts}.tar.gz"
}

add_target(){
  # Удобный сборщик наборов целей
  case "$1" in
    cache) TARGETS=("cache");;
    deep-cache) TARGETS=("cache" "site-data");;
    cookies) TARGETS=("cookies");;
    history) TARGETS=("history");;
    site-data) TARGETS=("site-data");;
    all) TARGETS=("cache" "site-data" "cookies" "history");;
    *) err "Неизвестная цель: $1"; exit 1 ;;
  esac
}

########## ПАРСИНГ АРГУМЕНТОВ ##########
usage(){
cat <<EOF
Использование: $0 [опции]

Опции:
  --browser chrome|chromium       (по умолчанию: chrome)
  --profiles "Default" "Profile 1"  ограничить список профилей
  --targets cache|deep-cache|cookies|history|site-data|all
                                   (по умолчанию: cache)
  --dry-run                        показывать, что будет удалено, без действий
  -y, --yes                        не спрашивать подтверждений
  --backup-dir DIR                 куда класть архив-бэкап (по умолчанию: $BACKUP_DIR)
  --kill                           принудительно закрыть запущенный браузер
  -h, --help                       помощь

Примеры:
  $0                                  # очистить кэш и временные каталоги всех профилей Chrome
  $0 --browser chromium --targets all # полная очистка Chromium (кэш, сайт-данные, куки, история)
  $0 --targets cookies -y             # удалить только куки, без вопросов
  $0 --profiles "Default" --targets deep-cache
EOF
}

ARGS=("$@")
while [[ $# -gt 0 ]]; do
  case "$1" in
    --browser) BROWSER="${2:-}"; shift 2 ;;
    --profiles)
      PROFILES=()
      shift
      # собираем профили до следующего флага
      while [[ $# -gt 0 && ! "$1" =~ ^- ]]; do PROFILES+=("$1"); shift; done
      ;;
    --targets) add_target "${2:-}"; shift 2 ;;
    --dry-run) DRYRUN=true; shift ;;
    -y|--yes) ASSUME_YES=true; shift ;;
    --backup-dir) BACKUP_DIR="${2:-}"; shift 2 ;;
    --kill) KILL_RUNNING=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "Неизвестный аргумент: $1"; usage; exit 1 ;;
  esac
done

########## ЛОГИКА ##########
ensure_closed
ROOT="$(detect_root)"
[[ -d "$ROOT" ]] || { err "Не найден каталог профилей: $ROOT"; exit 1; }

mapfile -t FOUND_PROFILES < <(list_profiles "$ROOT" | sort -u)
if [[ ${#FOUND_PROFILES[@]} -eq 0 ]]; then
  err "Профили не найдены в $ROOT"; exit 1;
fi

info "Браузер: $BROWSER"
info "Корень профилей: $ROOT"
info "Профили: ${FOUND_PROFILES[*]}"
info "Цели: ${TARGETS[*]}"
$DRYRUN && info "Режим: DRY-RUN (без изменений)"
[[ -n "${BACKUP_DIR:-}" ]] && info "Каталог бэкапов: $BACKUP_DIR"

# Подбор путей для очистки
declare -a DELETE_PATHS
declare -a DELETE_FILES

for PROF in "${FOUND_PROFILES[@]}"; do
  PDIR="$ROOT/$PROF"

  # КЭШИ и временные
  if printf "%s\0" "${TARGETS[@]}" | grep -qz "cache"; then
    DELETE_PATHS+=(
      "$PDIR/Cache"
      "$PDIR/Code Cache"
      "$PDIR/GPUCache"
      "$PDIR/ShaderCache"
      "$PDIR/Media Cache"
      "$PDIR/Service Worker/CacheStorage"
      "$PDIR/Service Worker/ScriptCache"
      "$PDIR/Crashpad"
      "$PDIR/GrShaderCache"
      "$PDIR/GrShaderCacheGPUCache"
      "$PDIR/Visited Links"
      "$PDIR/OptimizationGuidePredictionModels"
      "$PDIR/Network Action Predictor"
      "$PDIR/TransportSecurity"
      "$PDIR/Affiliation Database"
    )
  fi

  # САЙТ-ДАННЫЕ (Local Storage, IndexedDB, WebSQL, Storage)
  if printf "%s\0" "${TARGETS[@]}" | grep -qz "site-data\|all"; then
    DELETE_PATHS+=(
      "$PDIR/Local Storage"
      "$PDIR/IndexedDB"
      "$PDIR/databases"
      "$PDIR/Storage"
      "$PDIR/Blob Storage"
      "$PDIR/File System"
      "$PDIR/Session Storage"
      "$PDIR/QuotaManager"
      "$PDIR/QuotaManager-journal"
      "$PDIR/Code Cache/js"
      "$PDIR/Code Cache/wasm"
      "$PDIR/Extensions Shader Cache"
    )
  fi

  # КУКИ
  if printf "%s\0" "${TARGETS[@]}" | grep -qz "cookies\|all"; then
    DELETE_FILES+=(
      "$PDIR/Cookies"
      "$PDIR/Cookies-journal"
      "$PDIR/Network/Cookies"
      "$PDIR/Network/Cookies-journal"
    )
  fi

  # ИСТОРИЯ
  if printf "%s\0" "${TARGETS[@]}" | grep -qz "history\|all"; then
    DELETE_FILES+=(
      "$PDIR/History"
      "$PDIR/History-journal"
      "$PDIR/History Provider Cache"
      "$PDIR/Top Sites"
      "$PDIR/Top Sites-journal"
      "$PDIR/Visited Links"
      "$PDIR/Shortcuts"
      "$PDIR/Shortcuts-journal"
    )
  fi
done

# Убираем дубликаты
mapfile -t DELETE_PATHS < <(printf "%s\n" "${DELETE_PATHS[@]}" | awk 'NF' | sort -u)
mapfile -t DELETE_FILES < <(printf "%s\n" "${DELETE_FILES[@]}" | awk 'NF' | sort -u)

# Показать план
echo "---------------- PLAN ----------------"
for p in "${DELETE_PATHS[@]}"; do echo "[dir]  $p"; done
for f in "${DELETE_FILES[@]}"; do echo "[file] $f"; done
echo "-------------------------------------"

# Предупреждения
if printf "%s\0" "${TARGETS[@]}" | grep -qz "cookies"; then
  info "ВНИМАНИЕ: удаление cookies выйдет из аккаунтов на сайтах."
fi
if printf "%s\0" "${TARGETS[@]}" | grep -qz "history"; then
  info "ВНИМАНИЕ: история просмотров будет удалена."
fi

# Бэкап
if ! $DRYRUN; then
  if confirm "Сделать бэкап затрагиваемых файлов/каталогов перед очисткой?"; then
    ARCHIVE="$(backup_path)"
    info "Создаю архив: $ARCHIVE"
    # Собираем только существующие пути
    to_backup=()
    for p in "${DELETE_PATHS[@]}"; do [[ -e "$p" ]] && to_backup+=("$p"); done
    for f in "${DELETE_FILES[@]}"; do [[ -e "$f" ]] && to_backup+=("$f"); done
    if [[ ${#to_backup[@]} -gt 0 ]]; then
      tar -czf "$ARCHIVE" -C / $(printf "%s\n" "${to_backup[@]}" | sed 's#^/##') 2>/dev/null || \
      tar -czf "$ARCHIVE" "${to_backup[@]}"
      ok "Бэкап готов: $ARCHIVE"
    else
      info "Нечего бэкапить."
    fi
  fi
fi

# Подтверждение
$DRYRUN || confirm "Приступить к очистке?" || { err "Отменено."; exit 1; }

# Очистка
if $DRYRUN; then
  ok "DRY-RUN: ничего не удалялось."
  exit 0
fi

# Удаление каталогов
for p in "${DELETE_PATHS[@]}"; do
  [[ -e "$p" ]] || continue
  rm -rf -- "$p" && ok "Удален каталог: $p" || err "Не удалось удалить: $p"
done

# Удаление файлов
for f in "${DELETE_FILES[@]}"; do
  [[ -e "$f" ]] || continue
  rm -f -- "$f" && ok "Удалён файл: $f" || err "Не удалось удалить: $f"
done

ok "Готово. Рекомендуется перезапустить браузер (если он был запущен)."
exit 0
