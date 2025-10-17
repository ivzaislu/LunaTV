#!/usr/bin/env node
import axios from "axios";
import * as cheerio from "cheerio";
import JSON5 from "json5";
import { chromium } from "playwright-core";
import { pathToFileURL } from "node:url";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function absoluteUrl(candidate, baseUrl) {
  if (!candidate) return null;
  const trimmed = String(candidate).trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch (err) {
    return null;
  }
}

function normalizeBaseUrl(baseUrl) {
  try {
    return new URL(baseUrl || "about:blank").toString();
  } catch (err) {
    return "about:blank";
  }
}

function collectFromJsonConfig(data, baseUrl, urls) {
  if (!data) {
    return;
  }
  if (typeof data === "string") {
    if (data.toLowerCase().includes(".m3u8")) {
      const url = absoluteUrl(data, baseUrl);
      if (url) {
        urls.add(url);
      }
    }
    return;
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      collectFromJsonConfig(item, baseUrl, urls);
    }
    return;
  }
  if (typeof data === "object") {
    for (const value of Object.values(data)) {
      collectFromJsonConfig(value, baseUrl, urls);
    }
  }
}

function collectFromDom($, baseUrl, urls) {
  const attrSelectors = [
    ["source", "src"],
    ["video", "src"],
    ["audio", "src"],
    ["a", "href"],
    ["link", "href"],
    ["meta", "content"],
    ["div", "data-src"],
    ["div", "data-url"],
  ];
  for (const [selector, attr] of attrSelectors) {
    $(selector).each((_, el) => {
      const value = $(el).attr(attr);
      if (typeof value === "string" && value.toLowerCase().includes(".m3u8")) {
        const url = absoluteUrl(value, baseUrl);
        if (url) {
          urls.add(url);
        }
      }
    });
  }

  $("[data-player-config]").each((_, el) => {
    const raw = $(el).attr("data-player-config");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      collectFromJsonConfig(parsed, baseUrl, urls);
    } catch (err) {
      // пропускаем некорректный JSON
    }
  });

  $("script[type='application/json'][data-role='player-config']").each((_, el) => {
    try {
      const parsed = JSON.parse($(el).html() || "{}");
      collectFromJsonConfig(parsed, baseUrl, urls);
    } catch (err) {
      // игнорируем ошибку парсинга
    }
  });
}

function collectFromScripts(html, baseUrl, urls) {
  const configRegex = /(?:__PLAYER_CONFIG__|playerConfig)\s*=\s*(\{[\s\S]*?\})\s*;/g;
  let match;
  while ((match = configRegex.exec(html)) !== null) {
    const jsonText = match[1];
    try {
      const parsed = JSON5.parse(jsonText);
      collectFromJsonConfig(parsed, baseUrl, urls);
    } catch (err) {
      // пропускаем, если не удалось распарсить
    }
  }

  const regex = /https?:[^'"\s<>]+\.m3u8[^'"\s<>]*/gi;
  for (const urlMatch of html.matchAll(regex)) {
    const url = absoluteUrl(urlMatch[0], baseUrl);
    if (url) {
      urls.add(url);
    }
  }
}

export function extractCinemaCandidates(html, baseUrl) {
  if (!html) return [];
  const safeBase = normalizeBaseUrl(baseUrl);
  const urls = new Set();

  collectFromScripts(html, safeBase, urls);
  try {
    const $ = cheerio.load(html);
    collectFromDom($, safeBase, urls);
  } catch (err) {
    // пропускаем ошибки парсинга DOM
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
        // ignore
      }
    }
    try {
      await browser.close();
    } catch (err) {
      // ignore
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

export async function runSelfTest() {
  const path = new URL("./fixtures/cinema-hls-player.html", import.meta.url);
  const fs = await import("node:fs/promises");
  const html = await fs.readFile(path, "utf8");
  const expected = [
    "https://backup.cinema.example/live/cinema_hd_backup.m3u8",
    "https://cdn-alt.cinema.example/hls/cinema_hd/playlist.m3u8?token=secure",
    "https://edge.cinema.example/live/cinema_hd/master.m3u8",
    "https://edge.cinema.example/live/cinema_hd/720p.m3u8",
    "https://edge.cinema.example/live/cinema_hd/index.m3u8",
    "https://edge.cinema.example/live/cinema_sd.m3u8",
    "https://mirror-1.cinema.example/live/cinema_hd/index.m3u8",
    "https://mirror-2.cinema.example/live/cinema_hd/index.m3u8",
  ].sort();
  const result = extractCinemaCandidates(html, "https://cinema.example/watch").sort();
  if (JSON.stringify(result) !== JSON.stringify(expected)) {
    console.error("[selftest] Ожидались другие URL:");
    console.error("  expected:", expected);
    console.error("  received:", result);
    process.exit(1);
  }
  console.log(`[selftest] найдено ${result.length} потоков`);
}

async function run() {
  const { flags, positional } = parseCliArgs(process.argv.slice(2));
  if (flags.has("--selftest")) {
    await runSelfTest();
    return;
  }

  const [pageUrl, timeoutArg] = positional;
  if (!pageUrl) {
    console.error("usage: node cinema-hls-extractor.js <pageUrl> [timeoutMs]");
    process.exit(2);
  }
  const timeoutMs = Number.parseInt(timeoutArg ?? "15000", 10);
  const httpOnly = flags.has("--http-only") || process.env.EXTRACTOR_HTTP_ONLY === "1";

  const html = await fetchHtml(pageUrl, timeoutMs, { httpOnly });
  const urls = extractCinemaCandidates(html, pageUrl);
  process.stdout.write(JSON.stringify(urls));
}

const invokedFromCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedFromCli) {
  run().catch((err) => {
    console.error("[cinema-hls-extractor] Ошибка:", err?.stack || err);
    process.exit(1);
  });
}
