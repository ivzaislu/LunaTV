// DEBUG=1 TIMEOUT_SEC=45 node live-viks-extractor.cjs "<pageUrl>" [referer] [cookie]
const { URL } = require('node:url');
const puppeteer = require('puppeteer');

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
const TIMEOUT_SEC = parseInt(process.env.TIMEOUT_SEC || '45', 10);
const NAV_TIMEOUT = Math.max(60000, TIMEOUT_SEC * 1000 + 10000);
const log = (...a)=>{ if (DEBUG) console.error('[DEBUG]', ...a); };

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function isM3UUrl(u=''){ return /\.m3u8(\?|$)/i.test(u); }
function isHttpish(u=''){ return /^https?:\/\//i.test(u) || /^\/\//.test(u) || /^:\/*/.test(u); }
function normalizeMaybeProtocolRelative(u) {
  if (!u) return u;
  if (/^:\/*/i.test(u)) return 'https' + u;
  if (/^\/\//.test(u))   return 'https:' + u;
  return u;
}
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
function findAllM3U8InHtml(text, baseUrl){
  const out = new Set();
  const reAbs = /https?:\/\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/ig;
  for (const m of text.match(reAbs) || []) out.add(m);
  const reRel = /(?<!["'])\b(?:\/\/)?[^"'<>]{1,200}?\.m3u8(?:\?[^\s"'<>]*)?/ig;
  for (const m of text.match(reRel) || []) {
    const norm = normalizeMaybeProtocolRelative(m);
    try { out.add(new URL(norm, baseUrl).toString()); } catch {}
  }
  return [...out];
}
function parseKodkKosFile(text, baseUrl){
  const out = { kodk:null, kos:null, file:null };
  const mKodk = text.match(/var\s+kodk\s*=\s*["']([^"']+\.m3u8[^"']*)["']/i);
  if (mKodk) {
    try { out.kodk = new URL(normalizeMaybeProtocolRelative(mKodk[1]), baseUrl).toString(); }
    catch { out.kodk = mKodk[1]; }
  }
  const mKos = text.match(/var\s+kos\s*=\s*["']([^"']+)["']/i);
  if (mKos) out.kos = mKos[1];
  const reFile = /Playerjs\s*\(\s*\{\s*[^}]*?\bfile\s*:\s*["']([^"']+)["']/ig;
  let m, last=null;
  while ((m = reFile.exec(text))) last = m[1];
  if (last) out.file = last;
  return out;
}
function tryDecodePlayerjsFile(s, base){
  if (!s) return null;
  let t = s;
  if (t.startsWith('#2')) t = t.slice(2);
  const cands = new Set();
  const tryB64 = (x)=>{
    try {
      const d1 = Buffer.from(x, 'base64').toString();
      if (isHttpish(d1) || isM3UUrl(d1)) cands.add(d1);
      if (/^[A-Za-z0-9+/=]{40,}$/.test(d1)) {
        const d2 = Buffer.from(d1,'base64').toString();
        if (isHttpish(d2) || isM3UUrl(d2)) cands.add(d2);
      }
    } catch {}
  };
  tryB64(t);
  const m = t.match(/(.+?=)([A-Za-z0-9+/=]+)$/);
  if (m) { tryB64(m[1]); tryB64(m[2]); }
  for (const c of cands) {
    try { return new URL(c, base).toString(); } catch { return c; }
  }
  return null;
}

// === ШАГ А: браузерный прогрев страницы (скрипты/куки/патчи) ===
async function warmUpPage(pageUrl, cookieArg){
  const browser = await puppeteer.launch({
    headless: 'new',
    ignoreHTTPSErrors: true,
    args: [
      '--no-sandbox','--disable-setuid-sandbox',
      '--disable-gpu','--disable-dev-shm-usage','--no-zygote',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1280,720'
    ],
    defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  });
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();

  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'sec-ch-ua': '"Chromium";v="124", "Not.A/Brand";v="24", "Google Chrome";v="124"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'upgrade-insecure-requests': '1',
  });

  // ранний XHR-патч из вашей страницы (plrjs.org -> srv224.com)
  await page.evaluateOnNewDocument(() => {
    try {
      const oldOpen = window.XMLHttpRequest && window.XMLHttpRequest.prototype.open;
      if (oldOpen) {
        window.XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
          const args = arguments;
          try {
            if (typeof url === 'string' && url.includes('plrjs.org')) {
              args[1] = 'https://srv224.com/zoqAvDGnYVBqLaV70_rxWWg4VaWHDa5Rcc5_4GNwlRtLHCxy8AYdJIo0l6mb5NGbKKQApp9WWuqpBN3wcEa6E7sEJCb7tuXg';
            }
          } catch {}
          return oldOpen.apply(this, args);
        };
      }
      // лог .m3u8 для отладки
      const oldFetch = window.fetch;
      if (oldFetch) {
        window.fetch = function(input, init){
          try {
            const u = (typeof input === 'string') ? input : (input && input.url) ? input.url : String(input);
            if (/\.m3u8(\?|$)/i.test(u)) console.log('[HLS fetch]', u);
          } catch {}
          return oldFetch.apply(this, arguments);
        };
      }
    } catch {}
  });

  // куки на домен страницы (если дали)
  if (cookieArg) {
    try {
      const u = new URL(pageUrl);
      for (const pair of cookieArg.split(';')) {
        const [name, ...rest] = pair.trim().split('=');
        const value = rest.join('=');
        if (!name) continue;
        await page.setCookie({ name, value, domain: u.hostname, path: '/' });
      }
      log('cookies set for', new URL(pageUrl).hostname);
    } catch (e) { log('cookie set fail', e.message); }
  }

  // слушатель ответов для диагностики
  page.on('response', async (res) => {
    try {
      const url = res.url();
      if (!/\.m3u8(\?|$)/i.test(url)) return;
      const ct = res.headers()['content-type'] || '';
      const status = res.status();
      let bytes = 0; try { bytes = (await res.text() || '').length; } catch {}
      log('RESP', status, url, '| CT=', ct, '| bytes=', bytes);
    } catch {}
  });

  // грузим страницу, даём ей «подышать»
  log('PAGE goto', pageUrl);
  try {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  } catch (e) {
    log('PAGE goto fail', e.message);
  }
  // «пинок» плееру
  try {
    await page.mouse.click(300, 300);
    await page.keyboard.press('Space');
  } catch {}
  await page.waitForTimeout(1500);

  return { browser, page };
}

// === ШАГ Б: из этого же контекста идём на kodk и достаем master ===
async function getMasterFromKodkInContext(page, kodk, referer, cookie){
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const headers = { ...req.headers() };
    // Для s.viks/tivix — Referer ОСТАВЛЯЕМ как страница
    try {
      const u = new URL(req.url());
      headers['accept']  = 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*';
      if (/(^|\.)(tivix\.co|viks\.tv)$/i.test(u.hostname)) {
        headers['referer'] = referer; // важный момент!
        headers['origin']  = new URL(referer).origin;
      } else {
        headers['referer'] = `${u.protocol}//${u.host}/`;
        headers['origin']  = `${u.protocol}//${u.host}`;
      }
    } catch {
      headers['referer'] = referer;
    }
    if (cookie) headers['cookie'] = cookie;
    req.continue({ headers }).catch(()=>{ try{ req.continue(); }catch{} });
  });

  let text = '', finalUrl = kodk, ct = '', status = 0;
  try {
    const res = await page.goto(kodk, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT, referer });
    if (res) {
      finalUrl = res.url();
      ct = res.headers()['content-type'] || '';
      status = res.status();
      try { text = await res.text(); } catch {}
    }
    log('NAV', status, finalUrl, '| CT=', ct, '| bytes=', Buffer.byteLength(text||''));
  } catch (e) {
    log('NAV error', e.message);
  } finally {
    try { await page.setRequestInterception(false); } catch {}
  }

  // если тело пустое — попробуем добрать через fetch внутри страницы (с куками)
  if (!text || !text.startsWith('#EXTM3U')) {
    try {
      const r = await page.evaluate(async (u) => {
        const rs = await fetch(u, { redirect: 'follow', credentials: 'include' });
        const t = await rs.text();
        return { t, f: rs.url, ct: rs.headers.get('content-type')||'', st: rs.status };
      }, kodk);
      if (r && r.t) {
        text = r.t; finalUrl = r.f || finalUrl; ct = r.ct || ct; status = r.st || status;
        log('FETCH(in-page)', status, finalUrl, '| CT=', ct, '| bytes=', text.length);
      }
    } catch (e) {
      log('in-page fetch fail', e.message);
    }
  }

  if (text && text.startsWith('#EXTM3U')) {
    const kind = classify(text);
    if (kind === 'master') return pickBest(text, finalUrl) || finalUrl;
    if (kind === 'media') {
      for (const g of guessMasterUrlsFromMedia(finalUrl)) {
        try {
          const r2 = await page.goto(g, { waitUntil: 'domcontentloaded', timeout: 30000, referer });
          const t2 = r2 ? await r2.text() : '';
          if (t2 && t2.startsWith('#EXTM3U') && classify(t2) === 'master')
            return pickBest(t2, r2.url()) || r2.url();
        } catch {}
      }
      return finalUrl;
    }
  }
  return null;
}

// ——— Быстрый fetch (для сторонних CDN, не viks/tivix)
async function fetchText(u, referer, cookie){
  const r = await fetch(u, {
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
      'Referer': referer,
      ...(cookie ? { 'Cookie': cookie } : {}),
    }
  });
  const text = await r.text();
  const finalUrl = r.url || u;
  const ct = r.headers.get('content-type') || '';
  log('FETCH', r.status, finalUrl, '| CT=', ct, '| bytes=', text.length);
  return { text, finalUrl, ct };
}

async function main(){
  const pageUrl    = process.argv[2];
  const refererArg = process.argv[3];
  const cookieArg  = process.argv[4];
  if (!pageUrl) {
    console.error('Usage: DEBUG=1 TIMEOUT_SEC=45 node live-viks-extractor.cjs "<pageUrl>" [referer] [cookie]');
    process.exit(1);
  }
  const referer = refererArg || pageUrl;

  // 1) качаем HTML страницы
  let html = '';
  try {
    const r = await fetch(pageUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': referer,
        ...(cookieArg ? { 'Cookie': cookieArg } : {}),
      }
    });
    html = await r.text();
    log('PAGE', r.url, '| bytes=', html.length);
  } catch (e) {
    console.error('Ошибка загрузки страницы:', e.message);
    process.exit(2);
  }

  // 2) вытащим параметры
  const { kodk, kos, file } = parseKodkKosFile(html, pageUrl);
  const foundM3U8 = findAllM3U8InHtml(html, pageUrl);
  log('Extracted:', { kodk, kos, file, m3u8: foundM3U8.slice(0,3) });

  // 3) если видим viks/tivix — идем через прогрев страницы
  let best = null;
  if (kodk) {
    const host = (()=>{ try { return new URL(kodk).hostname; } catch { return ''; } })();
    if (/(^|\.)(tivix\.co|viks\.tv)$/i.test(host)) {
      const { browser, page } = await warmUpPage(pageUrl, cookieArg);
      try {
        best = await getMasterFromKodkInContext(page, kodk, referer, cookieArg);
      } finally {
        await browser.close();
      }
      if (best) { console.log(best); process.exit(0); }
      // если не вышло — пойдем обычным путём ниже
    }
  }

  // 4) пробуем раскодировать file (вдруг там прямой URL)
  let decoded = null;
  if (file) decoded = tryDecodePlayerjsFile(file, pageUrl);
  if (decoded) foundM3U8.unshift(decoded);

  // 5) перебор найденных .m3u8 обычным fetch (для других CDN)
  let mediaAlt = null;
  for (const u of Array.from(new Set(foundM3U8))) {
    try {
      const { text, finalUrl } = await fetchText(u, referer, cookieArg);
      if (text && text.startsWith('#EXTM3U')) {
        const kind = classify(text);
        if (kind === 'master') { console.log(pickBest(text, finalUrl) || finalUrl); process.exit(0); }
        if (kind === 'media' && !mediaAlt) mediaAlt = finalUrl;
      }
    } catch {}
  }

  if (mediaAlt) { console.log(mediaAlt); process.exit(0); }
  console.error('Не удалось получить master/media. Нужен свежий k= и/или cookies.');
  process.exit(2);
}

main().catch(e => { console.error('Ошибка:', e.message); process.exit(2); });
