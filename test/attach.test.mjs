// Attaching to a browser the user is already running (JEV_BROWSER_CDP), including the everyday profile through the
// browser's own remote-debugging switch (edge://inspect/#remote-debugging, Chromium 144+). Offline: the "user's
// browser" is a Playwright Chromium on a temp profile with a debug port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { JevBrowser, cdpEndpoint } from "../src/session.mjs";

const PORT_FILE = "9222\n/devtools/browser/abc-123\n";
const doc = t => `data:text/html,<title>${t}</title><p>${t}</p>`;
const until = async (ok, ms = 5000) => { const t0 = Date.now(); while (!(await ok())) { if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise(r => setTimeout(r, 50)); } };

test("cdpEndpoint: a URL passes through and nothing stays nothing", () => {
  for (const u of ["http://127.0.0.1:9222", "ws://127.0.0.1:9222/devtools/browser/x", "HTTPS://host:1"]) assert.equal(cdpEndpoint(u), u);
  assert.equal(cdpEndpoint(undefined), undefined);
  assert.equal(cdpEndpoint(""), undefined);
});

test("cdpEndpoint: edge and chrome mean the everyday profile's own debugging endpoint", () => {
  const env = { LOCALAPPDATA: "L" }, seen = [];
  const read = f => { seen.push(f); return PORT_FILE; };
  assert.equal(cdpEndpoint("edge", { env, read }), "ws://127.0.0.1:9222/devtools/browser/abc-123");
  assert.equal(cdpEndpoint(" MSEdge ", { env, read }), "ws://127.0.0.1:9222/devtools/browser/abc-123");
  assert.equal(cdpEndpoint("chrome", { env, read }), "ws://127.0.0.1:9222/devtools/browser/abc-123");
  assert.deepEqual(seen, [join("L", "Microsoft", "Edge", "User Data", "DevToolsActivePort"), join("L", "Microsoft", "Edge", "User Data", "DevToolsActivePort"),
    join("L", "Google", "Chrome", "User Data", "DevToolsActivePort")]);
});

test("cdpEndpoint: anything else is a profile directory", () => {
  const seen = [];
  assert.equal(cdpEndpoint("/home/me/.config/microsoft-edge", { env: {}, read: f => { seen.push(f); return PORT_FILE; } }), "ws://127.0.0.1:9222/devtools/browser/abc-123");
  assert.deepEqual(seen, [join("/home/me/.config/microsoft-edge", "DevToolsActivePort")]);
});

test("cdpEndpoint: no port file, or a broken one, says how to switch remote debugging on", () => {
  const gone = () => { throw new Error("ENOENT"); };
  assert.throws(() => cdpEndpoint("edge", { env: { LOCALAPPDATA: "L" }, read: gone }), /inspect\/#remote-debugging.*JEV_BROWSER_CDP=edge/s);
  assert.throws(() => cdpEndpoint("edge", { env: { LOCALAPPDATA: "L" }, read: () => "not a port file" }), /inspect\/#remote-debugging/);
  assert.throws(() => cdpEndpoint("edge", { env: {}, read: () => PORT_FILE }), /profile directory/);   // no LOCALAPPDATA: not Windows
});

async function usersBrowser(t) {
  const dir = mkdtempSync(join(tmpdir(), "jev-attach-"));
  const theirs = await chromium.launchPersistentContext(dir, { args: ["--remote-debugging-port=0"] });
  t.after(async () => { await theirs.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });
  await until(() => existsSync(join(dir, "DevToolsActivePort")));
  const tab = theirs.pages()[0] ?? await theirs.newPage();
  await tab.goto(doc("theirs"));
  return { dir, theirs, tab };
}
const titles = ctx => Promise.all(ctx.pages().map(p => p.title()));

test("attached: works in a tab of its own and never drives, follows or resizes the user's tabs", async t => {
  const { dir, theirs, tab } = await usersBrowser(t);
  const b = await JevBrowser.launch({ cdpUrl: dir });
  t.after(() => b.close());
  await b.open(doc("ours"));
  assert.deepEqual(await titles(theirs), ["theirs", "ours"]);            // their tab was not navigated

  const later = await theirs.newPage();                                   // the user opens a tab while we are attached
  await later.goto(doc("later"));
  await new Promise(r => setTimeout(r, 300));
  assert.equal(await b.page.title(), "ours");                             // not followed
  assert.equal(await later.evaluate(() => typeof window.__jevMut), "undefined");   // and nothing injected into it

  const width = await tab.evaluate(() => innerWidth);
  await b.open(doc("ours"), { viewport: "390x844" });
  assert.equal(await b.page.evaluate(() => innerWidth), 390);
  assert.equal(await tab.evaluate(() => innerWidth), width);              // only our tab is resized

  const first = b.page;
  await first.evaluate(() => { window.open("about:blank"); });            // a tab our own page opens is ours
  await until(() => b.page !== first);
  assert.equal(await b.page.opener(), first);
  assert.equal(theirs.pages().length, 4);
  await b.page.close();                                                   // falls back to our other tab, never to theirs
  await until(() => b.page === first);

  await b.close();
  assert.deepEqual(await titles(theirs), ["theirs", "later"]);            // our tabs are gone, theirs are untouched
  assert.equal(await tab.evaluate(() => 1 + 1), 2);                       // and the browser is still running
});

test("attached: when its only tab was closed, the next open() makes a new tab instead of taking one", async t => {
  const { dir, theirs } = await usersBrowser(t);
  const b = await JevBrowser.launch({ cdpUrl: dir });
  t.after(() => b.close());
  await b.open(doc("ours"));
  await b.page.close();
  await b.open(doc("again"));
  assert.deepEqual(await titles(theirs), ["theirs", "again"]);
});

test("attached: a browser that is not listening fails with a message that says what to do", async () => {
  await assert.rejects(JevBrowser.launch({ cdpUrl: "ws://127.0.0.1:1/devtools/browser/none" }), /JEV_BROWSER_CDP.*(not running|remote debugging)/s);
});
