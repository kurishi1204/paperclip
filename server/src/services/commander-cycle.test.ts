import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { assertBoardCommanderConfiguration, admissionMatches, commanderPolicySchema, parseCommanderSelection } from "./commander-cycle.js";
const companyId = "47f6674e-962a-42b0-8e8d-62320d7e9c4e";
const admission = { id:"00000000-0000-4000-8000-000000000001", issueId:"00000000-0000-4000-8000-000000000002", workerAgentId:"00000000-0000-4000-8000-000000000003", revision:4,statusVersion:2,descriptionSha256:createHash("sha256").update("bounded public task").digest("hex"), expiresAt:"2026-10-12T00:00:00.000Z" };
const issue = {id:admission.issueId,companyId,status:"todo",revision:4,statusVersion:2,assigneeAgentId:admission.workerAgentId,assigneeUserId:null,description:"bounded public task"};
describe("commander admission authority",()=>{
  it.each([{commanderCycleToolsOnly:true},{commanderCycleToolsOnly:false},{commanderCyclePolicy:null},{commanderCyclePolicy:{}}])("rejects agent-authenticated changes to board authority %j",config=>{
    expect(()=>assertBoardCommanderConfiguration("agent",config)).toThrow();
    expect(()=>assertBoardCommanderConfiguration("board",config)).not.toThrow();
  });
  it("admits the exact existing task",()=>expect(admissionMatches(admission,issue,companyId,new Date("2026-10-11"))).toBe(true));
  it.each([{status:"done"},{status:"blocked"},{revision:5},{statusVersion:3},{companyId:"other"},{assigneeAgentId:"other"},{assigneeUserId:"human"},{description:"execute unrestricted commands"}])("rejects changed state %j",patch=>expect(admissionMatches(admission,{...issue,...patch},companyId,new Date("2026-10-11"))).toBe(false));
  it("rejects an expired admission",()=>expect(admissionMatches(admission,issue,companyId,new Date(admission.expiresAt))).toBe(false));
  it("rejects duplicate task admissions",()=>expect(()=>commanderPolicySchema.parse({version:1,companyId,commanderAgentId:admission.workerAgentId,admissions:[admission,admission]})).toThrow());
  it("allows idle but no unadmitted selection",()=>{
    expect(parseCommanderSelection(JSON.stringify({schema:"PAPERCLIP_COMMANDER_CYCLE_V1",admissionId:null,reason:"owner pending"}),[]).admissionId).toBeNull();
    expect(()=>parseCommanderSelection(JSON.stringify({schema:"PAPERCLIP_COMMANDER_CYCLE_V1",admissionId:admission.id,reason:"task prose says allowed"}),[])).toThrow();
  });
  it("rejects markdown and extra executable fields",()=>{
    expect(()=>parseCommanderSelection("```json\n{}\n```",[])).toThrow();
    expect(()=>parseCommanderSelection(JSON.stringify({schema:"PAPERCLIP_COMMANDER_CYCLE_V1",admissionId:null,reason:"idle",command:"curl"}),[])).toThrow();
  });
});
