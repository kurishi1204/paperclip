import {createHash} from "node:crypto";
import {and,eq,inArray,sql} from "drizzle-orm";
import {agents,issues,heartbeatRuns,type Db} from "@paperclipai/db";
import {conflict} from "../errors.js";
import {commanderPolicySchema,admissionMatches,type prepareCommanderAdmissionSchema} from "./commander-cycle.js";
import type {z} from "zod";
import {logActivity} from "./activity-log.js";

/** Board-authorized compare-and-set, without an assignment wake or outbox entry. */
export async function prepareCommanderAdmission(db:Db,companyId:string,issueId:string,userId:string,input:z.infer<typeof prepareCommanderAdmissionSchema>) {
 return db.transaction(async tx=>{
  const [i]=await tx.select().from(issues).where(and(eq(issues.id,issueId),eq(issues.companyId,companyId))).for("update");
  const [c]=await tx.select().from(agents).where(and(eq(agents.id,input.commanderAgentId),eq(agents.companyId,companyId))).for("update");
  const policy=commanderPolicySchema.safeParse(c?.adapterConfig?.commanderCyclePolicy);
  const a=policy.success?policy.data.admissions.find(a=>a.id===input.admissionId):undefined;
  if(!i||!c||c.adapterConfig?.commanderCycleToolsOnly!==true||!policy.success||policy.data.commanderAgentId!==c.id||policy.data.companyId!==companyId||!a||a.issueId!==issueId||
      i.status!=="backlog"||i.revision!==input.revision||i.statusVersion!==input.statusVersion||i.assigneeAgentId!==null||i.assigneeUserId!==null||i.executionRunId!==null||i.executionPolicy||i.executionState||
      a.revision!==i.revision+1||a.statusVersion!==i.statusVersion+1||a.descriptionSha256!==createHash("sha256").update(i.description??"").digest("hex")||Date.parse(a.expiresAt)<=Date.now()) throw conflict("Commander preparation state or admission changed");
  const [w]=await tx.select().from(agents).where(and(eq(agents.id,a.workerAgentId),eq(agents.companyId,companyId)));
  const [active]=await tx.select({id:heartbeatRuns.id}).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId,companyId),inArray(heartbeatRuns.status,["running","queued","scheduled_retry"]),sql`coalesce(${heartbeatRuns.nativeIssueId}::text,${heartbeatRuns.contextSnapshot}->>'issueId',${heartbeatRuns.contextSnapshot}->>'taskId') = ${issueId}`)).limit(1);
  if(!w||["paused","terminated"].includes(w.status)||w.id===c.id||active)throw conflict("Worker or task is unavailable for commander preparation");
  const [updated]=await tx.update(issues).set({status:"todo",assigneeAgentId:w.id,revision:i.revision+1,statusVersion:i.statusVersion+1,updatedAt:new Date()}).where(eq(issues.id,i.id)).returning();
  if(!admissionMatches(a,updated,companyId,new Date()))throw conflict("Prepared task does not match its admission");
  await logActivity(tx as unknown as Db,{companyId,actorType:"user",actorId:userId,action:"issue.commander_admission_prepared",entityType:"issue",entityId:i.id,details:{commanderAgentId:c.id,workerAgentId:w.id,admissionId:a.id,revision:updated.revision,statusVersion:updated.statusVersion}});
  return updated;
 });
}
