import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { projectToolContext } from "../services/project-tool-context.js";
import { callProjectTool, projectToolDefinitions, SELF_TASK_DOCUMENT_CONTEXT_KEY } from "../services/project-tools.js";
import { assertCompanyAccess } from "./authz.js";
import { forbidden } from "../errors.js";

/** Mounted after actor middleware; connection-scoped tokens cannot authenticate here. */
export function projectToolRoutes(db: Db) {
  const router = Router();
  router.post("/mcp/project-tools", async (req, res) => {
    const context = await projectToolContext(db, req.actor);
    assertCompanyAccess(req, context.run.companyId);
    const { id = null, method, params } = req.body;
    const send = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });
    if (method === "initialize") return send({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "paperclip-project-tools", version: "1" } });
    if (method === "notifications/initialized") return res.status(202).end();
    const documentMode = context.run.contextSnapshot?.[SELF_TASK_DOCUMENT_CONTEXT_KEY] === true;
    const definitions = projectToolDefinitions(context.issue.workMode, true, documentMode);
    if (method === "tools/list") return send({ tools: definitions });
    if (method !== "tools/call") return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    try {
      if (!definitions.some(tool => tool.name === params?.name)) throw forbidden("Tool is unavailable in this mode");
      let apiUrl = process.env.PAPERCLIP_API_URL;
      if (documentMode) {
        // Bound document credentials stay on the accepting listener. Ordinary
        // project tools keep the configured origin they used before this mode.
        const address = req.socket.localAddress;
        const port = req.socket.localPort;
        if (!address || !port) throw new Error("Paperclip local API listener is unavailable");
        apiUrl = `http://${address.includes(":") ? `[${address}]` : address}:${port}`;
      }
      if (!apiUrl) throw new Error("Paperclip API origin is unavailable");
      const result = await callProjectTool({
        name: params.name, arguments: params.arguments ?? {}, apiUrl,
        token: req.header("authorization")!.replace(/^Bearer\s+/i, ""),
        companyId: context.run.companyId, issueId: context.issue.id, agentId: context.run.agentId,
        conversation: Boolean(context.issue.conversationAgentId),
      });
      const failed = result && typeof result === "object" && "outcome" in result && result.outcome !== "verified";
      return send({ ...(failed ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
    } catch (error) {
      return send({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Project tool failed" }] });
    }
  });
  return router;
}
