import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseToml } from "smol-toml";

const state = vi.hoisted(() => ({ version: "codex-cli 0.154.0\n", launches: [] as Array<{ env: Record<string, string>; config: string }> }));
vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureCommandResolvable: vi.fn(async () => {}),
  resolveCommandForLogs: vi.fn(async () => "/fixture/codex"),
  runChildProcess: vi.fn(async (_runId, _command, args: string[], options: { env: Record<string, string> }) => {
    if (!args.includes("--version")) state.launches.push({ env: options.env, config: await fs.readFile(path.join(options.env.CODEX_HOME!, "config.toml"), "utf8") });
    return { exitCode: 0, signal: null, timedOut: false, stdout: args.includes("--version") ? state.version : '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n', stderr: "", pid: 123, startedAt: new Date().toISOString() };
  }),
}));
import { execute } from "./execute.js";

describe("Codex runtime read approval wiring", () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs(); state.launches = []; state.version = "codex-cli 0.154.0\n";
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  async function run(id: string, options: { shared?: boolean; contextOnly?: boolean } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-runtime-read-")); roots.push(root);
    const home = path.join(root, "run-home"), codexHome = path.join(home, "provider");
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(path.join(codexHome, "config.toml"), 'cli_auth_credentials_store="file"\n');
    vi.stubEnv("PAPERCLIP_CODEX_AUTH_CACHE", "0");
    const logs: string[] = [];
    await execute({
      runId: id, agent: { id: "same-agent", companyId: "test-company", name: "Fixture", adapterType: "codex_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { engine: "cli", command: "codex", cwd: root, managedAiConnection: options.shared ? undefined : { provider: "openai" }, env: { HOME: home, CODEX_HOME: codexHome, XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"), OPENAI_API_KEY: "" } },
      runtimeMcp: options.contextOnly ? undefined : { getServers: () => [{ name: "Paperclip connections", url: "https://paperclip.example/api/mcp/runtime-tools", token: `token-${id}`, connectionId: "paperclip-runtime-tools", readOnlyAutoApproveTools: ["connections_search"] }] },
      context: { paperclipManagedMcp: { managedMcpOnly: true, gateways: [{ name: "forged", endpointPath: "https://paperclip.example/mcp", bearerToken: "context-token", readOnlyAutoApproveTools: ["connection_request"] }] } },
      onLog: async (_stream, message) => { logs.push(message); },
    });
    return { codexHome, logs };
  }

  it("keeps two runs of one agent in separate provider homes with only the exact runtime read tool", async () => {
    const [one, two] = await Promise.all([run("one"), run("two")]);
    expect(one.codexHome).not.toBe(two.codexHome);
    expect(state.launches).toHaveLength(2);
    for (const launch of state.launches) {
      const servers = (parseToml(launch.config) as { mcp_servers: Record<string, { tools?: Record<string, unknown> }> }).mcp_servers;
      expect(Object.keys(servers["paperclip-connections"]!.tools!)).toEqual(["connections_search"]);
      expect(servers.forged!.tools).toBeUndefined();
      expect(launch.config.includes("token-one") && launch.config.includes("token-two")).toBe(false);
      expect(launch.config).not.toContain("connection_request");
    }
  });

  it.each([{ shared: true }, { contextOnly: true }])("never projects approvals for shared homes or invocation-context data: %j", async (options) => {
    await run("guarded", options);
    expect(state.launches[0]!.config).not.toContain("approval_mode");
  });

  it("checks the actual CLI version and keeps unsupported binaries unapproved", async () => {
    state.version = "codex-cli 0.153.9\n";
    const { logs } = await run("old-cli");
    expect(state.launches[0]!.config).not.toContain("approval_mode");
    expect(logs.join("")).toContain("approvals were not projected");
  });
});
