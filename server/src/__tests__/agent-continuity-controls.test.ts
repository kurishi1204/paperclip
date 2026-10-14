import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agentConfigRevisions, agents, companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentContinuityControls } from "../services/agent-continuity-controls.js";
import { evaluateAgentInvokabilityFromDb } from "../services/agent-invokability.js";
import { agentService } from "../services/agents.js";
import { persistActivity } from "../services/activity-log.js";

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
    expect(before).toMatchObject({ companyId: f.companyId, status: "paused", blockAssignment: true, wakeOnDemand: false, eligible: true });
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
    const [revision] = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, f.agentId));
    expect(revision).toMatchObject({ createdByUserId: "board-user", source: "patch", changedKeys: ["runtimeConfig"] });
    expect((revision!.afterConfig.runtimeConfig as { heartbeat: { wakeOnDemand: boolean } }).heartbeat.wakeOnDemand).toBe(true);
    const mappedEvent = await persistActivity(db, { companyId: f.companyId, actorType: "user",
      actorId: "board-user", action: "agent.continuity_controls_updated", entityType: "agent", entityId: f.agentId });
    expect(mappedEvent.publication.pluginEvent?.eventType).toBe("agent.updated");
    await expect(agentService(db).update(f.agentId, { runtimeConfig: f.runtimeConfig }))
      .rejects.toMatchObject({ status: 409 });
    await expect(agentService(db).updatePermissions(f.agentId, {
      ...f.permissions, canCreateAgents: false,
    })).rejects.toMatchObject({ status: 409 });
    await expect(agentService(db).update(f.agentId, { runtimeConfig: {
      ...(stored!.runtimeConfig as Record<string, unknown>), unrelated: "edited",
    } })).resolves.not.toBeNull();
    await expect(agentService(db).updatePermissions(f.agentId, {
      ...(stored!.permissions as Record<string, unknown>), unrelated: "edited",
    })).resolves.not.toBeNull();
    await expect(agentService(db).update(f.agentId, {
      adapterConfig: { token: "SYNTHETIC_ADAPTER_SECRET", harmless: true },
    })).resolves.not.toBeNull();
    const [afterGeneralEdits] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(afterGeneralEdits!.runtimeConfig).toMatchObject({ heartbeat: {
      wakeOnDemand: true,
    }, unrelated: "edited" });
    expect(afterGeneralEdits!.permissions).toMatchObject({ authorizationPolicy: {
      protectedAgent: { blockAssignment: false },
    }, unrelated: "edited" });
    await expect(svc.patch(f.agentId, {
      expectedUpdatedAt: before!.updatedAt, blockAssignment: true, wakeOnDemand: false,
    }, "board-user", f.companyId)).rejects.toMatchObject({ status: 409 });
  });

  it("restores unrelated settings without rolling back live scoped controls", async () => {
    const f = await seed();
    const safeRuntime = { heartbeat: f.runtimeConfig.heartbeat, unrelated: "keep" };
    await db.update(agents).set({ adapterConfig: {}, runtimeConfig: safeRuntime })
      .where(eq(agents.id, f.agentId));
    const historic = { ...safeRuntime, unrelated: "historic" };
    const service = agentService(db);
    await service.update(f.agentId, { runtimeConfig: historic },
      { recordRevision: { source: "test" } });
    const [revision] = await service.listConfigRevisions(f.agentId);
    await service.update(f.agentId, { runtimeConfig: { ...historic, unrelated: "current" } });
    const controls = agentContinuityControls(db);
    const before = await controls.get(f.agentId);
    await controls.patch(f.agentId, {
      expectedUpdatedAt: before!.updatedAt, blockAssignment: false, wakeOnDemand: true,
    }, "board-user", f.companyId);
    await expect(service.rollbackConfigRevision(f.agentId, revision.id, {})).resolves.not.toBeNull();
    const [stored] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(stored!.runtimeConfig).toMatchObject({
      heartbeat: { enabled: false, wakeOnDemand: true }, unrelated: "historic",
    });
    expect(stored!.permissions).toMatchObject({
      authorizationPolicy: { protectedAgent: { blockAssignment: false } },
    });
  });

  it("records the live scoped wake in a rollback racing with a scoped patch", async () => {
    const f = await seed();
    const safeRuntime = { heartbeat: f.runtimeConfig.heartbeat, unrelated: "keep" };
    await db.update(agents).set({ adapterConfig: {}, runtimeConfig: safeRuntime })
      .where(eq(agents.id, f.agentId));
    const service = agentService(db);
    const historic = { ...safeRuntime, unrelated: "historic" };
    await service.update(f.agentId, { runtimeConfig: historic },
      { recordRevision: { source: "test" } });
    const [sourceRevision] = await service.listConfigRevisions(f.agentId);
    await service.update(f.agentId, { runtimeConfig: { ...historic, unrelated: "current" } });

    let enterTransaction!: () => void;
    let releaseTransaction!: () => void;
    const entered = new Promise<void>((resolve) => { enterTransaction = resolve; });
    const release = new Promise<void>((resolve) => { releaseTransaction = resolve; });
    const wrappedDb = new Proxy(db, {
      get(target, key, receiver) {
        if (key === "transaction") {
          return async (callback: Parameters<typeof db.transaction>[0]) => target.transaction(async (tx) => {
            enterTransaction();
            await release;
            return callback(tx);
          });
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const pending = agentService(wrappedDb).rollbackConfigRevision(
      f.agentId, sourceRevision.id, { userId: "board-user" });
    try {
      await entered; // Rollback read the historic snapshot before the scoped write.
      const before = await agentContinuityControls(db).get(f.agentId);
      await agentContinuityControls(db).patch(f.agentId, {
        expectedUpdatedAt: before!.updatedAt, blockAssignment: false, wakeOnDemand: true,
      }, "board-user", f.companyId);
    } finally {
      releaseTransaction();
    }
    await expect(pending).resolves.not.toBeNull();
    const revisions = await db.select().from(agentConfigRevisions)
      .where(eq(agentConfigRevisions.agentId, f.agentId));
    const rollback = revisions.find((item) => item.source === "rollback");
    expect(rollback?.changedKeys).toContain("runtimeConfig");
    for (const snapshot of [rollback!.beforeConfig, rollback!.afterConfig]) {
      expect((snapshot.runtimeConfig as { heartbeat: { wakeOnDemand: boolean } })
        .heartbeat.wakeOnDemand).toBe(true);
    }
    const [stored] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(stored!.runtimeConfig).toMatchObject({ heartbeat: { wakeOnDemand: true }, unrelated: "historic" });
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

  it("reports legacy approval agents as ineligible before the operator edits", async () => {
    const f = await seed();
    const permissions = structuredClone(f.permissions);
    (permissions.authorizationPolicy.protectedAgent as typeof permissions.authorizationPolicy.protectedAgent & {
      requiresApproval: boolean;
    }).requiresApproval = true;
    await db.update(agents).set({ permissions }).where(eq(agents.id, f.agentId));
    const svc = agentContinuityControls(db);
    const before = await svc.get(f.agentId);
    expect(before).toMatchObject({ eligible: false });
    await expect(svc.patch(f.agentId, {
      expectedUpdatedAt: before!.updatedAt, blockAssignment: false, wakeOnDemand: true,
    }, "board-user", f.companyId)).rejects.toMatchObject({ status: 409 });
  });

  it("allows an ineligible paused agent to tighten both flags through the general update", async () => {
    const f = await seed();
    const permissions = structuredClone(f.permissions);
    permissions.authorizationPolicy.protectedAgent.blockAssignment = false;
    const runtimeConfig = structuredClone(f.runtimeConfig);
    runtimeConfig.heartbeat.enabled = true;
    runtimeConfig.heartbeat.wakeOnDemand = true;
    await db.update(agents).set({ permissions, runtimeConfig }).where(eq(agents.id, f.agentId));
    const before = await agentContinuityControls(db).get(f.agentId);
    await expect(agentContinuityControls(db).patch(f.agentId, {
      expectedUpdatedAt: before!.updatedAt, blockAssignment: true, wakeOnDemand: false,
    }, "board-user", f.companyId)).rejects.toMatchObject({ status: 409 });
    const tightenedPermissions = structuredClone(permissions);
    tightenedPermissions.authorizationPolicy.protectedAgent.blockAssignment = true;
    const tightenedRuntime = structuredClone(runtimeConfig);
    tightenedRuntime.heartbeat.wakeOnDemand = false;
    await expect(agentService(db).update(f.agentId, {
      permissions: tightenedPermissions, runtimeConfig: tightenedRuntime,
    })).resolves.not.toBeNull();
    const [stored] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(stored!.permissions).toMatchObject({ authorizationPolicy: {
      protectedAgent: { blockAssignment: true },
    } });
    expect(stored!.runtimeConfig).toMatchObject({ heartbeat: {
      enabled: true, wakeOnDemand: false,
    } });
  });

  it("keeps general edits available when a paused agent is ineligible for scoped controls", async () => {
    const f = await seed();
    const runtimeConfig = structuredClone(f.runtimeConfig);
    runtimeConfig.heartbeat.enabled = true;
    await db.update(agents).set({ runtimeConfig }).where(eq(agents.id, f.agentId));
    expect(await agentContinuityControls(db).get(f.agentId)).toMatchObject({ eligible: false });

    const permissions = structuredClone(f.permissions);
    permissions.authorizationPolicy.protectedAgent.blockAssignment = false;
    runtimeConfig.heartbeat.wakeOnDemand = true;
    await expect(agentService(db).update(f.agentId, { permissions, runtimeConfig }))
      .resolves.not.toBeNull();
    const [stored] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(stored!.permissions).toMatchObject({ authorizationPolicy: {
      protectedAgent: { blockAssignment: false },
    } });
    expect(stored!.runtimeConfig).toMatchObject({ heartbeat: {
      enabled: true, wakeOnDemand: true,
    } });
  });

  it("attributes a general config revision only to changes made after the scoped patch", async () => {
    const f = await seed();
    let enterTransaction!: () => void;
    let releaseTransaction!: () => void;
    const entered = new Promise<void>((resolve) => { enterTransaction = resolve; });
    const release = new Promise<void>((resolve) => { releaseTransaction = resolve; });
    const wrappedDb = new Proxy(db, {
      get(target, key, receiver) {
        if (key === "transaction") {
          return async (callback: Parameters<typeof db.transaction>[0]) => target.transaction(async (tx) => {
            enterTransaction();
            await release;
            return callback(tx);
          });
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const pending = agentService(wrappedDb).update(f.agentId, { name: "Renamed" },
      { recordRevision: { source: "test" } });
    try {
      await entered; // The general edit has already read the pre-patch row.
      const before = await agentContinuityControls(db).get(f.agentId);
      await agentContinuityControls(db).patch(f.agentId, {
        expectedUpdatedAt: before!.updatedAt, blockAssignment: false, wakeOnDemand: true,
      }, "board-user", f.companyId);
    } finally {
      releaseTransaction();
    }
    await expect(pending).resolves.not.toBeNull();
    const revisions = await db.select().from(agentConfigRevisions)
      .where(eq(agentConfigRevisions.agentId, f.agentId));
    const revision = revisions.find((item) => item.source === "test");
    expect(revision?.changedKeys).toContain("name");
    expect(revision?.changedKeys).not.toContain("runtimeConfig");
    expect((revision!.beforeConfig.runtimeConfig as { heartbeat: { wakeOnDemand: boolean } })
      .heartbeat.wakeOnDemand).toBe(true);
    expect((revision!.afterConfig.runtimeConfig as { heartbeat: { wakeOnDemand: boolean } })
      .heartbeat.wakeOnDemand).toBe(true);
  });

  it("rechecks a stale general update after a concurrent scoped patch commits", async () => {
    const f = await seed();
    const stalePermissions = structuredClone(f.permissions);
    stalePermissions.authorizationPolicy.protectedAgent.blockAssignment = false;
    const staleRuntime = structuredClone(f.runtimeConfig);
    staleRuntime.heartbeat.wakeOnDemand = true;
    await db.update(agents).set({ permissions: stalePermissions, runtimeConfig: staleRuntime })
      .where(eq(agents.id, f.agentId));

    let enterTransaction!: () => void;
    let releaseTransaction!: () => void;
    const entered = new Promise<void>((resolve) => { enterTransaction = resolve; });
    const release = new Promise<void>((resolve) => { releaseTransaction = resolve; });
    const wrappedDb = new Proxy(db, {
      get(target, key, receiver) {
        if (key === "transaction") {
          return async (callback: Parameters<typeof db.transaction>[0]) => target.transaction(async (tx) => {
            enterTransaction();
            await release;
            return callback(tx);
          });
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const pending = agentService(wrappedDb).update(f.agentId, {
      permissions: stalePermissions, runtimeConfig: staleRuntime,
    });
    try {
      await entered; // The general path has already read its stale snapshot.
      const before = await agentContinuityControls(db).get(f.agentId);
      await agentContinuityControls(db).patch(f.agentId, {
        expectedUpdatedAt: before!.updatedAt, blockAssignment: true, wakeOnDemand: false,
      }, "board-user", f.companyId);
    } finally {
      releaseTransaction();
    }
    await expect(pending).rejects.toMatchObject({ status: 409 });
    const [stored] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(stored!.permissions).toMatchObject({ authorizationPolicy: {
      protectedAgent: { blockAssignment: true },
    } });
    expect(stored!.runtimeConfig).toMatchObject({ heartbeat: { wakeOnDemand: false } });
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
