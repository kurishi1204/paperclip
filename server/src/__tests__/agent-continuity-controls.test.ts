import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentContinuityControls } from "../services/agent-continuity-controls.js";
import { evaluateAgentInvokabilityFromDb } from "../services/agent-invokability.js";
import { agentService } from "../services/agents.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping agent continuity Postgres tests: ${support.reason ?? "unsupported host"}`);

describeDb("agent continuity controls", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-continuity-");
    db = createDb(tempDb.connectionString);
  }, 20_000);
  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  async function seed(status = "paused") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Continuity test", issuePrefix: `C${companyId.slice(0, 6).toUpperCase()}` });
    const permissions = {
      canAssignTasks: false,
      authorizationPolicy: {
        assignmentPolicy: { mode: "protected", extra: "keep" },
        protectedAgent: { blockAssignment: true, extra: "keep" },
      },
      unrelated: "keep",
    };
    const runtimeConfig = {
      heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1, extra: "keep" },
      aiConnection: { credentialRef: "SYNTHETIC_SECRET_MUST_NOT_LEAK" },
      unrelated: "keep",
    };
    await db.insert(agents).values({ id: agentId, companyId, name: "Paused worker", role: "engineer", status,
      adapterType: "codex_local", permissions, runtimeConfig, adapterConfig: { token: "SYNTHETIC_ADAPTER_SECRET" } });
    return { companyId, agentId, permissions, runtimeConfig };
  }

  it("changes only the two flags and returns no config or secret fields", async () => {
    const f = await seed();
    const svc = agentContinuityControls(db);
    const before = await svc.get(f.agentId);
    expect(JSON.stringify(before)).not.toContain("SYNTHETIC_SECRET");
    expect(before).toMatchObject({ companyId: f.companyId, status: "paused", blockAssignment: true, wakeOnDemand: false });
    const after = await svc.patch(f.agentId, {
      expectedUpdatedAt: before!.updatedAt, blockAssignment: false, wakeOnDemand: true,
    }, "board-user", f.companyId);
    expect(after).toMatchObject({ blockAssignment: false, wakeOnDemand: true });
    expect(JSON.stringify(after)).not.toContain("Config");
    const [stored] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(stored!.permissions).toEqual({ ...f.permissions, authorizationPolicy: {
      ...f.permissions.authorizationPolicy,
      protectedAgent: { ...f.permissions.authorizationPolicy.protectedAgent, blockAssignment: false },
    } });
    expect(stored!.runtimeConfig).toEqual({ ...f.runtimeConfig, heartbeat: {
      ...f.runtimeConfig.heartbeat, wakeOnDemand: true,
    } });
    expect(stored!.adapterConfig).toEqual({ token: "SYNTHETIC_ADAPTER_SECRET" });
    expect(await evaluateAgentInvokabilityFromDb(db, stored!)).toMatchObject({ invokable: false, reason: "paused" });
    const [audit] = await db.select().from(activityLog).where(eq(activityLog.entityId, f.agentId));
    expect(audit).toMatchObject({ actorType: "user", actorId: "board-user",
      agentId: null, action: "agent.continuity_controls_updated" });
    await expect(agentService(db).update(f.agentId, { runtimeConfig: f.runtimeConfig }))
      .rejects.toMatchObject({ status: 409 });
    await expect(agentService(db).updatePermissions(f.agentId, {
      ...f.permissions, canCreateAgents: false,
    })).rejects.toMatchObject({ status: 409 });
    const [afterRejectedUpdates] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(afterRejectedUpdates!.runtimeConfig).toEqual(stored!.runtimeConfig);
    expect(afterRejectedUpdates!.permissions).toEqual(stored!.permissions);
    await expect(svc.patch(f.agentId, {
      expectedUpdatedAt: before!.updatedAt, blockAssignment: true, wakeOnDemand: false,
    }, "board-user", f.companyId)).rejects.toMatchObject({ status: 409 });
  });

  it("rejects active agents without changing their config", async () => {
    const f = await seed("active");
    const svc = agentContinuityControls(db);
    const before = await svc.get(f.agentId);
    await expect(svc.patch(f.agentId, {
      expectedUpdatedAt: before!.updatedAt, blockAssignment: false, wakeOnDemand: true,
    }, "board-user", f.companyId)).rejects.toMatchObject({ status: 409 });
    const [stored] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(stored!.permissions).toEqual(f.permissions);
    expect(stored!.runtimeConfig).toEqual(f.runtimeConfig);
  });

  it("rejects a company change between authorization and the locked write", async () => {
    const f = await seed();
    const svc = agentContinuityControls(db);
    const before = await svc.get(f.agentId);
    await expect(svc.patch(f.agentId, {
      expectedUpdatedAt: before!.updatedAt, blockAssignment: false, wakeOnDemand: true,
    }, "board-user", randomUUID())).rejects.toMatchObject({ status: 409 });
    const [stored] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(stored!.permissions).toEqual(f.permissions);
    expect(stored!.runtimeConfig).toEqual(f.runtimeConfig);
  });

  it("fails closed on malformed legacy approval flags without a SQL cast error", async () => {
    for (const path of ["protectedAgent", "assignmentPolicy"] as const) {
      const f = await seed();
      const permissions = structuredClone(f.permissions);
      const policy = permissions.authorizationPolicy as unknown as {
        protectedAgent: Record<string, unknown>; assignmentPolicy: Record<string, unknown>;
      };
      if (path === "protectedAgent") policy.protectedAgent.requiresApproval = "always";
      else policy.assignmentPolicy.protectedAgentRequiresApproval = { unexpected: true };
      await db.update(agents).set({ permissions }).where(eq(agents.id, f.agentId));
      const svc = agentContinuityControls(db);
      const before = await svc.get(f.agentId);
      expect(before).not.toBeNull();
      await expect(svc.patch(f.agentId, {
        expectedUpdatedAt: before!.updatedAt, blockAssignment: false, wakeOnDemand: true,
      }, "board-user", f.companyId)).rejects.toMatchObject({ status: 409 });
      const [stored] = await db.select().from(agents).where(eq(agents.id, f.agentId));
      expect(stored!.permissions).toEqual(permissions);
    }
  });
});
