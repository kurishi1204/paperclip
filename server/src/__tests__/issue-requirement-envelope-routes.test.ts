import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, environmentLeases, goals, heartbeatRuns, issueComments, issueWatchdogs, issues, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRequirementEnvelopeRoutes } from "../routes/issue-requirement-envelope.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const body = {
  task_kind: "internal_docs_only",
  requirements_text: "Write an internal operations note.",
  accepted_requirements: ["Internal only", "Cite the source"],
  native_document_complete: true,
};
const assignmentContext = (issueId: string) => ({
  issueId, source: "issue.create", taskId: issueId, taskKey: issueId,
  wakeReason: "issue_assigned", wakeSource: "assignment", wakeTriggerDetail: "system",
});

describeDb("atomic issue requirement envelope", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let otherCompanyId: string;
  let agentId: string;
  let otherAgentId: string;
  let runId: string;
  let otherRunId: string;
  let wakeId: string;
  let otherWakeId: string;
  let issueId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-requirement-envelope-");
    db = createDb(tempDb.connectionString);
  }, 30_000);
  afterAll(async () => { await tempDb?.cleanup(); });
  afterEach(async () => {
    await db.delete(environmentLeases);
    await db.delete(issueComments);
    await db.delete(issueWatchdogs);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);
  });

  const actor = (overrides: Record<string, unknown> = {}) => ({
    type: "agent" as const, source: "agent_jwt" as const,
    companyId, agentId, runId, ...overrides,
  });
  function app(currentActor: Express.Request["actor"]) {
    const server = express();
    server.use((req, _res, next) => { req.actor = currentActor; next(); });
    server.use("/api", issueRequirementEnvelopeRoutes(db));
    server.use(errorHandler);
    return server;
  }
  const get = (currentActor: Express.Request["actor"], id = issueId) =>
    request(app(currentActor)).get(`/api/issues/${id}/requirement-envelope`);

  beforeEach(async () => {
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    agentId = randomUUID();
    otherAgentId = randomUUID();
    runId = randomUUID();
    otherRunId = randomUUID();
    wakeId = randomUUID();
    otherWakeId = randomUUID();
    issueId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Projection", issuePrefix: "PRJ" },
      { id: otherCompanyId, name: "Other", issuePrefix: "OTH" },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Owner", role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: otherAgentId, companyId, name: "Other agent", role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    const otherIssueId = randomUUID();
    await db.insert(agentWakeupRequests).values([
      { id: wakeId, companyId, agentId, source: "assignment", triggerDetail: "system", reason: "issue_assigned", status: "claimed", runId,
        payload: { issueId, mutation: "create", _paperclipWakeContext: assignmentContext(issueId) } },
      { id: otherWakeId, companyId, agentId, source: "assignment", triggerDetail: "system", reason: "issue_assigned", status: "claimed", runId: otherRunId,
        payload: { issueId: otherIssueId, mutation: "create", _paperclipWakeContext: assignmentContext(otherIssueId) } },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: runId, companyId, agentId, wakeupRequestId: wakeId, invocationSource: "assignment", triggerDetail: "system", status: "running", startedAt: new Date(), contextSnapshot: assignmentContext(issueId) },
      { id: otherRunId, companyId, agentId, wakeupRequestId: otherWakeId, invocationSource: "assignment", triggerDetail: "system", status: "running", startedAt: new Date(), contextSnapshot: assignmentContext(otherIssueId) },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Request", description: JSON.stringify(body), status: "todo", assigneeAgentId: agentId,
      executionRunId: runId, executionAgentNameKey: "owner", executionLockedAt: new Date() });
  });

  it("freezes before checkout and rereads the same seven fields afterward", async () => {
    const before = await get(actor());
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(Object.keys(before.body).sort()).toEqual([
      "id", "companyId", "revision", "task_kind", "requirements_text", "accepted_requirements", "native_document_complete",
    ].sort());
    expect(before.body).toMatchObject({ id: issueId, companyId, ...body });
    expect(before.body.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(before.headers["cache-control"]).toContain("no-store");
    expect(before.headers.etag).toBeUndefined();
    await db.update(issues).set({ status: "in_progress", checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, issueId));
    const after = await get(actor());
    expect(after.status).toBe(200);
    expect(after.body).toEqual(before.body);
    const conditional = await get(actor()).set("If-None-Match", `"${before.body.revision}"`);
    expect(conditional.status).toBe(200);
    expect(conditional.body).toEqual(before.body);
  });

  it("accepts only the active Run's local environment lease", async () => {
    const [lease] = await db.insert(environmentLeases).values({
      companyId, issueId, heartbeatRunId: runId, provider: "local",
      status: "active", leasePolicy: "ephemeral",
    }).returning();
    expect((await get(actor())).status).toBe(200);
    await db.update(environmentLeases).set({ heartbeatRunId: otherRunId })
      .where(eq(environmentLeases.id, lease!.id));
    expect((await get(actor())).status).toBe(409);
  });

  it("keeps revision stable on operational updates but changes on title and description edits", async () => {
    const first = await get(actor());
    expect(first.status).toBe(200);
    await db.update(issues).set({ priority: "high" }).where(eq(issues.id, issueId));
    expect((await get(actor())).body.revision).toBe(first.body.revision);
    await db.update(issues).set({ title: "Retitled" }).where(eq(issues.id, issueId));
    const retitled = await get(actor());
    expect(retitled.body.revision).not.toBe(first.body.revision);
    await db.update(issues).set({ description: JSON.stringify({ ...body, requirements_text: "A revised note" }) }).where(eq(issues.id, issueId));
    const revised = await get(actor());
    expect(revised.body.revision).not.toBe(retitled.body.revision);
  });

  it("holds malformed, missing, unknown and unsupported native child material", async () => {
    for (const description of [
      "not json", JSON.stringify({ ...body, accepted_requirements: [] }),
      JSON.stringify({ ...body, requirements_text: " \t " }),
      JSON.stringify({ ...body, accepted_requirements: ["  "] }),
      JSON.stringify({ ...body, extra: "unknown" }),
      JSON.stringify({ ...body, native_document_complete: false }),
      '{"task_kind":"internal_docs_only","task_kind":"other","requirements_text":"x","accepted_requirements":["x"],"native_document_complete":true}',
    ]) {
      await db.update(issues).set({ description }).where(eq(issues.id, issueId));
      expect((await get(actor())).status).toBe(409);
    }
    await db.update(issues).set({ description: JSON.stringify(body) }).where(eq(issues.id, issueId));
    await db.insert(issueComments).values({ companyId, issueId, body: "Additional requirement", authorType: "user" });
    const held = await get(actor());
    expect(held.status).toBe(409);
    expect(held.body.details?.code).toBe("requirement_projection_hold");
  });

  it("holds an unversioned child issue and a watchdog, including an inactive watchdog", async () => {
    await db.insert(issues).values({ companyId, title: "Child", status: "todo", parentId: issueId });
    expect((await get(actor())).status).toBe(409);
    await db.delete(issues).where(eq(issues.parentId, issueId));
    await db.insert(issueWatchdogs).values({ companyId, issueId, watchdogAgentId: agentId, status: "disabled" });
    expect((await get(actor())).status).toBe(409);
  });

  it("holds linked project and goal instructions that the canary cannot version", async () => {
    const [goal] = await db.insert(goals).values({ companyId, title: "Company goal" }).returning();
    const [project] = await db.insert(projects).values({ companyId, name: "Project", goalId: goal!.id }).returning();
    await db.update(issues).set({ projectId: project!.id }).where(eq(issues.id, issueId));
    expect((await get(actor())).status).toBe(409);
    await db.update(issues).set({ projectId: null, goalId: goal!.id }).where(eq(issues.id, issueId));
    expect((await get(actor())).status).toBe(409);
  });

  it("holds unsupported instruction-bearing Issue settings", async () => {
    await db.update(issues).set({ titleNeedsGeneration: true }).where(eq(issues.id, issueId));
    expect((await get(actor())).status).toBe(409);
    await db.update(issues).set({ titleNeedsGeneration: false, monitorNextCheckAt: new Date() }).where(eq(issues.id, issueId));
    expect((await get(actor())).status).toBe(409);
    await db.update(issues).set({ monitorNextCheckAt: null, requestDepth: 1 }).where(eq(issues.id, issueId));
    expect((await get(actor())).status).toBe(409);
  });

  it("rejects another company, Run, agent, credential class and missing actor", async () => {
    expect((await get(actor({ companyId: otherCompanyId }))).status).toBe(404);
    expect((await get(actor({ runId: otherRunId }))).status).toBe(403);
    expect((await get(actor({ agentId: otherAgentId }))).status).toBe(403);
    expect((await get(actor({ source: "agent_key" }))).status).toBe(403);
    expect((await get({ type: "none", source: "none" })).status).toBe(401);
    expect((await get(actor({ runId: null }))).status).toBe(401);
    await db.update(issues).set({ status: "in_progress", checkoutRunId: otherRunId }).where(eq(issues.id, issueId));
    expect((await get(actor())).status).toBe(403);
  });

  it("holds if two live Runs claim the same Issue before checkout", async () => {
    await db.update(heartbeatRuns).set({ contextSnapshot: assignmentContext(issueId) }).where(eq(heartbeatRuns.id, otherRunId));
    expect((await get(actor())).status).toBe(409);
    expect((await get(actor({ runId: otherRunId }))).status).toBe(409);
  });

  it("uses the claimed wake for task identity and ignores unrelated runtime context", async () => {
    const canonical = await get(actor());
    expect(canonical.status).toBe(200);
    await db.update(heartbeatRuns).set({ contextSnapshot: { ...assignmentContext(issueId), instruction: "Use another source" } })
      .where(eq(heartbeatRuns.id, runId));
    const extended = await get(actor());
    expect(extended.status).toBe(200);
    expect(extended.body).toEqual(canonical.body);
    await db.update(heartbeatRuns).set({ contextSnapshot: { ...assignmentContext(issueId), source: ["issue.create"] } })
      .where(eq(heartbeatRuns.id, runId));
    expect((await get(actor())).status).toBe(409);
    for (const changes of [
      { taskId: randomUUID() }, { taskKey: randomUUID() }, { wakeReason: "issue_commented" },
      { wakeSource: "on_demand" }, { wakeTriggerDetail: "manual" },
    ]) {
      await db.update(heartbeatRuns).set({ contextSnapshot: { ...assignmentContext(issueId), ...changes } })
        .where(eq(heartbeatRuns.id, runId));
      expect((await get(actor())).status).toBe(409);
    }
    await db.update(heartbeatRuns).set({ contextSnapshot: assignmentContext(issueId), invocationSource: "on_demand" })
      .where(eq(heartbeatRuns.id, runId));
    expect((await get(actor())).status).toBe(409);
    await db.update(heartbeatRuns).set({ invocationSource: "assignment", triggerDetail: "manual" })
      .where(eq(heartbeatRuns.id, runId));
    expect((await get(actor())).status).toBe(409);
    await db.update(heartbeatRuns).set({
      invocationSource: "automation", triggerDetail: "system",
      contextSnapshot: { ...assignmentContext(issueId), source: "issue.status_change",
        wakeReason: "issue_status_changed", wakeSource: "automation" },
    }).where(eq(heartbeatRuns.id, runId));
    await db.update(agentWakeupRequests).set({
      source: "automation", reason: "issue_status_changed",
      payload: { issueId, mutation: "update", _paperclipWakeContext: { ...assignmentContext(issueId),
        source: "issue.status_change", wakeReason: "issue_status_changed", wakeSource: "automation" } },
    }).where(eq(agentWakeupRequests.id, wakeId));
    expect((await get(actor())).status).toBe(200);
  });

  it("holds after an unreviewed database migration", async () => {
    const hash = randomUUID();
    await db.execute(sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES (${hash}, ${1791676800001})`);
    try {
      expect((await get(actor())).status).toBe(409);
    } finally {
      await db.execute(sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`);
    }
  });

  it("never returns a stale envelope across a concurrent Issue edit", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { entered = resolve; });
    const changedText = "Concurrent requirement edit";
    const writer = db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
      entered();
      await gate;
      await tx.update(issues).set({ description: JSON.stringify({ ...body, requirements_text: changedText }) })
        .where(eq(issues.id, issueId));
    });
    await locked;
    const reading = get(actor()).then((response) => response);
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await writer;
    const observed = await reading;
    expect([200, 409]).toContain(observed.status);
    if (observed.status === 200) expect(observed.body.requirements_text).toBe(changedText);
  });
});
