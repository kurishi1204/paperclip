import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue, IssueComment } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const company = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const owner = "fixture-owner-not-a-uuid-01";
const issueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const commentId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const spaceId = "55555555-5555-4555-8555-555555555555";
const now = "2026-10-27T10:00:00.000Z";
const body = "Synthetic owner note for local verification.";
const bodyHash = createHash("sha256").update(body).digest("hex");
const profile = { version: 1, enabled: true, sourceScopes: [{kind:"root_issues",issueIds:[issueId]}],
  sourceKinds: {issues:false,comments:true,documents:false,attachments:"off",workProducts:"off"},
  cursor: {maxWindowCharacters:60000,maxCharactersPerSource:12000,minSourceAgeMinutes:15,maxWindowsPerRun:6,staleAfterHours:72},
  backfill: {requireManualQueue:true} };
const config = {ownerCommentRawCapture:{version:1,enabled:true,spaceSlug:"owner-notes",ownerUserId:owner,
  issueIds:[issueId],classification:{label:"internal",decidedByUserId:owner,decidedAt:now,decisionRef:"synthetic-local"},
  allowCompanyReaders:true,maxBodyBytes:250000}};
const issue = {id:issueId,companyId:company,originKind:null} as unknown as Issue;
const comment = {id:commentId,companyId:company,issueId,authorType:"user",authorUserId:owner,authorAgentId:null,
  onBehalfOfUserId:null,createdByRunId:null,derivedAuthorAgentId:null,derivedCreatedByRunId:null,
  derivedAuthorSource:null,deletedAt:null,sourceTrust:null,metadata:null,presentation:null,
  createdAt:new Date(now),updatedAt:new Date(now),body} as IssueComment;

function setup(options: {spaceSlug?: string; profile?: unknown} = {}) {
  const slug=options.spaceSlug ?? "owner-notes";
  const harness = createTestHarness({manifest,config:{ownerCommentRawCapture:{...config.ownerCommentRawCapture,spaceSlug:slug}}});
  harness.seed({issues:[issue],issueComments:[comment]});
  const files = new Map<string,string>();
  let row: Record<string,unknown> | null = null;
  let creates = 0;
  let currentProfile:unknown=options.profile ?? profile;
  const observedQueries:string[]=[];
  const rawInserts:unknown[][]=[];
  const origQuery = harness.ctx.db.query.bind(harness.ctx.db);
  harness.ctx.db.query = async <T,>(sql:string,params?:unknown[]) => {
    observedQueries.push(sql);
    if (sql.includes("wiki_spaces") && sql.includes("ORDER BY CASE WHEN slug = 'default'")) return [{id:spaceId,company_id:company,wiki_id:"default",
      slug,display_name:"Owner notes",space_type:"local_folder",folder_mode:"managed_subfolder",
      root_folder_key:"wiki-root",path_prefix:slug === "default" ? null : `spaces/${slug}`,configured_root_path:null,access_scope:"shared",
      owner_user_id:null,owner_agent_id:null,team_key:null,settings:{paperclipIngestion:currentProfile},status:"active",
      created_at:now,updated_at:now}] as T[];
    if (sql.includes("wiki_spaces") && (params?.[2] === slug || (slug === "default" && sql.includes("slug = 'default'")))) return [{id:spaceId,company_id:company,wiki_id:"default",
      slug,display_name:"Owner notes",space_type:"local_folder",folder_mode:"managed_subfolder",
      root_folder_key:"wiki-root",path_prefix:slug === "default" ? null : `spaces/${slug}`,configured_root_path:null,access_scope:"shared",
      owner_user_id:null,owner_agent_id:null,team_key:null,settings:{paperclipIngestion:currentProfile},status:"active",
      created_at:now,updated_at:now}] as T[];
    if (sql.includes("paperclip_owner_raw_captures")) return (row ? [row] : []) as T[];
    return origQuery<T>(sql,params);
  };
  const origExecute = harness.ctx.db.execute.bind(harness.ctx.db);
  harness.ctx.db.execute = async (sql,params) => {
    if (sql.includes("paperclip_owner_raw_captures")) {
      if (sql.includes("INSERT")) rawInserts.push(params ?? []);
      if (sql.includes("INSERT") && !row) row={company_id:params?.[0],space_id:params?.[1],comment_id:params?.[2],
        issue_id:params?.[3],owner_user_id:params?.[4],body_sha256:params?.[5],comment_updated_at:params?.[6],
        raw_path:params?.[7],policy_sha256:params?.[8],status:"pending"};
      if (sql.includes("UPDATE") && row) row.status="verified";
      return {rowCount:1};
    }
    return origExecute(sql,params);
  };
  harness.ctx.localFolders.createTextExclusive = async (_company,_folder,path,contents) => {
    if (files.has(path)) return {created:false,status:{} as never};
    creates++;
    files.set(path,contents); return {created:true,status:{} as never};
  };
  harness.ctx.localFolders.readText = async (_company,_folder,path) => {
    const value=files.get(path); if (value===undefined) throw new Error("ENOENT"); return value;
  };
  harness.ctx.localFolders.status = async () => ({folderKey:"wiki-root",configured:true,path:"/synthetic/wiki",realPath:"/synthetic/wiki",
    access:"readWrite",readable:true,writable:true,requiredDirectories:[],requiredFiles:[],missingDirectories:[],
    missingFiles:[],healthy:true,problems:[],checkedAt:now});
  const emit = () => harness.emit("issue.comment.created",{commentId,agentId:null,runId:null,responsibleUserId:null},
    {companyId:company,entityId:issueId,entityType:"issue",actorId:owner,actorType:"user",occurredAt:now});
  return {harness,files,emit,row:()=>row,creates:()=>creates,observedQueries,rawInserts,setProfile:(value:unknown)=>{currentProfile=value}};
}

describe("owner comment raw receipt through exported plugin",()=>{
  it("stores only a quarantined raw file and verifies duplicate delivery by readback",async()=>{
    const s=setup(); await plugin.definition.setup(s.harness.ctx);
    await s.emit(); await s.emit();
    expect(s.files.size).toBe(1);
    expect([...s.files.keys()][0]).toBe(`spaces/owner-notes/.paperclip/owner-comment-raw/${spaceId}/${commentId}/${bodyHash}.txt`);
    expect([...s.files.values()][0]).toBe(body);
    expect(s.creates()).toBe(1);
    expect((s.row() as Record<string,unknown>).status).toBe("verified");
    expect(s.harness.getState({scopeKind:"company",scopeId:company,namespace:"owner-comment-raw-capture",stateKey:commentId})).toMatchObject({status:"verified",reason:null});
    const source=await s.harness.getData<{source:string}>("owner-comment-raw-source",{companyId:company,commentId});
    expect(source.source).toBe(body);
    expect(s.harness.dbExecutes.some((entry)=>entry.sql.includes("wiki_sources") || entry.sql.includes("wiki_pages"))).toBe(false);
    expect(JSON.parse(String(s.rawInserts[0]?.[9])).consentSnapshot.classification).toMatchObject(config.ownerCommentRawCapture.classification);
  });
  it("rejects edited current comment and never returns the old bytes",async()=>{
    const s=setup(); await plugin.definition.setup(s.harness.ctx); await s.emit();
    s.harness.seed({issueComments:[{...comment,body:"Edited",updatedAt:new Date("2026-10-27T10:01:00Z")}]});
    await expect(s.harness.getData("owner-comment-raw-source",{companyId:company,commentId})).rejects.toThrow();
  });
  it("normalizes incoming UUID case without changing the opaque owner identity",async()=>{
    const s=setup(); await plugin.definition.setup(s.harness.ctx);
    await s.harness.emit("issue.comment.created",{commentId:commentId.toUpperCase(),agentId:null,runId:null,responsibleUserId:null},
      {companyId:company.toUpperCase(),entityId:issueId.toUpperCase(),entityType:"issue",actorId:owner,actorType:"user",occurredAt:now});
    expect(s.row()).toMatchObject({company_id:company,issue_id:issueId,comment_id:commentId,owner_user_id:owner,status:"verified"});
    expect(s.files.size).toBe(1);
    expect([...s.files.keys()][0]).toBe(`spaces/owner-notes/.paperclip/owner-comment-raw/${spaceId}/${commentId}/${bodyHash}.txt`);
  });
  it("reads the canonical receipt for uppercase company and comment UUIDs",async()=>{
    const s=setup(); await plugin.definition.setup(s.harness.ctx); await s.emit();
    const result=await s.harness.getData<{source:string;commentId:string;companyId:string}>("owner-comment-raw-source",
      {companyId:company.toUpperCase(),commentId:commentId.toUpperCase()});
    expect(result).toMatchObject({source:body,commentId,companyId:company});
    expect(s.creates()).toBe(1);
  });
  it("is default-off and never writes a raw file",async()=>{
    const s=setup(); s.harness.setConfig({}); await plugin.definition.setup(s.harness.ctx); await s.emit();
    expect(s.files.size).toBe(0); expect(s.row()).toBeNull();
  });
  it("skips out-of-scope agent comments without raw health or DB effects",async()=>{
    const s=setup();await plugin.definition.setup(s.harness.ctx);
    await s.harness.emit("issue.comment.created",{commentId,agentId:"agent-1",runId:null,responsibleUserId:null},
      {companyId:company,entityId:"99999999-9999-4999-8999-999999999999",entityType:"issue",actorId:"agent-1",actorType:"agent",occurredAt:now});
    expect(s.row()).toBeNull();expect(s.files.size).toBe(0);
    expect(s.harness.getState({scopeKind:"company",scopeId:company,namespace:"owner-comment-raw-capture",stateKey:commentId})).toBeUndefined();
  });
  it("uses one config health key for malformed enabled config",async()=>{
    const s=setup();s.harness.setConfig({ownerCommentRawCapture:{...config.ownerCommentRawCapture,classification:null}});
    await plugin.definition.setup(s.harness.ctx);await expect(s.emit()).rejects.toThrow("owner_comment_raw_invalid_config");
    expect(s.harness.getState({scopeKind:"company",scopeId:company,namespace:"owner-comment-raw-capture",stateKey:"config"})).toMatchObject({status:"hold",reason:"invalid_config"});
    expect(s.harness.getState({scopeKind:"company",scopeId:company,namespace:"owner-comment-raw-capture",stateKey:commentId})).toBeUndefined();
  });
  it("does not write health when config cannot be read and default-off is unknown",async()=>{
    const s=setup();await plugin.definition.setup(s.harness.ctx);
    s.harness.ctx.config.get=async()=>{throw new Error(`private ${body}`)};
    await expect(s.emit()).rejects.toThrow("owner_comment_raw_config_unavailable");
    expect(s.harness.getState({scopeKind:"company",scopeId:company,namespace:"owner-comment-raw-capture",stateKey:commentId})).toBeUndefined();
    expect(s.harness.logs.some((line)=>JSON.stringify(line).includes(body))).toBe(false);
  });
  it("serializes competing deliveries through one row and one create-only leaf",async()=>{
    const s=setup(); await plugin.definition.setup(s.harness.ctx);
    await Promise.all([s.emit(),s.emit()]);
    expect(s.files.size).toBe(1);
    expect((s.row() as Record<string,unknown>).status).toBe("verified");
  });
  it("keeps a pending row after a write failure and resumes without replacing bytes",async()=>{
    const s=setup(); await plugin.definition.setup(s.harness.ctx);
    const create=s.harness.ctx.localFolders.createTextExclusive;
    let once=true;
    s.harness.ctx.localFolders.createTextExclusive=async (...args)=>{
      if (once) {once=false;throw new Error("synthetic write failure");}
      return create(...args);
    };
    await expect(s.emit()).rejects.toThrow("owner_comment_raw_io_pending");
    expect((s.row() as Record<string,unknown>).status).toBe("pending");
    expect(s.files.size).toBe(0);
    await s.emit();
    expect((s.row() as Record<string,unknown>).status).toBe("verified");
    expect(s.files.size).toBe(1);
    expect(s.harness.getState({scopeKind:"company",scopeId:company,namespace:"owner-comment-raw-capture",stateKey:commentId})).toMatchObject({status:"verified",reason:null});
  });
  it("holds when the current comment changes between file write and finalization",async()=>{
    const s=setup(); await plugin.definition.setup(s.harness.ctx);
    const get=s.harness.ctx.issues.listComments;
    let calls=0;
    s.harness.ctx.issues.listComments=async (...args)=>{
      const comments=await get(...args); calls++;
      return calls===2 ? [{...comments[0]!,body:"changed",updatedAt:new Date("2026-10-27T10:01:00Z")}] : comments;
    };
    await expect(s.emit()).rejects.toThrow("owner_comment_raw_comment_version");
    expect((s.row() as Record<string,unknown>).status).toBe("pending");
    expect(s.files.size).toBe(1);
    expect(s.harness.getState({scopeKind:"company",scopeId:company,namespace:"owner-comment-raw-capture",stateKey:commentId})).toMatchObject({status:"hold"});
    expect(s.harness.logs.some((line)=>line.message==="LLM Wiki recorded Paperclip event for cursor discovery")).toBe(true);
    s.harness.ctx.issues.listComments=get;
    await s.emit();
    expect((s.row() as Record<string,unknown>).status).toBe("verified");
    expect(s.creates()).toBe(1);
    expect(s.harness.getState({scopeKind:"company",scopeId:company,namespace:"owner-comment-raw-capture",stateKey:commentId})).toMatchObject({status:"verified",reason:null});
  });
  it("holds a body race even when the comment timestamp is unchanged",async()=>{
    const s=setup(); await plugin.definition.setup(s.harness.ctx);
    const get=s.harness.ctx.issues.listComments;
    let calls=0;
    s.harness.ctx.issues.listComments=async (...args)=>{
      const comments=await get(...args); calls++;
      return calls===2 ? [{...comments[0]!,body:"Changed within the same timestamp."}] : comments;
    };
    await expect(s.emit()).rejects.toThrow("owner_comment_raw_version_race");
    expect((s.row() as Record<string,unknown>).status).toBe("pending");
    expect(s.files.size).toBe(1);
    expect(s.harness.getState({scopeKind:"company",scopeId:company,namespace:"owner-comment-raw-capture",stateKey:commentId})).toMatchObject({status:"hold",reason:"version_race"});
    await expect(s.harness.getData("owner-comment-raw-source",{companyId:company,commentId})).rejects.toThrow("owner_comment_raw_reader_row");
  });
  it.each<[
    string,
    {actorType?: string; actorId?: string; payload?: Record<string,unknown>}
  ]>([
    ["agent actor",{actorType:"agent",payload:{commentId,agentId:"agent-1",runId:null,responsibleUserId:null}}],
    ["other actor",{actorId:"99999999-9999-4999-8999-999999999999"}],
  ])("skips in-scope %s without raw health or DB effects",async(_label,change)=>{
    const s=setup();await plugin.definition.setup(s.harness.ctx);
    await s.harness.emit("issue.comment.created",change.payload ?? {commentId,agentId:null,runId:null,responsibleUserId:null},
      {companyId:company,entityId:issueId,entityType:"issue",actorId:change.actorId ?? owner,
        actorType:(change.actorType ?? "user") as "user"|"agent",occurredAt:now});
    expect(s.files.size).toBe(0);expect(s.row()).toBeNull();
    expect(s.harness.getState({scopeKind:"company",scopeId:company,namespace:"owner-comment-raw-capture",stateKey:commentId})).toBeUndefined();
    expect(s.observedQueries.some((sql)=>sql.includes("paperclip_owner_raw_captures"))).toBe(false);
  });
  it.each<[
    string,
    {actorType?: string; actorId?: string; payload?: Record<string,unknown>}
  ]>([
    ["agent marker on owner event",{payload:{commentId,agentId:"agent-1",runId:null,responsibleUserId:null}}],
    ["run marker",{payload:{commentId,agentId:null,runId:"run-1",responsibleUserId:null}}],
    ["missing exact comment",{payload:{commentId:"99999999-9999-4999-8999-999999999999",agentId:null,runId:null,responsibleUserId:null}}],
  ])("fails closed for %s",async(_label,change)=>{
    const s=setup();await plugin.definition.setup(s.harness.ctx);
    await expect(s.harness.emit("issue.comment.created",change.payload ?? {commentId,agentId:null,runId:null,responsibleUserId:null},
      {companyId:company,entityId:issueId,entityType:"issue",actorId:change.actorId ?? owner,
        actorType:(change.actorType ?? "user") as "user"|"agent",occurredAt:now})).rejects.toThrow();
    expect(s.files.size).toBe(0);expect(s.row()).toBeNull();
  });
  it("normalizes case-insensitive configured issue IDs for capture and current reads",async()=>{
    const s=setup();s.harness.setConfig({ownerCommentRawCapture:{...config.ownerCommentRawCapture,issueIds:[issueId.toUpperCase()]}});
    await plugin.definition.setup(s.harness.ctx);await s.emit();
    expect((s.row() as Record<string,unknown>).status).toBe("verified");
    const result=await s.harness.getData<{source:string}>("owner-comment-raw-source",{companyId:company,commentId});
    expect(result.source).toBe(body);
  });
  it("rejects configured issue IDs duplicated only by letter case",async()=>{
    const s=setup();s.harness.setConfig({ownerCommentRawCapture:{...config.ownerCommentRawCapture,issueIds:[issueId,issueId.toUpperCase()]}});
    await plugin.definition.setup(s.harness.ctx);
    await expect(s.emit()).rejects.toThrow("owner_comment_raw_invalid_config");
    expect(s.row()).toBeNull();expect(s.files.size).toBe(0);
  });
  it("rejects a missing classification before any DB or file effect",async()=>{
    const s=setup();s.harness.setConfig({ownerCommentRawCapture:{...config.ownerCommentRawCapture,classification:null}});
    await plugin.definition.setup(s.harness.ctx);
    await expect(s.emit()).rejects.toThrow("owner_comment_raw_invalid_config");
    expect(s.files.size).toBe(0);expect(s.row()).toBeNull();
  });
  it("holds on an existing different leaf and does not overwrite it",async()=>{
    const s=setup();await plugin.definition.setup(s.harness.ctx);await s.emit();
    const path=[...s.files.keys()][0]!;
    s.files.set(path,"synthetic tamper");
    await expect(s.emit()).rejects.toThrow("owner_comment_raw_file_integrity");
    expect(s.files.get(path)).toBe("synthetic tamper");
    expect(s.creates()).toBe(1);
  });
  it("refuses a conflicting previously claimed body hash without a second path",async()=>{
    const s=setup();await plugin.definition.setup(s.harness.ctx);await s.emit();
    (s.row() as Record<string,unknown>).body_sha256="0".repeat(64);
    await expect(s.emit()).rejects.toThrow("owner_comment_raw_row_conflict");
    expect(s.files.size).toBe(1);
  });
  it("refuses to expose a pending row even if its file was created",async()=>{
    const s=setup();await plugin.definition.setup(s.harness.ctx);await s.emit();
    (s.row() as Record<string,unknown>).status="pending";
    await expect(s.harness.getData("owner-comment-raw-source",{companyId:company,commentId})).rejects.toThrow("owner_comment_raw_reader_row");
  });
  it("recovers a failed final DB update from the same file without a second create",async()=>{
    const s=setup();await plugin.definition.setup(s.harness.ctx);
    const execute=s.harness.ctx.db.execute;
    let fail=true;
    s.harness.ctx.db.execute=async (sql,params)=>{
      if (fail && sql.includes("paperclip_owner_raw_captures") && sql.includes("UPDATE")) {
        fail=false;throw new Error(`private ${body}`);
      }
      return execute(sql,params);
    };
    await expect(s.emit()).rejects.toThrow("owner_comment_raw_io_pending");
    expect((s.row() as Record<string,unknown>).status).toBe("pending");
    expect(s.creates()).toBe(1);
    await s.emit();
    expect(s.creates()).toBe(1);
    expect((s.row() as Record<string,unknown>).status).toBe("verified");
    expect(s.harness.getState({scopeKind:"company",scopeId:company,namespace:"owner-comment-raw-capture",stateKey:commentId})).toMatchObject({status:"verified"});
  });
  it("never recreates a missing file after DB verification",async()=>{
    const s=setup();await plugin.definition.setup(s.harness.ctx);await s.emit();
    s.files.clear();
    await expect(s.emit()).rejects.toThrow("owner_comment_raw_verified_file_unavailable");
    expect(s.files.size).toBe(0);expect(s.creates()).toBe(1);
    expect((s.row() as Record<string,unknown>).status).toBe("verified");
    expect(s.harness.getState({scopeKind:"company",scopeId:company,namespace:"owner-comment-raw-capture",stateKey:commentId})).toMatchObject({status:"hold",reason:"verified_file_unavailable"});
  });
  it("holds unhealthy folder before claiming the source",async()=>{
    const s=setup();await plugin.definition.setup(s.harness.ctx);
    s.harness.ctx.localFolders.status=async()=>({folderKey:"wiki-root",configured:true,path:"/synthetic/wiki",realPath:"/synthetic/wiki",
      access:"readWrite",readable:true,writable:true,requiredDirectories:[],requiredFiles:["AGENTS.md"],
      missingDirectories:[],missingFiles:["AGENTS.md"],healthy:false,problems:[],checkedAt:now});
    await expect(s.emit()).rejects.toThrow("owner_comment_raw_folder_unhealthy");
    expect(s.row()).toBeNull();expect(s.files.size).toBe(0);
  });
  it("keeps a receipt readable after an added issue, but denies removed issue and owner changes",async()=>{
    const s=setup();await plugin.definition.setup(s.harness.ctx);await s.emit();
    const extra="99999999-9999-4999-8999-999999999999";
    s.setProfile({...profile,sourceScopes:[{kind:"root_issues",issueIds:[issueId,extra]}]});
    s.harness.setConfig({ownerCommentRawCapture:{...config.ownerCommentRawCapture,issueIds:[issueId,extra]}});
    expect((await s.harness.getData<{source:string}>("owner-comment-raw-source",{companyId:company,commentId})).source).toBe(body);
    s.harness.setConfig({ownerCommentRawCapture:{...config.ownerCommentRawCapture,issueIds:[issueId,extra],
      classification:{...config.ownerCommentRawCapture.classification,decisionRef:"new-synthetic-decision"}}});
    expect((await s.harness.getData<{source:string}>("owner-comment-raw-source",{companyId:company,commentId})).source).toBe(body);
    s.harness.setConfig({ownerCommentRawCapture:{...config.ownerCommentRawCapture,issueIds:[extra]}});
    await expect(s.harness.getData("owner-comment-raw-source",{companyId:company,commentId})).rejects.toThrow();
    s.harness.setConfig({ownerCommentRawCapture:{...config.ownerCommentRawCapture,ownerUserId:"different-fixture-owner",classification:{...config.ownerCommentRawCapture.classification,decidedByUserId:"different-fixture-owner"}}});
    await expect(s.harness.getData("owner-comment-raw-source",{companyId:company,commentId})).rejects.toThrow();
  });
  it("selects the timestamp as stable UTC ISO rather than session-local text",async()=>{
    const s=setup();await plugin.definition.setup(s.harness.ctx);await s.emit();
    expect(s.observedQueries.some((sql)=>sql.includes("to_char(comment_updated_at AT TIME ZONE 'UTC'"))).toBe(true);
    expect(s.observedQueries.some((sql)=>sql.includes("comment_updated_at::text"))).toBe(false);
  });
  it.each([
    ["deleted",{deletedAt:new Date(now)}],
    ["derived agent",{derivedAuthorAgentId:"agent-1"}],
    ["oversize",{body:"x".repeat(250001)}],
    ["secret",{body:"Authorization: Bearer synthetic-secret-token"}],
  ])("holds %s current material before any claim",async(_label,patch)=>{
    const s=setup();await plugin.definition.setup(s.harness.ctx);
    s.harness.ctx.issues.listComments=async()=>[{...comment,...patch}];
    await expect(s.emit()).rejects.toThrow("owner_comment_raw_");
    expect(s.row()).toBeNull();expect(s.files.size).toBe(0);
  });
  it("allows the default space only with its own strict explicit profile",async()=>{
    const s=setup({spaceSlug:"default"});await plugin.definition.setup(s.harness.ctx);await s.emit();
    expect(s.files.size).toBe(1);
    expect([...s.files.keys()][0]).toMatch(/^\.paperclip\/owner-comment-raw\//);
  });
  it("rejects unknown source scopes before a file claim",async()=>{
    const s=setup({profile:{...profile,sourceScopes:[{kind:"root_issues",issueIds:[issueId]},{kind:"unknown_future_scope"}]}});
    await plugin.definition.setup(s.harness.ctx);
    await expect(s.emit()).rejects.toThrow("owner_comment_raw_space_policy");
    expect(s.files.size).toBe(0);expect(s.row()).toBeNull();
  });
  it("reports a fixed code when health state write fails without revealing source bytes",async()=>{
    const s=setup();await plugin.definition.setup(s.harness.ctx);
    const set=s.harness.ctx.state.set;
    s.harness.ctx.state.set=async (key,value)=>{
      if (key.namespace==="owner-comment-raw-capture") throw new Error(`private ${body}`);
      return set(key,value);
    };
    await expect(s.emit()).rejects.toThrow("owner_comment_raw_state_write_failed");
    expect((s.row() as Record<string,unknown>).status).toBe("verified");
    expect(s.harness.logs.some((line)=>JSON.stringify(line).includes(body))).toBe(false);
  });
  it("reports a fixed code if hold health state cannot be written",async()=>{
    const s=setup();await plugin.definition.setup(s.harness.ctx);
    const set=s.harness.ctx.state.set;
    s.harness.ctx.state.set=async (key,value)=>{
      if (key.namespace==="owner-comment-raw-capture") throw new Error(`private ${body}`);
      return set(key,value);
    };
    s.harness.ctx.issues.listComments=async()=>[{...comment,deletedAt:new Date(now)}];
    await expect(s.emit()).rejects.toThrow("owner_comment_raw_state_write_failed");
    expect(s.row()).toBeNull();expect(s.files.size).toBe(0);
    expect(s.harness.logs.some((line)=>JSON.stringify(line).includes(body))).toBe(false);
  });
  it("refuses a reader Issue whose returned identity differs from the claimed row",async()=>{
    const s=setup();await plugin.definition.setup(s.harness.ctx);await s.emit();
    s.harness.ctx.issues.get=async()=>({...issue,id:"99999999-9999-4999-8999-999999999999"});
    await expect(s.harness.getData("owner-comment-raw-source",{companyId:company,commentId})).rejects.toThrow("owner_comment_raw_reader_issue");
  });
  it("keeps verified raw independent when cursor discovery fails",async()=>{
    const s=setup();await plugin.definition.setup(s.harness.ctx);
    const execute=s.harness.ctx.db.execute;
    s.harness.ctx.db.execute=async (sql,params)=>{
      if (sql.includes("paperclip_distillation_cursors")) throw new Error("synthetic cursor failure");
      return execute(sql,params);
    };
    await expect(s.emit()).rejects.toThrow("synthetic cursor failure");
    expect((s.row() as Record<string,unknown>).status).toBe("verified");
    expect(s.harness.logs.some((line)=>line.message==="Owner comment raw receipt verified")).toBe(true);
  });
  it("keeps ordinary raw source and page tools outside the quarantine",async()=>{
    const s=setup();await plugin.definition.setup(s.harness.ctx);await s.emit();
    const hidden=`.paperclip/owner-comment-raw/${spaceId}/${commentId}/${bodyHash}.txt`;
    await expect(s.harness.executeTool("wiki_read_source",{companyId:company,spaceSlug:"owner-notes",rawPath:hidden})).rejects.toThrow();
    await expect(s.harness.executeTool("wiki_read_page",{companyId:company,spaceSlug:"owner-notes",path:hidden})).rejects.toThrow();
    expect(s.files.size).toBe(1);
  });
});
