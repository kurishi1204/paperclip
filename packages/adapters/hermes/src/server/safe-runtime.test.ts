import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildHermesChildEnv,
  resolveHermesCommandForConfig,
  validateBoundedHermesHome,
  validateBoundedRuntimeOptions,
  validateBoundedToolsets,
  validateHermesExtraArgs,
} from "./safe-runtime.js";

describe("Hermes child boundary", () => {
  const host = {
    HOME: "/Users/runner",
    PATH: "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    ANTHROPIC_API_KEY: "unrelated-host-secret",
    PAPERCLIP_API_KEY: "unrelated-paperclip-secret",
    HERMES_YOLO_MODE: "1",
    PAPERCLIP_HERMES_BOUNDED_HOME: "/private/qa/hermes",
  };

  it("does not inherit unrelated credentials or approval flags", () => {
    const env = buildHermesChildEnv(undefined, false, host);
    expect(env).toEqual({ HOME: "/Users/runner", PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" });
  });

  it("uses a dedicated home and only explicit provider credentials in bounded mode", () => {
    const env = buildHermesChildEnv({ HERMES_HOME: "/private/qa/hermes", OPENAI_API_KEY: "selected-key" }, true, host);
    expect(env.HOME).toBe("/Users/runner");
    expect(env.HERMES_HOME).toBe("/private/qa/hermes");
    expect(env.OPENAI_API_KEY).toBe("selected-key");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("HERMES_YOLO_MODE");
  });

  it("rejects a global home and unknown control variables in bounded mode", () => {
    expect(() => buildHermesChildEnv({ HERMES_HOME: "relative/path" }, true, host)).toThrow(/absolute HERMES_HOME/);
    expect(() => buildHermesChildEnv({ HERMES_HOME: "/Users/runner" }, true, host)).toThrow(/separate from the host home/);
    expect(() => buildHermesChildEnv({ HERMES_HOME: "/private/qa/hermes", HOME: "/Users/runner" }, true, host)).toThrow(/not allowed/);
    expect(() => buildHermesChildEnv({ HERMES_HOME: "/private/qa/hermes", PATH: "/tmp/fake" }, true, host)).toThrow(/not allowed/);
    expect(() => buildHermesChildEnv({ HERMES_HOME: "/private/qa/hermes", HERMES_YOLO_MODE: "1" }, true, host)).toThrow(/not allowed/);
    expect(() => buildHermesChildEnv({ HERMES_HOME: "/private/qa/other" }, true, host)).toThrow(/operator-pinned home/);
    expect(() => buildHermesChildEnv({ HERMES_HOME: "/private/qa/hermes" }, true, { ...host, PAPERCLIP_HERMES_BOUNDED_HOME: undefined })).toThrow(/operator-pinned/);
    expect(() => buildHermesChildEnv({ HERMES_ACCEPT_HOOKS: "1" }, false, host)).toThrow(/not allowed/);
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
    expect(resolveHermesCommandForConfig({ boundedExecution: true }, { PAPERCLIP_HERMES_TRUSTED_COMMAND: "/opt/homebrew/bin/hermes" })).toBe("/opt/homebrew/bin/hermes");
    expect(() => resolveHermesCommandForConfig({ boundedExecution: true }, { PAPERCLIP_HERMES_TRUSTED_COMMAND: "relative/hermes" })).toThrow(/absolute normalized/);
  });

  it("keeps bounded toolsets research-only", () => {
    expect(() => validateBoundedToolsets("web")).not.toThrow();
    expect(() => validateBoundedToolsets("terminal,file,web")).toThrow(/only the web toolset/);
  });

  it("rejects file and workspace options for bounded research", () => {
    for (const option of ["instructionsFilePath", "cwd", "worktreeMode", "checkpoints"]) {
      const value = option === "instructionsFilePath" || option === "cwd" ? "/private/other" : true;
      expect(() => validateBoundedRuntimeOptions({ [option]: value })).toThrow(/does not accept/);
    }
    expect(() => validateBoundedRuntimeOptions({ boundedExecution: true, quiet: true })).not.toThrow();
  });

  it("passes Windows process settings but blocks case-variant approval flags", () => {
    const winHost = { Path: "C:\\Windows\\System32", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\agent", PATHEXT: ".EXE;.CMD", APPDATA: "C:\\Users\\agent\\AppData", PAPERCLIP_HERMES_BOUNDED_HOME: "C:\\Paperclip\\hermes" };
    const env = buildHermesChildEnv({}, false, winHost, "win32");
    expect(env.PATH).toBe(winHost.Path);
    expect(env.SystemRoot).toBe(winHost.SystemRoot);
    expect(env.HOME).toBe(winHost.USERPROFILE);
    expect(() => buildHermesChildEnv({ Hermes_Yolo_Mode: "1" }, false, winHost, "win32")).toThrow(/not allowed/);
    expect(() => buildHermesChildEnv({ HERMES_HOME: "C:\\Paperclip\\hermes", PythonPath: "C:\\tmp" }, true, winHost, "win32")).toThrow(/not allowed/);
    expect(buildHermesChildEnv({ HERMES_HOME: "C:\\Paperclip\\hermes" }, true, winHost, "win32").HERMES_HOME).toBe("C:\\Paperclip\\hermes");
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
});
