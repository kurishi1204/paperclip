import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const [label, source, expectedState, expectedCode] of [
  ["compiled module", "export function startServer() {}", "normal", 0],
  ["missing build", null, "unknown", 2],
  ["source fallback", "import './runtime.ts'; export function startServer() {}", "abnormal", 1],
  ["invalid server contract", "export const unrelated = true;", "abnormal", 1],
]) {
  test(label, async () => {
    const root = await mkdtemp(join(tmpdir(), "production-runtime-"));
    try {
      await mkdir(join(root, "scripts"));
      await mkdir(join(root, "server/dist"), { recursive: true });
      await writeFile(join(root, "package.json"), '{"type":"module"}');
      await copyFile(new URL("./check-production-runtime.mjs", import.meta.url), join(root, "scripts/check.mjs"));
      if (source !== null) await writeFile(join(root, "server/dist/index.js"), source);
      await writeFile(join(root, "server/dist/runtime.ts"), "export const fixture: string = 'actual Node TS load';");
      const result = spawnSync(process.execPath, [join(root, "scripts/check.mjs")], { encoding: "utf8" });
      assert.equal(result.status, expectedCode, result.stderr);
      const observed = JSON.parse(result.stdout);
      assert.equal(observed.state, expectedState);
      assert.equal(observed.sources.length, label === "source fallback" ? 1 : 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
