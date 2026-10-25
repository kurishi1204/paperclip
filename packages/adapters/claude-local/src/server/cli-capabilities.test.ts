import { afterEach, describe, expect, it, vi } from "vitest";

const { runAdapterExecutionTargetProcess } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  runAdapterExecutionTargetProcess,
}));

import {
  claudeCommandSupportsEffortFlag,
  readClaudeCommandVersion,
  resetClaudeCliCapabilitiesCacheForTests,
} from "./cli-capabilities.js";

afterEach(() => {
  vi.resetAllMocks();
  resetClaudeCliCapabilitiesCacheForTests();
});

describe("Claude capability probe budgets", () => {
  const cases = [
    { timeoutSec: 0, expected: 20 },
    { timeoutSec: -1, expected: 20 },
    { timeoutSec: 5, expected: 5 },
    { timeoutSec: 60, expected: 20 },
  ];

  it.each(cases)("reads a valid CLI version with timeoutSec=$timeoutSec", async ({ timeoutSec, expected }) => {
    runAdapterExecutionTargetProcess.mockImplementation(async (_runId, _target, _command, _args, options) => ({
      exitCode: options.timeoutSec >= 1.25 ? 0 : null,
      timedOut: options.timeoutSec < 1.25,
      stdout: options.timeoutSec >= 1.25 ? "2.1.280 (Claude Code)" : "",
      stderr: "",
    }));
    const version = await readClaudeCommandVersion({
      runId: "version-probe", command: "claude", target: null,
      cwd: "/workspace", env: {}, timeoutSec, graceSec: 15,
    });
    expect(version).toBe("2.1.280");
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledWith(
      "version-probe", null, "claude", ["--version"],
      expect.objectContaining({ timeoutSec: expected, graceSec: 5 }),
    );
  });

  it.each(cases)("detects effort support with timeoutSec=$timeoutSec", async ({ timeoutSec, expected }) => {
    runAdapterExecutionTargetProcess.mockImplementation(async (_runId, _target, _command, _args, options) => ({
      exitCode: options.timeoutSec >= 1.25 ? 0 : null,
      timedOut: options.timeoutSec < 1.25,
      stdout: options.timeoutSec >= 1.25 ? "--effort <level>" : "",
      stderr: "",
    }));
    const supported = await claudeCommandSupportsEffortFlag({
      runId: "effort-probe", command: "claude", target: null,
      cwd: "/workspace", env: {}, timeoutSec, graceSec: 15,
    });
    expect(supported).toBe(true);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledWith(
      "effort-probe", null, "claude", ["--help"],
      expect.objectContaining({ timeoutSec: expected, graceSec: 5 }),
    );
  });

  it("keeps a timed-out version probe unverified", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue({
      exitCode: null, timedOut: true, stdout: "2.1.280 (Claude Code)", stderr: "",
    });
    expect(await readClaudeCommandVersion({
      runId: "version-timeout", command: "claude", target: null,
      cwd: "/workspace", env: {}, timeoutSec: 0, graceSec: 15,
    })).toBeNull();
  });

  it("keeps a failed version probe unverified", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue({
      exitCode: 1, timedOut: false, stdout: "2.1.280 (Claude Code)", stderr: "",
    });
    expect(await readClaudeCommandVersion({
      runId: "version-failed", command: "claude", target: null,
      cwd: "/workspace", env: {}, timeoutSec: 0, graceSec: 15,
    })).toBeNull();
  });

  it("keeps a timed-out effort probe unverified", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue({
      exitCode: null, timedOut: true, stdout: "--effort", stderr: "",
    });
    expect(await claudeCommandSupportsEffortFlag({
      runId: "effort-timeout", command: "claude", target: null,
      cwd: "/workspace", env: {}, timeoutSec: 0, graceSec: 15,
    })).toBeNull();
  });
});
