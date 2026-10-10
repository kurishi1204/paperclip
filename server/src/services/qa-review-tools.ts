import { z } from "zod";
import { conflict, forbidden } from "../errors.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";

const commentPageSchema = z.object({
  afterCommentId: z.string().uuid().optional(),
}).strict();

const reviewDecisionSchema = z.object({
  decision: z.enum(["approve", "request_changes"]),
  summary: z.string().trim().min(1).max(10_000),
  expectedStageId: z.string().uuid(),
  expectedStatusVersion: z.number().int().nonnegative(),
  expectedLastDecisionId: z.string().uuid().nullable(),
}).strict();

export const QA_REVIEW_MCP_NAME = "paperclip_qa";
export const QA_REVIEW_MCP_CONNECTION_ID = "paperclip-qa-review";
export const QA_REVIEW_TOOL_NAMES = [
  "read_assigned_issue",
  "list_assigned_issue_comments",
  "submit_review_decision",
] as const;

export const qaReviewToolDefinitions = [
  {
    name: QA_REVIEW_TOOL_NAMES[0],
    description: "Read the issue assigned to this live QA run, including its plan, work products, review stage and version. No issue ID can be supplied.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: QA_REVIEW_TOOL_NAMES[1],
    description: "Read the assigned issue's comments in ascending pages of 100. Use the last returned comment ID as afterCommentId until a page is empty.",
    inputSchema: z.toJSONSchema(commentPageSchema),
  },
  {
    name: QA_REVIEW_TOOL_NAMES[2],
    description: "Record the current review-stage decision with a reason. Copy expectedStageId, expectedStatusVersion and expectedLastDecisionId from read_assigned_issue. A request for changes returns the issue to its recorded assignee.",
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
    assigneeAgentId: string | null;
    executionState: unknown;
  };
  agentId: string;
};

async function issueApi(input: QaToolInput, method: "GET" | "PATCH", suffix: string, body?: object) {
  const response = await fetch(`${input.apiUrl.replace(/\/+$/, "").replace(/\/api$/, "")}/api/issues/${input.issue.id}${suffix}`, {
    method,
    headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `QA issue request failed (${response.status})`);
  return result;
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
    const query = new URLSearchParams({ order: "asc", limit: "100" });
    if (args.afterCommentId) query.set("after", args.afterCommentId);
    const comments = await issueApi(input, "GET", `/comments?${query}`);
    return {
      comments,
      nextAfterCommentId: Array.isArray(comments) && comments.length === 100 ? comments[99]?.id ?? null : null,
    };
  }
  if (input.name !== QA_REVIEW_TOOL_NAMES[2]) throw forbidden("Unknown QA review tool");
  const args = reviewDecisionSchema.parse(input.arguments);
  if (stage.currentStageId !== args.expectedStageId ||
      input.issue.statusVersion !== args.expectedStatusVersion ||
      stage.lastDecisionId !== args.expectedLastDecisionId) {
    throw conflict("Review stage changed; read the issue again before deciding");
  }
  const comment = args.decision === "approve"
    ? `kind: review\ndecision: approved\nsummary: ${args.summary}`
    : `kind: review\ndecision: changes_requested\nsummary: ${args.summary}`;
  const result = await issueApi(input, "PATCH", "", {
    status: args.decision === "approve" ? "done" : "in_progress",
    comment,
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
    decisionId: next.lastDecisionId,
    decisionOutcome: next.lastDecisionOutcome,
    executionState: next,
  };
}
