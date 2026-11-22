import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { forbidden } from "./errors.js";

/** Stop revokes write authority before waiting for the executor to settle. */
export function agentRunWritesRevoked(run: {
  status: string;
  resultJson?: Record<string, unknown> | null;
} | null | undefined): boolean {
  const cancellation = run?.resultJson?.executionCancellation;
  return run?.status === "cancelled" || Boolean(cancellation && typeof cancellation === "object"
    && "state" in cancellation && cancellation.state === "requested");
}

/** The two cancellation facts read from a run's result document. The whole
 * document can reach megabytes and these checks run on every agent request and
 * write, so only the facts are selected. */
export function agentRunCancellationColumns() {
  return {
    status: heartbeatRuns.status,
    executionCancellation: sql<unknown>`${heartbeatRuns.resultJson} -> 'executionCancellation'`,
    issueMutationStopId: sql<string | null>`case
      when jsonb_typeof(${heartbeatRuns.resultJson} -> 'issueMutationStopId') = 'string'
      then ${heartbeatRuns.resultJson} ->> 'issueMutationStopId' end`,
  };
}

/** The caller must supply its write transaction, so Stop and commit serialize. */
export async function assertAgentRunWriteAllowed(tx: Db, companyId: string, actor: {
  agentId?: string | null;
  runId?: string | null;
  stopId?: string | null;
}) {
  if (!actor.agentId || !actor.runId) return;
  const [run] = await tx.select(agentRunCancellationColumns())
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, actor.runId),
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, actor.agentId)))
    .for("share");
  const stoppedForThisMutation = run?.status === "cancelled" && actor.stopId &&
    run.issueMutationStopId === actor.stopId;
  if (agentRunWritesRevoked(run && { status: run.status, resultJson: { executionCancellation: run.executionCancellation } })
    && !stoppedForThisMutation) {
    throw forbidden("This run was cancelled", { code: "agent_run_cancelled" });
  }
}
