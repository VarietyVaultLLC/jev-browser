// Offline: secrets must stay out of every Jev request, including the chunked ones a big page
// takes (per-chunk target calls, the final call with its one-line digest of every element) and
// the compact whole-page state check()/choose() fall back to. Jev is stubbed at ask(), below
// call(), so redaction runs exactly as it does live. Also: JEV_BROWSER_CHANNEL still works as
// the older name of JEV_BROWSER.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { JevBrowser, browserSetting } from "../src/session.mjs";
import { estimateTokens, FIT_TOKENS } from "../src/budget.mjs";

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser.close(); });

const API_KEY = "sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";   // 40 chars: longer than the digest's 20-char value cut
const PASSWORD = "hunter2-correct-horse";

// A page far over one request: ~600 links plus a text field holding a typed API key and a password field.
function bigPage() {
  const elements = Array.from({ length: 600 }, (_, i) => ({ i, tag: "a", text: `Story ${i} ${"lorem ipsum dolor ".repeat(6)}`, href: `https://example.com/a/${i}/${"slug-".repeat(8)}` }));
  elements.push({ i: 600, tag: "input:text", label: "API key", value: API_KEY });
  elements.push({ i: 601, tag: "input:password", label: "Password", value: PASSWORD });
  return { url: "https://example.com/settings", title: "Settings", text: "Account settings ".repeat(80), metrics: { elements: 602 }, elements };
}

function stubAsk(b) {
  const sent = [];
  b.ask = async (state, questions) => {
    sent.push(JSON.stringify(state));
    const answers = {};
    for (const [k, q] of Object.entries(questions)) {
      if (q.type === "noul") answers[k] = { noul: 0.05 };
      else { const c = Object.keys(q.criteria)[0]; answers[k] = { choice: c, probabilities: Object.fromEntries(Object.keys(q.criteria).map(x => [x, x === c ? 0.9 : 0.01])), confidence: 1 }; }
    }
    return { answers, ms: 1, tokens: 0 };
  };
  return sent;
}

const leaks = (sent, s) => sent.filter(j => j.includes(s.slice(0, 12)));   // any 12-char piece of the start is a leak

test("chunked decide(): no request carries the typed key or the password, not even the digest's cut value", async () => {
  const b = await JevBrowser.launch({ browser });
  b.secrets = new Set([API_KEY]);   // what do() records for a secret-named value
  const page = bigPage();
  assert.ok(estimateTokens({ page }) > FIT_TOKENS, "fixture must force chunking");
  const sent = stubAsk(b);
  const a = await b.decide(page, "Save the settings", { api_key: API_KEY }, []);
  assert.equal(a.stages, 2, "page was chunked");
  assert.ok(sent.length > 2, "several requests went out");
  assert.deepEqual(leaks(sent, API_KEY), [], "API key (or its first 20 chars) reached Jev");
  assert.deepEqual(leaks(sent, PASSWORD), [], "password reached Jev");
  assert.equal(page.elements[600].value, API_KEY, "the caller's page model keeps the real value");
  await b.close();
});

test("compact whole-page state (check/choose fallback): no secret in the digest either", async () => {
  const b = await JevBrowser.launch({ browser });
  b.secrets = new Set([API_KEY]);
  const sent = stubAsk(b);
  const qs = { q: { type: "noul", instructions: "Answer about `page`: is the key saved?" } };
  const { state } = b.wholePage(bigPage(), {}, qs);
  assert.ok(state.page.all_elements, "fixture must take the compact path");
  await b.call(state, qs);
  assert.deepEqual(leaks(sent, API_KEY), []);
  assert.deepEqual(leaks(sent, PASSWORD), []);
  await b.close();
});

test("JEV_BROWSER_CHANNEL is the older name of JEV_BROWSER; JEV_BROWSER wins", () => {
  assert.equal(browserSetting({ JEV_BROWSER_CHANNEL: "msedge" }), "msedge");
  assert.equal(browserSetting({ JEV_BROWSER: "chrome", JEV_BROWSER_CHANNEL: "msedge" }), "chrome");
  assert.equal(browserSetting({}), undefined);
});
