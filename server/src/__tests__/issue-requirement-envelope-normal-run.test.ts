import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueRequirementEnvelopeRoutes } from "../routes/issue-requirement-envelope.js";
import { heartbeatService, startTaskDrain, stopTaskDrain } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("requirement envelope on a normal Issue assignment Run", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "issue-requirement-envelope-normal-run-test-secret");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-requirement-normal-run-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => {
    stopTaskDrain();
    if (db) await heartbeatService(db).drainActiveRunExecutions();
    await tempDb?.cleanup();
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
});
