import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BLACKLIST,
  extractFirstCdnFromHtml,
  isBlacklisted,
  processChannel,
} from "../../cdnsearch.js";

const EXAMPLE_ORIGIN = "https://example.com/";

describe("cdnsearch utilities", () => {
  it("marks configured domains as blacklisted", () => {
    for (const domain of BLACKLIST) {
      assert.equal(isBlacklisted(domain), true, `Domain ${domain} should be blocked`);
      assert.equal(
        isBlacklisted(`cdn.${domain}`),
        true,
        `Subdomain of ${domain} should be blocked`,
      );
    }
    assert.equal(isBlacklisted("allowed.example"), false);
  });

  it("extracts the first usable CDN iframe", () => {
    const html = `
      <iframe src="https://programma-peredach.com/embed"></iframe>
      <iframe src="/player"></iframe>
      <iframe src="https://cdn.example.com/video"></iframe>
    `;
    const result = extractFirstCdnFromHtml(html, `${EXAMPLE_ORIGIN}page`);
    assert.equal(result, `${EXAMPLE_ORIGIN}player`);
  });

  it("updates channel entries with discovered CDN URLs", async () => {
    const channel = { url: `${EXAMPLE_ORIGIN}stream` };
    const response = await processChannel(
      "demo",
      channel,
      EXAMPLE_ORIGIN,
      {
        fetcher: async () => "<iframe src=\"/hls/master.m3u8\"></iframe>",
      },
    );
    assert.equal(response.updated, true);
    assert.equal(channel.cdn, `${EXAMPLE_ORIGIN}hls/master.m3u8`);
  });

  it("skips channels hosted on a different origin", async () => {
    const channel = { url: "https://other.example/stream" };
    const response = await processChannel("remote", channel, EXAMPLE_ORIGIN);
    assert.equal(response.updated, false);
    assert.equal(response.reason, "skip-other-origin");
  });
});
