import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";

type Segment = {id:number;uid:number;cuid:number;key:number;size:number;nattch:number;cpid:number;lpid:number;ctime:number;mode?:number;seq?:number};
const identity = (x:Segment) => [x.id,x.uid,x.cuid,x.key,x.size,x.cpid,x.ctime].join(":");
const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
function gone(pid:number){try{process.kill(pid,0);return false;}catch(error){return (error as NodeJS.ErrnoException).code==="ESRCH";}}
function privateFile(file:string){const s=fs.lstatSync(file);if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw new Error(`Untrusted IPC receipt: ${file}`);}
function append(file:string,value:unknown){const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_NOFOLLOW);try{fs.writeSync(fd,JSON.stringify(value)+"\n");fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function create(file:string,value:unknown){const fd=fs.openSync(file,"wx",0o600);try{fs.writeSync(fd,JSON.stringify(value)+"\n");fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}

function privateDirectory(directory:string){
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const st=fs.lstatSync(directory);
  if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o777)!==0o700)
    throw new Error(`Test IPC directory must be owned by this UID and mode 0700: ${directory}; no initdb`);
  return fs.realpathSync(directory);
}

// One host-wide lock also covers independently selected Vitest invocations.
// Existing explicit receipt scopes keep their original scoped lock as well.
function sharedIpcRoot(){return privateDirectory(path.join(fs.realpathSync("/tmp"),`paperclip-test-ipc-${process.getuid!()}`));}
let preparedIpc:{guard:string;directory:string}|undefined;
export function prepareTestIpc(){
  if(process.platform!=="darwin")return undefined;
  if(preparedIpc)return preparedIpc;
  const guard=process.env.PAPERCLIP_TEST_IPC_GUARD,directory=process.env.PAPERCLIP_TEST_IPC_RECEIPT_DIR;
  if(Boolean(guard)!==Boolean(directory))throw new Error("Set both explicit test IPC guard and receipt directory, or neither; no initdb");
  if(guard&&directory){
    const st=fs.lstatSync(guard);
    if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o022)!==0)
      throw new Error("Untrusted explicit test IPC guard; no initdb");
    return preparedIpc={guard:fs.realpathSync(guard),directory:privateDirectory(directory)};
  }
  const root=privateDirectory(process.env.PAPERCLIP_TEST_IPC_ROOT||sharedIpcRoot());
  const receipts=path.join(root,`run-${process.pid}-${randomUUID()}-ipc`);
  fs.mkdirSync(receipts,{mode:0o700});
  const source=fileURLToPath(new URL("./test-embedded-postgres-ipc.c",import.meta.url));
  const binary=path.join(receipts,"ipc-guard");
  const record={schema:"paperclip.test-ipc-preparation.v1",at:new Date().toISOString(),ownerUid:process.getuid!(),
    ownerPid:process.pid,runId:process.env.PAPERCLIP_TEST_RUN_ID??null,taskId:process.env.PAPERCLIP_TEST_TASK_ID??null,
    dispatchId:process.env.PAPERCLIP_TEST_DISPATCH_ID??null,terminal:process.env.ORCA_TERMINAL_HANDLE??null,
    referenceRole:"orchestration correlation only; not ownership or deletion authority",source,
    sourceSha256:sha(fs.readFileSync(source,"utf8")),guard:binary,receiptDirectory:receipts};
  try{
    execFileSync("/usr/bin/cc",["-std=c11","-O2","-Wall","-Wextra",source,"-o",binary],{encoding:"utf8",stdio:["ignore","pipe","pipe"]});
    fs.chmodSync(binary,0o700);
    create(path.join(receipts,"preparation.json"),{...record,status:"compiled",guardSha256:createHash("sha256").update(fs.readFileSync(binary)).digest("hex")});
  }catch(error){
    create(path.join(receipts,"preparation.json"),{...record,status:"compile_failed",error:String(error)});
    throw new Error(`Test IPC guard compilation failed; no initdb: ${String(error)}`);
  }
  process.env.PAPERCLIP_TEST_IPC_GUARD=binary;
  process.env.PAPERCLIP_TEST_IPC_RECEIPT_DIR=receipts;
  return preparedIpc={guard:binary,directory:receipts};
}

async function acquireIpcLease(guard:string,root:string){
  const paths=[path.join(sharedIpcRoot(),"ipc-helper.lock"),path.join(root,"ipc-helper.lock"),process.env.PAPERCLIP_TEST_IPC_LEASE_FILE].filter((x):x is string=>Boolean(x));
  const releases:(()=>Promise<void>)[]=[];
  const release=async()=>{const failures:unknown[]=[];for(const done of releases.reverse()){try{await done();}catch(error){failures.push(error);}}releases.length=0;if(failures.length)throw new AggregateError(failures,"IPC lease release failed");};
  try{
    for(const file of [...new Set(paths)]){
      if(!path.isAbsolute(file))throw new Error("IPC lease path must be absolute; no initdb");
      const child=spawn(guard,["lease",file],{stdio:["pipe","pipe","pipe"]});
      let stderr="";child.stderr.on("data",chunk=>{stderr+=String(chunk);});
      const exited=new Promise<number|null>(resolve=>child.once("exit",resolve));
      await new Promise<void>((resolve,reject)=>{child.once("error",reject);child.once("exit",()=>reject(new Error(`IPC lease refused: ${stderr}`)));child.stdout.once("data",chunk=>String(chunk).trim()==="leased"?resolve():reject(new Error("Invalid IPC lease reply")));});
      releases.push(async()=>{child.stdin.end();if(await exited!==0)throw new Error(`IPC lease release failed: ${stderr}`);});
    }
    return {release,paths:[...new Set(paths)]};
  }catch(error){await release();throw error;}
}

function completedCleanupSide(file:string,rows:any[]){
  if(rows[0]?.phase!=="cleanup_intent")return false;
  const suffix=".cleanup.jsonl",last=rows.at(-1);
  if(!file.endsWith(suffix)||last?.phase!=="cleanup_complete"||last.absent!==true)throw new Error(`Historical cleanup incomplete: ${file}`);
  const source=file.slice(0,-suffix.length);privateFile(source);
  if(sha(fs.readFileSync(source,"utf8"))!==rows[0].sourceSha256||fs.existsSync(rows[0].dataDir))throw new Error(`Historical cleanup evidence changed: ${file}`);
  return true;
}


// A normal child exit proves only its captured PostgreSQL generation. Foreign
// inventory changes remain evidence, never ownership or permission to remove.
export function proveNormalOwnedCleanup(rows:any[],current:Segment[],directory:{dev:number;ino:number;uid:number;directory:boolean;symlink:boolean},pidGone:boolean,postmasterPresent:boolean){
  const need=(ok:unknown,reason:string)=>{if(!ok)throw new Error(`Owned IPC cleanup unproven: ${reason}`);};
  const one=(phase:string)=>{const values=rows.filter(x=>x.phase===phase);need(values.length===1,phase);return values[0];};
  const reserved=one("reserved"),init=one("initialise_started"),initialized=one("initialise_exited"),running=one("running"),stop=one("stop_requested"),exit=one("exit_observed"),stopped=one("stopped_inventory");
  need([reserved,init,initialized,running,stop,exit,stopped].every((x,i,a)=>i===0||rows.indexOf(a[i-1])<rows.indexOf(x)),"phase order");
  need(rows.every(x=>x.ownerPid===reserved.ownerPid&&x.dataDir===reserved.dataDir&&x.device===reserved.device&&x.inode===reserved.inode),"receipt generation");
  need(!rows.slice(0,rows.indexOf(exit)).some(x=>x.phase==="interrupted"||x.phase==="stop_failed"),"interrupted exit");
  const lines=String(running.extra.postmasterPid).trim().split("\n"),pid=Number(lines[0]),pair=String(lines[6]).trim().split(/\s+/).map(Number),[key,id]=pair;
  need(Number.isSafeInteger(pid)&&pid>1&&pair.length===2&&pair.every(Number.isSafeInteger)&&key>0&&id>=0,"postmaster identity");
  need(pid===running.extra.pid&&pid===stop.extra.pid&&pid===exit.extra.pid&&exit.extra.exitCode===0&&exit.extra.signalCode===null&&pidGone,"exact normal child exit");
  need(directory.directory&&!directory.symlink&&directory.dev===reserved.device&&directory.ino===reserved.inode&&lines[1]===reserved.dataDir&&!postmasterPresent,"datadir identity or live marker");
  const valid=(inventory:Segment[])=>{
    need(Array.isArray(inventory)&&new Set(inventory.map(x=>x.id)).size===inventory.length,"inventory shape");
    need(inventory.every(x=>[x.id,x.uid,x.cuid,x.key,x.size,x.nattch,x.cpid,x.lpid,x.ctime,x.mode,x.seq].every(Number.isSafeInteger)),"inventory fields");
  };
  const before=reserved.extra.before as Segment[],during=running.extra.segments as Segment[],after=stopped.extra.after as Segment[];
  for(const inventory of [before,during,after,current])valid(inventory);
  const original=during.find(x=>x.id===id);
  need(original&&original.key===key&&original.cpid===pid&&original.uid===directory.uid&&original.cuid===directory.uid&&original.size===56,"captured PostgreSQL segment");
  need(!before.some(x=>x.id===id||x.key===key||x.cpid===pid),"segment existed before child");
  // Numeric ID/key reuse is ambiguous even if the captured generation differs.
  for(const inventory of [after,current])need(!inventory.some(x=>x.id===id||x.key===key||x.cpid===pid),"owned/reused segment still present");
  const delta=(inventory:Segment[])=>({newSegments:inventory.filter(x=>!before.some(y=>identity(x)===identity(y))),missing:before.filter(x=>!inventory.some(y=>identity(x)===identity(y)))});
  need(JSON.stringify(stopped.extra.newSegments)===JSON.stringify(delta(after).newSegments)&&JSON.stringify(stopped.extra.missing)===JSON.stringify(delta(after).missing),"recorded inventory delta");
  return {scope:"exact_normally_exited_child" as const,original:original!,pid,dataDir:reserved.dataDir,device:reserved.device,inode:reserved.inode,
    normalExit:exit.extra,stoppedInventory:after,observedInventory:current,foreignDelta:delta(current),globalInventoryVerified:false as const,dataDirRetained:true as const};
}

function readRows(file:string){privateFile(file);const raw=fs.readFileSync(file,"utf8");if(Buffer.byteLength(raw)>2_000_000)throw new Error(`Oversized IPC receipt: ${file}`);return {raw,rows:raw.trim().split("\n").map(line=>JSON.parse(line))};}
function normalOwnedProof(rows:any[],current:Segment[]){
  const reserved=rows.find(x=>x.phase==="reserved"),running=rows.find(x=>x.phase==="running");
  if(!reserved||!running)throw new Error("Owned IPC cleanup lacks reserved/running evidence");
  const st=fs.lstatSync(reserved.dataDir);
  if(st.uid!==process.getuid?.())throw new Error("Owned IPC datadir owner changed");
  // Validate stored generation before querying a PID; no foreign PID probe on a malformed receipt.
  const proof=proveNormalOwnedCleanup(rows,current,{dev:st.dev,ino:st.ino,uid:st.uid,directory:st.isDirectory(),symlink:st.isSymbolicLink()},true,fs.existsSync(path.join(reserved.dataDir,"postmaster.pid")));
  if(!gone(proof.pid))throw new Error("Owned IPC cleanup unproven: exact child process still present");
  return proof;
}
function verifyOwnedCompletion(file:string,rows:any[],current:Segment[],saved:any){
  if(saved?.scope!=="exact_normally_exited_child"||saved.globalInventoryVerified!==false||saved.dataDirRetained!==true)throw new Error(`Invalid owned IPC scope: ${file}`);
  const reserved=rows.find(x=>x.phase==="reserved"),running=rows.find(x=>x.phase==="running");
  if(!reserved||!running||saved.dataDir!==reserved.dataDir||saved.device!==reserved.device||saved.inode!==reserved.inode||saved.pid!==running.extra.pid)throw new Error(`Owned IPC binding changed: ${file}`);
  // A later historical datadir cleanup still requires the original global
  // inventory/command-exit gates; an absent directory alone is not proof.
  if(!fs.existsSync(reserved.dataDir)){
    const side=file+".cleanup.jsonl",cleanup=readRows(side);
    if(!completedCleanupSide(side,cleanup.rows)||cleanup.rows[0].dataDir!==reserved.dataDir||cleanup.rows[0].device!==reserved.device||cleanup.rows[0].inode!==reserved.inode)throw new Error(`Owned datadir absence unproven: ${file}`);
    const original=running.extra.segments.find((x:Segment)=>x.id===saved.original?.id);
    if(JSON.stringify(original)!==JSON.stringify(saved.original)||current.some(x=>x.id===saved.original.id||x.key===saved.original.key||x.cpid===saved.pid)||!gone(saved.pid))throw new Error(`Owned IPC absence changed: ${file}`);
    return;
  }
  const proof=normalOwnedProof(rows,current);
  for(const key of ["original","pid","dataDir","device","inode","normalExit","stoppedInventory"] as const)
    if(JSON.stringify(proof[key])!==JSON.stringify(saved[key]))throw new Error(`Owned IPC receipt changed: ${file}`);
}
function ownedCompletion(file:string,raw:string,rows:any[],current:Segment[],recover=false):"owned_cleanup_verified"|"owned_cleanup_recovered"|null{
  const owned=rows.filter(x=>x.phase==="owned_cleanup_verified");
  if(owned.length){if(fs.existsSync(file+".recovery.json.intent"))throw new Error(`Earlier recovery outcome unresolved: ${file}`);if(owned.length!==1)throw new Error(`Duplicate owned IPC completion: ${file}`);verifyOwnedCompletion(file,rows,current,owned[0].extra);return "owned_cleanup_verified";}
  const recovery=file+".recovery.json";
  if(fs.existsSync(recovery)){
    privateFile(recovery);const saved=JSON.parse(fs.readFileSync(recovery,"utf8"));
    if(saved.status!=="owned_cleanup_verified")return null;
    if(fs.existsSync(recovery+".intent"))throw new Error(`Earlier recovery outcome unresolved: ${recovery}.intent`);
    if(saved.sourceSha256!==sha(raw))throw new Error(`Owned IPC source changed: ${file}`);
    verifyOwnedCompletion(file,rows,current,saved.proof);return "owned_cleanup_recovered";
  }
  if(!recover||!rows.some(x=>x.phase==="exit_observed"&&x.extra.exitCode===0&&x.extra.signalCode===null))return null;
  // Never replace an earlier unknown remove intent or remove any IPC here.
  if(fs.existsSync(recovery+".intent"))throw new Error(`Earlier recovery outcome unresolved: ${recovery}.intent`);
  const proof=normalOwnedProof(rows,current);
  if(fs.readFileSync(file,"utf8")!==raw)throw new Error(`IPC source changed before recovery receipt: ${file}`);
  create(recovery,{status:"owned_cleanup_verified",sourceSha256:sha(raw),at:new Date().toISOString(),proof,removal:null});
  if(fs.readFileSync(file,"utf8")!==raw)throw new Error(`IPC source changed during recovery receipt: ${file}`);
  const received=ownedCompletion(file,raw,rows,current);
  if(received!=="owned_cleanup_recovered")throw new Error(`Owned IPC recovery receipt missing: ${recovery}`);
  return received;
}


function verifyPriorReceiptRoot(snapshot:()=>Segment[]){
  const root=process.env.PAPERCLIP_TEST_IPC_PRIOR_RECEIPT_ROOT;
  if(!root)return [];
  const st=fs.lstatSync(root);
  if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid?.())throw new Error("Untrusted prior IPC receipt root; no initdb");
  const current=snapshot(),references:unknown[]=[];
  for(const entry of fs.readdirSync(root,{withFileTypes:true})){
    if(!entry.isDirectory()||!entry.name.endsWith("-ipc"))continue;
    for(const name of fs.readdirSync(path.join(root,entry.name))){
      if(!name.endsWith(".jsonl"))continue;
      const file=path.join(root,entry.name,name);privateFile(file);
      const raw=fs.readFileSync(file,"utf8");if(Buffer.byteLength(raw)>2_000_000)throw new Error(`Oversized prior IPC receipt: ${file}`);
      const rows=raw.trim().split("\n").map(line=>JSON.parse(line));
      let completion:string,recoverySha256:string|null=null;
      if(completedCleanupSide(file,rows))completion="cleanup_complete";
      else if(ownedCompletion(file,raw,rows,current)) {completion="owned_cleanup_verified";const side=file+".recovery.json";if(fs.existsSync(side))recoverySha256=sha(fs.readFileSync(side,"utf8"));}
      else if(rows.some(x=>x.phase==="cleanup_verified")){
        const stopped=rows.findLast(x=>x.phase==="stopped_inventory");
        if(!stopped||stopped.extra.newSegments.length||stopped.extra.missing.length)throw new Error(`Prior inventory cleanup unproven: ${file}`);
        const running=rows.find(x=>x.phase==="running");
        if(running){
          const id=Number(String(running.extra.postmasterPid).trim().split("\n")[6].trim().split(/\s+/)[1]);
          const original=running.extra.segments.find((x:Segment)=>x.id===id);
          if(!original||current.some(x=>identity(x)===identity(original)))throw new Error(`Prior IPC generation still present: ${file}`);
        }
        completion="cleanup_verified";
      }else{
        const recovery=file+".recovery.json";privateFile(recovery);
        const text=fs.readFileSync(recovery,"utf8"),record=JSON.parse(text);
        if(record.sourceSha256!==sha(raw)||record.status!=="verified_absent"||current.some(x=>identity(x)===identity(record.original)))throw new Error(`Prior recovery unproven: ${file}`);
        completion="verified_absent";recoverySha256=sha(text);
      }
      references.push({file,sourceSha256:sha(raw),completion,recoverySha256});
    }
  }
  return references;
}

// This is a Darwin test entry, scoped to a single receipt root and a kernel flock.
// It never infers ownership from zero bytes, a nearby key, or current PID liveness.
export async function beginTestIpc(dataDir:string) {
  if(process.platform !== "darwin") return { record:(_phase:string,_extra:unknown={})=>{}, finish:async()=>({dataDirCleanupAllowed:true}), snapshot:()=>[] as Segment[] };
  const {guard,directory}=prepareTestIpc()!;
  const root=path.dirname(directory);
  const {release,paths:leasePaths}=await acquireIpcLease(guard,root);
  const snapshot=():Segment[]=>{
    const raw=execFileSync("/usr/bin/ipcs",["-m"],{encoding:"utf8"});
    const ids=raw.split("\n").filter(x=>x.startsWith("m ")).map(x=>Number(x.trim().split(/\s+/)[1]));
    const rows=ids.map(id=>JSON.parse(execFileSync(guard,["stat",String(id)],{encoding:"utf8"})) as Segment);
    if(new Set(ids).size!==ids.length||rows.some((x,i)=>x.id!==ids[i])) throw new Error("IPC inventory identity mismatch");
    return rows;
  };
  try {
    // Examine every prior DB receipt in this same entry's scope, including failures.
    for(const entry of fs.readdirSync(root,{withFileTypes:true})){
      if(!entry.isDirectory()||!entry.name.endsWith("-ipc"))continue;
      for(const name of fs.readdirSync(path.join(root,entry.name))){
        if(!name.endsWith(".jsonl"))continue;
        const file=path.join(root,entry.name,name);privateFile(file);
        const raw=fs.readFileSync(file,"utf8");if(Buffer.byteLength(raw)>2_000_000)throw new Error(`Oversized IPC receipt: ${file}`);
        const rows=raw.trim().split("\n").map(line=>JSON.parse(line));
        if(completedCleanupSide(file,rows))continue;
        if(ownedCompletion(file,raw,rows,snapshot()))continue;
        if(rows.some(x=>x.phase==="cleanup_verified"||x.phase==="capacity_wait"))continue;
        if(rows.some(x=>x.phase==="host_probe_failed")){
          const probe=file+".probe";privateFile(probe);const last=JSON.parse(fs.readFileSync(probe,"utf8").trim().split("\n").at(-1)!);
          if(last.remains!==false||last.removeError!==0)throw new Error(`Prior host probe cleanup unproven: ${probe}`);
          continue;
        }
        const recovery=file+".recovery.json";
        if(fs.existsSync(recovery)){privateFile(recovery);const receipt=JSON.parse(fs.readFileSync(recovery,"utf8"));if(receipt.sourceSha256!==sha(raw)||receipt.status!=="verified_absent")throw new Error(`Invalid recovery receipt: ${recovery}`);if(snapshot().some(x=>identity(x)===identity(receipt.original)))throw new Error(`Recovered IPC unexpectedly present: ${recovery}`);continue;}
        if(ownedCompletion(file,raw,rows,snapshot(),true))continue;
        const reserved=rows.find(x=>x.phase==="reserved"), running=rows.find(x=>x.phase==="running");
        if(!reserved||!running)throw new Error(`Prior initialization exit unproven: ${file}; retain and inspect before new initdb`);
        const stat=fs.lstatSync(reserved.dataDir), lines=String(running.extra.postmasterPid).trim().split("\n");
        const pid=Number(lines[0]), [key,id]=String(lines[6]).trim().split(/\s+/).map(Number);
        const original=(running.extra.segments as Segment[]).find(x=>x.id===id);
        if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==reserved.device||stat.ino!==reserved.inode||lines[1]!==reserved.dataDir||pid!==running.extra.pid||!original||original.cpid!==pid||original.key!==key||!gone(pid))throw new Error(`Prior generation or process exit unproven: ${file}`);
        const current=snapshot(), present=current.find(x=>x.id===id);
        const originalBaseline=reserved.extra.before as Segment[];
        if(originalBaseline.some(x=>!current.some(y=>identity(x)===identity(y))))throw new Error(`Baseline IPC changed during interrupted cycle: ${file}`);
        if(current.some(x=>x.id!==id&&!originalBaseline.some(y=>identity(x)===identity(y))))throw new Error(`Unattributed IPC after interrupted cycle: ${file}`);
        let removal:unknown=null;
        if(present){
          if(identity(present)!==identity(original)||present.nattch!==0||present.uid!==process.getuid?.()||present.cuid!==process.getuid?.())throw new Error(`Prior IPC changed or attached: ${file}`);
          const inspected=execFileSync(guard,["inspect",String(id)],{encoding:"utf8"}).trim().split("\n").map(x=>JSON.parse(x));
          const h=inspected[1];if(h.magic!==679834894||h.creator!==pid||h.device!==stat.dev||h.inode!==stat.ino)throw new Error(`Prior PostgreSQL header mismatch: ${file}`);
          const intent={status:"recovery_intent",sourceSha256:sha(raw),original,dataDir:reserved.dataDir,header:h};
          const intentFile=recovery+".intent";
          if(fs.existsSync(intentFile))throw new Error(`Earlier recovery outcome unresolved: ${intentFile}`);
          create(intentFile,intent);
          removal=execFileSync(guard,["remove",String(id),String(key),String(original.ctime),String(pid),String(stat.dev),String(stat.ino),String(h.dsm)],{encoding:"utf8"});
        }
        if(snapshot().some(x=>x.id===id))throw new Error(`Prior IPC removal unconfirmed: ${file}`);
        create(recovery,{status:"verified_absent",sourceSha256:sha(raw),at:new Date().toISOString(),original,dataDir:reserved.dataDir,retained:true,removal});
      }
    }
    const priorReceiptReferences=verifyPriorReceiptRoot(snapshot);
    const st=fs.statSync(dataDir),before=snapshot();
    const file=path.join(directory,`${path.basename(dataDir)}.jsonl`);
    create(file,{phase:"reserved",at:new Date().toISOString(),ownerPid:process.pid,dataDir,device:st.dev,inode:st.ino,extra:{before,leasePaths,priorReceiptReferences,orchestration:{runId:process.env.PAPERCLIP_TEST_RUN_ID??null,taskId:process.env.PAPERCLIP_TEST_TASK_ID??null,dispatchId:process.env.PAPERCLIP_TEST_DISPATCH_ID??null},keyDerivation:"PG key_t from inode, collision increments; actual key/id comes from postmaster.pid"}});
    const record=(phase:string,extra:unknown={})=>append(file,{phase,at:new Date().toISOString(),ownerPid:process.pid,dataDir,device:st.dev,inode:st.ino,extra});
    const limit=Number(execFileSync("/usr/sbin/sysctl",["-n","kern.sysv.shmmni"],{encoding:"utf8"}).trim());
    if(!Number.isSafeInteger(limit)||limit<=before.length){record("capacity_wait",{limit,used:before.length,resume:"one proven safe free slot and host shmat permission"});throw new Error("test IPC capacity exhausted; no initdb attempt");}
    try{execFileSync(guard,["probe",file+".probe"],{encoding:"utf8"});record("host_probe",{receipt:file+".probe"});}
    catch(error){record("host_probe_failed",{error:String(error),receipt:file+".probe"});throw error;}
    let finished:Promise<{dataDirCleanupAllowed:boolean}>|undefined;
    const finish=()=>finished??=(async()=>{
      try{
        const after=snapshot(),newSegments=after.filter(x=>!before.some(y=>identity(x)===identity(y))),missing=before.filter(x=>!after.some(y=>identity(x)===identity(y)));
        const current=fs.statSync(dataDir);record("stopped_inventory",{after,newSegments,missing});
        if(current.dev!==st.dev||current.ino!==st.ino||newSegments.length||missing.length){
          try{const {rows}=readRows(file);const proof=normalOwnedProof(rows,after);record("owned_cleanup_verified",proof);return {dataDirCleanupAllowed:false};}
          catch(error){record("cleanup_blocked",{resume:"retain datadir; verify process exit and complete IPC provenance before recovery"});throw new Error(`IPC cleanup unproven; retain ${dataDir}; receipt ${file}; ${String(error)}`);}
        }
        record("cleanup_verified",{dataDirRetained:true});return {dataDirCleanupAllowed:true};
      }finally{await release();}
    })();
    return {record,snapshot,finish};
  }catch(error){await release();throw error;}
}

// Reclaim only this entry's previously successful, normally exited synthetic DBs.
// Original receipts remain immutable; each historical cleanup has a side receipt.
export async function cleanupSavedTestDatadirs(cleanup:(directory:string)=>void){
  const guard=process.env.PAPERCLIP_TEST_IPC_GUARD,directory=process.env.PAPERCLIP_TEST_IPC_RECEIPT_DIR;
  if(process.platform!=="darwin"||!guard||!directory)throw new Error("Saved cleanup requires the Darwin guard and existing receipt scope");
  const root=path.dirname(directory),{release}=await acquireIpcLease(guard,root);
  const results:unknown[]=[];
  try{
    const raw=execFileSync("/usr/bin/ipcs",["-m"],{encoding:"utf8"});
    const current=raw.split("\n").filter(x=>x.startsWith("m ")).map(x=>JSON.parse(execFileSync(guard,["stat",x.trim().split(/\s+/)[1]!],{encoding:"utf8"})) as Segment);
    for(const entry of fs.readdirSync(root,{withFileTypes:true})){
      if(!entry.isDirectory()||!entry.name.endsWith("-ipc"))continue;
      const commandFile=path.join(root,entry.name.slice(0,-4)+"-command.json");
      for(const name of fs.readdirSync(path.join(root,entry.name))){
        if(!name.endsWith(".jsonl"))continue;
        const file=path.join(root,entry.name,name);privateFile(file);const text=fs.readFileSync(file,"utf8");
        const rows=text.trim().split("\n").map(x=>JSON.parse(x)),reserved=rows.find(x=>x.phase==="reserved"),running=rows.find(x=>x.phase==="running"),exit=rows.find(x=>x.phase==="exit_observed");
        if(completedCleanupSide(file,rows))continue;
        if(!reserved)throw new Error(`Unknown receipt shape: ${file}`);
        if(!fs.existsSync(reserved.dataDir))continue;
        const keep=(reason:string)=>results.push({receipt:file,dataDir:reserved.dataDir,action:"retain",reason});
        if(!fs.existsSync(commandFile)||JSON.parse(fs.readFileSync(commandFile,"utf8")).exitCode!==0){keep("failed or incomplete test run; investigation data");continue;}
        if(!running||!exit||exit.extra.exitCode!==0||exit.extra.signalCode!==null||exit.extra.pid!==running.extra.pid||!gone(exit.extra.pid)||!(rows.some(x=>x.phase==="cleanup_verified")||ownedCompletion(file,text,rows,current))){keep("exact normal exit/IPC cleanup unproven");continue;}
        if((reserved.extra.before as Segment[]).some(x=>!current.some(y=>identity(x)===identity(y)))||current.some(x=>!(reserved.extra.before as Segment[]).some(y=>identity(x)===identity(y)))){keep("IPC inventory changed");continue;}
        const st=fs.lstatSync(reserved.dataDir);
        if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid?.()||st.dev!==reserved.device||st.ino!==reserved.inode||fs.existsSync(path.join(reserved.dataDir,"postmaster.pid"))){keep("datadir identity or stopped marker unproven");continue;}
        const side=file+".cleanup.jsonl";
        if(fs.existsSync(side)){keep("prior cleanup outcome requires explicit reconciliation");continue;}
        create(side,{phase:"cleanup_intent",sourceSha256:sha(text),dataDir:reserved.dataDir,device:st.dev,inode:st.ino,normalExit:exit.extra,syntheticPurpose:"isolated fixed-scope validation completed; receipt/body hashes retained"});
        cleanup(reserved.dataDir);
        const absent=!fs.existsSync(reserved.dataDir);append(side,{phase:"cleanup_complete",absent});if(!absent)throw new Error(`Saved cleanup incomplete: ${side}`);
        results.push({receipt:file,dataDir:reserved.dataDir,action:"cleaned",sideReceipt:side});
      }
    }
    return results;
  }finally{await release();}
}
