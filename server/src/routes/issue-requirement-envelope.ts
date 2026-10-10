import { createHash } from "node:crypto";
import { Router } from "express";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues } from "@paperclipai/db";
import { conflict, forbidden, notFound, unauthorized } from "../errors.js";
import { accessService } from "../services/access.js";
import { captureIssueRequirementSnapshotInTransaction } from "../services/issue-requirement-snapshot.js";
import { assertCompanyAccess, hasCompanyAccess } from "./authz.js";

type DescriptionBody = {
  task_kind: "internal_docs_only";
  requirements_text: string;
  accepted_requirements: string[];
  native_document_complete: true;
};

const ASSIGNMENT_RUN_CONTEXT_KEYS = [
  "issueId", "source", "taskId", "taskKey", "wakeReason", "wakeSource", "wakeTriggerDetail",
] as const;

function assertSupportedAssignmentRunContext(run: {
  contextSnapshot: Record<string, unknown> | null;
  invocationSource: string;
  triggerDetail: string | null;
}, issueId: string) {
  const context = run.contextSnapshot;
  if (!context || Array.isArray(context) ||
      Object.keys(context).length !== ASSIGNMENT_RUN_CONTEXT_KEYS.length ||
      ASSIGNMENT_RUN_CONTEXT_KEYS.some((key) => !Object.hasOwn(context, key))) {
    hold("Active Run carries unsupported task context");
  }
  const expected = context.source === "issue.create" || context.source === "issue.update"
    ? { wakeReason: "issue_assigned", wakeSource: "assignment" }
    : context.source === "issue.status_change"
    ? { wakeReason: "issue_status_changed", wakeSource: "automation" }
    : null;
  if (!expected || context.issueId !== issueId || context.taskId !== issueId ||
      context.taskKey !== issueId || context.wakeReason !== expected.wakeReason ||
      context.wakeSource !== expected.wakeSource || context.wakeTriggerDetail !== "system" ||
      run.invocationSource !== expected.wakeSource || run.triggerDetail !== "system") {
    hold("Active Run context is not a supported Issue assignment wake");
  }
}

// SHA-256 of the sorted SQL-content hashes for every migration in this fork
// through 0313. A new or replaced migration requires an explicit canary review.
const APPROVED_MIGRATION_SET_SHA256 = "7b78cd60efa0fd8e4153379cbb10508dd9dcfd108df4c029d4a7ead2fe13bb51";

function hold(reason: string): never {
  throw conflict(reason, { code: "requirement_projection_hold" });
}

function isSerializationFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") return false;
    if ((current as { code?: unknown }).code === "40001") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function assertReviewedSchema(tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) {
  let migrations: Awaited<ReturnType<typeof tx.execute>>;
  try {
    migrations = await tx.execute(sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY hash`);
  } catch {
    hold("Database migration inventory is unavailable");
  }
  if (migrations.some((entry) => typeof entry.hash !== "string")) {
    hold("Database migration inventory is malformed");
  }
  const manifest = createHash("sha256")
    .update(migrations.map((entry) => entry.hash).join("\n"))
    .digest("hex");
  if (manifest !== APPROVED_MIGRATION_SET_SHA256) {
    hold("Database schema has not been reviewed for this canary");
  }
}

/** JSON.parse accepts duplicate keys; the canary document contract does not. */
function hasDuplicateTopLevelKey(text: string): boolean {
  const seen = new Set<string>();
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let start = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        quoted = false;
        if (depth !== 1) continue;
        let next = index + 1;
        while (/\s/.test(text[next] ?? "")) next += 1;
        if (text[next] !== ":") continue;
        const key = JSON.parse(text.slice(start, index + 1)) as string;
        if (seen.has(key)) return true;
        seen.add(key);
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      start = index;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
    }
  }
  return false;
}

function readDescription(value: string | null): DescriptionBody {
  if (!value || value.length > 1_048_576) hold("Complete canary requirement document is unavailable");
  let raw: unknown;
  try {
    raw = JSON.parse(value);
    if (hasDuplicateTopLevelKey(value)) hold("Duplicate requirement document key");
  } catch (error) {
    if (error instanceof Error && "status" in error) throw error;
    hold("Requirement document is not strict JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) hold("Requirement document must be an object");
  const body = raw as Record<string, unknown>;
  const expected = ["task_kind", "requirements_text", "accepted_requirements", "native_document_complete"];
  if (Object.keys(body).length !== expected.length || expected.some((key) => !Object.hasOwn(body, key))) {
    hold("Requirement document has missing or unsupported fields");
  }
  if (body.task_kind !== "internal_docs_only" ||
      typeof body.requirements_text !== "string" || body.requirements_text.trim().length === 0 ||
      !Array.isArray(body.accepted_requirements) || body.accepted_requirements.length === 0 ||
      body.accepted_requirements.some((item) => typeof item !== "string" || item.trim().length === 0) ||
      body.native_document_complete !== true) {
    hold("Requirement document is incomplete or unsupported");
  }
  return body as DescriptionBody;
}

/** Any direct Issue reference outside the serialization row is unsupported. */
async function hasUnsupportedIssueReference(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  issueId: string,
): Promise<boolean> {
  // Inspect the actual migrated schema, including newly added tables. The
  // suffix check catches explicit columns that lack a foreign key; the FK
  // branch catches nonstandard column names. A new reference therefore holds
  // the canary until it is deliberately classified.
  const references = await tx.execute(sql<{ tableName: string; columnName: string }>`
    SELECT DISTINCT relation.relname AS "tableName", attribute.attname AS "columnName"
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
      AND relation.relname NOT IN ('issues', 'heartbeat_runs')
      AND (
        attribute.attname ~ 'issue_id$'
        OR EXISTS (
          SELECT 1 FROM pg_constraint reference
          JOIN pg_class target ON target.oid = reference.confrelid
          WHERE reference.conrelid = relation.oid
            AND reference.contype = 'f'
            AND target.relname = 'issues'
            AND attribute.attnum = ANY(reference.conkey)
        )
      )
    ORDER BY relation.relname, attribute.attname
  `);
  for (const reference of references) {
    if (typeof reference.tableName !== "string" || typeof reference.columnName !== "string") {
      hold("Issue reference inventory is malformed");
    }
    const tableName = reference.tableName.replaceAll('"', '""');
    const columnName = reference.columnName.replaceAll('"', '""');
    const found = await tx.execute(sql`
      SELECT 1 FROM ${sql.raw(`"public"."${tableName}"`)}
      WHERE ${sql.raw(`"${columnName}"`)}::text = ${issueId} LIMIT 1
    `);
    if (found.length > 0) return true;
  }
  return false;
}

/**
 * First canary only. The Issue row is the serialization point for native
 * requirement children (migrations 0312/0313). Separate evidence and the
 * parent/child graph are not mapped into the seven-field broker envelope, so
 * their presence holds the projection. No outbox reservation or send occurs.
 */
export function issueRequirementEnvelopeRoutes(db: Db) {
  const router = Router();
  router.get("/issues/:id/requirement-envelope", async (req, res) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    if (req.actor.type === "none") throw unauthorized();
    if (req.actor.type !== "agent" || req.actor.source !== "agent_jwt" || !req.actor.agentId) {
      throw forbidden("A runtime-bound agent is required");
    }
    const runId = req.actor.runId?.trim();
    if (!runId) throw unauthorized("Agent run id required");
    const issueId = req.params.id as string;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(issueId)) {
      throw notFound("Issue not found");
    }
    const actor = req.actor;
    const companyId = actor.companyId;
    if (!companyId) throw unauthorized("Agent company id required");
    const envelope = await db.transaction(async (tx) => {
      // All checks below read one snapshot. Native child writers take this
      // Issue row lock before changing their material.
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      const [issue] = await tx.select().from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
        .for("update");
      if (!issue || !hasCompanyAccess(req, issue.companyId)) throw notFound("Issue not found");
      assertCompanyAccess(req, issue.companyId);
      const decision = await accessService(tx as unknown as Db).decide({
        actor,
        action: "issue:read",
        resource: {
          type: "issue", companyId: issue.companyId, issueId: issue.id,
          projectId: issue.projectId, parentIssueId: issue.parentId,
          assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId,
          status: issue.status,
        },
        scope: {
          issueId: issue.id, projectId: issue.projectId, parentIssueId: issue.parentId,
          assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId,
        },
      });
      if (!decision.allowed || issue.assigneeAgentId !== actor.agentId || issue.assigneeUserId !== null) {
        throw forbidden("Issue is outside this agent's authority");
      }
      const [run] = await tx.select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        finishedAt: heartbeatRuns.finishedAt,
        invocationSource: heartbeatRuns.invocationSource,
        triggerDetail: heartbeatRuns.triggerDetail,
        nativeIssueId: heartbeatRuns.nativeIssueId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.companyId, issue.companyId),
        eq(heartbeatRuns.agentId, actor.agentId),
      )).for("share");
      if (!run || run.status !== "running" || run.finishedAt ||
          run.contextSnapshot?.issueId !== issue.id ||
          (run.nativeIssueId !== null && run.nativeIssueId !== issue.id)) {
        throw forbidden("Active Run is not bound to this Issue");
      }
      assertSupportedAssignmentRunContext(run, issue.id);
      const [competingRun] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, issue.companyId),
          ne(heartbeatRuns.id, runId),
          eq(heartbeatRuns.status, "running"),
          isNull(heartbeatRuns.finishedAt),
          or(
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
            eq(heartbeatRuns.nativeIssueId, issue.id),
          ),
        )).limit(1);
      if (competingRun) hold("More than one active Run claims this Issue");
      if (issue.checkoutRunId === null) {
        // heartbeat stamps the active execution Run before the agent can
        // perform checkout. The broker freezes in this state first.
        if (!["todo", "backlog"].includes(issue.status) || issue.executionRunId !== runId) {
          hold("Issue is not in the pre-checkout canary state");
        }
      } else if (issue.checkoutRunId !== runId || issue.executionRunId !== runId) {
        throw forbidden("Issue is checked out by another Run");
      } else if (issue.status !== "in_progress") {
        hold("Issue checkout state is inconsistent");
      }
      if (issue.parentId || issue.projectId || issue.projectWorkspaceId || issue.goalId ||
          issue.conversationAgentId || issue.conversationUserId || issue.conversationState ||
          issue.conversationSessionGeneration !== 0 || issue.conversationBoundaryCommentId ||
          issue.titleNeedsGeneration || issue.lastStatusDecisionId || issue.reviewPolicy ||
          issue.workMode !== "standard" || issue.harnessKind || issue.originKind !== "manual" ||
          issue.originId || issue.originRunId || issue.originIdentityContextId ||
          issue.continuationIdentityContextId || issue.originFingerprint !== "default" ||
          issue.requestDepth !== 0 || issue.billingCode || issue.sourceTrust || issue.unblockDescriptor ||
          issue.executionPolicy || issue.executionState || issue.assigneeAdapterOverrides ||
          issue.executionWorkspaceId || issue.executionWorkspacePreference || issue.executionWorkspaceSettings ||
          issue.monitorNextCheckAt || issue.monitorWakeRequestedAt ||
          issue.monitorLastTriggeredAt || issue.monitorAttemptCount !== 0 || issue.monitorNotes ||
          issue.monitorScheduledBy || issue.blockedTransitionAt || issue.blockedOwnerNotifiedAt ||
          issue.completedAt || issue.cancelledAt || issue.hiddenAt) {
        hold("Issue has unsupported linked or execution material");
      }
      await assertReviewedSchema(tx);
      const snapshot = await captureIssueRequirementSnapshotInTransaction(tx, { companyId: issue.companyId, issueId: issue.id });
      if (Object.values(snapshot.counts).some((count) => count !== 0)) {
        hold("Issue has unsupported native child material");
      }
      const [child] = await tx.select({ id: issues.id }).from(issues)
        .where(and(eq(issues.companyId, issue.companyId), eq(issues.parentId, issue.id))).limit(1);
      if (child || await hasUnsupportedIssueReference(tx, issue.id)) {
        hold("Issue has unsupported graph or governance material");
      }
      const description = readDescription(issue.description);
      // Revision includes only accepted content and stable identity. Native
      // issue.revision and full-row snapshots change on checkout/status writes.
      const revision = createHash("sha256").update(JSON.stringify({
        schema: "paperclip.requirement-envelope.v1",
        migrationSetSha256: APPROVED_MIGRATION_SET_SHA256,
        id: issue.id,
        companyId: issue.companyId,
        title: issue.title,
        task_kind: description.task_kind,
        requirements_text: description.requirements_text,
        accepted_requirements: description.accepted_requirements,
        native_document_complete: description.native_document_complete,
      })).digest("hex");
      return {
        id: issue.id,
        companyId: issue.companyId,
        revision,
        task_kind: description.task_kind,
        requirements_text: description.requirements_text,
        accepted_requirements: description.accepted_requirements,
        native_document_complete: true as const,
      };
    }).catch((error: unknown) => {
      if (isSerializationFailure(error)) hold("Issue changed during requirement projection");
      throw error;
    });
    // res.end avoids Express GET ETag/If-None-Match freshness conversion to 304.
    res.status(200).setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(envelope));
  });
  return router;
}
