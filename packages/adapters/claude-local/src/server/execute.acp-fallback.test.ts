import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  executeClaudeAcp,
  prepareAdapterExecutionTargetRuntime,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  executeClaudeAcp: vi.fn(async () => {
    throw new Error('Transform failed with 1 error: execute.ts:818:0: ERROR: Unexpected "<<"');
  }),
  prepareAdapterExecutionTargetRuntime: vi.fn(async () => {
    throw new Error("REMOTE_PREPARATION_REACHED");
  }),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({
        type: "assistant",
        session_id: "claude-session-1",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "result",
        session_id: "claude-session-1",
        result: "hello",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => executeClaudeAcp,
  resolveClaudeExecutionEngineForRun: async (ctx: { config: Record<string, unknown> }) =>
    ctx.config.engine === "cli"
      ? { engine: "cli", explicit: true }
      : ctx.config.engine === "acp"
      ? { engine: "acp", explicit: true }
      : { engine: "acp", explicit: false },
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    prepareAdapterExecutionTargetRuntime,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

function buildContext(config: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("claude_local ACP startup fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not start CLI after default ACP fails", async () => {
    const ctx = buildContext();
    await expect(execute(ctx as never)).rejects.toThrow('Unexpected "<<"');
    expect(executeClaudeAcp).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("trusts the Paperclip API URL when network access is allowlisted", async () => {
    const paperclipApiUrl = "http://127.0.0.1:4310";
    vi.stubEnv("PAPERCLIP_API_URL", paperclipApiUrl);
    const ctx = buildContext({ engine: "cli", networkScope: "allowlist" });

    await execute(ctx as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledWith(
      expect.any(String),
      null,
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        localProcessSandbox: expect.objectContaining({
          networkScope: "allowlist",
          networkTrustedUrls: [paperclipApiUrl],
        }),
      }),
    );
  });

  it("keeps explicit ACP strict when startup fails", async () => {
    const ctx = buildContext({ engine: "acp" });

    await expect(execute(ctx as never)).rejects.toThrow('Unexpected "<<"');

    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("projects only the two Task document tools for an opted-in CLI run", async () => {
    const ctx = buildContext({
      engine: "cli", selfTaskDocumentToolsOnly: true, dangerouslySkipPermissions: false,
      managedAiConnection: { provider: "anthropic" },
    });
    ctx.context = { issueId: "issue-1" };
    const result = await execute({
      ...ctx,
      runtimeMcp: { getServers: () => [{
        name: "Paperclip projects", connectionId: "paperclip-project-tools",
        url: "http://127.0.0.1:3100/api/mcp/project-tools", token: "synthetic-run-token",
      }] },
    } as never);
    expect(result.exitCode).toBe(0);
    const calls = runAdapterExecutionTargetProcess.mock.calls as unknown as Array<[unknown, unknown, unknown, string[]]>;
    const args = calls.find((call) => call[3]?.includes("--print"))?.[3];
    expect(args).toBeDefined();
    expect(args).toEqual(expect.arrayContaining([
      "--restricted", "--setting-sources", "", "--tools", "",
      "--permission-mode", "dontAsk", "--permission-prompts", "none",
      "--strict-mcp-config",
    ]));
    expect(args?.filter((arg) => arg === "--setting-sources")).toHaveLength(1);
    expect(args?.[args.indexOf("--allowedTools") + 1]).toBe(
      "mcp__Paperclip_projects__read_self_task_document,mcp__Paperclip_projects__write_self_task_document",
    );
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("keeps opted-in Task MCP requests off a proxy while retaining provider proxy settings", async () => {
    vi.stubEnv("HTTP_PROXY", "http://proxy.example.invalid:8080");
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example.invalid:8080");
    vi.stubEnv("NO_PROXY", "host.example.invalid");
    vi.stubEnv("no_proxy", "lower.example.invalid");
    const ctx = buildContext({
      engine: "cli", selfTaskDocumentToolsOnly: true, dangerouslySkipPermissions: false,
      env: {
        NO_PROXY: "task.example.invalid",
        HTTP_PROXY: "http://proxy.example.invalid:8080",
        HTTPS_PROXY: "http://proxy.example.invalid:8080",
      },
    });
    ctx.context = { issueId: "issue-1" };
    await execute({
      ...ctx,
      runtimeMcp: { getServers: () => [{
        name: "Paperclip projects", connectionId: "paperclip-project-tools",
        url: "http://127.0.0.1:3100/api/mcp/project-tools", token: "synthetic-run-token",
      }] },
    } as never);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledWith(
      expect.any(String), null, expect.any(String), expect.any(Array),
      expect.objectContaining({ env: expect.objectContaining({
        HTTP_PROXY: "http://proxy.example.invalid:8080",
        HTTPS_PROXY: "http://proxy.example.invalid:8080",
        NO_PROXY: "task.example.invalid,lower.example.invalid,127.0.0.1,localhost,::1,[::1]",
        no_proxy: "task.example.invalid,lower.example.invalid,127.0.0.1,localhost,::1,[::1]",
      }) }),
    );
  });

  it.each([
    [{ engine: "acp", selfTaskDocumentToolsOnly: true, dangerouslySkipPermissions: false }, "self_task_document_tools_configuration_invalid"],
    [{ engine: "cli", selfTaskDocumentToolsOnly: true, dangerouslySkipPermissions: true }, "self_task_document_tools_configuration_invalid"],
    [{ engine: "cli", selfTaskDocumentToolsOnly: true, dangerouslySkipPermissions: false, extraArgs: ["--allowedTools", "Bash"] }, "self_task_document_tools_configuration_invalid"],
  ])("rejects an unsafe Task document projection before CLI launch", async (config, errorCode) => {
    const ctx = buildContext(config);
    ctx.context = { issueId: "issue-1" };
    const result = await execute(ctx as never);
    expect(result.errorCode).toBe(errorCode);
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("rejects absent or additional MCP connections before the opted-in CLI starts", async () => {
    const ctx = buildContext({ engine: "cli", selfTaskDocumentToolsOnly: true, dangerouslySkipPermissions: false });
    ctx.context = { issueId: "issue-1" };
    for (const servers of [[], [
      { name: "Paperclip projects", connectionId: "paperclip-project-tools", url: "http://127.0.0.1:3100/api/mcp/project-tools", token: "synthetic-run-token" },
      { name: "other", connectionId: "other", url: "http://127.0.0.1:3100/other", token: "other" },
    ]]) {
      const result = await execute({ ...ctx, runtimeMcp: { getServers: () => servers } } as never);
      expect(result.errorCode).toBe("self_task_document_tools_configuration_invalid");
      expect(result.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
    }
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("rejects an opted-in remote target before CLI launch", async () => {
    const ctx = buildContext({ engine: "cli", selfTaskDocumentToolsOnly: true, dangerouslySkipPermissions: false });
    ctx.context = { issueId: "issue-1" };
    const result = await execute({
      ...ctx,
      runtimeMcp: { getServers: () => [{
        name: "Paperclip projects", connectionId: "paperclip-project-tools",
        url: "http://127.0.0.1:3100/api/mcp/project-tools", token: "synthetic-run-token",
      }] },
      executionTransport: { remoteExecution: {
        host: "127.0.0.1", port: 2222, username: "fixture",
        remoteWorkspacePath: "/remote/workspace", remoteCwd: "/remote/workspace",
        privateKey: "SYNTHETIC KEY", knownHosts: "[127.0.0.1]:2222 ssh-ed25519 SYNTHETIC",
        strictHostKeyChecking: true,
      } },
    } as never);
    expect(result.errorCode).toBe("self_task_document_tools_configuration_invalid");
    expect(result.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("does not start a fresh session after an opted-in document run loses its resumed session", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: 1, signal: null, timedOut: false,
      stdout: JSON.stringify({ type: "result", is_error: true, result: "No conversation found with session id old-session" }),
      stderr: "", pid: 123, startedAt: new Date().toISOString(),
    });
    const ctx = buildContext({ engine: "cli", selfTaskDocumentToolsOnly: true, dangerouslySkipPermissions: false });
    ctx.context = { issueId: "issue-1" };
    const result = await execute({
      ...ctx, runtime: { ...ctx.runtime, sessionId: "11111111-1111-4111-8111-111111111111" },
      runtimeMcp: { getServers: () => [{
        name: "Paperclip projects", connectionId: "paperclip-project-tools",
        url: "http://127.0.0.1:3100/api/mcp/project-tools", token: "synthetic-run-token",
      }] },
    } as never);
    expect(result.exitCode).toBe(1);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(ctx.onLog).toHaveBeenCalledWith("stderr", expect.stringContaining("no fresh-session retry"));
  });
});
