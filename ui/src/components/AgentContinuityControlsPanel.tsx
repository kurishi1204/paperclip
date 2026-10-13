import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentContinuityControls } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { ToggleSwitch } from "./ui/toggle-switch";

type Draft = {
  agentId: string;
  expectedUpdatedAt: string;
  initialBlockAssignment: boolean;
  initialWakeOnDemand: boolean;
  blockAssignment: boolean;
  wakeOnDemand: boolean;
  dirty: boolean;
};

function draftFrom(current: AgentContinuityControls): Draft | null {
  if (current.blockAssignment === null || current.wakeOnDemand === null) return null;
  return {
    agentId: current.id,
    expectedUpdatedAt: current.updatedAt,
    initialBlockAssignment: current.blockAssignment,
    initialWakeOnDemand: current.wakeOnDemand,
    blockAssignment: current.blockAssignment,
    wakeOnDemand: current.wakeOnDemand,
    dirty: false,
  };
}

/** Keeps the sensitive general agent configuration out of this two-flag UI. */
export function AgentContinuityControlsPanel({ agentId, companyId, detailRef }: {
  agentId: string; companyId: string; detailRef?: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const key = ["agents", agentId, "continuity-controls"] as const;
  const controls = useQuery({
    queryKey: key,
    queryFn: () => agentsApi.getContinuityControls(agentId, companyId),
  });
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    const current = controls.data;
    setDraft((previous) => {
      if (!current || current.id !== agentId) return null;
      // A background query refresh must not erase choices or replace the CAS
      // revision that the operator originally edited.
      if (previous?.agentId === current.id && previous.dirty) return previous;
      return draftFrom(current);
    });
  }, [agentId, controls.data]);

  const save = useMutation({
    mutationFn: async () => {
      const current = controls.data;
      if (!current || !draft) throw new Error("Read the continuity controls again");
      if (current.updatedAt !== draft.expectedUpdatedAt) {
        throw new Error("Agent controls changed; reload them before saving");
      }
      return agentsApi.patchContinuityControls(agentId, {
        expectedUpdatedAt: draft.expectedUpdatedAt,
        blockAssignment: draft.blockAssignment,
        wakeOnDemand: draft.wakeOnDemand,
      }, companyId);
    },
    onSuccess: (updated: AgentContinuityControls) => {
      setDraft(draftFrom(updated));
      queryClient.setQueryData(key, updated);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
      if (detailRef && detailRef !== agentId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(detailRef) });
      }
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
  const eligible = current?.eligible === true;
  const stale = Boolean(draft && current && draft.agentId === current.id
    && draft.expectedUpdatedAt !== current.updatedAt);
  const changed = Boolean(draft && (draft.blockAssignment !== draft.initialBlockAssignment
    || draft.wakeOnDemand !== draft.initialWakeOnDemand));

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
      {stale ? <div className="space-y-2 text-sm" role="status">
        <p>These controls changed while you were editing. Your choices are preserved; reload before saving.</p>
        <Button type="button" disabled={save.isPending} onClick={() => current && setDraft(draftFrom(current))}>
          Reload continuity controls
        </Button>
      </div> : null}
      {eligible && draft ? <>
        <div className="flex items-center justify-between gap-4 text-sm">
          <span>Block task assignment</span>
          <ToggleSwitch aria-label="Block task assignment" checked={draft.blockAssignment} disabled={save.isPending}
            onCheckedChange={(blockAssignment) => setDraft((previous) => previous && { ...previous, blockAssignment, dirty: true })} />
        </div>
        <div className="flex items-center justify-between gap-4 text-sm">
          <span>Wake on demand</span>
          <ToggleSwitch aria-label="Wake on demand" checked={draft.wakeOnDemand} disabled={save.isPending}
            onCheckedChange={(wakeOnDemand) => setDraft((previous) => previous && { ...previous, wakeOnDemand, dirty: true })} />
        </div>
        <p className="text-xs text-muted-foreground">
          Clearing the block still requires a separate assignment grant and an explicit operator action.
        </p>
        <Button type="button" disabled={!changed || stale || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving..." : "Save continuity controls"}
        </Button>
      </> : null}
    </section>
  );
}
