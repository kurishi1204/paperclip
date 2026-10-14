import { ADAPTER_AGNOSTIC_KEYS, type Agent } from "@paperclipai/shared";

export interface AgentConfigOverlay {
  identity: Record<string, unknown>;
  adapterType?: string;
  adapterConfig: Record<string, unknown>;
  heartbeat: Record<string, unknown>;
  debug: Record<string, unknown>;
  runtime: Record<string, unknown>;
}

export function omitUndefinedEntries(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

export function buildAgentUpdatePatch(agent: Agent, overlay: AgentConfigOverlay) {
  const patch: Record<string, unknown> = {};

  if (Object.keys(overlay.identity).length > 0) {
    Object.assign(patch, overlay.identity);
  }

  if (overlay.adapterType !== undefined) {
    patch.adapterType = overlay.adapterType;
  }

  if (overlay.adapterType !== undefined || Object.keys(overlay.adapterConfig).length > 0) {
    const existing = (agent.adapterConfig ?? {}) as Record<string, unknown>;
    const nextAdapterConfig =
      overlay.adapterType !== undefined
        ? {
            ...Object.fromEntries(
              ADAPTER_AGNOSTIC_KEYS
                .filter((key) => existing[key] !== undefined)
                .map((key) => [key, existing[key]]),
            ),
            ...overlay.adapterConfig,
          }
        : {
            ...existing,
            ...overlay.adapterConfig,
          };

    patch.adapterConfig = omitUndefinedEntries(nextAdapterConfig);
    patch.replaceAdapterConfig = true;
  }

  if (Object.keys(overlay.runtime).length > 0) {
    Object.assign(patch, overlay.runtime);
  }

  if (
    overlay.runtime.runtimeConfig !== undefined
    || Object.keys(overlay.heartbeat).length > 0
    || Object.keys(overlay.debug).length > 0
  ) {
    // Keep explicit clears through every merge; omit them only at the end.
    const nextRuntimeConfig: Record<string, unknown> = {
      ...agent.runtimeConfig,
      ...(overlay.runtime.runtimeConfig as Record<string, unknown> | undefined),
    };

    if (Object.keys(overlay.heartbeat).length > 0) {
      const existingHb = (nextRuntimeConfig.heartbeat ?? {}) as Record<string, unknown>;
      nextRuntimeConfig.heartbeat = { ...existingHb, ...overlay.heartbeat };
    }
    if (Object.keys(overlay.debug).length > 0) {
      const existingDebug = (nextRuntimeConfig.debug ?? {}) as Record<string, unknown>;
      const nextDebug = omitUndefinedEntries({ ...existingDebug, ...overlay.debug });
      if (Object.keys(nextDebug).length === 0) delete nextRuntimeConfig.debug;
      else nextRuntimeConfig.debug = nextDebug;
    }
    patch.runtimeConfig = omitUndefinedEntries(nextRuntimeConfig);
  }

  return patch;
}
