// Offline tests: open() resizes the window and the size sticks for later pages and new tabs. No Jev calls.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { JevBrowser, parseViewport } from "../src/session.mjs";

const PAGES = {
  "/": `<!doctype html><meta name="viewport" content="width=device-width"><title>Size</title>
    <style>#m { display: none } @media (max-width: 600px) { #m { display: block } #d { display: none } }</style>
    <p id="m">phone layout</p><p id="d">desktop layout</p><a href="/" target="_blank">tab</a>`,
  "/fullscreen": `<!doctype html><button onclick="document.documentElement.requestFullscreen()">Full screen</button>`,
  "/player": `<!doctype html><iframe src="/fullscreen" allow="fullscreen"></iframe>`,
};

let server, base, browser, b;
before(async () => {
  server = createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(PAGES[req.url] ?? ""); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  b = await JevBrowser.launch({ browser });
});
after(async () => { await b.close(); await browser.close(); server.close(); });

const width = () => b.page.evaluate(() => innerWidth);

test("parseViewport reads WIDTHxHEIGHT and rejects the rest", () => {
  assert.deepEqual(parseViewport("390x844"), { width: 390, height: 844 });
  assert.deepEqual(parseViewport("1024x768"), { width: 1024, height: 768 });
  for (const bad of ["", "390", "390x", "x844", "390*844", "-390x844", " 390x844", "390X844", undefined]) assert.throws(() => parseViewport(bad), /390x844/);
});

test("default size is 1280x800 and shows the desktop layout", async () => {
  await b.open(base);
  assert.equal(await width(), 1280);
  assert.match((await b.snapshot()).text, /desktop layout/);
});

test("open with a viewport switches to the phone layout and keeps the size", async () => {
  await b.open(base, { viewport: "390x844" });
  assert.deepEqual(b.page.viewportSize(), { width: 390, height: 844 });
  assert.equal(await width(), 390);
  const text = (await b.snapshot()).text;
  assert.match(text, /phone layout/);
  assert.doesNotMatch(text, /desktop layout/);
  await b.open(base);
  assert.equal(await width(), 390, "a later open without viewport keeps the size");
});

test("a new tab gets the same size", async () => {
  await b.open(base, { viewport: { width: 414, height: 896 } });
  const tab = b.context.waitForEvent("page");
  await b.page.click("a");
  const p = await tab;
  await p.waitForLoadState();
  await p.waitForFunction(() => innerWidth === 414);
  assert.deepEqual(p.viewportSize(), { width: 414, height: 896 });
});

test("a tab opened earlier is resized too, so switching back to it keeps the size", async () => {
  const other = b.context.pages().find(p => p !== b.page);
  await other.setViewportSize({ width: 800, height: 600 });
  await b.open(base, { viewport: "500x700" });
  for (const p of b.context.pages()) assert.deepEqual(p.viewportSize(), { width: 500, height: 700 });
});

test("a page that went fullscreen (its own button or a video player's iframe) is still resized", async () => {
  for (const [path, button] of [["/fullscreen", p => p.locator("button")], ["/player", p => p.frameLocator("iframe").locator("button")]]) {
    for (const wait of [false, true]) {   // right after the click, and once the page reports fullscreen
      await b.open(base + path);
      await button(b.page).click();
      if (wait) await b.page.waitForFunction(() => !!document.fullscreenElement);
      await b.open(base, { viewport: "360x640" });
      assert.equal(await width(), 360, `${path}, wait=${wait}`);
      assert.equal(await b.page.evaluate(() => document.fullscreenElement), null, `${path}, wait=${wait}`);
    }
  }
});

test("a malformed viewport fails before navigating", async () => {
  await b.open(`${base}/`);
  await assert.rejects(b.open("about:blank", { viewport: "wide" }), /390x844/);
  assert.equal(b.page.url(), `${base}/`);
});
