// Minimal client for the Typesafe System One API (model: Jev), direct or through OpenRouter.
// Jev answers typed questions over a state object; it never generates text.
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Jev is served by TypeSafe directly and by OpenRouter (same System One request and response).
// TYPESAFE_API_KEY wins over OPENROUTER_API_KEY wherever each was found (environment or .env).
// JEV_API_URL and JEV_MODEL override the TypeSafe endpoint and model only, so an OpenRouter key
// is never sent to another host.
const PROVIDERS = {
  TYPESAFE_API_KEY: { name: "TypeSafe", url: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", overridable: true },
  OPENROUTER_API_KEY: { name: "OpenRouter", url: "https://openrouter.ai/api/v1/systemone", model: "~typesafe/jev-latest" },
};
const KEY_NAMES = Object.keys(PROVIDERS);
let cached;
export function credentials() {
  if (cached) return cached;
  // The environment beats .env for the same key; the first file listed beats the next.
  const keys = {};
  for (const k of KEY_NAMES) if (process.env[k]) keys[k] = process.env[k];
  // The MCP server skips the working directory's .env: as a plugin that is the user's project,
  // and a key found there was not given to this server.
  const files = process.env.JEV_BROWSER_MCP === "1" ? [resolve(ROOT, ".env")] : [resolve(process.cwd(), ".env"), resolve(ROOT, ".env")];
  for (const p of files) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*"?([^"\s]+)"?/);
      if (m && KEY_NAMES.includes(m[1]) && !keys[m[1]]) keys[m[1]] = m[2];
    }
  }
  const k = KEY_NAMES.find(k => keys[k]);
  if (!k) throw new Error("No API key: set TYPESAFE_API_KEY or OPENROUTER_API_KEY (as a Claude Code plugin: /plugin, then configure jev-browser) or put one in .env");
  const p = PROVIDERS[k];
  const url = (p.overridable && process.env.JEV_API_URL) || p.url;
  const model = (p.overridable && process.env.JEV_MODEL) || p.model;
  return (cached = { key: keys[k], name: p.name, url, model });
}
export const apiKey = () => credentials().key;

// questions: { name: { type: "noul" | "choice" | "score", instructions, criteria? } }
export async function jev(state, questions, { retries = 2, timeout = 60_000 } = {}) {
  const { key, url, model, name } = credentials();
  for (let attempt = 0; ; attempt++) {
    const t = performance.now();
    let res, body;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state, model, questions }),
        signal: AbortSignal.timeout(timeout),
      });
      body = await res.json().catch(() => ({}));
    } catch (e) {
      if (attempt < retries) { await sleep(800 * (attempt + 1)); continue; }
      throw e;
    }
    const ms = Math.round(performance.now() - t);
    if (res.ok) return { answers: body.answers, ms, tokens: body.usage?.input_tokens ?? 0 };
    if (attempt < retries && (res.status === 429 || res.status >= 500)) { await sleep(800 * (attempt + 1)); continue; }
    throw new Error(`Jev (${name}) ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
}
