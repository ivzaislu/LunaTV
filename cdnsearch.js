// update-channels-cdn.js
import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// --- настройки ---
const BLACKLIST = ["programma-peredach.com"]; // игнорируемые домены
const TIMEOUT_MS = 20000;

// --- утилиты ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const normalizeHost = (h) => h.replace(/^www\./i, "").toLowerCase();
const isBlacklisted = (host) => {
  const h = normalizeHost(host);
  return BLACKLIST.some((d) => h === d || h.endsWith("." + d));
};

function loadJson(filePath) {
  const txt = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(txt);
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

async function fetchHtml(url) {
  const res = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: TIMEOUT_MS,
    maxRedirects: 5,
  });
  return res.data;
}

function extractFirstCdnFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  const found = [];

  $("iframe").each((i, el) => {
    const raw = $(el).attr("src");
    if (!raw) return;

    // пропускаем data:, blob:, javascript:, и т.п.
    if (!/^https?:/i.test(raw) && !/^[/.]/.test(raw)) return;

    try {
      const abs = new URL(raw, pageUrl).toString();
      const host = new URL(abs).hostname;
      if (isBlacklisted(host)) {
        console.log(`  ⏭️  Игнорируем iframe #${i + 1} (черный список): ${abs}`);
        return;
      }
      found.push(abs);
      console.log(`  ✅ Найден iframe #${i + 1}: ${abs}`);
    } catch {
      // некорректная ссылка — пропускаем
    }
  });

  // вернём первый подходящий
  return found[0] || null;
}

async function processChannel(key, channelObj, baseOrigin) {
  const pageUrl = channelObj?.url;
  if (!pageUrl || typeof pageUrl !== "string") return { updated: false, reason: "no-url" };

  if (!pageUrl.startsWith(baseOrigin)) return { updated: false, reason: "skip-other-origin" };

  // не обрабатываем, если уже есть cdn
  if (channelObj.cdn) return { updated: false, reason: "already-has-cdn" };

  console.log(`→ Обработка [${key}] ${pageUrl}`);
  try {
    const html = await fetchHtml(pageUrl);
    const cdn = extractFirstCdnFromHtml(html, pageUrl);
    if (!cdn) {
      console.log("  ⚠️  На странице не найден подходящий iframe.");
      return { updated: false, reason: "no-iframe" };
    }
    channelObj.cdn = cdn; // добавляем поле cdn
    console.log(`  💾 Присвоен cdn: ${cdn}`);
    return { updated: true };
  } catch (e) {
    console.log(`  ❌ Ошибка: ${e.message}`);
    return { updated: false, reason: "error", error: e.message };
  }
}

// --- main ---
async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Использование: node update-channels-cdn.js <base-origin>");
    console.log('Пример:     node update-channels-cdn.js "http://oneliketv.net/"');
    process.exit(1);
  }

  const baseOriginArg = args[0];
  let baseOrigin;
  try {
    // гарантируем слэш на конце origin
    const u = new URL(baseOriginArg);
    baseOrigin = u.origin + "/";
  } catch {
    console.error("Неверный base-origin. Укажите что-то вроде: http://oneliketv.net/");
    process.exit(1);
  }

  const configDir = path.join(__dirname, "config");
  const channelsPath = path.join(configDir, "channels.json");
  if (!fs.existsSync(channelsPath)) {
    console.error(`Файл не найден: ${channelsPath}`);
    process.exit(1);
  }

  const channels = loadJson(channelsPath);

  // делаем бэкап
  const backupPath = path.join(configDir, "channels.json.bak");
  fs.copyFileSync(channelsPath, backupPath);
  console.log(`🗂  Бэкап создан: ${backupPath}`);

  let total = 0;
  let updated = 0;

  for (const [key, obj] of Object.entries(channels)) {
    total++;
    const res = await processChannel(key, obj, baseOrigin);
    if (res.updated) updated++;
  }

  saveJson(channelsPath, channels);
  console.log(`\n✅ Готово. Обработано: ${total}, обновлено: ${updated}. Файл сохранён: ${channelsPath}`);
}

main();
