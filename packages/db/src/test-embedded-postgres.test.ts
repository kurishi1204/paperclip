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

const ipcFinish=vi.hoisted(()=>vi.fn(async()=>({dataDirCleanupAllowed:true})));
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
      async initialise(){throw new Error("Address already in use");}
      async start(){}
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
