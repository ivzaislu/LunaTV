// cdnpotok.js — channels.json lookup by referer URL, with robust matching
import axios from "axios";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Конфиг ищем относительно файла скрипта:
const CONFIG_DIR    = path.resolve(__dirname, "..", "config");
const CHANNELS_PATH = path.join(CONFIG_DIR, "channels.json");

// ---- settings ----
const UA = "Mozilla/5.0";
const DEBUG = process.env.DEBUG === "1";

// ---- args ----
function extractFirstUrl(s) {
  if (!s) return null;
  const m = String(s).match(/https?:\/\/[^\s"'<>)]+/i);
  return m ? m[0] : null;
}
const a1 = process.argv[2] || "";
const a2 = process.argv[3] || "";
const a3 = process.argv[4] || "";
const u1 = extractFirstUrl(a1);
const u2 = extractFirstUrl(a2);
const qualityPref = (/(^best$)|^\d{3,4}$/.test(a3) ? a3 : /(best|\d{3,4})/.test(a2) ? a2 : "best").toLowerCase();

if (!a1) {
  console.error('Использование:\n  node cdnpotok.js "<channelKey | REFERER_URL>" [качество]\n  node cdnpotok.js "<CDN_URL>" "<REFERER_URL>" [качество]');
  process.exit(1);
}

// ---- utils ----
function originOf(u) { try { return new URL(u).origin; } catch { return ""; } }
function absolutize(maybeUrl, base) { try { return new URL(maybeUrl, base).href; } catch { return maybeUrl; } }
function looksLikeM3U8(u) { return /\.m3u8(\b|$)/i.test(u || ""); }
function multiDecodeURIComponent(s, times = 5) {
  let cur = (s || "").replace(/&amp;/g, "&");
  for (let i = 0; i < times; i++) { try { const dec = decodeURIComponent(cur); if (dec === cur) break; cur = dec; } catch { break; } }
  return cur;
}
function maybeBase64Decode(s) {
  const t = (s || "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(t) || t.length % 4 !== 0) return null;
  try { return Buffer.from(t, "base64").toString("utf8"); } catch { return null; }
}
function tryParseJson(s) { try { return JSON.parse(s); } catch { return null; } }

// ---- URL matching helpers ----
function normalizeForMatch(u) {
  try {
    const x = new URL(u);
    let host = x.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    let p = x.pathname || "/";
    if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
    // игнорируем query и hash
    return `${host}${p}`;
  } catch { return (u || "").toLowerCase(); }
}
function samePage(a, b) { return normalizeForMatch(a) === normalizeForMatch(b); }
function basenameKeyFromUrl(u) {
  try {
    const x = new URL(u);
    const base = x.pathname.split("/").filter(Boolean).pop() || "";
    const name = base.replace(/\.[a-z0-9]+$/i, ""); // убираем .html
    if (!name) return null;
    return `${name}-oneliketv`;
  } catch { return null; }
}

// ---- channels ----
async function readChannels() {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(CHANNELS_PATH, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    await fs.writeFile(CHANNELS_PATH, JSON.stringify({}, null, 2), "utf8");
    return {};
  }
}
async function findByRefererUrl(refererUrl) {
  const channels = await readChannels();
  // 1) прямой матч по entry.url
  for (const [key, entry] of Object.entries(channels)) {
    if (entry && entry.url && samePage(entry.url, refererUrl)) {
      return { key, entry };
    }
  }
  // 2) попытка по вычисленному ключу <basename>-oneliketv
  const guessKey = basenameKeyFromUrl(refererUrl);
  if (guessKey && channels[guessKey]) {
    return { key: guessKey, entry: channels[guessKey] };
  }
  return null;
}

// ---- HTTP ----
function commonHeaders(forUrl, referer) {
  const h = {
    Referer: referer,
    Origin: originOf(referer),
    "User-Agent": UA,
    "Accept-Language": "ru,en;q=0.9",
  };
  return h;
}

async function fetchText(url, referer) {
  const headers = {
    ...commonHeaders(url, referer),
    Accept: "application/vnd.apple.mpegurl,application/x-mpegURL,text/html;q=0.9,*/*;q=0.8",
  };
  if (DEBUG) console.error(`[GET]  REF=${headers.Referer} URL=${url}`);
  const resp = await axios.get(url, {
    headers,
    timeout: 20000,
    responseType: "text",
    transformResponse: x => x,
    maxRedirects: 5,
    validateStatus: s => s >= 200 && s < 400,
  });
  if (DEBUG) console.error(`      -> ${resp.status}`);
  return typeof resp.data === "string" ? resp.data : String(resp.data);
}

async function resolveFinalUrl(startUrl, referer, maxHops = 10) {
  let current = startUrl;
  for (let i = 0; i < maxHops; i++) {
    const headers = { ...commonHeaders(current, referer), Accept: "*/*" };
    if (DEBUG) console.error(`[HOP] REF=${headers.Referer} URL=${current}`);
    const resp = await axios.get(current, {
      headers,
      maxRedirects: 0,
      timeout: 20000,
      validateStatus: s => s >= 200 && s < 400,
    });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.location;
      if (DEBUG) console.error(`     -> ${resp.status} Location: ${loc || "(none)"}`);
      if (!loc) return current;
      current = absolutize(loc, current);
      continue;
    }
    if (DEBUG) console.error(`     -> ${resp.status} (final)`);
    return current; // 2xx
  }
  return current;
}

// ---- parsers ----
function extractStreamUrlFromHtml(html, base) {
  const patterns = [
    /file\s*:\s*["']([^"']+)["']/i, /"file"\s*:\s*["']([^"']+)["']/i,
    /src\s*:\s*["']([^"']+)["']/i,  /"src"\s*:\s*["']([^"']+)["']/i,
    /url\s*:\s*["']([^"']+)["']/i,  /"url"\s*:\s*["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return absolutize(multiDecodeURIComponent(m[1]), base);
  }
  const m3u8 = html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>}]*/i);
  if (m3u8) return absolutize(m3u8[0], base);
  const mp4 = html.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>}]*/i);
  if (mp4) return absolutize(mp4[0], base);
  const rel = html.match(/["'](\/[^"'<>]+\.(?:m3u8|mp4)[^"'<>}]*)["']/i);
  if (rel) return absolutize(rel[1], base);
  return null;
}

function extractFromJsonLike(obj, baseUrl) {
  if (typeof obj === "string") {
    const dec = multiDecodeURIComponent(obj);
    const direct = (dec.match(/https?:\/\/[^\s"'<>]+?\.(?:m3u8|mp4)[^\s"'<>}]*/i) || [])[0];
    if (direct) return absolutize(direct, baseUrl);
    return null;
  }
  if (Array.isArray(obj)) {
    for (const it of obj) { const r = extractFromJsonLike(it, baseUrl); if (r) return r; }
    return null;
  }
  if (obj && typeof obj === "object") {
    const keys = ["file","src","url","m3u8","video"];
    for (const k of keys) {
      if (obj[k]) {
        const v = typeof obj[k] === "string" ? multiDecodeURIComponent(obj[k]) : obj[k];
        if (typeof v === "string") {
          const qlist = /[|]/.test(v) && /(m3u8|mp4)/i.test(v) ? pickFromQualityList(v, baseUrl) : null;
          if (qlist) return qlist;
          const direct = (v.match(/https?:\/\/[^\s"'<>]+?\.(?:m3u8|mp4)[^\s"'<>}]*/i) || [])[0];
          if (direct) return absolutize(direct, baseUrl);
          if (/^\/[^"'<>]+\.(?:m3u8|mp4)/i.test(v)) return absolutize(v, baseUrl);
        } else if (v && typeof v === "object") {
          const r = extractFromJsonLike(v, baseUrl); if (r) return r;
        }
      }
    }
  }
  return null;
}

function unwrapPlayerWrappers(url) {
  let current = url;
  for (let i = 0; i < 5; i++) {
    let next = null;
    try {
      const u = new URL(current, current);
      const params = ["file","src","url","m3u8","video"];
      for (const p of params) {
        if (u.searchParams.has(p)) {
          let v = multiDecodeURIComponent(u.searchParams.get(p) || "");
          const b64 = maybeBase64Decode(v);
          if (b64) {
            const j = tryParseJson(b64);
            if (j) { const f = extractFromJsonLike(j, current); if (f) { next = f; break; } }
            const directB64 = (b64.match(/https?:\/\/[^\s"'<>]+?\.(?:m3u8|mp4)[^\s"'<>}]*/i)||[])[0];
            if (directB64) { next = absolutize(directB64, current); break; }
          }
          const j2 = tryParseJson(v);
          if (j2) { const f = extractFromJsonLike(j2, current); if (f) { next = f; break; } }
          const direct = (v.match(/https?:\/\/[^\s"'<>]+?\.(?:m3u8|mp4)[^\s"'<>}]*/i)||[])[0];
          if (direct) { next = absolutize(direct, current); break; }
          if (/^\/[^"'<>]+\.(?:m3u8|mp4)/i.test(v)) { next = absolutize(v, current); break; }
          if (/playerjs\.html/i.test(v) && /file=/.test(v)) { next = absolutize(v, current); break; }
        }
      }
    } catch {}
    if (!next) break;
    current = next;
  }
  return current;
}

function parseAttrs(line) {
  const out = {};
  for (const kv of line.split(",")) {
    const [k, vRaw] = kv.split("=");
    if (!k || vRaw === undefined) continue;
    out[k.trim().toUpperCase()] = vRaw.replace(/^"|"$/g, "").trim();
  }
  return out;
}

function pickFromQualityList(listStr, baseUrl) {
  const parts = (listStr || "").split(/\s*,\s*/).map(x => x.trim()).filter(Boolean);
  const items = parts.map(p => {
    const [label, url] = p.includes("|") ? p.split("|") : [null, p];
    const h = label && /\d{3,4}p/i.test(label) ? parseInt(label) : 0;
    return { h, uri: absolutize(url, baseUrl) };
  }).filter(x => x.uri);

  if (!items.length) return null;
  if (qualityPref !== "best") {
    const q = Number(qualityPref);
    const exact = items.find(i => i.h === q);
    if (exact) return exact.uri;
    const below = items.filter(i => i.h && i.h <= q).sort((a,b)=>b.h-a.h)[0];
    if (below) return below.uri;
  }
  const withH = items.filter(i => i.h);
  if (withH.length) return withH.sort((a,b)=>b.h-a.h)[0].uri;
  return items[items.length - 1].uri;
}

function pickVariantFromMaster(masterText, baseUrl) {
  const lines = masterText.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (ln.startsWith("#EXT-X-STREAM-INF:")) {
      const attrs = parseAttrs(ln.slice("#EXT-X-STREAM-INF:".length));
      const uri = (lines[i + 1] || "").trim();
      if (!uri || uri.startsWith("#")) continue;
      const abs = absolutize(uri, baseUrl);
      const bw = Number(attrs["BANDWIDTH"] || 0);
      let h = 0;
      const res = attrs["RESOLUTION"];
      if (res && res.includes("x")) h = Number(res.toLowerCase().split("x")[1]) || 0;
      variants.push({ uri: abs, bandwidth: bw, height: h });
    }
  }
  if (!variants.length) return null;

  if (qualityPref !== "best") {
    const q = Number(qualityPref);
    const exact = variants.find(v => v.height === q);
    if (exact) return exact.uri;
    const below = variants.filter(v => v.height && v.height <= q).sort((a,b)=>b.height-a.height)[0];
    if (below) return below.uri;
  }
  variants.sort((a,b)=>(b.bandwidth-a-bandwidth)||(b.height-a.height));
  return variants[0].uri;
}

// ---- main resolver ----
async function resolvePlayableUrl(url, referer) {
  url = unwrapPlayerWrappers(url);

  // CDN page HTML?
  if (!looksLikeM3U8(url) && !/\.mp4(\?|$)/i.test(url) && !/playerjs\.html/i.test(url)) {
    const html = await fetchText(url, referer);
    const fromHtml = extractStreamUrlFromHtml(html, url);
    if (fromHtml) url = unwrapPlayerWrappers(fromHtml);
  }

  if (!looksLikeM3U8(url)) {
    return await resolveFinalUrl(url, referer);
  }

  const txt = await fetchText(url, referer);
  if (/#EXT-X-STREAM-INF:/i.test(txt)) {
    const variant = pickVariantFromMaster(txt, url);
    return await resolveFinalUrl(variant || url, referer);
  }
  return await resolveFinalUrl(url, referer);
}

// ---- MAIN ----
(async function main() {
  try {
    let cdnUrl, refererUrl;

    if (u1 && u2) {
      // два URL: CDN + Referer
      cdnUrl = u1; refererUrl = u2;
    } else if (u1 && !u2) {
      // один URL: считаем это REFERER → ищем канал по url
      const found = await findByRefererUrl(u1);
      if (!found) {
        console.error(`Нет записи в ${CHANNELS_PATH} для url = ${u1}`);
        process.exit(2);
      }
      refererUrl = found.entry.url;
      cdnUrl = found.entry.cdn || found.entry.url;
      if (DEBUG) console.error(`[FOUND] key=${found.key} cdn=${cdnUrl}`);
    } else {
      // ключ канала
      const channels = await readChannels();
      const entry = channels[a1];
      if (!entry || !entry.url) {
        console.error(`Канал "${a1}" не найден или без url в ${CHANNELS_PATH}`);
        process.exit(2);
      }
      refererUrl = entry.url;
      cdnUrl = entry.cdn || entry.url;
    }

    const finalUrl = await resolvePlayableUrl(cdnUrl, refererUrl);
    console.log(finalUrl); // только финальная ссылка
  } catch (e) {
    console.error(e?.message || String(e));
    process.exit(1);
  }
})();
