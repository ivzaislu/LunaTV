// smotrettv-m3u8-human.js
// Usage:
//   node smotrettv-m3u8-human.js "<page-or-candidate-url>" [timeoutSeconds|referer]

import { URL } from 'node:url';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ACCEPT_LANG = 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7';

function htmlDecodeAmp(s) { return s.replace(/&amp;/g, '&'); }

export function normalizeSmotretTvUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.hostname.toLowerCase() === 'smotrettv.com') {
      url.protocol = 'https:';
      url.hostname = 'smotrettv.net';
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function isM3UContentType(ct='') {
  ct = ct.toLowerCase();
  return ct.includes('application/vnd.apple.mpegurl')
      || ct.includes('application/x-mpegurl')
      || ct.includes('audio/mpegurl')
      || ct.includes('vnd.apple.mpegurl');
}

function isM3UUrl(u='') { return /\.m3u8(\?|$)/i.test(u); }

function pickBestVariant(masterText, baseUrl) {
  const lines = masterText.split(/\r?\n/);
  let best = { bw: -1, uri: null };

  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (!L.startsWith('#EXT-X-STREAM-INF')) continue;
    const bwMatch = L.match(/BANDWIDTH=(\d+)/i);
    const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
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

function findM3U8InText(text, baseUrl) {
  const re = /https?:\/\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/ig;
  const m = text.match(re);
  if (m && m.length) return htmlDecodeAmp(m[0]);
  const rel = text.match(/[^"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/i);
  if (rel) {
    try { return new URL(htmlDecodeAmp(rel[0]), baseUrl).toString(); } catch {}
  }
  return null;
}

function cliRefererArg(value) {
  if (!value || /^\d+(?:\.\d+)?$/.test(value)) return null;
  return value;
}

async function main() {
  const rawInput = process.argv[2];
  const optionalArg = process.argv[3];

  if (!rawInput) {
    console.error('Usage: node smotrettv-m3u8-human.js "<page-or-candidate-url>" [timeoutSeconds|referer]');
    process.exit(1);
  }

  const originalCandidate = htmlDecodeAmp(rawInput.trim());
  const candidate = normalizeSmotretTvUrl(originalCandidate);
  const refererArg = cliRefererArg(optionalArg);
  let referer;
  try {
    const u = new URL(candidate);
    referer = refererArg || `${u.protocol}//${u.host}/`;
  } catch {
    console.error('Bad URL:', candidate);
    process.exit(1);
  }

  if (candidate !== originalCandidate) {
    console.error(`[extractor] Source URL migrated: ${originalCandidate} -> ${candidate}`);
  }

  try {
    const res = await fetch(candidate, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Accept-Language': ACCEPT_LANG,
        'Referer': referer,
        'Accept': 'text/html, application/vnd.apple.mpegurl, application/x-mpegURL, */*',
      },
    });

    const finalUrl = res.url;
    const ct = res.headers.get('content-type') || '';
    const bodyText = await res.text();

    if (bodyText.startsWith('#EXTM3U')) {
      if (bodyText.includes('#EXT-X-STREAM-INF')) {
        const best = pickBestVariant(bodyText, finalUrl);
        if (best) { console.log(best); process.exit(0); }
      }
      console.log(finalUrl);
      process.exit(0);
    }

    if (isM3UContentType(ct) || isM3UUrl(finalUrl)) {
      const fromText = findM3U8InText(bodyText, finalUrl);
      console.log(fromText || finalUrl);
      process.exit(0);
    }

    const embedded = findM3U8InText(bodyText, finalUrl);
    if (embedded) {
      try {
        const r2 = await fetch(embedded, {
          headers: { 'User-Agent': UA, 'Accept-Language': ACCEPT_LANG, 'Referer': finalUrl || referer },
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

    console.error('Не удалось извлечь .m3u8 из ответа.');
    process.exit(2);
  } catch (e) {
    console.error('Ошибка сети:', e?.message || e);
    process.exit(2);
  }
}

function selfTest() {
  const migrated = normalizeSmotretTvUrl('http://smotrettv.com/tv/sport/143-setanta-qazaqstan.html');
  if (migrated !== 'https://smotrettv.net/tv/sport/143-setanta-qazaqstan.html') {
    throw new Error(`SmotretTV migration mismatch: ${migrated}`);
  }
  const untouched = normalizeSmotretTvUrl('https://telik.live/demo.html');
  if (untouched !== 'https://telik.live/demo.html') {
    throw new Error(`Unexpected URL rewrite: ${untouched}`);
  }
  if (cliRefererArg('12') !== null || cliRefererArg('https://example.com/') !== 'https://example.com/') {
    throw new Error('CLI timeout/referer parsing failed');
  }
  console.log('Self-test passed');
}

if (process.argv.includes('--selftest')) {
  try {
    selfTest();
  } catch (err) {
    console.error(err?.message || err);
    process.exit(1);
  }
} else {
  main();
}
