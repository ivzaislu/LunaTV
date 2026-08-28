// smotrettv-m3u8-human.js
// Fast SmotretTV extractor. Overall extraction budget is capped at 5 seconds.

import { URL } from 'node:url';
import { chromium } from 'playwright-core';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ACCEPT_LANG = 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7';
const MAX_BUDGET_MS = 5000;
const HTTP_FAST_PATH_MS = 800;

function htmlDecodeAmp(s) { return String(s || '').replace(/&amp;/g, '&'); }

export function normalizeSmotretTvUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.hostname.toLowerCase() === 'smotrettv.com') {
      url.protocol = 'https:';
      url.hostname = 'smotrettv.net';
    }
    if (
      url.hostname.toLowerCase() === 'smotrettv.net' &&
      url.pathname === '/tv/sport/144-setanta-sports-1.html'
    ) {
      url.pathname = '/tv/sport/1210-setanta-sports-1.html';
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
    const line = lines[i];
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
    const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
    let j = i + 1;
    while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
    if (j >= lines.length) continue;
    try {
      const abs = new URL(lines[j].trim(), baseUrl).toString();
      if (bw > best.bw) best = { bw, uri: abs };
    } catch {}
  }
  return best.uri;
}

export function findM3U8InText(text, baseUrl) {
  const direct = String(text || '').match(/https?:\/\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/i);
  if (direct) return htmlDecodeAmp(direct[0]);
  const rel = String(text || '').match(/[^"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/i);
  if (rel) {
    try { return new URL(htmlDecodeAmp(rel[0]), baseUrl).toString(); } catch {}
  }
  return null;
}

function cliRefererArg(value) {
  if (!value || /^\d+(?:\.\d+)?$/.test(value)) return null;
  return value;
}

function cliTimeoutSeconds(value) {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return 5;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 5) : 5;
}

function remainingMs(deadline) {
  return Math.max(0, deadline - Date.now());
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function httpCandidate(candidate, referer, deadline) {
  const remaining = remainingMs(deadline);
  const timeoutMs = Math.min(HTTP_FAST_PATH_MS, remaining);
  if (timeoutMs < 100) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(candidate, {
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
    const finalUrl = res.url || candidate;
    const ct = res.headers.get('content-type') || '';
    const bodyText = await res.text();

    if (bodyText.startsWith('#EXTM3U')) {
      if (bodyText.includes('#EXT-X-STREAM-INF')) return pickBestVariant(bodyText, finalUrl) || finalUrl;
      return finalUrl;
    }
    if (isM3UContentType(ct) || isM3UUrl(finalUrl)) {
      return findM3U8InText(bodyText, finalUrl) || finalUrl;
    }
    return findM3U8InText(bodyText, finalUrl);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function browserCandidate(candidate, referer, deadline) {
  if (remainingMs(deadline) < 250) return null;
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
    let first = null;
    let resolveFirst;
    const firstCandidate = new Promise((resolve) => { resolveFirst = resolve; });
    const remember = (raw) => {
      if (first || typeof raw !== 'string' || !raw.toLowerCase().includes('.m3u8')) return;
      first = htmlDecodeAmp(raw);
      resolveFirst?.();
    };

    page.on('request', (request) => remember(request.url()));
    page.on('response', (response) => remember(response.url()));

    await context.route('**/*', (route) => {
      const request = route.request();
      const url = request.url().toLowerCase();
      const type = request.resourceType();
      if (url.includes('.m3u8')) return route.continue();
      if (['image', 'font', 'stylesheet'].includes(type)) return route.abort();
      if (type === 'media' && /\.(?:ts|m4s|mp4)(?:[?#]|$)/i.test(url)) return route.abort();
      return route.continue();
    });

    const navTimeout = Math.min(1400, remainingMs(deadline));
    if (navTimeout > 100) {
      try {
        await Promise.race([
          page.goto(candidate, { referer, waitUntil: 'commit', timeout: navTimeout }),
          firstCandidate,
        ]);
      } catch {}
    }
    if (first) return first;

    try {
      const embedded = findM3U8InText(await page.content(), page.url() || candidate);
      if (embedded) return embedded;
    } catch {}

    const wait = remainingMs(deadline);
    if (wait > 50) await Promise.race([firstCandidate, delay(wait)]);
    return first;
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

  const started = Date.now();
  const originalCandidate = htmlDecodeAmp(rawInput.trim());
  const candidate = normalizeSmotretTvUrl(originalCandidate);
  const refererArg = cliRefererArg(optionalArg);
  const timeoutSec = cliTimeoutSeconds(optionalArg);
  const deadline = Date.now() + Math.min(MAX_BUDGET_MS, timeoutSec * 1000);
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

  const fromHttp = await httpCandidate(candidate, referer, deadline);
  if (fromHttp) {
    console.error(`[extractor] elapsed_ms=${Date.now() - started}`);
    console.log(fromHttp);
    return;
  }

  const fromBrowser = await browserCandidate(candidate, referer, deadline);
  console.error(`[extractor] elapsed_ms=${Date.now() - started}`);
  if (fromBrowser) {
    console.log(fromBrowser);
    return;
  }

  console.error('Не удалось извлечь .m3u8 в пределах 5 секунд.');
  process.exitCode = 2;
}

function selfTest() {
  const migrated = normalizeSmotretTvUrl('http://smotrettv.com/tv/sport/143-setanta-qazaqstan.html');
  if (migrated !== 'https://smotrettv.net/tv/sport/143-setanta-qazaqstan.html') {
    throw new Error(`SmotretTV migration mismatch: ${migrated}`);
  }
  const setanta1 = normalizeSmotretTvUrl('https://smotrettv.com/tv/sport/144-setanta-sports-1.html');
  if (setanta1 !== 'https://smotrettv.net/tv/sport/1210-setanta-sports-1.html') {
    throw new Error(`Setanta Sports 1 migration mismatch: ${setanta1}`);
  }
  if (cliTimeoutSeconds('15') !== 5 || cliTimeoutSeconds(undefined) !== 5) {
    throw new Error('5 second timeout cap failed');
  }
  const sample = findM3U8InText('file:"https://cdn.example/live/index.m3u8?token=1"', 'https://example.com/');
  if (sample !== 'https://cdn.example/live/index.m3u8?token=1') {
    throw new Error('M3U8 text extraction failed');
  }
  console.log('Self-test passed');
}

if (process.argv.includes('--selftest')) {
  try { selfTest(); } catch (err) {
    console.error(err?.message || err);
    process.exit(1);
  }
} else {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
