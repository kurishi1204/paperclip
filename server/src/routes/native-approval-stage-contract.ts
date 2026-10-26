import { z } from "zod";

// The dedicated native-run endpoint and its OpenAPI operation share this
// strict wire contract. Ordinary Issue PATCH does not accept these preconditions.
export const nativeApprovalStageDecisionSchema = z.object({
  decision: z.enum(["approve", "request_changes"]),
  summary: z.string().trim().min(1).max(20_000),
  expectedStageId: z.string().uuid(),
  expectedStatusVersion: z.number().int().nonnegative(),
  expectedRevision: z.number().int().nonnegative(),
  expectedLastDecisionId: z.string().uuid().nullable(),
}).strict();

export type NativeApprovalStageDecision = z.infer<typeof nativeApprovalStageDecisionSchema>;
