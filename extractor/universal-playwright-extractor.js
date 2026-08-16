#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import axios from "axios";
import * as cheerio from "cheerio";
import { chromium } from "playwright-core";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CHROMIUM_SUFFIX = {
  linux: "chrome-linux/chrome",
  darwin: "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  win32: "chrome-win/chrome.exe",
}[process.platform] || null;

function uniqueStrings(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const value = typeof item === "string" ? item : String(item || "");
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function resolveChromiumExecutable() {
  const direct = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (direct && fs.existsSync(direct)) {
    return direct;
  }
  if (!CHROMIUM_SUFFIX) {
    return null;
  }

  const searchRoots = uniqueStrings([
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(process.cwd(), "node_modules", ".cache", "ms-playwright"),
    path.join(os.homedir(), ".cache", "ms-playwright"),
    process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local", "ms-playwright")
      : null,
  ]);

  for (const root of searchRoots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("chromium-")) {
        continue;
      }
      const candidate = path.join(root, entry.name, CHROMIUM_SUFFIX);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

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

function mergeCandidates(...groups) {
  const out = [];
  const seen = new Set();
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
    return {
      html: typeof response.data === "string" ? response.data : "",
      networkCandidates: [],
      finalUrl: response.request?.res?.responseUrl || url,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtmlWithPlaywright(url, timeoutMs) {
  const executablePath = resolveChromiumExecutable();
  const launchOptions = {
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
  };
  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }
  const browser = await chromium.launch(launchOptions);
  let context;
  try {
    context = await browser.newContext({
      userAgent: USER_AGENT,
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 720 },
    });

    const networkCandidates = new Set();
    const rememberUrl = (candidate) => {
      if (typeof candidate !== "string" || !candidate.toLowerCase().includes(".m3u8")) return;
      const normalized = absoluteUrl(candidate.replace(/&amp;/g, "&"), url);
      if (normalized) networkCandidates.add(normalized);
    };

    const page = await context.newPage();
    page.on("request", (request) => rememberUrl(request.url()));
    page.on("response", (response) => rememberUrl(response.url()));

    await context.route("**/*", (route) => {
      const request = route.request();
      const type = request.resourceType();
      const requestUrl = request.url().toLowerCase();

      if (requestUrl.includes(".m3u8")) {
        route.continue();
        return;
      }
      if (["image", "font", "stylesheet", "media"].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(Math.min(2000, Math.max(750, Math.floor(timeoutMs / 5))));
    const html = await page.content();
    const finalUrl = page.url();
    await page.close();
    return { html, networkCandidates: Array.from(networkCandidates), finalUrl };
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
      if (attempt === fetchHtmlWithPlaywright) {
        const message = err?.message || String(err);
        console.warn(
          `[extractor] Playwright не удалось запустить (${message}). Попробуем HTTP-режим. ` +
            "Убедитесь, что выполнена команда 'npx playwright@1.55.0 install chromium'.",
        );
      }
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
    console.error("Usage: node universal-playwright-extractor.js <url> [timeoutSeconds]");
    console.error("       node universal-playwright-extractor.js --http-only <url> [timeoutSeconds]");
    process.exit(1);
  }

  const timeoutSec = Number.parseInt(timeoutArg, 10);
  const timeoutMs = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 10000;
  const httpOnly = flags.has("--http-only") || process.env.EXTRACTOR_HTTP_ONLY === "1";

  try {
    const loaded = await fetchHtml(pageUrl, timeoutMs, { httpOnly });
    const baseUrl = loaded.finalUrl || pageUrl;
    const candidates = mergeCandidates(
      loaded.networkCandidates,
      extractM3U8Candidates(loaded.html, baseUrl),
    );
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

  const merged = mergeCandidates(
    ["https://edge.example/live/main.m3u8?token=1"],
    ["https://edge.example/live/main.m3u8?token=1", "https://edge.example/live/backup.m3u8&amp;x=1"],
  );
  assert(merged.length === 2, "Сетевые и HTML кандидаты должны объединяться без дублей");
  assert(merged[1].includes("&x=1"), "HTML entity в m3u8 URL должна декодироваться");

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
