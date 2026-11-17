import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import type { ExecutionProjection } from "@paperclipai/shared";
import { readNativeRunRecoveryReadback } from "./native-run-recovery-readback.js";

const CLEANUP_NEXT_ACTION = "Send a new message to continue after Paperclip verifies that the previous provider and its tools have stopped. If cleanup cannot be verified, inspect the run and its environment. Clearing a task session does not resolve this quarantine. Automatic retries are stopped.";

function emptyReadDb(): Pick<Db, "select"> {
  const db = {
    select: () => {
      const rows: unknown[] = [];
      const query = {
        from: () => query,
        where: () => query,
        orderBy: () => query,
        limit: async () => rows,
      };
      return query;
    },
  };
  return db as unknown as Pick<Db, "select">;
}

describe("native run recovery readback", () => {
  it("preserves the original long operator next action without loosening bounded identifiers", async () => {
    expect(CLEANUP_NEXT_ACTION.length).toBe(267);
    const projection = {
      phase: "recovery_needed",
      cause: "native_session_cleanup_quarantined",
      recoveryOwner: "board",
      nextAction: CLEANUP_NEXT_ACTION,
      successorRunId: "r".repeat(257),
      permittedActions: ["inspect_run", "inspect_recovery"],
    } as unknown as ExecutionProjection;
    const receipt = await readNativeRunRecoveryReadback(emptyReadDb(), {
      id: "run-1", companyId: "company-1", agentId: "agent-1", nativeIssueId: "issue-1",
      nativeSessionId: null, runnerInstanceId: null,
    }, { finalizationObserved: true, history: [], totalCount: 0 }, { runId: "run-1", projection });

    expect(receipt.projection.nextAction).toBe(CLEANUP_NEXT_ACTION);
    expect(receipt.projection.successorRunId).toBeNull();
  });
});
