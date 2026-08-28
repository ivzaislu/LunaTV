#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import axios from "axios";
import * as cheerio from "cheerio";
import { acquireChromium, releaseChromium } from "./browser-runtime.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MAX_BUDGET_MS = 3300;
const HTTP_FAST_PATH_MS = 450;
const HLS_PROBE_MS = 450;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHANNELS_PATH = path.join(HERE, "..", "config", "channels.json");

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
    process.platform === "win32" ? path.join(os.homedir(), "AppData", "Local", "ms-playwright") : null,
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

function remainingMs(deadline) {
  return Math.max(0, deadline - Date.now());
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function resolveConfiguredTarget(rawUrl) {
  const pageUrl = normalizeSourceUrl(rawUrl);
  let cdnUrl = "";
  let channels = {};
  try { channels = JSON.parse(fs.readFileSync(CHANNELS_PATH, "utf8")); } catch {}
  for (const entry of Object.values(channels || {})) {
    if (!entry || typeof entry !== "object") continue;
    const entryUrl = String(entry.url || "").trim();
    if (!entryUrl) continue;
    if (entryUrl === rawUrl || normalizeSourceUrl(entryUrl) === pageUrl) {
      cdnUrl = String(entry.cdn || "").trim();
      break;
    }
  }
  return { pageUrl, cdnUrl, referer: pageUrl };
}

async function probeHls(url, referer, deadline) {
  const timeoutMs = Math.min(HLS_PROBE_MS, remainingMs(deadline));
  if (timeoutMs < 100) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/vnd.apple.mpegurl,application/x-mpegURL,*/*",
        ...(referer ? { Referer: referer } : {}),
      },
    });
    if (!response.ok) return false;
    const type = String(response.headers.get("content-type") || "").toLowerCase();
    if (type.includes("mpegurl")) return true;
    const reader = response.body?.getReader();
    if (!reader) return false;
    const { value } = await reader.read();
    try { await reader.cancel(); } catch {}
    const text = new TextDecoder().decode(value || new Uint8Array()).replace(/^\uFEFF/, "").trimStart();
    return text.startsWith("#EXTM3U");
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function firstLiveCandidate(candidates, referer, deadline, alreadyProbed = new Set()) {
  for (const raw of candidates || []) {
    const url = String(raw || "").trim();
    if (!url || alreadyProbed.has(url)) continue;
    alreadyProbed.add(url);
    if (await probeHls(url, referer, deadline)) return url;
    if (remainingMs(deadline) < 120) break;
  }
  return null;
}

async function extractWithHttp(targetUrl, referer, deadline) {
  if (!targetUrl) return [];
  const timeout = Math.min(HTTP_FAST_PATH_MS, remainingMs(deadline));
  if (timeout < 100) return [];
  try {
    const response = await axios.get(targetUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
        ...(referer ? { Referer: referer } : {}),
      },
      timeout,
      maxRedirects: 4,
      responseType: "text",
      transformResponse: (value) => value,
    });
    const finalUrl = response.request?.res?.responseUrl || targetUrl;
    return extractM3U8Candidates(typeof response.data === "string" ? response.data : "", finalUrl);
  } catch {
    return [];
  }
}

async function extractWithPlaywright(pageUrl, referer, deadline) {
  const executablePath = resolveChromiumExecutable();
  const launchOptions = {
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
  };
  if (executablePath) launchOptions.executablePath = executablePath;

  const stageStarted = Date.now();
  const { browser, shared } = await acquireChromium(launchOptions);
  const connectedAt = Date.now();
  let context;
  try {
    context = await browser.newContext({
      userAgent: USER_AGENT,
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 720 },
      extraHTTPHeaders: { "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8" },
    });
    const page = await context.newPage();
    const candidates = [];
    const seen = new Set();
    const probed = new Set();
    let liveResponse = null;
    let resolveLiveResponse;
    const liveResponsePromise = new Promise((resolve) => { resolveLiveResponse = resolve; });
    let wakeResolve = null;
    let wakePromise = new Promise((resolve) => { wakeResolve = resolve; });
    const wake = () => {
      wakeResolve?.();
      wakePromise = new Promise((resolve) => { wakeResolve = resolve; });
    };
    const remember = (candidate) => {
      if (typeof candidate !== "string" || !candidate.toLowerCase().includes(".m3u8")) return;
      const base = page.url() && page.url() !== "about:blank" ? page.url() : pageUrl;
      const normalized = absoluteUrl(candidate, base);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      candidates.push(normalized);
      wake();
    };

    page.on("request", (request) => remember(request.url()));
    page.on("response", (response) => {
      const url = response.url();
      remember(url);
      if (
        !liveResponse &&
        url.toLowerCase().includes(".m3u8") &&
        response.status() >= 200 && response.status() < 400
      ) {
        liveResponse = absoluteUrl(url, page.url() || pageUrl) || url;
        resolveLiveResponse?.(liveResponse);
      }
    });

    await context.route("**/*", (route) => {
      const request = route.request();
      const requestUrl = request.url().toLowerCase();
      const type = request.resourceType();
      if (requestUrl.includes(".m3u8")) return route.continue();
      if (["image", "font", "stylesheet"].includes(type)) return route.abort();
      if (type === "media" && /\.(?:ts|m4s|mp4)(?:[?#]|$)/i.test(requestUrl)) return route.abort();
      return route.continue();
    });

    const navTimeout = Math.min(850, remainingMs(deadline));
    if (navTimeout > 100) {
      try {
        await Promise.race([
          page.goto(pageUrl, { waitUntil: "commit", timeout: navTimeout }),
          liveResponsePromise,
        ]);
      } catch {}
    }
    if (liveResponse) {
      console.error(`[extractor] shared=${shared} connect_ms=${connectedAt - stageStarted} first_live_ms=${Date.now() - stageStarted}`);
      return [liveResponse];
    }

    try {
      for (const candidate of extractM3U8Candidates(await page.content(), page.url() || pageUrl)) remember(candidate);
    } catch {}

    while (remainingMs(deadline) > 120) {
      if (liveResponse) {
        console.error(`[extractor] shared=${shared} connect_ms=${connectedAt - stageStarted} first_live_ms=${Date.now() - stageStarted}`);
        return [liveResponse];
      }
      const live = await firstLiveCandidate(candidates, referer, deadline, probed);
      if (live) {
        console.error(`[extractor] shared=${shared} connect_ms=${connectedAt - stageStarted} probed_live_ms=${Date.now() - stageStarted}`);
        return [live];
      }
      const waitMs = Math.min(120, remainingMs(deadline));
      if (waitMs <= 0) break;
      await Promise.race([liveResponsePromise, wakePromise, delay(waitMs)]);
    }

    console.warn(`[extractor] shared=${shared} connect_ms=${connectedAt - stageStarted} rejected_candidates=${probed.size}`);
    return [];
  } finally {
    if (context) { try { await context.close(); } catch {} }
    await releaseChromium(browser, shared);
  }
}

async function extractFast(rawUrl, requestedTimeoutMs, { httpOnly = false } = {}) {
  const budgetMs = Math.max(500, Math.min(MAX_BUDGET_MS, requestedTimeoutMs || MAX_BUDGET_MS));
  const deadline = Date.now() + budgetMs;
  const { pageUrl, cdnUrl, referer } = resolveConfiguredTarget(rawUrl);

  if (cdnUrl) {
    console.error(`[extractor] http_cdn=${new URL(cdnUrl).hostname}`);
    const cdnCandidates = await extractWithHttp(cdnUrl, referer, deadline);
    const cdnLive = await firstLiveCandidate(cdnCandidates, referer, deadline);
    if (cdnLive) return [cdnLive];
  }

  const pageCandidates = await extractWithHttp(pageUrl, referer, deadline);
  const pageLive = await firstLiveCandidate(pageCandidates, referer, deadline);
  if (pageLive) return [pageLive];
  if (httpOnly || remainingMs(deadline) < 250) return [];

  try {
    return await extractWithPlaywright(pageUrl, referer, deadline);
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
  if (!candidates.length) console.error("[extractor] Быстрый живой HLS не найден");
  console.error(`[extractor] elapsed_ms=${Date.now() - started}`);
  process.stdout.write(`${JSON.stringify(candidates)}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runSelfTest() {
  const sampleHtml = `<video src="/streams/main.m3u8"></video><script>const b="https://cdn.example/live/index.m3u8?x=1";</script>`;
  const result = extractM3U8Candidates(sampleHtml, "https://tv.example/watch");
  assert(result.includes("https://tv.example/streams/main.m3u8"), "relative m3u8 extraction failed");
  assert(result.includes("https://cdn.example/live/index.m3u8?x=1"), "absolute m3u8 extraction failed");
  const migrated = normalizeSourceUrl("http://ip.tivix.co/035212-telekanal-dom-kino.html");
  assert(migrated === "https://live.tivix.co/035212-telekanal-dom-kino.html", "Tivix URL migration failed");
  assert(MAX_BUDGET_MS < 4000, "Internal budget must stay well below the 5s SLA");
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
