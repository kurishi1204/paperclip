import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildHermesChildEnv,
  hashBoundedHermesSkillsTree,
  isBoundedHermesExecution,
  resolveHermesCommandForConfig,
  validateBoundedHermesCommand,
  validateBoundedHermesHome,
  validateBoundedRuntimeOptions,
  validateBoundedToolsets,
  validateHermesExtraArgs,
  validateHermesReasoningEffort,
} from "./safe-runtime.js";

describe("Hermes child boundary", () => {
  const host = {
    HOME: "/Users/runner",
    PATH: "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    ANTHROPIC_API_KEY: "unrelated-host-secret",
    HTTPS_PROXY: "http://127.0.0.1:8123",
    PAPERCLIP_API_KEY: "unrelated-paperclip-secret",
    HERMES_YOLO_MODE: "1",
    PAPERCLIP_HERMES_BOUNDED_HOME: "/private/qa/hermes",
  };

  it("rejects every long-option prefix conflict only when the canonical field is set", () => {
    const canonical = "--reasoning";
    const options = Array.from({ length: canonical.length - 2 }, (_, i) => canonical.slice(0, i + 3));
    for (const option of [...options, "--reasoning-effort"]) {
      for (const arg of [option, `${option}=high`]) {
        expect(() => validateHermesReasoningEffort("high", [arg, "high"])).toThrow(/cannot be combined/);
        expect(validateHermesReasoningEffort(undefined, [arg, "high"])).toBeUndefined();
      }
    }
    expect(validateHermesReasoningEffort("high", ["--source", "tool"])).toBe("high");
  });

  it("preserves the legacy standard host environment except Paperclip identity", () => {
    const env = buildHermesChildEnv(undefined, false, host);
    expect(env.ANTHROPIC_API_KEY).toBe("unrelated-host-secret");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:8123");
    expect(env.HERMES_YOLO_MODE).toBe("1");
    expect(env.PAPERCLIP_API_KEY).toBeUndefined();
  });

  it("uses a dedicated home and only explicit provider credentials in bounded mode", () => {
    const env = buildHermesChildEnv({ HERMES_HOME: "/private/qa/hermes", OPENAI_API_KEY: "selected-key" }, true, host);
    expect(env.HOME).toBe("/Users/runner");
    expect(env.HERMES_HOME).toBe("/private/qa/hermes");
    expect(env.OPENAI_API_KEY).toBe("selected-key");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("HERMES_YOLO_MODE");
    expect(env).not.toHaveProperty("HTTPS_PROXY");
  });

  it("rejects a global home and unknown control variables in bounded mode", () => {
    expect(() => buildHermesChildEnv({ HERMES_HOME: "relative/path" }, true, host)).toThrow(/absolute HERMES_HOME/);
    expect(() => buildHermesChildEnv({ HERMES_HOME: "/Users/runner" }, true, host)).toThrow(/separate from the host home/);
    expect(buildHermesChildEnv({ HERMES_HOME: "/private/qa/hermes", HOME: "/tmp/forged", PATH: "/tmp/fake" }, true, host)).toMatchObject({ HOME: "/Users/runner", PATH: "/usr/bin:/bin" });
    expect(() => buildHermesChildEnv({ HERMES_HOME: "/private/qa/hermes", HERMES_YOLO_MODE: "1" }, true, host)).toThrow(/not allowed/);
    expect(() => buildHermesChildEnv({ HERMES_HOME: "/private/qa/other" }, true, host)).toThrow(/operator-pinned home/);
    expect(() => buildHermesChildEnv({ HERMES_HOME: "/private/qa/hermes" }, true, { ...host, PAPERCLIP_HERMES_BOUNDED_HOME: undefined })).toThrow(/operator-pinned/);
    expect(buildHermesChildEnv({ HERMES_ACCEPT_HOOKS: "1", PYTHONPATH: "/old/venv" }, false, host)).toMatchObject({ HERMES_ACCEPT_HOOKS: "1", PYTHONPATH: "/old/venv" });
  });

  it("preserves standard arguments and rejects all bounded extra args", () => {
    expect(validateHermesExtraArgs(["--yolo"], false)).toEqual(["--yolo"]);
    expect(validateHermesExtraArgs("legacy malformed", false)).toEqual([]);
    expect(() => validateHermesExtraArgs(["--ignore-rules=true"], true)).toThrow(/does not accept extraArgs/);
    expect(validateHermesExtraArgs(["--accept-hooks"], false)).toEqual(["--accept-hooks"]);
    expect(() => validateHermesExtraArgs(["--toolsets", "terminal"], true)).toThrow(/does not accept extraArgs/);
    expect(() => validateHermesExtraArgs(["--reasoning-effort", "high"], true)).toThrow(/does not accept extraArgs/);
    expect(validateHermesExtraArgs([], true)).toEqual([]);
  });

  it("pins bounded commands to the operator, not the agent config", () => {
    expect(() => resolveHermesCommandForConfig({ boundedExecution: true, command: "/tmp/fake" }, {})).toThrow(/command override/);
    expect(() => resolveHermesCommandForConfig({ boundedExecution: true }, {})).toThrow(/operator-pinned command/);
    expect(resolveHermesCommandForConfig({ boundedExecution: true }, { PAPERCLIP_HERMES_TRUSTED_COMMAND: "/opt/homebrew/bin/hermes" })).toBe("/opt/homebrew/bin/hermes");
    expect(() => resolveHermesCommandForConfig({ boundedExecution: true }, { PAPERCLIP_HERMES_TRUSTED_COMMAND: "relative/hermes" })).toThrow(/absolute normalized/);
  });

  it("rejects a changed executable after its operator SHA-256 was pinned", async () => {
    const stage = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hermes-command-pin-")));
    const command = path.join(stage, "hermes");
    const prior = process.env.PAPERCLIP_HERMES_TRUSTED_COMMAND_SHA256;
    try {
      await fs.writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      process.env.PAPERCLIP_HERMES_TRUSTED_COMMAND_SHA256 = createHash("sha256").update(await fs.readFile(command)).digest("hex");
      await expect(validateBoundedHermesCommand(command)).resolves.toBeUndefined();
      await fs.writeFile(command, "#!/bin/sh\nexit 1\n");
      await expect(validateBoundedHermesCommand(command)).rejects.toThrow(/operator pin/);
    } finally {
      if (prior === undefined) delete process.env.PAPERCLIP_HERMES_TRUSTED_COMMAND_SHA256;
      else process.env.PAPERCLIP_HERMES_TRUSTED_COMMAND_SHA256 = prior;
      await fs.rm(stage, { recursive: true, force: true });
    }
  });

  it("keeps bounded toolsets research-only", () => {
    expect(() => validateBoundedToolsets("search")).not.toThrow();
    expect(() => validateBoundedToolsets("web")).toThrow(/only the search toolset/);
    expect(() => validateBoundedToolsets("terminal,file,search")).toThrow(/only the search toolset/);
  });

  it("tolerates server-managed instructions but rejects workspace options for bounded research", () => {
    const bounded = { maxTurnsPerRun: 2 };
    expect(() => validateBoundedRuntimeOptions({ ...bounded, instructionsFilePath: "/private/managed" })).not.toThrow();
    for (const option of ["cwd", "worktreeMode", "checkpoints"]) {
      const value = option === "cwd" ? "/private/other" : true;
      expect(() => validateBoundedRuntimeOptions({ ...bounded, [option]: value })).toThrow(/does not accept/);
    }
    expect(() => validateBoundedRuntimeOptions({ ...bounded, boundedExecution: true, quiet: true })).not.toThrow();
    expect(() => validateBoundedRuntimeOptions({ maxTurnsPerRun: 9 })).toThrow(/2-8 turns/);
    expect(() => validateBoundedRuntimeOptions({ ...bounded, timeoutSec: 901 })).toThrow(/timeout seconds/);
    expect(() => validateBoundedRuntimeOptions({ ...bounded, graceSec: 11 })).toThrow(/grace seconds/);
  });

  it("passes Windows process settings but blocks case-variant approval flags", () => {
    const winHost = { Path: "C:\\Windows\\System32", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\agent", PATHEXT: ".EXE;.CMD", APPDATA: "C:\\Users\\agent\\AppData", PAPERCLIP_HERMES_BOUNDED_HOME: "C:\\Paperclip\\hermes" };
    const env = buildHermesChildEnv({}, false, winHost, "win32");
    expect(env.PATH).toBe(winHost.Path);
    expect(env.SystemRoot).toBe(winHost.SystemRoot);
    expect(env.HOME).toBe(winHost.USERPROFILE);
    expect(buildHermesChildEnv({ Hermes_Yolo_Mode: "1" }, false, winHost, "win32").Hermes_Yolo_Mode).toBe("1");
    expect(() => buildHermesChildEnv({ HERMES_HOME: "C:\\Paperclip\\hermes", PythonPath: "C:\\tmp" }, true, winHost, "win32")).toThrow(/not allowed/);
    expect(buildHermesChildEnv({ HERMES_HOME: "C:\\Paperclip\\hermes" }, true, winHost, "win32").HERMES_HOME).toBe("C:\\Paperclip\\hermes");
  });

  it("operator-pins bounded mode so an agent config cannot downgrade it", () => {
    const hostEnv = { PAPERCLIP_HERMES_BOUNDED_AGENT_ID: "agent-1" };
    expect(isBoundedHermesExecution({ boundedExecution: false }, "agent-1", hostEnv)).toBe(true);
    expect(isBoundedHermesExecution({ boundedExecution: "true" }, "agent-1", hostEnv)).toBe(true);
    expect(isBoundedHermesExecution({}, "agent-2", hostEnv)).toBe(false);
    expect(() => isBoundedHermesExecution({ boundedExecution: true }, "agent-2", hostEnv)).toThrow(/agent ID/);
    expect(() => isBoundedHermesExecution({ boundedExecution: "true" }, "agent-2", hostEnv)).toThrow(/agent ID/);
    expect(() => isBoundedHermesExecution({ boundedExecution: true }, "agent-1", {})).toThrow(/agent ID/);
  });

  it("rejects persistent approval bypasses in a dedicated Hermes .env", async () => {
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-bounded-home-"));
    const home = await fs.realpath(created);
    try {
      await fs.chmod(home, 0o700);
      await fs.writeFile(path.join(home, ".env"), "TAVILY_API_KEY=fixture-value\n", { mode: 0o600 });
      await expect(validateBoundedHermesHome(home)).resolves.toBeUndefined();
      await fs.writeFile(path.join(home, ".env"), "HERMES_YOLO_MODE=1\n", { mode: 0o600 });
      await expect(validateBoundedHermesHome(home)).rejects.toThrow(/unsupported setting/);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("checks the actual dedicated-home inputs before each bounded launch", async () => {
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-home-inputs-"));
    const home = await fs.realpath(created);
    const priorHash = process.env.PAPERCLIP_HERMES_CONFIG_SHA256;
    try {
      await fs.chmod(home, 0o700);
      for (const directory of ["plugins", "hooks", "skills", "memories", "cron"]) {
        await fs.mkdir(path.join(home, directory), { mode: 0o700 });
      }
      await fs.writeFile(path.join(home, "active_profile"), "default\n", { mode: 0o600 });
      await fs.writeFile(path.join(home, ".skills_prompt_snapshot.json"), JSON.stringify({
        version: 1, manifest: {}, skills: [], category_descriptions: {},
      }), { mode: 0o600 });
      const config = "onboarding:\n  seen:\n    busy_input_prompt: true\n    tool_progress_prompt: true\n    openclaw_residue_cleanup: true\n";
      await fs.writeFile(path.join(home, "config.yaml"), config, { mode: 0o600 });
      process.env.PAPERCLIP_HERMES_CONFIG_SHA256 = createHash("sha256").update(config).digest("hex");
      await expect(validateBoundedHermesHome(home)).resolves.toBeUndefined();

      await fs.writeFile(path.join(home, "plugins", "unexpected.py"), "print('unexpected')");
      await expect(validateBoundedHermesHome(home)).rejects.toThrow(/plugins must be empty/);
      await fs.rm(path.join(home, "plugins", "unexpected.py"));

      await fs.writeFile(path.join(home, "active_profile"), "other\n");
      await expect(validateBoundedHermesHome(home)).rejects.toThrow(/active_profile must be default/);
      await fs.writeFile(path.join(home, "active_profile"), "default\n");

      await fs.writeFile(path.join(home, ".env"), "A".repeat(65_537), { mode: 0o600 });
      await expect(validateBoundedHermesHome(home)).rejects.toThrow(/inspection limit/);
      await fs.rm(path.join(home, ".env"));

      await fs.writeFile(path.join(home, "active_profile"), "A".repeat(1_025));
      await expect(validateBoundedHermesHome(home)).rejects.toThrow(/inspection limit/);
      await fs.writeFile(path.join(home, "active_profile"), "default\n");

      await fs.writeFile(path.join(home, ".skills_prompt_snapshot.json"), JSON.stringify({
        version: 1, manifest: {}, skills: ["injected instructions"], category_descriptions: {},
      }));
      await expect(validateBoundedHermesHome(home)).rejects.toThrow(/skills snapshot must be empty/);
      await fs.writeFile(path.join(home, ".skills_prompt_snapshot.json"), JSON.stringify({
        version: 1, manifest: {}, skills: [], category_descriptions: {},
      }));

      await fs.appendFile(path.join(home, "config.yaml"), "plugins:\n  enabled: true\n");
      await expect(validateBoundedHermesHome(home)).rejects.toThrow(/operator pin/);
      const privateConfig = config + "security:\n  allow_private_urls: true\n";
      await fs.writeFile(path.join(home, "config.yaml"), privateConfig);
      process.env.PAPERCLIP_HERMES_CONFIG_SHA256 = createHash("sha256").update(privateConfig).digest("hex");
      await expect(validateBoundedHermesHome(home)).rejects.toThrow(/cannot override URL safety/);
      const fakeRangeConfig = config + "security:\n  fake_ip_ranges: [10.0.0.0/8]\n";
      await fs.writeFile(path.join(home, "config.yaml"), fakeRangeConfig);
      process.env.PAPERCLIP_HERMES_CONFIG_SHA256 = createHash("sha256").update(fakeRangeConfig).digest("hex");
      await expect(validateBoundedHermesHome(home)).rejects.toThrow(/cannot override URL safety/);
      process.env.PAPERCLIP_HERMES_CONFIG_SHA256 = createHash("sha256").update(config).digest("hex");
      await fs.writeFile(path.join(home, "config.yaml"), config);

      await fs.writeFile(path.join(home, "mcp.json"), "{}");
      await expect(validateBoundedHermesHome(home)).rejects.toThrow(/mcp.json is not supported/);
    } finally {
      if (priorHash === undefined) delete process.env.PAPERCLIP_HERMES_CONFIG_SHA256;
      else process.env.PAPERCLIP_HERMES_CONFIG_SHA256 = priorHash;
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("accepts only an operator-pinned Hermes bundled skills tree after first startup", async () => {
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-bundled-skills-"));
    const home = await fs.realpath(created);
    const skills = path.join(home, "skills");
    const skill = path.join(skills, "research", "SKILL.md");
    const soul = path.join(home, "SOUL.md");
    const priorTree = process.env.PAPERCLIP_HERMES_SKILLS_TREE_SHA256;
    const priorSoul = process.env.PAPERCLIP_HERMES_SOUL_SHA256;
    try {
      await fs.chmod(home, 0o700);
      await fs.mkdir(path.dirname(skill), { recursive: true, mode: 0o700 });
      await fs.writeFile(skill, "Bundled public research skill\n", { mode: 0o600 });
      await fs.writeFile(path.join(skills, ".bundled_manifest"), "research:fixture\n", { mode: 0o600 });
      await fs.writeFile(soul, "Default identity\n", { mode: 0o600 });
      await expect(validateBoundedHermesHome(home)).rejects.toThrow(/operator pin/);
      process.env.PAPERCLIP_HERMES_SKILLS_TREE_SHA256 = await hashBoundedHermesSkillsTree(skills);
      await expect(validateBoundedHermesHome(home)).rejects.toThrow(/SOUL.md.*operator pin/);
      process.env.PAPERCLIP_HERMES_SOUL_SHA256 = createHash("sha256").update("Default identity\n").digest("hex");
      await expect(validateBoundedHermesHome(home)).resolves.toBeUndefined();

      await fs.appendFile(skill, "unreviewed instruction\n");
      await expect(validateBoundedHermesHome(home)).rejects.toThrow(/operator pin/);
      await fs.writeFile(skill, "Bundled public research skill\n");
      await fs.symlink(skill, path.join(skills, "unexpected-link"));
      await expect(validateBoundedHermesHome(home)).rejects.toThrow(/unsafe entry/);
      await fs.unlink(path.join(skills, "unexpected-link"));
      await fs.chmod(skill, 0o622);
      await expect(validateBoundedHermesHome(home)).rejects.toThrow(/unsafe entry/);
      await fs.chmod(skill, 0o600);
      await fs.appendFile(soul, "override\n");
      await expect(validateBoundedHermesHome(home)).rejects.toThrow(/SOUL.md.*operator pin/);
      await fs.rm(skills, { recursive: true });
      await expect(validateBoundedHermesHome(home)).rejects.toThrow(/pinned skills tree is missing/);
    } finally {
      if (priorTree === undefined) delete process.env.PAPERCLIP_HERMES_SKILLS_TREE_SHA256;
      else process.env.PAPERCLIP_HERMES_SKILLS_TREE_SHA256 = priorTree;
      if (priorSoul === undefined) delete process.env.PAPERCLIP_HERMES_SOUL_SHA256;
      else process.env.PAPERCLIP_HERMES_SOUL_SHA256 = priorSoul;
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
