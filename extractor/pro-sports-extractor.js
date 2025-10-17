import axios from "axios";
import cloudscraper from "cloudscraper";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const M3U8_REGEX = /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>}]*/gi;
const RELATIVE_M3U8_REGEX = /(^|[^a-z0-9_/:])([/.][^\s"'<>\]}]+\.m3u8[^\s"'<>\]}]*)/gi;
const BASE64_TOKEN = /\b[A-Za-z0-9+/=]{40,}\b/g;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function absolutize(candidate, baseUrl) {
  const raw = String(candidate || "").trim();
  if (!raw) return null;
  try {
    return new URL(raw, baseUrl).href;
  } catch {
    return null;
  }
}

function sanitizeUrlCandidate(candidate) {
  let value = decodeHtmlEntities(String(candidate ?? "").trim());
  value = multiDecodeURIComponent(value);
  value = value.replace(/^['"(]+/, "").replace(/[)"'],?$/g, "");
  const stop = value.search(/[\s"'\])}]/);
  if (stop > 0) {
    value = value.slice(0, stop);
  }
  return value;
}

function decodeHtmlEntities(value) {
  if (!value || typeof value !== "string") return value;
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function multiDecodeURIComponent(value, limit = 5) {
  let current = String(value ?? "");
  for (let i = 0; i < limit; i += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current;
}

function maybeBase64Decode(value) {
  const text = String(value ?? "").replace(/\s+/g, "");
  if (!text || text.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(text)) return null;
  try {
    return Buffer.from(text, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function tryParseJson(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractUrlsFromQueryString(value) {
  const found = [];
  try {
    const params = new URLSearchParams(value);
    for (const val of params.values()) {
      found.push(val);
    }
  } catch {
    // ignore
  }
  return found;
}

function collectFromJson(value, pushString) {
  if (typeof value === "string") {
    pushString(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectFromJson(entry, pushString);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      collectFromJson(entry, pushString);
    }
  }
}

function extractCandidateStrings(scriptText) {
  const results = new Set();
  const quotePattern = /(["'`])((?:\\.|(?!\1)[\s\S])+?)\1/g;
  let match;
  while ((match = quotePattern.exec(scriptText)) !== null) {
    const raw = match[2];
    if (!raw) continue;
    if (raw.length < 5) continue;
    results.add(raw);
  }
  return results;
}

function normalizeJsEscapes(value) {
  if (value == null) return "";
  const asString = String(value);

  try {
    return JSON.parse(`"${asString}"`);
  } catch {
    try {
      return JSON.parse(`"${asString.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
    } catch {
      return asString
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\`/g, "`")
        .replace(/\\\//g, "/");
    }
  }
}

function decodeLayers(initial, pushString) {
  const queue = [initial];
  const seen = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null) continue;
    const asString = String(current);
    if (!seen.add(asString)) continue;
    pushString(asString);

    const htmlDecoded = decodeHtmlEntities(asString);
    if (htmlDecoded !== asString) queue.push(htmlDecoded);

    const uriDecoded = multiDecodeURIComponent(asString);
    if (uriDecoded !== asString) queue.push(uriDecoded);

    const base64Decoded = maybeBase64Decode(asString);
    if (base64Decoded && base64Decoded !== asString) queue.push(base64Decoded);

    if (asString.includes("|")) {
      for (const part of asString.split("|")) {
        if (part && part !== asString) queue.push(part);
      }
    }

    if (asString.includes("&") && asString.includes("=")) {
      for (const part of extractUrlsFromQueryString(asString)) {
        if (part && part !== asString) queue.push(part);
      }
    }

    const json = tryParseJson(asString);
    if (json) {
      collectFromJson(json, (next) => {
        if (next && next !== asString) queue.push(next);
      });
    }
  }
}

export function extractProSportsCandidates(html, baseUrl) {
  const found = new Set();
  const processedStrings = new Set();

  function pushUrl(candidate) {
    const sanitized = sanitizeUrlCandidate(candidate);
    if (!sanitized) return;
    if (!/^https?:/i.test(sanitized) && !sanitized.startsWith("//") && !sanitized.startsWith("/") && !sanitized.startsWith("./")) {
      return;
    }
    const normalized = absolutize(sanitized, baseUrl);
    if (normalized && /\.m3u8(\b|\?)/i.test(normalized)) {
      found.add(normalized);
    }
  }

  function processString(value) {
    const raw = String(value ?? "");
    if (!raw || processedStrings.has(raw)) return;
    processedStrings.add(raw);

    const directMatches = raw.match(M3U8_REGEX);
    if (directMatches) {
      for (const item of directMatches) {
        pushUrl(item);
      }
    }

    const relativeMatches = [];
    let relMatch;
    while ((relMatch = RELATIVE_M3U8_REGEX.exec(raw)) !== null) {
      const rel = relMatch[2];
      if (rel) relativeMatches.push(rel);
    }
    for (const rel of relativeMatches) {
      pushUrl(rel);
    }

    decodeLayers(raw, (decoded) => {
      if (!decoded || processedStrings.has(decoded)) return;
      processString(decoded);
    });
  }

  const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const script of scripts) {
    const [, content = ""] = script.match(/<script[^>]*>([\s\S]*?)<\/script>/i) || [];
    for (const token of extractCandidateStrings(content || "")) {
      const normalizedToken = normalizeJsEscapes(token);
      const heuristicTarget = normalizedToken || token || "";
      if (
        heuristicTarget.length >= 40 ||
        /m3u8|https?:/i.test(heuristicTarget) ||
        /%7B|%22/.test(heuristicTarget) ||
        /streams|token/i.test(heuristicTarget)
      ) {
        processString(normalizedToken);
      }
    }

    const base64Matches = content.match(BASE64_TOKEN) || [];
    for (const token of base64Matches) {
      processString(token);
    }
  }

  // fallback: search entire HTML for direct links
  const direct = html.match(M3U8_REGEX);
  if (direct) {
    for (const url of direct) pushUrl(url);
  }

  return Array.from(found).sort();
}

async function fetchHtml(target) {
  if (/^https?:/i.test(target)) {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Referer: new URL(target).origin + "/",
      "Accept-Language": "en-US,en;q=0.9,ru;q=0.8",
    };

    try {
      const resp = await axios.get(target, {
        responseType: "text",
        timeout: 20000,
        headers,
        maxRedirects: 5,
      });
      if (typeof resp.data === "string" && !isCloudflareChallenge(resp)) {
        return resp.data;
      }
      const fallbackHtml = await maybeCloudscrape(target, headers, {
        response: resp,
      });
      if (fallbackHtml) return fallbackHtml;
      if (typeof resp.data === "string") {
        return resp.data;
      }
      return String(resp.data ?? "");
    } catch (err) {
      const html = await maybeCloudscrape(target, headers, err);
      if (html) return html;
      throw err;
    }
  }

  const data = await readFile(target, "utf8");
  return data;
}

function isCloudflareChallenge(resp) {
  const status = resp?.status;
  if (status && status >= 200 && status < 300) {
    const data = typeof resp.data === "string" ? resp.data : "";
    if (data.includes("cf-mitigated") || data.includes("Just a moment")) {
      return true;
    }
  }
  if (status === 403 || status === 503) return true;
  return false;
}

async function maybeCloudscrape(target, headers, originalError) {
  const err = originalError || {};
  const status = err?.response?.status;
  const code = err?.code;
  const isRedirectError = code === "ERR_FR_TOO_MANY_REDIRECTS";
  const shouldRetry =
    isRedirectError ||
    status === 403 ||
    status === 503 ||
    /cloudflare|Just a moment/i.test(err?.response?.data ?? "");

  if (!shouldRetry) return null;

  try {
    const body = await cloudscraper.get({
      uri: target,
      headers,
      gzip: true,
      timeout: 20000,
      resolveWithFullResponse: false,
    });
    if (typeof body === "string" && body.trim()) {
      return body;
    }
  } catch (cloudError) {
    if (cloudError?.response?.body) {
      return String(cloudError.response.body);
    }
    throw cloudError;
  }

  return null;
}

async function runCli() {
  const [,, arg, maybeTimeout] = process.argv;
  if (!arg || arg === "-h" || arg === "--help") {
    console.log("usage: node extractor/pro-sports-extractor.js <url|path> [timeoutMs]");
    console.log("       node extractor/pro-sports-extractor.js --selftest");
    process.exit(0);
  }

  if (arg === "--selftest") {
    const fixturePath = path.join(__dirname, "fixtures", "view-source_https___pro-sports.live_match-futbol-3.html");
    const html = await readFile(fixturePath, "utf8");
    const expected = [
      "https://backup1.pro-sports.example/hls/match-futbol-3_backup.m3u8",
      "https://edge-alt.pro-sports.example/live/match-futbol-3_alt.m3u8",
      "https://mirror-cdn.pro-sports.example/edge/match-futbol-3/index.m3u8",
      "https://play-cdn.pro-sports.example/edge/match-futbol-3/master.m3u8",
      "https://play1.pro-sports.example/linear/match-futbol-3/playlist.m3u8",
      "https://play2.pro-sports.example/live/match-futbol-3_sd.m3u8",
      "https://secure-token.pro-sports.example/live/match-futbol-3_token.m3u8?token=secure-example",
    ].sort();
    const actual = extractProSportsCandidates(html, "https://pro-sports.live/match-futbol-3.html").sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      console.error("[selftest] pro-sports extractor mismatch\n expected:", expected, "\n actual:", actual);
      process.exit(1);
    }
    console.log("[selftest] pro-sports extractor OK (", actual.length, "stream(s))");
    return;
  }

  const timeout = Number.parseInt(maybeTimeout || "", 10);
  if (Number.isFinite(timeout) && timeout > 0) {
    axios.defaults.timeout = timeout;
  }

  try {
    const html = await fetchHtml(arg);
    const base = /^https?:/i.test(arg) ? arg : undefined;
    const result = extractProSportsCandidates(html, base);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    console.error("[pro-sports-extractor] Ошибка:", err?.stack || err);
    process.exit(1);
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  runCli();
}
