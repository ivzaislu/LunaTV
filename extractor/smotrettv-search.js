// node extractor/smotrettv-sport-human.js <startUrl> <timeoutSec> [--pages=5] [--headful] [--proxy=http://user:pass@host:port] [--cookies=cookies.json]
// Собирает JSON-массив абсолютных URL карточек каналов из /tv/sport/ на smotrettv.com
// Максимально "по-человечески": stealth + анти-детект хаки + реальное поведение пользователя.

import fs from "node:fs";
import { URL } from "node:url";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

/* ---------- утилиты ---------- */

const RAND = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const SLEEP = (ms) => new Promise(r => setTimeout(r, ms));

const UA_POOL = [
  // Несколько «свежих» десктопных UA (Chrome ветки 122–126)
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0", // пусть встречается и FF
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
];

const VIEWPORT_POOL = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
  { width: 1280, height: 800 }
];

function normalize(u) {
  try {
    const x = new URL(u);
    const scheme = (x.protocol || "http:").toLowerCase();
    const host = (x.hostname || "").toLowerCase();
    if (!host) return u;
    let netloc = host;
    const p = x.port ? parseInt(x.port, 10) : null;
    if (p && !((scheme === "http:" && p === 80) || (scheme === "https:" && p === 443))) {
      netloc = `${host}:${p}`;
    }
    let path = (x.pathname || "/").replace(/\/+/, "/").replace(/\/$/, "");
    if (!path) path = "/";
    return `${scheme}//${netloc}${path}${x.search || ""}`;
  } catch {
    return u;
  }
}

function isSportChannelPath(pathname) {
  return /^\/tv\/sport\/\d+-[a-z0-9\-]+\.html$/i.test(pathname || "");
}
function isSportChannelUrl(abs) {
  try {
    const u = new URL(abs);
    if (!/^(https?:)\/\/smotrettv\.com$/i.test(`${u.protocol}//${u.hostname}`)) return false;
    return isSportChannelPath(u.pathname);
  } catch { return false; }
}
function uniqPush(destArr, srcArr, seenSet) {
  for (const u of srcArr) {
    const norm = normalize(u);
    if (seenSet.has(norm)) continue;
    seenSet.add(norm);
    destArr.push(norm);
  }
}

function parseCli() {
  const startUrl = process.argv[2];
  const timeoutSec = parseInt(process.argv[3] || "25", 10);
  const pagesArg = process.argv.find(a => a.startsWith("--pages="));
  const maxPages = pagesArg ? Math.max(1, parseInt(pagesArg.split("=")[1], 10) || 1) : 5;
  const headful = process.argv.includes("--headful");
  const proxyArg = process.argv.find(a => a.startsWith("--proxy="));
  const proxy = proxyArg ? proxyArg.slice("--proxy=".length) : null;
  const cookiesArg = process.argv.find(a => a.startsWith("--cookies="));
  const cookiesPath = cookiesArg ? cookiesArg.slice("--cookies=".length) : null;

  if (!startUrl) {
    console.error("Usage: node extractor/smotrettv-sport-human.js <startUrl> <timeoutSec> [--pages=5] [--headful] [--proxy=...] [--cookies=path]");
    process.stdout.write("[]");
    process.exit(2);
  }
  return { startUrl, timeoutSec, maxPages, headful, proxy, cookiesPath };
}

/* ---------- «человекоподобная» настройка страницы ---------- */

async function humanizePage(page, { ua, viewport }) {
  // UA, ч.з.
  await page.setUserAgent(ua);
  await page.setViewport({
    ...viewport,
    deviceScaleFactor: [1, 1.25, 1.5][RAND(0,2)],
    isLandscape: true,
    hasTouch: Math.random() < 0.15
  });

  // Языки / часовой пояс / геолокация
  await page.emulateTimezone("Europe/Berlin");
  await page.setExtraHTTPHeaders({
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    "Sec-CH-UA": `"Chromium";v="${RAND(122,126)}", "Not(A:Brand";v="24", "Google Chrome";v="${RAND(122,126)}"`,
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": `"Windows"`,
    "Upgrade-Insecure-Requests": "1",
    "Pragma": "no-cache",
    "Cache-Control": "no-cache",
    "DNT": "1"
  });

  // Доп. анти-детект (поверх Stealth): переопределяем признаки прямо до любого скрипта страницы
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });

    // Плагины и mimeTypes
    Object.defineProperty(navigator, "plugins", { get: () => [ {name:"Chrome PDF Plugin"}, {name:"Chrome PDF Viewer"}, {name:"Native Client"} ] });
    Object.defineProperty(navigator, "mimeTypes", { get: () => [ {type:"application/pdf"}, {type:"application/x-nacl"} ] });

    // Языки
    Object.defineProperty(navigator, "languages", { get: () => ["ru-RU","ru","en-US","en"] });

    // Девайс-параметры
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => [4,6,8][Math.floor(Math.random()*3)] });
    Object.defineProperty(navigator, "deviceMemory", { get: () => [4,8,16][Math.floor(Math.random()*3)] });

    // WebGL vendor/renderer
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return "Intel Inc."; // UNMASKED_VENDOR_WEBGL
      if (param === 37446) return "Intel(R) Iris(R) Xe Graphics"; // UNMASKED_RENDERER_WEBGL
      return getParameter.call(this, param);
    };

    // Медиа-кодеки (часто палят по этому)
    const canPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function(type) {
      if (type === "video/mp4; codecs=\"avc1.42E01E\"") return "probably";
      if (type === "audio/ogg; codecs=vorbis") return "probably";
      return canPlayType.call(this, type);
    };

    // Permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === "notifications" ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );
  });
}

/* ---------- поведение пользователя ---------- */

async function humanBrowse(page) {
  // пару случайных скроллов
  const totalScrolls = RAND(2, 5);
  for (let i = 0; i < totalScrolls; i++) {
    const distance = RAND(200, 600);
    await page.mouse.wheel({ deltaY: distance });
    await SLEEP(RAND(200, 900));
  }
  // возврат немного вверх
  await page.mouse.wheel({ deltaY: -RAND(100, 300) });
  await SLEEP(RAND(200, 600));

  // случайные движения мыши
  const vp = await page.viewport();
  const moves = RAND(10, 25);
  for (let i = 0; i < moves; i++) {
    await page.mouse.move(RAND(20, vp.width - 20), RAND(100, vp.height - 50), { steps: RAND(2, 6) });
    await SLEEP(RAND(50, 180));
  }

  // наводим на несколько карточек, если есть
  const cards = await page.$$(".sect__content #dle-content a.thumb[href]");
  const toHover = cards.slice(0, RAND(2, Math.min(6, cards.length)));
  for (const el of toHover) {
    try {
      const box = await el.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width/2, box.y + box.height/2, { steps: RAND(3,8) });
        await SLEEP(RAND(150, 400));
      }
    } catch {}
  }
}

/* ---------- извлечение ссылок ---------- */

async function collectFromRendered(page) {
  // Основной сценарий: карточки в контенте
  const hrefs = await page.$$eval(
    ".sect__content #dle-content a.thumb[href], .content .sect #dle-content a.thumb[href]",
    nodes => nodes.map(n => (n.getAttribute("href") || "").trim()).filter(Boolean)
  ).catch(() => []);

  // Если карточек ноль — запасной план: все <a>, но фильтранём строго
  const allAnchors = hrefs.length ? [] : await page.$$eval(
    "a[href]",
    nodes => nodes.map(n => (n.getAttribute("href") || "").trim()).filter(Boolean)
  ).catch(() => []);

  const origin = await page.evaluate(() => location.origin);
  const toAbs = (h) => {
    try { return new URL(h, origin).toString(); } catch { return null; }
  };

  let list = (hrefs.length ? hrefs : allAnchors)
    .map(toAbs)
    .filter(Boolean)
  // дополнительно отрежем всё, что не карточка /tv/sport/<id>-<slug>.html
    .filter(isSportChannelUrl);

  // Если всё ещё ноль — режем из итогового HTML
  if (!list.length) {
    const html = await page.evaluate(() => document.documentElement.outerHTML || "");
    const re = /href\s*=\s*["']\s*(?:https?:\/\/smotrettv\.com)?(\/tv\/sport\/\d+-[a-z0-9\-]+\.html)\s*["']/ig;
    const base = await page.evaluate(() => location.href);
    const abs = new Set();
    let m; 
    while ((m = re.exec(html)) !== null) {
      try {
        const u = new URL(m[1], base).toString();
        if (isSportChannelUrl(u)) abs.add(u);
      } catch {}
    }
    list = Array.from(abs);
  }

  return Array.from(new Set(list));
}

async function getNextPageUrl(page) {
  // типовая пагинация: последняя ссылка в блоке страниц
  const href = await page.$eval("#pagination .pagination__pages a[href]:last-child", n => n.getAttribute("href"))
    .catch(() => null);
  if (!href) return null;
  try {
    const base = await page.evaluate(() => location.href);
    const next = new URL(href, base).toString();
    const cur = new URL(base).toString();
    if (normalize(next) === normalize(cur)) return null;
    return next;
  } catch { return null; }
}

/* ---------- загрузка кук ---------- */

async function loadCookies(page, cookiesPath, urlForDomain) {
  if (!cookiesPath) return;
  try {
    const raw = fs.readFileSync(cookiesPath, "utf8");
    const cookies = JSON.parse(raw);
    const baseHost = new URL(urlForDomain).hostname.replace(/^www\./, "");
    const filtered = cookies.filter(c => (c.domain || "").includes(baseHost));
    if (filtered.length) await page.setCookie(...filtered);
  } catch (e) {
    console.error("cookie load error:", e?.message || e);
  }
}

/* ---------- main ---------- */

(async function main() {
  const { startUrl, timeoutSec, maxPages, headful, proxy, cookiesPath } = parseCli();

  const ua = UA_POOL[RAND(0, UA_POOL.length - 1)];
  const viewport = VIEWPORT_POOL[RAND(0, VIEWPORT_POOL.length - 1)];

  const launchArgs = [
    "--no-sandbox", "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    // частично имитируем обычный запуск
    `--window-size=${viewport.width},${viewport.height}`,
  ];
  if (proxy) launchArgs.push(`--proxy-server=${proxy}`);

  const browser = await puppeteer.launch({
    headless: !headful ? "new" : false,
    args: launchArgs,
    defaultViewport: null, // используем окно
  });

  const ctx = await browser.createIncognitoBrowserContext();
  const page = await ctx.newPage();

  await humanizePage(page, { ua, viewport });

  // Разрешим геолокацию (если сайт запрашивает)
  try {
    const client = await page.target().createCDPSession();
    await client.send("Browser.grantPermissions", {
      origin: new URL(startUrl).origin,
      permissions: ["geolocation"]
    });
  } catch {}

  // Куки (если есть)
  await loadCookies(page, cookiesPath, startUrl);

  const all = [];
  const seen = new Set();
  let url = startUrl;
  let pagesDone = 0;

  try {
    while (url && pagesDone < maxPages) {
      pagesDone += 1;

      // Реалистичный заход — иногда с промежуточной «задумчивостью»
      await page.goto(url, {
        waitUntil: ["domcontentloaded", "networkidle2"],
        timeout: Math.max(1000, timeoutSec * 1000),
      });

      // «Человеческие» действия до и после появления контента
      await humanBrowse(page);

      // Ждём карточки разумно, потом ещё раз «пошевелимся» и подождём
      try {
        await page.waitForSelector(".sect__content #dle-content a.thumb[href]", {
          timeout: Math.max(600, (timeoutSec * 1000) / 2)
        });
      } catch {}
      await humanBrowse(page);

      // Ещё один «докрут до низа», чтобы подхватить ленивую вёрстку
      let lastHeight = await page.evaluate(() => document.body.scrollHeight);
      for (let i = 0; i < 4; i++) {
        await page.mouse.wheel({ deltaY: lastHeight });
        await SLEEP(RAND(400, 900));
        const newHeight = await page.evaluate(() => document.body.scrollHeight);
        if (newHeight === lastHeight) break;
        lastHeight = newHeight;
      }

      const links = await collectFromRendered(page);
      uniqPush(all, links, seen);

      const next = await getNextPageUrl(page);

      // небольшая случайная пауза между страницами
      await SLEEP(RAND(500, 1200));
      url = next;
    }
  } catch (e) {
    console.error("puppeteer error:", e?.message || e);
  } finally {
    await browser.close();
  }

  process.stdout.write(JSON.stringify(all));
})();
