import { z } from "zod";
import { issueDocumentKeySchema } from "@paperclipai/shared";
import { conflict, forbidden } from "../errors.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";

const commentPageSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  afterCommentId: z.string().uuid().optional(),
}).strict();

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
] as const;

export const qaReviewToolDefinitions = [
  {
    name: QA_REVIEW_TOOL_NAMES[0],
    description: "Read the issue assigned to this live QA run, including its plan, work products, review stage, status version, and requirement revision. No issue ID can be supplied.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: QA_REVIEW_TOOL_NAMES[1],
    description: "Read the assigned issue's comments in ascending pages of 100 at the expected issue revision. Use the last returned comment ID as afterCommentId until a page is empty.",
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
];

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

function apiOrigin(input: QaToolInput) {
  return input.apiUrl.replace(/\/+$/, "").replace(/\/api$/, "");
}

async function issueApi(input: QaToolInput, method: "GET" | "PATCH", suffix: string, body?: object) {
  const response = await fetch(`${apiOrigin(input)}/api/issues/${input.issue.id}${suffix}`, {
    method,
    headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `QA issue request failed (${response.status})`);
  return result;
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
  const response = await fetch(`${apiOrigin(input)}/api/attachments/${attachment.id}/content`, {
    headers: { Authorization: `Bearer ${input.token}`, Range: `bytes=${args.offset}-${end}` },
    signal: AbortSignal.timeout(60_000),
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

/** Use the existing issue routes for authorization, redaction, activity and formal decisions. */
export async function callQaReviewTool(input: QaToolInput) {
  const stage = assertActiveQaParticipant(input.issue, input.agentId);
  if (input.name === QA_REVIEW_TOOL_NAMES[0]) {
    z.object({}).strict().parse(input.arguments);
    return issueApi(input, "GET", "");
  }
  if (input.name === QA_REVIEW_TOOL_NAMES[1]) {
    const args = commentPageSchema.parse(input.arguments);
    assertExpectedRevision(input, args.expectedRevision);
    const query = new URLSearchParams({ order: "asc", limit: "100" });
    if (args.afterCommentId) query.set("after", args.afterCommentId);
    const comments = await issueApi(input, "GET", `/comments?${query}`);
    return {
      comments,
      issueRevision: args.expectedRevision,
      nextAfterCommentId: Array.isArray(comments) && comments.length === 100 ? comments[99]?.id ?? null : null,
    };
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
  const comment = args.decision === "approve"
    ? `kind: review\ndecision: approved\nsummary: ${args.summary}`
    : `kind: review\ndecision: changes_requested\nsummary: ${args.summary}`;
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
  const next = parseIssueExecutionState(result.executionState);
  if (!next?.lastDecisionId || next.lastDecisionId === args.expectedLastDecisionId ||
      next.lastDecisionOutcome !== (args.decision === "approve" ? "approved" : "changes_requested")) {
    throw conflict("Decision response is unverified; inspect the issue before any retry");
  }
  return {
    issueId: input.issue.id,
    status: result.status,
    statusVersion: result.statusVersion,
    revision: result.revision,
    decisionId: next.lastDecisionId,
    decisionOutcome: next.lastDecisionOutcome,
    executionState: next,
  };
}
