import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { execute } from "./execute.js";

describe("bounded Hermes real child boundary", () => {
  it("passes only the selected home and excludes service secrets at the actual spawn", async () => {
    const stage = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hermes-real-spawn-")));
    const home = path.join(stage, "home");
    const fakeHermes = path.join(stage, "fake-hermes");
    const names = ["PAPERCLIP_HERMES_BOUNDED_AGENT_ID", "PAPERCLIP_HERMES_BOUNDED_HOME", "PAPERCLIP_HERMES_TRUSTED_COMMAND", "PAPERCLIP_HERMES_TRUSTED_COMMAND_SHA256", "ANTHROPIC_API_KEY", "HERMES_YOLO_MODE"] as const;
    const original = Object.fromEntries(names.map((name) => [name, process.env[name]])) as Record<string, string | undefined>;
    try {
      await fs.mkdir(home, { mode: 0o700 });
      await fs.writeFile(fakeHermes, [
        "#!/usr/bin/env node",
        "const keys = ['ANTHROPIC_API_KEY', 'PAPERCLIP_API_KEY', 'PAPERCLIP_RUNTIME_TOOLS_TOKEN', 'PAPERCLIP_HERMES_BOUNDED_AGENT_ID', 'PAPERCLIP_HERMES_BOUNDED_HOME', 'PAPERCLIP_HERMES_TRUSTED_COMMAND', 'HERMES_YOLO_MODE', 'PAPERCLIP_RUN_SCRATCH_DIR', 'GH_TOKEN'];",
        "const seen = Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]));",
        "seen.HERMES_HOME = process.env.HERMES_HOME; seen.HOME = process.env.HOME;",
        "seen.argv = process.argv.slice(2);",
        "const events = [",
        "  {type:'system',subtype:'init',session_id:'actual-cli-session'},",
        "  {type:'tool_use',name:'web_search',input:{query:'public source'}},",
        "  {type:'tool_result',name:'web_search',is_error:false,output:JSON.stringify({success:true,data:{web:[{url:'https://example.org/source'}]}})},",
        "  {type:'result',session_id:'actual-cli-session',exit_code:0,text:JSON.stringify(seen)},",
        "];",
        "process.stdout.write(events.map(x => JSON.stringify(x)).join('\\n') + '\\n');",
      ].join("\n"), { mode: 0o755 });
      await fs.chmod(fakeHermes, 0o755);
      process.env.PAPERCLIP_HERMES_BOUNDED_AGENT_ID = "bounded-fixture-agent";
      process.env.PAPERCLIP_HERMES_BOUNDED_HOME = home;
      process.env.PAPERCLIP_HERMES_TRUSTED_COMMAND = fakeHermes;
      process.env.PAPERCLIP_HERMES_TRUSTED_COMMAND_SHA256 = createHash("sha256").update(await fs.readFile(fakeHermes)).digest("hex");
      process.env.ANTHROPIC_API_KEY = "synthetic-unrelated-host-key";
      process.env.HERMES_YOLO_MODE = "1";
      const result = await execute({
        runId: "bounded-real-child-fixture",
        agent: { id: "bounded-fixture-agent", companyId: "fixture-company", name: "Research", adapterType: "hermes_local", adapterConfig: {} },
        config: { boundedExecution: true, provider: "openai-codex", model: "gpt-6.1-sol", reasoningEffort: "high", toolsets: "search", maxTurnsPerRun: 2, env: { HERMES_HOME: home, PAPERCLIP_RUN_SCRATCH_DIR: stage, GH_TOKEN: "synthetic-git-key" } },
        context: { issueId: "fixture-issue", paperclipWorkspace: { cwd: stage } },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        authToken: "synthetic-paperclip-token",
        runtimeTools: {
          mcpEndpoint: "http://127.0.0.1/private", bearerToken: "synthetic-runtime-token",
          expiresAt: "2026-10-11T00:00:00Z", tools: ["connections_search"], guidance: "private guidance",
          rest: { connectionsSearch: "http://127.0.0.1/search", connectionRequest: "http://127.0.0.1/request" },
        },
        onLog: async () => {},
        onMeta: async () => {},
      } as any);
      expect(result.exitCode).toBe(0);
      const seen = JSON.parse((result.resultJson as { result: string }).result);
      for (const name of ["ANTHROPIC_API_KEY", "PAPERCLIP_API_KEY", "PAPERCLIP_RUNTIME_TOOLS_TOKEN", "PAPERCLIP_HERMES_BOUNDED_AGENT_ID", "PAPERCLIP_HERMES_BOUNDED_HOME", "PAPERCLIP_HERMES_TRUSTED_COMMAND", "HERMES_YOLO_MODE", "PAPERCLIP_RUN_SCRATCH_DIR", "GH_TOKEN"]) {
        expect(seen[name]).toBeNull();
      }
      expect(seen.HERMES_HOME).toBe(home);
      expect(seen.argv).toEqual(["chat", "-q", expect.any(String), "-Q",
        "--ignore-user-config", "--ignore-rules", "--format", "stream-json",
        "-m", "gpt-6.1-sol", "--provider", "openai-codex", "--reasoning", "high",
        "-t", "search", "--max-turns", "2", "--source", "tool"]);
      expect(seen.HOME).not.toBe(process.env.HOME);
      expect(seen.HOME).not.toBe(stage);
      expect(result.sessionParams).toBeUndefined();
      expect(result.clearSession).toBe(true);
      expect((result.resultJson as { session_id: string }).session_id).toBe("actual-cli-session");
      await expect(fs.stat(seen.HOME)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      for (const name of names) {
        if (original[name] === undefined) delete process.env[name];
        else process.env[name] = original[name];
      }
      await fs.rm(stage, { recursive: true, force: true });
    }
  });
});
