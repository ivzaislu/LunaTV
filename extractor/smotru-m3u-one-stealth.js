// smotru-m3u-one-stealth.js
//
// Usage:
//   node smotru-m3u-one-stealth.js "https://smotru.tv/history-2.html" [timeoutSec]
//
// Что делает:
// - Специально под smotru.tv (но сработает и на схожих плеерах/айфреймах).
// - Перехватывает .m3u8 во всех фреймах (в т.ч. вложенных).
// - Завершается сразу после первой 200 OK m3u8 с #EXTM3U.
// - Если такого ответа не пришло — по таймауту вернёт «лучшую» из увиденных ссылок.
// - Снижен палевный след headless-Puppeteer: puppeteer-extra + stealth + правдоподобные отпечатки.

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

const url = process.argv[2];
const timeoutSec = Number(process.argv[3] || 20);
if (!url) {
  console.error('Provide URL: node smotru-m3u-one-stealth.js "https://smotru.tv/history-2.html" [timeoutSec]');
  process.exit(1);
}

// ───────────────────────────────────────────────────────────────────────────────
// Ранжирование «красивых»/правильных HLS-ссылок: чем выше — тем лучше.
const RX_ANY_M3U8 = /\.m3u8(\?|$)/i;
function rank(u) {
  // token/id/10-digit-ts/index.m3u8
  if (/\/[A-Za-z0-9_-]{10,}\/\d+\/\d{10}\/index\.m3u8/i.test(u)) return 4;
  // .../index.m3u8 без ?k=
  if (/\/index\.m3u8(?:$|[#?])/i.test(u) && !/[?&]k=/.test(u)) return 3;
  // .m3u8 с ?k=...
  if (/[?&]k=[^&]+/i.test(u)) return 2;
  // любой .m3u8
  return 1;
}

// ───────────────────────────────────────────────────────────────────────────────
// Stealth + правдоподобные отпечатки
puppeteer.use(StealthPlugin());

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const ACCEPT_LANG = 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7';

(async () => {
  const browser = await puppeteer.launch({
    headless: true, // новый headless достаточно близок к обычному
    args: [
      '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=PrivacySandboxAdsAPIs',
      '--lang=ru-RU,ru',
    ],
    defaultViewport: { width: 1366, height: 768, deviceScaleFactor: 1 },
  });

  const page = await browser.newPage();

  // CDP-override для UA/locale/platform (на уровене сети)
  const client = await page.target().createCDPSession();
  await client.send('Network.setUserAgentOverride', {
    userAgent: UA,
    acceptLanguage: ACCEPT_LANG,
    platform: 'Win32',
  });

  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ 'Accept-Language': ACCEPT_LANG });

  // Лёгкие отпечатки: languages/platform/plugins/WebGL/Audio и т.д.
  await page.evaluateOnNewDocument(() => {
    try {
      Object.defineProperty(navigator, 'languages', { get: () => ['ru-RU','ru','en-US','en'] });
      Object.defineProperty(navigator, 'platform',  { get: () => 'Win32' });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
      Object.defineProperty(navigator, 'webdriver', { get: () => false });

      // Фейковые плагины (многие сайты на них смотрят)
      const fakePlugins = [
        { name: 'Chrome PDF Plugin' },
        { name: 'Chrome PDF Viewer' },
        { name: 'Native Client' },
      ];
      Object.defineProperty(navigator, 'plugins', { get: () => fakePlugins });

      try { screen.orientation = Object.freeze({ type: 'landscape-primary', angle: 0 }); } catch {}

      // Стабилизация WebGL-вендора/рендерера
      const patchGl = (protoName) => {
        const proto = window[protoName] && window[protoName].prototype;
        if (!proto) return;
        const _getParam = proto.getParameter;
        Object.defineProperty(proto, 'getParameter', {
          value: function(p){
            if (p === 37445) return 'Intel Inc.';            // UNMASKED_VENDOR_WEBGL
            if (p === 37446) return 'Intel(R) UHD Graphics'; // UNMASKED_RENDERER_WEBGL
            return _getParam.apply(this, arguments);
          }
        });
      };
      patchGl('WebGLRenderingContext');
      patchGl('WebGL2RenderingContext');

      // Инициализируем аудио-контекст — снижает вариативность фингерпринта
      try { new (window.AudioContext || window.webkitAudioContext)(); } catch {}

      // chrome-объект
      window.chrome = window.chrome || { runtime: {} };
    } catch {}
  });

  let done = false;
  let best = null; // {url, rank}

  const finish = async (u, code = 0) => {
    if (done) return;
    done = true;
    if (u) console.log(u);
    try { await browser.close(); } catch {}
    process.exit(code);
  };

  const consider = (u) => {
    if (!u || !RX_ANY_M3U8.test(u)) return;
    const r = rank(u);
    if (!best || r > best.rank) best = { url: u, rank: r };
  };

  // ───────────────────────────────────────────────────────────────
  // Глобальная прослушка сети (охватывает и подфреймы)
  page.on('request', (req) => consider(req.url()));

  page.on('response', async (res) => {
    const u = res.url();
    if (!RX_ANY_M3U8.test(u)) return;
    consider(u);

    try {
      if (res.status() !== 200) return;

      const headers = res.headers();
      const ct = (headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
      let looks = ct.includes('application/vnd.apple.mpegurl') || ct.includes('application/x-mpegurl');

      if (!looks) {
        // иногда CDN отдают как text/plain — проверяем тело
        const body = await res.text().catch(() => '');
        looks = body.startsWith('#EXTM3U');
      }

      if (looks) {
        await finish(u, 0);
      }
    } catch { /* ignore */ }
  });

  // ───────────────────────────────────────────────────────────────
  // Репорт из контекста страниц/фреймов
  await page.exposeFunction('___reportM3U8', (u) => consider(String(u)));

  // Скрипт-хук, который внедряем ДО исполнения страницы/фрейма
  const INJECT_HOOKS = `
    (function(){
      const rx = /\\.m3u8(\\?|$)/i;

      // fetch
      try {
        const _fetch = window.fetch;
        window.fetch = new Proxy(_fetch, {
          apply(target, thisArg, args){
            try {
              const req = args[0];
              const url = typeof req === 'string' ? req : (req && req.url) || '';
              if (rx.test(url)) { window.___reportM3U8(url); }
            } catch {}
            return Reflect.apply(target, thisArg, args);
          }
        });
      } catch {}

      // XHR
      try {
        const OX = window.XMLHttpRequest;
        function NX(){
          const x = new OX();
          x.addEventListener('readystatechange', ()=> {
            try {
              const u = x.responseURL || '';
              if (u && rx.test(u)) window.___reportM3U8(u);
            } catch {}
          });
          return x;
        }
        window.XMLHttpRequest = NX;
      } catch {}

      // PerformanceObserver — Hls.js часто создаёт fetch-записи
      try {
        const po = new PerformanceObserver((list)=>{
          for (const e of list.getEntries()){
            if (e.name && rx.test(e.name)) window.___reportM3U8(e.name);
          }
        });
        po.observe({ entryTypes: ['resource'] });
      } catch {}

      // Небольшой «пинок» плееру
      window.addEventListener('DOMContentLoaded', ()=>{
        try {
          const v = document.querySelector('video');
          if (v) { v.muted = true; v.play().catch(()=>{}); }
        } catch {}
      }, { once: true });
    })();
  `;

  // Втыкаем хуки в основной документ
  await page.evaluateOnNewDocument(INJECT_HOOKS);

  // И во все будущие присоединённые фреймы ДО их исполнения
  page.on('frameattached', async (frame) => {
    try { await frame.evaluateOnNewDocument(INJECT_HOOKS); } catch {}
  });

  // На всякий — и в уже существующие фреймы «поверх»
  const injectIntoFramesRuntime = async () => {
    const frames = page.frames();
    for (const fr of frames) {
      try { await fr.evaluate(INJECT_HOOKS); } catch {}
    }
  };

  // ───────────────────────────────────────────────────────────────
  // Навигация
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutSec * 1000, 60000) });
  } catch {}

  // Дождёмся iframe и «подтолкнём» его
  try {
    await page.waitForSelector('iframe', { timeout: 5000 });
    await injectIntoFramesRuntime();
  } catch {}

  // Жёсткий таймер — по истечении печатаем лучшую виденную ссылку
  setTimeout(async () => {
    if (done) return;
    if (best) {
      await finish(best.url, 0);
    } else {
      console.error('No .m3u8 found within timeout.');
      await finish(null, 2);
    }
  }, timeoutSec * 1000);
})();
