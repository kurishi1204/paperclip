import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

/** These are server-read facts, not a request schema or an authorization token.
 * The DB adapter re-reads them at each boundary; a serialized binding grants no access. */
export type DocumentReturnBinding = {
  schema: "paperclip.document-return.v1";
  companyId: string; issueId: string; authorId: string; sourceRunId: string;
  interactionId: string; reviewerId: string; reviewRunId: string; resolvedAt: string;
  documentId: string; key: string; revisionId: string; revisionNumber: number;
  bodySha256: string; bodyBytes: number;
};
export type DocumentReturnFacts = {
  issue: { id: string; companyId: string; assigneeAgentId: string | null; status: string };
  interaction: {
    id: string; companyId: string; issueId: string; kind: string; status: string;
    continuationPolicy: string; createdByAgentId: string | null; createdByUserId?: string | null;
    addresseeAgentId: string | null; addresseeUserId?: string | null;
    resolvedByAgentId: string | null; resolvedByUserId?: string | null;
    sourceRunId: string | null; resolvedByRunId: string | null; resolvedAt: Date | string | null;
    payload: unknown; result: unknown;
  };
  sourceRun: { id: string; companyId: string; agentId: string; issueId: string | null } | null;
  reviewRun: { id: string; companyId: string; agentId: string; issueId: string | null } | null;
  document: { companyId: string; issueId: string; id: string; key: string;
    revisionId: string; latestRevisionId: string | null; revisionNumber: number;
    latestRevisionNumber: number; createdByAgentId: string | null;
    revisionAuthorId: string | null; body: string } | null;
};
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const uuid = (v: unknown): v is string => typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export function bindDocumentReturn(f: DocumentReturnFacts, actorId: string): DocumentReturnBinding | null {
  const c=f.interaction, p=object(c.payload), target=object(p.target), d=f.document;
  const ids=[f.issue.id,f.issue.companyId,actorId,c.id,c.createdByAgentId,c.addresseeAgentId,c.sourceRunId,c.resolvedByRunId];
  if (!ids.every(uuid) || f.issue.assigneeAgentId !== actorId || ["done","cancelled"].includes(f.issue.status) ||
      c.companyId !== f.issue.companyId || c.issueId !== f.issue.id || c.createdByAgentId !== actorId ||
      c.createdByUserId || c.addresseeUserId || c.resolvedByUserId ||
      c.kind !== "request_confirmation" || c.status !== "accepted" || object(c.result).outcome !== "accepted" ||
      !["wake_assignee","wake_assignee_on_accept"].includes(c.continuationPolicy) ||
      c.resolvedByAgentId !== c.addresseeAgentId || c.addresseeAgentId === actorId ||
      Object.hasOwn(p,"toolAction") || Object.hasOwn(p,"secretProposal") || target.type !== "issue_document" || target.key === "plan" ||
      target.issueId !== f.issue.id || !d || d.companyId !== f.issue.companyId || d.issueId !== f.issue.id ||
      d.id !== target.documentId || d.key !== target.key || d.revisionId !== target.revisionId ||
      d.latestRevisionId !== d.revisionId || d.latestRevisionNumber !== d.revisionNumber ||
      (target.revisionNumber !== undefined && target.revisionNumber !== d.revisionNumber) ||
      !Number.isSafeInteger(d.revisionNumber) || d.revisionNumber < 1 ||
      d.createdByAgentId !== actorId || d.revisionAuthorId !== actorId || !uuid(d.id) || !uuid(d.revisionId)) return null;
  for (const [run,id,author] of [[f.sourceRun,c.sourceRunId,actorId],[f.reviewRun,c.resolvedByRunId,c.addresseeAgentId]] as const) {
    if (!run || run.id !== id || run.companyId !== f.issue.companyId || run.issueId !== f.issue.id || run.agentId !== author) return null;
  }
  if (c.sourceRunId === c.resolvedByRunId || !c.resolvedAt) return null;
  const at=new Date(c.resolvedAt); if (!Number.isFinite(at.getTime())) return null;
  return {schema:"paperclip.document-return.v1",companyId:f.issue.companyId,issueId:f.issue.id,authorId:actorId,
    sourceRunId:c.sourceRunId!,interactionId:c.id,reviewerId:c.addresseeAgentId!,reviewRunId:c.resolvedByRunId!,
    resolvedAt:at.toISOString(),documentId:d.id,key:d.key,revisionId:d.revisionId,revisionNumber:d.revisionNumber,
    bodySha256:createHash("sha256").update(d.body,"utf8").digest("hex"),bodyBytes:Buffer.byteLength(d.body,"utf8")};
}
export function sameDocumentReturn(a: unknown, b: DocumentReturnBinding): boolean {
  return isDeepStrictEqual(a,b);
}
export function documentReturnKey(b: DocumentReturnBinding): string {
  return `document-return:${b.interactionId}:${b.revisionId}`;
}
export function documentReturnBody(b: DocumentReturnBinding): string {
  return `QA-accepted document ready for intake: ${b.key}@${b.revisionId}\n` +
    `Document ${b.documentId}; revision ${b.revisionNumber}; UTF-8 ${b.bodyBytes} bytes; SHA256 ${b.bodySha256}.\n` +
    `Author ${b.authorId}; source run ${b.sourceRunId}; review ${b.interactionId}; reviewer ${b.reviewerId}; review run ${b.reviewRunId}.\n` +
    "This returns only the fixed reviewed document. Task blockers and company/user acceptance remain unchanged.";
}
export type DocumentReturnDelivery =
  | { state: "not_started" }
  | { state: "unknown" }
  | { state: "committed"; binding: unknown; comment: {
      id: string; companyId: string; issueId: string; authorAgentId: string | null;
      createdByRunId: string | null; body: string; deletedAt: Date | string | null;
    }; runId: string; acknowledgment: { commentId: string; binding: unknown } };
/** A return is a bounded handoff, never permission to execute a blocked deliverable.
 * Acknowledgment here means exact durable storage, NOT independent company acceptance. */
export function consumeDocumentReturn(input: {
  expected: unknown; current: DocumentReturnBinding | null; delivery: DocumentReturnDelivery;
  operation: "return" | "deliverable"; dependenciesReady: boolean;
}) {
  const b=input.current;
  if (!b || !sameDocumentReturn(input.expected,b)) return {state:"rejected" as const,reason:"document_return_binding_mismatch"};
  if (input.operation !== "return") return {state:"rejected" as const,reason:"document_return_does_not_authorize_deliverable"};
  if (input.delivery.state === "unknown") return {state:"rejected" as const,reason:"document_return_outcome_unknown"};
  if (input.delivery.state === "committed") {
    const r=input.delivery,c=r.comment;
    if (!sameDocumentReturn(r.binding,b) || !sameDocumentReturn(r.acknowledgment.binding,b) ||
        !uuid(c.id) || !uuid(r.runId) || r.acknowledgment.commentId !== c.id || c.companyId !== b.companyId ||
        c.issueId !== b.issueId || c.authorAgentId !== b.authorId || c.createdByRunId !== r.runId ||
        c.deletedAt !== null || c.body !== documentReturnBody(b)) {
      return {state:"rejected" as const,reason:"document_return_receipt_mismatch"};
    }
    return {state:"already_returned" as const,commentId:c.id,maySend:false as const,companyAccepted:false as const};
  }
  return {state:"ready" as const,binding:b,idempotencyKey:documentReturnKey(b),body:documentReturnBody(b),
    scope:"fixed_document_return_only" as const,deliverableAllowed:false as const,
    dependenciesReady:input.dependenciesReady,companyAccepted:false as const};
}

/** Ordinary queue records precede native preparation; only the claim boundary
 * accepts that exact original shape. Tools/execution still require native binding. */
export function documentReturnRunMatches(run: {
  companyId:string;agentId:string;retryOfRunId:string|null;wakeupRequestId:string|null;
  runtimeMode:string;status:string;nativeIssueId:string|null;contextSnapshot:unknown;
  runnerProfileJson?:unknown;processPid?:number|null;processGroupId?:number|null;
},b:DocumentReturnBinding,phase:"claim"|"native"|"server") {
  if (run.companyId !== b.companyId || run.agentId !== b.authorId || run.retryOfRunId || !run.wakeupRequestId ||
      object(run.contextSnapshot).issueId !== b.issueId || !sameDocumentReturn(object(run.contextSnapshot).documentReturn,b)) return false;
  if (phase === "claim") return run.status === "queued" &&
    ((run.runtimeMode === "legacy" && run.nativeIssueId === null) ||
     (run.runtimeMode === "native" && run.nativeIssueId === b.issueId));
  if (phase === "server") return run.status === "running" && run.runtimeMode === "legacy" &&
    run.nativeIssueId === null && run.processPid == null && run.processGroupId == null &&
    sameDocumentReturn(object(run.runnerProfileJson).documentReturnAdmission,b);
  return run.runtimeMode === "native" && run.nativeIssueId === b.issueId && run.status === "running";
}

/** A return wake never grants generic transport/provider authority, including
 * malformed markers. Only the server executor can consume a verified binding. */
export function isDocumentReturnContext(context: unknown): boolean {
  return Object.hasOwn(object(context), "documentReturn");
}
export function documentReturnGate(input: {
  binding: DocumentReturnBinding | null; expected: unknown;
  ownerCurrent: boolean; paused: boolean; cancelled: boolean; unknownEffect: boolean;
}) {
  return Boolean(input.binding && sameDocumentReturn(input.expected,input.binding) &&
    input.ownerCurrent && !input.paused && !input.cancelled && !input.unknownEffect);
}
/** Production consumer, inside the caller's locked transaction. No provider,
 * arbitrary body, HTTP credential, deliverable or status mutation is available. */
export async function commitDocumentReturn(port: {
  binding: DocumentReturnBinding; expected: unknown; runId: string;
  readDelivery: () => Promise<DocumentReturnDelivery>;
  append: (body: string) => Promise<Extract<DocumentReturnDelivery,{state:"committed"}>["comment"]>;
  saveReceipt: (key:string, receipt:Record<string,unknown>) => Promise<void>;
}) {
  const packet=consumeDocumentReturn({expected:port.expected,current:port.binding,
    delivery:await port.readDelivery(),operation:"return",dependenciesReady:false});
  if (packet.state === "rejected") throw new Error(packet.reason);
  if (packet.state === "already_returned") return packet;
  const comment=await port.append(packet.body);
  const acknowledgment={commentId:comment.id,binding:port.binding};
  const checked=consumeDocumentReturn({expected:port.expected,current:port.binding,
    delivery:{state:"committed",binding:port.binding,comment,runId:port.runId,acknowledgment},
    operation:"return",dependenciesReady:false});
  if (checked.state !== "already_returned") throw new Error("document_return_storage_mismatch");
  await port.saveReceipt(packet.idempotencyKey,{operationId:"report_progress",
    input:{body:packet.body,idempotencyKey:packet.idempotencyKey},
    result:{commentId:comment.id,documentReturn:port.binding,
      documentReturnAck:{...acknowledgment,scope:"durable_storage_only"},companyAccepted:false}});
  return {...checked,disposition:"applied" as const};
}
