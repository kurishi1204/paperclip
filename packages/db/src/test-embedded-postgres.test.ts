import { proveNormalOwnedCleanup } from "./test-embedded-postgres-ipc.js";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupCompletedEmbeddedPostgresTestDatadirs,
  __embeddedPostgresStartMaxAttemptsForTests as MAX_ATTEMPTS,
  __setEmbeddedPostgresCtorProviderForTests,
  __startEmbeddedPostgresWithRetryForTests as startWithRetry,
} from "./test-embedded-postgres.js";

// A fake embedded-postgres constructor. It records every constructed instance so
// the test can assert the retry uses a fresh port and a fresh data directory each
// attempt. `start()` emits the same output the real cluster writes for a port
// conflict, then rejects with an empty message (the real rejection shape). The
// option type matches the real constructor so no type cast is needed.
type FakeOptions = {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
};

const ipcFinish=vi.hoisted(()=>vi.fn(async(options:{initializationUnproven?:boolean}={})=>{
  if(options.initializationUnproven)throw new Error("Initialization exit unproven; no cleanup");
  return {dataDirCleanupAllowed:true};
}));
vi.mock("./test-embedded-postgres-ipc.js",async()=>({...await vi.importActual<typeof import("./test-embedded-postgres-ipc.js")>("./test-embedded-postgres-ipc.js"),beginTestIpc:()=>({record:()=>{},finish:ipcFinish,snapshot:()=>[]})}));
const BIND_CONFLICT_LOG = 'could not bind IPv4 address "127.0.0.1": Address already in use';

function makeFakeCtor(failFirst: number) {
  const constructed: FakeOptions[] = [];
  let started = 0;

  class FakeEmbeddedPostgres {
    private readonly options: FakeOptions;
    constructor(options: FakeOptions) {
      this.options = options;
      constructed.push(options);
    }
    async initialise(): Promise<void> {}
    async start(): Promise<void> {
      started += 1;
      if (started <= failFirst) {
        // Mirror the real failure: Postgres logs the reason, then `start()`
        // rejects with an Error whose message is empty.
        this.options.onLog?.(BIND_CONFLICT_LOG);
        throw new Error();
      }
    }
    async stop(): Promise<void> {}
  }

  return { ctor: FakeEmbeddedPostgres, constructed };
}

describe("startEmbeddedPostgresWithRetry", () => {
  afterEach(() => {
    __setEmbeddedPostgresCtorProviderForTests(null);
  });

  it("recovers from a transient port conflict and returns on a later attempt", async () => {
    const { ctor, constructed } = makeFakeCtor(2);
    __setEmbeddedPostgresCtorProviderForTests(async () => ctor);

    const started = await startWithRetry("paperclip-retry-recover-");

    // The first two attempts fail, the third succeeds.
    expect(constructed).toHaveLength(3);

    // Each attempt uses a fresh data directory. The two failed directories are
    // retained. The returned directory still exists.
    const dataDirs = constructed.map((options) => options.databaseDir);
    expect(new Set(dataDirs).size).toBe(3);
    expect(fs.existsSync(dataDirs[0])).toBe(true);
    expect(fs.existsSync(dataDirs[1])).toBe(true);
    expect(started.dataDir).toBe(dataDirs[2]);
    expect(fs.existsSync(started.dataDir)).toBe(true);

    // Each attempt allocates a port.
    for (const options of constructed) {
      expect(Number.isInteger(options.port)).toBe(true);
      expect(options.port).toBeGreaterThan(0);
    }

    // Clean up the returned attempt.
    await started.instance.stop();
    // Retained under explicit owner direction.
  });

  it("throws with the real Postgres output after the attempt bound", async () => {
    const { ctor, constructed } = makeFakeCtor(Number.POSITIVE_INFINITY);
    __setEmbeddedPostgresCtorProviderForTests(async () => ctor);

    await expect(startWithRetry("paperclip-retry-fail-")).rejects.toThrow(/after \d+ attempts/);

    // The retry stops at the bound and does not loop forever.
    expect(constructed).toHaveLength(MAX_ATTEMPTS);

    // Every failed attempt retains its data directory.
    for (const options of constructed) {
      expect(fs.existsSync(options.databaseDir)).toBe(true);
    }
  });

  it("keeps the real failure reason instead of a generic fallback", async () => {
    const { ctor } = makeFakeCtor(Number.POSITIVE_INFINITY);
    __setEmbeddedPostgresCtorProviderForTests(async () => ctor);

    const error = await startWithRetry("paperclip-retry-reason-").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    // The thrown message carries the captured Postgres output, not only the
    // generic "embedded Postgres startup failed" text.
    expect((error as Error).message).toContain("Address already in use");
  });
  it.each(["shmget: No space left on device","shmat: Operation not permitted"])("does not retry resource failure %s",async reason=>{
    let calls=0;let directory="";
    class ResourceFailure {
      constructor(options:FakeOptions){calls++;directory=options.databaseDir;}
      async initialise(){throw new Error(reason);}
      async start(){}
      async stop(){}
    }
    __setEmbeddedPostgresCtorProviderForTests(async()=>ResourceFailure);
    await expect(startWithRetry("qa-resource-refusal-")).rejects.toThrow(reason);
    expect(calls).toBe(1);expect(fs.existsSync(directory)).toBe(true);
  });
  it("surfaces stop failure and retains its data instead of retrying",async()=>{
    let calls=0;let directory="";
    class StopFailure {
      process={pid:12345,exitCode:null,signalCode:null} as any;
      constructor(options:FakeOptions){calls++;directory=options.databaseDir;}
      async initialise(){}
      async start(){throw new Error("Address already in use");}
      async stop(){throw new Error("synthetic stop denied");}
    }
    __setEmbeddedPostgresCtorProviderForTests(async()=>StopFailure);
    await expect(startWithRetry("qa-stop-refusal-")).rejects.toThrow("synthetic stop denied");
    expect(calls).toBe(1);expect(fs.existsSync(directory)).toBe(true);
  });

});

it.skipIf(!process.env.QA_SAVED_CLEANUP)("cleans only saved successful synthetic DBs through existing cleanup",async()=>{
  const results=await cleanupCompletedEmbeddedPostgresTestDatadirs();
  fs.writeFileSync(process.env.QA_SAVED_CLEANUP!,JSON.stringify({synthetic:true,results},null,2)+"\n",{mode:0o600});
});

it("releases an acquired IPC lease when construction throws",async()=>{
  const before=ipcFinish.mock.calls.length;
  class Broken {constructor(){throw new Error("synthetic constructor failure");}async initialise(){}async start(){}async stop(){}}
  __setEmbeddedPostgresCtorProviderForTests(async()=>Broken);
  try{await expect(startWithRetry("qa-constructor-failure-")).rejects.toThrow("synthetic constructor failure");expect(ipcFinish.mock.calls.length).toBe(before+1);}
  finally{__setEmbeddedPostgresCtorProviderForTests(null);}
});


// No initdb, IPC command, filesystem mutation or process lookup in this fixture.
function normalOwnedFixture(){
  const original={id:19,uid:501,cuid:501,key:900,size:56,nattch:9,cpid:31,lpid:31,ctime:10,mode:2432,seq:1};
  const foreign={...original,id:20,key:901,cpid:32,lpid:32,nattch:19,seq:2};
  const row=(phase:string,extra:Record<string,unknown>={})=>({phase,ownerPid:100,dataDir:"/synthetic-db",device:1,inode:900,extra});
  const rows=[row("reserved",{before:[]}),row("initialise_started"),row("initialise_exited"),
    row("running",{pid:31,postmasterPid:"31\n/synthetic-db\n1\n54329\n\n127.0.0.1\n900 19\nready\n",segments:[original]}),
    row("stop_requested",{pid:31}),row("exit_observed",{pid:31,exitCode:0,signalCode:null}),
    row("stopped_inventory",{after:[foreign],newSegments:[foreign],missing:[]})];
  return {rows,original,foreign,directory:{dev:1,ino:900,uid:501,directory:true,symlink:false}};
}
it("separates exact normal child absence from unchanged-host inventory",()=>{
  const f=normalOwnedFixture(),proof=proveNormalOwnedCleanup(f.rows,[f.foreign],f.directory,true,false);
  expect(proof.original.id).toBe(19);expect(proof.foreignDelta.newSegments).toEqual([f.foreign]);
  expect(proof.globalInventoryVerified).toBe(false);expect(proof.dataDirRetained).toBe(true);
});
it.each(["remaining","attached","reused_id","reused_key"])("refuses ambiguous own segment: %s",kind=>{
  const f=normalOwnedFixture();
  const segment=kind==="remaining"?{...f.original,nattch:0}:kind==="attached"?f.original:
    kind==="reused_id"?{...f.foreign,id:19,seq:99}:{...f.foreign,key:900};
  expect(()=>proveNormalOwnedCleanup(f.rows,[segment],f.directory,true,false)).toThrow("owned/reused segment still present");
});
it.each(["unknown_exit","other_pid","init_unknown","data_generation","live_child","postmaster_present"])("holds incomplete normal-exit proof: %s",kind=>{
  const f=normalOwnedFixture();
  if(kind==="unknown_exit")Object.assign(f.rows[5]!.extra,{exitCode:null});
  if(kind==="other_pid")Object.assign(f.rows[5]!.extra,{pid:99});
  if(kind==="init_unknown")f.rows.splice(2,1);
  if(kind==="data_generation")f.directory.ino++;
  expect(()=>proveNormalOwnedCleanup(f.rows,[f.foreign],f.directory,kind!=="live_child",kind==="postmaster_present")).toThrow("Owned IPC cleanup unproven");
});

// A fake ChildProcess is the only executable in these lifecycle tests.
// No initdb, PostgreSQL, IPC command or PID lookup is used.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { observeInitializationChild } from "./test-embedded-postgres-initialization.js";
import { assertInitializationAllowsFinish } from "./test-embedded-postgres-ipc.js";

function initFixture(failPhase?: string, timeout = 100) {
  const child = Object.assign(new EventEmitter(), {
    pid: 42001, spawnfile: "/synthetic/initdb", exitCode: null as number|null,
    signalCode: null as NodeJS.Signals|null, stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill: vi.fn(() => true),
  });
  const controller = new AbortController();
  const rows: {phase:string;extra:any}[] = [{phase:"initialise_started",extra:{observedChild:true}}];
  const launch = vi.fn(() => child as unknown as ChildProcess);
  const context = {signal:controller.signal,record:(phase:string,extra:unknown={}) => {
    if(phase===failPhase)throw new Error("synthetic receipt write failed");
    rows.push({phase,extra});
  }};
  const run = () => observeInitializationChild(launch,context,{scope:"direct_initdb_child_only"},()=>{},timeout);
  const exit = (code:number|null=0,signal:NodeJS.Signals|null=null) => {
    child.exitCode=code; child.signalCode=signal;child.emit("exit",code,signal);child.emit("close",code,signal);
  };
  return {child,controller,rows,launch,run,exit};
}
it("requires same child spawn/exit/close before initialization completes",async()=>{
  const f=initFixture();let completed=false;const result=f.run().then(()=>{completed=true;});
  f.child.emit("spawn");f.child.exitCode=0;f.child.emit("exit",0,null);
  await Promise.resolve();expect(completed).toBe(false);
  f.child.emit("close",0,null);await result;
  f.rows.push({phase:"initialise_exited",extra:{}});
  expect(()=>assertInitializationAllowsFinish(f.rows)).not.toThrow();
  const generations=f.rows.filter(x=>x.extra.generation).map(x=>x.extra.generation);
  expect(new Set(generations).size).toBe(1);
  expect(f.rows.filter(x=>x.extra.pid).map(x=>x.extra.pid)).toEqual([42001,42001,42001]);
});
it("cancels before spawn without invoking launcher",async()=>{
  const f=initFixture();f.controller.abort();await expect(f.run()).rejects.toThrow("before spawn");expect(f.launch).not.toHaveBeenCalled();
});
it("cancels between launch and spawn, waits for close and never succeeds",async()=>{
  const f=initFixture();const result=f.run();const rejected=expect(result).rejects.toThrow("Initialization failed");
  f.controller.abort();expect(f.child.kill).not.toHaveBeenCalled();f.child.emit("spawn");
  expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");f.exit(null,"SIGTERM");await rejected;
  expect(()=>assertInitializationAllowsFinish(f.rows)).toThrow("exit unproven");
});
it("abort after exit before close still forbids start",async()=>{
  const f=initFixture();const result=f.run();const rejected=expect(result).rejects.toThrow("Initialization failed");
  f.child.emit("spawn");f.child.exitCode=0;f.child.emit("exit",0,null);f.controller.abort();
  expect(f.child.kill).not.toHaveBeenCalled();f.child.emit("close",0,null);await rejected;
});
it.each(["initialise_spawn_intent","initialise_spawned","initialise_child_exit","initialise_child_close"])("receipt failure at %s never succeeds",async phase=>{
  const f=initFixture(phase);const result=f.run();const rejected=expect(result).rejects.toThrow();
  if(phase!=="initialise_spawn_intent"){f.child.emit("spawn");f.exit();}
  await rejected;
  if(phase==="initialise_spawn_intent")expect(f.launch).not.toHaveBeenCalled();
});
it("spawn error with close and no exit remains failure",async()=>{
  const f=initFixture();const result=f.run();const rejected=expect(result).rejects.toThrow("Initialization failed");
  f.child.emit("error",Object.assign(new Error("not found"),{code:"ENOENT"}));f.child.emit("close",-2,null);await rejected;
  expect(f.rows.some(x=>x.phase==="initialise_child_exit")).toBe(false);
});
it("does not reinterpret nonzero child exit as successful initialization",async()=>{
  const f=initFixture();const result=f.run();const rejected=expect(result).rejects.toThrow("Initialization failed");f.child.emit("spawn");f.exit(1);await rejected;
});
it("bounded cancellation without close is UNKNOWN, never exit evidence",async()=>{
  vi.useFakeTimers();
  try {
    const f=initFixture(undefined,10);const result=f.run();const rejected=expect(result).rejects.toThrow("close unproven");
    f.child.emit("spawn");f.controller.abort();await vi.advanceTimersByTimeAsync(10);await rejected;
    expect(f.rows.some(x=>x.phase==="initialise_child_exit"||x.phase==="initialise_child_close")).toBe(false);
  }finally{vi.useRealTimers();}
});
it("keeps original interrupted initialization UNKNOWN even with unchanged inventory",()=>{
  const rows=[{phase:"reserved"},{phase:"host_probe"},{phase:"initialise_started"},{phase:"interrupted",extra:{signal:"SIGTERM"}}];
  expect(()=>assertInitializationAllowsFinish(rows)).toThrow("Initialization exit unproven");
});
it("keeps legacy completed initialization compatible without fabricating new child evidence",()=>{
  expect(()=>assertInitializationAllowsFinish([{phase:"initialise_started"},{phase:"initialise_exited"}])).not.toThrow();
});
it("refuses another child generation in otherwise normal initialization",async()=>{
  const f=initFixture();const result=f.run();f.child.emit("spawn");f.exit();await result;
  f.rows.push({phase:"initialise_exited",extra:{}});f.rows.find(x=>x.phase==="initialise_child_close")!.extra.generation="other";
  expect(()=>assertInitializationAllowsFinish(f.rows)).toThrow("generation/normal exit/close unproven");
});


it("does not grant cleanup or retry after unobserved initialise failure",async()=>{
  let starts=0,constructors=0;
  class UnobservedFailure {
    constructor(){constructors++;}
    async initialise(){throw new Error("initialization interrupted fixture");}
    async start(){starts++;}
    async stop(){}
  }
  const previous=ipcFinish.mock.calls.length;
  __setEmbeddedPostgresCtorProviderForTests(async()=>UnobservedFailure);
  try {
    await expect(startWithRetry("qa-init-unproven-")).rejects.toThrow("initialization interrupted fixture");
    expect(starts).toBe(0);expect(constructors).toBe(1);
    expect(ipcFinish.mock.calls.slice(previous)).toEqual([[{initializationUnproven:true}]]);
  } finally {__setEmbeddedPostgresCtorProviderForTests(null);}
});

import { observePostmasterStartup, initialiseTestCluster } from "./test-embedded-postgres-initialization.js";
it("pre-cancelled preparation performs no permission or binary work",async()=>{
  const f=initFixture();f.controller.abort();const permissionIds=vi.fn(async()=>({}));
  await expect(initialiseTestCluster({databaseDir:"/not-used",user:"synthetic",password:"synthetic",authMethod:"password",initdbFlags:[],onLog:()=>{},permissionIds},
    {signal:f.controller.signal,record:()=>{}})).rejects.toThrow("during preparation");
  expect(permissionIds).not.toHaveBeenCalled();
});
it("cancellation during asynchronous postmaster preparation prevents the later spawn",async()=>{
  const f=initFixture();let prepared!:(launch:()=>ChildProcess)=>void;
  const preparation=new Promise<()=>ChildProcess>(resolve=>{prepared=resolve;});
  const adopt=vi.fn();const started=observePostmasterStartup(()=>preparation,{signal:f.controller.signal,record:()=>{}},adopt,()=>{});
  const rejected=expect(started).rejects.toThrow("Postmaster start interrupted");
  f.controller.abort();prepared(f.launch);await rejected;
  expect(f.launch).not.toHaveBeenCalled();expect(adopt).not.toHaveBeenCalled();
});
it("postmaster cancellation after adoption preserves the exact handle for stop",async()=>{
  const f=initFixture();const adopted:ChildProcess[]=[];
  const started=observePostmasterStartup(async()=>f.launch,{signal:f.controller.signal,record:()=>{}},child=>adopted.push(child),()=>{});
  const rejected=expect(started).rejects.toThrow("owned handle requires stop");
  await Promise.resolve();f.controller.abort();await rejected;
  expect(adopted).toEqual([f.child]);expect(f.launch).toHaveBeenCalledTimes(1);
});
it("postmaster success still waits for the existing readiness message",async()=>{
  const f=initFixture();let ready=false;
  const started=observePostmasterStartup(async()=>f.launch,{signal:f.controller.signal,record:()=>{}},()=>{},()=>{}).then(()=>{ready=true;});
  await Promise.resolve();f.child.stderr.emit("data","starting");expect(ready).toBe(false);
  f.child.stderr.emit("data","database system is ready to accept connections");await started;expect(ready).toBe(true);
});
it("synchronous spawn failure records failure without inventing exit",async()=>{
  const rows:string[]=[];
  await expect(observeInitializationChild(()=>{throw Object.assign(new Error("spawn denied"),{code:"EACCES"});},
    {signal:new AbortController().signal,record:phase=>{rows.push(phase);}}, {},()=>{})).rejects.toThrow("spawn denied");
  expect(rows).toEqual(["initialise_spawn_intent","initialise_spawn_failed"]);
});
it("datadir generation change during preparation prevents postmaster spawn",async()=>{
  const f=initFixture();let checks=0;
  await expect(observePostmasterStartup(async()=>f.launch,
    {signal:f.controller.signal,record:()=>{},assertDataDirectory:()=>{if(++checks===2)throw new Error("generation changed");}},()=>{},()=>{})).rejects.toThrow("generation changed");
  expect(f.launch).not.toHaveBeenCalled();
});
