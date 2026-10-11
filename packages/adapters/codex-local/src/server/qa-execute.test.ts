import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@paperclipai/adapter-utils/execution-target", () => ({ runAdapterExecutionTargetProcess: run }));
import { executeCodexQa, QA_TOOLS } from "./qa-execute.js";
const homes: string[] = [];
const oldCommand=process.env.PAPERCLIP_CODEX_QA_TRUSTED_COMMAND,oldHash=process.env.PAPERCLIP_CODEX_QA_TRUSTED_COMMAND_SHA256;
afterEach(async () => { run.mockReset(); if(oldCommand===undefined)delete process.env.PAPERCLIP_CODEX_QA_TRUSTED_COMMAND;else process.env.PAPERCLIP_CODEX_QA_TRUSTED_COMMAND=oldCommand;if(oldHash===undefined)delete process.env.PAPERCLIP_CODEX_QA_TRUSTED_COMMAND_SHA256;else process.env.PAPERCLIP_CODEX_QA_TRUSTED_COMMAND_SHA256=oldHash; await Promise.all(homes.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });
async function context(): Promise<AdapterExecutionContext> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "qa-adapter-test-")); homes.push(home);
  const bin=path.join(home,"trusted-codex");await fs.writeFile(bin,"pinned fixture",{mode:0o555});process.env.PAPERCLIP_CODEX_QA_TRUSTED_COMMAND=bin;process.env.PAPERCLIP_CODEX_QA_TRUSTED_COMMAND_SHA256=createHash("sha256").update("pinned fixture").digest("hex");
  await fs.mkdir(path.join(home, "provider")); await fs.writeFile(path.join(home, "provider/auth.json"), '{"fixture":true}');
  return { runId: "fixture", config: { qaReviewToolsOnly: true, engine: "cli", managedAiConnection: { provider: "openai" }, env: { HOME: home, CODEX_HOME: path.join(home, "provider"), XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data") } }, authToken: "fixture-token", runtimeMcp: { getServers: () => [{ name: "paperclip_qa", connectionId: "paperclip-qa-review", url: "http://127.0.0.1:3317/api/mcp/qa-review", token: "fixture-token" }] }, onLog: async () => {} } as unknown as AdapterExecutionContext;
}
it("isolates managed credentials and launches only the pinned, restricted QA surface", async () => {
  const ctx = await context();let capturedConfig="";
  run.mockResolvedValueOnce({ exitCode: 0, stdout: "codex-cli 0.154.0\n" }).mockImplementationOnce(async (...args) => {capturedConfig=await fs.readFile(path.join(args[4].env.CODEX_HOME,"config.toml"),"utf8");return { exitCode: 0, signal: null, timedOut: false, stdout: '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n', stderr: "" };});
  const result = await executeCodexQa(ctx);
  expect(result.exitCode).toBe(0); expect(result.clearSession).toBe(true);
  const [, target, command, args, opts] = run.mock.calls[1];
  expect(target).toBeNull(); expect(command).toBe(process.env.PAPERCLIP_CODEX_QA_TRUSTED_COMMAND); expect(opts.inheritHostEnv).toBe(false);
  expect(args).toContain("features.shell_tool=false"); expect(args).toContain("features.apps=false");
  expect(args).toContain('web_search="disabled"'); expect(args).not.toContain("resume");
  expect(opts.env.CODEX_HOME).not.toBe((ctx.config.env as Record<string,string>).CODEX_HOME);
  expect(Object.keys(opts.env).sort()).toEqual(["CODEX_HOME", "HOME", "PAPERCLIP_QA_TOKEN", "PATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME"].sort());
  const config=capturedConfig;
  await expect(fs.access(opts.env.CODEX_HOME)).rejects.toThrow();
  expect(config).toContain(JSON.stringify(QA_TOOLS)); expect(config).not.toContain("fixture-token");
});
it("refuses an unverified CLI version before starting provider work", async () => {
  const ctx = await context(); run.mockResolvedValue({ exitCode: 0, stdout: "codex-cli 0.155.0" });
  expect((await executeCodexQa(ctx)).errorCode).toBe("qa_review_configuration_invalid"); expect(run).toHaveBeenCalledTimes(1);
});
it.each([{ dangerouslySkipPermissions: true }, { extraArgs: ["--yolo"] }, { engine: "acp" }])("rejects escape configuration %j", async delta => {
  const ctx = await context(); Object.assign(ctx.config, delta);
  expect((await executeCodexQa(ctx)).exitCode).toBe(1); expect(run).not.toHaveBeenCalled();
});
it("does not count an exit-zero incomplete protocol as QA success", async () => {
  const ctx = await context(); run.mockResolvedValueOnce({ exitCode: 0, stdout: "codex-cli 0.154.0" }).mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
  expect((await executeCodexQa(ctx)).errorCode).toBe("qa_review_protocol_incomplete");
});

it("refuses missing operator binary seal even when PATH runtime claims the verified version", async () => {
  const ctx=await context();run.mockResolvedValue({exitCode:0,stdout:"codex-cli 0.154.0"});
  delete process.env.PAPERCLIP_CODEX_QA_TRUSTED_COMMAND;delete process.env.PAPERCLIP_CODEX_QA_TRUSTED_COMMAND_SHA256;
  expect((await executeCodexQa(ctx)).errorCode).toBe("qa_review_configuration_invalid");
  expect(run).not.toHaveBeenCalled();
});

it("rejects changed executable content before invoking even a version probe",async()=>{
 const ctx=await context();await fs.chmod(process.env.PAPERCLIP_CODEX_QA_TRUSTED_COMMAND!,0o755);await fs.writeFile(process.env.PAPERCLIP_CODEX_QA_TRUSTED_COMMAND!,"changed");
 expect((await executeCodexQa(ctx)).errorCode).toBe("qa_review_configuration_invalid");expect(run).not.toHaveBeenCalled();
});
it("rejects symlink executable seals before provider work",async()=>{
 const ctx=await context();const link=path.join((ctx.config.env as Record<string,string>).HOME,"alias");await fs.symlink(process.env.PAPERCLIP_CODEX_QA_TRUSTED_COMMAND!,link);process.env.PAPERCLIP_CODEX_QA_TRUSTED_COMMAND=link;
 expect((await executeCodexQa(ctx)).errorCode).toBe("qa_review_configuration_invalid");expect(run).not.toHaveBeenCalled();
});
