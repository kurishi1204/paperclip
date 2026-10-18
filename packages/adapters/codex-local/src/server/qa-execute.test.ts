import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
const { run, acl } = vi.hoisted(() => ({ run: vi.fn(), acl:vi.fn() }));
vi.mock("node:child_process",()=>{const execFile=()=>{};Object.assign(execFile,{[Symbol.for("nodejs.util.promisify.custom")]:async()=>({stdout:acl(),stderr:""})});return {execFile};});
vi.mock("@paperclipai/adapter-utils/execution-target", () => ({ runAdapterExecutionTargetProcess: run }));
import { executeCodexQa, QA_TOOLS, QA_TRUSTED_COMMAND, QA_TRUSTED_CODE_MODE_HOST } from "./qa-execute.js";
import { runningProcesses, getQaReviewProcess } from "@paperclipai/adapter-utils/server-utils";
const homes: string[] = [];
it("retains a route hold after map deletion and raw exit0/deadline, bound only after the version probe", async () => {
  const ctx = await context();
  ctx.onSpawn = async () => { throw new Error("metadata persistence fixture"); };
  run.mockResolvedValueOnce({ exitCode: 0, stdout: "codex-cli 0.154.0" }).mockImplementationOnce(async (...args) => {
    expect(getQaReviewProcess(ctx.runId)).toBeNull();
    const spawned = args[4].onSpawn({ pid: 12345678, processGroupId: null, startedAt: new Date().toISOString() });
    runningProcesses.set(ctx.runId, { child: { pid: 12345678 } as never, graceSec: 10, processGroupId: null });
    await spawned.catch(() => undefined); // real runner logs metadata failures
    const binding = getQaReviewProcess(ctx.runId)!;
    expect(binding).not.toBeNull();
    binding.control.requestedHold = { reason: "qa_review_read_hold", runId: ctx.runId,
      companyId: "fixture-company", issueId: "fixture-issue", agentId: "fixture-agent",
      currentStageId: "fixture-stage", statusVersion: 3, lastDecisionId: null };
    runningProcesses.delete(ctx.runId);
    expect(args[4].stdin).toContain("Use each tool's own published input schema and defaults");
    expect(args[4].stdin).toContain("List limits count records; text limits use the unit of that tool");
    expect(args[4].stdin).toContain("Omit optional limit and offset on the first call");
    expect(args[4].stdin).toContain("each successful response's actual returned continuation field");
    expect(args[4].stdin).toContain("Treat null as EOF only on a successful page");
    expect(args[4].stdin).toContain("Retain each successful page and its EOF marker at the same issue revision");
    expect(args[4].stdin).toContain("reuse returned item IDs to read text instead of re-requesting a completed page");
    expect(args[4].stdin).not.toMatch(/max\d|\d/);
    return { exitCode: 0, signal: "SIGTERM", timedOut: true, stdout: '{"type":"turn.completed"}\n', stderr: "" };
  });
  const result = await executeCodexQa(ctx);
  expect(result).toMatchObject({ exitCode: 1, signal: null, timedOut: false,
    errorCode: "configuration_incomplete", errorFamily: "configuration" });
  expect(result.resultJson).toMatchObject({ configurationIncomplete: { reason: "qa_review_read_hold" },
    qaReviewRawOutcome: { exitCode: 0, signal: "SIGTERM", timedOut: true } });
  expect(run.mock.calls[0][4].onSpawn).toBe(ctx.onSpawn);
});
it("uses the sealed executor for a commander with no MCP, no run token and only its server snapshot",async()=>{
  const ctx=await context();ctx.config={...ctx.config,qaReviewToolsOnly:false,commanderCycleToolsOnly:true};
  ctx.authToken=undefined;ctx.runtimeMcp={getServers:()=>[]};ctx.context={paperclipCommanderPrompt:"SERVER SNAPSHOT ONLY"};
  let configured="";
  run.mockResolvedValueOnce({exitCode:0,stdout:"codex-cli 0.154.0\n"}).mockImplementationOnce(async(...args)=>{
    configured=await fs.readFile(path.join(args[4].env.CODEX_HOME,"config.toml"),"utf8");
    return {exitCode:0,signal:null,timedOut:false,stdout:'{"type":"item.completed","item":{"type":"agent_message","text":"commander fixture"}}\n{"type":"turn.completed"}\n',stderr:""};
  });
  expect((await executeCodexQa(ctx)).exitCode).toBe(0);
  const [,target,command,args,options]=run.mock.calls[1];
  expect(target).toBeNull();expect(command).toBe(QA_TRUSTED_COMMAND);expect(options.inheritHostEnv).toBe(false);
  expect(options.stdin).toBe("SERVER SNAPSHOT ONLY");expect(options.env.PAPERCLIP_QA_TOKEN).toBeUndefined();
  expect(configured).toBe('cli_auth_credentials_store="file"\n');expect(args).toContain("features.shell_tool=false");
  expect(args).toContain("features.code_mode_host=true");
});
it.each(["mcp","token","qa_flag","missing_snapshot"])("rejects commander authority contamination: %s",async kind=>{
  const ctx=await context();ctx.config={...ctx.config,qaReviewToolsOnly:false,commanderCycleToolsOnly:true};
  ctx.authToken=undefined;ctx.runtimeMcp={getServers:()=>[]};ctx.context={paperclipCommanderPrompt:"SERVER SNAPSHOT ONLY"};
  if(kind==="mcp")ctx.runtimeMcp={getServers:()=>[{name:"paperclip_qa",connectionId:"paperclip-qa-review",url:"http://127.0.0.1:3317/api/mcp/qa-review",token:"PUBLIC_FIXTURE_TOKEN"}]};
  if(kind==="token")ctx.authToken="PUBLIC_FIXTURE_TOKEN";
  if(kind==="qa_flag")ctx.config.qaReviewToolsOnly=true;
  if(kind==="missing_snapshot")ctx.context={};
  expect((await executeCodexQa(ctx)).errorCode).toBe("commander_cycle_configuration_invalid");expect(run).not.toHaveBeenCalled();
});
const oldCompanionHash=process.env.PAPERCLIP_CODEX_QA_TRUSTED_CODE_MODE_HOST_SHA256;
const oldCommand=process.env.PAPERCLIP_CODEX_QA_TRUSTED_COMMAND,oldHash=process.env.PAPERCLIP_CODEX_QA_TRUSTED_COMMAND_SHA256;
afterEach(async () => { run.mockReset();if(oldCompanionHash===undefined)delete process.env.PAPERCLIP_CODEX_QA_TRUSTED_CODE_MODE_HOST_SHA256;else process.env.PAPERCLIP_CODEX_QA_TRUSTED_CODE_MODE_HOST_SHA256=oldCompanionHash;vi.restoreAllMocks();acl.mockReset(); if(oldCommand===undefined)delete process.env.PAPERCLIP_CODEX_QA_TRUSTED_COMMAND;else process.env.PAPERCLIP_CODEX_QA_TRUSTED_COMMAND=oldCommand;if(oldHash===undefined)delete process.env.PAPERCLIP_CODEX_QA_TRUSTED_COMMAND_SHA256;else process.env.PAPERCLIP_CODEX_QA_TRUSTED_COMMAND_SHA256=oldHash; await Promise.all(homes.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });
async function context(): Promise<AdapterExecutionContext> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "qa-adapter-test-")); homes.push(home);
  const bin=path.join(home,"trusted-codex");await fs.writeFile(bin,"pinned fixture",{mode:0o555});process.env.PAPERCLIP_CODEX_QA_TRUSTED_COMMAND=QA_TRUSTED_COMMAND;
  const companion=path.join(home,"trusted-code-mode-host");await fs.writeFile(companion,"pinned companion",{mode:0o555});process.env.PAPERCLIP_CODEX_QA_TRUSTED_CODE_MODE_HOST_SHA256=createHash("sha256").update("pinned companion").digest("hex");
  const open=fs.open.bind(fs),lstat=fs.lstat.bind(fs);
  vi.spyOn(fs,"open").mockImplementation(async(...args)=>{const h=await open(args[0]===QA_TRUSTED_COMMAND?bin:args[0]===QA_TRUSTED_CODE_MODE_HOST?companion:args[0],args[1],args[2]);if(args[0]===QA_TRUSTED_COMMAND||args[0]===QA_TRUSTED_CODE_MODE_HOST){const stat=h.stat.bind(h);vi.spyOn(h,"stat").mockImplementation(async()=>Object.assign(await stat(),{uid:0}));}return h;});
  vi.spyOn(fs,"lstat").mockImplementation(async p=>{const st=await lstat(p===QA_TRUSTED_CODE_MODE_HOST?companion:bin);return Object.assign(st,{uid:0,mode:0o555,isSymbolicLink:()=>false,isDirectory:()=>p!==QA_TRUSTED_COMMAND&&p!==QA_TRUSTED_CODE_MODE_HOST,isFile:()=>p===QA_TRUSTED_COMMAND||p===QA_TRUSTED_CODE_MODE_HOST});});
  acl.mockReturnValue("dr-xr-xr-x  1 root wheel 1 fixed-path\n");process.env.PAPERCLIP_CODEX_QA_TRUSTED_COMMAND_SHA256=createHash("sha256").update("pinned fixture").digest("hex");
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
  expect(opts.env.CODEX_HOME).toBe((ctx.config.env as Record<string,string>).CODEX_HOME);
  expect(Object.keys(opts.env).sort()).toEqual(["CODEX_HOME", "HOME", "PAPERCLIP_QA_TOKEN", "PATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME"].sort());
  const config=capturedConfig;
  await expect(fs.access(opts.env.HOME)).rejects.toThrow();await expect(fs.access(path.join(opts.env.CODEX_HOME,"auth.json"))).resolves.toBeUndefined();
  expect(config).toContain('cli_auth_credentials_store="file"');expect(config).toContain(JSON.stringify(QA_TOOLS)); expect(config).not.toContain("fixture-token");
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
 const ctx=await context();const bin=path.join((ctx.config.env as Record<string,string>).HOME,"trusted-codex");await fs.chmod(bin,0o755);await fs.writeFile(bin,"changed");
 expect((await executeCodexQa(ctx)).errorCode).toBe("qa_review_configuration_invalid");expect(run).not.toHaveBeenCalled();
});
it("rejects symlink executable seals before provider work",async()=>{
 const ctx=await context();const link=path.join((ctx.config.env as Record<string,string>).HOME,"alias");await fs.symlink(path.join((ctx.config.env as Record<string,string>).HOME,"trusted-codex"),link);process.env.PAPERCLIP_CODEX_QA_TRUSTED_COMMAND=link;
 expect((await executeCodexQa(ctx)).errorCode).toBe("qa_review_configuration_invalid");expect(run).not.toHaveBeenCalled();
});

it("accepts the actual heartbeat local lease target and keeps execution local",async()=>{
 const ctx=await context();Object.assign(ctx,{executionTarget:{kind:"local",environmentId:"fixture-env",leaseId:"fixture-lease"}});
 run.mockResolvedValueOnce({exitCode:0,stdout:"codex-cli 0.154.0"}).mockResolvedValueOnce({exitCode:0,stdout:'{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n',stderr:""});
 expect((await executeCodexQa(ctx)).exitCode).toBe(0);expect(run.mock.calls[1][1]).toBeNull();
});
it("rejects remote execution targets before invoking the sealed binary",async()=>{
 const ctx=await context();Object.assign(ctx,{executionTarget:{kind:"remote",environmentId:"fixture-env",leaseId:"fixture-lease",transport:"sandbox"}});
 expect((await executeCodexQa(ctx)).errorCode).toBe("qa_review_configuration_invalid");expect(run).not.toHaveBeenCalled();
});

it("rejects a writable parent before executing the trusted leaf",async()=>{
 const ctx=await context();run.mockResolvedValueOnce({exitCode:0,stdout:"codex-cli 0.154.0"}).mockResolvedValueOnce({exitCode:0,stdout:'{"type":"turn.completed"}\n',stderr:""});const stat=await fs.lstat("/opt");vi.mocked(fs.lstat).mockResolvedValueOnce(Object.assign(stat,{mode:0o777}));
 expect((await executeCodexQa(ctx)).errorCode).toBe("qa_review_configuration_invalid");expect(run).not.toHaveBeenCalled();
});
it("rejects parent ACLs before executing the trusted leaf",async()=>{
 const ctx=await context();run.mockResolvedValueOnce({exitCode:0,stdout:"codex-cli 0.154.0"}).mockResolvedValueOnce({exitCode:0,stdout:'{"type":"turn.completed"}\n',stderr:""});acl.mockReturnValue("dr-xr-xr-x+ 1 root wheel 1 fixed-path\n 0: user:fixture allow write\n");
 expect((await executeCodexQa(ctx)).errorCode).toBe("qa_review_configuration_invalid");expect(run).not.toHaveBeenCalled();
});
it("rejects a non-root parent before executing the trusted leaf",async()=>{
 const ctx=await context();run.mockResolvedValueOnce({exitCode:0,stdout:"codex-cli 0.154.0"}).mockResolvedValueOnce({exitCode:0,stdout:'{"type":"turn.completed"}\n',stderr:""});const stat=await fs.lstat("/opt");vi.mocked(fs.lstat).mockResolvedValueOnce(Object.assign(stat,{uid:501}));
 expect((await executeCodexQa(ctx)).errorCode).toBe("qa_review_configuration_invalid");expect(run).not.toHaveBeenCalled();
});

it("returns rotated subscription credentials to managed cleanup before deleting disposable HOME",async()=>{
 const ctx=await context();run.mockResolvedValueOnce({exitCode:0,stdout:"codex-cli 0.154.0"}).mockImplementationOnce(async(...args)=>{await fs.writeFile(path.join(args[4].env.CODEX_HOME,"auth.json"),'{"fixture":"rotated"}');return {exitCode:0,stdout:'{"type":"turn.completed"}\n',stderr:""};});
 await executeCodexQa(ctx);expect(await fs.readFile(path.join((ctx.config.env as Record<string,string>).CODEX_HOME,"auth.json"),"utf8")).toBe('{"fixture":"rotated"}');await expect(fs.access(run.mock.calls[1][4].env.HOME)).rejects.toThrow();
});

it.each(["ENOSPC","EIO"])("keeps the sole managed credential without a copyback failure path: %s",async code=>{
 const ctx=await context();const realCopy=fs.copyFile.bind(fs);let copies=0;const copy=vi.spyOn(fs,"copyFile").mockImplementation(async(...args)=>{if(++copies===1)return realCopy(...args);throw Object.assign(new Error("fixture copyback failure"),{code});});
 run.mockResolvedValueOnce({exitCode:0,stdout:"codex-cli 0.154.0"}).mockImplementationOnce(async(...args)=>{await fs.writeFile(path.join(args[4].env.CODEX_HOME,"auth.json"),'{"fixture":"rotated"}');return {exitCode:0,stdout:'{"type":"turn.completed"}\n',stderr:""};});
 let result;try{result=await executeCodexQa(ctx);}catch{}expect(await fs.readFile(path.join((ctx.config.env as Record<string,string>).CODEX_HOME,"auth.json"),"utf8")).toBe('{"fixture":"rotated"}');expect(result?.exitCode).toBe(0);expect(copy).not.toHaveBeenCalled();
});

it("rejects missing required code-mode host before provider work",async()=>{ const ctx=await context(); run.mockResolvedValueOnce({exitCode:0,stdout:"codex-cli 0.154.0"}).mockResolvedValueOnce({exitCode:0,stdout:'{"type":"turn.completed"}\n',stderr:""}); await fs.unlink(path.join((ctx.config.env as Record<string,string>).HOME,"trusted-code-mode-host")); expect((await executeCodexQa(ctx)).errorCode).toBe("qa_review_configuration_invalid"); expect(run).not.toHaveBeenCalled(); });
it("rejects changed code-mode host content before provider work",async()=>{ const ctx=await context();run.mockResolvedValueOnce({exitCode:0,stdout:"codex-cli 0.154.0"}).mockResolvedValueOnce({exitCode:0,stdout:'{"type":"turn.completed"}\n',stderr:""});const p=path.join((ctx.config.env as Record<string,string>).HOME,"trusted-code-mode-host");await fs.chmod(p,0o755);await fs.writeFile(p,"changed companion");expect((await executeCodexQa(ctx)).errorCode).toBe("qa_review_configuration_invalid");expect(run).not.toHaveBeenCalled(); });
