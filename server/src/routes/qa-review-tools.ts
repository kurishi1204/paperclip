import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { ZodError } from "zod";
import { getQaReviewProcess, requestQaReviewHold } from "@paperclipai/adapter-utils/server-utils";
import { projectToolContext } from "../services/project-tool-context.js";
import { assertActiveQaParticipant, callQaReviewTool, hasOwnQaDecision, QaDecisionOutcomeUnknownError, qaReviewToolDefinitions } from "../services/qa-review-tools.js";
import { assertCompanyAccess } from "./authz.js";
import { forbidden, HttpError } from "../errors.js";

const MAX_QA_MCP_RESPONSE_BYTES = 64_000;
const MAX_QA_MCP_ERROR_MESSAGE_BYTES = 2_048;
const QA_MCP_OVERSIZE_MESSAGE = "QA tool response exceeds the size limit; request a smaller page or use human review";
const QA_MCP_DECISION_UNCERTAIN_MESSAGE = "QA decision response could not be delivered. Use read_assigned_review_receipt with the original stage, decision, and summary; do not resubmit the decision";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** A run-bound MCP with no caller-selected issue, identity or API route. */
export function qaReviewToolRoutes(db: Db) {
  const router = Router();
  router.post("/mcp/qa-review", async (req, res) => {
    const context = await projectToolContext(db, req.actor, false, "QA review");
    assertCompanyAccess(req, context.run.companyId);
    let activeParticipant = true;
    try { assertActiveQaParticipant(context.issue, context.run.agentId); }
    catch { activeParticipant = false; }
    if (!activeParticipant && !await hasOwnQaDecision(db, {
      companyId: context.run.companyId, issueId: context.issue.id,
      agentId: context.run.agentId, runId: context.run.id,
    })) throw forbidden("QA tools require the current review participant or this run's formal decision");
    const { id = null, method, params } = req.body ?? {};
    const serializedId = JSON.stringify(id);
    const boundedId = (typeof id === "string" || typeof id === "number" || id === null) &&
      serializedId && Buffer.byteLength(serializedId, "utf8") <= 512 ? id : null;
    const send = (result: unknown) => {
      // content.text and structuredContent duplicate the result. Bound the actual
      // JSON-RPC wire response, rather than any one tool's projected object.
      const serialized = JSON.stringify({ jsonrpc: "2.0", id, result });
      if (Buffer.byteLength(serialized, "utf8") <= MAX_QA_MCP_RESPONSE_BYTES) {
        return res.type("application/json").send(serialized);
      }
      // A caller-controlled JSON-RPC id can itself be oversized. Preserve only
      // a small id so even the fail-closed response has a fixed byte bound.
      const message = method === "tools/call" && params?.name === "submit_review_decision"
        ? QA_MCP_DECISION_UNCERTAIN_MESSAGE : QA_MCP_OVERSIZE_MESSAGE;
      const fallback = JSON.stringify({ jsonrpc: "2.0", id: boundedId,
        result: { isError: true, content: [{ type: "text", text: message }] } });
      return res.type("application/json").send(fallback);
    };
    if (method === "initialize") return send({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "paperclip-qa-review", version: "1" } });
    if (method === "notifications/initialized") return res.status(202).end();
    if (method === "tools/list") return send({ tools: qaReviewToolDefinitions });
    if (method !== "tools/call") return res.type("application/json").send(JSON.stringify({
      jsonrpc: "2.0", id: boundedId, error: { code: -32601, message: "Method not found" },
    }));
    try {
      if (!qaReviewToolDefinitions.some(tool => tool.name === params?.name)) {
        throw forbidden("Unknown QA review tool");
      }
      const binding = getQaReviewProcess(context.run.id);
      const receiptOnly = params?.name === "read_assigned_review_receipt";
      if (!binding && !receiptOnly) throw forbidden("QA review process is not bound to this run");
      if (!activeParticipant && params?.name !== "read_assigned_review_receipt") {
        throw forbidden("Only this run's review receipt remains available after the decision");
      }
      // Call back through the listener that accepted this authenticated MCP
      // request. PAPERCLIP_API_URL can be a public tunnel and must not carry
      // this run's token out of the host for a server-local read or decision.
      const localAddress = req.socket.localAddress;
      const localPort = req.socket.localPort;
      if (!localAddress || !localPort) throw new Error("Paperclip local API listener is unavailable");
      const localHost = localAddress.includes(":") ? `[${localAddress}]` : localAddress;
      const apiUrl = `http://${localHost}:${localPort}`;
      const call = () => callQaReviewTool({
        db,
        runId: context.run.id,
        companyId: context.run.companyId,
        name: params.name,
        arguments: params.arguments ?? {},
        apiUrl,
        token: req.header("authorization")!.replace(/^Bearer\s+/i, ""),
        issue: context.issue,
        agentId: context.run.agentId,
      });
      const control = binding?.control;
      if (control && !receiptOnly && (control.hold || control.requestedHold || control.verdict === "unknown")) {
        throw forbidden("QA evidence paging is held; only its existing review receipt may be read");
      }
      let result: Awaited<ReturnType<typeof callQaReviewTool>>;
      if (params.name === "submit_review_decision" && control) {
        if (control.verdict !== "none") throw forbidden("QA decision already admitted; read its matching receipt");
        control.verdict = "pending";
        const pending = call();
        control.verdictPromise = pending;
        try {
          result = await pending;
          control.verdict = "committed";
          control.requestedHold = null;
        } catch (error) {
          control.verdict = error instanceof QaDecisionOutcomeUnknownError ? "unknown" : "none";
          if (control.verdict === "unknown") control.requestedHold = null;
          throw error;
        }
      } else if (!control || receiptOnly) {
        result = await call();
      } else {
        const key = canonical({ tool: params.name, arguments: params.arguments ?? {},
          revision: context.issue.revision, statusVersion: context.issue.statusVersion });
        let page = control.reads.get(key);
        if (!page) {
          page = { tail: Promise.resolve(), errors: 0, result: null, repeats: 0 };
          control.reads.set(key, page);
        }
        const previous = page.tail;
        let release!: () => void;
        page.tail = new Promise<void>(resolve => { release = resolve; });
        await previous;
        const hold = (kind: string) => {
          const state = context.issue.executionState as Record<string, unknown> | null;
          requestQaReviewHold(binding!, {
            reason: "qa_review_read_hold", companyId: context.run.companyId,
            issueId: context.issue.id, runId: context.run.id, agentId: context.run.agentId,
            currentStageId: state?.currentStageId, statusVersion: context.issue.statusVersion,
            lastDecisionId: state?.lastDecisionId ?? null, kind,
            evidence: { tool: params.name, canonicalArguments: canonical(params.arguments ?? {}),
              issueRevision: context.issue.revision, errors: page!.errors, repeats: page!.repeats },
          });
        };
        try {
          if (control.hold || control.requestedHold) throw forbidden("QA evidence paging is held");
          result = await call();
          if (Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id,
            result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } }), "utf8") > MAX_QA_MCP_RESPONSE_BYTES) {
            throw new HttpError(413, QA_MCP_OVERSIZE_MESSAGE);
          }
          page.errors = 0;
          // All current read tools other than the overview are evidence pages
          // (including comment-ID cursors). Receipt/decision are handled above.
          // Inspect the actual complete result, not one cursor-field spelling.
          if (params.name !== "read_assigned_issue") {
            const signature = canonical(result);
            page.repeats = signature === page.result ? page.repeats + 1 : 1;
            page.result = signature;
            if (page.repeats >= 3) { hold("unchanged_page"); throw forbidden("QA paging returned the same page without progress"); }
          }
        } catch (error) {
          const deterministic = error instanceof ZodError || error instanceof HttpError && [400, 403, 409, 413, 422].includes(error.status);
          if (!control.hold && !control.requestedHold && deterministic) {
            page.errors += 1;
            if (page.errors >= 2) hold("repeated_rejection");
          }
          throw error;
        } finally { release(); }
      }
      return send({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
    } catch (error) {
      const rawReason = error instanceof Error ? error.message : "QA review tool failed";
      const reason = Buffer.byteLength(rawReason, "utf8") <= MAX_QA_MCP_ERROR_MESSAGE_BYTES
        ? rawReason : "QA review tool failed";
      const message = params?.name === "submit_review_decision"
        ? error instanceof QaDecisionOutcomeUnknownError
          ? `${reason}. Use read_assigned_review_receipt with the original stage, decision, and summary; do not resubmit the decision`
          : `${reason}. No decision was recorded by this attempt; re-read the issue and submit a new decision if the review stage remains pending`
        : reason;
      return send({ isError: true, content: [{ type: "text", text: message }] });
    }
  });
  return router;
}
