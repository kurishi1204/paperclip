import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentContinuityControls } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { ToggleSwitch } from "./ui/toggle-switch";

/** Keeps the sensitive general agent configuration out of this two-flag UI. */
export function AgentContinuityControlsPanel({ agentId, companyId }: { agentId: string; companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const key = ["agents", agentId, "continuity-controls"] as const;
  const controls = useQuery({
    queryKey: key,
    queryFn: () => agentsApi.getContinuityControls(agentId, companyId),
  });
  const [draft, setDraft] = useState<{ blockAssignment: boolean; wakeOnDemand: boolean } | null>(null);

  useEffect(() => {
    const current = controls.data;
    setDraft(current && current.blockAssignment !== null && current.wakeOnDemand !== null
      ? { blockAssignment: current.blockAssignment, wakeOnDemand: current.wakeOnDemand }
      : null);
  }, [controls.data]);

  const save = useMutation({
    mutationFn: async () => {
      const current = controls.data;
      if (!current || !draft) throw new Error("Read the continuity controls again");
      return agentsApi.patchContinuityControls(agentId, {
        expectedUpdatedAt: current.updatedAt,
        blockAssignment: draft.blockAssignment,
        wakeOnDemand: draft.wakeOnDemand,
      }, companyId);
    },
    onSuccess: (updated: AgentContinuityControls) => {
      queryClient.setQueryData(key, updated);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.configRevisions(agentId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
      pushToast({ title: "Continuity controls saved", tone: "success" });
    },
    onError: (error) => {
      void controls.refetch();
      pushToast({
        title: "Continuity controls were not saved",
        body: error instanceof ApiError || error instanceof Error ? error.message : "Read the controls again",
        tone: "error",
      });
    },
  });

  const current = controls.data;
  const eligible = current?.status === "paused" && current.role !== "ceo"
    && current.assignmentMode === "protected" && current.heartbeatEnabled === false
    && current.canAssignTasks === false && current.canCreateAgents !== true
    && current.blockAssignment !== null && current.wakeOnDemand !== null;
  const changed = draft && current
    && (draft.blockAssignment !== current.blockAssignment || draft.wakeOnDemand !== current.wakeOnDemand);

  return (
    <section className="rounded-lg border border-border p-4 space-y-4">
      <div>
        <h3 className="text-sm font-medium">Paused agent continuity</h3>
        <p className="text-xs text-muted-foreground">
          Changes only assignment blocking and on-demand wake. Saving does not resume or wake the agent.
        </p>
      </div>
      {controls.isLoading ? <p className="text-sm text-muted-foreground">Loading controls...</p> : null}
      {controls.isError ? <p className="text-sm text-destructive">Could not read these controls.</p> : null}
      {current && !eligible ? <p className="text-sm text-muted-foreground">This agent is not eligible for scoped continuity changes.</p> : null}
      {eligible && draft ? <>
        <div className="flex items-center justify-between gap-4 text-sm">
          <span>Block task assignment</span>
          <ToggleSwitch aria-label="Block task assignment" checked={draft.blockAssignment} disabled={save.isPending}
            onCheckedChange={(blockAssignment) => setDraft((previous) => previous && { ...previous, blockAssignment })} />
        </div>
        <div className="flex items-center justify-between gap-4 text-sm">
          <span>Wake on demand</span>
          <ToggleSwitch aria-label="Wake on demand" checked={draft.wakeOnDemand} disabled={save.isPending}
            onCheckedChange={(wakeOnDemand) => setDraft((previous) => previous && { ...previous, wakeOnDemand })} />
        </div>
        <p className="text-xs text-muted-foreground">
          Clearing the block still requires a separate assignment grant and an explicit operator action.
        </p>
        <Button type="button" disabled={!changed || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving..." : "Save continuity controls"}
        </Button>
      </> : null}
    </section>
  );
}
