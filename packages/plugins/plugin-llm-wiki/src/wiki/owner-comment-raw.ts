import { createHash } from "node:crypto";
import type { Issue, IssueComment, PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { DEFAULT_MAX_SOURCE_BYTES, PLUGIN_ID, WIKI_ROOT_FOLDER_KEY } from "../manifest.js";
import { containsDistillationSecret, ownerCommentRawSpacePolicy, spaceRelativePath, type WikiSpace } from "./core.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const MAX_ISSUES = 25;
const MAX_SKEW_MS = 5 * 60_000;
const NAMESPACE = "owner-comment-raw-capture";
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const uuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const opaqueUserId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 160 && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
const dateMs = (value: unknown) => {
  const n = value instanceof Date ? value.getTime() : typeof value === "string" ? new Date(value).getTime() : NaN;
  return Number.isFinite(n) ? n : null;
};
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export class OwnerCommentRawHold extends Error {
  constructor(readonly code: string) { super(`owner_comment_raw_${code}`); }
}
function hold(code: string): never { throw new OwnerCommentRawHold(code); }

type Config = {
  ownerUserId: string;
  spaceSlug: string;
  issueIds: string[];
  maxBodyBytes: number;
  policySha256: string;
  consentDecision: { label: "internal"; decidedByUserId: string; decidedAt: string; decisionRef: string };
};

function parseConfig(raw: Record<string, unknown>): Config | null {
  const input = record(raw.ownerCommentRawCapture);
  if (!input || input.enabled !== true) return null;
  const classification = record(input.classification);
  const ids = input.issueIds;
  const maxGlobal = typeof raw.maxSourceBytes === "number" && Number.isSafeInteger(raw.maxSourceBytes) && raw.maxSourceBytes > 0
    ? Math.min(raw.maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES) : DEFAULT_MAX_SOURCE_BYTES;
  if (input.version !== 1 || !opaqueUserId(input.ownerUserId) || typeof input.spaceSlug !== "string"
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.spaceSlug) || input.spaceSlug.length > 64
    || !Array.isArray(ids) || ids.length < 1 || ids.length > MAX_ISSUES || !ids.every(uuid)
    || new Set((ids as string[]).map((id) => id.toLowerCase())).size !== ids.length || input.allowCompanyReaders !== true
    || !Number.isSafeInteger(input.maxBodyBytes) || (input.maxBodyBytes as number) < 1
    || (input.maxBodyBytes as number) > maxGlobal
    || classification?.label !== "internal" || classification.decidedByUserId !== input.ownerUserId
    || typeof classification.decisionRef !== "string" || !classification.decisionRef.trim()
    || typeof classification.decidedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(classification.decidedAt)
    || !Number.isFinite(Date.parse(classification.decidedAt))) {
    hold("invalid_config");
  }
  const ownerUserId = input.ownerUserId as string;
  const spaceSlug = input.spaceSlug as string;
  const issueIds = (ids as string[]).map((id) => id.toLowerCase());
  return {
    ownerUserId, spaceSlug, issueIds,
    maxBodyBytes: input.maxBodyBytes as number,
    policySha256: hash(JSON.stringify({version: 1, ownerUserId: input.ownerUserId, spaceSlug: input.spaceSlug,
      allowCompanyReaders: true, classificationLabel: "internal"})),
    consentDecision: {label:"internal",decidedByUserId:ownerUserId,
      decidedAt:classification.decidedAt as string,decisionRef:classification.decisionRef as string},
  };
}

function exactComment(comments: IssueComment[], commentId: string, companyId: string, issue: Issue, owner: string,
  occurredAt: number, maxBytes: number): { comment: IssueComment; bodyHash: string; updatedAt: string } {
  const matches = comments.filter((comment) => comment.id === commentId);
  if (matches.length !== 1) hold("comment_missing_or_ambiguous");
  const comment = matches[0]!;
  if (comment.companyId !== companyId || comment.issueId !== issue.id || comment.authorType !== "user"
    || comment.authorUserId !== owner || comment.authorAgentId !== null
    || (comment.onBehalfOfUserId != null && comment.onBehalfOfUserId !== owner)
    || comment.createdByRunId != null || comment.derivedAuthorAgentId != null
    || comment.derivedCreatedByRunId != null || comment.derivedAuthorSource != null
    || comment.deletedAt != null || comment.sourceTrust != null || comment.metadata != null || comment.presentation != null) {
    hold("comment_attribution");
  }
  const created = dateMs(comment.createdAt), updated = dateMs(comment.updatedAt);
  if (created === null || updated === null || created !== updated || created > occurredAt + MAX_SKEW_MS
    || occurredAt - created > MAX_SKEW_MS) hold("comment_version");
  if (typeof comment.body !== "string" || !comment.body.trim()
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(comment.body)) hold("body_invalid");
  if (Buffer.byteLength(comment.body, "utf8") > maxBytes || containsDistillationSecret(comment.body)) hold("body_denied");
  return { comment, bodyHash: hash(comment.body), updatedAt: new Date(updated).toISOString() };
}

type Row = { company_id: string; space_id: string; comment_id: string; issue_id: string; owner_user_id: string;
  body_sha256: string; comment_updated_at: string; raw_path: string; policy_sha256: string; status: string };
const table = (ctx: PluginContext) => `"${ctx.db.namespace}"."paperclip_owner_raw_captures"`;
async function getRow(ctx: PluginContext, companyId: string, spaceId: string, commentId: string): Promise<Row | null> {
  const rows = await ctx.db.query<Row>(`SELECT company_id, space_id, comment_id, issue_id, owner_user_id, body_sha256,
    to_char(comment_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS comment_updated_at,
    raw_path, policy_sha256, status FROM ${table(ctx)}
    WHERE company_id=$1 AND space_id=$2 AND comment_id=$3`, [companyId, spaceId, commentId]);
  return rows[0] ?? null;
}
function rowMatches(row: Row, input: {companyId: string; space: WikiSpace; commentId: string; issueId: string;
  owner: string; bodyHash: string; updatedAt: string; path: string; policyHash: string}) {
  return row.company_id === input.companyId && row.space_id === input.space.id && row.comment_id === input.commentId
    && row.issue_id === input.issueId && row.owner_user_id === input.owner && row.body_sha256 === input.bodyHash
    && dateMs(row.comment_updated_at) === dateMs(input.updatedAt) && row.raw_path === input.path
    && row.policy_sha256 === input.policyHash && ["pending", "verified"].includes(row.status);
}
async function readExactFile(ctx: PluginContext, companyId: string, path: string, body: string, bodyHash: string) {
  const actual = await ctx.localFolders.readText(companyId, WIKI_ROOT_FOLDER_KEY, path);
  if (actual !== body || hash(actual) !== bodyHash || Buffer.byteLength(actual, "utf8") !== Buffer.byteLength(body, "utf8")) hold("file_integrity");
}

async function writeHealth(ctx: PluginContext, event: PluginEvent, commentId: string | null,
  status: "hold" | "pending" | "verified", reason: string | null) {
  try {
    await ctx.state.set({ scopeKind: "company", scopeId: event.companyId, namespace: NAMESPACE,
      stateKey: commentId ?? event.eventId },
      { status, reason, eventId: event.eventId, observedAt: new Date().toISOString() });
  } catch {
    // Host failures can carry file paths or source text. Expose only the fixed failure code.
    ctx.logger.error("Owner comment raw health write failed", { companyId: event.companyId, reason: "state_write_failed" });
    hold("state_write_failed");
  }
}

async function noteHold(ctx: PluginContext, event: PluginEvent, commentId: string | null, code: string) {
  await writeHealth(ctx, event, commentId, "hold", code);
  ctx.logger.warn("Owner comment raw capture held", { companyId: event.companyId, reason: code });
}

async function notePending(ctx: PluginContext, event: PluginEvent, commentId: string | null) {
  await writeHealth(ctx, event, commentId, "pending", "io_unknown");
  ctx.logger.error("Owner comment raw capture pending", { companyId: event.companyId, reason: "io_unknown" });
}

export async function captureOwnerCommentRaw(ctx: PluginContext, event: PluginEvent): Promise<"disabled" | "skipped" | "verified"> {
  if (event.eventType !== "issue.comment.created") return "skipped";
  if (!uuid(event.companyId) || event.entityType !== "issue" || !uuid(event.entityId)) return "skipped";
  const payload = record(event.payload);
  const commentId = payload?.commentId;
  let config: Config | null;
  let rawConfig: Record<string, unknown>;
  try { rawConfig = await ctx.config.get(event.companyId); }
  catch (error) {
    ctx.logger.error("Owner comment raw config unavailable", { companyId: event.companyId, reason: "config_unavailable" });
    hold("config_unavailable");
  }
  try { config = parseConfig(rawConfig); }
  catch (error) {
    if (error instanceof OwnerCommentRawHold && error.code === "invalid_config") {
      await noteHold(ctx, event, "config", error.code);
      throw error;
    }
    throw error;
  }
  if (!config) return "disabled";
  if (!config.issueIds.includes(event.entityId)) return "skipped";
  if (event.actorType !== "user" || event.actorId !== config.ownerUserId) return "skipped";
  try {
    if (!uuid(commentId) || payload?.agentId !== null || payload.runId !== null
      || (payload.responsibleUserId !== null && payload.responsibleUserId !== config.ownerUserId)) hold("event_attribution");
    const occurredAt = dateMs(event.occurredAt);
    if (occurredAt === null) hold("event_time");
    const issue = await ctx.issues.get(event.entityId, event.companyId);
    if (!issue || issue.companyId !== event.companyId || issue.id !== event.entityId
      || (typeof issue.originKind === "string" && issue.originKind.startsWith(`plugin:${PLUGIN_ID}:operation`))) hold("issue_identity");
    const space = await ownerCommentRawSpacePolicy(ctx, event.companyId, config.spaceSlug, config.issueIds)
      .catch(() => hold("space_policy"));
    const folder = await ctx.localFolders.status(event.companyId, WIKI_ROOT_FOLDER_KEY);
    if (!folder.configured || !folder.readable || !folder.writable || !folder.healthy || folder.access !== "readWrite") {
      hold("folder_unhealthy");
    }
    const first = exactComment(await ctx.issues.listComments(issue.id, event.companyId), commentId, event.companyId,
      issue, config.ownerUserId, occurredAt, config.maxBodyBytes);
    const rawPath = spaceRelativePath(space, `.paperclip/owner-comment-raw/${space.id}/${commentId}/${first.bodyHash}.txt`);
    const identity = {companyId: event.companyId, space, commentId, issueId: issue.id,
      owner: config.ownerUserId, bodyHash: first.bodyHash, updatedAt: first.updatedAt, path: rawPath,
      policyHash: config.policySha256};
    await ctx.db.execute(`INSERT INTO ${table(ctx)} (company_id,space_id,comment_id,issue_id,owner_user_id,
      body_sha256,comment_updated_at,raw_path,policy_sha256,status,metadata) VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10::jsonb)
      ON CONFLICT (company_id,space_id,comment_id) DO NOTHING`,
      [event.companyId, space.id, commentId, issue.id, config.ownerUserId, first.bodyHash, first.updatedAt,
        rawPath, config.policySha256, JSON.stringify({attribution:"host_user_attributed_no_run_markers",eventId:event.eventId,
          consentSnapshot:{classification:config.consentDecision,
            issueIds:config.issueIds,maxBodyBytes:config.maxBodyBytes,allowCompanyReaders:true}})]);
    let row = await getRow(ctx, event.companyId, space.id, commentId);
    if (!row || !rowMatches(row, identity)) hold("row_conflict");
    if (row.status === "pending") {
      await ctx.localFolders.createTextExclusive(event.companyId, WIKI_ROOT_FOLDER_KEY, rawPath, first.comment.body);
    }
    try { await readExactFile(ctx, event.companyId, rawPath, first.comment.body, first.bodyHash); }
    catch (error) {
      if (row.status === "verified" && !(error instanceof OwnerCommentRawHold)) hold("verified_file_unavailable");
      throw error;
    }
    const second = exactComment(await ctx.issues.listComments(issue.id, event.companyId), commentId, event.companyId,
      issue, config.ownerUserId, occurredAt, config.maxBodyBytes);
    if (second.bodyHash !== first.bodyHash || second.updatedAt !== first.updatedAt) hold("version_race");
    if (row.status === "pending") {
      await ctx.db.execute(`UPDATE ${table(ctx)} SET status='verified',updated_at=now() WHERE company_id=$1
        AND space_id=$2 AND comment_id=$3 AND body_sha256=$4 AND policy_sha256=$5 AND status='pending'`,
        [event.companyId,space.id,commentId,first.bodyHash,config.policySha256]);
    }
    row = await getRow(ctx, event.companyId, space.id, commentId);
    if (!row || row.status !== "verified" || !rowMatches(row, identity)) hold("final_row");
    try { await readExactFile(ctx, event.companyId, rawPath, first.comment.body, first.bodyHash); }
    catch (error) {
      if (!(error instanceof OwnerCommentRawHold)) hold("verified_file_unavailable");
      throw error;
    }
    await writeHealth(ctx, event, commentId, "verified", null);
    return "verified";
  } catch (error) {
    if (error instanceof OwnerCommentRawHold && error.code === "state_write_failed") throw error;
    if (error instanceof OwnerCommentRawHold) await noteHold(ctx, event, uuid(commentId) ? commentId : null, error.code);
    else { await notePending(ctx, event, uuid(commentId) ? commentId : null); throw new Error("owner_comment_raw_io_pending"); }
    throw error;
  }
}

export async function readOwnerCommentRaw(ctx: PluginContext, companyId: string, commentId: string) {
  if (!uuid(companyId) || !uuid(commentId)) hold("reader_identity");
  const config = parseConfig(await ctx.config.get(companyId));
  if (!config) hold("reader_disabled");
  const space = await ownerCommentRawSpacePolicy(ctx, companyId, config.spaceSlug, config.issueIds)
    .catch(() => hold("space_policy"));
  const row = await getRow(ctx, companyId, space.id, commentId);
  if (!row || row.status !== "verified" || !config.issueIds.includes(row.issue_id)
    || row.owner_user_id !== config.ownerUserId || row.policy_sha256 !== config.policySha256
    || !SHA.test(row.body_sha256) || row.raw_path !== spaceRelativePath(space,
      `.paperclip/owner-comment-raw/${space.id}/${commentId}/${row.body_sha256}.txt`)) hold("reader_row");
  const issue = await ctx.issues.get(row.issue_id, companyId);
  if (!issue || issue.companyId !== companyId || issue.id !== row.issue_id) hold("reader_issue");
  const comments = await ctx.issues.listComments(issue.id, companyId);
  const selected = comments.filter((comment) => comment.id === commentId);
  if (selected.length !== 1) hold("reader_comment");
  const body = selected[0]!.body;
  const created = dateMs(selected[0]!.createdAt);
  if (created === null) hold("reader_version");
  const current = exactComment(comments, commentId, companyId, issue, config.ownerUserId, created, config.maxBodyBytes);
  if (current.bodyHash !== row.body_sha256 || dateMs(current.updatedAt) !== dateMs(row.comment_updated_at)) hold("reader_version");
  await readExactFile(ctx, companyId, row.raw_path, body, row.body_sha256);
  return { companyId, commentId, issueId: issue.id, source: body, receipt: { status: "verified", bodySha256: row.body_sha256,
    bodyBytes: Buffer.byteLength(body,"utf8"), readbackAt: new Date().toISOString(), qa: false,
    companyAdoption: false, wikiPublished: false,
    commentUpdatedAt: current.updatedAt, attribution: "host_user_attributed_no_run_markers", rawPath: row.raw_path } };
}
