import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const AGENT_ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_RUN_ID = "44444444-4444-4444-8444-444444444444";
const PAUSED_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const IDLE_AGENT_ID = "33333333-3333-4333-8333-333333333333";

const agentStatusById: Record<string, string> = {
  [AGENT_ACTOR_ID]: "idle",
  [PAUSED_AGENT_ID]: "paused",
  [IDLE_AGENT_ID]: "idle",
};

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdForUpdate: vi.fn(),
  findOpenAncestorCreatedByAgent: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  createChild: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
  getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
  getCurrentScheduledRetry: vi.fn(async () => null),
  getDependencyReadiness: vi.fn(async () => ({
    blockerIssueIds: [],
    isDependencyReady: false,
    unresolvedBlockerCount: 0,
  })),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockObserveCrossIssueInfluence = vi.hoisted(() => vi.fn(async () => null));

vi.mock("../services/cross-issue-influence-limit.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/cross-issue-influence-limit.js")>(),
  observeCrossIssueInfluence: mockObserveCrossIssueInfluence,
}));

vi.mock("../services/index.js", () => ({
  taskWatchdogService: () => ({ reconcileForIssueAndAncestors: vi.fn(async () => []) }),
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1" })),
  }),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: vi.fn(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    })),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async (id: string) => ({
      id,
      companyId: "company-1",
      status: agentStatusById[id] ?? "idle",
    })),
    resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: {
        id: raw,
        companyId: "company-1",
        status: agentStatusById[raw] ?? "idle",
        orgChainHealth: { status: "healthy" },
      },
    })),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => ({
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByHistoricalComments: vi.fn(async () => []),
  }),
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

import { errorHandler } from "../middleware/index.js";
import { HttpError } from "../errors.js";
import { issueRoutes } from "../routes/issues.js";

type Actor = Record<string, unknown>;

function boardActor(): Actor {
  return {
    type: "board",
    userId: "local-board",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

function agentActor(): Actor {
  return {
    type: "agent",
    agentId: AGENT_ACTOR_ID,
    companyId: "company-1",
    source: "agent_key",
    runId: AGENT_RUN_ID,
  };
}

// Minimal chainable/thenable db stub: any query resolves to an empty row set.
// Run containment is mocked because this suite targets assignee invokability.
function stubDb(): any {
  const query: any = {};
  for (const method of ["select", "from", "where", "innerJoin", "leftJoin", "orderBy", "limit", "groupBy", "for"]) {
    query[method] = () => query;
  }
  query.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([]));
  const db: any = { select: () => query };
  db.transaction = async (body: any) => body(db);
  return db;
}

function createApp(actor: Actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(stubDb() as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    status: "todo",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: AGENT_ACTOR_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-999",
    title: "Invokability test",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

describe("issue assignee invokability guard", () => {
  beforeEach(() => {
    mockIssueService.getById.mockReset();
    mockIssueService.findOpenAncestorCreatedByAgent.mockReset();
    mockIssueService.findOpenAncestorCreatedByAgent.mockResolvedValue(null);
    mockIssueService.update.mockReset();
    mockIssueService.create.mockReset();
    mockIssueService.createChild.mockReset();
    mockIssueService.addComment.mockReset();
    mockHeartbeatService.wakeup.mockClear();
    mockObserveCrossIssueInfluence.mockClear();
    mockObserveCrossIssueInfluence.mockResolvedValue(null);
  });

  it("refuses an agent assigning an issue to a paused agent", async () => {
    const existing = makeIssue();
    mockIssueService.getById.mockResolvedValue(existing);

    const res = await request(createApp(agentActor()))
      .patch(`/api/issues/${existing.id}`)
      .send({ assigneeAgentId: PAUSED_AGENT_ID });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("paused agent");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("refuses an agent creating a child issue assigned to a paused agent", async () => {
    const parent = makeIssue();
    mockIssueService.getById.mockResolvedValue(parent);

    const res = await request(createApp(agentActor()))
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Escalation for the manager",
        description: "Needs a decision",
        assigneeAgentId: PAUSED_AGENT_ID,
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("paused agent");
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("still allows an agent to assign to an invokable agent", async () => {
    const existing = makeIssue();
    const updated = makeIssue({ assigneeAgentId: IDLE_AGENT_ID });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);

    const res = await request(createApp(agentActor()))
      .patch(`/api/issues/${existing.id}`)
      .send({ assigneeAgentId: IDLE_AGENT_ID });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("allows a board user to assign to a paused agent deliberately", async () => {
    const existing = makeIssue({ assigneeAgentId: null });
    const updated = makeIssue({ assigneeAgentId: PAUSED_AGENT_ID });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);

    const res = await request(createApp(boardActor()))
      .patch(`/api/issues/${existing.id}`)
      .send({ assigneeAgentId: PAUSED_AGENT_ID });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });
});

describe("agent delegation cycle guard", () => {
  beforeEach(() => {
    mockIssueService.getById.mockReset();
    mockIssueService.findOpenAncestorCreatedByAgent.mockReset();
    mockIssueService.findOpenAncestorCreatedByAgent.mockResolvedValue(null);
    mockIssueService.create.mockReset();
    mockIssueService.createChild.mockReset();
  });

  it("refuses an agent child assigned to the creator of an open ancestor", async () => {
    const parent = makeIssue();
    mockIssueService.getById.mockResolvedValue(parent);
    mockIssueService.findOpenAncestorCreatedByAgent.mockResolvedValue({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      identifier: "PAP-100",
      parentId: null,
      createdByAgentId: IDLE_AGENT_ID,
      status: "in_progress",
    });

    const res = await request(createApp(agentActor()))
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Hand it back",
        description: "Bounce",
        assigneeAgentId: IDLE_AGENT_ID,
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Delegation cycle");
    expect(res.body.details).toMatchObject({ code: "delegation_cycle" });
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
    expect(mockIssueService.findOpenAncestorCreatedByAgent).toHaveBeenCalledWith(parent.id, IDLE_AGENT_ID);
  });

  it("allows the same child when no open ancestor was created by the assignee", async () => {
    const parent = makeIssue();
    mockIssueService.getById.mockResolvedValue(parent);
    mockIssueService.createChild.mockResolvedValue({
      issue: makeIssue({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", parentId: parent.id, assigneeAgentId: IDLE_AGENT_ID }),
      parentBlockerAdded: false,
    });

    const res = await request(createApp(agentActor()))
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Legit subtask",
        description: "Fine",
        assigneeAgentId: IDLE_AGENT_ID,
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.createChild).toHaveBeenCalled();
  });

  it("does not consult the guard for board actors", async () => {
    const parent = makeIssue({ assigneeAgentId: null });
    mockIssueService.getById.mockResolvedValue(parent);
    mockIssueService.createChild.mockResolvedValue({
      issue: makeIssue({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", parentId: parent.id, assigneeAgentId: IDLE_AGENT_ID }),
      parentBlockerAdded: false,
    });

    const res = await request(createApp(boardActor()))
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Human-created child",
        description: "Deliberate",
        assigneeAgentId: IDLE_AGENT_ID,
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.findOpenAncestorCreatedByAgent).not.toHaveBeenCalled();
  });
});

const mockWorkAssignmentCheck = vi.hoisted(() => vi.fn());
vi.mock("../services/agent-assignability.js", async (load) => {
 const actual = await load<typeof import("../services/agent-assignability.js")>();
 return { ...actual, assertAssignableAgent: async (_db, _company, agentId, options) => {
  mockWorkAssignmentCheck(options);
  const result = actual.assignmentWorkCompatibility({issue:options.work,agent:{id:agentId,adapterType:"hermes_local",adapterConfig:{boundedExecution:true}}});
  if (result.kind === "blocked") {
   const {conflict} = await import("../errors.js");
   throw conflict(result.block.reason,{code:result.block.errorCode,...result.block.details});
  }
 }};
});

describe("normal work sender before ownership side effects, no HTTP server", () => {
 it("returns explicit document mismatch through the real PATCH handler before any stop, update or wake", async () => {
  const existing=makeIssue({description:"Original requested saved document.",assigneeAgentId:AGENT_ACTOR_ID});
  mockIssueService.getById.mockResolvedValue(existing);
  mockIssueService.update.mockClear();mockHeartbeatService.cancelRun.mockClear();mockHeartbeatService.wakeup.mockClear();
  const router=issueRoutes(stubDb() as any,{} as any);
  const layer=(router as any).stack.find((l:any)=>l.route?.path==="/issues/:id"&&l.route.methods.patch);
  const {updateIssueSchema}=await import("@paperclipai/shared");
  const body=updateIssueSchema.parse({assigneeAgentId:IDLE_AGENT_ID,status:"todo",workRequirements:{requiredOperations:["issue_document_write"],deliverable:"saved_issue_document"}});
  const req:any={params:{id:existing.id},body,actor:boardActor(),headers:{},method:"PATCH",path:`/issues/${existing.id}`,get:()=>undefined};
  const res:any={status:vi.fn().mockReturnThis(),json:vi.fn().mockReturnThis(),on:vi.fn(),once:vi.fn(),locals:{}};
  await expect(layer.route.stack.at(-1).handle(req,res,()=>{})).rejects.toMatchObject({status:409,details:{code:"agent_work_requirements_unavailable"}});
  expect(mockWorkAssignmentCheck).toHaveBeenCalled();
  expect(mockIssueService.update).not.toHaveBeenCalled();expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
 });
 it("saves a valid normal sender contract using the locked brief and preserves concurrent unrelated metadata", async () => {
  const existing=makeIssue({description:"Current brief.",revision:36,assigneeAdapterOverrides:{adapterConfig:{before:"keep"}}});
  const locked={...existing,revision:39,assigneeAdapterOverrides:{useProjectWorkspace:true,adapterConfig:{before:"keep",concurrent:"keep too"}}};
  mockIssueService.getById.mockResolvedValue(existing);mockIssueService.getByIdForUpdate.mockResolvedValue(locked);
  mockIssueService.update.mockImplementation(async (_id,data)=>({...locked,...data}));
  const router=issueRoutes(stubDb() as any,{} as any);
  const layer=(router as any).stack.find((l:any)=>l.route?.path==="/issues/:id"&&l.route.methods.patch);
  const {updateIssueSchema}=await import("@paperclipai/shared");
  const body=updateIssueSchema.parse({workRequirements:{requiredOperations:["web_search","final_response"],deliverable:"research_response"}});
  const req:any={params:{id:existing.id},body,actor:boardActor(),headers:{},method:"PATCH",path:`/issues/${existing.id}`,get:()=>undefined};
  const res:any={status:vi.fn().mockReturnThis(),json:vi.fn().mockReturnThis(),on:vi.fn(),once:vi.fn(),locals:{}};
  await layer.route.stack.at(-1).handle(req,res,()=>{});
  expect(mockIssueService.getByIdForUpdate).toHaveBeenCalled();
  const data=mockIssueService.update.mock.calls.at(-1)![1];
  expect(data).not.toHaveProperty("workRequirements");
  expect(data.assigneeAdapterOverrides).toMatchObject({useProjectWorkspace:true,adapterConfig:{before:"keep",concurrent:"keep too",paperclipWorkRequirements:{companyId:existing.companyId,issueId:existing.id,requiredOperations:["web_search","final_response"]}}});
  expect(res.json).toHaveBeenCalled();
 });
 it("rejects a source-brief change under the existing row lock before saving or waking", async () => {
  const existing=makeIssue({description:"Current brief.",revision:36});
  mockIssueService.getById.mockResolvedValue(existing);mockIssueService.getByIdForUpdate.mockResolvedValue({...existing,description:"Changed requirement.",revision:37});
  mockIssueService.update.mockClear();mockHeartbeatService.wakeup.mockClear();
  const router=issueRoutes(stubDb() as any,{} as any);
  const layer=(router as any).stack.find((l:any)=>l.route?.path==="/issues/:id"&&l.route.methods.patch);
  const {updateIssueSchema}=await import("@paperclipai/shared");
  const body=updateIssueSchema.parse({workRequirements:{requiredOperations:["web_search"],deliverable:"research_response"}});
  const req:any={params:{id:existing.id},body,actor:boardActor(),headers:{},method:"PATCH",path:`/issues/${existing.id}`,get:()=>undefined};
  const res:any={status:vi.fn().mockReturnThis(),json:vi.fn().mockReturnThis(),on:vi.fn(),once:vi.fn(),locals:{}};
  await expect(layer.route.stack.at(-1).handle(req,res,()=>{})).rejects.toMatchObject({status:409,details:{code:"assignment_work_contract_invalid"}});
  expect(mockIssueService.update).not.toHaveBeenCalled();expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
 });

 it("keeps an unclassified ordinary reassignment on the original path without an extra guard or transaction", async () => {
  const existing=makeIssue({description:"Unclassified existing request."});
  mockIssueService.getById.mockResolvedValue(existing);mockIssueService.update.mockImplementation(async (_id,data)=>({...existing,...data}));
  mockWorkAssignmentCheck.mockClear();mockIssueService.getByIdForUpdate.mockClear();
  const db=stubDb();const transaction=vi.spyOn(db,"transaction");
  const router=issueRoutes(db,{} as any);
  const layer=(router as any).stack.find((l:any)=>l.route?.path==="/issues/:id"&&l.route.methods.patch);
  const req:any={params:{id:existing.id},body:{assigneeAgentId:IDLE_AGENT_ID},actor:boardActor(),headers:{},method:"PATCH",path:`/issues/${existing.id}`,get:()=>undefined};
  const res:any={status:vi.fn().mockReturnThis(),json:vi.fn().mockReturnThis(),on:vi.fn(),once:vi.fn(),locals:{}};
  await layer.route.stack.at(-1).handle(req,res,()=>{});
  expect(mockWorkAssignmentCheck).not.toHaveBeenCalled();expect(transaction).not.toHaveBeenCalled();
  expect(mockIssueService.getByIdForUpdate).not.toHaveBeenCalled();expect(mockIssueService.update).toHaveBeenCalled();expect(res.json).toHaveBeenCalled();
 });

});

describe("stop boundary qualification with a modeled active run, no HTTP", () => {
 async function invoke(requiredOperations: string[]) {
  const runId="55555555-5555-4555-8555-555555555555";
  const existing=makeIssue({description:"Current brief.",revision:36,executionRunId:runId,checkoutRunId:runId});
  const run={id:runId,companyId:existing.companyId,agentId:AGENT_ACTOR_ID,status:"running",nativeIssueId:existing.id,contextSnapshot:{issueId:existing.id}};
  mockIssueService.getById.mockResolvedValue(existing);
  mockIssueService.getByIdForUpdate.mockResolvedValue({...existing,description:"Concurrent changed brief.",revision:37});
  mockHeartbeatService.getRun.mockClear();mockHeartbeatService.getRun.mockResolvedValue(run as any);
  mockHeartbeatService.getActiveRunForAgent.mockClear();mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(run as any);
  mockHeartbeatService.cancelRun.mockClear();mockHeartbeatService.cancelRun.mockResolvedValue({...run,status:"cancelled"} as any);
  mockIssueService.update.mockClear();mockHeartbeatService.wakeup.mockClear();mockIssueService.getByIdForUpdate.mockClear();
  const router=issueRoutes(stubDb() as any,{} as any);
  const layer=(router as any).stack.find((l:any)=>l.route?.path==="/issues/:id"&&l.route.methods.patch);
  const {updateIssueSchema}=await import("@paperclipai/shared");
  const body=updateIssueSchema.parse({assigneeAgentId:IDLE_AGENT_ID,workRequirements:{requiredOperations,deliverable:"explicit_deliverable"}});
  const req:any={params:{id:existing.id},body,actor:boardActor(),headers:{},method:"PATCH",path:`/issues/${existing.id}`,get:()=>undefined};
  const res:any={status:vi.fn().mockReturnThis(),json:vi.fn().mockReturnThis(),on:vi.fn(),once:vi.fn(),locals:{}};
  return layer.route.stack.at(-1).handle(req,res,()=>{});
 }
 it("rejects preflight mismatch before even resolving or cancelling the modeled active run", async () => {
  await expect(invoke(["issue_document_write"])).rejects.toMatchObject({details:{code:"agent_work_requirements_unavailable"}});
  expect(mockHeartbeatService.getRun).not.toHaveBeenCalled();expect(mockHeartbeatService.getActiveRunForAgent).not.toHaveBeenCalled();
  expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();expect(mockIssueService.getByIdForUpdate).not.toHaveBeenCalled();
  expect(mockIssueService.update).not.toHaveBeenCalled();expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
 });
 it("can cancel the modeled original run before a later locked brief-change rejection", async () => {
  await expect(invoke(["web_search","final_response"])).rejects.toMatchObject({details:{code:"assignment_work_contract_invalid"}});
  expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("55555555-5555-4555-8555-555555555555",expect.any(String),expect.objectContaining({errorCode:"issue_reassigned"}));
  expect(mockIssueService.getByIdForUpdate).toHaveBeenCalled();
  expect(mockHeartbeatService.cancelRun.mock.invocationCallOrder[0]).toBeLessThan(mockIssueService.getByIdForUpdate.mock.invocationCallOrder[0]);
  expect(mockIssueService.update).not.toHaveBeenCalled();expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
 });
});

describe("reserved work contract raw updates through original PATCH, no HTTP", () => {
 async function executeRaw(existingOverrides: unknown, nextOverrides: unknown, lockedOverrides = existingOverrides) {
  const existing = makeIssue({ description: "Fixed brief.", assigneeAdapterOverrides: existingOverrides });
  const locked = { ...existing, assigneeAdapterOverrides: lockedOverrides };
  mockIssueService.getById.mockResolvedValue(existing);
  mockIssueService.getByIdForUpdate.mockResolvedValue(locked);
  mockIssueService.update.mockClear();
  mockIssueService.update.mockImplementation(async (_id, data) => ({ ...locked, ...data }));
  mockHeartbeatService.cancelRun.mockClear();mockHeartbeatService.wakeup.mockClear();
  const router = issueRoutes(stubDb() as any, {} as any);
  const layer = (router as any).stack.find((l: any) => l.route?.path === "/issues/:id" && l.route.methods.patch);
  const { updateIssueSchema } = await import("@paperclipai/shared");
  const req: any = { params: { id: existing.id }, body: updateIssueSchema.parse({ assigneeAdapterOverrides: nextOverrides }), actor: boardActor(), headers: {}, method: "PATCH", path: `/issues/${existing.id}`, get: () => undefined };
  const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), on: vi.fn(), once: vi.fn(), locals: {} };
  return layer.route.stack.at(-1).handle(req, res, () => {});
 }
 const contract = { schema: "paperclip.work-requirements.v1", companyId: "company-1", issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceBriefSha256: "fixed", requiredOperations: ["issue_document_write"], deliverable: "saved document" };
 const protectedOverrides = { adapterConfig: { paperclipWorkRequirements: contract, unrelated: "kept" } };
 for (const next of [null, {}, { adapterConfig: {} }, { adapterConfig: { paperclipWorkRequirements: { ...contract, requiredOperations: ["web_search"] } } }]) {
  it(`rejects raw deletion or rewrite ${JSON.stringify(next)} before stop or save`, async () => {
   await expect(executeRaw(protectedOverrides, next)).rejects.toMatchObject({ status: 409, details: { code: "assignment_work_contract_invalid" } });
   expect(mockIssueService.update).not.toHaveBeenCalled();expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });
 }
 it("rejects raw contract creation rather than accepting client-supplied pins", async () => {
  await expect(executeRaw({}, protectedOverrides)).rejects.toMatchObject({ status: 409, details: { code: "assignment_work_contract_invalid" } });
  expect(mockIssueService.update).not.toHaveBeenCalled();
 });
 it("rechecks locked current contract before unrelated stale raw replacement", async () => {
  await expect(executeRaw({ adapterConfig: { unrelated: "old" } }, { adapterConfig: { unrelated: "new" } }, protectedOverrides)).rejects.toMatchObject({ status: 409, details: { code: "assignment_work_contract_invalid" } });
  expect(mockIssueService.getByIdForUpdate).toHaveBeenCalled();expect(mockIssueService.update).not.toHaveBeenCalled();
 });
 it("preserves the exact contract while allowing unrelated configuration to change", async () => {
  const next = { adapterConfig: { unrelated: "new", paperclipWorkRequirements: { ...contract } } };
  await executeRaw(protectedOverrides, next);
  expect(mockIssueService.update.mock.calls.at(-1)![1].assigneeAdapterOverrides).toEqual(next);
 });
 it("allows unrelated raw updates when neither current nor next has a contract", async () => {
  const next = { adapterConfig: { unrelated: "new" } };
  await executeRaw({ adapterConfig: { unrelated: "old" } }, next);
  expect(mockIssueService.update.mock.calls.at(-1)![1].assigneeAdapterOverrides).toEqual(next);
 });
});


describe("assignment failure response after modeled cancellation, no HTTP", () => {
  async function invoke(mode: "locked-rejection" | "update-unknown" | "preflight" | "locked-other-owner") {
    const runId = "55555555-5555-4555-8555-555555555555";
    const existing = makeIssue({ description: "Current brief.", revision: 36, statusVersion: 8, executionRunId: runId, checkoutRunId: runId });
    const locked = { ...existing, revision: 37,
      description: mode === "locked-rejection" ? "Concurrent brief." : existing.description,
      assigneeAgentId: mode === "locked-other-owner" ? PAUSED_AGENT_ID : existing.assigneeAgentId,
    };
    const run = { id: runId, companyId: existing.companyId, agentId: AGENT_ACTOR_ID, status: "running", nativeIssueId: existing.id, contextSnapshot: { issueId: existing.id } };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.getByIdForUpdate.mockResolvedValue(locked);
    mockHeartbeatService.getRun.mockResolvedValue(run as any);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(run as any);
    mockHeartbeatService.cancelRun.mockReset();
    mockHeartbeatService.cancelRun.mockImplementation(async (_id, _reason, options) => ({ ...run, status: "cancelled", resultJson: options?.resultJson }) as any);
    const originalError = new Error("private database failure, commit outcome unknown");
    mockIssueService.update.mockReset(); mockIssueService.update.mockRejectedValue(originalError);
    mockHeartbeatService.wakeup.mockClear(); mockIssueService.getByIdForUpdate.mockClear();
    const router = issueRoutes(stubDb() as any, {} as any);
    const layer = (router as any).stack.find((l: any) => l.route?.path === "/issues/:id" && l.route.methods.patch);
    const { updateIssueSchema } = await import("@paperclipai/shared");
    const body = updateIssueSchema.parse({ assigneeAgentId: IDLE_AGENT_ID, workRequirements: { requiredOperations: mode === "preflight" ? ["issue_document_write"] : ["web_search", "final_response"], deliverable: "research" } });
    const req: any = { params: { id: existing.id }, body, actor: boardActor(), headers: {}, method: "PATCH", path: `/issues/${existing.id}`, originalUrl: `/api/issues/${existing.id}`, get: () => undefined };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), on: vi.fn(), once: vi.fn(), locals: {} };
    let caught: unknown;
    try { await layer.route.stack.at(-1).handle(req, res, () => {}); } catch (err) { caught = err; errorHandler(err, req, res, () => {}); }
    return { caught, originalError, existing, locked, res, payload: res.json.mock.calls.at(-1)?.[0] };
  }
  it("reports confirmed cancellation and locked ownership without claiming assignment or replay", async () => {
    const result = await invoke("locked-rejection");
    expect(result.caught).toBeInstanceOf(HttpError);
    expect(result.res.status).toHaveBeenCalledWith(409);
    expect(result.payload).toMatchObject({ code: "assignment_work_contract_invalid", issueMutation: {
      issueId: result.existing.id, assignmentWrite: "not_attempted", currentOwnership: "unverified", automaticRetry: false,
      runCancellation: { runId: "55555555-5555-4555-8555-555555555555", observedStatus: "cancelled", evidence: "cancelRun_return" },
      lastObservedOwnership: { source: "locked_before_update", revision: 37, assigneeAgentId: AGENT_ACTOR_ID },
    } });
    expect(result.payload.issueMutation.issueMutationStopId).toBe(mockHeartbeatService.cancelRun.mock.calls[0][2]?.resultJson?.issueMutationStopId);
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledTimes(1);
    expect(mockIssueService.update).not.toHaveBeenCalled(); expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });
  it("keeps an update/commit exception unknown, preserves original error and masks private message", async () => {
    const result = await invoke("update-unknown");
    expect(result.caught).toBe(result.originalError);
    expect(result.res.status).toHaveBeenCalledWith(500);
    expect(result.payload).toMatchObject({ error: "Internal server error", issueMutation: { assignmentWrite: "outcome_unknown", currentOwnership: "unverified", automaticRetry: false } });
    expect(JSON.stringify(result.payload)).not.toContain("private database failure");
    expect(mockIssueService.update).toHaveBeenCalledTimes(1); expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });
  it("reports concurrent owner only as last locked observation", async () => {
    const result = await invoke("locked-other-owner");
    expect(result.payload.issueMutation).toMatchObject({ assignmentWrite: "not_attempted", currentOwnership: "unverified", lastObservedOwnership: { assigneeAgentId: PAUSED_AGENT_ID, revision: 37 } });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
  it("does not invent a cancellation receipt for a preflight rejection", async () => {
    const result = await invoke("preflight");
    expect(result.payload).toMatchObject({ code: "agent_work_requirements_unavailable" });
    expect(result.payload).not.toHaveProperty("issueMutation");
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });
});
