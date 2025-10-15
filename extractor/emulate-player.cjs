// DEBUG=1 TIMEOUT_SEC=30 node emulate-player.cjs --kodk "<url>" [--file "<playerjs_file>"] [--referer "<page url>"]
const puppeteer = require('puppeteer');
const { URL } = require('node:url');

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
const TIMEOUT_SEC = parseInt(process.env.TIMEOUT_SEC || '30', 10);
const log = (...a)=>{ if (DEBUG) console.error('[DEBUG]', ...a); };

function arg(key, def=null){
  const i = process.argv.indexOf(key);
  return (i>0 && i+1<process.argv.length) ? process.argv[i+1] : def;
}
const KODK = arg('--kodk') || '';
const FILE = arg('--file') || '';
const PAGE_REFERER = arg('--referer') || (KODK ? (new URL(KODK).origin + '/') : 'http://live.viks.tv/');

if (!KODK && !FILE) {
  console.error('Usage: node emulate-player.cjs --kodk "<m3u8 or page url>" [--file "<playerjs file>"] [--referer "<page url>"]');
  process.exit(1);
}

const M3U8_RE = /\.m3u8(\?|$)/i;

function classify(text){
  if (!text || !text.startsWith('#EXTM3U')) return 'unknown';
  if (/#EXT-X-STREAM-INF\b/i.test(text)) return 'master';
  if (/#EXTINF\b/i.test(text) || /#EXT-X-TARGETDURATION\b/i.test(text)) return 'media';
  return 'unknown';
}
function pickBest(masterText, baseUrl){
  const lines = masterText.split(/\r?\n/);
  let best = { bw: -1, uri: null };
  for (let i=0;i<lines.length;i++){
    const L = lines[i];
    if (!L.startsWith('#EXT-X-STREAM-INF')) continue;
    const m = L.match(/BANDWIDTH=(\d+)/i);
    const bw = m ? parseInt(m[1],10) : 0;
    let j=i+1; while (j<lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
    if (j>=lines.length) continue;
    const uri = lines[j].trim();
    try { const abs = new URL(uri, baseUrl).toString(); if (bw > best.bw) best = { bw, uri: abs }; } catch {}
  }
  return best.uri;
}
function guessMasterUrlsFromMedia(mediaUrl){
  const out = new Set();
  try {
    const u = new URL(mediaUrl);
    if (/index\.m3u8$/i.test(u.pathname)) {
      out.add(new URL(u.pathname.replace(/index\.m3u8$/i, 'master.m3u8'), u).toString());
      out.add(new URL(u.pathname.replace(/index\.m3u8$/i, 'playlist.m3u8'), u).toString());
    }
    const parent = u.pathname.replace(/\/[^/]+\.m3u8$/i, '/');
    out.add(new URL(parent + 'master.m3u8', u).toString());
    out.add(new URL(parent + 'playlist.m3u8', u).toString());
    const stripped = u.pathname.replace(/\/\d+\/index\.m3u8$/i, '/index.m3u8');
    if (stripped !== u.pathname) out.add(new URL(stripped, u).toString());
  } catch {}
  return [...out];
}
// попытка дешифрации playerjs file: поддержим простые base64/двойной base64
function tryDecodeFileToUrl(s, base){
  if (!s) return null;
  if (s.startsWith('#2')) s = s.slice(2);
  const candidates = [];
  // прямой base64 и двойной
  const tryB64 = (x)=>{
    try {
      const b = Buffer.from(x, 'base64').toString();
      if (/^https?:\/\//i.test(b) || M3U8_RE.test(b)) candidates.push(b);
      if (/^[A-Za-z0-9+/=]{40,}$/.test(b)) {
        const bb = Buffer.from(b, 'base64').toString();
        if (/^https?:\/\//i.test(bb) || M3U8_RE.test(bb)) candidates.push(bb);
      }
    } catch {}
  };
  // строка могла быть склеена из двух base64 кусков
  const m = s.match(/(.+?=)([A-Za-z0-9+/=]+)$/);
  if (m) { tryB64(m[1]); tryB64(m[2]); }
  tryB64(s);
  // абсолютим
  const outs = [];
  for (const c of candidates) {
    try { outs.push(new URL(c, base).toString()); } catch { outs.push(c); }
  }
  return outs.find(x => /^https?:\/\//i.test(x)) || null;
}

async function main(){
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox','--disable-setuid-sandbox',
      '--disable-gpu','--disable-dev-shm-usage','--no-zygote',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1280,720'
    ],
    defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  });

  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(Math.max(45000, TIMEOUT_SEC*1000+5000));
  page.setDefaultTimeout(Math.max(20000, TIMEOUT_SEC*1000));

  // Заголовки для «навигации»
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7' });

  // Перехват запросов: проставляем Referer/Origin под целевой хост (tivix/viks)
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    const headers = { ...req.headers() };
    try {
      const u = new URL(url);
      const host = u.host;
      if (/\.(tivix\.co|viks\.tv)$/i.test(host) || /(^|\.)tivix\.co$/i.test(host) || /(^|\.)viks\.tv$/i.test(host)) {
        headers['referer'] = `${u.protocol}//${u.host}/`;
        headers['origin']  = `${u.protocol}//${u.host}`;
      } else if (!headers['referer']) {
        headers['referer'] = PAGE_REFERER;
      }
    } catch {
      if (!headers['referer']) headers['referer'] = PAGE_REFERER;
    }
    req.continue({ headers });
  });

  // Откроем пустую страницу и будем делать fetch из контекста
  await page.goto('about:blank');

  // вспомогательные функции в контексте страницы
  await page.exposeFunction('doFetchText', async (url) => {
    const r = await fetch(url, { redirect: 'follow', credentials: 'include' });
    const t = await r.text();
    return { text: t, finalUrl: r.url, ct: r.headers.get('content-type') || '' };
  });

  async function fetchHls(url){
    const r = await page.evaluate(async (u)=>await window.doFetchText(u), url);
    log('FETCH', r.finalUrl, '| CT=', r.ct, '| bytes=', (r.text||'').length);
    if (r.text && r.text.startsWith('#EXTM3U')) {
      const kind = classify(r.text);
      if (kind === 'master') return { kind:'master', best: pickBest(r.text, r.finalUrl) || r.finalUrl, master: r.finalUrl };
      if (kind === 'media')  return { kind:'media',  media: r.finalUrl };
    }
    return { kind:'unknown' };
  }

  let candidates = [];

  if (KODK) candidates.push(KODK);
  // попробуем раскодировать Playerjs file (если это base64/двойной base64)
  const decoded = tryDecodeFileToUrl(FILE, KODK || PAGE_REFERER);
  if (decoded) candidates.push(decoded);

  // Уникализируем
  candidates = Array.from(new Set(candidates));

  log('Candidates:', candidates);

  let bestOut = null, mediaAlt = null;

  // 1) прогоняем все кандидаты
  for (const c of candidates) {
    const r = await fetchHls(c);
    if (r.kind === 'master') { bestOut = r.best; break; }
    if (r.kind === 'media' && !mediaAlt) mediaAlt = r.media;
  }

  // 2) если пока только media — пробуем родительские master-эвристики
  if (!bestOut && mediaAlt) {
    for (const g of guessMasterUrlsFromMedia(mediaAlt)) {
      const r = await fetchHls(g);
      if (r.kind === 'master') { bestOut = r.best; break; }
    }
  }

  await browser.close();

  if (bestOut) { console.log(bestOut); process.exit(0); }
  if (mediaAlt) { console.log(mediaAlt); process.exit(0); }
  console.error('Не удалось получить master/media. Проверьте реферер/валидность k.');
  process.exit(2);
}

main().catch(e => { console.error('Ошибка:', e.message); process.exit(2); });
