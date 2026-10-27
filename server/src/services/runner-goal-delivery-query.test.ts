import { randomUUID } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { agents, agentSessionGoalActions, agentTaskSessions, heartbeatRuns, issues } from "@paperclipai/db";
import { claimRunnerGoalActionDelivery, releaseUnsentRunnerGoalActionDelivery, runnerGoalService } from "./runner-goals.js";

vi.mock("./live-events.js", () => ({ publishLiveEvent: vi.fn() }));

// This double executes the exported service's queries while retaining their
// Drizzle predicates for inspection. It models only the no-run, one-action case.
function makeGoalDb(withActiveRun = false) {
  const companyId = randomUUID();
  const issueId = randomUUID();
  const agentId = randomUUID();
  const sessionId = randomUUID();
  const runId = randomUUID();
  const issue = { id: issueId, companyId, assigneeAgentId: agentId };
  const agent = { id: agentId, companyId, adapterType: "paperclip_runner", adapterConfig: {} };
  const session = {
    id: sessionId, companyId, agentId, adapterType: "paperclip_runner", taskKey: issueId,
    goalRevision: 0, goalJson: null, goalCapabilityJson: null, goalObservedAt: null,
    updatedAt: new Date(),
  };
  let action: Record<string, any> | null = null;
  const updates: Array<{ status: string; sql: string; params: unknown[] }> = [];
  const dialect = new PgDialect();
  const rowFor = (table: unknown) => table === issues ? issue
    : table === agents ? agent
    : table === agentTaskSessions ? session
    : table === agentSessionGoalActions ? action
    : table === heartbeatRuns && withActiveRun ? { id: runId } : null;
  const db: any = {
    select: () => ({
      from(table: unknown) {
        const query: any = {
          where() { return query; }, orderBy() { return query; }, limit() { return query; },
          for() { return query; },
          then(resolve: (rows: unknown[]) => unknown, reject?: (error: unknown) => unknown) {
            const row = rowFor(table);
            return Promise.resolve(row ? [row] : []).then(resolve, reject);
          },
        };
        return query;
      },
    }),
    insert: (table: unknown) => ({
      values(values: Record<string, unknown>) {
        return {
          onConflictDoNothing: async () => [],
          returning: async () => {
            if (table !== agentSessionGoalActions) throw new Error("unexpected insert");
            action = { id: randomUUID(), ...values };
            return [action];
          },
        };
      },
    }),
    update: (table: unknown) => ({
      set(values: Record<string, unknown>) {
        let changed = false;
        const query: any = {
          where(predicate: Parameters<PgDialect["sqlToQuery"]>[0]) {
            if (table === agentSessionGoalActions) {
              const rendered = dialect.sqlToQuery(predicate);
              updates.push({ status: String(values.status), sql: rendered.sql, params: rendered.params });
              if (action?.status === "ready" && values.status === "delivering") {
                Object.assign(action, values);
                changed = true;
              } else if (action?.status === "delivering" && values.status === "ready") {
                Object.assign(action, values);
                changed = true;
              } else if (action?.status === "delivering" && values.status === "delivered") {
                Object.assign(action, values);
                changed = true;
              } else if (action?.status === "delivering" && values.status === "pending") {
                // Model the old producer's post-enqueue downgrade so this
                // regression would fail if that write were restored.
                Object.assign(action, values);
                changed = true;
              }
            } else if (table === agentTaskSessions) {
              Object.assign(session, values);
            }
            return query;
          },
          returning: async () => changed && action ? [{ id: action.id }] : [],
          then(resolve: (rows: unknown[]) => unknown, reject?: (error: unknown) => unknown) {
            return Promise.resolve([]).then(resolve, reject);
          },
        };
        return query;
      },
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return {
    db: db as Db,
    binding: { companyId, issueId, agentId, adapterType: "paperclip_runner", sessionId },
    runId,
    updates,
    action: () => action,
  };
}

describe("goal action delivery query contract", () => {
  it("claims the exact new row once and never infers legacy pending is unsent", async () => {
    const f = makeGoalDb();
    const request = {
      requestId: randomUUID(), agentId: f.binding.agentId, expectedRevision: 0,
      action: "create" as const, objective: "One delivery",
    };
    const owner = { kind: "heartbeat" as const, ownerRunId: f.runId };
    await runnerGoalService(f.db).act(f.binding.companyId, f.binding.issueId, request);
    expect(f.action()?.status).toBe("ready");
    const originalProjection = f.action()?.resultJson?.projection;
    expect((await claimRunnerGoalActionDelivery(f.db, f.binding, { ...request, objective: "Different" }, owner)).state).toBe("indeterminate");
    expect((await claimRunnerGoalActionDelivery(f.db, f.binding, request, owner)).state).toBe("claimed");
    expect(f.action()?.resultJson?.projection).toEqual(originalProjection);
    expect(f.action()?.resultJson?.deliveryClaim).toMatchObject({
      version: 1, kind: "heartbeat", ownerRunId: f.runId,
    });
    expect(await claimRunnerGoalActionDelivery(f.db, f.binding, request, owner)).toMatchObject({
      state: "indeterminate", receiptRelation: "same_owner", claimOwnerRunId: f.runId,
    });
    expect(await claimRunnerGoalActionDelivery(f.db, f.binding, request, {
      kind: "heartbeat", ownerRunId: randomUUID(),
    })).toMatchObject({ state: "indeterminate", receiptRelation: "other_owner", claimOwnerRunId: f.runId });
    expect(f.updates).toHaveLength(1);
    const cas = f.updates[0]!;
    for (const column of ["id", "company_id", "session_id", "request_id", "payload_json", "result_json", "status"]) {
      expect(cas.sql).toContain(column);
    }
    expect(cas.params).toContain("ready");
    expect(cas.params).toContain(request.requestId);
    expect(cas.params).toContain(f.binding.companyId);
    expect(cas.params).toContain(f.binding.sessionId);
    expect(cas.params).toContain(f.action()?.id);
    expect(cas.params).toContain(JSON.stringify(request));
    f.action()!.status = "pending";
    f.action()!.resultJson = { projection: originalProjection };
    expect(await claimRunnerGoalActionDelivery(f.db, f.binding, request, owner)).toMatchObject({
      state: "indeterminate", receiptRelation: "no_valid_receipt", claimOwnerRunId: null,
    });
    expect(f.updates).toHaveLength(1);
    f.action()!.status = "ready";
    f.action()!.resultJson = { projection: originalProjection, deliveryClaim: { malformed: true } };
    expect((await claimRunnerGoalActionDelivery(f.db, f.binding, request, owner)).state).toBe("indeterminate");
    expect(f.updates).toHaveLength(1);
  });

  it("keeps a claim made during offline enqueue when the producer returns", async () => {
    const f = makeGoalDb();
    const request = {
      requestId: randomUUID(), agentId: f.binding.agentId, expectedRevision: 0,
      action: "create" as const, objective: "Race the producer",
    };
    const owner = { kind: "heartbeat" as const, ownerRunId: f.runId };
    await runnerGoalService(f.db, {
      enqueueOfflineControl: async () => {
        expect((await claimRunnerGoalActionDelivery(f.db, f.binding, request, owner)).state).toBe("claimed");
      },
    }).act(f.binding.companyId, f.binding.issueId, request);
    expect(f.action()?.status).toBe("delivering");
    expect(f.updates.map((update) => update.status)).toEqual(["delivering"]);
  });

  it("refuses to release another claim or a changed result", async () => {
    const f = makeGoalDb();
    const request = {
      requestId: randomUUID(), agentId: f.binding.agentId, expectedRevision: 0,
      action: "create" as const, objective: "Claim ownership",
    };
    await runnerGoalService(f.db).act(f.binding.companyId, f.binding.issueId, request);
    const original = f.action()!.resultJson;
    const claim = await claimRunnerGoalActionDelivery(f.db, f.binding, request, {
      kind: "live", ownerRunId: f.runId,
    });
    expect(claim.state).toBe("claimed");
    expect(await releaseUnsentRunnerGoalActionDelivery(f.db, f.binding, request, {
      ...claim, claimId: randomUUID(),
    }, original)).toBe(false);
    expect(f.action()?.status).toBe("delivering");
    f.action()!.resultJson = { ...f.action()!.resultJson, providerReceipt: "observed" };
    expect(await releaseUnsentRunnerGoalActionDelivery(f.db, f.binding, request, claim, original)).toBe(false);
    expect(f.action()?.status).toBe("delivering");
  });

  it("reserves before a live command and does not send an idempotent repeat", async () => {
    const f = makeGoalDb(true);
    const request = {
      requestId: randomUUID(), agentId: f.binding.agentId, expectedRevision: 0,
      action: "create" as const, objective: "Live once",
    };
    const send = vi.fn(() => {
      expect(f.action()?.status).toBe("delivering");
      return { runId: f.runId, completion: Promise.resolve() };
    });
    const service = runnerGoalService(f.db, { dispatchLiveControl: send });
    await service.act(f.binding.companyId, f.binding.issueId, request);
    expect(f.action()?.status).toBe("delivered");
    expect((await service.act(f.binding.companyId, f.binding.issueId, request)).status).toBe("pending");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("releases its exact claim and enqueues offline when every live sink synchronously returns null", async () => {
    const f = makeGoalDb(true);
    const offline = vi.fn(async () => {});
    const service = runnerGoalService(f.db, {
      dispatchLiveControl: () => null,
      queueLiveCommand: () => null,
      enqueueOfflineControl: offline,
    });
    await service.act(f.binding.companyId, f.binding.issueId, {
      requestId: randomUUID(), agentId: f.binding.agentId, expectedRevision: 0,
      action: "create", objective: "Queue unsent goal",
    });
    expect(offline).toHaveBeenCalledOnce();
    expect(f.action()?.status).toBe("ready");
    expect(f.action()?.resultJson?.deliveryClaim).toBeUndefined();
    expect(f.updates.map(({ status }) => status)).toEqual(["delivering", "ready"]);
    const release = f.updates[1]!;
    for (const column of ["id", "company_id", "session_id", "request_id", "payload_json", "result_json", "status"]) {
      expect(release.sql).toContain(column);
    }
    expect(release.params).toContain("delivering");
    expect(release.params).toContain(f.binding.companyId);
    expect(release.params).toContain(f.binding.sessionId);
  });

  it("holds a claim if a live sink returns an acknowledgement for another run", async () => {
    const f = makeGoalDb(true);
    const offline = vi.fn(async () => {});
    const service = runnerGoalService(f.db, {
      dispatchLiveControl: () => ({ runId: randomUUID(), completion: Promise.resolve() }),
      enqueueOfflineControl: offline,
    });
    await expect(service.act(f.binding.companyId, f.binding.issueId, {
      requestId: randomUUID(), agentId: f.binding.agentId, expectedRevision: 0,
      action: "create", objective: "Hold partial acceptance",
    })).rejects.toMatchObject({ code: "session_goal_control_delivery_indeterminate" });
    expect(offline).not.toHaveBeenCalled();
    expect(f.action()?.status).toBe("delivering");
  });

  it("holds an offline wake whose promise rejects after an unknown enqueue outcome", async () => {
    const f = makeGoalDb();
    await expect(runnerGoalService(f.db, {
      enqueueOfflineControl: async () => { throw new Error("result lost"); },
    }).act(f.binding.companyId, f.binding.issueId, {
      requestId: randomUUID(), agentId: f.binding.agentId, expectedRevision: 0,
      action: "create", objective: "Unknown wake receipt",
    })).rejects.toMatchObject({ code: "session_goal_control_delivery_indeterminate" });
    expect(f.action()?.status).toBe("delivering");
  });
});
