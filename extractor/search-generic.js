// node extractor/search-generic.js <startUrl> <timeoutSec>
const scheme = (x.protocol||'http:').toLowerCase();
const host = (x.hostname||'').toLowerCase();
if(!host) return u;
let netloc = host;
const p = x.port?parseInt(x.port,10):null;
if(p && !((scheme==='http:'&&p===80)||(scheme==='https:'&&p===443))) netloc=`${host}:${p}`;
let path=(x.pathname||'/').replace(/\/+/, '/').replace(/\/$/, '');
if(!path) path='/';
return `${scheme}//${netloc}${path}${x.search||''}`;
}catch{return u}
}


async function fetchHtml(url, t=15000){
const ctrl = new AbortController();
const id = setTimeout(()=>ctrl.abort(), t);
try{
const res = await fetch(url,{headers:{'User-Agent':USER_AGENT,Accept:'text/html,*/*'},redirect:'follow',signal:ctrl.signal});
if(!res.ok) throw new Error('HTTP '+res.status);
return await res.text();
}finally{ clearTimeout(id); }
}


function compileFromEnv(){
// Позволяет передать правила из Python через env, иначе берём дефолт
const allow = process.env.SEARCH_ALLOW_RE ? JSON.parse(process.env.SEARCH_ALLOW_RE) : [];
const deny = process.env.SEARCH_DENY_RE ? JSON.parse(process.env.SEARCH_DENY_RE) : [];
const atext = process.env.SEARCH_ATEXT_RE ? JSON.parse(process.env.SEARCH_ATEXT_RE) : [];
return { allows: allow.map(r=>new RegExp(r)), denys: deny.map(r=>new RegExp(r)), atext: atext.map(r=>new RegExp(r)) };
}


function accept(href, txt, {allows,denys,atext}){
if(!href) return false;
if(href.startsWith('javascript:')||href.startsWith('mailto:')||href.startsWith('#')) return false;
if(allows.length && !allows.some(r=>r.test(href))) return false;
if(denys.length && denys.some(r=>r.test(href))) return false;
if(txt && atext.length && atext.some(r=>r.test(txt))) return false;
return true;
}


(async function(){
const startUrl = process.argv[2];
const timeout = parseInt(process.argv[3]||'10',10)*1000;
if(!startUrl){
console.error('Usage: node extractor/search-generic.js <startUrl> <timeoutSec>');
process.stdout.write('[]');
process.exit(2);
}
const pat = compileFromEnv();
let html='';
try{ html = await fetchHtml(startUrl, timeout); }
catch(e){ console.error('fetch error:', e?.message||e); process.stdout.write('[]'); return; }
const $ = cheerio.load(html);
const base = new URL(startUrl).origin;
const seen = new Set();
const out = [];
$('a[href]').each((_,a)=>{
const raw = ($(a).attr('href')||'').trim();
if(!raw) return;
let abs; try{ abs = new URL(raw, raw.startsWith('/')?base:startUrl).toString(); }catch{ return; }
if(!/^https?:\/\//i.test(abs)) return;
const norm = normalize(abs);
const txt = $(a).text().trim();
if(!accept(norm, txt, pat)) return;
if(seen.has(norm)) return; seen.add(norm);
out.push(norm);
});
process.stdout.write(JSON.stringify(out));
})();