/** Read-only metadata contract; business/QA bodies never belong in this response. */
export interface NativeRunReceiptReadback {
  schema: "paperclip.native-run-receipt-readback.v1";
  observedAtUTC: string;
  scope: { companyId: string; issueId: string | null; runId: string; agentId: string };
  comparison: {
    state: "accepted_same_hash" | "missing" | "unverified" | "conflicting";
    expectedCanonicalSha256: string | null;
    reasons: string[];
    complete: boolean;
  };
  results: {
    complete: boolean;
    limit: number;
    rows: Array<{
      id: string; turnIdHash: string | null; completionContractId: string;
      schemaStatus: string; canonicalSha256: string | null; serverFingerprint: string | null;
      callerResultIdHash: string | null; callerDedupeKeyHash: string | null; createdAt: string;
    }>;
  };
  finalization: {
    state: "found" | "missing";
    record: null | {
      phase: string; attempt: number; resultId: string | null; assessmentId: string | null;
      decisionId: string | null; failureCode: string | null; leaseOwnerHash: string | null;
      leaseExpiresAt: string | null; controllerBootId: string | null; controllerPid: number | null;
      controllerProcessStartedAt: string | null; controllerGeneration: number;
      recoveryState: string | null; recoveryRequestIdHash: string | null;
      controlDeadlineAt: string | null; nextAttemptAt: string | null; updatedAt: string;
    };
  };
  decision: {
    state: "found" | "missing" | "not_referenced";
    record: null | {
      id: string; assessmentId: string; decisionVersion: number; policyVersion: string;
      fromStatus: string; toStatus: string; reasonCode: string; decisionDigest: string | null;
      applicationState: string; appliedAt: string | null; createdAt: string;
    };
  };
  effects: {
    state: "found" | "missing" | "not_referenced" | "unverified"; complete: boolean; limit: number;
    rows: Array<{
      id: string; decisionId: string; ordinal: number; effectKind: string; targetType: string;
      targetIdHash: string | null; idempotencyKeyHash: string; deliveryState: string;
      attemptCount: number; nextAttemptAt: string | null; deliveredAt: string | null; updatedAt: string;
    }>;
  };
  authority: {
    run: {
      status: string; runtimeMode: string; runnerInstanceId: string | null; nativeSessionId: string | null;
      controllerBootId: string | null; controllerLeaseExpiresAt: string | null;
      processPid: number | null; processStartedAt: string | null;
    };
    issue: null | {
      id: string; status: string; assigneeAgentId: string | null; checkoutRunId: string | null;
      executionRunId: string | null; lastStatusDecisionId: string | null;
    };
    environmentLeases: {
      complete: boolean; limit: number;
      rows: Array<{
        id: string; environmentId: string | null; executionWorkspaceId: string | null;
        status: string; leasePolicy: string; acquiredAt: string; expiresAt: string | null;
        releasedAt: string | null; cleanupStatus: string | null;
      }>;
    };
  };
}
