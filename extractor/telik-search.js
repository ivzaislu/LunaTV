// node extractor/telik-search.js <startUrl> <timeoutSec>
// Возвращает JSON-массив абсолютных URL каналов с категории telik.live

import { load } from "cheerio";
import { URL } from "node:url";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";

function normalize(u) {
  try {
    const x = new URL(u);
    const scheme = (x.protocol || "http:").toLowerCase();
    const host = (x.hostname || "").toLowerCase();
    if (!host) return u;
    let netloc = host;
    const p = x.port ? parseInt(x.port, 10) : null;
    if (p && !((scheme === "http:" && p === 80) || (scheme === "https:" && p === 443))) {
      netloc = `${host}:${p}`;
    }
    let path = (x.pathname || "/").replace(/\/+/, "/").replace(/\/$/, "");
    if (!path) path = "/";
    return `${scheme}//${netloc}${path}${x.search || ""}`;
  } catch {
    return u;
  }
}

async function fetchHtml(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,*/*",
        "Accept-Language": "ru,en;q=0.9",
        "Referer": "https://telik.live/"
      },
      redirect: "follow",
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function collectChannelLinks($, startUrl) {
  const baseTag = $("base").attr("href");
  const base = normalize(baseTag ? new URL(baseTag, startUrl).toString() : startUrl);

  const seen = new Set();
  const out = [];

  $("a[href]").each((_, a) => {
    const raw = ($(a).attr("href") || "").trim();
    if (!raw) return;
    let abs;
    try { abs = new URL(raw, base).toString(); } catch { return; }
    if (!/^https?:\/\/telik\.live(\/|$)/i.test(abs)) return;

    const u = new URL(abs);
    if (!/\.html$/i.test(u.pathname)) return;
    if (/^\/(tv-online\/|component\/|index\.php$|sitemap\.html$)/i.test(u.pathname)) return;

    const norm = normalize(u.toString());
    if (seen.has(norm)) return;
    seen.add(norm);
    out.push(norm);
  });

  return out;
}

(async function main() {
  const startUrl = process.argv[2];
  const timeoutSec = parseInt(process.argv[3] || "12", 10);
  if (!startUrl) {
    console.error("Usage: node extractor/telik-search.js <startUrl> [timeoutSec]");
    process.stdout.write("[]");
    process.exit(2);
  }

  let html = "";
  try {
    html = await fetchHtml(startUrl, Math.max(1, timeoutSec) * 1000);
  } catch (e) {
    console.error("fetch error:", e?.message || e);
    process.stdout.write("[]");
    process.exit(0);
  }

  const $ = load(html);
  const links = collectChannelLinks($, startUrl);
  process.stdout.write(JSON.stringify(links));
})();
