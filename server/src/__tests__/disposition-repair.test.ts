import { describe, expect, it } from "vitest";
import { ISSUE_RECOVERY_ACTION_KINDS } from "@paperclipai/shared";
import { classifyContinuationFailure } from "../services/recovery/service.ts";
import {
  DISPOSITION_REPAIR_BASE_DELAYS_MS,
  DISPOSITION_REPAIR_MAX_ATTEMPTS,
  dispositionRepairDelayMs,
  collectDispositionRepairSourceState,
} from "../services/recovery/disposition-repair.ts";

const deliberateWaitRun = {
  id: "run-1",
  agentId: "agent-1",
  status: "cancelled" as const,
  error: "Continuation parked",
  errorCode: "issue_continuation_waiting_on_review",
  contextSnapshot: {},
  livenessState: null,
  startedAt: new Date("2026-08-11T00:00:00.000Z"),
  createdAt: new Date("2026-08-11T00:00:00.000Z"),
};

describe("owner-sticky disposition repair", () => {
  it.each(["todo", "in_progress", "in_review", "done"])(
    "keeps stale nonblocked descriptors outside the %s upgrade fingerprint", async status => {
      const emptyQuery = () => {
        const query = { from: () => query, innerJoin: () => query, where: async () => [] };
        return query;
      };
      const db = { select: emptyQuery } as unknown as Parameters<typeof collectDispositionRepairSourceState>[0];
      const issue = {
        id: "11111111-1111-4111-8111-111111111111",
        companyId: "22222222-2222-4222-8222-222222222222",
        status, assigneeAgentId: null, assigneeUserId: null,
        executionPolicy: null, executionState: null, monitorNextCheckAt: null, unblockDescriptor: null,
      };
      const legacy = await collectDispositionRepairSourceState(db, { issue });
      const stale = await collectDispositionRepairSourceState(db, { issue: {
        ...issue, unblockDescriptor: { owner: "board", action: "Historical receipt wait" },
      } });
      expect(stale.fingerprint).toBe(legacy.fingerprint);
      expect(stale.hasDurableWaitingPath).toBe(false);
    },
  );
  it("keeps the original null-descriptor fingerprint byte-identical", async () => {
    const emptyQuery = () => {
      const query = {
        from: () => query,
        innerJoin: () => query,
        where: async () => [],
      };
      return query;
    };
    const db = { select: emptyQuery } as unknown as Parameters<typeof collectDispositionRepairSourceState>[0];
    const state = await collectDispositionRepairSourceState(db, { issue: {
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      status: "blocked", assigneeAgentId: null, assigneeUserId: null,
      executionPolicy: null, executionState: null, monitorNextCheckAt: null, unblockDescriptor: null,
    } });
    expect(state.fingerprint).toBe("disposition_repair:v1:8e17260cb097569afdde5f9ccd0591446506aeaf7e30eb1979bb31a2e5d666c1");
    expect(state.hasDurableWaitingPath).toBe(false);
  });
  it("classifies a deliberate wait without a target into its dedicated bounded lane", () => {
    expect(ISSUE_RECOVERY_ACTION_KINDS).toContain("deliberate_wait_without_target");
    expect(classifyContinuationFailure(deliberateWaitRun)).toEqual({
      kind: "deliberate_wait_without_target",
      maxAttempts: 5,
      baseBackoffMs: 60_000,
      errorCode: "issue_continuation_waiting_on_review",
    });
  });

  it("uses the persisted five-attempt owner-sticky schedule with bounded deterministic jitter", () => {
    const fingerprint = "disposition_repair:v1:example";
    const timings = [1, 2, 3, 4, 5].map((attempt) => dispositionRepairDelayMs(attempt, fingerprint));

    expect(DISPOSITION_REPAIR_MAX_ATTEMPTS).toBe(5);
    expect(DISPOSITION_REPAIR_BASE_DELAYS_MS).toEqual([0, 60_000, 120_000, 240_000, 480_000]);
    expect(timings[0]).toEqual({ baseDelayMs: 0, jitterMs: 0, delayMs: 0 });
    expect(timings[1]?.baseDelayMs).toBe(60_000);
    expect(timings[1]?.jitterMs).toBeGreaterThanOrEqual(0);
    expect(timings[1]?.jitterMs).toBeLessThanOrEqual(6_000);
    expect(timings[2]?.baseDelayMs).toBe(120_000);
    expect(timings[2]?.jitterMs).toBeGreaterThanOrEqual(0);
    expect(timings[2]?.jitterMs).toBeLessThanOrEqual(12_000);
    expect(timings[3]?.baseDelayMs).toBe(240_000);
    expect(timings[3]?.jitterMs).toBeLessThanOrEqual(24_000);
    expect(timings[4]?.baseDelayMs).toBe(480_000);
    expect(timings[4]?.jitterMs).toBeLessThanOrEqual(48_000);
    expect(dispositionRepairDelayMs(2, fingerprint)).toEqual(timings[1]);
    expect(() => dispositionRepairDelayMs(6, fingerprint)).toThrow(/Invalid disposition repair attempt/);
  });
});
