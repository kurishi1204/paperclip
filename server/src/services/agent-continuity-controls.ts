import { eq, sql } from "drizzle-orm";
import { activityLog, agents, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";

// Only these non-secret fields may cross the continuity-controls API. In
// particular, selecting the complete runtimeConfig would expose aiConnection.
const safeSelection = {
  id: agents.id,
  companyId: agents.companyId,
  status: agents.status,
  role: agents.role,
  adapterType: agents.adapterType,
  updatedAt: sql<string>`to_char(${agents.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  assignmentMode: sql<string | null>`${agents.permissions} #>> '{authorizationPolicy,assignmentPolicy,mode}'`,
  blockAssignment: sql<boolean | null>`case when jsonb_typeof(${agents.permissions} #> '{authorizationPolicy,protectedAgent,blockAssignment}') = 'boolean' then (${agents.permissions} #>> '{authorizationPolicy,protectedAgent,blockAssignment}')::boolean else null end`,
  wakeOnDemand: sql<boolean | null>`case when jsonb_typeof(${agents.runtimeConfig} #> '{heartbeat,wakeOnDemand}') = 'boolean' then (${agents.runtimeConfig} #>> '{heartbeat,wakeOnDemand}')::boolean else null end`,
  heartbeatEnabled: sql<boolean | null>`case when jsonb_typeof(${agents.runtimeConfig} #> '{heartbeat,enabled}') = 'boolean' then (${agents.runtimeConfig} #>> '{heartbeat,enabled}')::boolean else null end`,
  canAssignTasks: sql<boolean | null>`case when jsonb_typeof(${agents.permissions} -> 'canAssignTasks') = 'boolean' then (${agents.permissions} ->> 'canAssignTasks')::boolean else null end`,
  canCreateAgents: sql<boolean | null>`case when jsonb_typeof(${agents.permissions} -> 'canCreateAgents') = 'boolean' then (${agents.permissions} ->> 'canCreateAgents')::boolean else null end`,
  legacyRequiresApproval: sql<boolean>`coalesce((${agents.permissions} #>> '{authorizationPolicy,protectedAgent,requiresApproval}')::boolean, false) or coalesce((${agents.permissions} #>> '{authorizationPolicy,assignmentPolicy,protectedAgentRequiresApproval}')::boolean, false)`,
};

function publicView(row: {
  id: string; companyId: string; status: string; role: string; adapterType: string;
  updatedAt: string; assignmentMode: string | null; blockAssignment: boolean | null;
  wakeOnDemand: boolean | null; heartbeatEnabled: boolean | null; canAssignTasks: boolean | null;
  canCreateAgents: boolean | null;
}) {
  return {
    id: row.id,
    companyId: row.companyId,
    status: row.status,
    role: row.role,
    adapterType: row.adapterType,
    updatedAt: row.updatedAt,
    assignmentMode: row.assignmentMode,
    blockAssignment: row.blockAssignment,
    wakeOnDemand: row.wakeOnDemand,
    heartbeatEnabled: row.heartbeatEnabled,
    canAssignTasks: row.canAssignTasks,
    canCreateAgents: row.canCreateAgents,
  };
}

export function agentContinuityControls(db: Db) {
  return {
    async get(id: string) {
      const [row] = await db.select(safeSelection).from(agents).where(eq(agents.id, id));
      return row ? publicView(row) : null;
    },

    async patch(id: string, input: {
      expectedUpdatedAt: string;
      blockAssignment: boolean;
      wakeOnDemand: boolean;
    }, actorId: string, authorizedCompanyId: string) {
      return db.transaction(async (tx) => {
        const [row] = await tx.select(safeSelection).from(agents).where(eq(agents.id, id)).for("update");
        if (!row) return null;
        if (row.companyId !== authorizedCompanyId) {
          throw conflict("Agent company changed; read the controls again");
        }
        if (row.updatedAt !== input.expectedUpdatedAt) {
          throw conflict("Agent controls changed; read them again");
        }
        if (row.status !== "paused" || row.role === "ceo" || row.assignmentMode !== "protected"
          || row.blockAssignment === null || row.wakeOnDemand === null || row.heartbeatEnabled !== false
          || row.canAssignTasks !== false || row.canCreateAgents === true || row.legacyRequiresApproval) {
          throw conflict("Agent is not eligible for a scoped continuity-control update");
        }
        const [changed] = await tx.update(agents).set({
          permissions: sql`jsonb_set(${agents.permissions}, '{authorizationPolicy,protectedAgent,blockAssignment}', to_jsonb(${input.blockAssignment}::boolean), false)`,
          runtimeConfig: sql`jsonb_set(${agents.runtimeConfig}, '{heartbeat,wakeOnDemand}', to_jsonb(${input.wakeOnDemand}::boolean), false)`,
          updatedAt: sql`greatest(clock_timestamp(), ${agents.updatedAt} + interval '1 microsecond')`,
        }).where(eq(agents.id, id)).returning(safeSelection);
        if (!changed || changed.blockAssignment !== input.blockAssignment || changed.wakeOnDemand !== input.wakeOnDemand) {
          throw conflict("Scoped controls did not change as requested");
        }
        await tx.insert(activityLog).values({
          companyId: row.companyId, actorType: "user", actorId,
          action: "agent.continuity_controls_updated", entityType: "agent", entityId: id, agentId: id,
          details: {
            previousBlockAssignment: row.blockAssignment,
            blockAssignment: changed.blockAssignment,
            previousWakeOnDemand: row.wakeOnDemand,
            wakeOnDemand: changed.wakeOnDemand,
          },
        });
        return publicView(changed);
      });
    },
  };
}
