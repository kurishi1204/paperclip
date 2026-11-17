/** Read-only metadata contract; business/QA bodies never belong in this response. */
export interface NativeRunReceiptReadback {
  schema: "paperclip.native-run-receipt-readback.v1";
  observedAtUTC: string;
  scope: { companyId: string; issueId: string | null; runId: string; agentId: string };
  /** Optional on older servers; absence is unverified, never a clean recovery. */
  recovery?: NativeRunRecoveryReadback;
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

export interface NativeRunRecoveryReadback {
  schema: "paperclip.native-run-recovery-readback.v1";
  inspectionOnly: true;
  projection: {
    state: "observed" | "unverified"; phase: string | null; cause: string | null;
    recoveryOwner: string | null; inspectionActions: Array<"inspect_run" | "inspect_recovery">;
  };
  cleanupHistory: {
    state: "recorded" | "not_recorded" | "unverified"; complete: boolean;
    totalCount: number | null; observedCount: number; unclassifiedCount: number;
    rows: Array<{
      kind: string | null; phase: string | null; requestIdHash: string | null;
      sourceFingerprint: string | null; settledFingerprint: string | null;
      code: string | null; startedAt: string | null; settledAt: string | null;
      bindingState: "exact" | "row_scoped" | "conflicting" | "unverified";
    }>;
  };
  maintenanceEvents: {
    state: "recorded" | "not_recorded" | "unverified"; complete: boolean;
    observedCount: number; unclassifiedCount: number;
    rows: Array<{
      eventSeq: number; createdAt: string; rawSourceSeq: number | null; eventType: string | null;
      requestIdHash: string | null; canonicalSha256: string | null;
      bindingState: "same_run" | "conflicting" | "unverified";
    }>;
  };
  actions: {
    state: "recorded" | "not_recorded" | "unverified"; complete: boolean;
    observedCount: number; unclassifiedCount: number;
    rows: Array<{
      id: string; kind: string | null; status: string | null; cause: string | null;
      ownerType: string | null; ownerAgentId: string | null; returnOwnerAgentId: string | null;
      outcome: string | null; attemptCount: number; maxAttempts: number | null;
      timeoutAt: string | null; updatedAt: string; automaticRecoveryPolicy: string | null;
      automaticActionOutcome: string | null; replay: string | null;
      providerStoppedRecorded: boolean | null; entry: string | null;
    }>;
  };
  gaps: string[];
  verification: {
    providerStop: "unverified"; actionOutcomes: "unverified"; sourceRunLink: "unverified";
    sourceRunId: null; automaticRetry: false;
  };
  operatorEntry: {
    runPath: string; taskPath: string; kind: "inspect_original_run_and_task_recovery";
  };
}
