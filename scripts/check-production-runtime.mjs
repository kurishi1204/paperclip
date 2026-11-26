#!/usr/bin/env node
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Observe the module files actually loaded by Node, rather than inferring a
// production runtime from package.json declarations or a caller's mode flag.
async function observeProductionRuntime() {
  const loaded = new Set();
  const sources = new Set();
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      loaded.add(url);
      if (url.startsWith("file:") && /\.[cm]?tsx?$/.test(new URL(url).pathname)) sources.add(url);
      return nextLoad(url, context);
    },
  });
  try {
    const server = await import("../server/dist/index.js");
    if (typeof server.startServer !== "function") {
      return { state: "abnormal", reason: "server_start_export_missing", modules: loaded.size, sources: [...sources] };
    }
    return { state: sources.size ? "abnormal" : "normal", modules: loaded.size, sources: [...sources] };
  } catch (error) {
    return { state: "unknown", reason: error.code ?? error.name, modules: loaded.size, sources: [...sources] };
  } finally {
    hooks.deregister();
  }
}

export { observeProductionRuntime };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const observation = await observeProductionRuntime();
  console.log(JSON.stringify({ ...observation, memory: process.memoryUsage() }));
  process.exitCode = observation.state === "normal" ? 0 : observation.state === "abnormal" ? 1 : 2;
}
