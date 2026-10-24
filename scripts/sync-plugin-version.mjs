#!/usr/bin/env node
// Keeps the plugin manifest and its pinned npx launcher on package.json's version.
// Runs from `npm version` (the "version" script), so the bump commit carries all three files.
//   node scripts/sync-plugin-version.mjs --check   exits 1 if they disagree (CI, release)
import { readFileSync, writeFileSync } from "node:fs";

const read = p => JSON.parse(readFileSync(p, "utf8"));
const { version } = read("package.json");
const plugin = read(".claude-plugin/plugin.json");
const mcp = read(".mcp.json");
const args = mcp.mcpServers["jev-browser"].args;
const at = args.findIndex(a => a.startsWith("jev-browser@"));
const pinned = args[at];

if (process.argv.includes("--check")) {
  const bad = [plugin.version !== version && `.claude-plugin/plugin.json has ${plugin.version}`, pinned !== `jev-browser@${version}` && `.mcp.json pins ${pinned}`].filter(Boolean);
  if (bad.length) { console.error(`package.json is ${version}, but ${bad.join(" and ")}. Run: node scripts/sync-plugin-version.mjs`); process.exit(1); }
} else {
  plugin.version = version;
  args[at] = `jev-browser@${version}`;
  writeFileSync(".claude-plugin/plugin.json", JSON.stringify(plugin, null, 2) + "\n");
  writeFileSync(".mcp.json", JSON.stringify(mcp, null, 2) + "\n");
}
