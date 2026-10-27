import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentSessionGoalActions, agentTaskSessions, agents, issues, type Db } from "@paperclipai/db";
import { inspectRunnerGoalActionDelivery } from "./runner-goals.js";

describe("read-only goal delivery preflight", () => {
  const binding = {
    companyId: randomUUID(), issueId: randomUUID(), agentId: randomUUID(),
    adapterType: "paperclip_runner", sessionId: randomUUID(),
  };
  const request = {
    requestId: randomUUID(), agentId: binding.agentId, expectedRevision: 0,
    action: "pause" as const,
  };
  const owner = { kind: "heartbeat" as const, ownerRunId: randomUUID() };

  function readOnlyDb(status: string, resultJson: Record<string, unknown>, payloadJson: unknown = request) {
    let selects = 0;
    const rows = new Map<unknown, unknown[]>([
      [issues, [{ assigneeAgentId: binding.agentId }]],
      [agents, [{ adapterType: binding.adapterType }]],
      [agentTaskSessions, [{ id: binding.sessionId }]],
      [agentSessionGoalActions, [{ id: randomUUID(), action: request.action, payloadJson, status, resultJson }]],
    ]);
    const db = {
      select: () => ({ from: (table: unknown) => {
        selects += 1;
        const query = { where: () => query, limit: async () => rows.get(table) ?? [] };
        return query;
      } }),
    } as unknown as Db;
    return { db, selectCount: () => selects };
  }

  it("reports ready without taking a claim or requiring write capabilities", async () => {
    const fixture = readOnlyDb("ready", { projection: "retained" });
    expect(await inspectRunnerGoalActionDelivery(fixture.db, binding, request, owner)).toEqual({
      state: "ready", receiptRelation: "no_valid_receipt", claimOwnerRunId: null, claimId: null,
      consumeOnlyEligible: false,
    });
    expect(fixture.selectCount()).toBe(4);
  });

  it("identifies an exact same-owner heartbeat receipt without replaying it", async () => {
    const claimId = randomUUID();
    const fixture = readOnlyDb("delivering", { deliveryClaim: {
      version: 1, kind: "heartbeat", ownerRunId: owner.ownerRunId, claimId,
    } });
    expect(await inspectRunnerGoalActionDelivery(fixture.db, binding, request, owner)).toEqual({
      state: "indeterminate", receiptRelation: "same_owner", claimOwnerRunId: owner.ownerRunId, claimId,
      consumeOnlyEligible: true,
    });
  });

  it("holds legacy unknown and a changed canonical payload", async () => {
    const legacy = readOnlyDb("pending", {});
    expect((await inspectRunnerGoalActionDelivery(legacy.db, binding, request, owner)).state).toBe("indeterminate");
    const changed = readOnlyDb("ready", {}, { ...request, expectedRevision: 1 });
    expect((await inspectRunnerGoalActionDelivery(changed.db, binding, request, owner)).state).toBe("indeterminate");
    const inconsistent = readOnlyDb("ready", { deliveryClaim: {
      version: 1, kind: "heartbeat", ownerRunId: owner.ownerRunId, claimId: randomUUID(),
    } });
    expect(await inspectRunnerGoalActionDelivery(inconsistent.db, binding, request, owner)).toMatchObject({
      state: "indeterminate", receiptRelation: "same_owner", consumeOnlyEligible: false,
    });
    const mismatchedClaimed = readOnlyDb("delivering", { deliveryClaim: {
      version: 1, kind: "heartbeat", ownerRunId: owner.ownerRunId, claimId: randomUUID(),
    } }, { ...request, expectedRevision: 1 });
    expect(await inspectRunnerGoalActionDelivery(mismatchedClaimed.db, binding, request, owner)).toMatchObject({
      state: "indeterminate", receiptRelation: "same_owner", consumeOnlyEligible: false,
    });
  });
});
