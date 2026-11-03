import { createHash } from "node:crypto";

/** A withdrawal preserves bytes. This ledger is separate from publication pins. */
export interface RetractionScope {
  companyId: string;
  wikiId: string;
  spaceSlug: string;
}
export interface RetractionTarget extends RetractionScope {
  path: string;
  contentHash: string;
}
export interface RetractionApproval {
  id: string;
  companyId: string;
  target: RetractionTarget;
  reason: string;
  reviewerId: string;
  reviewRunId: string;
  ownerDecisionId: string;
  proposal?: { issueId: string; documentKey: string; documentId: string; revisionId: string; bodySHA256: string; registrySHA256: string };
}
export interface RetractionFence {
  folderKey: "wiki-root";
  rootPath: string;
  pathPrefix: string;
  mode: "freeze-wiki" | "citation-holds";
  readable: Array<{ path: string; contentHash: string }>;
  blocks: Array<{ path: string; contentHash: string; state: "retracted" | "blocked_by_retraction" }>;
}
export interface RetractionEvent extends RetractionTarget {
  fence?: RetractionFence;
  schema: "paperclip.wiki-retraction/v1";
  id: string;
  sequence: number;
  previousHash: string | null;
  eventHash: string;
  type: "executed" | "observed" | "republished";
  republication?: {
    operationId: string; retractionEventHash: string; previousPath: string;
    physicalPath: string; rootPath: string; producerAgentId: string;
    documentId: string; revisionId: string; sourceRefsSHA256: string; reviewRecordSHA256: string;
    registryBeforeSHA256: string; registryAfterSHA256: string;
  };
  maintenanceLog?: {
    path: string; rootPath: string; prefixBytes: number; prefixSHA256: string;
    appendText: string; appendSHA256: string; resultingSHA256: string;
  };
  retractionId: string;
  reason: string;
  actorId: string;
  runId: string | null;
  at: string;
  approval: RetractionApproval;
}
export interface RetractionTransaction {
  events(): Promise<RetractionEvent[]>;
  append(event: RetractionEvent): Promise<void>;
}
/** Implementations must serialize a company/wiki/space and commit append atomically.
 * The ledger itself never edits Wiki files, publication pins, or old events. */
export interface RetractionStore {
  read(scope: RetractionScope): Promise<RetractionEvent[]>;
  transaction<T>(scope: RetractionScope, work: (tx: RetractionTransaction) => Promise<T>): Promise<T>;
}
export class RetractionError extends Error {
  constructor(readonly code: string) { super(`wiki_retraction_${code}`); }
}
function need(value: unknown, code: string): asserts value {
  if (!value) throw new RetractionError(code);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}
export function sameRetractionScope(a: RetractionScope, b: RetractionScope): boolean {
  return a.companyId === b.companyId && a.wikiId === b.wikiId && a.spaceSlug === b.spaceSlug;
}
function validTarget(target: RetractionTarget) {
  need([target.companyId, target.wikiId, target.spaceSlug, target.path].every(text), "target_shape");
  // Only the canonical worker identity can be recorded. No aliases in receipts.
  need(!target.path.startsWith("/") && !target.path.includes("\\") &&
    target.path.split("/").every(p => p !== "." && p !== ".." && p.length > 0), "target_path");
  need(/^[a-f0-9]{64}$/.test(target.contentHash), "target_hash");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" +
    Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical((value as Record<string, unknown>)[k])).join(",") + "}";
  return JSON.stringify(value);
}
export function retractionEventHash(event: Omit<RetractionEvent, "eventHash">): string {
  return createHash("sha256").update(canonical(event)).digest("hex");
}
function logHash(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
function logLine(event: RetractionEvent, before: string) {
  return "\n<!-- paperclip.wiki-maintenance/v1 -->\n" + JSON.stringify({
    schema: "paperclip.wiki-maintenance/v1", eventId: event.id, eventType: event.type,
    retractionId: event.retractionId, target: event.path, targetSHA256: event.contentHash,
    reason: event.reason, actorId: event.actorId, runId: event.runId, at: event.at,
    previousEventHash: event.previousHash, previousLogSHA256: before,
  }) + "\n";
}
function logAnchor(event: RetractionEvent, prior: RetractionEvent[]) {
  const parent = prior.find(e => e.type === "executed" && e.retractionId === event.retractionId);
  const fence = event.fence ?? parent?.fence;
  need(fence?.mode === "citation-holds", "maintenance_log_fence");
  const path = (fence.pathPrefix ? fence.pathPrefix + "/" : "") + "wiki/log.md";
  const original = fence.blocks.find(b => b.path === path); need(original, "maintenance_log_original");
  const previous = prior.filter(e => e.maintenanceLog?.path === path).at(-1)?.maintenanceLog;
  return { path, rootPath: fence.rootPath, prefixSHA256: previous?.resultingSHA256 ?? original.contentHash };
}
/** Compute the exact append before committing the authoritative event. No file
 * is edited by the ledger. The host performs that append once after commit. */
export function withRetractionMaintenanceLog(event: RetractionEvent, prior: RetractionEvent[], current: string): RetractionEvent {
  const anchor = logAnchor(event, prior);
  need(logHash(current) === anchor.prefixSHA256, "maintenance_log_pending_or_changed");
  const appendText = logLine(event, anchor.prefixSHA256);
  const { eventHash: _old, ...basis } = event;
  const next = { ...basis, maintenanceLog: { ...anchor, prefixBytes: Buffer.byteLength(current), appendText,
    appendSHA256: logHash(appendText), resultingSHA256: logHash(current + appendText) } };
  const result = { ...next, eventHash: retractionEventHash(next) };
  validateRetractionEvents(event,[...prior,result]); return result;
}
/** Return an exact historical prefix only when every recorded append and the
 * latest complete/pending log state match. Unknown partial effects fail closed. */
export function retainedRetractionFile(events: RetractionEvent[], filePath: string, expectedSHA256: string, contents: string): string {
  const records = events.filter(e => e.maintenanceLog?.path === filePath).sort((a,b)=>a.sequence-b.sequence);
  if (!records.length) { need(logHash(contents) === expectedSHA256, "readable_content_changed"); return contents; }
  need(records.every(e => sameRetractionScope(e, records[0]!) && e.maintenanceLog!.rootPath === records[0]!.maintenanceLog!.rootPath), "maintenance_log_scope");
  const bytes = Buffer.from(contents), latest = records.at(-1)!.maintenanceLog!;
  const full = logHash(bytes);
  need((full === latest.prefixSHA256 && bytes.length === latest.prefixBytes) ||
    (full === latest.resultingSHA256 && bytes.length === latest.prefixBytes + Buffer.byteLength(latest.appendText)), "maintenance_log_unknown_effect");
  let expectedLength: number | undefined;
  for (const event of records) {
    const log = event.maintenanceLog!, end = log.prefixBytes + Buffer.byteLength(log.appendText);
    need(logHash(bytes.subarray(0, log.prefixBytes)) === log.prefixSHA256, "maintenance_log_original_changed");
    if (bytes.length >= end) need(bytes.subarray(log.prefixBytes, end).equals(Buffer.from(log.appendText)), "maintenance_log_append_changed");
    else need(event === records.at(-1) && bytes.length === log.prefixBytes, "maintenance_log_missing_append");
    if (log.prefixSHA256 === expectedSHA256) expectedLength = log.prefixBytes;
    if (log.resultingSHA256 === expectedSHA256) expectedLength = end;
  }
  need(expectedLength !== undefined && expectedLength <= bytes.length && logHash(bytes.subarray(0,expectedLength)) === expectedSHA256, "readable_content_changed");
  return bytes.subarray(0,expectedLength).toString("utf8");
}
function verifyApproval(approval: RetractionApproval, target: RetractionTarget, reason: string, actorId: string, runId: string | null) {
  validTarget(approval.target);
  need([approval.id, approval.reason, approval.reviewerId, approval.reviewRunId, approval.ownerDecisionId].every(text), "approval_shape");
  need(approval.companyId === target.companyId && sameRetractionScope(approval.target, target) &&
    approval.target.path === target.path && approval.target.contentHash === target.contentHash && approval.reason === reason, "approval_scope");
  need(approval.reviewerId !== actorId && approval.reviewRunId !== runId, "independent_approval_required");
}
export function validateRetractionEvents(scope: RetractionScope, events: RetractionEvent[]): RetractionEvent[] {
  need([scope.companyId, scope.wikiId, scope.spaceSlug].every(text), "ledger_scope");
  let previousHash: string | null = null;
  const ids = new Set<string>(); const executed = new Map<string, RetractionEvent>();
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    validTarget(event);
    need(event.schema === "paperclip.wiki-retraction/v1" && sameRetractionScope(scope, event), "ledger_scope");
    need(event.sequence === i + 1 && event.previousHash === previousHash && !ids.has(event.id), "ledger_sequence");
    need([event.id, event.retractionId, event.reason, event.actorId, event.at].every(text) &&
      Number.isFinite(Date.parse(event.at)) && (event.runId === null || text(event.runId)), "ledger_event");
    if (event.fence) {
      need(typeof event.fence.pathPrefix === "string" && text(event.fence.rootPath) && event.fence.folderKey === "wiki-root" && ["freeze-wiki", "citation-holds"].includes(event.fence.mode) &&
        Array.isArray(event.fence.readable) && Array.isArray(event.fence.blocks) && event.fence.blocks.length > 0, "fence_shape");
      const paths = new Set<string>();
      for (const block of event.fence.blocks) {
        validTarget({ ...event, path: block.path, contentHash: block.contentHash });
        need(!paths.has(block.path) && ["retracted", "blocked_by_retraction"].includes(block.state), "fence_block");
        paths.add(block.path);
      }
      for (const item of event.fence.readable) {
        validTarget({ ...event, ...item });
        need(!paths.has(item.path), "fence_readable"); paths.add(item.path);
      }
    }
    const { eventHash, ...basis } = event;
    need(eventHash === retractionEventHash(basis), "ledger_integrity");
    need(["executed", "observed", "republished"].includes(event.type), "ledger_type");
    need((event.type === "republished") === Boolean(event.republication), "republication_event_shape");
    if (event.type === "executed") {
      verifyApproval(event.approval, event, event.reason, event.actorId, event.runId);
      need(!executed.has(event.path) && ![...executed.values()].some(e => e.retractionId === event.retractionId), "ledger_duplicate_retraction");
      executed.set(event.path, event);
    } else if (event.type === "republished") {
      verifyApproval(event.approval, event, event.reason, event.actorId, event.runId);
      const p = event.republication;
      const original = [...executed.values()].find(e => e.retractionId === event.retractionId);
      need(p && original?.fence?.mode === "citation-holds" && !event.fence &&
        original.eventHash === p.retractionEventHash && original.fence.rootPath === p.rootPath &&
        original.approval.ownerDecisionId === event.approval.ownerDecisionId, "republication_parent");
      const prior = original.fence.blocks.find(b => b.path === p.previousPath);
      need(prior?.state === "blocked_by_retraction" && p.previousPath !== p.physicalPath &&
        p.physicalPath === (original.fence.pathPrefix ? original.fence.pathPrefix + "/" : "") + event.path,
        "republication_target");
      validTarget({ ...event, path: p.physicalPath });
      need([p.operationId, p.producerAgentId, p.documentId, p.revisionId].every(text) &&
        [p.sourceRefsSHA256,p.reviewRecordSHA256,p.registryBeforeSHA256,p.registryAfterSHA256].every(v => /^[a-f0-9]{64}$/.test(v)) &&
        p.producerAgentId !== event.approval.reviewerId && p.producerAgentId !== event.actorId &&
        event.approval.proposal?.documentId === p.documentId && event.approval.proposal.revisionId === p.revisionId &&
        event.approval.proposal.bodySHA256 === event.contentHash, "republication_review");
      need(!events.slice(0,i).some(e => e.republication?.operationId === p.operationId ||
        e.republication?.physicalPath === p.physicalPath || e.fence?.blocks.some(b => b.path === p.physicalPath) ||
        e.fence?.readable.some(b => b.path === p.physicalPath)), "republication_new_version_required");
      need(![...executed.values()].some(e => e.fence?.mode !== "citation-holds"), "republication_legacy_hold");
    } else {
      const original = executed.get(event.path);
      need(original && original.retractionId === event.retractionId && original.contentHash === event.contentHash &&
        original.reason === event.reason && canonical(original.approval) === canonical(event.approval), "ledger_observation");
      need(event.actorId !== original.actorId && event.runId !== original.runId, "independent_observer_required");
    }
    if (event.maintenanceLog) {
      const log = event.maintenanceLog, anchor = logAnchor(event, events.slice(0,i));
      need(log.path === anchor.path && log.rootPath === anchor.rootPath && log.prefixSHA256 === anchor.prefixSHA256 &&
        Number.isSafeInteger(log.prefixBytes) && log.prefixBytes >= 0 && log.appendText === logLine(event, anchor.prefixSHA256) &&
        log.appendSHA256 === logHash(log.appendText) && /^[a-f0-9]{64}$/.test(log.resultingSHA256), "maintenance_log_record");
    }
    previousHash = eventHash; ids.add(event.id);
  }
  return events;
}
export async function readRetractions(store: RetractionStore, scope: RetractionScope): Promise<RetractionEvent[]> {
  return validateRetractionEvents(scope, await store.read(scope)).filter(e => e.type === "executed");
}
export async function executeRetraction(store: RetractionStore, input: {
  target: RetractionTarget; retractionId: string; reason: string;
  actorId: string; runId: string | null; eventId: string; at: string;
  /** This approval must come from a server-authenticated resolver, never tool arguments. */
  approval: RetractionApproval;
  fence?: RetractionFence;
  readCurrent(): Promise<{ path: string; contentHash: string }>;
  prepareEvent?(event: RetractionEvent, prior: RetractionEvent[]): Promise<RetractionEvent>;
}): Promise<RetractionEvent> {
  const { target } = input; validTarget(target);
  need([input.retractionId, input.reason, input.actorId, input.eventId, input.at].every(text), "request_shape");
  verifyApproval(input.approval, target, input.reason, input.actorId, input.runId);
  return store.transaction(target, async tx => {
    const events = validateRetractionEvents(target, await tx.events());
    const old = events.find(e => e.type === "executed" && (e.path === target.path || e.retractionId === input.retractionId));
    if (old) {
      need(old.path === target.path && old.contentHash === target.contentHash && old.reason === input.reason &&
        old.retractionId === input.retractionId && old.approval.id === input.approval.id && old.actorId === input.actorId, "already_retracted");
      return old; // Receipt readback, no second write or model call.
    }
    const current = await input.readCurrent();
    need(current.path === target.path && current.contentHash === target.contentHash, "page_changed");
    const basis: Omit<RetractionEvent, "eventHash"> = {
      ...target, schema: "paperclip.wiki-retraction/v1", id: input.eventId,
      sequence: events.length + 1, previousHash: events.at(-1)?.eventHash ?? null,
      type: "executed", retractionId: input.retractionId, reason: input.reason,
      actorId: input.actorId, runId: input.runId, at: input.at, approval: structuredClone(input.approval),
      ...(input.fence ? { fence: structuredClone(input.fence) } : {}),
    };
    let event: RetractionEvent = { ...basis, eventHash: retractionEventHash(basis) };
    if (input.prepareEvent) event = await input.prepareEvent(event, events);
    validateRetractionEvents(target, [...events, event]);
    await tx.append(event); // There is no separate mutable status to get ahead of audit.
    return event;
  });
}

/** The content of dependants is retained; its use is held, never declared false. */
export interface RetractionBlock {
  state: "retracted" | "blocked_by_retraction";
  readPolicy?: "citation-holds";
  path: string;
  retractionId: string;
  retractedPath: string;
  reason: string;
  eventHash: string;
}
export function retractionBlock(path: string, dependencies: Map<string, string[]>, events: RetractionEvent[]): RetractionBlock | null {
  const withdrawn = new Map(events.filter(e => e.type === "executed").map(e => [e.path, e]));
  const seen = new Set<string>();
  function visit(current: string): RetractionEvent | null {
    const event = withdrawn.get(current); if (event) return event;
    if (seen.has(current)) return null;
    seen.add(current);
    for (const parent of dependencies.get(current) ?? []) { const result = visit(parent); if (result) return result; }
    return null;
  }
  const event = visit(path);
  return event ? { state: event.path === path ? "retracted" : "blocked_by_retraction", path,
    retractionId: event.retractionId, retractedPath: event.path, reason: event.reason, eventHash: event.eventHash } : null;
}
