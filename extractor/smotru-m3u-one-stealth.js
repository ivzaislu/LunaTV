#!/usr/bin/env node
import axios from "axios";
import * as cheerio from "cheerio";
import { chromium } from "playwright-core";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export function normalizeSourceUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.hostname.toLowerCase() === "ip.tivix.co") {
      url.protocol = "https:";
      url.hostname = "live.tivix.co";
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function absoluteUrl(candidate, baseUrl) {
  if (!candidate) return null;
  const trimmed = String(candidate).replace(/&amp;/g, "&").trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

function mergeCandidates(...groups) {
  const seen = new Set();
  const out = [];
  for (const group of groups) {
    for (const raw of group || []) {
      const value = String(raw || "").replace(/&amp;/g, "&").trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function collectFromCheerio($, baseUrl, urls) {
  const addAttr = (selector, attr) => {
    $(selector).each((_, el) => {
      const value = $(el).attr(attr);
      if (typeof value === "string" && value.toLowerCase().includes(".m3u8")) {
        const url = absoluteUrl(value, baseUrl);
        if (url) urls.add(url);
      }
    });
  };

  addAttr("source", "src");
  addAttr("video", "src");
  addAttr("audio", "src");
  addAttr("a", "href");
  addAttr("script", "src");
  addAttr("link", "href");
  addAttr("meta", "content");

  $("*[data-src], *[data-href], *[data-url], *[data-file]").each((_, el) => {
    for (const attr of ["data-src", "data-href", "data-url", "data-file"]) {
      const value = $(el).attr(attr);
      if (typeof value === "string" && value.toLowerCase().includes(".m3u8")) {
        const url = absoluteUrl(value, baseUrl);
        if (url) urls.add(url);
      }
    }
  });
}

function collectFromRegex(html, baseUrl, urls) {
  if (!html) return;
  const regex = /https?:[^'"\s<>]+\.m3u8[^'"\s<>]*/gi;
  for (const match of html.matchAll(regex)) {
    const normalized = absoluteUrl(match[0], baseUrl);
    if (normalized) urls.add(normalized);
  }

  const quoted = /"([^"]*\.m3u8[^"]*)"|'([^']*\.m3u8[^']*)'/gi;
  for (const match of html.matchAll(quoted)) {
    const candidate = match[1] || match[2];
    const normalized = absoluteUrl(candidate, baseUrl);
    if (normalized) urls.add(normalized);
  }
}

export function extractM3U8Candidates(html, baseUrl) {
  const urls = new Set();
  if (!html) return [];

  const safeBase = (() => {
    try {
      return new URL(baseUrl || "about:blank").toString();
    } catch {
      return "about:blank";
    }
  })();

  collectFromRegex(html, safeBase, urls);
  try {
    const $ = cheerio.load(html);
    collectFromCheerio($, safeBase, urls);
  } catch {
    // Regex candidates are still useful if HTML parsing fails.
  }
  return Array.from(urls);
}

async function fetchHtmlWithHttp(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await axios.get(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
      },
      timeout: timeoutMs,
      signal: controller.signal,
      maxRedirects: 5,
      responseType: "text",
      transformResponse: (value) => value,
    });
    const finalUrl = response.request?.res?.responseUrl || url;
    return {
      html: typeof response.data === "string" ? response.data : String(response.data || ""),
      networkCandidates: [],
      finalUrl,
    };
  } finally {
    clearTimeout(timer);
  }
}

function isTimeoutError(error) {
  return /timeout/i.test(String(error?.name || "")) || /timeout/i.test(String(error?.message || ""));
}

async function fetchHtmlWithPlaywright(url, timeoutMs) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  let context;
  try {
    context = await browser.newContext({
      userAgent: USER_AGENT,
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 720 },
      extraHTTPHeaders: { "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8" },
    });

    const page = await context.newPage();
    const networkCandidates = new Set();
    const remember = (candidate) => {
      if (typeof candidate !== "string" || !candidate.toLowerCase().includes(".m3u8")) return;
      const normalized = absoluteUrl(candidate, page.url() === "about:blank" ? url : page.url());
      if (normalized) networkCandidates.add(normalized);
    };

    page.on("request", (request) => remember(request.url()));
    page.on("response", (response) => remember(response.url()));

    await context.route("**/*", (route) => {
      const request = route.request();
      const requestUrl = request.url().toLowerCase();
      const type = request.resourceType();

      if (requestUrl.includes(".m3u8")) {
        route.continue();
        return;
      }
      if (["image", "font", "stylesheet"].includes(type)) {
        route.abort();
        return;
      }
      if (type === "media" && /\.(?:ts|m4s|mp4)(?:[?#]|$)/i.test(requestUrl)) {
        route.abort();
        return;
      }
      route.continue();
    });

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    } catch (error) {
      // Protected/slow players often keep loading forever while the useful player
      // requests have already happened. Preserve those partial results on timeout.
      if (!isTimeoutError(error) || page.url() === "about:blank") throw error;
    }

    await page.waitForTimeout(Math.min(4000, Math.max(1000, Math.floor(timeoutMs / 4))));
    const finalUrl = page.url() === "about:blank" ? url : page.url();
    let html = "";
    try {
      html = await page.content();
    } catch {}

    const frameCandidates = new Set();
    for (const frame of page.frames()) {
      try {
        collectFromRegex(await frame.content(), frame.url() || finalUrl, frameCandidates);
      } catch {
        // Frames can detach while a dynamic player initializes.
      }
    }

    await page.close();
    return {
      html,
      networkCandidates: mergeCandidates(Array.from(networkCandidates), Array.from(frameCandidates)),
      finalUrl,
    };
  } finally {
    if (context) {
      try { await context.close(); } catch {}
    }
    try { await browser.close(); } catch {}
  }
}

function parseCliArgs(argv) {
  const flags = new Set();
  const positional = [];
  for (const arg of argv) {
    if (typeof arg === "string" && arg.startsWith("--")) flags.add(arg);
    else positional.push(arg);
  }
  return { flags, positional };
}

async function run() {
  const { flags, positional } = parseCliArgs(process.argv.slice(2));
  const [pageUrl, timeoutArg] = positional;
  if (!pageUrl) {
    console.error("Usage: node smotru-m3u-one-stealth.js <url> [timeoutSeconds]");
    console.error("       node smotru-m3u-one-stealth.js --http-only <url> [timeoutSeconds]");
    process.exit(1);
  }

  const timeoutSec = Number.parseInt(timeoutArg, 10);
  const timeoutMs = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 10000;
  const httpOnly = flags.has("--http-only") || process.env.EXTRACTOR_HTTP_ONLY === "1";
  const effectivePageUrl = normalizeSourceUrl(pageUrl);

  if (effectivePageUrl !== pageUrl) {
    console.error(`[extractor] Source URL migrated: ${pageUrl} -> ${effectivePageUrl}`);
  }

  let browserLoaded = null;
  let browserError = null;
  if (!httpOnly) {
    try {
      browserLoaded = await fetchHtmlWithPlaywright(effectivePageUrl, timeoutMs);
      const browserCandidates = mergeCandidates(
        browserLoaded.networkCandidates,
        extractM3U8Candidates(browserLoaded.html, browserLoaded.finalUrl || effectivePageUrl),
      );
      if (browserCandidates.length) {
        process.stdout.write(`${JSON.stringify(browserCandidates)}\n`);
        return;
      }
    } catch (error) {
      browserError = error;
    }
  }

  try {
    const httpLoaded = await fetchHtmlWithHttp(effectivePageUrl, timeoutMs);
    const candidates = mergeCandidates(
      browserLoaded?.networkCandidates,
      browserLoaded ? extractM3U8Candidates(browserLoaded.html, browserLoaded.finalUrl || effectivePageUrl) : [],
      extractM3U8Candidates(httpLoaded.html, httpLoaded.finalUrl || effectivePageUrl),
    );
    if (!candidates.length) console.error("[extractor] Потоки не найдены");
    process.stdout.write(`${JSON.stringify(candidates)}\n`);
  } catch (httpError) {
    const error = browserError || httpError;
    console.error(`[extractor] Ошибка: ${error?.message || String(error)}`);
    process.exitCode = 1;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runSelfTest() {
  const sampleHtml = `
    <html>
      <body>
        <video src="/streams/main.m3u8"></video>
        <script>
          const backup = "https://cdn.example.com/backup/index.m3u8?token=abc";
        </script>
        <div data-src="//media.example.org/live/playlist.m3u8"></div>
        <a href="https://example.com/not-stream.mp4">mp4</a>
      </body>
    </html>
  `;
  const base = "https://tv.example.com/watch/page";
  const result = extractM3U8Candidates(sampleHtml, base);
  const expected = new Set([
    "https://tv.example.com/streams/main.m3u8",
    "https://cdn.example.com/backup/index.m3u8?token=abc",
    "https://media.example.org/live/playlist.m3u8",
  ]);
  assert(result.length === expected.size, "Количество ссылок не совпадает");
  for (const url of result) assert(expected.has(url), `Неожиданный URL в результатах: ${url}`);

  const merged = mergeCandidates(
    ["https://edge.example/live/main.m3u8?token=1"],
    ["https://edge.example/live/main.m3u8?token=1", "https://edge.example/live/backup.m3u8&amp;x=1"],
  );
  assert(merged.length === 2, "Network/HTML candidates must be deduplicated");
  assert(merged[1].includes("&x=1"), "HTML entities must be decoded");

  const migrated = normalizeSourceUrl("http://ip.tivix.co/035212-telekanal-dom-kino.html?x=1");
  assert(
    migrated === "https://live.tivix.co/035212-telekanal-dom-kino.html?x=1",
    `Tivix migration mismatch: ${migrated}`,
  );
  assert(
    normalizeSourceUrl("https://mediamaniya.ru/tv/nba-tv") === "https://mediamaniya.ru/tv/nba-tv",
    "Unrelated source URL must not be changed",
  );

  console.log("Self-test passed");
}

if (process.argv.includes("--selftest")) {
  runSelfTest().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
} else if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
