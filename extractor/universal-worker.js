#!/usr/bin/env node
import http from "node:http";
import { chromium } from "playwright-core";

const HOST = process.env.EXTRACTOR_WORKER_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.EXTRACTOR_WORKER_PORT || "6071", 10);
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MAX_BUDGET_MS = 4200;

let browser = null;
let stopping = false;

function normalizeSourceUrl(rawUrl) {
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

function absoluteUrl(raw, baseUrl) {
  try {
    return new URL(String(raw || "").replace(/&amp;/g, "&"), baseUrl).toString();
  } catch {
    return null;
  }
}

function remaining(deadline) {
  return Math.max(0, deadline - Date.now());
}

async function extractOne(rawUrl, timeoutMs) {
  const started = Date.now();
  const budget = Math.max(500, Math.min(MAX_BUDGET_MS, Number(timeoutMs) || MAX_BUDGET_MS));
  const deadline = started + budget;
  const pageUrl = normalizeSourceUrl(rawUrl);
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 },
    extraHTTPHeaders: { "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8" },
  });

  try {
    const page = await context.newPage();
    let firstLive = null;
    let resolveLive;
    const livePromise = new Promise((resolve) => { resolveLive = resolve; });

    const acceptResponse = (response) => {
      const url = response.url();
      if (firstLive || !url.toLowerCase().includes(".m3u8")) return;
      const status = response.status();
      if (status < 200 || status >= 400) return;
      firstLive = absoluteUrl(url, page.url() || pageUrl) || url;
      resolveLive(firstLive);
    };
    page.on("response", acceptResponse);

    await context.route("**/*", (route) => {
      const request = route.request();
      const url = request.url().toLowerCase();
      const type = request.resourceType();
      if (url.includes(".m3u8")) return route.continue();
      if (["image", "font", "stylesheet"].includes(type)) return route.abort();
      if (type === "media" && /\.(?:ts|m4s|mp4)(?:[?#]|$)/i.test(url)) return route.abort();
      return route.continue();
    });

    const navMs = Math.min(1200, remaining(deadline));
    if (navMs > 100) {
      try {
        await Promise.race([
          page.goto(pageUrl, { waitUntil: "commit", timeout: navMs }),
          livePromise,
        ]);
      } catch {}
    }

    if (!firstLive && remaining(deadline) > 0) {
      await Promise.race([
        livePromise,
        new Promise((resolve) => setTimeout(resolve, remaining(deadline))),
      ]);
    }

    return {
      streams: firstLive ? [firstLive] : [],
      elapsed_ms: Date.now() - started,
      page_host: (() => { try { return new URL(pageUrl).hostname; } catch { return ""; } })(),
    };
  } finally {
    try { await context.close(); } catch {}
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("request too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function main() {
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
    ],
  });

  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (req.method === "GET" && req.url === "/health") {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/extract") {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    try {
      const body = await readJson(req);
      const url = String(body.url || "").trim();
      if (!/^https?:\/\//i.test(url)) throw new Error("invalid url");
      const result = await extractOne(url, body.timeout_ms);
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: error?.message || String(error) }));
    }
  });

  await new Promise((resolve) => server.listen(PORT, HOST, resolve));
  console.log(`[extractor-worker] ready http://${HOST}:${PORT}`);

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try { server.close(); } catch {}
    try { await browser.close(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(`[extractor-worker] fatal: ${error?.stack || error}`);
  process.exit(1);
});
