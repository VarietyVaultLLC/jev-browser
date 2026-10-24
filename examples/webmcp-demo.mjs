#!/usr/bin/env node
// WebMCP demo: a planner page registers its own tools (add, complete, move, re-prioritise, list).
// Every step is a plain browser_do goal, as Claude would write it. Each round Jev sees the page's
// tools next to its buttons and picks: call a tool (filling its arguments from `values`, or from
// the schema's options for list and priority), or click when no tool fits (filters, "Clear completed").
// A bar along the bottom shows the current goal; the log on the right shows which `values` key
// Jev chose for each argument. Jev never writes text: "text: values.g1 → "milk"".
//
//   node examples/webmcp-demo.mjs                     # headed
//   JEV_BROWSER_HEADED=0 node examples/webmcp-demo.mjs
//   STEP_MS=800 node examples/webmcp-demo.mjs         # pause between steps, for watching
//   RECORD=webmcp.mp4 node examples/webmcp-demo.mjs   # record the page at 2x (needs ffmpeg)
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { JevBrowser } from "../src/index.mjs";

const STEP_MS = +(process.env.STEP_MS ?? 50);
const RECORD = process.env.RECORD;
const HEADED = process.env.JEV_BROWSER_HEADED !== "0" && !process.env.CI;
const VIEW = { width: 1280, height: 800 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PAGE = readFileSync(new URL("./webmcp-planner.html", import.meta.url), "utf8");

const STEPS = [
  ["Add every grocery item to the groceries list", { g1: "milk", g2: "eggs", g3: "sourdough bread", g4: "coffee beans", g5: "apples", g6: "basmati rice" }],
  ["Add the errands to the errands list; picking up the prescription is high priority", { e1: "pick up prescription", e2: "return library books", e3: "post the package" }],
  ["Add 'prepare Q3 report' to the work list as high priority", { task: "prepare Q3 report" }],
  ["Add 'book dentist appointment' to the errands list as low priority", { task: "book dentist appointment" }],
  ["Mark eggs, coffee beans and the library books errand as done", { a: "eggs", b: "coffee beans", c: "return library books" }],
  ["Move 'post the package' to the work list", { item: "post the package" }],
  ["Make 'apples' high priority", { item: "apples" }],
  ["Clear the completed items", {}],
  ["Show only the high priority items", {}],
];
const CHECK = "Does the planner show only high-priority items, and are 'pick up prescription', 'prepare Q3 report' and 'apples' among them?";

// Caption bar, as in the checkout demo. It hangs off <html>, outside <body>, and ignores the pointer,
// so Jev never reads or hits it.
const CAPTION = ({ html, tone }) => {
  document.querySelector("[data-jev-caption]")?.remove();
  const bar = document.createElement("div");
  bar.setAttribute("data-jev-overlay", ""); bar.setAttribute("data-jev-caption", "");
  const bg = { run: "#1f2937", pass: "#15803d", fail: "#b91c1c", pause: "#b45309" }[tone] ?? "#1f2937";
  Object.assign(bar.style, { position: "fixed", left: "0", right: "0", bottom: "0", zIndex: 2147483646, pointerEvents: "none",
    background: bg, color: "#fff", font: "500 15px/1.35 system-ui, sans-serif", padding: "10px 16px", boxShadow: "0 -2px 10px rgba(0,0,0,.25)" });
  bar.innerHTML = html;
  document.documentElement.appendChild(bar);
};
const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

// Records the page through Chrome's screencast (frames arrive when something changes), then
// encodes them at their real timing. Clean 2x frames, no window chrome.
async function startRecording(page) {
  const dir = mkdtempSync(join(tmpdir(), "jev-rec-"));
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    const f = join(dir, `f${String(frames.length).padStart(5, "0")}.jpg`);
    writeFileSync(f, Buffer.from(data, "base64")); frames.push({ f, t: metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: VIEW.width * 2, maxHeight: VIEW.height * 2 });
  return async (out, holdS = 2.5) => {
    await cdp.send("Page.stopScreencast").catch(() => {});
    const list = frames.map((fr, i) => `file '${fr.f}'\nduration ${((frames[i + 1]?.t ?? fr.t + holdS) - fr.t).toFixed(3)}`);
    writeFileSync(join(dir, "list.txt"), `${list.join("\n")}\nfile '${frames.at(-1).f}'\n`);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"),
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-r", "30", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-tune", "stillimage",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
    rmSync(dir, { recursive: true, force: true });
    return frames.length;
  };
}

const http = createServer((_, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(PAGE); });
await new Promise(r => http.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${http.address().port}/`;

const browser = await chromium.launch({ headless: !HEADED });
const b = new JevBrowser(browser, await browser.newContext({ viewport: VIEW, deviceScaleFactor: RECORD ? 2 : 1 }), true);
b.page = await b.context.newPage();
b.highlight = true;   // red label on the element Jev clicks
// Tell the page where Jev took each argument from, so its log can show "text: values.g1 → "milk"".
const act = b.act.bind(b);
b.act = async a => {
  if (a.tool === "webmcp") await b.page.evaluate(k => { window.__jevArgKeys = k; }, a.argKeys ?? null).catch(() => {});
  return act(a);
};
const caption = (html, tone = "run") => b.page.evaluate(CAPTION, { html, tone }).catch(() => {});

const t0 = Date.now();
let tools = 0, clicks = 0, jevCalls = 0, failed = 0, stop;
try {
  await b.open(url);
  const pageTools = (await b.webmcpTools()).map(t => t.name);
  console.log(`page tools: ${pageTools.join(", ")}\n`);
  if (RECORD) stop = await startRecording(b.page);
  await caption(`WebMCP planner · the page registers <b>${pageTools.join(", ")}</b> · ${STEPS.length} goals for Jev`);
  await sleep(Math.max(STEP_MS, 400) * 2);
  for (const [i, [goal, values]] of STEPS.entries()) {
    await caption(`step ${i + 1}/${STEPS.length} · ${esc(goal)}`);
    const r = await b.do(goal, { values, maxActions: 12 });
    tools += r.actions.filter(a => a.action === "webmcp").length;
    clicks += r.actions.filter(a => a.action === "click").length;
    jevCalls += r.jev_calls;
    if (r.status !== "done") { failed++; await caption(`step ${i + 1}/${STEPS.length} · ${esc(goal)} → <b>${esc(r.status)}</b>`, "fail"); }
    console.log(`${r.status === "done" ? "✔" : "✖"} ${goal}  [${r.status}, ${(r.ms / 1000).toFixed(1)} s, ${r.jev_calls} Jev calls]`);
    for (const a of r.actions) console.log(`    ${a.action === "webmcp" ? a.element : `${a.action} ${a.element}`}${a.args ? " " + JSON.stringify(a.args) : ""}${a.error ? `  ! ${a.error}` : ""}`);
    await sleep(STEP_MS);
  }
  const p = await b.check(CHECK);
  jevCalls++;
  if (p < 0.6) failed++;
  console.log(`${p >= 0.6 ? "✔" : "✖"} check: ${CHECK}  p_yes ${p.toFixed(2)}`);
  // ground truth from the page's own data, not Jev's opinion
  const final = await b.page.evaluate(() => items);
  const want = {
    groceries: ["milk", "sourdough bread", "apples", "basmati rice"], errands: ["pick up prescription", "book dentist appointment"], work: ["prepare Q3 report", "post the package"],
  };
  const pri = { "pick up prescription": "high", "prepare Q3 report": "high", apples: "high", "book dentist appointment": "low" };
  const problems = [];
  for (const [list, names] of Object.entries(want)) {
    const got = final.filter(i => i.list === list).map(i => i.text).sort();
    if (JSON.stringify(got) !== JSON.stringify([...names].sort())) problems.push(`${list}: ${got.join(", ")}`);
  }
  for (const i of final) if ((pri[i.text] ?? "normal") !== i.priority) problems.push(`${i.text} is ${i.priority}`);
  if (final.some(i => i.done)) problems.push("completed items were not cleared");
  if (problems.length) failed++;
  console.log(`${problems.length ? "✖" : "✔"} page data: ${problems.length ? problems.join("; ") : `${final.length} items, every list, priority and completion as asked`}`);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const summary = `${STEPS.length} goals · ${tools} tool calls + ${clicks} clicks · ${jevCalls} Jev calls · ${secs} s`;
  await caption(failed ? `<b>failed</b> · ${failed} problem${failed > 1 ? "s" : ""} · ${summary}` : `<b>passed</b> · ${summary}`, failed ? "fail" : "pass");
  console.log(`\n${failed ? "FAILED" : "passed"}: ${STEPS.length} goals, ${tools} tool calls + ${clicks} clicks chosen by Jev, ${jevCalls} Jev calls, ${secs} s`);
  await sleep(Math.max(STEP_MS, 1500));
  if (stop) console.log(`recorded ${await stop(RECORD)} frames to ${RECORD}`);
  if (failed) process.exitCode = 1;
} finally {
  await b.close(); http.close();
}
