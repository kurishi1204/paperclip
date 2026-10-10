import { describe, expect, it } from "vitest";
import { buildHermesChildEnv, validateHermesExtraArgs } from "./safe-runtime.js";

describe("Hermes child boundary", () => {
  const host = {
    HOME: "/Users/runner",
    PATH: "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    ANTHROPIC_API_KEY: "unrelated-host-secret",
    PAPERCLIP_API_KEY: "unrelated-paperclip-secret",
    HERMES_YOLO_MODE: "1",
  };

  it("does not inherit unrelated credentials or approval flags", () => {
    const env = buildHermesChildEnv(undefined, false, host);
    expect(env).toEqual({ HOME: "/Users/runner", PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" });
  });

  it("uses a dedicated home and only explicit provider credentials in bounded mode", () => {
    const env = buildHermesChildEnv({ HERMES_HOME: "/private/qa/hermes", OPENAI_API_KEY: "selected-key" }, true, host);
    expect(env.HOME).toBe("/private/qa/hermes");
    expect(env.HERMES_HOME).toBe("/private/qa/hermes");
    expect(env.OPENAI_API_KEY).toBe("selected-key");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("HERMES_YOLO_MODE");
  });

  it("rejects a global home and unknown control variables in bounded mode", () => {
    expect(() => buildHermesChildEnv({ HERMES_HOME: "relative/path" }, true, host)).toThrow(/absolute HERMES_HOME/);
    expect(() => buildHermesChildEnv({ HERMES_HOME: "/private/qa/hermes", HOME: "/Users/runner" }, true, host)).toThrow(/HOME must equal/);
    expect(() => buildHermesChildEnv({ HERMES_HOME: "/private/qa/hermes", HERMES_YOLO_MODE: "1" }, true, host)).toThrow(/not allowed/);
    expect(() => buildHermesChildEnv({ HERMES_ACCEPT_HOOKS: "1" }, false, host)).toThrow(/not allowed/);
  });

  it("never accepts CLI approval bypasses and restricts bounded extra args", () => {
    expect(() => validateHermesExtraArgs(["--yolo"], false)).toThrow(/approval bypass/);
    expect(() => validateHermesExtraArgs(["--ignore-rules=true"], true)).toThrow(/approval bypass/);
    expect(() => validateHermesExtraArgs(["--accept-hooks"], false)).toThrow(/approval bypass/);
    expect(() => validateHermesExtraArgs(["--toolsets", "terminal"], true)).toThrow(/does not accept extraArgs/);
    expect(() => validateHermesExtraArgs(["--reasoning-effort", "high"], true)).toThrow(/does not accept extraArgs/);
    expect(validateHermesExtraArgs([], true)).toEqual([]);
  });
});
