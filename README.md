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
2. Запустите самотест экстрактора:
   ```bash
   npm test
   ```
3. Проверьте синтаксис Python-скриптов:
   ```bash
   python -m compileall update_playlist.py scaner.py
   ```

Дополнительные идеи развития и улучшений описаны в [`IMPROVEMENTS.md`](IMPROVEMENTS.md).
