# LunaTV

Инструменты для обновления и проксирования IPTV-плейлистов. Основные компоненты:

- `update_playlist.py` — обновление плейлистов на основе `config/channels.json` и JS-экстракторов;
- `scaner.py` — интерактивный сканер сайтов c поиском потоков и генерацией `m3u`;
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
   pip install -r requirements.txt  # при наличии файла требований
   ```
2. Запустите самотесты экстракторов:
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

6. Запустите HTTP-прокси (по умолчанию слушает `http://0.0.0.0:6060`, параметры можно задать через `PROXY_HOST`/`PROXY_PORT`):
   ```bash
   python proxy_server.py
   ```

   После запуска по адресу `http://0.0.0.0:6060/` доступна веб-панель.
   Отсюда можно запускать типовые задачи (обновление плейлистов,
   проверку потоков, тесты Python/Node) и просматривать список каналов и `.m3u`.

Дополнительные идеи развития и улучшений описаны в [`IMPROVEMENTS.md`](IMPROVEMENTS.md).
