import { and, eq, or, sql } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";

/** A finishing run releases only lease fields that still name that run. */
export async function releaseNativeRunCheckout(db: Db, input: {
  companyId: string; issueId: string; runId: string;
}) {
  const [released] = await db.update(issues).set({
    checkoutRunId: sql`case when ${issues.checkoutRunId} = ${input.runId}::uuid then null else ${issues.checkoutRunId} end`,
    executionRunId: sql`case when ${issues.executionRunId} = ${input.runId}::uuid then null else ${issues.executionRunId} end`,
    executionAgentNameKey: sql`case when ${issues.executionRunId} = ${input.runId}::uuid then null else ${issues.executionAgentNameKey} end`,
    executionLockedAt: sql`case when ${issues.executionRunId} = ${input.runId}::uuid then null else ${issues.executionLockedAt} end`,
    updatedAt: new Date(),
  }).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId),
    or(eq(issues.checkoutRunId, input.runId), eq(issues.executionRunId, input.runId))))
    .returning({id:issues.id,checkoutRunId:issues.checkoutRunId,executionRunId:issues.executionRunId});
  if (released) return released;
  const [current] = await db.select({id:issues.id,checkoutRunId:issues.checkoutRunId,executionRunId:issues.executionRunId})
    .from(issues).where(and(eq(issues.id,input.issueId),eq(issues.companyId,input.companyId))).limit(1);
  if (!current) throw new Error("native_checkout_not_released");
  return current;
}
