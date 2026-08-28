#!/usr/bin/env node
import fs from "node:fs";
import { chromium } from "playwright-core";
import { DEFAULT_ENDPOINT_FILE } from "./browser-runtime.js";

const endpointFile = DEFAULT_ENDPOINT_FILE;
let server = null;
let stopping = false;

async function cleanup(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  try { fs.rmSync(endpointFile, { force: true }); } catch {}
  if (server) {
    try { await server.close(); } catch {}
  }
  process.exit(exitCode);
}

async function main() {
  try { fs.rmSync(endpointFile, { force: true }); } catch {}
  server = await chromium.launchServer({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
    ],
  });
  const endpoint = server.wsEndpoint();
  fs.writeFileSync(endpointFile, `${endpoint}\n`, { mode: 0o600 });
  console.log("[browser-server] ready");
  setInterval(() => {}, 60_000);
}

process.on("SIGINT", () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));
process.on("uncaughtException", (error) => {
  console.error(`[browser-server] fatal: ${error?.message || error}`);
  cleanup(1);
});
process.on("unhandledRejection", (error) => {
  console.error(`[browser-server] fatal: ${error?.message || error}`);
  cleanup(1);
});

main().catch((error) => {
  console.error(`[browser-server] failed: ${error?.message || error}`);
  cleanup(1);
});
