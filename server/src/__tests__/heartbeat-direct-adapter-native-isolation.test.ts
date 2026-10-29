import {commanderAdmissionDigest} from "../services/commander-cycle.js";
import {applyIssueExecutionPolicyTransition} from "../services/issue-execution-policy.js";
import { createHash, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisions,
  documents,issueDocuments,
  workAssessments,
} from "@paperclipai/db";
import type { ServerAdapterModule } from "../adapters/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  registerServerAdapter,
  unregisterServerAdapter,
} from "../adapters/index.js";
import {captureCommanderHermesClaim,completeCommanderHermesResult,pendingCommanderResultHandoffs} from "../services/commander-result.js";
import {prepareCommanderAdmission} from "../services/commander-admission.js";
import { heartbeatService } from "../services/heartbeat.js";
import { SELF_TASK_DOCUMENT_CONTEXT_KEY } from "../services/self-task-document-runtime.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;
const DIRECT_ADAPTERS = [
  ["codex_local", "codex"],
  ["claude_local", "claude"],
  ["opencode_local", "opencode"],
] as const;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping direct-adapter native-isolation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

describeEmbeddedPostgres("direct adapter native-runner isolation", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  const execute = vi.fn<ServerAdapterModule["execute"]>();

  it.each(["success", "existing_receipt", "revision_changed", "policy_revoked", "parent_stopped"])("commander dispatch admission: %s",async mode=>{
    const companyId=randomUUID(), commander=randomUUID(),worker=randomUUID(),issueId=randomUUID(),admissionId=randomUUID();
    const admission={id:admissionId,issueId,workerAgentId:worker,revision:0,statusVersion:0,
      descriptionSha256:createHash("sha256").update("public bounded fixture").digest("hex"),expiresAt:new Date(Date.now()+60_000).toISOString()};
    const policy={version:1,companyId,commanderAgentId:commander,admissions:[admission]};
    let workerCalls=0;
    registerServerAdapter({type:"claude_local",supportsLocalAgentJwt:false,execute:async ctx=>{
      if(ctx.agent.id===worker){workerCalls++;await db.update(issues).set({status:"done",revision:1,statusVersion:1}).where(eq(issues.id,issueId));return {exitCode:0,signal:null,timedOut:false,summary:"worker fixture"};}
      expect(ctx.runtimeTools).toBeUndefined();expect(ctx.runtimeMcp?.getServers()??[]).toEqual([]);
      expect(ctx.context.paperclipManagedMcp).toBeUndefined();expect(ctx.authToken).toBeUndefined();
      const snapshot=String(ctx.context.paperclipCommanderPrompt);
      if(mode==="success" && workerCalls>0)return {exitCode:0,signal:null,timedOut:false,summary:JSON.stringify({schema:"PAPERCLIP_COMMANDER_CYCLE_V1",admissionId:null,reason:"completed task excluded"})};
      expect(snapshot).toContain(admissionId);
      if(mode==="revision_changed")await db.update(issues).set({revision:1}).where(eq(issues.id,issueId));
      if(mode==="policy_revoked")await db.update(agents).set({adapterConfig:{commanderCycleToolsOnly:true,commanderCyclePolicy:{...policy,admissions:[]}}}).where(eq(agents.id,commander));
      if(mode==="parent_stopped")await db.update(heartbeatRuns).set({status:"cancelled"}).where(eq(heartbeatRuns.id,ctx.runId));
      return {exitCode:0,signal:null,timedOut:false,summary:JSON.stringify({schema:"PAPERCLIP_COMMANDER_CYCLE_V1",admissionId,reason:"approved existing fixture"})};
    },testEnvironment:async()=>({adapterType:"claude_local",status:"pass",checks:[],testedAt:new Date(0).toISOString()})});
    await db.insert(companies).values({id:companyId,name:"Commander fixture",issuePrefix:"CF",defaultResponsibleUserId:"responsible-user"});
    await db.insert(agents).values([
      {id:commander,companyId,name:"commander",adapterType:"claude_local",role:"engineer",status:"idle",adapterConfig:{commanderCycleToolsOnly:true,commanderCyclePolicy:policy},runtimeConfig:{heartbeat:{enabled:true,wakeOnDemand:true,maxConcurrentRuns:1}},permissions:{}},
      {id:worker,companyId,name:"worker",adapterType:"claude_local",role:"engineer",status:"idle",adapterConfig:{},runtimeConfig:{heartbeat:{enabled:false,wakeOnDemand:true,maxConcurrentRuns:1}},permissions:{}},
    ]);
    await db.insert(issues).values({id:issueId,companyId,issueNumber:1,identifier:"CF-1",title:"bounded fixture",description:"public bounded fixture",status:"todo",assigneeAgentId:worker});
    expect(await heartbeat.invoke(commander,"on_demand",{issueId},"manual")).toBeNull();
    expect(workerCalls).toBe(0);
    expect(await heartbeat.invoke(worker,"assignment",{issueId},"system")).toBeNull();
    expect(workerCalls).toBe(0);
    let previousRunId:string|null=null;
    if(mode==="existing_receipt"){
      previousRunId=randomUUID();await db.insert(heartbeatRuns).values({id:previousRunId,companyId,agentId:worker,status:"succeeded",exitCode:0,finishedAt:new Date(),contextSnapshot:{issueId}});
      await db.insert(agentWakeupRequests).values({companyId,agentId:worker,source:"automation",status:"processed",runId:previousRunId,idempotencyKey:`commander-admission:${companyId}:${admissionId}`,payload:{issueId}});
    }
    const queued=await heartbeat.invoke(commander,"timer",{},"system");expect(queued).not.toBeNull();
    const result=await waitForRunToFinish(heartbeat,queued!.id);
    if(mode==="success") {
      expect(result?.status).toBe("succeeded");expect(result?.resultJson?.commanderCycle).toMatchObject({outcome:"dispatched",admissionId});
      await drainHeartbeatRunsToQuiescence(db,heartbeat);expect(workerCalls).toBe(1);
      const again=await heartbeat.invoke(commander,"on_demand",{},"manual");expect(again).not.toBeNull();
      expect((await waitForRunToFinish(heartbeat,again!.id))?.status).toBe("succeeded");
      await drainHeartbeatRunsToQuiescence(db,heartbeat);expect(workerCalls).toBe(1);
    }else if(mode==="existing_receipt"){expect(result?.status).toBe("succeeded");expect(result?.resultJson?.commanderCycle).toMatchObject({dispatchRunId:previousRunId});expect(workerCalls).toBe(0);}
    else {expect(result?.status).not.toBe("succeeded");expect(workerCalls).toBe(0);}
  },30_000);

  it.each(["success","revision","status_version","hash","expired","assigned","active","other_company"])("board commander preparation CAS: %s",async mode=>{
    const companyId=randomUUID(),commander=randomUUID(),worker=randomUUID(),issueId=randomUUID(),admissionId=randomUUID();
    const admission={id:admissionId,issueId,workerAgentId:worker,revision:1,statusVersion:1,descriptionSha256:createHash("sha256").update("approved fixture").digest("hex"),expiresAt:new Date(Date.now()+60_000).toISOString()};
    if(mode==="hash")admission.descriptionSha256="0".repeat(64);
    if(mode==="expired")admission.expiresAt=new Date(Date.now()-1000).toISOString();
    const policy={version:1,companyId:mode==="other_company"?randomUUID():companyId,commanderAgentId:commander,admissions:[admission]};
    await db.insert(companies).values({id:companyId,name:"Prepare fixture",issuePrefix:companyId.replace(/-/g,"").toUpperCase(),defaultResponsibleUserId:"responsible-user"});
    await db.insert(agents).values([{id:commander,companyId,name:"commander",role:"engineer",adapterType:"claude_local",status:"idle",adapterConfig:{commanderCycleToolsOnly:true,commanderCyclePolicy:policy}},{id:worker,companyId,name:"worker",role:"engineer",adapterType:"claude_local",status:"idle"}]);
    await db.insert(issues).values({id:issueId,companyId,issueNumber:1,identifier:companyId.replace(/-/g,"").toUpperCase()+"-1",title:"fixture",description:"approved fixture",status:"backlog",assigneeAgentId:mode==="assigned"?worker:null});
    if(mode==="active")await db.insert(heartbeatRuns).values({companyId,agentId:worker,status:"running",contextSnapshot:{issueId}});
    const request={commanderAgentId:commander,admissionId,workerAgentId:worker,admissionSha256:commanderAdmissionDigest(admission),revision:mode==="revision"?1:0,statusVersion:mode==="status_version"?1:0};
    if(mode==="success"){
      const prepared=await prepareCommanderAdmission(db,companyId,issueId,"board-user",request);expect(prepared).toMatchObject({status:"todo",assigneeAgentId:worker,revision:1,statusVersion:1});
      expect(await heartbeat.invoke(worker,"assignment",{issueId},"system")).toBeNull();
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId,companyId))).toEqual([expect.objectContaining({status:"skipped",reason:"commander_reserved_task",runId:null})]);
      await expect(prepareCommanderAdmission(db,companyId,issueId,"board-user",request)).rejects.toThrow();
    }else{
      await expect(prepareCommanderAdmission(db,companyId,issueId,"board-user",request)).rejects.toThrow();
      const [current]=await db.select().from(issues).where(eq(issues.id,issueId));expect(current).toMatchObject({status:"backlog",revision:0,statusVersion:0});
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId,companyId))).toEqual([]);
      if(mode==="active")await db.update(heartbeatRuns).set({status:"cancelled",finishedAt:new Date()}).where(eq(heartbeatRuns.companyId,companyId));
    }
  },30_000);

  it.each(["success","edited","stopped","revoked","same_reviewer","invalid_result","existing_document","withdraw_before_provider"])("commander server-owned result handoff: %s",async mode=>{
    const companyId=randomUUID(),commander=randomUUID(),worker=randomUUID(),qa=randomUUID(),issueId=randomUUID(),runId=randomUUID(),parentId=randomUUID(),wakeId=randomUUID();
    const admission={id:randomUUID(),issueId,workerAgentId:worker,revision:1,statusVersion:1,descriptionSha256:createHash("sha256").update("public task").digest("hex"),expiresAt:new Date(Date.now()+60_000).toISOString(),resultHandoff:{reviewerAgentId:mode==="same_reviewer"?worker:qa,ownerUserId:"responsible-user",documentKey:"fixed-result"}};
    const policy={version:1,companyId,commanderAgentId:commander,admissions:[admission]};
    await db.insert(companies).values({id:companyId,name:"Handoff fixture",issuePrefix:companyId.replace(/-/g,"").toUpperCase(),defaultResponsibleUserId:"responsible-user"});
    await db.insert(agents).values([{id:commander,companyId,name:"commander",role:"engineer",adapterType:"codex_local",status:"idle",adapterConfig:{commanderCycleToolsOnly:true,commanderCyclePolicy:policy}},{id:worker,companyId,name:"worker",role:"engineer",adapterType:"hermes_local",status:"idle",adapterConfig:{boundedExecution:true,qaReviewToolsOnly:true}},{id:qa,companyId,name:"qa",role:"engineer",adapterType:"codex_local",status:"idle",adapterConfig:{qaReviewToolsOnly:true}}]);
    await db.insert(issues).values({id:issueId,companyId,issueNumber:1,identifier:companyId.replace(/-/g,"").toUpperCase()+"-1",title:"fixture",description:"public task",status:"in_progress",revision:2,statusVersion:2,assigneeAgentId:worker});
    await db.insert(agentWakeupRequests).values({id:wakeId,companyId,agentId:worker,source:"automation",status:"processed",reason:"commander_admitted_task",requestedByActorType:"agent",requestedByActorId:commander,idempotencyKey:`commander-admission:${companyId}:${admission.id}`,payload:{issueId}});
    await db.insert(heartbeatRuns).values([{id:parentId,companyId,agentId:commander,status:"succeeded",exitCode:0,finishedAt:new Date()},{id:runId,companyId,agentId:worker,status:"running",wakeupRequestId:wakeId,contextSnapshot:{issueId,commanderRunId:parentId,commanderAdmission:admission}}]);
    try {
    if(mode==="withdraw_before_provider"){await db.update(agents).set({adapterConfig:{commanderCycleToolsOnly:true,commanderCyclePolicy:{...policy,admissions:[]}}}).where(eq(agents.id,commander));await expect(captureCommanderHermesClaim(db,runId)).rejects.toThrow();return;}
    const claim=await captureCommanderHermesClaim(db,runId);expect(claim).not.toBeNull();
    if(mode==="edited")await db.update(issues).set({revision:3}).where(eq(issues.id,issueId));
    if(mode==="stopped")await db.update(heartbeatRuns).set({status:"cancelled"}).where(eq(heartbeatRuns.id,runId));
    if(mode==="revoked")await db.update(agents).set({adapterConfig:{commanderCycleToolsOnly:true,commanderCyclePolicy:{...policy,admissions:[]}}}).where(eq(agents.id,commander));
    const result={result:"fixed public report",source_urls:["https://docs.paperclip.ing/reference/cli/agent"],web_search_count:mode==="invalid_result"?0:1};
    if(mode==="existing_document"){await db.insert(documents).values({id:randomUUID(),companyId,latestBody:"old"}).returning().then(async ([d])=>{await db.insert(issueDocuments).values({companyId,issueId,documentId:d.id,key:"fixed-result"});});}
    if(mode==="success"){
      const handoff=await completeCommanderHermesResult(db,runId,claim!,result);expect(handoff.reviewerAgentId).toBe(qa);
      const [i]=await db.select().from(issues).where(eq(issues.id,issueId));expect(i).toMatchObject({status:"in_review",revision:4,statusVersion:3,assigneeAgentId:qa});expect(i.executionState).toMatchObject({status:"pending",currentStageType:"review"});
      const [r]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId));expect(r.resultJson?.commanderHandoff).toMatchObject({runId,documentKey:"fixed-result"});
      await expect(completeCommanderHermesResult(db,runId,claim!,result)).rejects.toThrow();
      expect(await db.select().from(issueDocuments).where(eq(issueDocuments.issueId,issueId))).toHaveLength(1);
      expect(await pendingCommanderResultHandoffs(db)).toHaveLength(1);
      let qaCalls=0;registerServerAdapter({type:"codex_local",supportsLocalAgentJwt:false,execute:async()=>{qaCalls++;const [current]=await db.select().from(issues).where(eq(issues.id,issueId));const transition=applyIssueExecutionPolicyTransition({issue:current,policy:current.executionPolicy!,previousPolicy:current.executionPolicy!,requestedStatus:"done",requestedAssigneePatch:{},actor:{agentId:qa,userId:null},commentBody:"Independent fixture approval after restart"});await db.update(issues).set({...transition.patch,revision:current.revision+1,statusVersion:current.statusVersion+1}).where(eq(issues.id,issueId));return {exitCode:0,signal:null,timedOut:false,summary:"QA approved; owner pending"};},testEnvironment:async()=>({adapterType:"codex_local",status:"pass",checks:[],testedAt:new Date(0).toISOString()})});
      // Crash after atomic receipt, before any QA enqueue. Existing reconciler must dispatch QA only.
      await db.update(heartbeatRuns).set({status:"failed",finishedAt:new Date(),errorCode:"restart_fixture"}).where(eq(heartbeatRuns.id,runId));
      await heartbeat.reconcileStrandedAssignedIssues();await drainHeartbeatRunsToQuiescence(db,heartbeat);await heartbeat.reconcileStrandedAssignedIssues();await drainHeartbeatRunsToQuiescence(db,heartbeat);
      expect(qaCalls).toBe(1);expect(await pendingCommanderResultHandoffs(db)).toEqual([]);const [owned]=await db.select().from(issues).where(eq(issues.id,issueId));expect(owned.executionState).toMatchObject({status:"pending",currentStageType:"approval",lastDecisionOutcome:"approved"});
    }else{await expect(completeCommanderHermesResult(db,runId,claim!,result)).rejects.toThrow();const [i]=await db.select().from(issues).where(eq(issues.id,issueId));expect(i.status).toBe("in_progress");}
    } finally {await db.update(heartbeatRuns).set({status:"cancelled",finishedAt:new Date()}).where(eq(heartbeatRuns.id,runId));}
  },30_000);

  it("normal timer dispatch hands fixed Hermes result to QA and owner without repair redispatch",async()=>{
    const companyId=randomUUID(),commander=randomUUID(),worker=randomUUID(),qa=randomUUID(),issueId=randomUUID(),admissionId=randomUUID();let workerCalls=0,qaCalls=0;
    const admission={id:admissionId,issueId,workerAgentId:worker,revision:1,statusVersion:1,descriptionSha256:createHash("sha256").update("bounded public handoff").digest("hex"),expiresAt:new Date(Date.now()+60_000).toISOString(),resultHandoff:{reviewerAgentId:qa,ownerUserId:"responsible-user",documentKey:"fixed-handoff"}};
    const policy={version:1,companyId,commanderAgentId:commander,admissions:[admission]};
    registerServerAdapter({type:"codex_local",supportsLocalAgentJwt:false,execute:async ctx=>{
      if(ctx.agent.id===qa){qaCalls++;const [i]=await db.select().from(issues).where(eq(issues.id,issueId));const transition=applyIssueExecutionPolicyTransition({issue:i,policy:i.executionPolicy!,previousPolicy:i.executionPolicy!,requestedStatus:"done",requestedAssigneePatch:{},actor:{agentId:qa,userId:null},commentBody:"Independent fixture approval of fixed report"});await db.update(issues).set({...transition.patch,revision:i.revision+1,statusVersion:i.statusVersion+1}).where(eq(issues.id,issueId));return {exitCode:0,signal:null,timedOut:false,summary:"QA approved; owner decision pending"};}
      const [i]=await db.select().from(issues).where(eq(issues.id,issueId));return {exitCode:0,signal:null,timedOut:false,summary:JSON.stringify({schema:"PAPERCLIP_COMMANDER_CYCLE_V1",admissionId:i.status==="todo"?admissionId:null,reason:i.status==="todo"?"bounded admission":"owner pending, idle"})};
    },testEnvironment:async()=>({adapterType:"codex_local",status:"pass",checks:[],testedAt:new Date(0).toISOString()})});
    registerServerAdapter({type:"hermes_local",supportsLocalAgentJwt:false,execute:async()=>{workerCalls++;return {exitCode:0,signal:null,timedOut:false,summary:"fixed result",resultJson:{result:"Bounded public contract report with actual source evidence",source_urls:["https://docs.paperclip.ing/reference/cli/agent"],web_search_count:1}};},testEnvironment:async()=>({adapterType:"hermes_local",status:"pass",checks:[],testedAt:new Date(0).toISOString()})});
    await db.insert(companies).values({id:companyId,name:"Normal handoff fixture",issuePrefix:companyId.replace(/-/g,"").toUpperCase(),defaultResponsibleUserId:"responsible-user"});
    await db.insert(agents).values([{id:commander,companyId,name:"commander",role:"engineer",adapterType:"codex_local",status:"idle",adapterConfig:{commanderCycleToolsOnly:true,commanderCyclePolicy:policy},runtimeConfig:{heartbeat:{enabled:true,wakeOnDemand:true,maxConcurrentRuns:1}}},{id:worker,companyId,name:"worker",role:"engineer",adapterType:"hermes_local",status:"idle",adapterConfig:{boundedExecution:true},runtimeConfig:{heartbeat:{enabled:false,wakeOnDemand:true,maxConcurrentRuns:1}}},{id:qa,companyId,name:"qa",role:"engineer",adapterType:"codex_local",status:"idle",adapterConfig:{qaReviewToolsOnly:true},runtimeConfig:{heartbeat:{enabled:false,wakeOnDemand:true,maxConcurrentRuns:1}}}]);
    await db.insert(issues).values({id:issueId,companyId,issueNumber:1,identifier:companyId.replace(/-/g,"").toUpperCase()+"-1",title:"fixture",description:"bounded public handoff",status:"backlog"});
    try{
      await prepareCommanderAdmission(db,companyId,issueId,"responsible-user",{commanderAgentId:commander,admissionId,workerAgentId:worker,admissionSha256:commanderAdmissionDigest(admission),revision:0,statusVersion:0});
      const parent=await heartbeat.invoke(commander,"timer",{},"system");expect(parent).not.toBeNull();await waitForRunToFinish(heartbeat,parent!.id);await drainHeartbeatRunsToQuiescence(db,heartbeat);
      expect(workerCalls).toBe(1);expect(qaCalls).toBe(1);const [i]=await db.select().from(issues).where(eq(issues.id,issueId));expect(i).toMatchObject({status:"in_review",assigneeAgentId:null,assigneeUserId:"responsible-user"});expect(i.executionState).toMatchObject({status:"pending",currentStageType:"approval",lastDecisionOutcome:"approved"});
      const wakes=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId,companyId));expect(wakes.filter(w=>w.reason==="issue_disposition_repair")).toEqual([]);expect(wakes.filter(w=>w.idempotencyKey?.startsWith("commander-result-review:"))).toHaveLength(1);
      const again=await heartbeat.invoke(commander,"timer",{},"system");expect(again).not.toBeNull();expect((await waitForRunToFinish(heartbeat,again!.id))?.resultJson?.commanderCycle).toMatchObject({outcome:"idle"});await drainHeartbeatRunsToQuiescence(db,heartbeat);expect(workerCalls).toBe(1);expect(qaCalls).toBe(1);
    }finally{unregisterServerAdapter("hermes_local");}
  },30_000);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "heartbeat-direct-adapter-isolation-",
    );
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    for (const [adapterType] of DIRECT_ADAPTERS) {
      registerServerAdapter({
        type: adapterType,
        supportsLocalAgentJwt: false,
        execute,
        testEnvironment: async () => ({
          adapterType,
          status: "pass",
          checks: [],
          testedAt: new Date(0).toISOString(),
        }),
      });
    }
  }, 20_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runStatuses = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns);
    const pendingRuns = runStatuses.filter(
      (run) => run.status === "queued" || run.status === "running",
    );
    expect(pendingRuns).toEqual([]);
    vi.clearAllMocks();
    for (const [type] of DIRECT_ADAPTERS) registerServerAdapter({type,supportsLocalAgentJwt:false,execute,
      testEnvironment:async()=>({adapterType:type,status:"pass",checks:[],testedAt:new Date(0).toISOString()})});
    await db.execute(
      sql.raw(`
      TRUNCATE TABLE
        "native_run_finalizations",
        "status_decisions",
        "work_assessments",
        "native_run_results",
        "completion_contracts",
        "environment_leases",
        "environments",
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "company_skills",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `),
    );
  });

  afterAll(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (const [adapterType] of DIRECT_ADAPTERS) {
      unregisterServerAdapter(adapterType);
    }
    await tempDb?.cleanup();
  });

  it.each(DIRECT_ADAPTERS)(
    "executes flag-off %s once without creating native records",
    async (adapterType, provider) => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const directProofJson =
        '{"schema":"direct-proof.v1","value":"byte-stable"}';
      execute.mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider,
        model: `test-${provider}`,
        summary: "Direct adapter summary.",
        resultJson: { directProofJson },
      });

      await db.insert(companies).values({
        id: companyId,
        name: "Direct compatibility",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: `Direct ${provider}`,
        role: "engineer",
        status: "idle",
        adapterType,
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      expect(queued).not.toBeNull();
      const finished = await waitForRunToFinish(heartbeat, queued!.id);

      expect(execute).toHaveBeenCalledOnce();
      expect(finished).toMatchObject({
        status: "succeeded",
        exitCode: 0,
        signal: null,
        runtimeMode: "legacy",
        nativePhase: null,
      });
      const persistedResult = finished?.resultJson as Record<
        string,
        unknown
      > | null;
      expect(persistedResult?.directProofJson).toBe(directProofJson);

      const nativeRows = await Promise.all([
        db.select().from(completionContracts),
        db.select().from(nativeRunResults),
        db.select().from(workAssessments),
        db.select().from(statusDecisions),
        db.select().from(nativeRunFinalizations),
      ]);
      expect(nativeRows.every((rows) => rows.length === 0)).toBe(true);
    },
  );

  it("retains an unsolicited provider cancellation through finalization", async () => {
    const companyId = randomUUID(), agentId = randomUUID();
    execute.mockImplementation(async (context) => {
      expect(context.signal?.aborted).toBe(false);
      return { exitCode: 1, signal: null, timedOut: false, errorMessage: "ACP turn cancelled",
        resultJson: { status: "cancelled", acpToolInventoryComplete: true, acpPendingToolCount: 0 } };
    });
    await db.insert(companies).values({ id: companyId, name: "Provider stop",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Claude", role: "engineer", status: "idle",
      adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished).toMatchObject({ status: "cancelled", runtimeMode: "legacy", resultJson: {
      cancellation: { source: "provider", expected: false, initiator: { type: "provider" },
        reason: expect.stringContaining("Provider cancelled execution") },
      acpToolInventoryComplete: true, acpPendingToolCount: 0,
    } });
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each(["enabled", "missing_listener", "spoofed_wake"])("self-task document dispatcher: %s", async mode => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const names = ["PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_LISTEN_HOST", "PAPERCLIP_LISTEN_PORT", "PAPERCLIP_API_URL"];
    const prior = new Map(names.map(name => [name, process.env[name]]));
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    process.env.PAPERCLIP_LISTEN_HOST = mode === "missing_listener" ? "public-paperclip.invalid" : "127.0.0.1";
    process.env.PAPERCLIP_LISTEN_PORT = "3317";
    process.env.PAPERCLIP_API_URL = "https://public-paperclip.invalid";
    let calls = 0;
    registerServerAdapter({
      type: "claude_local", supportsLocalAgentJwt: true,
      execute: async ctx => {
        calls++;
        const enabled = mode !== "spoofed_wake";
        expect(ctx.context[SELF_TASK_DOCUMENT_CONTEXT_KEY]).toBe(enabled);
        const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ctx.runId));
        expect(persisted.contextSnapshot?.[SELF_TASK_DOCUMENT_CONTEXT_KEY]).toBe(enabled);
        const servers = ctx.runtimeMcp?.getServers() ?? [];
        if (enabled) {
          expect(ctx.runtimeTools).toBeUndefined();
          expect(ctx.context.paperclipRuntimeTools).toBeUndefined();
          expect(ctx.context.paperclipManagedMcp).toBeUndefined();
          if (mode === "missing_listener") expect(servers).toEqual([]);
          else {
            expect(servers).toEqual([expect.objectContaining({ name: "Paperclip projects",
              connectionId: "paperclip-project-tools", url: "http://127.0.0.1:3317/api/mcp/project-tools" })]);
            expect(servers[0]?.token).toBeTruthy();
          }
        } else {
          expect(servers).toContainEqual(expect.objectContaining({ name: "Paperclip projects",
            url: "https://public-paperclip.invalid/api/mcp/project-tools" }));
        }
        return { exitCode: 0, signal: null, timedOut: false, summary: "Dispatcher fixture complete" };
      },
      testEnvironment: async () => ({ adapterType: "claude_local", status: "pass", checks: [], testedAt: new Date(0).toISOString() }),
    });
    try {
      await db.insert(companies).values({ id: companyId, name: "Document profile", issuePrefix: "SD", defaultResponsibleUserId: "responsible-user" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Writer", adapterType: "claude_local",
        role: "engineer", status: "idle", adapterConfig: mode === "spoofed_wake" ? {} : {
          selfTaskDocumentToolsOnly: true, engine: "cli", dangerouslySkipPermissions: false,
        }, runtimeConfig: {}, permissions: {} });
      await db.insert(issues).values({ id: issueId, companyId, issueNumber: 1, identifier: "SD-1",
        title: "Save assigned result", status: "todo", assigneeAgentId: agentId });
      const queued = await heartbeat.invoke(agentId, "on_demand", { issueId,
        [SELF_TASK_DOCUMENT_CONTEXT_KEY]: mode === "spoofed_wake",
        paperclipRuntimeTools: { injected: true }, paperclipManagedMcp: { injected: true },
      }, "manual");
      expect(queued).not.toBeNull();
      expect((await waitForRunToFinish(heartbeat, queued!.id))?.status).toBe("succeeded");
      expect(calls).toBe(1);
      if (mode === "enabled") {
        const next = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual",
          requestedByActorType: "user", requestedByActorId: "responsible-user",
          reason: "owner_new_episode", contextSnapshot: { issueId } });
        expect(next).not.toBeNull();
        expect((await waitForRunToFinish(heartbeat, next!.id))?.status).toBe("succeeded");
        expect(calls).toBe(2);
      }
    } finally {
      for (const [name, value] of prior) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });

  it("delivers only the local run-bound QA MCP to a QA Claude invocation", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    let captured: { config: Record<string, unknown>; runtimeTools: unknown; managedMcp: unknown;
      servers: Array<{ name: string; connectionId?: string; url: string; token?: string }> } | null = null;
    const prior = {
      secret: process.env.PAPERCLIP_AGENT_JWT_SECRET,
      host: process.env.PAPERCLIP_LISTEN_HOST,
      port: process.env.PAPERCLIP_LISTEN_PORT,
      publicUrl: process.env.PAPERCLIP_API_URL,
    };
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    process.env.PAPERCLIP_LISTEN_HOST = "127.0.0.1";
    process.env.PAPERCLIP_LISTEN_PORT = "3317";
    process.env.PAPERCLIP_API_URL = "https://public-paperclip.invalid";
    registerServerAdapter({
      type: "claude_local", supportsLocalAgentJwt: true,
      execute: async (ctx) => {
        captured = { config: ctx.config, runtimeTools: ctx.runtimeTools,
          managedMcp: ctx.context.paperclipManagedMcp, servers: ctx.runtimeMcp?.getServers() ?? [] };
        return { exitCode: 0, signal: null, timedOut: false };
      },
      testEnvironment: async () => ({ adapterType: "claude_local", status: "pass", checks: [], testedAt: new Date(0).toISOString() }),
    });
    try {
      await db.insert(companies).values({ id: companyId, name: "Formal QA", issuePrefix: "QA", defaultResponsibleUserId: "responsible-user" });
      await db.insert(agents).values({ id: agentId, companyId, name: "QA reviewer", adapterType: "claude_local",
        role: "engineer", status: "idle", adapterConfig: { qaReviewToolsOnly: true }, runtimeConfig: {}, permissions: {} });
      await db.insert(issues).values({ id: issueId, companyId, issueNumber: 1, identifier: "QA-1",
        title: "Review assigned result", status: "in_review", assigneeAgentId: agentId });
      const queued = await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual");
      expect(queued).not.toBeNull();
      expect((await waitForRunToFinish(heartbeat, queued!.id))?.status).toBe("succeeded");
      expect(captured?.config.qaReviewToolsOnly).toBe(true);
      expect(captured?.runtimeTools).toBeUndefined();
      expect(captured?.managedMcp).toBeUndefined();
      expect(captured?.servers).toHaveLength(1);
      expect(captured?.servers[0]).toMatchObject({ name: "paperclip_qa",
        connectionId: "paperclip-qa-review", url: "http://127.0.0.1:3317/api/mcp/qa-review" });
      expect(captured?.servers[0]?.token).toBeTruthy();
    } finally {
      const restore = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      };
      restore("PAPERCLIP_AGENT_JWT_SECRET", prior.secret);
      restore("PAPERCLIP_LISTEN_HOST", prior.host);
      restore("PAPERCLIP_LISTEN_PORT", prior.port);
      restore("PAPERCLIP_API_URL", prior.publicUrl);
    }
  });
});
