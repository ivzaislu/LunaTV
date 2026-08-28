// smotrettv-m3u8-human.js
// Usage:
//   node smotrettv-m3u8-human.js "<page-or-candidate-url>" [timeoutSeconds|referer]

import { URL } from 'node:url';
import { chromium } from 'playwright-core';

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

export function findM3U8InText(text, baseUrl) {
  const re = /https?:\/\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/ig;
  const m = text.match(re);
  if (m && m.length) return htmlDecodeAmp(m[0]);
  const rel = text.match(/[^"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/i);
  if (rel) {
    try { return new URL(htmlDecodeAmp(rel[0]), baseUrl).toString(); } catch {}
  }
  return null;
}

function collectM3U8(text, baseUrl, out) {
  if (!text) return;
  const re = /https?:\/\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/ig;
  for (const match of text.matchAll(re)) out.add(htmlDecodeAmp(match[0]));
  const quoted = text.match(/["']([^"'<>]+\.m3u8[^"'<>}]*)["']/gi) || [];
  for (const raw of quoted) {
    try { out.add(new URL(htmlDecodeAmp(raw.slice(1, -1)), baseUrl).toString()); } catch {}
  }
}

function cliRefererArg(value) {
  if (!value || /^\d+(?:\.\d+)?$/.test(value)) return null;
  return value;
}

function cliTimeoutSeconds(value) {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return 12;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 60) : 12;
}

function isTimeoutError(error) {
  return /timeout/i.test(String(error?.name || '')) || /timeout/i.test(String(error?.message || ''));
}

async function browserCandidates(candidate, referer, timeoutMs) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  });
  let context;
  try {
    context = await browser.newContext({
      userAgent: UA,
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 720 },
      extraHTTPHeaders: { 'Accept-Language': ACCEPT_LANG },
    });
    const page = await context.newPage();
    const streams = new Set();
    const remember = (url) => {
      if (typeof url === 'string' && url.toLowerCase().includes('.m3u8')) streams.add(htmlDecodeAmp(url));
    };

    page.on('request', (request) => remember(request.url()));
    page.on('response', (response) => remember(response.url()));

    await context.route('**/*', (route) => {
      const request = route.request();
      const url = request.url().toLowerCase();
      if (url.includes('.m3u8')) return route.continue();
      if (['image', 'font', 'stylesheet'].includes(request.resourceType())) return route.abort();
      if (request.resourceType() === 'media' && /\.(?:ts|m4s|mp4)(?:[?#]|$)/i.test(url)) return route.abort();
      return route.continue();
    });

    try {
      await page.goto(candidate, { referer, waitUntil: 'domcontentloaded', timeout: timeoutMs });
    } catch (error) {
      if (!isTimeoutError(error) || page.url() === 'about:blank') throw error;
    }

    await page.waitForTimeout(Math.min(5000, Math.max(1800, Math.floor(timeoutMs / 3))));
    try { collectM3U8(await page.content(), page.url(), streams); } catch {}
    for (const frame of page.frames()) {
      try { collectM3U8(await frame.content(), frame.url() || page.url(), streams); } catch {}
    }
    return Array.from(streams);
  } finally {
    if (context) { try { await context.close(); } catch {} }
    try { await browser.close(); } catch {}
  }
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
  const timeoutSec = cliTimeoutSeconds(optionalArg);
  const timeoutMs = timeoutSec * 1000;
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(candidate, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': UA,
          'Accept-Language': ACCEPT_LANG,
          'Referer': referer,
          'Accept': 'text/html, application/vnd.apple.mpegurl, application/x-mpegURL, */*',
        },
      });
    } finally {
      clearTimeout(timer);
    }

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
      console.log(embedded);
      process.exit(0);
    }

    const browser = await browserCandidates(finalUrl || candidate, referer, timeoutMs);
    if (browser.length) {
      console.log(browser[0]);
      process.exit(0);
    }

    console.error('Не удалось извлечь .m3u8 из HTTP или browser fallback.');
    process.exit(2);
  } catch (e) {
    // If plain HTTP is blocked, still give the browser path a chance.
    try {
      const browser = await browserCandidates(candidate, referer, timeoutMs);
      if (browser.length) {
        console.log(browser[0]);
        process.exit(0);
      }
    } catch {}
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
  if (cliTimeoutSeconds('15') !== 15 || cliTimeoutSeconds('https://example.com/') !== 12) {
    throw new Error('CLI timeout parsing failed');
  }
  const sample = findM3U8InText('file:"https://cdn.example/live/index.m3u8?token=1"', 'https://example.com/');
  if (sample !== 'https://cdn.example/live/index.m3u8?token=1') {
    throw new Error('M3U8 text extraction failed');
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
