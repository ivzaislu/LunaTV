// resolver_http.js
// Использование:
//   node resolver_http.js https://telik.live/plan-b.html

const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.141 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.62 Safari/537.36',
];
const UA = UA_LIST[Math.floor(Math.random() * UA_LIST.length)];

const RE_IFRAME = /<iframe[^>]+src=["']([^"']*cdntvmedia\.com\/[^"']+)["']/i;
const RE_PLAYERFILE = /playerjs\.html\?file=([^"'&\s<>]+)/i;
const RE_ANY_M3U8 = /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi;
const RE_FINAL = /https?:\/\/tv\.tvcdnpotok\.com\/[^/]+\/\d+\/\d+\/index\.m3u8/i;

async function fetchText(url, headers = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      ...headers,
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchFollow(url, headers = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      'Referer': 'https://cdntvmedia.com/player/playerjs.html',
      'Origin': 'https://cdntvmedia.com',
      'Accept': '*/*',
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      ...headers,
    },
  });
  const finalUrl = res.url || url;
  const body = await res.text().catch(() => '');
  return { finalUrl, body };
}

function absolutize(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}
function uniq(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

async function resolveChannel(pageUrl) {
  const pageHtml = await fetchText(pageUrl);
  const iframeMatch = pageHtml.match(RE_IFRAME);
  if (!iframeMatch) throw new Error('iframe не найден');
  const iframeUrl = absolutize(pageUrl, iframeMatch[1]);

  const iframeHtml = await fetchText(iframeUrl, { Referer: pageUrl });

  const candidates = [];
  const pf = iframeHtml.match(RE_PLAYERFILE);
  if (pf) candidates.push(decodeURIComponent(pf[1]));
  const alls = iframeHtml.match(RE_ANY_M3U8) || [];
  candidates.push(...alls.map((u) => absolutize(iframeUrl, u)));

  const uniqCand = uniq(candidates);

  for (const c of uniqCand) {
    let url = c;
    if (/playerjs\.html\?file=/i.test(c)) {
      try {
        const u = new URL(c);
        const f = u.searchParams.get('file');
        if (f) url = decodeURIComponent(f);
      } catch {}
    }

    const { finalUrl, body } = await fetchFollow(url);
    const hit = finalUrl.match(RE_FINAL) || (body || '').match(RE_FINAL);
    if (hit) return hit[0];
  }

  throw new Error('финальный m3u8 не найден');
}

// main
const pageUrl = process.argv[2];
if (!pageUrl) {
  console.error('Использование: node resolver_http.js <URL_страницы>');
  process.exit(1);
}
resolveChannel(pageUrl)
  .then((url) => console.log(url))
  .catch((e) => {
    console.error('Ошибка:', e.message || e);
    process.exit(1);
  });
