import { issueDocumentKeySchema, upsertIssueDocumentSchema, projectDiscoverySchema, createProjectSchema, createIssueSchema, setIssueTitleSchema } from "@paperclipai/shared";
import { z } from "zod";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../vendor/paperclip-runner/index.js";
import { badRequest } from "../errors.js";

export const PROJECT_TOOL_NAMES = ["create_project", "list_project_repositories", "list_projects"];
export { SELF_TASK_DOCUMENT_CONTEXT_KEY } from "./self-task-document-runtime.js";
const readSelfTaskSchema = z.object({ key: issueDocumentKeySchema, revisionId: z.string().uuid().optional() }).strict();
const writeSelfTaskSchema = upsertIssueDocumentSchema.extend({
  key: issueDocumentKeySchema,
  documentId: z.string().uuid().nullable(),
  baseRevisionId: z.string().uuid().nullable(),
  input: z.object({ key: issueDocumentKeySchema, documentId: z.string().uuid(), revisionId: z.string().uuid(),
    bodySha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
}).strict();

/** Reuse the catalog's dedicated document work-mode policy. */
export function selfTaskDocumentModeAllowed(workMode: string, write: boolean) {
  return CAPABILITY_SEMANTIC_TOOL_CATALOG.find(tool => tool.operationId === (write ? "write_document" : "read_document"))
    ?.allowedModes.includes(workMode as "standard") ?? false;
}

export function projectToolDefinitions(workMode: string, includeTask = false, selfTaskOnly = false) {
  const definitions: { name: string; description: string; inputSchema: z.core.JSONSchema.BaseSchema | (typeof CAPABILITY_SEMANTIC_TOOL_CATALOG)[number]["inputSchema"] }[] = CAPABILITY_SEMANTIC_TOOL_CATALOG.filter(tool =>
    !selfTaskOnly && (PROJECT_TOOL_NAMES.includes(tool.operationId) || includeTask && ["create_task", "set_task_title"].includes(tool.operationId))
    && tool.allowedModes.includes(workMode as "standard"),
  ).map(tool => ({ name: tool.operationId, description: tool.description,
    inputSchema: tool.operationId === "create_project"
      ? z.toJSONSchema(createProjectSchema.extend({ idempotencyKey: z.string().min(1).max(255) }))
      : tool.inputSchema,
  }));
  if (selfTaskOnly && selfTaskDocumentModeAllowed(workMode, false)) definitions.push({
    name: "read_self_task_document", description: "Read a current or fixed document revision on this run's task.",
    inputSchema: z.toJSONSchema(readSelfTaskSchema, { io: "input" }),
  });
  if (selfTaskOnly && selfTaskDocumentModeAllowed(workMode, true)) definitions.push({
    name: "write_self_task_document", description: "Save one fixed-input revision to this run's task; never replay an unknown write.",
    inputSchema: z.toJSONSchema(writeSelfTaskSchema, { io: "input" }),
  });
  return definitions;
}

/** All transports use the normal authenticated API, including its validation and audit path. */
export async function callProjectTool(input: {
  name: string; arguments: Record<string, unknown>; apiUrl: string; token: string;
  companyId: string; issueId: string; agentId: string; conversation: boolean;
}) {
  if (input.name === "read_self_task_document" || input.name === "write_self_task_document") {
    return callSelfTaskDocumentTool(input);
  }
  const args = input.arguments;
  const page = input.name === "list_projects" ? projectDiscoverySchema.parse(args) : null;
  let path = `/companies/${input.companyId}/projects`;
  let body: unknown;
  if (input.name === "set_task_title") {
    path = `/issues/${input.issueId}/title`;
    body = setIssueTitleSchema.parse(args);
  } else if (input.name === "list_project_repositories") path = `/companies/${input.companyId}/project-repositories`;
  else if (page) {
    const query = new URLSearchParams({ view: "summary", limit: String(page.limit) });
    if (page.cursor) query.set("cursor", page.cursor);
    path += `?${query}`;
  }
  else if (input.name === "create_project") {
    body = createProjectSchema.extend({ idempotencyKey: z.string().min(1).max(255) }).parse(args);
  } else if (input.name === "create_task") {
    const key = z.string().min(1).max(150).parse(args.idempotencyKey);
    path = `/companies/${input.companyId}/issues`;
    body = createIssueSchema.parse({
      title: args.title, description: args.description, priority: args.priority,
      projectId: args.projectId, initialPlan: args.initialPlan,
      assigneeAgentId: args.assigneeActorId ?? input.agentId,
      parentId: input.conversation ? null : input.issueId,
      status: Array.isArray(args.blockedByTaskIds) && args.blockedByTaskIds.length ? "blocked" : "todo",
      blockedByIssueIds: args.blockedByTaskIds,
      idempotencyKey: `chat-handoff:${input.issueId}:${key}`,
    });
  } else throw badRequest("Unknown project tool");
  const response = await fetch(`${input.apiUrl.replace(/\/+$/, "").replace(/\/api$/, "")}/api${path}`, {
    method: input.name === "set_task_title" ? "PUT" : body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `Project tool failed (${response.status})`);
  return result;
}
import { createHash } from "node:crypto";

type DocumentToolInput = Parameters<typeof callProjectTool>[0];
const currentDocumentSchema = z.object({
  id: z.string().uuid(), companyId: z.string().uuid(), issueId: z.string().uuid(), key: issueDocumentKeySchema,
  body: z.string(), latestRevisionId: z.string().uuid(), latestRevisionNumber: z.number().int().positive(),
}).passthrough();
const historicalRevisionSchema = z.object({
  id: z.string().uuid(), companyId: z.string().uuid(), issueId: z.string().uuid(), key: issueDocumentKeySchema,
  documentId: z.string().uuid(), body: z.string(), revisionNumber: z.number().int().positive(),
}).passthrough();

function digest(body: string) {
  return createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
}

/** One PUT maximum. A missing acknowledgement after PUT is unknown, never a reason to replay. */
async function callSelfTaskDocumentTool(input: DocumentToolInput) {
  let stage = "validate";
  let putAttempted = false;
  const requests = { reads: 0, puts: 0, readbacks: 0 };
  const result = (outcome: "verified" | "rejected" | "unknown" | "mismatch", details: Record<string, unknown>) =>
    ({ outcome, stage, taskId: input.issueId, requests: { ...requests }, ...details });
  const request = async (key: string, method: "GET" | "PUT", body?: unknown, revisions = false, expectedDocumentId?: string | null) => {
    const response = await fetch(`${input.apiUrl.replace(/\/+$/, "").replace(/\/api$/, "")}/api/issues/${input.issueId}/documents/${encodeURIComponent(key)}${revisions ? "/revisions" : ""}`, {
      method, redirect: "manual", signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json",
        "X-Paperclip-Document-Mode": "self-task",
        ...(expectedDocumentId === undefined ? {} : { "X-Paperclip-Expected-Document-Id": expectedDocumentId ?? "new" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: unknown = null;
    try { json = await response.json(); } catch { /* An absent receipt is unknown after PUT. */ }
    return { response, json };
  };
  try {
    if (input.name === "read_self_task_document") {
      const args = readSelfTaskSchema.parse(input.arguments);
      stage = "read"; requests.reads++;
      const read = await request(args.key, "GET", undefined, Boolean(args.revisionId));
      if (!read.response.ok || read.response.redirected || read.response.status !== 200)
        return result("rejected", { status: read.response.status, reason: "Document read was refused" });
      if (args.revisionId) {
        const parsed = z.array(historicalRevisionSchema).safeParse(read.json);
        if (!parsed.success) return result("unknown", { reason: "Malformed revision response" });
        const revision = parsed.data.find(row => row.id === args.revisionId);
        if (!revision) return result("rejected", { status: 404, reason: "Revision unavailable" });
        if (revision.issueId !== input.issueId || revision.companyId !== input.companyId || revision.key !== args.key)
          return result("mismatch", { reason: "Revision is not on this task" });
        return result("verified", { key: args.key, documentId: revision.documentId, revisionId: revision.id,
          revisionNumber: revision.revisionNumber, body: revision.body, bodySha256: digest(revision.body) });
      }
      const parsed = currentDocumentSchema.safeParse(read.json);
      if (!parsed.success) return result("unknown", { reason: "Malformed current document response" });
      if (parsed.data.issueId !== input.issueId || parsed.data.companyId !== input.companyId || parsed.data.key !== args.key)
        return result("mismatch", { reason: "Document is not on this task" });
      return result("verified", { key: args.key, documentId: parsed.data.id, revisionId: parsed.data.latestRevisionId,
        revisionNumber: parsed.data.latestRevisionNumber, body: parsed.data.body, bodySha256: digest(parsed.data.body) });
    }
    const args = writeSelfTaskSchema.parse(input.arguments);
    if ((args.documentId === null) !== (args.baseRevisionId === null))
      return result("rejected", { reason: "Document ID and base revision must both be null or both be fixed" });
    stage = "input"; requests.reads++;
    const inputRevision = await request(args.input.key, "GET", undefined, true);
    if (!inputRevision.response.ok || inputRevision.response.redirected || inputRevision.response.status !== 200)
      return result("rejected", { status: inputRevision.response.status, reason: "Fixed input unavailable" });
    const revisions = z.array(historicalRevisionSchema).safeParse(inputRevision.json);
    if (!revisions.success) return result("unknown", { reason: "Malformed fixed input response" });
    const revision = revisions.data.find(row => row.id === args.input.revisionId);
    if (!revision) return result("rejected", { status: 404, reason: "Fixed input revision unavailable" });
    if (revision.issueId !== input.issueId || revision.companyId !== input.companyId || revision.key !== args.input.key ||
        revision.documentId !== args.input.documentId || digest(revision.body) !== args.input.bodySha256)
      return result("mismatch", { reason: "Fixed input identity or digest mismatch" });
    stage = "put"; putAttempted = true; requests.puts++;
    const saved = await request(args.key, "PUT", { title: args.title, format: args.format, body: args.body,
      changeSummary: args.changeSummary, baseRevisionId: args.baseRevisionId }, false, args.documentId);
    if (!saved.response.ok || saved.response.redirected) return result(
      saved.response.headers.get("X-Paperclip-Document-Outcome") === "rejected" ? "rejected" : "unknown",
      { status: saved.response.status, reason: "PUT failed; do not replay" },
    );
    if (saved.response.status !== (args.documentId === null ? 201 : 200))
      return result("unknown", { status: saved.response.status, reason: "Unexpected PUT status; do not replay" });
    const receipt = currentDocumentSchema.safeParse(saved.json);
    if (!receipt.success) return result("unknown", { reason: "Malformed PUT receipt; do not replay" });
    const doc = receipt.data;
    if (doc.companyId !== input.companyId || doc.issueId !== input.issueId || doc.key !== args.key ||
        (args.documentId !== null && doc.id !== args.documentId) || doc.latestRevisionId === args.baseRevisionId ||
        doc.body !== args.body) return result("mismatch", { reason: "PUT receipt differs from requested document" });
    stage = "readback"; requests.readbacks++;
    const checked = await request(args.key, "GET");
    if (!checked.response.ok || checked.response.redirected || checked.response.status !== 200)
      return result("unknown", { reason: "Readback failed after PUT; do not replay" });
    const observed = currentDocumentSchema.safeParse(checked.json);
    if (!observed.success) return result("unknown", { reason: "Malformed readback after PUT; do not replay" });
    if (observed.data.id !== doc.id || observed.data.latestRevisionId !== doc.latestRevisionId ||
        observed.data.latestRevisionNumber !== doc.latestRevisionNumber || observed.data.body !== doc.body)
      return result("mismatch", { reason: "Readback differs from PUT receipt" });
    stage = "complete";
    return result("verified", { key: doc.key, documentId: doc.id, revisionId: doc.latestRevisionId,
      revisionNumber: doc.latestRevisionNumber, body: doc.body, bodySha256: digest(doc.body) });
  } catch (error) {
    return result(putAttempted ? "unknown" : error instanceof z.ZodError ? "rejected" : "unknown",
      { reason: error instanceof Error ? error.message : "Document tool failed" });
  }
}
