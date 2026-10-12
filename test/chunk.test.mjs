// Offline tests for big pages: a page whose Jev request would exceed TypeSafe's limits must be
// split into chunks, never sent whole. The Jev client is mocked; the mock enforces the documented
// limits (docs.typesafe.ai/models: 64k tokens per request, 32k for state + the longest question,
// at most 255 choices) with a deliberately realistic density of 1.7 chars per token (measured on
// Hacker News: 32,279 chars of page JSON = 18.4k billed tokens, criteria included).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { JevBrowser } from "../src/session.mjs";
import { estimateTokens, fits, chunkElements, digest, compactPage, FIT_TOKENS, MAX_OPTIONS } from "../src/budget.mjs";

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser.close(); });

const REAL_CHARS_PER_TOKEN = 1.7;
const tok = x => Math.ceil(JSON.stringify(x).length / REAL_CHARS_PER_TOKEN);

// A Hacker News-shaped page: ~230 link elements with long titles and urls, one needle.
function hnPage(n = 230, { needleAt = 200, textLen = 2400, titleLen = 100 } = {}) {
  const elements = Array.from({ length: n }, (_, i) => ({
    i, tag: "a",
    text: i === needleAt ? "NEEDLE the one story to open" : `Story ${i} ${"lorem ipsum dolor sit amet ".repeat(8)}`.slice(0, titleLen),
    href: `https://example.com/articles/${i}/${"slug-".repeat(9)}`,
    near: "123 points by someone 4 hours ago | 57 comments",
  }));
  return { url: "https://news.ycombinator.com/", title: "Hacker News", text: "Hacker News new | past | comments ".repeat(100).slice(0, textLen), metrics: { elements: n }, elements, needle: needleAt };
}

// Mock Jev: enforces the limits, answers deterministically. Records every request.
function mockJev(b, { failChunk = false } = {}) {
  const seen = [];
  b.call = async (state, questions) => {
    seen.push({ state, questions });
    const longest = Math.max(0, ...Object.values(questions).map(tok));
    if (tok(state) + longest > 32768) throw new Error("Jev 400: max_tokens_exceeded (state + longest question)");
    if (tok(state) + Object.values(questions).reduce((a, q) => a + tok(q), 0) > 65536) throw new Error("Jev 400: max_tokens_exceeded (request)");
    const ids = new Set((state.page?.elements ?? []).map(e => String(e.i)));
    const answers = {};
    for (const [name, q] of Object.entries(questions)) {
      if (q.type === "noul") answers[name] = { noul: name === "irreversible" ? 0.2 : 0.05 };
      else if (name === "target") {
        const crit = Object.keys(q.criteria);
        if (crit.length > 255) throw new Error("Jev 400: Too many choices. Must have at most 255 choices.");
        for (const k of crit) assert.ok(ids.has(k), `target option ${k} is not in page.elements`);
        const win = crit.find(k => state.page.elements.find(e => String(e.i) === k)?.text?.startsWith("NEEDLE")) ?? crit[0];
        if (failChunk && !questions.tool && crit.includes("100")) throw new Error("Jev 503");
        answers[name] = { choice: win, probabilities: Object.fromEntries(crit.map(k => [k, k === win ? 0.9 : 0.1 / Math.max(1, crit.length - 1)])) };
      } else if (name === "tool") answers[name] = { choice: "click", probabilities: { click: 0.9, none: 0.1 } };
      else answers[name] = { choice: Object.keys(q.criteria ?? { x: 1 })[0], probabilities: { x: 1 } };
    }
    b.stats.calls++;
    return { answers, ms: 1, tokens: tok(state) };
  };
  return seen;
}



test("a Hacker News-scale page that would blow the token limit is chunked, and the needle is still found", async () => {
  const b = await JevBrowser.launch({ browser });
  const page = hnPage();
  assert.ok(JSON.stringify(page).length <= 70_000, "fixture passes the old 70k-char gate, so the old code sends it whole");
  assert.ok(tok({ page }) > 32768 * 0.8, `fixture must be big (${tok({ page })} tokens)`);
  const seen = mockJev(b);
  const a = await b.decide(page, "Open the best story", {}, []);
  assert.ok(seen.length > 1, "more than one Jev call");
  const best = Object.entries(a.target.probabilities).sort((x, y) => y[1] - x[1])[0][0];
  assert.equal(best, String(page.needle));
  await b.close();
});

const STATUS = ["done", "done_change", "blocked", "error", "login", "irreversible", "tool"];

test("chunked: chunk calls ask only the target question, every element is seen, one final call answers the status questions", async () => {
  const b = await JevBrowser.launch({ browser });
  const page = hnPage();
  const seen = mockJev(b);
  const a = await b.decide(page, "Open the best story", {}, []);
  const final = seen.at(-1), chunkCalls = seen.slice(0, -1);
  assert.ok(chunkCalls.length >= 2);
  for (const c of chunkCalls) assert.deepEqual(Object.keys(c.questions), ["target"]);
  assert.deepEqual(new Set(chunkCalls.flatMap(c => c.state.page.elements.map(e => e.i))), new Set(page.elements.map(e => e.i)), "no element dropped");
  for (const k of STATUS) assert.ok(final.questions[k], `final call asks ${k}`);
  assert.ok(final.questions.target);
  assert.equal(final.state.page.elements.length, Object.keys(final.questions.target.criteria).length);
  assert.ok(final.state.page.all_elements.length === page.elements.length, "the digest lists every element");
  assert.ok(final.state.page.text.length > 0);
  assert.equal(a.irreversible.noul, 0.2, "irreversible comes from the final call");
  assert.equal(a.stages, 2);
  assert.equal(a.degraded, undefined);
  await b.close();
});

test("a page that fits is sent whole in one call, untouched", async () => {
  const b = await JevBrowser.launch({ browser });
  const page = hnPage(30);
  const seen = mockJev(b);
  const a = await b.decide(page, "Open the best story", {}, []);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].state.page, page);
  assert.equal(a.stages, 1);
  assert.deepEqual(Object.keys(seen[0].questions).sort(), [...STATUS, "target"].sort());
  await b.close();
});

test("more than 255 small elements: chunked under the option cap, needle at the far end still found", async () => {
  const b = await JevBrowser.launch({ browser });
  const elements = Array.from({ length: 700 }, (_, i) => ({ i, tag: "button", text: i === 699 ? "NEEDLE" : `b${i}` }));
  const page = { url: "https://x.test/", title: "t", text: "hi", metrics: {}, elements };
  const seen = mockJev(b);
  const a = await b.decide(page, "Press the needle", {}, []);
  assert.ok(seen.every(c => Object.values(c.questions).every(q => Object.keys(q.criteria ?? {}).length <= MAX_OPTIONS)));
  assert.equal(Object.entries(a.target.probabilities).sort((x, y) => y[1] - x[1])[0][0], "699");
  await b.close();
});

test("fail safe: a cut digest caps done below the done threshold; the irreversible question is still asked", async () => {
  const b = await JevBrowser.launch({ browser });
  const elements = Array.from({ length: 3000 }, (_, i) => ({ i, tag: "button", text: `button number ${i} with a longish name here` }));
  const page = { url: "https://x.test/", title: "t", text: "hi", metrics: {}, elements };
  const seen = mockJev(b);
  b.call = (orig => async (state, qs) => { const r = await orig(state, qs); if (r.answers.done) { r.answers.done.noul = 0.95; r.answers.done_change.noul = 0.95; } return r; })(b.call);
  const a = await b.decide(page, "Open a link", {}, []);
  const final = seen.at(-1);
  assert.ok(final.questions.irreversible, "irreversible asked in the final call");
  assert.ok(final.state.page.elements_not_listed > 0, "the cut is declared to Jev");
  assert.ok(a.degraded);
  assert.ok(a.done.noul < 0.5 && a.done_change.noul < 0.5, "done is capped");
  await b.close();
});

test("fail safe: a failed chunk call fails the round instead of silently dropping its elements", async () => {
  const b = await JevBrowser.launch({ browser });
  mockJev(b, { failChunk: true });
  await assert.rejects(b.decide(hnPage(), "Open the best story", {}, []), /503/);
  await b.close();
});

test("check() and choose() on a big page send a compact page that fits", async () => {
  const b = await JevBrowser.launch({ browser });
  const seen = mockJev(b);
  b.settle = async () => {}; const page = hnPage(); b.snapshot = async () => page;
  b.call = (orig => async (st, qs) => { seen.push({ st }); return { answers: { q: { noul: 0.4, choice: "a", probabilities: { a: 1 }, confidence: 1 } }, ms: 1, tokens: 0 }; })();
  await b.check("Is there a story called NEEDLE?");
  await b.choose("Which?", ["a", "b"]);
  for (const { st } of seen) assert.ok(tok(st) < 32768 * 0.8 && st.page.all_elements.length > 0);
  await b.close();
});

test("budget: estimate is pessimistic, fits() applies both limits and the option cap", () => {
  const s = "x".repeat(3000);
  assert.equal(estimateTokens(s), 2000);
  assert.ok(estimateTokens("日本語".repeat(10)) >= 45, "non-ASCII costs more");
  assert.ok(fits({ a: "x".repeat(1000) }, { q: { type: "noul", instructions: "q" } }));
  assert.ok(!fits({ a: "x".repeat(FIT_TOKENS * 2) }, { q: { type: "noul", instructions: "q" } }));
  const opts = n => ({ q: { type: "choice", criteria: Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), null])) } });
  assert.ok(fits({}, opts(MAX_OPTIONS)) && !fits({}, opts(MAX_OPTIONS + 1)));
  const near = { a: "x".repeat(Math.floor((FIT_TOKENS - 300) * 1.5)) }, q = { q: { type: "noul", instructions: "q" } };
  assert.ok(fits(near, q) && !fits(near, q, 1000), "reserve is held back");
});

test("budget: chunkElements keeps order and every element, and each chunk fits", () => {
  const page = hnPage();
  const q = { type: "choice", instructions: "Which?" };
  const chunks = chunkElements(page.elements, { head: { url: page.url, text: page.text }, taskState: { task: { goal: "g" } }, question: q });
  assert.deepEqual(chunks.flat().map(e => e.i), page.elements.map(e => e.i));
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(tok({ page: { elements: c } }) < 32768);
});

test("budget: digest reports what it could not list; compactPage keeps candidates in full", () => {
  const els = Array.from({ length: 500 }, (_, i) => ({ i, tag: "a", text: `link ${i}`, checked: i === 3 ? true : undefined }));
  const d = digest(els, 100);
  assert.ok(d.lines.length < 500 && d.omitted === 500 - d.lines.length);
  assert.ok(digest(els).lines.includes("3 a link 3 checked"));
  assert.equal(d.omittedControls, 0, "plain links are cut first and do not count as lost state");
  const mixed = [...Array.from({ length: 300 }, (_, i) => ({ i, tag: "input:checkbox", label: `option number ${i}`, checked: false })), ...els];
  assert.ok(digest(mixed, 300).omittedControls > 0, "a cut that loses stateful controls is reported");
  const c = compactPage({ url: "u", title: "t", text: "x", metrics: {}, elements: els }, { keep: [els[7]] });
  assert.deepEqual(c.page.elements, [els[7]]);
  assert.equal(c.omitted, 0);
});
