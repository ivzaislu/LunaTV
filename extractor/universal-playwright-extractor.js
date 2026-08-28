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
const MAX_BUDGET_MS = 5000;
const HTTP_FAST_PATH_MS = 700;

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

function remainingMs(deadline) {
  return Math.max(0, deadline - Date.now());
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function extractWithHttp(url, deadline) {
  const timeout = Math.min(HTTP_FAST_PATH_MS, remainingMs(deadline));
  if (timeout < 100) return [];
  try {
    const response = await axios.get(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
      },
      timeout,
      maxRedirects: 5,
      responseType: "text",
      transformResponse: (value) => value,
    });
    const finalUrl = response.request?.res?.responseUrl || url;
    return extractM3U8Candidates(
      typeof response.data === "string" ? response.data : "",
      finalUrl,
    );
  } catch {
    return [];
  }
}

async function extractWithPlaywright(url, deadline) {
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
    const candidates = new Set();
    let resolveFirst;
    const firstCandidate = new Promise((resolve) => { resolveFirst = resolve; });

    const remember = (candidate) => {
      if (typeof candidate !== "string" || !candidate.toLowerCase().includes(".m3u8")) return;
      const base = page.url() && page.url() !== "about:blank" ? page.url() : url;
      const normalized = absoluteUrl(candidate, base);
      if (!normalized || candidates.has(normalized)) return;
      candidates.add(normalized);
      resolveFirst?.();
    };

    page.on("request", (request) => remember(request.url()));
    page.on("response", (response) => remember(response.url()));

    await context.route("**/*", (route) => {
      const request = route.request();
      const requestUrl = request.url().toLowerCase();
      const type = request.resourceType();
      if (requestUrl.includes(".m3u8")) return route.continue();
      if (["image", "font", "stylesheet"].includes(type)) return route.abort();
      if (type === "media" && /\.(?:ts|m4s|mp4)(?:[?#]|$)/i.test(requestUrl)) return route.abort();
      return route.continue();
    });

    const navTimeout = Math.min(1600, remainingMs(deadline));
    if (navTimeout > 100) {
      try {
        await Promise.race([
          page.goto(url, { waitUntil: "commit", timeout: navTimeout }),
          firstCandidate,
        ]);
      } catch {
        // A slow navigation is acceptable as long as useful player requests arrive.
      }
    }

    if (candidates.size) return Array.from(candidates);

    try {
      const html = await page.content();
      for (const candidate of extractM3U8Candidates(html, page.url() || url)) remember(candidate);
    } catch {}
    if (candidates.size) return Array.from(candidates);

    const wait = remainingMs(deadline);
    if (wait > 50) await Promise.race([firstCandidate, delay(wait)]);
    if (candidates.size) return Array.from(candidates);

    // One final lightweight DOM read before the global deadline expires.
    try {
      const html = await page.content();
      for (const candidate of extractM3U8Candidates(html, page.url() || url)) remember(candidate);
    } catch {}
    return Array.from(candidates);
  } finally {
    if (context) { try { await context.close(); } catch {} }
    try { await browser.close(); } catch {}
  }
}

async function extractFast(rawUrl, requestedTimeoutMs, { httpOnly = false } = {}) {
  const budgetMs = Math.max(500, Math.min(MAX_BUDGET_MS, requestedTimeoutMs || MAX_BUDGET_MS));
  const deadline = Date.now() + budgetMs;
  const url = normalizeSourceUrl(rawUrl);

  const httpCandidates = await extractWithHttp(url, deadline);
  if (httpCandidates.length || httpOnly) return httpCandidates;
  if (remainingMs(deadline) < 300) return [];

  try {
    return await extractWithPlaywright(url, deadline);
  } catch (error) {
    console.warn(`[extractor] browser fast-path failed: ${error?.message || error}`);
    return [];
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
    console.error("Usage: node universal-playwright-extractor.js <url> [timeoutSeconds]");
    process.exit(1);
  }

  const parsed = Number.parseFloat(timeoutArg);
  const requestedTimeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : MAX_BUDGET_MS;
  const started = Date.now();
  const candidates = await extractFast(pageUrl, requestedTimeoutMs, {
    httpOnly: flags.has("--http-only") || process.env.EXTRACTOR_HTTP_ONLY === "1",
  });
  if (!candidates.length) console.error("[extractor] Потоки не найдены в пределах 5 секунд");
  console.error(`[extractor] elapsed_ms=${Date.now() - started}`);
  process.stdout.write(`${JSON.stringify(candidates)}\n`);
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
  for (const url of result) assert(expected.has(url), `Неожиданный URL: ${url}`);

  const migrated = normalizeSourceUrl("http://ip.tivix.co/035212-telekanal-dom-kino.html");
  assert(migrated === "https://live.tivix.co/035212-telekanal-dom-kino.html", "Tivix URL migration failed");
  assert(Math.min(MAX_BUDGET_MS, 12000) === 5000, "Global extractor budget must stay capped at 5s");
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
