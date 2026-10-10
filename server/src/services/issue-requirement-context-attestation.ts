import { normalizedContentHash } from "@paperclipai/shared/portability-hash";

// Written with the Run context in one transaction by heartbeat. The projection
// compares the whole runtime context to this receipt, including execution
// controls and fields added by future heartbeat versions.
export const ISSUE_REQUIREMENT_CONTEXT_HASH_KEY = "_paperclipIssueRequirementContextHash";

export function issueRequirementContextHash(context: Record<string, unknown>): string {
  // Match the JSONB value PostgreSQL stores: runtime context can contain Date
  // instances, which the JSON serializer turns into ISO strings.
  return normalizedContentHash(JSON.parse(JSON.stringify(context)));
}
