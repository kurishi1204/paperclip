import { z } from "zod";

/** A compare-and-set update to two non-secret controls on a paused protected agent. */
export const agentContinuityControlsPatchSchema = z.object({
  expectedUpdatedAt: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/),
  blockAssignment: z.boolean(),
  wakeOnDemand: z.boolean(),
}).strict();

export type AgentContinuityControlsPatch = z.infer<typeof agentContinuityControlsPatchSchema>;
