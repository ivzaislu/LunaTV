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
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function resolveChromiumExecutable() {
  const direct = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (direct && fs.existsSync(direct)) return direct;
  if (!CHROMIUM_SUFFIX) return null;

  const roots = uniqueStrings([
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(process.cwd(), "node_modules", ".cache", "ms-playwright"),
    path.join(os.homedir(), ".cache", "ms-playwright"),
    process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local", "ms-playwright")
      : null,
  ]);

  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("chromium-")) continue;
      const candidate = path.join(root, entry.name, CHROMIUM_SUFFIX);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function absoluteUrl(candidate, baseUrl) {
  if (!candidate) return null;
  const trimmed = String(candidate).replace(/&amp;/g, "&").trim();
  if (!trimmed) return null;
  try { return new URL(trimmed, baseUrl).toString(); } catch { return null; }
}

function collectFromRegex(text, baseUrl, urls) {
  if (!text) return;
  const direct = /https?:\/\/[^'"\s<>]+\.m3u8[^'"\s<>}]*/gi;
  for (const match of text.matchAll(direct)) {
    const value = absoluteUrl(match[0], baseUrl);
    if (value) urls.add(value);
  }

  const quoted = /"([^"]*\.m3u8[^"]*)"|'([^']*\.m3u8[^']*)'/gi;
  for (const match of text.matchAll(quoted)) {
    const value = absoluteUrl(match[1] || match[2], baseUrl);
    if (value) urls.add(value);
  }
}

function collectFromCheerio($, baseUrl, urls) {
  for (const [selector, attr] of [
    ["source", "src"], ["video", "src"], ["audio", "src"], ["a", "href"],
    ["script", "src"], ["link", "href"], ["meta", "content"],
  ]) {
    $(selector).each((_, el) => {
      const raw = $(el).attr(attr);
      if (typeof raw !== "string" || !raw.toLowerCase().includes(".m3u8")) return;
      const value = absoluteUrl(raw, baseUrl);
      if (value) urls.add(value);
    });
  }

  $("*[data-src], *[data-href], *[data-url], *[data-file]").each((_, el) => {
    for (const attr of ["data-src", "data-href", "data-url", "data-file"]) {
      const raw = $(el).attr(attr);
      if (typeof raw !== "string" || !raw.toLowerCase().includes(".m3u8")) continue;
      const value = absoluteUrl(raw, baseUrl);
      if (value) urls.add(value);
    }
  });
}

export function extractM3U8Candidates(html, baseUrl) {
  const urls = new Set();
  if (!html) return [];
  let safeBase = "about:blank";
  try { safeBase = new URL(baseUrl || safeBase).toString(); } catch {}

  collectFromRegex(html, safeBase, urls);
  try { collectFromCheerio(cheerio.load(html), safeBase, urls); } catch {}
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

function isTimeoutError(error) {
  return /timeout/i.test(String(error?.name || "")) || /timeout/i.test(String(error?.message || ""));
}

function responseLooksInspectable(response) {
  const headers = response.headers();
  const type = String(headers["content-type"] || "").toLowerCase();
  if (!/(text|html|json|javascript|mpegurl)/.test(type)) return false;
  const length = Number.parseInt(headers["content-length"] || "0", 10);
  return !Number.isFinite(length) || length <= 1024 * 1024;
}

async function fetchHtmlWithHttp(url, timeoutMs) {
  const response = await axios.get(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
    },
    timeout: timeoutMs,
    maxRedirects: 5,
    responseType: "text",
    transformResponse: (value) => value,
  });
  return {
    html: typeof response.data === "string" ? response.data : "",
    networkCandidates: [],
    finalUrl: response.request?.res?.responseUrl || url,
  };
}

async function fetchHtmlWithPlaywright(url, timeoutMs) {
  const executablePath = resolveChromiumExecutable();
  const launchOptions = {
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
  };
  if (executablePath) launchOptions.executablePath = executablePath;

  const browser = await chromium.launch(launchOptions);
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
    const pendingBodies = new Set();
    const rememberUrl = (candidate, base = url) => {
      if (typeof candidate !== "string" || !candidate.toLowerCase().includes(".m3u8")) return;
      const normalized = absoluteUrl(candidate, base);
      if (normalized) networkCandidates.add(normalized);
    };

    page.on("request", (request) => rememberUrl(request.url()));
    page.on("response", (response) => {
      rememberUrl(response.url());
      if (!responseLooksInspectable(response)) return;
      const task = response
        .text()
        .then((body) => collectFromRegex(body, response.url(), networkCandidates))
        .catch(() => {})
        .finally(() => pendingBodies.delete(task));
      pendingBodies.add(task);
    });

    await context.route("**/*", (route) => {
      const request = route.request();
      const type = request.resourceType();
      const requestUrl = request.url().toLowerCase();

      if (requestUrl.includes(".m3u8")) return route.continue();
      if (["image", "font", "stylesheet"].includes(type)) return route.abort();
      if (type === "media" && /\.(?:ts|m4s|mp4)(?:[?#]|$)/i.test(requestUrl)) return route.abort();
      return route.continue();
    });

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    } catch (error) {
      if (!isTimeoutError(error) || page.url() === "about:blank") throw error;
      console.warn("[extractor] navigation timeout; using partial page/network data");
    }

    await page.waitForTimeout(Math.min(5000, Math.max(1800, Math.floor(timeoutMs / 3))));

    let html = "";
    try { html = await page.content(); } catch {}
    const finalUrl = page.url() || url;
    collectFromRegex(html, finalUrl, networkCandidates);

    for (const frame of page.frames()) {
      try {
        const frameUrl = frame.url() || finalUrl;
        const frameHtml = await frame.content();
        collectFromRegex(frameHtml, frameUrl, networkCandidates);
      } catch {}
    }

    if (pendingBodies.size) {
      await Promise.race([
        Promise.allSettled(Array.from(pendingBodies)),
        page.waitForTimeout(1500),
      ]);
    }

    await page.close();
    return { html, networkCandidates: Array.from(networkCandidates), finalUrl };
  } finally {
    if (context) { try { await context.close(); } catch {} }
    try { await browser.close(); } catch {}
  }
}

async function fetchHtml(url, timeoutMs, { httpOnly = false } = {}) {
  const attempts = httpOnly ? [fetchHtmlWithHttp] : [fetchHtmlWithPlaywright, fetchHtmlWithHttp];
  let lastError;
  for (const attempt of attempts) {
    try {
      return await attempt(url, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt === fetchHtmlWithPlaywright) {
        console.warn(`[extractor] Playwright failed (${error?.message || error}); trying HTTP fallback`);
      }
    }
  }
  throw lastError || new Error("Не удалось загрузить страницу");
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
    console.error("Usage: node universal-playwright-extractor.js <url> [timeoutSeconds]");
    console.error("       node universal-playwright-extractor.js --http-only <url> [timeoutSeconds]");
    process.exit(1);
  }

  const parsed = Number.parseInt(timeoutArg, 10);
  const timeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : 10000;
  const httpOnly = flags.has("--http-only") || process.env.EXTRACTOR_HTTP_ONLY === "1";

  try {
    const loaded = await fetchHtml(pageUrl, timeoutMs, { httpOnly });
    const baseUrl = loaded.finalUrl || pageUrl;
    const candidates = mergeCandidates(
      loaded.networkCandidates,
      extractM3U8Candidates(loaded.html, baseUrl),
    );
    if (!candidates.length) console.error("[extractor] Потоки не найдены");
    process.stdout.write(`${JSON.stringify(candidates)}\n`);
  } catch (error) {
    console.error(`[extractor] Ошибка: ${error?.message || error}`);
    process.exitCode = 1;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runSelfTest() {
  const sampleHtml = `
    <html><body>
      <video src="/streams/main.m3u8"></video>
      <script>const backup = "https://cdn.example.com/backup/index.m3u8?token=abc";</script>
      <div data-src="//media.example.org/live/playlist.m3u8"></div>
      <a href="https://example.com/not-stream.mp4">mp4</a>
    </body></html>
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
  assert(merged.length === 2, "Сетевые и HTML кандидаты должны объединяться без дублей");
  assert(merged[1].includes("&x=1"), "HTML entity в m3u8 URL должна декодироваться");

  console.log("Self-test passed");
}

if (process.argv.includes("--selftest")) {
  runSelfTest().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
} else if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
}
