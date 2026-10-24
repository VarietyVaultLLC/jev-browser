// Offline tests for JEV_BROWSER: how the setting maps onto Playwright's launch options, and that a
// browser that isn't there fails with a message naming the setting (not the Chromium install hint).
import { test } from "node:test";
import assert from "node:assert/strict";
import { JevBrowser, browserOptions } from "../src/session.mjs";

test("browserOptions: empty or chromium keeps Playwright's Chromium", () => {
  for (const v of [undefined, "", "  ", "chromium"]) assert.deepEqual(browserOptions(v), {});
});

test("browserOptions: a name is a channel, a path is an executable", () => {
  assert.deepEqual(browserOptions("chrome"), { channel: "chrome" });
  assert.deepEqual(browserOptions(" msedge "), { channel: "msedge" });
  assert.deepEqual(browserOptions("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
    { executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" });
  assert.deepEqual(browserOptions("C:\\Program Files\\BraveSoftware\\brave.exe"), { executablePath: "C:\\Program Files\\BraveSoftware\\brave.exe" });
});

test("launch: a missing executable names JEV_BROWSER", async () => {
  await assert.rejects(JevBrowser.launch({ use: "/nonexistent/jev-browser-test/chrome" }), /JEV_BROWSER\) was not found/);
});
