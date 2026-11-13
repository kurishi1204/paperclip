import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const compiler = vi.hoisted(() => ({ fail: false }));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
    if (args[0] === "/usr/bin/cc" && compiler.fail) throw new Error("synthetic compiler refusal");
    return (actual.execFileSync as Function)(...args);
  } };
});
const temporary:string[]=[];
afterEach(()=>{compiler.fail=false;vi.unstubAllEnvs();vi.resetModules();for(const dir of temporary.splice(0))fs.rmSync(dir,{recursive:true,force:false});});
function scope(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"paperclip-ipc-preparation-test-"));temporary.push(root);
  vi.stubEnv("PAPERCLIP_TEST_IPC_GUARD",undefined);vi.stubEnv("PAPERCLIP_TEST_IPC_RECEIPT_DIR",undefined);
  vi.stubEnv("PAPERCLIP_TEST_IPC_ROOT",root);return root;
}
it.skipIf(process.platform!=="darwin")("stops before constructing or initializing a DB when the guard compiler fails",async()=>{
  const root=scope();compiler.fail=true;
  const support=await import("./test-embedded-postgres.js");let constructors=0,initialises=0;
  class NoDatabase {constructor(){constructors++;}async initialise(){initialises++;}async start(){}async stop(){}}
  support.__setEmbeddedPostgresCtorProviderForTests(async()=>NoDatabase);
  try{await expect(support.__startEmbeddedPostgresWithRetryForTests("paperclip-compile-refusal-")).rejects.toThrow("Test IPC guard compilation failed; no initdb");}
  finally{support.__setEmbeddedPostgresCtorProviderForTests(null);}
  expect(constructors).toBe(0);expect(initialises).toBe(0);
  const dirs=fs.readdirSync(root);expect(dirs).toHaveLength(1);
  const receipt=JSON.parse(fs.readFileSync(path.join(root,dirs[0]!,"preparation.json"),"utf8"));expect(receipt.status).toBe("compile_failed");
  expect(fs.readdirSync(path.join(root,dirs[0]!)).some(x=>x.endsWith(".jsonl"))).toBe(false);
});
it.skipIf(process.platform!=="darwin")("rejects a partial explicit environment without silently preparing a different guard",async()=>{
  scope();vi.stubEnv("PAPERCLIP_TEST_IPC_GUARD","/not/a/guard");
  const {prepareTestIpc}=await import("./test-embedded-postgres-ipc.js");
  expect(()=>prepareTestIpc()).toThrow("Set both explicit test IPC guard and receipt directory, or neither; no initdb");
});
it.skipIf(process.platform!=="darwin")("refuses a nonprivate receipt root before compilation",async()=>{
  const root=scope();fs.chmodSync(root,0o755);
  const {prepareTestIpc}=await import("./test-embedded-postgres-ipc.js");
  expect(()=>prepareTestIpc()).toThrow("mode 0700");expect(fs.readdirSync(root)).toEqual([]);
});
