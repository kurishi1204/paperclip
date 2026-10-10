import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueRequirementEnvelopeRoutes } from "../routes/issue-requirement-envelope.js";
import { heartbeatService, startTaskDrain, stopTaskDrain } from "../services/heartbeat.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("requirement envelope on a normal Issue assignment Run", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "issue-requirement-envelope-normal-run-test-secret");
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-requirement-ai-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "requirement-ai-fixture");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-requirement-normal-run-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => {
    stopTaskDrain();
    if (db) await heartbeatService(db).drainActiveRunExecutions();
    await tempDb?.cleanup();
    if (home) await rm(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("projects the actual creation wake after heartbeat starts the bound Run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Canary", issuePrefix: "CNY", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Canary worker", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", "setTimeout(() => process.exit(0), 5000)"] },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } }, permissions: {},
    });
    const createApp = express();
    createApp.use(express.json());
    createApp.use((req, _res, next) => {
      req.actor = { type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    createApp.use("/api", issueRoutes(db, {} as never));
    createApp.use(errorHandler);

    startTaskDrain({});
    const created = await request(createApp).post(`/api/companies/${companyId}/issues`).send({
      title: "Write an internal note", status: "todo", assigneeAgentId: agentId,
      description: JSON.stringify({
        task_kind: "internal_docs_only", requirements_text: "Write the internal note.",
        accepted_requirements: ["Internal distribution"], native_document_complete: true,
      }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const issueId = created.body.id as string;
    let run: typeof heartbeatRuns.$inferSelect | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      if (run) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(run?.status).toBe("queued");
    expect(run?.contextSnapshot).toMatchObject({ issueId, source: "issue.create" });

    const heartbeat = heartbeatService(db);
    stopTaskDrain();
    await heartbeat.resumeQueuedRuns();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      if (run?.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(run?.status, JSON.stringify(run?.contextSnapshot)).toBe("running");

    const getApp = express();
    getApp.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    getApp.use("/api", issueRequirementEnvelopeRoutes(db));
    getApp.use(errorHandler);
    const token = createLocalAgentJwt(agentId, companyId, "process", run!.id);
    expect(token).toBeTruthy();
    const projection = await request(getApp).get(`/api/issues/${issueId}/requirement-envelope`)
      .set("Authorization", `Bearer ${token}`);
    expect(projection.status, JSON.stringify({ body: projection.body, context: run?.contextSnapshot })).toBe(200);
    expect(projection.body).toMatchObject({ id: issueId, companyId, native_document_complete: true });
    startTaskDrain({});
    await heartbeat.drainActiveRunExecutions();
  }, 45_000);

  it("projects the actual managed Anthropic Run before and after agent checkout", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const userId = `canary-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Managed canary", issuePrefix: "MNY", requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: userId, name: "Canary owner", email: `${userId}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    await aiConnectionService(db).save(companyId, userId, {
      provider: "anthropic", method: "api_key", ownership: "personal", name: "Fixture Anthropic",
      apiKey: "fixture", allAgents: true, agentIds: [],
    }, "fixture-anthropic-key");
    await db.insert(agents).values({
      id: agentId, companyId, name: "Managed canary worker", role: "engineer", status: "idle",
      adapterType: "claude_local", adapterConfig: { cwd: home, engine: "cli", model: "claude-opus-5-5" },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true },
        aiConnection: { provider: "anthropic", method: "api_key", mode: "responsible_user" } },
      permissions: {},
    });
    let finishExecution!: (value: { exitCode: number; signal: null; timedOut: false; resultJson: Record<string, unknown> }) => void;
    const execution = new Promise<{ exitCode: number; signal: null; timedOut: false; resultJson: Record<string, unknown> }>((resolve) => {
      finishExecution = resolve;
    });
    const execute = vi.fn(async () => execution);
    registerServerAdapter({ ...getServerAdapter("claude_local"), execute });
    let checkoutEntered!: () => void;
    let allowCheckout!: () => void;
    const entered = new Promise<void>((resolve) => { checkoutEntered = resolve; });
    const checkoutGate = new Promise<void>((resolve) => { allowCheckout = resolve; });
    const heartbeat = heartbeatService(db, {
      beforeIssueAutoCheckout: async () => { checkoutEntered(); await checkoutGate; },
    });
    try {
      stopTaskDrain();
      const [issue] = await db.insert(issues).values({
        companyId, title: "Write an internal note", status: "todo", assigneeAgentId: agentId,
        createdByUserId: userId, responsibleUserId: userId,
        description: JSON.stringify({ task_kind: "internal_docs_only", requirements_text: "Write the internal note.",
          accepted_requirements: ["Internal distribution"], native_document_complete: true }),
      }).returning();
      const issueId = issue!.id;
      const wake = await queueIssueAssignmentWakeup({
        heartbeat, issue: issue!, reason: "issue_assigned", mutation: "create", contextSource: "issue.create",
        requestedByActorType: "user", requestedByActorId: userId, rethrowOnError: true,
      });
      expect(wake).toBeTruthy();
      let run: typeof heartbeatRuns.$inferSelect | undefined;
      await expect.poll(async () => {
        [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
        return run?.id;
      }, { timeout: 10_000 }).toBeTruthy();
      await heartbeat.resumeQueuedRuns();
      let checkoutTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          entered,
          new Promise<never>((_, reject) => {
            checkoutTimeout = setTimeout(() => reject(new Error("Issue auto checkout was not reached")), 10_000);
          }),
        ]);
      } finally {
        if (checkoutTimeout) clearTimeout(checkoutTimeout);
      }
      [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      expect(run?.status).toBe("running");
      const token = createLocalAgentJwt(agentId, companyId, "claude_local", run!.id);
      const agentApp = express();
      agentApp.use(express.json());
      agentApp.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
      agentApp.use("/api", issueRequirementEnvelopeRoutes(db));
      agentApp.use("/api", issueRoutes(db, {} as never));
      agentApp.use(errorHandler);
      const read = () => request(agentApp).get(`/api/issues/${issueId}/requirement-envelope`)
        .set("Authorization", `Bearer ${token}`);
      const before = await read();
      expect(before.status, JSON.stringify({ body: before.body, context: run?.contextSnapshot })).toBe(200);
      expect((await request(agentApp).get(`/api/issues/${issueId}/requirement-envelope`)
        .set("Authorization", `Bearer ${createLocalAgentJwt(agentId, companyId, "claude_local", randomUUID())}`)).status).toBe(403);
      allowCheckout();
      await expect.poll(async () => {
        [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
        return run?.contextSnapshot?.aiConnection;
      }, { timeout: 20_000 }).toMatchObject({ provider: "anthropic", method: "api_key", responsibleUserId: userId });
      await expect.poll(() => execute.mock.calls.length, { timeout: 20_000 }).toBe(1);
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({
        status: "in_progress", checkoutRunId: run!.id, executionRunId: run!.id,
      });
      const after = await read();
      expect(after.status, JSON.stringify({ body: after.body, context: run?.contextSnapshot })).toBe(200);
      expect(after.body).toEqual(before.body);
      const [acceptedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(acceptedIssue?.continuationIdentityContextId).toBeTruthy();
      await db.update(issues).set({ continuationIdentityContextId: randomUUID() }).where(eq(issues.id, issueId));
      expect((await read()).status).toBe(409);
      await db.update(issues).set({ continuationIdentityContextId: acceptedIssue!.continuationIdentityContextId })
        .where(eq(issues.id, issueId));
      await expect.poll(async () => (await read()).status, { timeout: 10_000 }).toBe(200);
      const context = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)))[0]!.contextSnapshot!;
      await db.update(heartbeatRuns).set({ contextSnapshot: { ...context, source: "issue.comment" } })
        .where(eq(heartbeatRuns.id, run!.id));
      expect((await read()).status).toBe(409);
      await db.update(heartbeatRuns).set({ contextSnapshot: context }).where(eq(heartbeatRuns.id, run!.id));
      expect((await read()).status).toBe(200);
      await db.update(heartbeatRuns).set({ contextSnapshot: { ...context, instruction: "Use another source" } })
        .where(eq(heartbeatRuns.id, run!.id));
      expect((await read()).status).toBe(409);
      await db.update(heartbeatRuns).set({ contextSnapshot: context }).where(eq(heartbeatRuns.id, run!.id));
      expect((await read()).status).toBe(200);
      await db.update(heartbeatRuns).set({ contextSnapshot: { ...context, forceFreshSession: true } })
        .where(eq(heartbeatRuns.id, run!.id));
      expect((await read()).status).toBe(409);
      await db.update(heartbeatRuns).set({ contextSnapshot: {
        ...context, aiConnection: { ...(context.aiConnection as Record<string, unknown>), responsibleUserId: randomUUID() },
      } }).where(eq(heartbeatRuns.id, run!.id));
      expect((await read()).status).toBe(409);
      await db.update(heartbeatRuns).set({ contextSnapshot: context }).where(eq(heartbeatRuns.id, run!.id));
      expect((await read()).status).toBe(200);
      const [claimedWake] = await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, run!.wakeupRequestId!));
      expect(claimedWake!.payload?._paperclipIssueRequirementContextHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      await db.update(agentWakeupRequests).set({ payload: {
        ...claimedWake!.payload, _paperclipIssueRequirementContextHash: `sha256:${"0".repeat(64)}`,
      } }).where(eq(agentWakeupRequests.id, claimedWake!.id));
      expect((await read()).status).toBe(409);
      await db.update(agentWakeupRequests).set({ payload: claimedWake!.payload })
        .where(eq(agentWakeupRequests.id, claimedWake!.id));
      expect((await read()).status).toBe(200);
      await db.update(agentWakeupRequests).set({ payload: { ...claimedWake!.payload, mutation: "comment" } })
        .where(eq(agentWakeupRequests.id, claimedWake!.id));
      expect((await read()).status).toBe(409);
      await db.update(agentWakeupRequests).set({ payload: claimedWake!.payload })
        .where(eq(agentWakeupRequests.id, claimedWake!.id));
      expect((await read()).status).toBe(200);
    } finally {
      allowCheckout();
      finishExecution({ exitCode: 0, signal: null, timedOut: false, resultJson: {} });
      stopTaskDrain();
      await heartbeat.drainActiveRunExecutions();
      unregisterServerAdapter("claude_local");
    }
  }, 60_000);
});
