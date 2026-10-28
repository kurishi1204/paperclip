import { describe, expect, it } from "vitest";
import { issueExecutionDecisions, issues, type Db } from "@paperclipai/db";
import {
  isAuthorizedQaDecisionWake,
  isCurrentQaChangesRequestedDecision,
  qaDecisionIdFromWakeKey,
  qaDecisionWakeKey,
} from "./qa-decision-wake.js";

const current = {
  companyId: "company-1", issueId: "issue-1", agentId: "worker-1",
  decisionId: "decision-1", decision: {
    id: "decision-1", companyId: "company-1", issueId: "issue-1",
    stageId: "stage-1", stageType: "review", outcome: "changes_requested",
    freshEpisodeWakeRequested: true,
  },
  issue: {
    id: "issue-1", companyId: "company-1", status: "in_progress",
    assigneeAgentId: "worker-1",
    executionState: {
      status: "changes_requested", currentStageId: "stage-1",
      lastDecisionId: "decision-1", returnAssignee: { type: "agent", agentId: "worker-1" },
    },
  },
} as const;

describe("QA decision wake authority", () => {
  it("accepts only the committed current decision for the return assignee", () => {
    expect(isCurrentQaChangesRequestedDecision(current)).toBe(true);
    expect(isCurrentQaChangesRequestedDecision({ ...current, agentId: "other" })).toBe(false);
    expect(isCurrentQaChangesRequestedDecision({ ...current, decision: { ...current.decision, outcome: "approved" } })).toBe(false);
    expect(isCurrentQaChangesRequestedDecision({ ...current, decision: { ...current.decision, freshEpisodeWakeRequested: false } })).toBe(false);
    expect(isCurrentQaChangesRequestedDecision({ ...current, issue: { ...current.issue, executionState: { ...current.issue.executionState, lastDecisionId: "later" } } })).toBe(false);
    expect(isCurrentQaChangesRequestedDecision({ ...current, issue: { ...current.issue, executionState: { ...current.issue.executionState, currentStageId: "later" } } })).toBe(false);
  });

  it("rechecks the same committed source at admission and claim", async () => {
    const issue: {
      id: string; companyId: string; status: string; assigneeAgentId: string;
      executionState: { status: string; currentStageId: string; lastDecisionId: string;
        returnAssignee: { type: string; agentId: string } };
    } = structuredClone(current.issue);
    const decision = structuredClone(current.decision);
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({ limit: async () => table === issues ? [issue] : table === issueExecutionDecisions ? [decision] : [] }),
        }),
      }),
    } as unknown as Db;
    const identity = {
      companyId: current.companyId, issueId: current.issueId,
      agentId: current.agentId, decisionId: current.decisionId,
    };
    expect(await isAuthorizedQaDecisionWake(db, identity)).toBe(true);
    const committedId = "11111111-1111-4111-8111-111111111111";
    expect(qaDecisionIdFromWakeKey(qaDecisionWakeKey(committedId))).toBe(committedId);
    // A later review decision makes the queued wake stale before claim.
    issue.executionState.lastDecisionId = "new-decision";
    expect(await isAuthorizedQaDecisionWake(db, identity)).toBe(false);
  });
});
