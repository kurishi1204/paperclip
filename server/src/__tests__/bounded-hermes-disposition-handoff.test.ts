import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, companies, createDb, heartbeatRuns,
  issueComments, issueRecoveryActions, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => ({ track: vi.fn() }) }));

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Embedded PostgreSQL unavailable: ${support.reason}`);
(support.supported ? describe : describe.skip)("bounded Hermes disposition handoff", () => {
  let db!: ReturnType<typeof createDb>;
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("bounded-hermes-disposition-");
    db = createDb(testDb.connectionString);
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await testDb?.cleanup(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  async function fixture(bounded: "config" | "operator" | "none", status: "in_progress" | "done" = "in_progress") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const coordinatorId = randomUUID();
    const issuePrefix = `H${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`;
    vi.stubEnv("PAPERCLIP_HERMES_BOUNDED_AGENT_ID", bounded === "operator" ? agentId : "");
    await db.insert(companies).values({ id: companyId, name: "Research fixture", issuePrefix, defaultResponsibleUserId: "fixture-user" });
    await db.insert(agents).values([
      { id: coordinatorId, companyId, name: "Coordinator", role: "ceo", status: "idle", adapterType: "claude_local", adapterConfig: {} },
      { id: agentId, companyId, name: "Researcher", role: "general", status: "idle", reportsTo: coordinatorId,
        adapterType: "hermes_local", adapterConfig: { ...(bounded === "config" ? { boundedExecution: true } : {}),
          model: "fixture-model", provider: "fixture-provider", toolsets: "search", persistSession: false },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Public research result needs disposition",
      status, assigneeAgentId: agentId, issueNumber: 1, identifier: `${issuePrefix}-1` });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded",
      invocationSource: "assignment", startedAt: new Date(Date.now() - 1000), finishedAt: new Date(),
      contextSnapshot: { issueId }, resultJson: { web_search_count: 1, source_urls: ["https://example.org/reference"], result: "Source-backed public finding." } });
    const before = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
    const enqueueWakeup = vi.fn<Parameters<typeof recoveryService>[1]["enqueueWakeup"]>(async (ownerId, input = {}) => {
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId: ownerId,
        source: "automation", triggerDetail: "system", reason: "issue_disposition_repair", status: "queued",
        payload: input.payload, idempotencyKey: input.idempotencyKey }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: ownerId, status: "queued",
        invocationSource: "automation", contextSnapshot: input.contextSnapshot, wakeupRequestId: wake.id }).returning();
      await db.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
      return run;
    });
    return { companyId, agentId, coordinatorId, issueId, runId, before, enqueueWakeup,
      recovery: recoveryService(db, { enqueueWakeup }) };
  }

  it.each(["config", "operator"] as const)("keeps a visible coordinator-owned handoff without dispatching the %s-bound web worker", async mode => {
    const f = await fixture(mode);
    expect(await f.recovery.reconcileLegacyContinuation(f.runId)).toBe("escalated");
    expect(f.enqueueWakeup).not.toHaveBeenCalled();
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: "active", ownerType: "board", ownerAgentId: null,
      previousOwnerAgentId: f.agentId, returnOwnerAgentId: f.agentId, attemptCount: 0,
      evidence: { terminalReason: "owner_disposition_capability_unavailable" },
      wakePolicy: { type: "board_escalation", preservesSourceAssignee: true } });
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue).toMatchObject({ status: "blocked", assigneeAgentId: f.agentId });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("web-only");
    expect(comments[0].body).not.toContain("exhausted");
    expect(actions[0].nextAction).toContain("coordinator");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(f.before);
    expect(await f.recovery.reconcileLegacyContinuation(f.runId)).toBe("skipped");
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actions[0].id)))[0].status).toBe("active");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
  });

  it("retains normal disposition repair for a Hermes worker with company tools", async () => {
    const f = await fixture("none");
    expect(await f.recovery.reconcileLegacyContinuation(f.runId)).toBe("queued");
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(actions[0]).toMatchObject({ ownerType: "agent", ownerAgentId: f.agentId, attemptCount: 1 });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(1);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({ status: "in_progress", assigneeAgentId: f.agentId });
  });

  it("does not reopen completed bounded research or create a handoff for it", async () => {
    const f = await fixture("config", "done");
    expect(await f.recovery.reconcileLegacyContinuation(f.runId)).toBe("skipped");
    expect(f.enqueueWakeup).not.toHaveBeenCalled();
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toHaveLength(0);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(0);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(f.before);
  });
});
