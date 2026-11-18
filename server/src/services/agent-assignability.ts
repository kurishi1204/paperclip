import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import {
  getAgentWorkEligibility,
  type AgentEligibilityAgent,
  type AgentOrgChainHealth,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

type AgentAssignmentKind = "work" | "routine";

type AssignabilityAgent = AgentEligibilityAgent;

type AgentAssignmentConflictReason =
  | "pending_approval"
  | "assignee_terminated"
  | "assignee_unknown_status"
  | "ancestor_terminated"
  | "ancestor_missing"
  | "ancestor_cross_company"
  | "ancestor_cycle"
  | "ancestor_depth_exceeded";

function assignmentMessage(kind: AgentAssignmentKind, reason: AgentAssignmentConflictReason) {
  if (reason === "pending_approval") {
    return kind === "routine"
      ? "Cannot assign routines to pending approval agents"
      : "Cannot assign work to pending approval agents";
  }
  if (reason === "assignee_terminated") {
    return kind === "routine"
      ? "Cannot assign routines to terminated agents"
      : "Cannot assign work to terminated agents";
  }
  if (reason === "assignee_unknown_status") {
    return kind === "routine"
      ? "Cannot assign routines to agents with an unsupported lifecycle status"
      : "Cannot assign work to agents with an unsupported lifecycle status";
  }
  return kind === "routine"
    ? "Cannot assign routines to agents with an invalid org chain"
    : "Cannot assign work to agents with an invalid org chain";
}

function conflictDetails(input: {
  companyId: string;
  assigneeAgentId: string;
  reason: AgentAssignmentConflictReason;
  chain: AssignabilityAgent[];
  invalidAncestorAgentId?: string | null;
  missingAncestorAgentId?: string | null;
}) {
  return {
    code: "agent_not_assignable",
    reason: input.reason,
    companyId: input.companyId,
    assigneeAgentId: input.assigneeAgentId,
    invalidAncestorAgentId: input.invalidAncestorAgentId ?? null,
    missingAncestorAgentId: input.missingAncestorAgentId ?? null,
    ancestorChain: input.chain.map((agent) => ({
      id: agent.id,
      companyId: agent.companyId,
      status: agent.status,
      reportsTo: agent.reportsTo,
    })),
  };
}

async function getAgent(db: Db, agentId: string): Promise<(AssignabilityAgent & { adapterType: string; adapterConfig: unknown }) | null> {
  return db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      status: agents.status,
      reportsTo: agents.reportsTo,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);
}

async function listCompanyAgents(db: Db, companyId: string): Promise<AssignabilityAgent[]> {
  return db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      status: agents.status,
      reportsTo: agents.reportsTo,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId));
}

function assignmentReasonFromHealth(health: AgentOrgChainHealth): AgentAssignmentConflictReason {
  if (health.reason === "terminated_ancestor") return "ancestor_terminated";
  if (health.reason === "missing_manager") return "ancestor_missing";
  if (health.reason === "cycle") return "ancestor_cycle";
  return "ancestor_missing";
}

export async function assertAssignableAgent(
  db: Db,
  companyId: string,
  agentId: string | null | undefined,
  options: { kind?: AgentAssignmentKind; work?: AssignmentWorkIssue } = {},
) {
  if (!agentId) return;
  const kind = options.kind ?? "work";
  const assignee = await getAgent(db, agentId);
  if (!assignee) throw notFound("Assignee agent not found");
  if (assignee.companyId !== companyId) {
    throw unprocessable("Assignee must belong to same company");
  }

  const companyAgents = await listCompanyAgents(db, companyId);
  const eligibility = getAgentWorkEligibility({ agent: assignee, agents: companyAgents });
  const chain = eligibility.orgChainHealth.fullChain.map((entry) => ({
    id: entry.id,
    companyId: entry.companyId,
    name: entry.name,
    status: entry.status,
    reportsTo: entry.reportsTo,
  }));

  if (eligibility.assignable) {
    if (options.work) {
      const compatibility = assignmentWorkCompatibility({ issue: options.work, agent: assignee });
      if (compatibility.kind === "blocked") {
        throw conflict(compatibility.block.reason, {
          code: compatibility.block.errorCode,
          ...compatibility.block.details,
        });
      }
    }
    return;
  }

  if (eligibility.assignabilityReason === "pending_approval") {
    throw conflict(assignmentMessage(kind, "pending_approval"), conflictDetails({
      companyId,
      assigneeAgentId: agentId,
      reason: "pending_approval",
      chain,
    }));
  }
  if (eligibility.assignabilityReason === "terminated") {
    throw conflict(assignmentMessage(kind, "assignee_terminated"), conflictDetails({
      companyId,
      assigneeAgentId: agentId,
      reason: "assignee_terminated",
      chain,
    }));
  }
  if (eligibility.assignabilityReason === "unknown_status") {
    throw conflict(assignmentMessage(kind, "assignee_unknown_status"), conflictDetails({
      companyId,
      assigneeAgentId: agentId,
      reason: "assignee_unknown_status",
      chain,
    }));
  }

  const reason = assignmentReasonFromHealth(eligibility.orgChainHealth);
  const firstInvalidAncestor = eligibility.orgChainHealth.firstInvalidAncestor;
  throw conflict(assignmentMessage(kind, reason), conflictDetails({
    companyId,
    assigneeAgentId: agentId,
    reason,
    chain,
    invalidAncestorAgentId:
      firstInvalidAncestor && firstInvalidAncestor.status !== "missing"
        ? firstInvalidAncestor.id
        : null,
    missingAncestorAgentId:
      firstInvalidAncestor?.status === "missing"
        ? firstInvalidAncestor.id
        : null,
  }));
}

/** Company owners decide what the work needs. This mechanical handoff contract
 * carries that decision; task titles, prose and agent names are not classifiers.
 * It is optional metadata on the existing per-issue adapter override, never a
 * grant of tools or authority. Dispatch always reads the persisted issue. */
export type AssignmentWorkBlock = {
  errorCode: "assignment_work_contract_invalid" | "agent_work_requirements_unavailable";
  reason: string;
  details: Record<string, unknown>;
};
export type AssignmentWorkCompatibility =
  | { kind: "unclassified"; reason: "not_supplied" | "not_assigned_executor" | "adapter_capabilities_not_declared" }
  | { kind: "compatible" }
  | { kind: "blocked"; block: AssignmentWorkBlock };

export function isBoundedResearchAgent(agent: {
  id: string; adapterType: string; adapterConfig?: unknown;
}, operatorBoundedAgentId: string | undefined = process.env.PAPERCLIP_HERMES_BOUNDED_AGENT_ID): boolean {
  const config = agent.adapterConfig && typeof agent.adapterConfig === "object" && !Array.isArray(agent.adapterConfig)
    ? agent.adapterConfig as Record<string, unknown> : {};
  return agent.adapterType === "hermes_local" &&
    (agent.id === operatorBoundedAgentId || config.boundedExecution === true);
}

/** Stable across assignment/status/metadata writes; pins only the source brief. */
export function assignmentWorkSourcePin(issue: { title: string; description: string | null }): string {
  return createHash("sha256").update(JSON.stringify({ title: issue.title, description: issue.description })).digest("hex");
}

export type AssignmentWorkIssue = {
  id: string; companyId: string; assigneeAgentId: string | null;
  title: string; description: string | null; assigneeAdapterOverrides?: unknown;
};

function assignmentWorkConfig(issue: AssignmentWorkIssue): Record<string, unknown> {
  const overrides = issue.assigneeAdapterOverrides;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return {};
  const config = (overrides as Record<string, unknown>).adapterConfig;
  return config && typeof config === "object" && !Array.isArray(config) ? config as Record<string, unknown> : {};
}

/** Presence is distinct from validity: an explicit null/broken contract still checks. */
export function hasAssignmentWorkRequirements(issue: AssignmentWorkIssue): boolean {
  return Object.hasOwn(assignmentWorkConfig(issue), "paperclipWorkRequirements");
}

/** Raw adapter configuration is not an alternate work-requirements producer.
 * Compare presence as well as value so deletion/null/creation cannot silently
 * turn an explicit contract into an unclassified legacy assignment. */
export function assertAssignmentWorkRequirementsPreserved(
  current: AssignmentWorkIssue,
  nextOverrides: unknown,
): void {
  const proposed = { ...current, assigneeAdapterOverrides: nextOverrides };
  const currentConfig = assignmentWorkConfig(current);
  const proposedConfig = assignmentWorkConfig(proposed);
  if (hasAssignmentWorkRequirements(current) !== hasAssignmentWorkRequirements(proposed) ||
      !isDeepStrictEqual(currentConfig.paperclipWorkRequirements, proposedConfig.paperclipWorkRequirements)) {
    throw conflict("Raw adapter overrides cannot create, replace or remove work requirements; use the authorized workRequirements input", {
      code: "assignment_work_contract_invalid",
      issueId: current.id,
    });
  }
}

/** Ordinary issue-update producer: the owner supplies meaning, the server supplies
 * identity. The resulting contract is the same persisted contract dispatch reads. */
export function prepareAssignmentWorkRequirements(
  issue: AssignmentWorkIssue,
  requirements: { requiredOperations: string[]; deliverable: string },
) {
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const overrides = object(issue.assigneeAdapterOverrides);
  return { ...issue, assigneeAdapterOverrides: {
    ...overrides,
    adapterConfig: {
      ...object(overrides.adapterConfig),
      paperclipWorkRequirements: {
        schema: "paperclip.work-requirements.v1",
        companyId: issue.companyId,
        issueId: issue.id,
        sourceBriefSha256: assignmentWorkSourcePin(issue),
        requiredOperations: [...requirements.requiredOperations],
        deliverable: requirements.deliverable,
      },
    },
  } };
}

export function assignmentWorkCompatibility(input: {
  issue: AssignmentWorkIssue;
  agent: { id: string; adapterType: string; adapterConfig?: unknown };
  operatorBoundedAgentId?: string;
}): AssignmentWorkCompatibility {
  // Match the runtime override owner: reviewer/coordinator work is a different operation.
  if (input.issue.assigneeAgentId !== input.agent.id) return { kind: "unclassified", reason: "not_assigned_executor" };
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const config = assignmentWorkConfig(input.issue);
  if (!hasAssignmentWorkRequirements(input.issue)) return { kind: "unclassified", reason: "not_supplied" };
  const raw = config.paperclipWorkRequirements;
  const contract = object(raw);
  const operations = contract.requiredOperations;
  const problems: string[] = [];
  if (contract.schema !== "paperclip.work-requirements.v1") problems.push("schema");
  if (contract.companyId !== input.issue.companyId) problems.push("companyId");
  if (contract.issueId !== input.issue.id) problems.push("issueId");
  if (contract.sourceBriefSha256 !== assignmentWorkSourcePin(input.issue)) problems.push("sourceBriefSha256");
  if (Object.keys(contract).some(key => !["schema", "companyId", "issueId", "sourceBriefSha256", "requiredOperations", "deliverable"].includes(key))) problems.push("unknown_fields");
  if (typeof contract.deliverable !== "string" || !contract.deliverable.trim()) problems.push("deliverable");
  if (!Array.isArray(operations) || operations.length === 0 ||
      operations.some(operation => typeof operation !== "string" || !operation.trim()) ||
      new Set(operations).size !== operations.length) problems.push("requiredOperations");
  if (problems.length) return { kind: "blocked", block: {
    errorCode: "assignment_work_contract_invalid",
    reason: "Assignment work contract is invalid or no longer matches the issue. The existing sender must correct the contract before execution.",
    details: { issueId: input.issue.id, invalidFields: problems, expectedSourceBriefSha256: assignmentWorkSourcePin(input.issue),
      suppliedSourceBriefSha256: typeof contract.sourceBriefSha256 === "string" ? contract.sourceBriefSha256 : null },
  } };
  // The operator pin cannot be disabled by an issue override. Other adapters
  // have no verified operation declaration here: leave them unclassified.
  const effectiveConfig = { ...object(input.agent.adapterConfig), ...config };
  if (!isBoundedResearchAgent({ ...input.agent, adapterConfig: effectiveConfig }, input.operatorBoundedAgentId)) {
    return { kind: "unclassified", reason: "adapter_capabilities_not_declared" };
  }
  // This is the bounded adapter's actual closed tool/result surface, not a
  // vocabulary for inferring a task's intent from its wording.
  const supported = new Set(["web_search", "final_response"]);
  const unavailableOperations = (operations as string[]).filter(operation => !supported.has(operation));
  if (!unavailableOperations.length) return { kind: "compatible" };
  return { kind: "blocked", block: {
    errorCode: "agent_work_requirements_unavailable",
    reason: "The assigned web-only research worker cannot perform the explicit required operations. The existing sender must use the approved capable owner or record the missing assignment decision; do not retry this worker.",
    details: { issueId: input.issue.id, sourceBriefSha256: contract.sourceBriefSha256, agentId: input.agent.id,
      requiredOperations: operations, unavailableOperations, deliverable: contract.deliverable,
      supportedOperations: [...supported], classification: "explicit_requirement_mismatch" },
  } };
}
