import type { AcpPermissionDecision, AcpPermissionRequest } from "acpx/runtime";
import type { HarnessRuntimeRequestResolution } from "../../contracts/harness-driver.js";
import { cursorToolIdentity } from "./cursor-plan-tool-identity.js";
import { redactPaperclipSemanticValue } from "../../semantic-tools/redaction.js";


export type AcpxPermissionAction = "accept" | "accept_for_session" | "decline" | "cancel";
export interface NormalizedAcpxPermission {
  title: string;
  kind: string;
  toolCallId: string;
  choices: Array<{ key: AcpxPermissionAction; label: string }>;
  resolve(resolution: HarnessRuntimeRequestResolution): AcpPermissionDecision;
}

/** Provider options describe choices, never authority to execute an operation. */
export function normalizeAcpxPermission(request: AcpPermissionRequest, options: { allowAlwaysScope?: "session"; provider?: string; workingDirectory?: string } = {}): NormalizedAcpxPermission {
  const raw = request.raw;
  if (!raw || !Array.isArray(raw.options) || raw.options.length > 32) {
    throw new Error("ACP permission request has invalid options");
  }
  const byKind = new Map<string, { optionId: string; name: string }>();
  const ids = new Set<string>();
  for (const option of raw.options) {
    if (!option || !["allow_once", "allow_always", "reject_once", "reject_always"].includes(option.kind)
      || typeof option.optionId !== "string" || !option.optionId || option.optionId.length > 160
      || typeof option.name !== "string" || !option.name || option.name.length > 500
      || ids.has(option.optionId) || byKind.has(option.kind)) {
      // ACPX resolves by kind. Ambiguous kinds must not select a different option.
      throw new Error("ACP permission request has ambiguous or unsupported options");
    }
    ids.add(option.optionId);
    byKind.set(option.kind, { optionId: option.optionId, name: option.name });
  }
  const call = raw.toolCall;
  if (!call || typeof call.toolCallId !== "string" || !call.toolCallId || call.toolCallId.length > 240
    || (options.provider === "cursor" && !call.toolCallId.trim())) {
    throw new Error("ACP permission request omitted its tool identity");
  }
  const bindings = new Map<AcpxPermissionAction, AcpPermissionDecision["outcome"]>();
  const choices: NormalizedAcpxPermission["choices"] = [];
  for (const [key, kind, label] of [
    ["accept", "allow_once", "Allow once"],
    ["accept_for_session", "allow_always", "Allow for session"],
    ["decline", "reject_once", "Deny"],
  ] as const) {
    if (kind === "allow_always" && options.allowAlwaysScope !== "session") continue;
    if (byKind.has(kind)) { bindings.set(key, kind); choices.push({ key, label }); }
  }
  // A permanent rejection is not silently substituted for a one-time denial.
  bindings.set("cancel", "cancel");
  choices.push({ key: "cancel", label: "Cancel" });
  return {
    title: permissionTitle(call.title, call.rawInput),
    kind: request.inferredKind ?? "other",
    // Display/durable identity must match the tool-event boundary. Leave the
    // original request intact for ACPX's exact native response correlation.
    toolCallId: options.provider === "cursor" ? cursorToolIdentity(call.toolCallId) : call.toolCallId,
    choices,
    resolve(resolution) {
      const outcome = bindings.get(resolution.action as AcpxPermissionAction);
      if (!outcome || "answers" in resolution || "content" in resolution || "response" in resolution) {
        throw new Error("ACP permission resolution is not an offered choice");
      }
      return { outcome } as AcpPermissionDecision;
    },
  };
}

/** Display-only: arguments never change permission choices or authorization. */
function permissionTitle(title: unknown, input: unknown): string {
  const heading = typeof title === "string" && title.trim()
    ? title.slice(0, 4_000) : "Approve provider operation";
  if (input === undefined) return heading;
  const inputHeading = heading.slice(0, 2_000);
  const args = JSON.stringify(redactPaperclipSemanticValue(input));
  const suffix = `\nArguments: ${args}`;
  return inputHeading.length + suffix.length <= 4_000
    ? inputHeading + suffix
    : `${inputHeading}\nArguments omitted: ${Buffer.byteLength(args)} bytes after redaction exceed the permission display limit.`;
}
