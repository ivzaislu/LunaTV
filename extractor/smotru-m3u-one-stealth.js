#!/usr/bin/env node
import axios from "axios";
import * as cheerio from "cheerio";
import { chromium } from "playwright-core";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function absoluteUrl(candidate, baseUrl) {
  if (!candidate) return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch (err) {
    return null;
  }
}

function collectFromCheerio($, baseUrl, urls) {
  const addAttr = (selector, attr) => {
    $(selector).each((_, el) => {
      const value = $(el).attr(attr);
      if (typeof value === "string" && value.toLowerCase().includes(".m3u8")) {
        const url = absoluteUrl(value, baseUrl);
        if (url) {
          urls.add(url);
        }
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

  $("*[data-src], *[data-href]").each((_, el) => {
    for (const attr of ["data-src", "data-href", "data-url", "data-file"]) {
      const value = $(el).attr(attr);
      if (typeof value === "string" && value.toLowerCase().includes(".m3u8")) {
        const url = absoluteUrl(value, baseUrl);
        if (url) {
          urls.add(url);
        }
      }
    }
  });
}

function collectFromRegex(html, baseUrl, urls) {
  if (!html) return;
  const regex = /https?:[^'"\s<>]+\.m3u8[^'"\s<>]*/gi;
  for (const match of html.matchAll(regex)) {
    const normalized = absoluteUrl(match[0], baseUrl);
    if (normalized) {
      urls.add(normalized);
    }
  }

  const quoted = /"([^"]*\.m3u8[^"]*)"|'([^']*\.m3u8[^']*)'/gi;
  for (const match of html.matchAll(quoted)) {
    const candidate = match[1] || match[2];
    const normalized = absoluteUrl(candidate, baseUrl);
    if (normalized) {
      urls.add(normalized);
    }
  }
}

export function extractM3U8Candidates(html, baseUrl) {
  const urls = new Set();
  if (!html) {
    return [];
  }

  const safeBase = (() => {
    try {
      return new URL(baseUrl || "about:blank").toString();
    } catch (err) {
      return "about:blank";
    }
  })();

  collectFromRegex(html, safeBase, urls);

  try {
    const $ = cheerio.load(html);
    collectFromCheerio($, safeBase, urls);
  } catch (err) {
    // если cheerio не смог распарсить документ, просто игнорируем
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
        "Accept-Language": "ru,en;q=0.9",
      },
      timeout: timeoutMs,
      signal: controller.signal,
      maxRedirects: 5,
      responseType: "text",
    });
    return typeof response.data === "string" ? response.data : "";
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtmlWithPlaywright(url, timeoutMs) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  let context;
  try {
    context = await browser.newContext({
      userAgent: USER_AGENT,
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 720 },
    });

    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "font", "media", "stylesheet"].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(750);
    const html = await page.content();
    await page.close();
    return html;
  } finally {
    if (context) {
      try {
        await context.close();
      } catch (err) {
        // ignore context closing errors
      }
    }
    try {
      await browser.close();
    } catch (err) {
      // ignore browser closing errors
    }
  }
}

async function fetchHtml(url, timeoutMs, { httpOnly = false } = {}) {
  const attempts = [];
  if (!httpOnly) {
    attempts.push(fetchHtmlWithPlaywright);
  }
  attempts.push(fetchHtmlWithHttp);

  let lastError;
  for (const attempt of attempts) {
    try {
      return await attempt(url, timeoutMs);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("Не удалось загрузить страницу");
}

function parseCliArgs(argv) {
  const flags = new Set();
  const positional = [];
  for (const arg of argv) {
    if (typeof arg === "string" && arg.startsWith("--")) {
      flags.add(arg);
    } else {
      positional.push(arg);
    }
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

  try {
    const html = await fetchHtml(pageUrl, timeoutMs, { httpOnly });
    const candidates = extractM3U8Candidates(html, pageUrl);
    if (!candidates.length) {
      console.error("[extractor] Потоки не найдены");
    }
    process.stdout.write(`${JSON.stringify(candidates)}\n`);
  } catch (err) {
    const message = err?.message || String(err);
    console.error(`[extractor] Ошибка: ${message}`);
    process.exitCode = 1;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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
  for (const url of result) {
    assert(expected.has(url), `Неожиданный URL в результатах: ${url}`);
  }
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
