import { request as directHttpRequest } from "node:http";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { issueExecutionDecisions, type Db } from "@paperclipai/db";
import { issueDocumentKeySchema } from "@paperclipai/shared";
import { conflict, forbidden } from "../errors.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";

const commentPageSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  afterCommentId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).default(100),
}).strict();

const commentTextPageSchema = z.object({
  commentId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative().max(10_000_000).default(0),
  limit: z.number().int().min(1).max(2_000).default(2_000),
}).strict();

const commentSourceSchema = z.object({
  id: z.string().uuid(), issueId: z.string().uuid(), body: z.string(),
  createdAt: z.string(), authorType: z.string().nullable(),
  authorAgentId: z.string().uuid().nullable(),
});

const descriptionPageSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative().max(10_000_000).default(0),
  limit: z.number().int().min(1).max(16_000).default(8_000),
}).strict();

const annotationPageSchema = z.object({
  key: issueDocumentKeySchema,
  expectedRevision: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative().max(1_000_000).default(0),
  limit: z.number().int().min(1).max(25).default(10),
}).strict();

const annotationTextPageSchema = z.object({
  key: issueDocumentKeySchema,
  threadId: z.string().uuid(),
  commentId: z.string().uuid().nullable(),
  field: z.enum(["selectedText", "body"]),
  expectedRevision: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative().max(10_000_000).default(0),
  limit: z.number().int().min(1).max(2_000).default(2_000),
}).strict();

const annotationThreadSchema = z.object({
  id: z.string().uuid(), issueId: z.string().uuid(), documentKey: z.string(),
  status: z.string(), anchorState: z.string(), selectedText: z.string(),
  comments: z.array(z.object({
    id: z.string().uuid(), threadId: z.string().uuid(), issueId: z.string().uuid(), body: z.string(),
  })),
});

const receiptSchema = z.object({
  expectedStageId: z.string().uuid(),
  decision: z.enum(["approve", "request_changes"]),
  summary: z.string().trim().min(1).max(10_000),
}).strict();

/** The QA subprocess is local; its run token must stay on the local listener. */
export function qaReviewLocalApiUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const host = env.PAPERCLIP_LISTEN_HOST?.trim().toLowerCase();
  const rawPort = env.PAPERCLIP_LISTEN_PORT?.trim() ?? "";
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  // The startup path replaces hostnames with server.address().address after
  // bind. A bare localhost value does not say which address family accepted
  // connections, so a QA bearer must not be sent to a guessed listener.
  if (host === "127.0.0.1" || host === "0.0.0.0") {
    return `http://127.0.0.1:${port}`;
  }
  if (host === "::1" || host === "::") return `http://[::1]:${port}`;
  return null;
}

const documentSummarySchema = z.object({
  id: z.string().uuid(), issueId: z.string().uuid(), key: z.string(),
  title: z.string().nullable(), format: z.string(),
  latestRevisionNumber: z.number().int().nonnegative(),
});

// The ordinary Issue GET is intentionally broad. Never pass its object or a
// nested object through to a QA subprocess: a relation, project, runtime
// workspace, or adapter override may include another task's private data.
const assignedIssueSourceSchema = z.object({
  id: z.string().uuid(), identifier: z.string(), title: z.string(),
  description: z.string().nullable(), status: z.string(), workMode: z.string(),
  statusVersion: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
  planDocument: documentSummarySchema.extend({ body: z.string() }).nullable(),
  legacyPlanDocument: z.object({ key: z.literal("plan"), body: z.string(), source: z.literal("issue_description") }).nullable(),
  documentSummaries: z.array(documentSummarySchema),
  workProducts: z.array(z.object({
    id: z.string().uuid(), issueId: z.string().uuid(), type: z.string(),
    provider: z.string(), title: z.string(), url: z.string().nullable(),
    status: z.string(), reviewState: z.string(), healthStatus: z.string(),
    isPrimary: z.boolean(),
  })),
});

const documentPageSchema = z.object({
  key: issueDocumentKeySchema,
  expectedRevision: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative().max(10_000_000).default(0),
  limit: z.number().int().min(1).max(16_000).default(8_000),
}).strict();

const attachmentListSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative().max(1_000_000).default(0),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();

const attachmentTextPageSchema = z.object({
  attachmentId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative().max(1_000_000_000).default(0),
  limit: z.number().int().min(4).max(16_384).default(8_192),
}).strict();

const reviewDecisionSchema = z.object({
  decision: z.enum(["approve", "request_changes"]),
  summary: z.string().trim().min(1).max(10_000),
  expectedStageId: z.string().uuid(),
  expectedStatusVersion: z.number().int().nonnegative(),
  expectedRevision: z.number().int().nonnegative(),
  expectedLastDecisionId: z.string().uuid().nullable(),
}).strict();

export const QA_REVIEW_MCP_NAME = "paperclip_qa";
export const QA_REVIEW_MCP_CONNECTION_ID = "paperclip-qa-review";
export const QA_REVIEW_TOOL_NAMES = [
  "read_assigned_issue",
  "list_assigned_issue_comments",
  "read_assigned_issue_document",
  "list_assigned_issue_attachments",
  "read_assigned_issue_attachment_text",
  "submit_review_decision",
  "read_assigned_issue_description",
  "list_assigned_issue_annotations",
  "read_assigned_review_receipt",
  "read_assigned_issue_comment",
  "read_assigned_issue_annotation_text",
] as const;

export const qaReviewToolDefinitions = [
  {
    name: QA_REVIEW_TOOL_NAMES[0],
    description: "Read bounded metadata for the assigned issue, document keys, work products, review stage, status version, and requirement revision. Page the issue description and every document body through their dedicated tools. No issue ID can be supplied.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: QA_REVIEW_TOOL_NAMES[1],
    description: "Read bounded, ascending pages of assigned-issue comments at the expected issue revision. Use nextAfterCommentId until null. If bodyOmitted is true, page that comment with read_assigned_issue_comment.",
    inputSchema: z.toJSONSchema(commentPageSchema),
  },
  {
    name: QA_REVIEW_TOOL_NAMES[2],
    description: "Read a bounded page of one document attached to the assigned issue at the expected issue revision. Discover keys in read_assigned_issue.documentSummaries; continue with nextOffset until null.",
    inputSchema: z.toJSONSchema(documentPageSchema),
  },
  {
    name: QA_REVIEW_TOOL_NAMES[3],
    description: "List bounded metadata pages for attachments on the assigned issue at the expected issue revision; object storage keys and content are never returned here.",
    inputSchema: z.toJSONSchema(attachmentListSchema),
  },
  {
    name: QA_REVIEW_TOOL_NAMES[4],
    description: "Read a bounded UTF-8 text page of an attachment listed on the assigned issue at the expected issue revision. Binary and invalid UTF-8 attachments require another evidence path; continue with nextOffset until null.",
    inputSchema: z.toJSONSchema(attachmentTextPageSchema),
  },
  {
    name: QA_REVIEW_TOOL_NAMES[5],
    description: "Record the current review-stage decision with a reason. Copy expectedStageId, expectedStatusVersion, expectedRevision and expectedLastDecisionId from read_assigned_issue. A request for changes returns the issue to its recorded assignee.",
    inputSchema: z.toJSONSchema(reviewDecisionSchema),
  },
  {
    name: QA_REVIEW_TOOL_NAMES[6],
    description: "Read a bounded page of the assigned issue description, including any legacy embedded plan, at the expected issue revision. Continue with nextOffset until null.",
    inputSchema: z.toJSONSchema(descriptionPageSchema),
  },
  {
    name: QA_REVIEW_TOOL_NAMES[7],
    description: "Read bounded pages of every annotation and comment on one assigned-issue document at the expected issue revision. Use status=all implicitly; continue with nextOffset until null. Page omitted selectedText or body with read_assigned_issue_annotation_text.",
    inputSchema: z.toJSONSchema(annotationPageSchema),
  },
  {
    name: QA_REVIEW_TOOL_NAMES[8],
    description: "After a verdict response is missing, read only this run's matching formal review decision. Supply the original stage, decision, and summary. A missing receipt is unknown; do not resend the verdict.",
    inputSchema: z.toJSONSchema(receiptSchema),
  },
  {
    name: QA_REVIEW_TOOL_NAMES[9],
    description: "Read a bounded Unicode text page of one comment on the assigned issue. Continue with nextOffset until null; use the same issue revision as the comment list.",
    inputSchema: z.toJSONSchema(commentTextPageSchema),
  },
  {
    name: QA_REVIEW_TOOL_NAMES[10],
    description: "Read a bounded Unicode text page of an omitted annotation selectedText or body. Use the document, thread and comment identifiers returned by list_assigned_issue_annotations, and continue with nextOffset until null.",
    inputSchema: z.toJSONSchema(annotationTextPageSchema),
  },
];

// The MCP route sends each result twice (structuredContent and content.text).
// Budget the actual UTF-8 serialization, including escaped JSON, before adding
// another item to a list. The remaining headroom covers the JSON-RPC id.
function fitsQaWire(value: unknown) {
  const text = JSON.stringify(value);
  return Buffer.byteLength(JSON.stringify({
    content: [{ type: "text", text }], structuredContent: value,
  }), "utf8") <= 56_000;
}

function textPage(body: string, offset: number, limit: number) {
  const characters = Array.from(body);
  if (offset > characters.length) throw conflict("Text offset is beyond the current body");
  const nextOffset = offset + limit < characters.length ? offset + limit : null;
  return { text: characters.slice(offset, offset + limit).join(""), offset,
    nextOffset, totalCharacters: characters.length };
}

export function assertActiveQaParticipant(issue: {
  status: string;
  assigneeAgentId: string | null;
  executionState: unknown;
}, agentId: string) {
  const stage = parseIssueExecutionState(issue.executionState);
  if (issue.status !== "in_review" || stage?.status !== "pending" ||
      stage.currentStageType !== "review" ||
      stage.currentParticipant?.type !== "agent" ||
      stage.currentParticipant.agentId !== agentId ||
      issue.assigneeAgentId !== agentId || !stage.currentStageId) {
    throw forbidden("QA tools require the current review-stage participant");
  }
  return stage;
}

type QaToolInput = {
  db: Db;
  runId: string;
  companyId: string;
  name: string;
  arguments: unknown;
  apiUrl: string;
  token: string;
  issue: {
    id: string;
    status: string;
    statusVersion: number;
    revision: number;
    assigneeAgentId: string | null;
    executionState: unknown;
  };
  agentId: string;
};

export async function hasOwnQaDecision(db: Db, input: {
  companyId: string; issueId: string; agentId: string; runId: string;
}) {
  const [decision] = await db.select({ id: issueExecutionDecisions.id })
    .from(issueExecutionDecisions).where(and(
      eq(issueExecutionDecisions.companyId, input.companyId),
      eq(issueExecutionDecisions.issueId, input.issueId),
      eq(issueExecutionDecisions.actorAgentId, input.agentId),
      eq(issueExecutionDecisions.createdByRunId, input.runId),
      eq(issueExecutionDecisions.stageType, "review"),
    )).limit(1);
  return Boolean(decision);
}

function apiOrigin(input: QaToolInput) {
  return input.apiUrl.replace(/\/+$/, "").replace(/\/api$/, "");
}

/** Keep a run JWT on the numeric loopback listener even with Node env proxies. */
function directQaApiRequest(input: QaToolInput, path: string, options: {
  method?: "GET" | "PATCH";
  body?: string;
  range?: string;
  maxBytes?: number;
} = {}): Promise<Response> {
  const url = new URL(path, `${apiOrigin(input)}/`);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "[::ffff:127.0.0.1]"].includes(url.hostname) ||
      url.username || url.password || url.hash || !url.pathname.startsWith("/api/")) {
    throw forbidden("QA local API listener is invalid");
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${input.token}` };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.range !== undefined) headers.Range = options.range;
  const maxBytes = options.maxBytes ?? 16_000_000;
  return new Promise<Response>((resolve, reject) => {
    // agent:false creates a private direct Agent. In particular, it does not
    // reuse http.globalAgent when Node --use-env-proxy has configured it.
    const req = directHttpRequest(url, {
      method: options.method ?? "GET", headers, agent: false,
      signal: AbortSignal.timeout(60_000),
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > maxBytes) {
          res.destroy(new Error("QA local API response exceeds the size limit"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        const status = res.statusCode;
        if (status === undefined) return reject(new Error("QA local API response has no status"));
        const responseHeaders = new Headers();
        for (const name of ["content-type", "content-range"] as const) {
          const value = res.headers[name];
          if (typeof value === "string") responseHeaders.set(name, value);
        }
        resolve(new Response(size === 0 ? null : Buffer.concat(chunks), {
          status, headers: responseHeaders,
        }));
      });
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

async function issueApi(input: QaToolInput, method: "GET" | "PATCH", suffix: string, body?: object) {
  let response: Response;
  try {
    response = await directQaApiRequest(input, `/api/issues/${input.issue.id}${suffix}`, {
      method, ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    if (method === "PATCH") throw new QaDecisionOutcomeUnknownError("QA decision transport failed", { cause: error });
    throw error;
  }
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    const reason = result && typeof result.error === "string" ? result.error : `QA issue request failed (${response.status})`;
    // A server failure or gateway timeout can be emitted after the transition
    // committed. Only explicit client/precondition rejection is definite.
    if (method === "PATCH" && (response.status >= 500 || response.status === 408 || response.status === 429)) {
      throw new QaDecisionOutcomeUnknownError(reason);
    }
    throw new Error(reason);
  }
  let result;
  try { result = await response.json(); }
  catch (error) {
    if (method === "PATCH") throw new QaDecisionOutcomeUnknownError("QA decision response could not be parsed", { cause: error });
    throw error;
  }
  return result;
}

export class QaDecisionOutcomeUnknownError extends Error {
  override name = "QaDecisionOutcomeUnknownError";
}

type QaAttachment = {
  id: string;
  issueId: string;
  originalFilename: string | null;
  contentType: string;
  byteSize: number;
  sha256: string;
  createdAt: string;
};

async function assignedAttachments(input: QaToolInput): Promise<QaAttachment[]> {
  const result = await issueApi(input, "GET", "/attachments");
  if (!Array.isArray(result) || result.some((entry) =>
    !entry || entry.issueId !== input.issue.id || typeof entry.id !== "string" ||
    typeof entry.contentType !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.byteSize) ||
    entry.byteSize < 0
  )) throw conflict("Assigned issue attachment list is invalid");
  return result.map((entry) => ({
    id: entry.id,
    issueId: entry.issueId,
    originalFilename: typeof entry.originalFilename === "string" ? entry.originalFilename : null,
    contentType: entry.contentType,
    byteSize: entry.byteSize,
    sha256: entry.sha256,
    createdAt: entry.createdAt,
  }));
}

function isReadableTextType(value: string) {
  const type = value.split(";", 1)[0]!.trim().toLowerCase();
  return type.startsWith("text/") || ["application/json", "application/xml", "application/x-ndjson"].includes(type);
}

async function readAssignedAttachmentText(input: QaToolInput, args: z.infer<typeof attachmentTextPageSchema>) {
  assertExpectedRevision(input, args.expectedRevision);
  const attachment = (await assignedAttachments(input)).find((item) => item.id === args.attachmentId);
  if (!attachment) throw forbidden("Attachment is not on the assigned issue");
  if (!isReadableTextType(attachment.contentType)) throw conflict("Binary attachment content is not readable by the QA text tool");
  if (args.offset > attachment.byteSize) throw conflict("Attachment offset is beyond the current content");
  if (args.offset === attachment.byteSize) return { attachmentId: attachment.id, issueRevision: args.expectedRevision, sha256: attachment.sha256, text: "", offset: args.offset, nextOffset: null, totalBytes: attachment.byteSize };
  const end = Math.min(attachment.byteSize - 1, args.offset + args.limit + 2);
  const response = await directQaApiRequest(input, `/api/attachments/${attachment.id}/content`, {
    range: `bytes=${args.offset}-${end}`, maxBytes: 64_000,
  });
  if (response.status !== 206 || !isReadableTextType(response.headers.get("content-type") ?? "") ||
      response.headers.get("content-range") !== `bytes ${args.offset}-${end}/${attachment.byteSize}`) {
    await response.body?.cancel();
    throw conflict("Attachment content range or type could not be verified");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== end - args.offset + 1) throw conflict("Attachment content length changed during read");
  let usedBytes = Math.min(args.limit, bytes.byteLength);
  let text = "";
  for (; usedBytes > 0; usedBytes -= 1) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, usedBytes));
      break;
    } catch {
      // Back off an incomplete final code point. A malformed start fails below.
    }
  }
  if (usedBytes === 0) throw conflict("Attachment is not valid UTF-8 at this offset");
  const nextOffset = args.offset + usedBytes < attachment.byteSize ? args.offset + usedBytes : null;
  return { attachmentId: attachment.id, issueRevision: args.expectedRevision, sha256: attachment.sha256, text, offset: args.offset, nextOffset, totalBytes: attachment.byteSize };
}

function assertExpectedRevision(input: QaToolInput, expectedRevision: number) {
  if (input.issue.revision !== expectedRevision) {
    throw conflict("Issue revision changed during QA evidence read; read the issue again");
  }
}

function projectAssignedIssue(input: QaToolInput, raw: unknown, stage: ReturnType<typeof assertActiveQaParticipant>) {
  const issue = assignedIssueSourceSchema.parse(raw);
  if (issue.id !== input.issue.id || issue.revision !== input.issue.revision ||
      issue.documentSummaries.some((doc) => doc.issueId !== input.issue.id) ||
      (issue.planDocument && issue.planDocument.issueId !== input.issue.id) ||
      issue.workProducts.some((product) => product.issueId !== input.issue.id)) {
    throw conflict("Assigned issue projection changed or contains another issue");
  }
  const projection = {
    id: issue.id, identifier: issue.identifier, title: issue.title,
    descriptionCharacters: Array.from(issue.description ?? "").length,
    status: issue.status, workMode: issue.workMode,
    statusVersion: issue.statusVersion, revision: issue.revision,
    reviewStage: { stageId: stage.currentStageId, lastDecisionId: stage.lastDecisionId },
    planDocument: issue.planDocument ? {
      id: issue.planDocument.id, key: issue.planDocument.key,
      title: issue.planDocument.title, format: issue.planDocument.format,
      latestRevisionNumber: issue.planDocument.latestRevisionNumber,
      bodyCharacters: Array.from(issue.planDocument.body).length,
    } : null,
    legacyPlanDocument: issue.legacyPlanDocument ? {
      key: "plan", source: "issue_description",
      bodyCharacters: Array.from(issue.legacyPlanDocument.body).length,
    } : null,
    documentSummaries: issue.documentSummaries.map((doc) => ({
      id: doc.id, key: doc.key, title: doc.title, format: doc.format,
      latestRevisionNumber: doc.latestRevisionNumber,
    })),
    workProducts: issue.workProducts.map((product) => ({
      id: product.id, type: product.type, provider: product.provider,
      title: product.title, url: product.url, status: product.status,
      reviewState: product.reviewState, healthStatus: product.healthStatus,
      isPrimary: product.isPrimary,
    })),
  };
  if (Buffer.byteLength(JSON.stringify(projection), "utf8") > 16_000) {
    throw conflict("Assigned issue metadata exceeds the QA overview size; use human review");
  }
  return projection;
}

function reviewComment(decision: "approve" | "request_changes", summary: string) {
  return decision === "approve"
    ? `kind: review\ndecision: approved\nsummary: ${summary}`
    : `kind: review\ndecision: changes_requested\nsummary: ${summary}`;
}

async function readAssignedReviewReceipt(input: QaToolInput) {
  const args = receiptSchema.parse(input.arguments);
  const [row] = await input.db.select({
    id: issueExecutionDecisions.id, stageId: issueExecutionDecisions.stageId,
    outcome: issueExecutionDecisions.outcome, createdAt: issueExecutionDecisions.createdAt,
  }).from(issueExecutionDecisions).where(and(
    eq(issueExecutionDecisions.companyId, input.companyId),
    eq(issueExecutionDecisions.issueId, input.issue.id),
    eq(issueExecutionDecisions.actorAgentId, input.agentId),
    eq(issueExecutionDecisions.createdByRunId, input.runId),
    eq(issueExecutionDecisions.stageId, args.expectedStageId),
    eq(issueExecutionDecisions.stageType, "review"),
    eq(issueExecutionDecisions.outcome, args.decision === "approve" ? "approved" : "changes_requested"),
    eq(issueExecutionDecisions.body, reviewComment(args.decision, args.summary)),
  )).limit(1);
  return row ? { recorded: true, issueId: input.issue.id, stageId: row.stageId,
    decisionId: row.id, decisionOutcome: row.outcome, createdAt: row.createdAt } :
    { recorded: false, issueId: input.issue.id, stageId: args.expectedStageId };
}

/** Use the existing issue routes for authorization, redaction, activity and formal decisions. */
export async function callQaReviewTool(input: QaToolInput) {
  if (input.name === QA_REVIEW_TOOL_NAMES[8]) return readAssignedReviewReceipt(input);
  const stage = assertActiveQaParticipant(input.issue, input.agentId);
  if (input.name === QA_REVIEW_TOOL_NAMES[9]) {
    const args = commentTextPageSchema.parse(input.arguments);
    assertExpectedRevision(input, args.expectedRevision);
    const raw = await issueApi(input, "GET", `/comments/${args.commentId}`);
    const comment = commentSourceSchema.parse(raw);
    if (comment.id !== args.commentId || comment.issueId !== input.issue.id) {
      throw conflict("Assigned issue comment could not be verified");
    }
    return { commentId: comment.id, issueRevision: args.expectedRevision,
      ...textPage(comment.body, args.offset, args.limit) };
  }
  if (input.name === QA_REVIEW_TOOL_NAMES[0]) {
    z.object({}).strict().parse(input.arguments);
    return projectAssignedIssue(input, await issueApi(input, "GET", ""), stage);
  }
  if (input.name === QA_REVIEW_TOOL_NAMES[6]) {
    const args = descriptionPageSchema.parse(input.arguments);
    assertExpectedRevision(input, args.expectedRevision);
    const issue = assignedIssueSourceSchema.parse(await issueApi(input, "GET", ""));
    if (issue.id !== input.issue.id || issue.revision !== args.expectedRevision) {
      throw conflict("Assigned issue changed during description read");
    }
    const characters = Array.from(issue.description ?? "");
    if (args.offset > characters.length) throw conflict("Description offset is beyond the current body");
    const nextOffset = args.offset + args.limit < characters.length ? args.offset + args.limit : null;
    return { issueId: issue.id, issueRevision: args.expectedRevision,
      body: characters.slice(args.offset, args.offset + args.limit).join(""),
      offset: args.offset, nextOffset, totalCharacters: characters.length };
  }
  if (input.name === QA_REVIEW_TOOL_NAMES[7]) {
    const args = annotationPageSchema.parse(input.arguments);
    assertExpectedRevision(input, args.expectedRevision);
    const raw = await issueApi(input, "GET", `/documents/${encodeURIComponent(args.key)}/annotations?status=all&includeComments=true`);
    const threads = z.array(annotationThreadSchema).parse(raw);
    if (threads.some((thread) => thread.issueId !== input.issue.id || thread.documentKey !== args.key ||
        thread.comments.some((comment) => comment.issueId !== input.issue.id || comment.threadId !== thread.id))) {
      throw conflict("Assigned issue annotations contain another issue or document");
    }
    const entries = threads.flatMap((thread): Array<{ threadId: string; status: string; anchorState: string;
      selectedText: string; commentId: string | null; body: string | null }> => thread.comments.length > 0
      ? thread.comments.map((comment) => ({ threadId: thread.id, status: thread.status,
        anchorState: thread.anchorState, selectedText: thread.selectedText,
        commentId: comment.id, body: comment.body }))
      : [{ threadId: thread.id, status: thread.status, anchorState: thread.anchorState,
        selectedText: thread.selectedText, commentId: null, body: null }]);
    if (args.offset > entries.length) throw conflict("Annotation offset is beyond the current page set");
    const page: Array<{ threadId: string; status: string; anchorState: string;
      selectedText: string; commentId: string | null; body: string | null;
      selectedTextCharacters: number; bodyCharacters: number;
      selectedTextOmitted: boolean; bodyOmitted: boolean }> = [];
    for (const entry of entries.slice(args.offset, args.offset + args.limit)) {
      const projected = { ...entry,
        selectedTextCharacters: Array.from(entry.selectedText).length,
        bodyCharacters: Array.from(entry.body ?? "").length,
        selectedTextOmitted: false, bodyOmitted: false };
      const candidate = () => ({ key: args.key, issueRevision: args.expectedRevision,
        annotations: [...page, projected], offset: args.offset, nextOffset: null, total: entries.length });
      if (!fitsQaWire(candidate())) {
        projected.body = null;
        projected.bodyOmitted = entry.body !== null;
      }
      if (!fitsQaWire(candidate())) {
        projected.selectedText = "";
        projected.selectedTextOmitted = true;
      }
      if (!fitsQaWire(candidate())) break;
      page.push(projected);
    }
    if (page.length === 0 && args.offset < entries.length) throw conflict("Annotation metadata exceeds the QA page size; use human review");
    const nextOffset = args.offset + page.length < entries.length ? args.offset + page.length : null;
    return { key: args.key, issueRevision: args.expectedRevision, annotations: page,
      offset: args.offset, nextOffset, total: entries.length };
  }
  if (input.name === QA_REVIEW_TOOL_NAMES[1]) {
    const args = commentPageSchema.parse(input.arguments);
    assertExpectedRevision(input, args.expectedRevision);
    const query = new URLSearchParams({ order: "asc", limit: String(args.limit) });
    if (args.afterCommentId) query.set("after", args.afterCommentId);
    const comments = z.array(commentSourceSchema).parse(await issueApi(input, "GET", `/comments?${query}`));
    if (comments.some((comment) => comment.issueId !== input.issue.id)) {
      throw conflict("Assigned issue comment page contains another issue");
    }
    const page: Array<{ id: string; body: string; createdAt: string;
      authorType: string | null; authorAgentId: string | null;
      bodyCharacters: number; bodyOmitted: boolean }> = [];
    for (const comment of comments) {
      const projected = {
        id: comment.id, body: comment.body, createdAt: comment.createdAt,
        authorType: comment.authorType, authorAgentId: comment.authorAgentId,
        bodyCharacters: Array.from(comment.body).length, bodyOmitted: false,
      };
      const candidate = () => ({ comments: [...page, projected], issueRevision: args.expectedRevision,
        nextAfterCommentId: null });
      if (!fitsQaWire(candidate())) {
        projected.body = "";
        projected.bodyOmitted = true;
      }
      if (!fitsQaWire(candidate())) break;
      page.push(projected);
    }
    if (page.length === 0 && comments.length > 0) throw conflict("Comment metadata exceeds the QA page size; use human review");
    return {
      comments: page,
      issueRevision: args.expectedRevision,
      nextAfterCommentId: page.length > 0 && (page.length < comments.length || comments.length === args.limit)
        ? page[page.length - 1]!.id : null,
    };
  }
  if (input.name === QA_REVIEW_TOOL_NAMES[10]) {
    const args = annotationTextPageSchema.parse(input.arguments);
    assertExpectedRevision(input, args.expectedRevision);
    const raw = await issueApi(input, "GET", `/documents/${encodeURIComponent(args.key)}/annotations?status=all&includeComments=true`);
    const threads = z.array(annotationThreadSchema).parse(raw);
    if (threads.some((thread) => thread.issueId !== input.issue.id || thread.documentKey !== args.key ||
        thread.comments.some((comment) => comment.issueId !== input.issue.id || comment.threadId !== thread.id))) {
      throw conflict("Assigned issue annotations contain another issue or document");
    }
    const thread = threads.find((item) => item.id === args.threadId);
    if (!thread) throw forbidden("Annotation is not on the assigned issue document");
    const body = args.field === "selectedText" ? thread.selectedText :
      thread.comments.find((item) => item.id === args.commentId)?.body;
    if (body === undefined || (args.field === "body" && args.commentId === null)) {
      throw forbidden("Annotation text is not on the assigned issue document");
    }
    return { key: args.key, threadId: args.threadId, commentId: args.commentId,
      field: args.field, issueRevision: args.expectedRevision, ...textPage(body, args.offset, args.limit) };
  }
  if (input.name === QA_REVIEW_TOOL_NAMES[2]) {
    const args = documentPageSchema.parse(input.arguments);
    assertExpectedRevision(input, args.expectedRevision);
    const doc = await issueApi(input, "GET", `/documents/${encodeURIComponent(args.key)}?includeAnnotations=false`);
    if (!doc || doc.issueId !== input.issue.id || doc.key !== args.key || typeof doc.body !== "string") {
      throw conflict("Assigned issue document could not be verified");
    }
    const characters = Array.from(doc.body);
    if (args.offset > characters.length) throw conflict("Document offset is beyond the current body");
    const nextOffset = args.offset + args.limit < characters.length ? args.offset + args.limit : null;
    return {
      key: doc.key, title: doc.title, format: doc.format,
      issueRevision: args.expectedRevision,
      body: characters.slice(args.offset, args.offset + args.limit).join(""),
      offset: args.offset, nextOffset, totalCharacters: characters.length,
      latestRevisionNumber: doc.latestRevisionNumber,
    };
  }
  if (input.name === QA_REVIEW_TOOL_NAMES[3]) {
    const args = attachmentListSchema.parse(input.arguments);
    assertExpectedRevision(input, args.expectedRevision);
    const attachments = await assignedAttachments(input);
    const nextOffset = args.offset + args.limit < attachments.length ? args.offset + args.limit : null;
    return { attachments: attachments.slice(args.offset, args.offset + args.limit), issueRevision: args.expectedRevision, offset: args.offset, nextOffset, total: attachments.length };
  }
  if (input.name === QA_REVIEW_TOOL_NAMES[4]) {
    return readAssignedAttachmentText(input, attachmentTextPageSchema.parse(input.arguments));
  }
  if (input.name !== QA_REVIEW_TOOL_NAMES[5]) throw forbidden("Unknown QA review tool");
  const args = reviewDecisionSchema.parse(input.arguments);
  if (stage.currentStageId !== args.expectedStageId ||
      input.issue.statusVersion !== args.expectedStatusVersion ||
      input.issue.revision !== args.expectedRevision ||
      stage.lastDecisionId !== args.expectedLastDecisionId) {
    throw conflict("Issue revision or review stage changed; read the issue again before deciding");
  }
  const comment = reviewComment(args.decision, args.summary);
  const result = await issueApi(input, "PATCH", "", {
    status: args.decision === "approve" ? "done" : "in_progress",
    comment,
    qaReviewExpected: {
      stageId: args.expectedStageId,
      statusVersion: args.expectedStatusVersion,
      revision: args.expectedRevision,
      lastDecisionId: args.expectedLastDecisionId,
    },
  });
  let verified: { status: string; statusVersion: number; revision: number; executionState: unknown };
  try {
    verified = z.object({ status: z.string(), statusVersion: z.number().int(),
      revision: z.number().int(), executionState: z.unknown() }).parse(result);
  } catch (error) {
    throw new QaDecisionOutcomeUnknownError("Decision response could not be verified", { cause: error });
  }
  const next = parseIssueExecutionState(verified.executionState);
  if (!next?.lastDecisionId || next.lastDecisionId === args.expectedLastDecisionId ||
      next.lastDecisionOutcome !== (args.decision === "approve" ? "approved" : "changes_requested")) {
    throw new QaDecisionOutcomeUnknownError("Decision response is unverified");
  }
  return {
    issueId: input.issue.id,
    status: verified.status,
    statusVersion: verified.statusVersion,
    revision: verified.revision,
    decisionId: next.lastDecisionId,
    decisionOutcome: next.lastDecisionOutcome,
    executionState: next,
  };
}
