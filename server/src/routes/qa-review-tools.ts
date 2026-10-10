import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { projectToolContext } from "../services/project-tool-context.js";
import { assertActiveQaParticipant, callQaReviewTool, hasOwnQaDecision, QaDecisionOutcomeUnknownError, qaReviewToolDefinitions } from "../services/qa-review-tools.js";
import { assertCompanyAccess } from "./authz.js";
import { forbidden } from "../errors.js";

const MAX_QA_MCP_RESPONSE_BYTES = 64_000;
const MAX_QA_MCP_ERROR_MESSAGE_BYTES = 2_048;
const QA_MCP_OVERSIZE_MESSAGE = "QA tool response exceeds the size limit; request a smaller page or use human review";
const QA_MCP_DECISION_UNCERTAIN_MESSAGE = "QA decision response could not be delivered. Use read_assigned_review_receipt with the original stage, decision, and summary; do not resubmit the decision";

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
      if (!qaReviewToolDefinitions.some(tool => tool.name === params?.name)) throw forbidden("Unknown QA review tool");
      if (!activeParticipant && params?.name !== "read_assigned_review_receipt") {
        throw forbidden("Only this run's review receipt remains available after the decision");
      }
      const apiUrl = process.env.PAPERCLIP_API_URL;
      if (!apiUrl) throw new Error("Paperclip API origin is unavailable");
      const result = await callQaReviewTool({
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
