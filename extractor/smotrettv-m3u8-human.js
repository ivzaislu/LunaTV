// m3u8-emulate-player.js
// Usage:
//   node m3u8-emulate-player.js "<candidateUrl>" [referer]
//
// Пример:
//   node m3u8-emulate-player.js "https://server.musical.uz/tv/amedia_premium/index.m3u8?token=...&amp;remote"

import { URL } from 'node:url';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ACCEPT_LANG = 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7';

// Быстрая «декодировка» HTML-энкодинга для &amp;
function htmlDecodeAmp(s) { return s.replace(/&amp;/g, '&'); }

function isM3UContentType(ct='') {
  ct = ct.toLowerCase();
  return ct.includes('application/vnd.apple.mpegurl')
      || ct.includes('application/x-mpegurl')
      || ct.includes('audio/mpegurl')
      || ct.includes('vnd.apple.mpegurl');
}

function isM3UUrl(u='') { return /\.m3u8(\?|$)/i.test(u); }

// Разбор master-плейлиста: выбрать поток с макс. BANDWIDTH
function pickBestVariant(masterText, baseUrl) {
  // Ищем пары (#EXT-X-STREAM-INF ... \n URI)
  const lines = masterText.split(/\r?\n/);
  let best = { bw: -1, uri: null };

  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (!L.startsWith('#EXT-X-STREAM-INF')) continue;
    const bwMatch = L.match(/BANDWIDTH=(\d+)/i);
    const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
    // Следующая непустая строка — обычно URI
    let j = i + 1;
    while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
    if (j >= lines.length) continue;
    const uri = lines[j].trim();
    try {
      const abs = new URL(uri, baseUrl).toString();
      if (bw > best.bw) best = { bw, uri: abs };
    } catch {}
  }
  return best.uri;
}

// Фолбэк: найти любую .m3u8 в тексте (JSON/HTML), вернуть первую
function findM3U8InText(text, baseUrl) {
  const re = /https?:\/\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/ig;
  const m = text.match(re);
  if (m && m.length) return m[0];
  // может быть относительный путь
  const rel = text.match(/[^"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/i);
  if (rel) {
    try { return new URL(rel[0], baseUrl).toString(); } catch {}
  }
  return null;
}

async function main() {
  const rawInput = process.argv[2];
  const refererArg = process.argv[3]; // опционально

  if (!rawInput) {
    console.error('Usage: node m3u8-emulate-player.js "<candidateUrl>" [referer]');
    process.exit(1);
  }

  const candidate = htmlDecodeAmp(rawInput.trim());
  let referer;
  try {
    const u = new URL(candidate);
    referer = refererArg || `${u.protocol}//${u.host}/`;
  } catch {
    console.error('Bad URL:', candidate);
    process.exit(1);
  }

  try {
    const res = await fetch(candidate, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Accept-Language': ACCEPT_LANG,
        'Referer': referer,
        'Accept': 'application/vnd.apple.mpegurl, application/x-mpegURL, */*',
      },
    });

    const finalUrl = res.url; // после редиректов
    const ct = res.headers.get('content-type') || '';
    const bodyText = await res.text();

    // 1) Если ответ — m3u8 и это мастер (#EXTM3U + STREAM-INF), выбираем лучший вариант.
    if (bodyText.startsWith('#EXTM3U')) {
      // master?
      if (bodyText.includes('#EXT-X-STREAM-INF')) {
        const best = pickBestVariant(bodyText, finalUrl);
        if (best) { console.log(best); process.exit(0); }
      }
      // не мастер — это уже media playlist
      // просто возвращаем финальный URL ответа
      console.log(finalUrl);
      process.exit(0);
    }

    // 2) Если тип похож на m3u, но текст не начинается с #EXTM3U — всё равно попробуем вытащить URL
    if (isM3UContentType(ct) || isM3UUrl(finalUrl)) {
      const fromText = findM3U8InText(bodyText, finalUrl);
      console.log(fromText || finalUrl);
      process.exit(0);
    }

    // 3) Если сервер дал JSON/HTML с вложенной m3u8 — пытаемся найти внутри
    const embedded = findM3U8InText(bodyText, finalUrl);
    if (embedded) {
      // На всякий — проверим, не мастер ли это (быстрый повторный fetch)
      try {
        const r2 = await fetch(embedded, {
          headers: { 'User-Agent': UA, 'Accept-Language': ACCEPT_LANG, 'Referer': referer },
          redirect: 'follow',
        });
        const t2 = await r2.text();
        if (t2.startsWith('#EXTM3U') && t2.includes('#EXT-X-STREAM-INF')) {
          const best = pickBestVariant(t2, r2.url);
          console.log(best || r2.url);
          process.exit(0);
        }
        console.log(r2.url || embedded);
        process.exit(0);
      } catch {
        console.log(embedded);
        process.exit(0);
      }
    }

    // 4) Ничего не нашли
    console.error('Не удалось извлечь .m3u8 из ответа.');
    process.exit(2);
  } catch (e) {
    console.error('Ошибка сети:', e?.message || e);
    process.exit(2);
  }
}

main();
