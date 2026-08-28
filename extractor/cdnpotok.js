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
const REQUEST_CAP_MS = 1800;

function now() { return Date.now(); }
function remaining(deadline) { return Math.max(0, deadline - now()); }
function absolutize(value, base) {
  try { return new URL(String(value || "").replace(/&amp;/g, "&"), base).toString(); }
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
function looksLikeM3U8(value) { return /\.m3u8(?:[?#]|$)/i.test(String(value || "")); }

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
        return { key, referer: entry.url, target: entry.cdn || entry.url };
      }
    }
    return { key: null, referer: input, target: input };
  }
  const entry = channels[input];
  if (!entry || typeof entry !== "object" || !entry.url) return null;
  return { key: input, referer: entry.url, target: entry.cdn || entry.url };
}

function decodeRepeated(value) {
  let current = String(value || "").replace(/&amp;/g, "&");
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch { break; }
  }
  return current;
}

function extractCandidate(text, base) {
  const body = String(text || "");
  const direct = body.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>}]*/i);
  if (direct) return absolutize(decodeRepeated(direct[0]), base);

  const attrs = [
    /(?:file|src|url|m3u8|video)\s*[:=]\s*["']([^"']+)["']/i,
    /["'](?:file|src|url|m3u8|video)["']\s*:\s*["']([^"']+)["']/i,
  ];
  for (const re of attrs) {
    const match = body.match(re);
    if (!match?.[1]) continue;
    const decoded = decodeRepeated(match[1]);
    const absolute = absolutize(decoded, base);
    if (absolute) return absolute;
  }

  const rel = body.match(/["'](\/[^"'<>]+\.m3u8[^"'<>}]*)["']/i);
  return rel ? absolutize(decodeRepeated(rel[1]), base) : null;
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

async function getText(url, referer, deadline) {
  const timeout = Math.min(REQUEST_CAP_MS, remaining(deadline));
  if (timeout < 100) throw new Error("deadline exceeded");
  const response = await axios.get(url, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
      "Referer": referer,
      "Accept": "text/html,application/xhtml+xml,application/vnd.apple.mpegurl,application/x-mpegURL,*/*;q=0.8",
      "Cache-Control": "no-cache",
    },
    timeout,
    maxRedirects: 3,
    responseType: "text",
    transformResponse: (value) => value,
    validateStatus: (status) => status >= 200 && status < 400,
  });
  return {
    body: typeof response.data === "string" ? response.data : String(response.data || ""),
    finalUrl: response.request?.res?.responseUrl || url,
    contentType: String(response.headers?.["content-type"] || "").toLowerCase(),
  };
}

async function resolveFast(target, referer, deadline) {
  let current = unwrapQuery(target, target);
  if (looksLikeM3U8(current)) return current;

  const first = await getText(current, referer, deadline);
  if (looksLikeM3U8(first.finalUrl) || first.contentType.includes("mpegurl") || first.body.trimStart().startsWith("#EXTM3U")) {
    return first.finalUrl;
  }

  let candidate = extractCandidate(first.body, first.finalUrl);
  if (!candidate) return null;
  candidate = unwrapQuery(candidate, first.finalUrl);
  if (looksLikeM3U8(candidate)) return candidate;

  if (remaining(deadline) < 250) return null;
  const second = await getText(candidate, referer, deadline);
  if (looksLikeM3U8(second.finalUrl) || second.contentType.includes("mpegurl") || second.body.trimStart().startsWith("#EXTM3U")) {
    return second.finalUrl;
  }
  candidate = extractCandidate(second.body, second.finalUrl);
  return candidate && looksLikeM3U8(candidate) ? candidate : null;
}

function selfTest() {
  const html = `<script>new Playerjs({file:"https://edge.example/live/master.m3u8?token=1"})</script>`;
  const found = extractCandidate(html, "https://example.test/player");
  if (found !== "https://edge.example/live/master.m3u8?token=1") throw new Error("m3u8 parser failed");
  const wrapped = unwrapQuery("https://example.test/player.html?file=https%3A%2F%2Fedge.example%2Flive.m3u8", "https://example.test/");
  if (wrapped !== "https://edge.example/live.m3u8") throw new Error("wrapper parser failed");
  if (MAX_BUDGET_MS >= 5000) throw new Error("budget must stay below 5s");
  console.log("Self-test passed");
}

async function main() {
  if (process.argv.includes("--selftest")) return selfTest();
  const input = process.argv[2];
  const explicitReferer = process.argv[3] && /^https?:\/\//i.test(process.argv[3]) ? process.argv[3] : null;
  if (!input) {
    console.error("Usage: node cdnpotok.js <channel-key|page-url|cdn-url> [referer-url]");
    process.exitCode = 2;
    return;
  }

  const started = now();
  const deadline = started + MAX_BUDGET_MS;
  let resolved;
  if (explicitReferer && /^https?:\/\//i.test(input)) {
    resolved = { key: null, target: input, referer: explicitReferer };
  } else {
    resolved = await resolveInput(input);
  }
  if (!resolved) {
    console.error("channel not found");
    process.exitCode = 2;
    return;
  }

  try {
    const result = await resolveFast(resolved.target, resolved.referer, deadline);
    console.error(`[extractor] elapsed_ms=${now() - started}${resolved.key ? ` key=${resolved.key}` : ""}`);
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
