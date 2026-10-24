// WebMCP: tools a page registers for agents (https://github.com/webmachinelearning/webmcp).
//
//   document.modelContext.registerTool({ name, description, inputSchema, execute }, { signal })
//   navigator.modelContext.provideContext({ tools: [...] })   // earlier drafts / Chrome preview
//
// An init script runs before the page's own scripts and keeps a registry of every tool the page
// registers, whatever surface it used. If the browser has a native modelContext the calls still
// reach it; if not, a minimal one is installed so pages that feature-detect it register anyway.
// Main frame only. The tools and their results are the page's own: treat them as untrusted.

export const WEBMCP_INIT = () => {
  if (window.__jevWebmcp) return;
  const tools = new Map();
  const clean = t => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? { type: "object", properties: {} }, ...(t.annotations ? { annotations: t.annotations } : {}) });
  const add = (t, signal) => {
    if (!t || typeof t.name !== "string" || typeof t.execute !== "function") throw new TypeError("WebMCP tool needs a name and an execute function");
    tools.set(t.name, t);
    signal?.addEventListener?.("abort", () => { if (tools.get(t.name) === t) tools.delete(t.name); });
  };
  const wrap = (mc = {}) => {
    const orig = name => typeof mc[name] === "function" ? mc[name].bind(mc) : null;
    const reg = orig("registerTool"), unreg = orig("unregisterTool"), provide = orig("provideContext"), clear = orig("clearContext");
    mc.registerTool = (t, opts) => { add(t, opts?.signal); return reg ? reg(t, opts) : Promise.resolve(); };
    mc.unregisterTool = name => { tools.delete(typeof name === "string" ? name : name?.name); return unreg?.(name); };
    mc.provideContext = (ctx = {}) => { tools.clear(); for (const t of ctx.tools ?? []) add(t); return provide?.(ctx); };
    mc.clearContext = () => { tools.clear(); return clear?.(); };
    return mc;
  };
  // Wrap the native object in place when there is one; otherwise share one shim on both surfaces.
  let shim;
  for (const host of [document, navigator]) {
    try {
      if (host.modelContext) wrap(host.modelContext);
      else Object.defineProperty(host, "modelContext", { value: (shim ??= wrap()), configurable: true });
    } catch {}
  }
  Object.defineProperty(window, "__jevWebmcp", { value: {
    list: () => [...tools.values()].map(clean),
    async call(name, args) {
      const t = tools.get(name);
      if (!t) return { error: `no WebMCP tool named "${name}"; registered: ${[...tools.keys()].join(", ") || "none"}` };
      const ac = new AbortController();
      // execute(input, options): `signal` is the current draft; `requestUserInteraction` the earlier one
      const client = { signal: ac.signal, requestUserInteraction: cb => Promise.resolve().then(cb) };
      try { return { result: await t.execute(args ?? {}, client) }; }
      catch (e) { return { error: String(e?.message ?? e) }; }
    },
  } });
};

// A tool result as text for the caller: MCP-style { content: [{ type: "text", text }] } is
// flattened, anything else is JSON. Capped so a page cannot flood the caller.
export function webmcpText(result, maxChars = 20_000) {
  let s;
  if (result && Array.isArray(result.content)) s = result.content.map(c => c?.type === "text" ? c.text : JSON.stringify(c)).join("\n");
  else s = typeof result === "string" ? result : JSON.stringify(result ?? null);
  return s.length > maxChars ? `${s.slice(0, maxChars)}\n[… ${s.length - maxChars} chars cut]` : s;
}
