#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractM3U8Candidates } from "./smotru-m3u-one-stealth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fixtures = [
  {
    name: "smotru-basic",
    file: "fixtures/smotru-basic.html",
    baseUrl: "https://smotru.example.com/watch/123",
    expected: [
      "https://smotru.example.com/hls/stream_hd.m3u8",
      "https://cdn.example.com/live/main/index.m3u8",
      "https://backup.example.net/hls/backup.m3u8",
    ],
  },
  {
    name: "smotru-inline-script",
    file: "fixtures/smotru-inline-script.html",
    baseUrl: "https://smotru.example.com/embed/456",
    expected: [
      "https://edge.example.org/channel/playlist.m3u8?token=xyz",
      "https://edge.example.org/channel/low/index.m3u8",
    ],
  },
];

async function run() {
  let failures = 0;
  for (const fixture of fixtures) {
    const htmlPath = path.join(__dirname, fixture.file);
    const html = await readFile(htmlPath, "utf8");
    const result = extractM3U8Candidates(html, fixture.baseUrl).sort();
    const expected = [...fixture.expected].sort();
    try {
      assert.deepEqual(result, expected);
      console.log(`✔ ${fixture.name}: найдено ${result.length} поток(ов)`);
    } catch (err) {
      failures += 1;
      console.error(`✖ ${fixture.name}:`, err.message || err);
      console.error("  expected:", expected);
      console.error("  received:", result);
    }
  }

  if (failures > 0) {
    console.error(`\n[extractor-tests] Не пройдено фикстур: ${failures}`);
    process.exit(1);
  }

  console.log("\n[extractor-tests] Все фикстуры успешно обработаны");
}

run().catch((err) => {
  console.error("[extractor-tests] Ошибка выполнения:", err?.stack || err);
  process.exit(1);
});
