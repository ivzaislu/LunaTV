// script.js — ESM, Node 18+
// usage: node script.js "http://oneliketv.net/eurosport.html" 10
import { setTimeout as delay } from "node:timers/promises";
import { URL as NodeURL } from "node:url";

/* --- UA профили: обычный (рандом) + принудительный iPhone Safari --- */
const UA_PROFILES = [
  { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    al: "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7" },
  { ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    al: "ru,en;q=0.9,uk;q=0.8" },
  { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    al: "en-US,en;q=0.9,ru;q=0.8" },
];
const HLS_IOS = { // принудительный профиль для HLS-попыток
  ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  al: "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
};
const RAND = UA_PROFILES[Math.floor(Math.random()*UA_PROFILES.length)];

/* --- настройки --- */
const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 12000;
const REQ_DELAY = 15;

const startUrl = process.argv[2];
const maxDepth = parseInt(process.argv[3] || "3", 10);
if (!startUrl) process.exit(1);

const printed = new Set();
const visited = new Set();
const queue = [];

/* --- cookie-jar (упрощённо) --- */
class CookieJar {
  constructor(){ this.store=[]; }
  setFromResponse(urlStr, res){
    const raw=res.headers.get("set-cookie"); if(!raw) return;
    for (const sc of splitSetCookieHeader(raw)) this.add(urlStr, sc);
  }
  add(urlStr, sc){
    const url=new NodeURL(urlStr);
    const [kv,...attrs]=sc.split(";").map(s=>s.trim());
    const i=kv.indexOf("="); if(i<1) return;
    const c={name:kv.slice(0,i),value:kv.slice(i+1),domain:url.hostname,path:"/",secure:false,expires:null};
    for(const a of attrs){
      const [k,v]=(a.split("=").map(x=>x&&x.trim()));
      if(!k) continue; const key=k.toLowerCase();
      if(key==="domain"&&v) c.domain=v.replace(/^\./,"");
      else if(key==="path"&&v) c.path=v;
      else if(key==="secure") c.secure=true;
      else if(key==="expires"&&v){ const ts=Date.parse(v); if(!Number.isNaN(ts)) c.expires=ts; }
      else if(key==="max-age"&&v&&!isNaN(+v)) c.expires=Date.now()+(+v)*1000;
    }
    this.store=this.store.filter(x=>!(x.name===c.name&&x.domain===c.domain&&x.path===c.path));
    this.store.push(c);
  }
  getHeader(urlStr){
    const url=new NodeURL(urlStr);
    const now=Date.now(), host=url.hostname, path=url.pathname||"/", https=url.protocol==="https:";
    const cookies=this.store.filter(c=>{
      if(c.expires && c.expires<now) return false;
      const dom=(host===c.domain)||host.endsWith("."+c.domain);
      if(!dom) return false;
      if(!path.startsWith(c.path)) return false;
      if(c.secure && !https) return false;
      return true;
    }).map(c=>`${c.name}=${c.value}`);
    return cookies.length?cookies.join("; "):null;
  }
}
function splitSetCookieHeader(h){
  const out=[]; let buf="", inExp=false;
  for(let i=0;i<h.length;i++){
    const ch=h[i];
    if(ch==="," && !inExp){ if(buf.trim()) out.push(buf.trim()); buf=""; continue; }
    buf+=ch;
    if(buf.toLowerCase().endsWith("expires=")) inExp=true;
    if(inExp && ch===";") inExp=false;
  }
  if(buf.trim()) out.push(buf.trim());
  return out;
}
const JAR = new CookieJar();

/* --- утилиты --- */
const isHtml = (ct="") => /text\/html|application\/xhtml\+xml/i.test(ct);
const isHlsCT = (ct="") => /application\/vnd\.apple\.mpegurl|application\/x-mpegURL/i.test(ct);
const looksLikeHls = (u="") => /\.m3u8(\b|[?#])/i.test(u);
function abs(base, href){ try{ return new NodeURL(href, base).toString(); }catch{ return null; } }
function pick(tag, attr, html){
  const re=new RegExp(`<${tag}\\b[^>]*?\\s${attr}\\s*=\\s*["']([^"']+)["'][^>]*>`, "ig");
  const out=[]; let m; while((m=re.exec(html))) out.push(m[1]); return out;
}
function extractM3u8FromURL(u){
  try{ const url=new NodeURL(u);
    for(const [,v] of url.searchParams){
      const m=String(v).match(/https?:\/\/[^\s"'<>]+?\.m3u8[^\s"'<>]*/i);
      if(m) return m[0];
    }
  }catch{}
  const m=String(u).match(/https?:\/\/[^\s"'<>]+?\.m3u8[^\s"'<>]*/i);
  return m?m[0]:null;
}
function decodeMaybe(s){ try{return decodeURIComponent(s);}catch{return s;} }

/* --- фиксация страницы плеера для реферера --- */
let PLAYER_REF = null;

/* --- построение заголовков (с возможностью «без Origin/Referer») --- */
function buildHeaders(forUrl, profile, refMode){
  const h = {
    "User-Agent": profile.ua,
    "Accept": "application/vnd.apple.mpegurl, application/x-mpegURL, */*",
    "Accept-Language": profile.al,
    "Cache-Control": "no-cache",
  };
  // refMode: "player" | "player-origin" | "start" | "target-origin" | "target-dir" | "none"
  let ref = null;
  if (refMode === "player" && PLAYER_REF) ref = PLAYER_REF;
  else if (refMode === "player-origin" && PLAYER_REF) { try{ ref=new NodeURL(PLAYER_REF).origin+"/"; }catch{} }
  else if (refMode === "start") ref = startUrl;
  else if (refMode === "target-origin") { try{ ref=new NodeURL(forUrl).origin+"/"; }catch{} }
  else if (refMode === "target-dir") { try{ const u=new NodeURL(forUrl); u.pathname=u.pathname.replace(/\/[^/]*$/,"/"); ref=u.toString(); }catch{} }
  if (ref) {
    h["Referer"] = ref;
    try { h["Origin"] = new NodeURL(ref).origin; } catch {}
  } else if (refMode !== "none") {
    // по умолчанию стартовая
    h["Referer"] = startUrl;
    try { h["Origin"] = new NodeURL(startUrl).origin; } catch {}
  }
  return h;
}

async function http(url, { method="GET", profile=RAND, refMode="start" } = {}){
  const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(), REQUEST_TIMEOUT_MS);
  try{
    const headers = buildHeaders(url, profile, refMode);
    const cookie = JAR.getHeader(url);
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(url, { method, redirect:"follow", signal:ctrl.signal, headers });
    JAR.setFromResponse(url, res);
    return res;
  } finally { clearTimeout(t); }
}

/* --- HLS с расширенными fallback’ами --- */
async function probeHls(u){
  const inner = extractM3u8FromURL(u) || u;

  // Порядок рефереров + профилей
  const refModes = ["player","player-origin","start","target-origin","target-dir","none"];
  const profiles = [RAND, HLS_IOS];

  for (const profile of profiles) {
    for (const refMode of refModes) {
      try {
        const r = await http(inner, { method:"GET", profile, refMode });
        const final = extractM3u8FromURL(r.url) || r.url;
        const ct = (r.headers.get("content-type") || "").toLowerCase();
        if (!(isHlsCT(ct) || looksLikeHls(final))) { continue; }

        const text = await r.text();
        const isMaster = /#EXT-X-STREAM-INF/i.test(text);
        if (isMaster) {
          const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(l=>l && !l.startsWith("#"));
          await Promise.all(lines.map(async l=>{
            const child = abs(final, l);
            if (child && looksLikeHls(child) && !printed.has(child)) {
              // фиксируем «видимость» у CDN
              try { await http(child, { method:"HEAD", profile, refMode }); } catch {}
              printed.add(child);
              console.log(child);
            }
          }));
        } else {
          if (!printed.has(final) && looksLikeHls(final)) {
            try { await http(final, { method:"HEAD", profile, refMode }); } catch {}
            printed.add(final);
            console.log(final);
          }
        }
        return; // успех — прекращаем дальнейшие пробы
      } catch { /* пробуем следующее сочетание */ }
    }
  }
}

/* --- извлечение кандидатов из тела --- */
function extractCandidates(body, baseUrl){
  const out = new Set();

  // 1) явные https://...m3u8
  (body.match(/https?:\/\/[^\s"'<>]+?\.m3u8[^\s"'<>]*/gi) || []).forEach(u=>out.add(u));

  // 2) Playerjs: file:"..." (включая urlencoded)
  const reFile = /file\s*:\s*["']([^"']+)["']/ig; let m;
  while ((m = reFile.exec(body))) {
    const raw = decodeMaybe(m[1]);
    const url = /^https?:\/\//i.test(raw) ? raw : abs(baseUrl, raw);
    if (url && looksLikeHls(url)) out.add(url);
  }

  // 3) src="...m3u8"
  const reSrc = /src\s*=\s*["']([^"']+\.m3u8[^"']*)["']/ig;
  while ((m = reSrc.exec(body))) out.add(abs(baseUrl, decodeMaybe(m[1])));

  return Array.from(out).filter(Boolean);
}

/* --- BFS обход с параллельностью --- */
function enqueue(url, depth){
  if (depth > maxDepth) return;
  if (visited.has(url)) return;
  visited.add(url);
  queue.push({ url, depth });
}

async function crawlOne(url, depth){
  let res;
  try { res = await http(url, { method:"GET" }); } catch { return; }
  const ct = (res.headers.get("content-type") || "").toLowerCase();

  if (/playerjs\.html/i.test(res.url)) { PLAYER_REF = res.url; }

  const embedded = extractM3u8FromURL(res.url);
  if (embedded) { await probeHls(embedded); return; }

  if (isHlsCT(ct) || looksLikeHls(res.url)) { await probeHls(res.url); return; }

  if (!isHtml(ct) && !/javascript|json|text\/plain|css|octet-stream|^$/i.test(ct)) return;
  const body = await res.text();

  const cands = extractCandidates(body, res.url);
  await Promise.all(cands.map(u => probeHls(u)));

  if (isHtml(ct) || /text\/html|xhtml/i.test(ct)) {
    const nexts = [
      ...pick("iframe","src",body),
      ...pick("script","src",body),
      ...pick("source","src",body),
      ...pick("link","href",body).filter(href=>{
        const tagRe=new RegExp(`<link[^>]*href=["']${href.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}["'][^>]*>`,"i");
        const t=tagRe.exec(body); return t && /rel=["']?stylesheet/i.test(t[0]);
      }),
    ].map(s=>abs(res.url,s)).filter(Boolean);

    nexts.forEach(n => { if (/playerjs\.html/i.test(n)) PLAYER_REF = n; enqueue(n, depth+1); });
  }
}

async function worker(){
  while (queue.length) {
    const { url, depth } = queue.shift();
    await crawlOne(url, depth);
    await delay(REQ_DELAY);
  }
}

/* --- main --- */
(async () => {
  enqueue(startUrl, 0);
  await Promise.all(Array.from({length: CONCURRENCY}, () => worker()));
})();
