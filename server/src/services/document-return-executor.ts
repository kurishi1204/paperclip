import {randomUUID} from "node:crypto";
import {and,eq} from "drizzle-orm";
import {agents,heartbeatRuns,issues,issueComments,type Db} from "@paperclipai/db";
import {agentRunWritesRevoked} from "../agent-run-cancellation.js";
import {commitDocumentReturn,documentReturnGate} from "./document-return-contract.js";
import {readCurrentDocumentReturnWake,readDocumentReturnDelivery} from "./document-return-wake.js";
import {issueService} from "./issues.js";
import {issueTreeControlService} from "./issue-tree-control.js";
import {getExecutionBlocker} from "./execution-blocker.js";
const object=(v:unknown):Record<string,unknown>=>v && typeof v === "object" && !Array.isArray(v) ? v as Record<string,unknown> : {};

/** Server-only exact return. The ordinary issue/run ownership fence remains;
 * no provider, session, workspace, API key or external publication is created. */
export async function executeDocumentReturn(db:Db,input:{companyId:string;issueId:string;agentId:string;runId:string}) {
 return db.transaction(async rawTx=>{
  const tx=rawTx as unknown as Db;
  const [issue]=await tx.select().from(issues).where(and(eq(issues.id,input.issueId),eq(issues.companyId,input.companyId))).for("update");
  const [run]=await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,input.runId),eq(heartbeatRuns.companyId,input.companyId),eq(heartbeatRuns.agentId,input.agentId))).for("update");
  const [actor]=await tx.select().from(agents).where(and(eq(agents.id,input.agentId),eq(agents.companyId,input.companyId))).for("share");
  if (!issue || !run || !actor) throw new Error("document_return_owner_missing");
  const context=object(run.contextSnapshot);
  const binding=await readCurrentDocumentReturnWake(tx,{...input,phase:"server",contextSnapshot:context});
  const paused=Boolean(await issueTreeControlService(tx).getActivePauseHoldGate(input.companyId,input.issueId));
  const unknownEffect=Boolean(await getExecutionBlocker(tx,input.companyId,input.issueId));
  if (!documentReturnGate({binding,expected:context.documentReturn,
    ownerCurrent:issue.assigneeAgentId===input.agentId && issue.executionRunId===input.runId &&
      (issue.checkoutRunId===null || issue.checkoutRunId===input.runId),
    paused:paused || ["paused","terminated","pending_approval","error"].includes(actor.status),
    cancelled:agentRunWritesRevoked(run),unknownEffect})) throw new Error("document_return_admission_revoked");
  const resultJson=object(run.resultJson),receipts={...object(resultJson.semanticToolReceipts)};
  const result=await commitDocumentReturn({binding:binding!,expected:context.documentReturn,runId:run.id,
    readDelivery:()=>readDocumentReturnDelivery(tx,binding!,run.id),
    append:async body=>{
      const comment=await issueService(tx).addComment(issue.id,body,{agentId:actor.id,runId:run.id},
        {authorizationReason:"fixed_document_return",mirrorToSlack:false},tx);
      const [stored]=await tx.select().from(issueComments).where(and(eq(issueComments.id,comment.id),
        eq(issueComments.companyId,input.companyId),eq(issueComments.issueId,input.issueId)));
      if (!stored) throw new Error("document_return_comment_not_read_back");
      return stored;
    },
    saveReceipt:async(key,receipt)=>{
      receipts[key]=receipt;
      await tx.update(heartbeatRuns).set({resultJson:{...resultJson,semanticToolReceipts:receipts},updatedAt:new Date()})
        .where(and(eq(heartbeatRuns.id,run.id),eq(heartbeatRuns.companyId,input.companyId)));
    }});
  // Receipt and terminal state commit together. A crashed response cannot make
  // an accepted comment look unsent; no automatic provider/retry fallback.
  const [terminalRun]=await tx.update(heartbeatRuns).set({status:"succeeded",finishedAt:new Date(),updatedAt:new Date(),
    exitCode:0,executionStatusDeliveryId:randomUUID(),issueCommentStatus:"satisfied",issueCommentSatisfiedByCommentId:result.commentId,issueCommentRetryQueuedAt:null,resultJson:{...resultJson,semanticToolReceipts:receipts,
      documentReturnResult:result,executionRecovery:{kind:"bootstrap",providerWorkStarted:false}}})
    .where(and(eq(heartbeatRuns.id,run.id),eq(heartbeatRuns.companyId,input.companyId))).returning();
  if (!terminalRun) throw new Error("document_return_terminal_receipt_missing");
  return {...result,terminalRun};
 });
}
