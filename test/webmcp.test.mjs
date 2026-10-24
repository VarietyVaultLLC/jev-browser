// Offline tests: WebMCP tools registered by a local fixture page are listed and called. No Jev calls.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { JevBrowser } from "../src/session.mjs";
import { webmcpText } from "../src/webmcp.mjs";

const PAGES = {
  "/current": `<!doctype html><title>Current API</title><p id="out">empty</p><script>
    const ac = new AbortController();
    document.modelContext.registerTool({
      name: "add_todo", description: "Add a todo item",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      annotations: { readOnlyHint: false },
      async execute({ text }) { document.getElementById("out").textContent = text; return { content: [{ type: "text", text: "added " + text }] }; },
    });
    document.modelContext.registerTool({ name: "temp", description: "gone soon", execute: () => 1 }, { signal: ac.signal });
    ac.abort();
    document.modelContext.registerTool({ name: "boom", description: "throws", execute() { throw new Error("nope"); } });
    document.modelContext.registerTool({ name: "hang", description: "never returns", execute: () => new Promise(() => {}) });
  </script>`,
  "/legacy": `<!doctype html><title>Legacy API</title><script>
    navigator.modelContext.provideContext({ tools: [
      { name: "search", description: "Search the catalog", inputSchema: { type: "object", properties: { q: { type: "string" } } }, execute: ({ q }) => ({ hits: [q + " 1", q + " 2"] }) },
    ] });
  </script>`,
  "/none": `<!doctype html><title>Plain</title><p>no tools</p>`,
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

test("registerTool tools are listed; an aborted signal unregisters", async () => {
  await b.open(`${base}/current`);
  const tools = await b.webmcpTools();
  assert.deepEqual(tools.map(t => t.name), ["add_todo", "boom", "hang"]);
  assert.equal(tools[0].description, "Add a todo item");
  assert.deepEqual(tools[0].inputSchema.required, ["text"]);
  assert.deepEqual(tools[0].annotations, { readOnlyHint: false });
});

test("calling a tool runs the page's code and returns its text", async () => {
  await b.open(`${base}/current`);
  const r = await b.webmcpCall("add_todo", { text: "buy milk" });
  assert.equal(r.result, "added buy milk");
  assert.equal(r.error, undefined);
  assert.equal(await b.page.textContent("#out"), "buy milk");
});

test("errors: a throwing tool, an unknown name, a tool that never returns", async () => {
  await b.open(`${base}/current`);
  assert.equal((await b.webmcpCall("boom")).error, "nope");
  assert.match((await b.webmcpCall("missing")).error, /no WebMCP tool named "missing"; registered: add_todo, boom, hang/);
  assert.match((await b.webmcpCall("hang", {}, { timeout: 300 })).error, /did not finish within 300 ms/);
});

test("provideContext (earlier draft) on navigator.modelContext", async () => {
  await b.open(`${base}/legacy`);
  assert.deepEqual((await b.webmcpTools()).map(t => t.name), ["search"]);
  assert.equal((await b.webmcpCall("search", { q: "lamp" })).result, '{"hits":["lamp 1","lamp 2"]}');
});

test("a page without tools lists none, and tools do not leak across navigations", async () => {
  await b.open(`${base}/current`);
  await b.open(`${base}/none`);
  assert.deepEqual(await b.webmcpTools(), []);
});

test("webmcpText flattens MCP content and caps size", () => {
  assert.equal(webmcpText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\nb");
  assert.equal(webmcpText("plain"), "plain");
  assert.equal(webmcpText(undefined), "null");
  assert.match(webmcpText("x".repeat(30), 10), /^x{10}\n\[… 20 chars cut\]$/);
});

// Jev stubbed: every question gets a default answer, `script(round)` overrides per decide() round.
function stubJev(b, script) {
  const sent = []; let round = -1;
  b.ask = async (state, questions) => {
    sent.push({ state, questions });
    if (questions.tool) round++;
    const over = questions.tool ? script(round) : script.args ?? {};
    const answers = {};
    for (const [k, q] of Object.entries(questions)) {
      const want = over[k];
      if (q.type === "noul") answers[k] = { noul: want ?? 0 };
      else { const c = want ?? Object.keys(q.criteria)[0]; answers[k] = { choice: c, probabilities: { [c]: 1 }, confidence: 1 }; }
    }
    return { answers, ms: 1, tokens: 0 };
  };
  return sent;
}

test("browser_do: Jev can pick a page tool, and fills its argument from values", async () => {
  await b.open(`${base}/current`);
  const script = r => r === 0 ? { tool: "webmcp", webmcp_tool: "add_todo" } : { done: 0.95, done_change: 0.95, tool: "none" };
  script.args = { a0: "todo" };
  const sent = stubJev(b, script);
  const r = await b.do("Add 'buy milk' to the list", { values: { todo: "buy milk" } });
  delete b.ask;
  assert.equal(r.status, "done");
  assert.deepEqual(r.actions[0], { action: "webmcp", element: "tool add_todo", args: { text: "values.todo" }, result: "added buy milk" });
  assert.equal(await b.page.textContent("#out"), "buy milk");
  const first = sent[0];
  assert.equal(first.questions.tool.criteria.webmcp !== undefined, true);
  assert.deepEqual(first.state.page.webmcp_tools.map(t => t.name), ["add_todo", "boom", "hang"]);
  assert.deepEqual(first.state.page.webmcp_tools[0].arguments, ["text"]);
});

test("browser_do: a page tool not marked read-only waits for allow_irreversible", async () => {
  await b.open(`${base}/current`);
  const script = () => ({ tool: "webmcp", webmcp_tool: "add_todo", irreversible: 0.9 });
  script.args = { a0: "todo" };
  stubJev(b, script);
  const r = await b.do("Add 'buy milk'", { values: { todo: "buy milk" } });
  delete b.ask;
  assert.equal(r.status, "needs_confirmation");
  assert.deepEqual(r.pending, { action: "webmcp", element: "tool add_todo", args: { text: "values.todo" }, p_irreversible: 0.9 });
  assert.equal(await b.page.textContent("#out"), "empty");
});

test("browser_do: a failing page tool is reported in the history, not thrown", async () => {
  await b.open(`${base}/current`);
  stubJev(b, r => r === 0 ? { tool: "webmcp", webmcp_tool: "boom" } : { tool: "none" });
  const r = await b.do("Do the thing");
  delete b.ask;
  assert.equal(r.actions[0].error, "page tool boom: nope");
});

test("browser_do: no page tools, no webmcp action offered", async () => {
  await b.open(`${base}/none`);
  const sent = stubJev(b, () => ({ tool: "none" }));
  await b.do("Anything");
  delete b.ask;
  assert.equal(sent[0].questions.tool.criteria.webmcp, undefined);
  assert.equal(sent[0].questions.webmcp_tool, undefined);
  assert.equal(sent[0].state.page.webmcp_tools, undefined);
});

test("browser_do: arguments ride in the decide request, so a tool call costs no extra Jev call", async () => {
  await b.open(`${base}/current`);
  const sent = stubJev(b, r => r === 0 ? { tool: "webmcp", webmcp_tool: "add_todo", t0a0: "todo" } : { done: 0.95, done_change: 0.95, tool: "none" });
  const r = await b.do("Add it", { values: { other: "x", todo: "buy milk" } });
  delete b.ask;
  assert.equal(r.actions[0].result, "added buy milk");
  assert.equal(sent.length, 2);   // two rounds, no follow-up
  assert.ok(sent[0].questions.t0a0 && sent[0].questions.use_tool);
});

test("browser_do: when Jev says a page tool fits, it is used even if click was the top action", async () => {
  await b.open(`${base}/current`);
  stubJev(b, r => r === 0 ? { tool: "click", use_tool: 0.8, webmcp_tool: "add_todo", t0a0: "todo" } : { done: 0.95, done_change: 0.95, tool: "none" });
  const r = await b.do("Add it", { values: { todo: "buy milk" } });
  delete b.ask;
  assert.equal(r.actions[0].action, "webmcp");
});

test("browser_do: a secret filled into a page tool's argument is never sent to Jev", async () => {
  await b.open(`${base}/current`);
  const sent = stubJev(b, r => r === 0 ? { tool: "webmcp", webmcp_tool: "add_todo", t0a0: "password" } : { done: 0.95, done_change: 0.95, tool: "none" });
  const r = await b.do("Add it", { values: { password: "hunter2" } });
  // the follow-up path (arguments asked separately) redacts too
  const act = { webmcp: "add_todo", schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };
  const args = await b.webmcpArgs({ url: "", title: "", text: "" }, "Add it", [], act, { password: "hunter2" });
  delete b.ask;
  assert.equal(r.actions[0].result, "added hunter2");   // the page got the real value
  assert.deepEqual(args, { text: "hunter2" });
  assert.ok(!JSON.stringify(sent).includes("hunter2"));
});
