import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";

import { HERMES_CLI } from "../shared/constants.js";
import { resolveHermesCommand } from "./execute.js";
import { testEnvironment, verifyBoundedWebProbe } from "./test.js";

const boundedWebProbe = [
  { type: "system", subtype: "init", session_id: "fixture-session" },
  { type: "tool_use", name: "web_search", input: { query: "official source", limit: 1 } },
  { type: "tool_result", name: "web_search", is_error: false,
    output: JSON.stringify({ success: true, data: { web: [{ url: "https://platform.openai.com/docs/overview" }] } }) },
  { type: "result", session_id: "fixture-session", exit_code: 0 },
].map((event) => JSON.stringify(event)).join("\n") + "\n";

test("bounded web evidence requires a real successful tool result and matching terminal session", () => {
  expect(verifyBoundedWebProbe(boundedWebProbe)).toBe(true);
  expect(verifyBoundedWebProbe("hello\n")).toBe(false);
  expect(verifyBoundedWebProbe(boundedWebProbe.replace('"success\\\":true', '"success\\\":false'))).toBe(false);
  expect(verifyBoundedWebProbe(boundedWebProbe.replace('"exit_code":0', '"exit_code":1'))).toBe(false);
  expect(verifyBoundedWebProbe(boundedWebProbe.replace('"fixture-session","exit_code":0', '"different-session","exit_code":0'))).toBe(false);
});

test("resolveHermesCommand prefers hermesCommand over command", () => {
  expect(resolveHermesCommand({ hermesCommand: "hermes_maximus", command: "hermes_backup" }))
    .toBe("hermes_maximus");
});

test("resolveHermesCommand falls back to command before default hermes binary", () => {
  expect(resolveHermesCommand({ command: "hermes_maximus" })).toBe("hermes_maximus");
  expect(resolveHermesCommand({})).toBe(HERMES_CLI);
});

test("testEnvironment accepts config.command when hermesCommand is absent", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-command-resolution-"));
  const cliPath = path.join(tempDir, "fake-hermes");

  try {
    await writeFile(
      cliPath,
      "#!/bin/sh\necho fake-hermes 1.2.3\n",
      "utf8",
    );
    await chmod(cliPath, 0o755);

    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: {
        command: cliPath,
      },
    });

    expect(result.status).not.toBe("fail");
    expect(result.checks.some((check) => check.code === "hermes_cli_not_found")).toBe(false);
    expect(result.checks.some(
      (check) => check.code === "hermes_version" && check.message.includes("fake-hermes 1.2.3"),
    )).toBe(true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("environment check fails when Hermes is found but cannot start", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-unusable-"));
  const cliPath = path.join(tempDir, "fake-hermes");
  try {
    await writeFile(cliPath, "#!/bin/sh\nexit 7\n");
    await chmod(cliPath, 0o755);
    const result = await testEnvironment({ companyId: "test", adapterType: "hermes_local", config: { command: cliPath } });
    expect(result.status).toBe("fail");
    expect(result.checks.some((check) => check.code === "hermes_cli_unusable")).toBe(true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("managed connections probe the selected environment without falling back to host keys", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-managed-probe-"));
  const cliPath = path.join(tempDir, "fake-hermes");
  try {
    await writeFile(cliPath, '#!/bin/sh\n[ "$HERMES_HOME" = "' + tempDir + '" ] || exit 1\n[ "$OPENAI_API_KEY" = "selected-key" ] || exit 1\n[ "$ANTHROPIC_API_KEY" = "" ] || exit 1\n[ "$1" = "chat" ] || exit 1\necho hello\n');
    await chmod(cliPath, 0o755);
    const config = { command: cliPath, managedAiRouting: true, model: "custom/model", provider: "auto", env: { HERMES_HOME: tempDir, OPENAI_API_KEY: "selected-key", ANTHROPIC_API_KEY: "" } };
    const passed = await testEnvironment({ companyId: "test", adapterType: "hermes_local", config });
    expect(passed.status).toBe("pass");
    expect(passed.checks[0]?.code).toBe("hermes_hello_probe_passed");
    const failed = await testEnvironment({ companyId: "test", adapterType: "hermes_local", config: { ...config, env: { ...config.env, OPENAI_API_KEY: "wrong-key" } } });
    expect(failed.status).toBe("fail");
    expect(failed.checks[0]?.code).toBe("hermes_hello_probe_failed");
    expect(JSON.stringify(failed)).not.toContain("wrong-key");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("bounded environment check fails before a probe when home or arguments are unsafe", async () => {
  const base = {
    companyId: "test",
    adapterType: "hermes_local" as const,
    config: {
      command: "/missing/hermes",
      managedAiRouting: true,
      boundedExecution: true,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      toolsets: "search",
      maxTurnsPerRun: 2,
      env: { HERMES_HOME: "/private/qa/hermes" },
    },
  };
  const unsafeArg = await testEnvironment({ ...base, config: { ...base.config, extraArgs: ["--yolo"] } });
  expect(unsafeArg.status).toBe("fail");
  expect(unsafeArg.checks[0]?.code).toBe("hermes_environment_invalid");

  const missingHome = await testEnvironment({ ...base, config: { ...base.config, env: {} } });
  expect(missingHome.status).toBe("fail");
  expect(missingHome.checks[0]?.code).toBe("hermes_environment_invalid");
});

test("bounded environment check exercises a real web search with an empty HOME", async () => {
  const stage = await realpath(await mkdtemp(path.join(os.tmpdir(), "hermes-bounded-probe-")));
  const home = path.join(stage, "home");
  const cli = path.join(stage, "fake-hermes");
  const keys = ["PAPERCLIP_HERMES_BOUNDED_AGENT_ID", "PAPERCLIP_HERMES_BOUNDED_HOME", "PAPERCLIP_HERMES_TRUSTED_COMMAND", "PAPERCLIP_HERMES_TRUSTED_COMMAND_SHA256"] as const;
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    await mkdir(home, { mode: 0o700 });
    await writeFile(cli, "#!/bin/sh\n[ \"$HOME\" != \"$HERMES_HOME\" ] || exit 7\n[ \"$1\" = chat ] || exit 7\ncase \" $* \" in *\" --ignore-user-config \"*) ;; *) exit 7;; esac\ncase \" $* \" in *\" --ignore-rules \"*) ;; *) exit 7;; esac\ncase \" $* \" in *\" --format stream-json \"*) ;; *) exit 7;; esac\ncat <<'JSONL'\n" + boundedWebProbe + "JSONL\n");
    await chmod(cli, 0o755);
    process.env.PAPERCLIP_HERMES_BOUNDED_AGENT_ID = "bounded-probe-agent";
    process.env.PAPERCLIP_HERMES_BOUNDED_HOME = home;
    process.env.PAPERCLIP_HERMES_TRUSTED_COMMAND = cli;
    process.env.PAPERCLIP_HERMES_TRUSTED_COMMAND_SHA256 = createHash("sha256").update(await readFile(cli)).digest("hex");
    const result = await testEnvironment({
      companyId: "test", adapterType: "hermes_local", agentId: "bounded-probe-agent",
      config: { boundedExecution: true, provider: "openai-codex", model: "gpt-5.6-sol", toolsets: "search", maxTurnsPerRun: 2, env: { HERMES_HOME: home } },
    });
    expect(result.status).toBe("pass");
    expect(result.checks.some((check) => check.code === "hermes_web_probe_passed")).toBe(true);
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    await rm(stage, { recursive: true, force: true });
  }
});

test("bounded environment probe passes enabledToolsets to the real CLI", async () => {
  const stage = await realpath(await mkdtemp(path.join(os.tmpdir(), "hermes-bounded-toolsets-")));
  const home = path.join(stage, "home");
  const cli = path.join(stage, "fake-hermes");
  const keys = ["PAPERCLIP_HERMES_BOUNDED_AGENT_ID", "PAPERCLIP_HERMES_BOUNDED_HOME", "PAPERCLIP_HERMES_TRUSTED_COMMAND", "PAPERCLIP_HERMES_TRUSTED_COMMAND_SHA256"] as const;
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    await mkdir(home, { mode: 0o700 });
    await writeFile(cli, '#!/bin/sh\ncase " $* " in *" -t search "*) ;; *) exit 7;; esac\ncat <<\x27JSONL\x27\n' + boundedWebProbe + 'JSONL\n');
    await chmod(cli, 0o755);
    process.env.PAPERCLIP_HERMES_BOUNDED_AGENT_ID = "bounded-toolsets-agent";
    process.env.PAPERCLIP_HERMES_BOUNDED_HOME = home;
    process.env.PAPERCLIP_HERMES_TRUSTED_COMMAND = cli;
    process.env.PAPERCLIP_HERMES_TRUSTED_COMMAND_SHA256 = createHash("sha256").update(await readFile(cli)).digest("hex");
    const result = await testEnvironment({
      companyId: "test", adapterType: "hermes_local", agentId: "bounded-toolsets-agent",
      config: { boundedExecution: true, provider: "openai-codex", model: "gpt-5.6-sol", enabledToolsets: ["search"], maxTurnsPerRun: 8, env: { HERMES_HOME: home } },
    });
    expect(result.status).toBe("pass");
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    await rm(stage, { recursive: true, force: true });
  }
});

test("bounded probe rejects a first launch that creates unpinned home instructions", async () => {
  const stage = await realpath(await mkdtemp(path.join(os.tmpdir(), "hermes-bounded-first-use-")));
  const home = path.join(stage, "home");
  const cli = path.join(stage, "fake-hermes");
  const keys = ["PAPERCLIP_HERMES_BOUNDED_AGENT_ID", "PAPERCLIP_HERMES_BOUNDED_HOME", "PAPERCLIP_HERMES_TRUSTED_COMMAND", "PAPERCLIP_HERMES_TRUSTED_COMMAND_SHA256"] as const;
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    await mkdir(home, { mode: 0o700 });
    await writeFile(cli, "#!/bin/sh\numask 077\nmkdir -m 700 -p \"$HERMES_HOME/skills\"\nprintf 'unreviewed\\n' > \"$HERMES_HOME/skills/SKILL.md\"\nprintf 'unreviewed\\n' > \"$HERMES_HOME/SOUL.md\"\ncat <<'JSONL'\n" + boundedWebProbe + "JSONL\n");
    await chmod(cli, 0o755);
    process.env.PAPERCLIP_HERMES_BOUNDED_AGENT_ID = "first-use-agent";
    process.env.PAPERCLIP_HERMES_BOUNDED_HOME = home;
    process.env.PAPERCLIP_HERMES_TRUSTED_COMMAND = cli;
    process.env.PAPERCLIP_HERMES_TRUSTED_COMMAND_SHA256 = createHash("sha256").update(await readFile(cli)).digest("hex");
    const result = await testEnvironment({
      companyId: "test", adapterType: "hermes_local", agentId: "first-use-agent",
      config: { boundedExecution: true, provider: "openai-codex", model: "fixture-model", toolsets: "search", maxTurnsPerRun: 2, env: { HERMES_HOME: home } },
    });
    expect(result.status).toBe("fail");
    expect(result.checks.some((check) => check.code === "hermes_web_probe_failed")).toBe(true);
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    await rm(stage, { recursive: true, force: true });
  }
});

test("standard environment check reports a host provider key that the legacy run inherits", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-no-host-key-"));
  const cliPath = path.join(tempDir, "fake-hermes");
  const prior = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "unrelated-host-secret";
  try {
    await writeFile(cliPath, "#!/bin/sh\necho fake-hermes 1.2.3\n");
    await chmod(cliPath, 0o755);
    const result = await testEnvironment({
      companyId: "test",
      adapterType: "hermes_local",
      config: { command: cliPath, env: { HERMES_HOME: tempDir } },
    });
    expect(result.checks.some((check) => check.code === "hermes_api_keys_found")).toBe(true);
  } finally {
    if (prior === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prior;
    await rm(tempDir, { recursive: true, force: true });
  }
});
