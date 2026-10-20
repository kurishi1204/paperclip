import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "run-vitest-stable.mjs");

// Live probes need the installed CLI loader. Keep them separate from the
// dependency-free plan checks that the CI policy job runs before install.
function workflowEnv(overrides = {}) {
  return { ...process.env, ...overrides };
}

test("unavailable ownership lookup stops the common entry before any Vitest job", () => {
  const result = spawnSync(process.execPath, [script, "--mode", "general", "--group", "general-workspaces-b"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: workflowEnv({ PATH: "" }),
    timeout: 20_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(result.stdout, /\[test:run\]/);
  assert.match(result.stderr, /Port-owner lookup returned no owner/);
  assert.match(result.stderr, /Preserve the host PATH/);
});

test("the common entry resolves probe dependencies from source when the target cwd is separate", () => {
  const targetRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pc-test-host-target-")));
  try {
    mkdirSync(path.join(targetRoot, "server/src/__tests__"), { recursive: true });
    mkdirSync(path.join(targetRoot, "server/scripts"), { recursive: true });
    const result = spawnSync(process.execPath, [script, "--mode", "general", "--group", "general-workspaces-b"], {
      cwd: targetRoot,
      encoding: "utf8",
      env: workflowEnv({ PATH: "" }),
      timeout: 20_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stdout, /\[test:run\]/);
    assert.match(result.stderr, /Port-owner lookup returned no owner/);
    assert.match(result.stderr, /Preserve the host PATH/);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test("the real host lookup identifies the probe's own ephemeral listener", () => {
  const result = spawnSync(process.execPath, [
    "--import", pathToFileURL(path.join(repoRoot, "cli/node_modules/tsx/dist/loader.mjs")).href,
    path.join(repoRoot, "scripts/check-vitest-test-host.mjs"),
  ], { cwd: repoRoot, encoding: "utf8", env: workflowEnv(), timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Local listener belongs to probe PID ${result.pid}\\.`));
});
