// Offline tests for provider selection in credentials(): which key wins across the environment
// and .env, and that endpoint overrides never send an OpenRouter key elsewhere. Each case runs in
// a fresh process because credentials() caches its result, on a copy of jev.mjs in a temp dir so
// the repo's own .env stays out of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SRC = join(import.meta.dirname, "..", "src", "jev.mjs");
const CLEAN = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "JEV_API_URL", "JEV_MODEL", "JEV_BROWSER_MCP"];

// The temp dir is both the copy's root and the cwd, so its .env is the only one read.
function creds(env, dotenv) {
  const dir = mkdtempSync(join(tmpdir(), "jev-creds-"));
  mkdirSync(join(dir, "src"));
  copyFileSync(SRC, join(dir, "src", "jev.mjs"));
  if (dotenv) writeFileSync(join(dir, ".env"), dotenv);
  const jev = pathToFileURL(join(dir, "src", "jev.mjs")).href;
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !CLEAN.includes(k)));
  const out = execFileSync(process.execPath, ["--input-type=module", "-e",
    `import(${JSON.stringify(jev)}).then(m => console.log(JSON.stringify(m.credentials())))`],
    { cwd: dir, env: { ...base, ...env }, encoding: "utf8" });
  return JSON.parse(out);
}

test("TYPESAFE_API_KEY in .env beats OPENROUTER_API_KEY in the environment", () => {
  const c = creds({ OPENROUTER_API_KEY: "or-key" }, "TYPESAFE_API_KEY=ts-key\n");
  assert.deepEqual([c.name, c.key, c.url, c.model], ["TypeSafe", "ts-key", "https://api.typesafe.ai/v1/systemone", "jev-latest"]);
});

test("the environment beats .env for the same key", () => {
  assert.equal(creds({ TYPESAFE_API_KEY: "env-key" }, "TYPESAFE_API_KEY=file-key\n").key, "env-key");
});

test("OpenRouter alone is used, from either source", () => {
  assert.equal(creds({ OPENROUTER_API_KEY: "or-key" }).name, "OpenRouter");
  assert.equal(creds({}, "OPENROUTER_API_KEY=or-key\n").name, "OpenRouter");
});

test("JEV_API_URL and JEV_MODEL override TypeSafe only", () => {
  const over = { JEV_API_URL: "https://example.test/v1/systemone", JEV_MODEL: "jev-x" };
  const ts = creds({ TYPESAFE_API_KEY: "ts-key", ...over });
  assert.deepEqual([ts.url, ts.model], [over.JEV_API_URL, over.JEV_MODEL]);
  const or = creds({ OPENROUTER_API_KEY: "or-key", ...over });
  assert.deepEqual([or.name, or.url, or.model], ["OpenRouter", "https://openrouter.ai/api/v1/systemone", "~typesafe/jev-latest"]);
});
