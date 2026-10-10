import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { projectToolContext } from "../services/project-tool-context.js";
import { assertActiveQaParticipant, callQaReviewTool, hasOwnQaDecision, qaReviewToolDefinitions } from "../services/qa-review-tools.js";
import { assertCompanyAccess } from "./authz.js";
import { forbidden } from "../errors.js";

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
    const send = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });
    if (method === "initialize") return send({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "paperclip-qa-review", version: "1" } });
    if (method === "notifications/initialized") return res.status(202).end();
    if (method === "tools/list") return send({ tools: qaReviewToolDefinitions });
    if (method !== "tools/call") return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
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
      return send({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "QA review tool failed" }] });
    }
  });
  return router;
}
