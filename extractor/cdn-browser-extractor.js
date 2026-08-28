#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CHANNELS_PATH = path.resolve(__dirname, "..", "config", "channels.json");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function normalizePageUrl(raw) {
  try {
    const url = new URL(raw);
    let host = url.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    let pathname = url.pathname || "/";
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    return `${host}${pathname}`;
  } catch {
    return String(raw || "").trim().toLowerCase();
  }
}

async function readChannels() {
  const raw = await fs.readFile(CHANNELS_PATH, "utf8");
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === "object" ? parsed : {};
}

export async function resolveChannel(pageUrl, channels = null) {
  const data = channels || (await readChannels());
  const target = normalizePageUrl(pageUrl);
  for (const [slug, entry] of Object.entries(data)) {
    if (!entry || typeof entry !== "object" || !entry.url) continue;
    if (normalizePageUrl(entry.url) === target) {
      return { slug, entry };
    }
  }
  return null;
}

function absoluteUrl(candidate, baseUrl) {
  if (!candidate) return null;
  try {
    return new URL(String(candidate).replace(/&amp;/g, "&"), baseUrl).toString();
  } catch {
    return null;
  }
}

export function collectFromText(text, baseUrl, out = new Set()) {
  if (!text) return out;
  const direct = text.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>}]*/gi) || [];
  for (const value of direct) {
    const normalized = absoluteUrl(value, baseUrl);
    if (normalized) out.add(normalized);
  }
  const quoted = text.match(/["']([^"'<>]+\.m3u8[^"'<>}]*)["']/gi) || [];
  for (const raw of quoted) {
    const value = raw.slice(1, -1);
    const normalized = absoluteUrl(value, baseUrl);
    if (normalized) out.add(normalized);
  }
  return out;
}

function isNavigationTimeout(error) {
  const name = String(error?.name || "");
  const message = String(error?.message || "");
  return name.includes("Timeout") || /timeout/i.test(message);
}

function shouldInspectResponse(response) {
  const headers = response.headers();
  const type = String(headers["content-type"] || "").toLowerCase();
  if (!/(json|javascript|text|html|mpegurl)/.test(type)) return false;
  const length = Number.parseInt(headers["content-length"] || "0", 10);
  return !Number.isFinite(length) || length <= 1024 * 1024;
}

async function runBrowser(cdnUrl, refererUrl, timeoutMs) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  const streams = new Set();
  const pendingBodies = new Set();
  let context;
  try {
    context = await browser.newContext({
      userAgent: USER_AGENT,
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 720 },
      extraHTTPHeaders: {
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
      },
    });

    const page = await context.newPage();
    const remember = (raw, base = cdnUrl) => {
      if (typeof raw !== "string" || !raw.toLowerCase().includes(".m3u8")) return;
      const url = absoluteUrl(raw, base);
      if (url) streams.add(url);
    };

    page.on("request", (request) => remember(request.url()));
    page.on("response", (response) => {
      remember(response.url());
      if (!shouldInspectResponse(response)) return;
      const task = response
        .text()
        .then((body) => collectFromText(body, response.url(), streams))
        .catch(() => {})
        .finally(() => pendingBodies.delete(task));
      pendingBodies.add(task);
    });

    await context.route("**/*", (route) => {
      const request = route.request();
      const requestUrl = request.url().toLowerCase();
      if (requestUrl.includes(".m3u8")) {
        route.continue();
        return;
      }
      if (["image", "font", "stylesheet"].includes(request.resourceType())) {
        route.abort();
        return;
      }
      if (request.resourceType() === "media" && /\.(?:ts|m4s|mp4)(?:[?#]|$)/i.test(requestUrl)) {
        route.abort();
        return;
      }
      route.continue();
    });

    try {
      await page.goto(cdnUrl, {
        referer: refererUrl,
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
    } catch (error) {
      if (!isNavigationTimeout(error) || page.url() === "about:blank") throw error;
      // Protected/slow players may never reach DOMContentLoaded. Keep the partial
      // document and network events gathered so far instead of discarding them.
    }

    await page.waitForTimeout(Math.min(5000, Math.max(2000, Math.floor(timeoutMs / 3))));

    collectFromText(await page.content(), page.url(), streams);
    for (const frame of page.frames()) {
      try {
        collectFromText(await frame.content(), frame.url() || page.url(), streams);
      } catch {
        // Cross-origin/detached frames can disappear while the player initializes.
      }
    }

    if (pendingBodies.size) {
      await Promise.race([
        Promise.allSettled(Array.from(pendingBodies)),
        page.waitForTimeout(1500),
      ]);
    }

    await page.close();
    return Array.from(streams);
  } finally {
    if (context) {
      try { await context.close(); } catch {}
    }
    try { await browser.close(); } catch {}
  }
}

async function main() {
  const pageUrl = process.argv[2];
  const timeoutArg = Number.parseInt(process.argv[3] || "12", 10);
  if (!pageUrl) {
    console.error("Usage: node cdn-browser-extractor.js <channel-page-url> [timeoutSeconds]");
    process.exit(1);
  }

  const found = await resolveChannel(pageUrl);
  if (!found) {
    console.error(`Channel not found in ${CHANNELS_PATH}`);
    process.exit(2);
  }

  const cdnUrl = found.entry.cdn || found.entry.url;
  const timeoutSec = Number.isFinite(timeoutArg) && timeoutArg > 0 ? timeoutArg : 12;
  try {
    const streams = await runBrowser(cdnUrl, found.entry.url, timeoutSec * 1000);
    process.stdout.write(`${JSON.stringify(streams)}\n`);
    if (!streams.length) process.exitCode = 2;
  } catch (error) {
    console.error(error?.message || String(error));
    process.exit(2);
  }
}

async function selfTest() {
  const channels = {
    demo: {
      url: "https://example.test/tv/demo.html?utm=1",
      cdn: "https://cdn.example.test/player.php",
    },
  };
  const found = await resolveChannel("https://www.example.test/tv/demo.html#x", channels);
  if (!found || found.slug !== "demo") {
    throw new Error("Channel URL matching failed");
  }

  const streams = collectFromText(
    '<script>const hls="https://edge.example/live/index.m3u8?token=abc"</script>',
    "https://cdn.example.test/player.php",
  );
  if (!streams.has("https://edge.example/live/index.m3u8?token=abc")) {
    throw new Error("HLS extraction from response text failed");
  }
  console.log("Self-test passed");
}

if (process.argv.includes("--selftest")) {
  selfTest().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
} else {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
}
