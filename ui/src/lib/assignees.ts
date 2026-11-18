export interface AssigneeSelection {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface AssigneeOption {
  id: string;
  label: string;
  searchText?: string;
}

interface CommentAssigneeSuggestionInput {
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
}

interface CommentAssigneeSuggestionComment {
  authorAgentId?: string | null;
  authorUserId?: string | null;
}

export function assigneeValueFromSelection(selection: Partial<AssigneeSelection>): string {
  if (selection.assigneeAgentId) return `agent:${selection.assigneeAgentId}`;
  if (selection.assigneeUserId) return `user:${selection.assigneeUserId}`;
  return "";
}

export function suggestedCommentAssigneeValue(
  issue: CommentAssigneeSuggestionInput,
  comments: CommentAssigneeSuggestionComment[] | null | undefined,
  currentUserId: string | null | undefined,
  currentAgentId?: string | null | undefined,
): string {
  if (comments && comments.length > 0 && (currentUserId || currentAgentId)) {
    for (let i = comments.length - 1; i >= 0; i--) {
      const comment = comments[i];
      if (comment.authorAgentId && comment.authorAgentId !== currentAgentId) {
        return assigneeValueFromSelection({ assigneeAgentId: comment.authorAgentId });
      }
      if (comment.authorUserId && comment.authorUserId !== currentUserId) {
        return assigneeValueFromSelection({ assigneeUserId: comment.authorUserId });
      }
    }
  }

  return assigneeValueFromSelection(issue);
}

export function parseAssigneeValue(value: string): AssigneeSelection {
  if (!value) {
    return { assigneeAgentId: null, assigneeUserId: null };
  }
  if (value.startsWith("agent:")) {
    const assigneeAgentId = value.slice("agent:".length);
    return { assigneeAgentId: assigneeAgentId || null, assigneeUserId: null };
  }
  if (value.startsWith("user:")) {
    const assigneeUserId = value.slice("user:".length);
    return { assigneeAgentId: null, assigneeUserId: assigneeUserId || null };
  }
  // Backward compatibility for older drafts/defaults that stored a raw agent id.
  return { assigneeAgentId: value, assigneeUserId: null };
}

export function currentUserAssigneeOption(currentUserId: string | null | undefined): AssigneeOption[] {
  if (!currentUserId) return [];
  return [{
    id: assigneeValueFromSelection({ assigneeUserId: currentUserId }),
    label: "Me",
    searchText: currentUserId === "local-board" ? "me board human local-board" : `me human ${currentUserId}`,
  }];
}

export function formatAssigneeUserLabel(
  userId: string | null | undefined,
  currentUserId: string | null | undefined,
  userLabels?: ReadonlyMap<string, string> | Record<string, string> | null,
): string | null {
  if (!userId) return null;
  if (currentUserId && userId === currentUserId) return "You";
  return formatUserLabel(userId, userLabels);
}

export function formatUserLabel(
  userId: string | null | undefined,
  userLabels?: ReadonlyMap<string, string> | Record<string, string> | null,
): string | null {
  if (!userId) return null;
  if (userLabels) {
    const label = userLabels instanceof Map
      ? userLabels.get(userId)
      : (userLabels as Record<string, string>)[userId];
    if (typeof label === "string" && label.trim()) return label;
  }
  if (userId === "local-board") return "Board";
  return userId.slice(0, 5);
}


/** A cancellation receipt is not proof of the current assignment or permission to replay. */
export function assignmentFailureNotice(
  errorBody: unknown,
  expectedIssueId: string,
  assigneeLabel: (selection: AssigneeSelection) => string | null,
): { title: string; body: string } | null {
  const record = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  const body = record(errorBody);
  const failure = record(body?.issueMutation) ?? record(record(body?.details)?.issueMutation);
  const cancellation = record(failure?.runCancellation);
  const ownership = record(failure?.lastObservedOwnership);
  const idOrNull = (value: unknown): value is string | null =>
    value === null || (typeof value === "string" && value.length > 0);
  if (!failure || failure.issueId !== expectedIssueId ||
      typeof failure.issueMutationStopId !== "string" || !failure.issueMutationStopId ||
      cancellation?.observedStatus !== "cancelled" || cancellation.evidence !== "cancelRun_return" ||
      typeof cancellation.runId !== "string" || !cancellation.runId ||
      !["not_attempted", "outcome_unknown"].includes(String(failure.assignmentWrite)) ||
      failure.currentOwnership !== "unverified" || failure.automaticRetry !== false ||
      failure.nextAction !== "read_issue_and_run_before_owner_decision" ||
      !ownership || !["request_read", "locked_before_update"].includes(String(ownership.source)) ||
      !Number.isInteger(ownership.revision) || Number(ownership.revision) < 0 ||
      !Number.isInteger(ownership.statusVersion) || Number(ownership.statusVersion) < 0 ||
      !idOrNull(ownership.assigneeAgentId) || !idOrNull(ownership.assigneeUserId) ||
      (ownership.assigneeAgentId !== null && ownership.assigneeUserId !== null)) return null;

  const selection = {
    assigneeAgentId: ownership.assigneeAgentId,
    assigneeUserId: ownership.assigneeUserId,
  };
  const label = assigneeLabel(selection);
  const lastObserved = label
    ? `Last observed assignee: ${label}.`
    : selection.assigneeAgentId || selection.assigneeUserId
      ? "An assignee was recorded in the last ownership observation."
      : "No assignee was recorded in the last ownership observation.";
  const writeOutcome = failure.assignmentWrite === "not_attempted"
    ? "This request did not attempt the assignment change."
    : "The assignment change result is unknown.";
  return {
    title: "Assignment needs confirmation",
    body: `The previous run is marked cancelled. Its processes have not been verified as stopped. ${writeOutcome} ${lastObserved} This observation does not verify the current assignee. Check the current task and run before deciding what to do. Do not resubmit this change.`,
  };
}
