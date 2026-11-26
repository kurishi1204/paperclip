import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import esbuild from "esbuild";
import config from "../esbuild.workspace.config.mjs";

const cliRoot = fileURLToPath(new URL("../", import.meta.url));

test("compiled CLI ignores an adjacent source checkout", async () => {
  const tempRoot = join(cliRoot, ".paperclip-runtime");
  await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(join(tempRoot, "compiled-entry-"));
  try {
    const output = join(root, "a/b/c/entry.mjs");
    await mkdir(join(root, "server/src"), { recursive: true });
    await mkdir(join(root, "a/b/c"), { recursive: true });
    await writeFile(join(root, "a/b/package.json"), '{"version":"0.0.0-fixture"}');
    await writeFile(join(root, "server/src/index.ts"), 'export async function startServer() { return {chosen: "source"}; }');
    const source = await readFile(join(cliRoot, "src/commands/run.ts"), "utf8");
    await esbuild.build({
      ...config,
      absWorkingDir: cliRoot,
      entryPoints: undefined,
      stdin: {
        contents: source + '\nconsole.log(JSON.stringify(await importServerEntry()));',
        resolveDir: join(cliRoot, "src/commands"), loader: "ts",
      },
      outfile: output,
      plugins: [{
        name: "fixture-server",
        setup(build) {
          build.onResolve({ filter: /^@paperclipai\/server$/ }, () => ({ path: "server", namespace: "fixture" }));
          build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'export async function startServer() { return {chosen: "compiled"}; }' }));
        },
      }],
    });
    const result = spawnSync(process.execPath, ["--conditions=paperclip-production", output], {
      cwd: root, encoding: "utf8", env: { HOME: root, PATH: process.env.PATH },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { chosen: "compiled" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
