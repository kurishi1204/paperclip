import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisions,
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
import { heartbeatService } from "../services/heartbeat.js";

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
