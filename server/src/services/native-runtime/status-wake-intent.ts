import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests } from "@paperclipai/db";

// Shared transactional outbox for native status and final review acceptance.
// These intents are dispatched by the existing native-status scheduler only
// after the surrounding transaction commits. Keep the producer identity stable
// so normal admission and crash recovery apply to both completion paths.
export async function enqueueNativeStatusWakeIntent(input: {
  tx: Db;
  companyId: string;
  issueId: string;
  agentId: string;
  reason: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  contextSnapshot?: Record<string, unknown>;
}) {
  const existing = await input.tx
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        inArray(agentWakeupRequests.status, [
          "queued",
          "deferred_issue_execution",
          "claimed",
          "completed",
        ]),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (existing) return existing.id;
  const inserted = await input.tx
    .insert(agentWakeupRequests)
    .values({
      companyId: input.companyId,
      agentId: input.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: input.reason,
      payload: {
        issueId: input.issueId,
        taskId: input.issueId,
        ...input.payload,
        _paperclipWakeContext: {
          issueId: input.issueId,
          taskId: input.issueId,
          ...(input.contextSnapshot ?? {}),
          wakeReason: input.reason,
          source: "native_status_decision",
          statusDecisionSource: "native_status_decision",
        },
      },
      requestedByActorType: "system",
      requestedByActorId: "native-status-committer",
      idempotencyKey: input.idempotencyKey,
    })
    .returning({ id: agentWakeupRequests.id })
    .then((rows) => rows[0] ?? null);
  if (!inserted) throw new Error("native_status_wake_not_persisted");
  return inserted.id;
}
