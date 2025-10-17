#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractM3U8Candidates } from "./universal-playwright-extractor.js";
import { extractCinemaCandidates } from "./cinema-hls-extractor.js";
import { extractProSportsCandidates } from "./pro-sports-extractor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fixtures = [
  {
    name: "smotru-basic",
    extractor: extractM3U8Candidates,
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
    extractor: extractM3U8Candidates,
    file: "fixtures/smotru-inline-script.html",
    baseUrl: "https://smotru.example.com/embed/456",
    expected: [
      "https://edge.example.org/channel/playlist.m3u8?token=xyz",
      "https://edge.example.org/channel/low/index.m3u8",
    ],
  },
  {
    name: "cinema-hls-player",
    extractor: extractCinemaCandidates,
    file: "fixtures/cinema-hls-player.html",
    baseUrl: "https://cinema.example/watch",
    expected: [
      "https://backup.cinema.example/live/cinema_hd_backup.m3u8",
      "https://cdn-alt.cinema.example/hls/cinema_hd/playlist.m3u8?token=secure",
      "https://edge.cinema.example/live/cinema_hd/index.m3u8",
      "https://edge.cinema.example/live/cinema_hd/master.m3u8",
      "https://edge.cinema.example/live/cinema_hd/720p.m3u8",
      "https://edge.cinema.example/live/cinema_sd.m3u8",
      "https://mirror-1.cinema.example/live/cinema_hd/index.m3u8",
      "https://mirror-2.cinema.example/live/cinema_hd/index.m3u8",
    ],
  },
  {
    name: "pro-sports-match-futbol-3",
    extractor: extractProSportsCandidates,
    file: "fixtures/view-source_https___pro-sports.live_match-futbol-3.html",
    baseUrl: "https://pro-sports.live/match-futbol-3.html",
    expected: [
      "https://backup1.pro-sports.example/hls/match-futbol-3_backup.m3u8",
      "https://edge-alt.pro-sports.example/live/match-futbol-3_alt.m3u8",
      "https://mirror-cdn.pro-sports.example/edge/match-futbol-3/index.m3u8",
      "https://play-cdn.pro-sports.example/edge/match-futbol-3/master.m3u8",
      "https://play1.pro-sports.example/linear/match-futbol-3/playlist.m3u8",
      "https://play2.pro-sports.example/live/match-futbol-3_sd.m3u8",
      "https://secure-token.pro-sports.example/live/match-futbol-3_token.m3u8?token=secure-example",
    ],
  },
];

async function run() {
  let failures = 0;
  for (const fixture of fixtures) {
    const htmlPath = path.join(__dirname, fixture.file);
    const html = await readFile(htmlPath, "utf8");
    const extractor = fixture.extractor ?? extractM3U8Candidates;
    const result = extractor(html, fixture.baseUrl).sort();
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
