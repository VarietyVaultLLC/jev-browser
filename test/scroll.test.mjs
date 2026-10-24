// Offline tests: the scroll action scrolls the page's main scrollable area (or the box around a given
// element), wherever the mouse is, and returns once the scroll has landed. No Jev calls.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { JevBrowser } from "../src/session.mjs";

const lines = n => Array.from({ length: n }, (_, i) => `<p>line ${i}</p>`).join("");
const PAGES = {
  // an app-like layout: the document doesn't scroll, an inner column does (a menu next to it)
  "/column": `<!doctype html><style>html, body { margin: 0; height: 100% } .frame { height: 100vh; display: flex; overflow: hidden }
    nav { width: 30% } .content { flex: 1; overflow-y: auto }</style>
    <div class="frame"><nav><a href="#">menu</a></nav><div class="content">${lines(200)}</div></div>`,
  // a plain long document with a small scrollable box in it
  "/document": `<!doctype html><style>body { margin: 0 } #box { height: 120px; overflow-y: auto; border: 1px solid }</style>
    <div id="box">${lines(40)}<button id="deep">deep</button></div>${lines(300)}`,
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

const top = sel => b.page.evaluate(s => s ? document.querySelector(s).scrollTop : scrollY, sel);

test("an inner column is scrolled although the mouse was never over it", async () => {
  await b.open(`${base}/column`);   // fresh page: the mouse is at (0, 0), over the menu
  const r = await b.actOn({ action: "scroll" });
  const moved = await top(".content");
  assert.ok(moved > 0, "the column moved");
  assert.equal(r.scrolled, moved, "the reply carries the distance, read after the scroll landed");
  assert.equal(await top(), 0, "the document itself doesn't scroll");
});

test("a scroll step is shorter than the visible area, so no line is skipped", async () => {
  await b.open(`${base}/column`);
  const height = await b.page.evaluate(() => document.querySelector(".content").clientHeight);
  const r = await b.actOn({ action: "scroll" });
  assert.ok(r.scrolled < height, `${r.scrolled} < ${height}`);
  assert.ok(r.scrolled >= height * 0.5, `${r.scrolled} >= half of ${height}`);
});

test("up scrolls back, and nothing left to scroll says so", async () => {
  await b.open(`${base}/column`);
  await b.actOn({ action: "scroll" });
  const down = await top(".content");
  const r = await b.actOn({ action: "scroll", value: "up" });
  assert.equal(r.scrolled, -down);
  assert.equal(await top(".content"), 0);
  const again = await b.actOn({ action: "scroll", value: "up" });
  assert.equal(again.scrolled, 0);
  assert.match(again.info, /nothing moved/);
});

test("a plain page scrolls the document, not a small box in it", async () => {
  await b.open(`${base}/document`);
  const r = await b.actOn({ action: "scroll" });
  assert.ok(await top() > 0);
  assert.equal(await top("#box"), 0);
  assert.equal(r.scrolled, await top());
});

test("with an element, the box that contains it is scrolled", async () => {
  await b.open(`${base}/document`);
  const page = await b.snapshot(); b.shown = page;
  const deep = page.elements.find(e => /deep/.test(e.text ?? e.label ?? ""));
  assert.ok(deep, "the button inside the box is listed");
  const r = await b.actOn({ action: "scroll", element: deep.i });
  assert.ok(await top("#box") > 0, "the box moved");
  assert.equal(await top(), 0, "the document didn't");
  assert.equal(r.scrolled, await top("#box"));
});

test("a scroll value other than up/down is rejected", async () => {
  await b.open(`${base}/column`);
  await assert.rejects(b.actOn({ action: "scroll", value: "sideways" }), /up.*down/);
});
