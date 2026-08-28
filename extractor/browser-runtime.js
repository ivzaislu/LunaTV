import fs from "node:fs";
import { chromium } from "playwright-core";

export const DEFAULT_ENDPOINT_FILE =
  process.env.PLAYWRIGHT_WS_ENDPOINT_FILE || "/tmp/lunatv-playwright-ws";

function readEndpoint() {
  const direct = String(process.env.PLAYWRIGHT_WS_ENDPOINT || "").trim();
  if (direct) return direct;
  try {
    return fs.readFileSync(DEFAULT_ENDPOINT_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

export async function acquireChromium(launchOptions = {}) {
  const endpoint = readEndpoint();
  if (endpoint) {
    try {
      const browser = await chromium.connect(endpoint, { timeout: 700 });
      return { browser, shared: true };
    } catch (error) {
      console.warn(`[browser-runtime] shared browser unavailable: ${error?.message || error}`);
    }
  }

  const browser = await chromium.launch(launchOptions);
  return { browser, shared: false };
}

export async function releaseChromium(browser, shared) {
  if (!browser || shared) return;
  try { await browser.close(); } catch {}
}
