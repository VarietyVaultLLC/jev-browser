// Request budgeting for Jev. TypeSafe's limits for jev-1.13 (docs: models.md): 64k tokens per
// request, 32k tokens for `state` plus the longest question, at most 255 options per choice.
// Everything here is pure: estimate, split, summarise. session.mjs decides what to ask.

// Deliberately pessimistic. Measured on Hacker News: 32,279 chars of page JSON plus a 231-option
// question were billed 18.4k tokens (about 1.75 chars/token); plain prose is nearer 4. JSON with
// short keys, urls and numbers is the dense case, so assume 1.5, and charge non-ASCII text
// (CJK, emoji) at 1.5 tokens per character.
export const CHARS_PER_TOKEN = 1.5;
export const NON_ASCII_TOKENS = 1.5;
// 32,768 minus a ~20% safety margin. `JEV_FIT_TOKENS` lowers it so a live run can force the
// chunked path on a page that would otherwise fit.
export const FIT_TOKENS = +process.env.JEV_FIT_TOKENS || 26_000;
// Everything together (state + every question) may use at most this much of the 64k request.
export const REQUEST_FIT_TOKENS = 2 * FIT_TOKENS;
export const MAX_OPTIONS = 240;           // choice questions accept at most 255 options
export const SUMMARY_TEXT_CHARS = 3000;   // page text kept in a chunk / summary header
export const DIGEST_MAX_TOKENS = Math.floor(FIT_TOKENS * 0.4);   // room kept for the element digest

export function estimateTokens(x) {
  const s = typeof x === "string" ? x : JSON.stringify(x) ?? "";
  let ascii = 0, other = 0;
  for (let k = 0; k < s.length; k++) s.charCodeAt(k) < 128 ? ascii++ : other++;
  return Math.ceil(ascii / CHARS_PER_TOKEN + other * NON_ASCII_TOKENS);
}

// Would this request be accepted? Checks the 32k rule (state + longest question), the 64k rule
// (state + all questions) and the option cap, each with the margin built into FIT_TOKENS.
// `reserve` tokens are held back for content added later (the element digest).
export function fits(state, questions, reserve = 0) {
  const s = estimateTokens(state), qs = Object.values(questions).map(estimateTokens);
  const options = Math.max(0, ...Object.values(questions).map(q => Object.keys(q.criteria ?? {}).length));
  return options <= MAX_OPTIONS && s + Math.max(0, ...qs) <= FIT_TOKENS - reserve && s + qs.reduce((a, b) => a + b, 0) <= REQUEST_FIT_TOKENS - reserve;
}

// Split `elements` (kept in page order, none dropped) into chunks that each fit as
// { ...head, elements: chunk } next to `taskState` and one target question over the chunk.
export function chunkElements(elements, { head, taskState, question, name = "target" }) {
  const chunks = []; let cur = [];
  const fitsWith = els => fits({ page: { ...head, elements: els }, ...taskState }, { [name]: { ...question, criteria: Object.fromEntries(els.map(e => [String(e.i), null])) } });
  for (const e of elements) {
    if (cur.length && (cur.length >= MAX_OPTIONS || !fitsWith([...cur, e]))) { chunks.push(cur); cur = []; }
    cur.push(e);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// The page without its element list, for questions that need the page as a whole.
export function pageHead(page) {
  const h = { url: page.url, title: page.title, text: (page.text ?? "").slice(0, SUMMARY_TEXT_CHARS), metrics: page.metrics };
  if (page.dialogs?.length) h.dialogs = page.dialogs;
  if (page.repeated_elements) h.repeated_elements = page.repeated_elements;
  if (page.webmcp_tools) h.webmcp_tools = page.webmcp_tools;   // the final call's use_tool / webmcp_tool questions point at it
  return h;
}

// One short line per element, with the state flags that change what "done" means.
export function digestLine(e) {
  const name = String(e.label || e.text || e.placeholder || e.name || e.near || e.href || "").slice(0, 32);
  const flags = ["checked", "disabled", "busy", "expanded", "active"].filter(k => e[k] !== undefined && e[k] !== false).map(k => (e[k] === true ? k : `${k}=${e[k]}`));
  if (e.value !== undefined && e.value !== "" && !/password/.test(e.tag)) flags.push(`value=${String(e.value).slice(0, 20)}`);
  return `${e.i} ${e.tag} ${name}${flags.length ? " " + flags.join(",") : ""}`;
}

// A plain link carries no state a status question can turn on (its text is in the digest line, the
// page's own state is in url/title/text); every other control can (checked, disabled, value...).
const plainLink = e => e.tag === "a" && !/ (checked|disabled|busy|expanded|active|value)/.test(digestLine(e));

// A compact list of every element for the page-level status questions, controls first so that a
// cut falls on plain links. Returns { lines, omitted, omittedControls }; `omittedControls` > 0
// means a stateful element is missing, so a "done" judged from this page is not trustworthy.
export function digest(elements, maxTokens = DIGEST_MAX_TOKENS) {
  const links = [], controls = [];
  for (const e of elements) (plainLink(e) ? links : controls).push(e);
  const lines = []; let used = 0, omittedControls = 0;
  for (const [group, isControl] of [[controls, true], [links, false]]) {
    for (const e of group) {
      const l = digestLine(e), t = estimateTokens(l) + 1;
      if (used + t > maxTokens) { if (isControl) omittedControls++; continue; }
      lines.push(l); used += t;
    }
  }
  return { lines, omitted: elements.length - lines.length, omittedControls };
}

// The page for a question about the page as a whole, when the full page does not fit: its head,
// the `keep` elements in full, and a one-line digest of every element in whatever budget is left.
// `omittedControls` > 0 means a stateful element (not a plain link) is not listed, so the answer
// rests on less than the page's state and callers must not trust a "done" from it. Omitted plain
// links are declared to Jev (`elements_not_listed`) but do not degrade the answer.
export function compactPage(page, { extra = {}, questions = {}, keep = [] } = {}) {
  const base = { ...pageHead(page), elements: keep };
  const used = estimateTokens({ page: base, ...extra }) + Math.max(0, ...Object.values(questions).map(estimateTokens));
  const { lines, omitted, omittedControls } = digest(page.elements, Math.max(0, Math.min(DIGEST_MAX_TOKENS, FIT_TOKENS - used)));
  return { page: { ...base, all_elements: lines, ...(omitted ? { elements_not_listed: omitted } : {}) }, omitted, omittedControls };
}
