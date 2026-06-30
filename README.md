# LunaTV

Инструменты для обновления и проксирования IPTV-плейлистов. Основные компоненты:

- `update_playlist.py` — обновление плейлистов на основе `config/channels.json` и JS-экстракторов;
- `scaner.py` — сканер сайтов c поиском потоков и генерацией `m3u` (поддерживает CLI-аргументы);
- `proxy_server.py` / `proxy_control.sh` — вспомогательные утилиты для прокси.

## Структура каталогов

```
config/      # конфигурация (channels.json, site_controller.json, m3u8_cache.json)
extractor/   # JS-экстракторы (см. README внутри каталога)
m3u/         # результирующие .m3u плейлисты
```

## Быстрый старт

1. Установите зависимости:
   ```bash
   npm install
   npx playwright@1.55.0 install chromium  # однократно скачивает браузер для экстракторов
   npx playwright@1.55.0 install-deps      # устанавливает системные зависимости Chromium (Linux)
   pip install -r requirements.txt  # при наличии файла требований
   ```
2. Запустите самотесты экстракторов (офлайн фикстуры `smotru` и `cinema`):
   ```bash
   npm test
   ```
3. Прогоните модульные тесты Python-утилит:
   ```bash
   python -m unittest discover
   ```

4. Проверьте синтаксис Python-скриптов:
   ```bash
   python -m compileall update_playlist.py scaner.py
   ```

5. Протестируйте готовые `.m3u` плейлисты (каталог `m3u/`):
   ```bash
   python test_m3u_playlists.py
   ```

6. Запустите backend HTTP-прокси (по умолчанию слушает `http://0.0.0.0:6060`, параметры можно задать через `PROXY_HOST`/`PROXY_PORT`):
   ```bash
   python proxy_server.py
   ```

   LunaTV больше не поставляет браузерную веб-панель и работает как backend/API-сервис.
   Основные эндпоинты:

   - `GET /` и `GET /api/health` — проверка состояния backend;
   - `GET /api/actions` и `POST /api/actions/<action_id>` — список и запуск серверных команд;
   - `GET /api/playlists` и `GET /playlist/<filename>` — список и отдача готовых M3U-плейлистов;
   - `GET|POST /api/channels`, `PUT|DELETE /api/channels/<slug>` — управление `config/channels.json`;
   - `GET|POST /api/settings` — просмотр и изменение runtime-настроек;
   - `GET|POST /api/site-controller` — управление выбором JS-экстракторов;
   - `GET /stream/<channel_slug>` — извлечение актуальной HLS-ссылки через настроенный экстрактор и HTTP 302-редирект на найденный поток.

   Изменённые параметры сохраняются в `config/settings.json` и автоматически подставляются при запуске фоновых задач.


Дополнительные идеи развития и улучшений описаны в [`IMPROVEMENTS.md`](IMPROVEMENTS.md).

### Запуск сканера из консоли

`scaner.py` теперь принимает аргументы командной строки и может запускаться без интерактивного ввода.

```bash
python scaner.py --start-url "https://example.com/tv/channel" --site-tag example
```

Если `--site-tag` опущен, скрипт автоматически построит тег на основе домена страницы. Те же параметры можно
передать backend-эндпоинту `POST /api/actions/run-scanner`.

## Windows Defender и ложные срабатывания

Некоторые антивирусы (в частности Windows Defender) могут ошибочно помечать архив с репозиторием
или скачанный npm-пакет Playwright как угрозу, потому что в комплекте поставляются вспомогательные
скрипты и бинарники Chromium. Чтобы минимизировать риск ложных тревог:

- В Node-зависимостях используется облегчённый пакет [`playwright-core`](https://www.npmjs.com/package/playwright-core),
  который не содержит браузеров внутри архива. Chromium загружается только по команде
  `npx playwright@1.55.0 install chromium`, и вы можете выполнять её в доверенной среде (например,
  внутри Docker-контейнера).
- При загрузке архива из GitHub можно проверить контрольную сумму, например
  `Get-FileHash LunaTV-main.zip -Algorithm SHA256` в PowerShell, и сравнить её с хешем, опубликованным
  в разделе "Releases".
- Если Defender продолжает блокировать распаковку, добавьте временное исключение **только** на папку
  проекта либо воспользуйтесь вариантом с Docker Compose — внутри контейнера установлен полный стек
  зависимостей.

После проверки архива не забывайте удалить исключение или зафиксировать хеш скачанного файла.

## Запуск через Docker Compose

В репозитории есть готовая конфигурация Docker, которая устанавливает Playwright вместе с нужными
браузерами и зависимостями. Это самый быстрый способ поднять backend-сервис "как есть".

1. Соберите и запустите контейнер:
   ```bash
   docker compose up --build
   ```

2. Проверьте backend по адресу [http://0.0.0.0:6060/api/health](http://0.0.0.0:6060/api/health). По умолчанию прокси
   доступен на локальной машине. Параметры можно изменить через переменные окружения
   (`PROXY_HOST`, `PROXY_PORT`, `BASE_DIR`) в `docker-compose.yml`.

Каталоги `config/` и `m3u/` проброшены наружу как тома, поэтому можно редактировать конфигурацию
и забирать плейлисты без пересборки образа. При необходимости добавьте дополнительные тома в
`docker-compose.yml`.
