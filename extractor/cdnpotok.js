#!/usr/bin/env node
import axios from "axios";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHANNELS_PATH = path.resolve(__dirname, "..", "config", "channels.json");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MAX_BUDGET_MS = 4200;
const REQUEST_CAP_MS = 1400;
const MAX_HOPS = 4;
const IFRAME_BLACKLIST = ["programma-peredach.com"];

function now() { return Date.now(); }
function remaining(deadline) { return Math.max(0, deadline - now()); }

function absolutize(value, base) {
  try { return new URL(String(value || "").replace(/&/g, "&"), base).toString(); }
  catch { return null; }
}

function normalizeForMatch(value) {
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    let pathname = u.pathname || "/";
    if (pathname.length > 1) pathname = pathname.replace(/\/$/, "");
    return `${host}${pathname}`;
  } catch { return String(value || "").toLowerCase(); }
}

function looksLikeM3U8(value) {
  return /\.m3u8(?:[?#]|$)/i.test(String(value || ""));
}

function hostOf(value) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return ""; }
}

function isBlacklistedHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^www\./, "");
  return IFRAME_BLACKLIST.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function decodeRepeated(value) {
  let current = String(value || "").replace(/&/g, "&").replace(/\\\//g, "/");
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch { break; }
  }
  return current;
}

function browserHeaders(referer, dest) {
  const headers = {
    "User-Agent": UA,
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
    "Accept": dest === "empty"
      ? "application/vnd.apple.mpegurl,application/x-mpegURL,*/*"
      : "text/html,application/xhtml+xml,application/vnd.apple.mpegurl,application/x-mpegURL,*/*;q=0.8",
    "Referer": referer || "",
    "Sec-Fetch-Dest": dest,
    "Sec-Fetch-Mode": dest === "empty" ? "cors" : "navigate",
    "Sec-Fetch-Site": "cross-site",
    "Cache-Control": "no-cache",
  };
  if (dest !== "empty") headers["Upgrade-Insecure-Requests"] = "1";
  return headers;
}

async function readChannels() {
  try { return JSON.parse(await fs.readFile(CHANNELS_PATH, "utf8")); }
  catch { return {}; }
}

async function resolveInput(input) {
  const channels = await readChannels();
  if (/^https?:\/\//i.test(input)) {
    const wanted = normalizeForMatch(input);
    for (const [key, entry] of Object.entries(channels)) {
      if (!entry || typeof entry !== "object" || !entry.url) continue;
      if (normalizeForMatch(entry.url) === wanted) {
        return { key, pageUrl: entry.url };
      }
    }
    return { key: null, pageUrl: input };
  }
  const entry = channels[input];
  if (!entry || typeof entry !== "object" || !entry.url) return null;
  return { key: input, pageUrl: entry.url };
}

function unwrapQuery(value, base) {
  let current = absolutize(value, base) || value;
  for (let i = 0; i < 3; i++) {
    try {
      const u = new URL(current, base);
      let found = null;
      for (const key of ["file", "src", "url", "m3u8", "video"]) {
        const raw = u.searchParams.get(key);
        if (!raw) continue;
        found = absolutize(decodeRepeated(raw), current);
        if (found) break;
      }
      if (!found || found === current) break;
      current = found;
    } catch { break; }
  }
  return current;
}

function extractCandidate(text, base) {
  return extractAllCandidates(text, base)[0] || null;
}

function extractAllCandidates(text, base) {
  const body = decodeRepeated(text);
  const found = [];
  const seen = new Set();
  const push = (value) => {
    const unwrapped = unwrapQuery(value, base);
    if (!unwrapped || !looksLikeM3U8(unwrapped) || seen.has(unwrapped)) return;
    seen.add(unwrapped);
    found.push(unwrapped);
  };

  const direct = /https?:\/\/[^\s"'<>]+?\.m3u8[^\s"'<>]*/gi;
  for (const match of body.matchAll(direct)) {
    for (const part of match[0].split(/\s+or\s+/i)) push(part);
  }

  const attrs = [
    /(?:file|src|url|m3u8|video)\s*[:=]\s*["']([^"']+)["']/gi,
    /["'](?:file|src|url|m3u8|video)["']\s*:\s*["']([^"']+)["']/gi,
  ];
  for (const re of attrs) {
    for (const match of body.matchAll(re)) {
      if (match[1]) push(decodeRepeated(match[1]));
    }
  }

  const rel = /["'](\/[^"'<>]+\.m3u8[^"'<>}]*)["']/gi;
  for (const match of body.matchAll(rel)) push(match[1]);

  found.sort((a, b) => rankCandidate(a) - rankCandidate(b));
  return found;
}

function rankCandidate(url) {
  try {
    const pathname = new URL(url).pathname;
    if (/\.m3u8$/i.test(pathname)) return 0;
    if (looksLikeM3U8(url)) return 1;
  } catch {}
  return 2;
}

function extractIframes(html, base) {
  const found = [];
  const seen = new Set();
  const re = /<iframe\b[^>]*\ssrc=["']([^"']+)["']/gi;
  for (const match of String(html || "").matchAll(re)) {
    const abs = absolutize(decodeRepeated(match[1]), base);
    if (!abs || seen.has(abs) || isBlacklistedHost(hostOf(abs))) continue;
    seen.add(abs);
    found.push(abs);
  }
  found.sort((a, b) => iframeScore(a) - iframeScore(b));
  return found;
}

function iframeScore(url) {
  return /player|cdn|movie|potok|tvmedia|tvtech/i.test(url) ? 0 : 1;
}

async function getText(url, referer, deadline, dest) {
  const timeout = Math.min(REQUEST_CAP_MS, remaining(deadline));
  if (timeout < 120) throw new Error("deadline exceeded");
  const response = await axios.get(url, {
    headers: browserHeaders(referer, dest),
    timeout,
    maxRedirects: 3,
    responseType: "text",
    transformResponse: (value) => value,
    validateStatus: (status) => status >= 200 && status < 400,
  });
  return {
    body: typeof response.data === "string" ? response.data : String(response.data || ""),
    finalUrl: response.request?.res?.responseUrl || response.request?.responseURL || url,
    contentType: String(response.headers?.["content-type"] || "").toLowerCase(),
  };
}

function usableCandidate(url) {
  return looksLikeM3U8(url) && !/(?:\s|%20)or(?:\s|%20)/i.test(url);
}

async function probePlaylist(candidate, referer, deadline) {
  let url = candidate;
  for (let hop = 0; hop < 4; hop++) {
    const timeout = Math.min(REQUEST_CAP_MS, remaining(deadline));
    if (timeout < 120) return null;
    const response = await axios.get(url, {
      headers: browserHeaders(referer, "empty"),
      timeout,
      maxRedirects: 0,
      responseType: "text",
      transformResponse: (value) => value,
      validateStatus: () => true,
    });
    const status = response.status;
    const location = response.headers?.location;
    if (status >= 300 && status < 400 && location) {
      url = new URL(location, url).toString();
      continue;
    }
    const text = String(response.data || "").replace(/^\uFEFF/, "").trimStart();
    if (status >= 200 && status < 300 && text.startsWith("#EXTM3U")) {
      return looksLikeM3U8(url) ? url : candidate;
    }
    return null;
  }
  return null;
}

async function firstPlayable(candidates, referer, deadline) {
  for (const candidate of candidates) {
    if (!usableCandidate(candidate) || remaining(deadline) < 180) continue;
    try {
      const found = await probePlaylist(candidate, referer, deadline);
      if (found) return found;
    } catch {}
  }
  return null;
}

async function walk(url, referer, deadline, dest, depth) {
  if (depth > MAX_HOPS || remaining(deadline) < 200) return null;
  let page;
  try {
    page = await getText(url, referer, deadline, dest);
  } catch {
    return null;
  }

  if (page.body.replace(/^\uFEFF/, "").trimStart().startsWith("#EXTM3U")) {
    return looksLikeM3U8(page.finalUrl) ? page.finalUrl : url;
  }

  const playable = await firstPlayable(extractAllCandidates(page.body, page.finalUrl), page.finalUrl, deadline);
  if (playable) return playable;

  for (const frame of extractIframes(page.body, page.finalUrl).slice(0, 2)) {
    const found = await walk(frame, page.finalUrl, deadline, "iframe", depth + 1);
    if (found) return found;
  }
  return null;
}

async function resolveFast(pageUrl, deadline) {
  if (looksLikeM3U8(pageUrl)) {
    const direct = await firstPlayable([pageUrl], pageUrl, deadline);
    if (direct) return direct;
  }
  return walk(pageUrl, pageUrl, deadline, "document", 0);
}

function selfTest() {
  const html = `<script>new Playerjs({file:"https://edge.example/live/master.m3u8?token=1"})</script>`;
  const found = extractCandidate(html, "https://example.test/player");
  if (found !== "https://edge.example/live/master.m3u8?token=1") throw new Error("m3u8 parser failed");

  const wrapped = unwrapQuery(
    "https://example.test/player.html?file=https%3A%2F%2Fedge.example%2Flive.m3u8",
    "https://example.test/",
  );
  if (wrapped !== "https://edge.example/live.m3u8") throw new Error("wrapper parser failed");

  const player = `var generatedFile = "https:\\/\\/tvcdnpotok.com\\/186\\/index.m3u8?token=1 or https:\\/\\/backup.example\\/186\\/index.m3u8?token=1";`;
  const alternatives = extractAllCandidates(player, "https://cdntvmedia.com/players/playerjs.php");
  if (alternatives[0] !== "https://tvcdnpotok.com/186/index.m3u8?token=1") {
    throw new Error(`primary alternative missed: ${alternatives[0]}`);
  }
  if (alternatives[1] !== "https://backup.example/186/index.m3u8?token=1") {
    throw new Error(`backup alternative missed: ${alternatives[1]}`);
  }

  const iframe = `<iframe src="https://cdntvmedia.com/players/playerjs.php?file=https://stream.example/live.m3u8&sp=5"></iframe>`;
  const fromIframe = extractAllCandidates(iframe, "https://smotru.tv/channel.html");
  if (!fromIframe.includes("https://stream.example/live.m3u8")) {
    throw new Error(`iframe file query missed: ${fromIframe.join(",")}`);
  }

  const frames = extractIframes(
    `<iframe src="https://programma-peredach.com/embed"></iframe><iframe src="https://cdntvmedia.com/movies/dom-kino.php?sp=5"></iframe>`,
    "https://smotru.tv/dom-kino.html",
  );
  if (frames.length !== 1 || !frames[0].includes("cdntvmedia.com/movies/dom-kino.php")) {
    throw new Error(`iframe filter failed: ${frames.join(",")}`);
  }
  if (browserHeaders("https://smotru.tv/a", "iframe")["Sec-Fetch-Dest"] !== "iframe") {
    throw new Error("iframe header missing");
  }
  if (MAX_BUDGET_MS >= 5000) throw new Error("budget must stay below 5s");
  console.log("Self-test passed");
}

async function main() {
  if (process.argv.includes("--selftest")) return selfTest();
  const input = process.argv[2];
  const explicitReferer = process.argv[3] && /^https?:\/\//i.test(process.argv[3]) ? process.argv[3] : null;
  if (!input) {
    console.error("Usage: node cdnpotok.js <channel-key|page-url> [referer-url]");
    process.exitCode = 2;
    return;
  }

  const started = now();
  const deadline = started + MAX_BUDGET_MS;
  let pageUrl = input;
  let key = null;
  if (!(explicitReferer && /^https?:\/\//i.test(input))) {
    const resolved = await resolveInput(input);
    if (!resolved) {
      console.error("channel not found");
      process.exitCode = 2;
      return;
    }
    pageUrl = resolved.pageUrl;
    key = resolved.key;
  }

  try {
    const result = await resolveFast(pageUrl, deadline);
    console.error(`[extractor] elapsed_ms=${now() - started}${key ? ` key=${key}` : ""}`);
    if (!result) {
      console.error("HLS not found by fast HTTP resolver");
      process.exitCode = 2;
      return;
    }
    console.log(result);
  } catch (error) {
    console.error(`[extractor] elapsed_ms=${now() - started}`);
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
