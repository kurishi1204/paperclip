/** Evidence returned by Hermes 0.21.6 for a bounded web-search run. */
export interface BoundedWebResult {
  sessionId: string;
  text: string;
  searches: number;
  sourceUrls: string[];
}

/**
 * Parse the CLI's JSONL events, not the model's prose. The run is accepted
 * only when every observed tool call is a successful web_search, the CLI
 * supplies a final exit 0 for the same session, and a search returns an
 * HTTPS source. Executor call IDs correlate parallel results. Legacy events
 * without IDs remain strictly sequential; the two schemas cannot be mixed.
 */
export function parseBoundedWebResult(
  stdout: string,
  options: { exactlyOneSearch?: boolean; requireText?: boolean } = {},
): BoundedWebResult | null {
  let initSession: string | undefined;
  let finalSession: string | undefined;
  let finalText = "";
  let pendingSearch = false;
  let mode: "identified" | "legacy" | undefined;
  const pendingIds = new Set<string>();
  const seenIds = new Set<string>();
  let searches = 0;
  let finished = false;
  const sourceUrls: string[] = [];
  try {
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (finished) return null;
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "system" && event.subtype === "init") {
        if (initSession || typeof event.session_id !== "string" || !event.session_id) return null;
        initSession = event.session_id;
      } else if (event.type === "tool_use") {
        if (!initSession || event.name !== "web_search") return null;
        const hasId = Object.hasOwn(event, "tool_call_id");
        if (hasId) {
          if (mode === "legacy" || typeof event.tool_call_id !== "string" || !event.tool_call_id.trim() ||
              seenIds.has(event.tool_call_id)) return null;
          mode = "identified";
          seenIds.add(event.tool_call_id);
          pendingIds.add(event.tool_call_id);
        } else {
          if (mode === "identified" || pendingSearch) return null;
          mode = "legacy";
          pendingSearch = true;
        }
      } else if (event.type === "tool_result") {
        const hasId = Object.hasOwn(event, "tool_call_id");
        if (mode === "identified") {
          if (!hasId || typeof event.tool_call_id !== "string" || !pendingIds.has(event.tool_call_id)) return null;
          pendingIds.delete(event.tool_call_id);
        } else if (mode !== "legacy" || hasId || !pendingSearch) return null;
        if (event.name !== "web_search" || event.is_error !== false ||
            typeof event.output !== "string" || event.output.endsWith("...")) return null;
        const output = JSON.parse(event.output) as Record<string, unknown>;
        const data = output.data as Record<string, unknown> | undefined;
        const web = data?.web;
        if (output.success !== true || !Array.isArray(web)) return null;
        const urls = web.flatMap((item: unknown) => {
          if (!item || typeof item !== "object") return [];
          const url = (item as Record<string, unknown>).url;
          if (typeof url !== "string") return [];
          try { return new URL(url).protocol === "https:" ? [url] : []; } catch { return []; }
        });
        if (urls.length === 0) return null;
        sourceUrls.push(...urls);
        searches += 1;
        pendingSearch = false;
      } else if (event.type === "result") {
        if (!initSession || pendingSearch || pendingIds.size !== 0 || searches === 0 || finalSession ||
            typeof event.session_id !== "string" || event.session_id !== initSession ||
            event.exit_code !== 0) return null;
        if (event.text !== undefined && typeof event.text !== "string") return null;
        finalSession = event.session_id;
        finalText = typeof event.text === "string" ? event.text : "";
        finished = true;
      }
    }
  } catch {
    return null;
  }
  if (!initSession || !finalSession || !finished || pendingSearch || pendingIds.size !== 0 ||
      (options.exactlyOneSearch && searches !== 1) ||
      (options.requireText && !finalText.trim())) return null;
  return { sessionId: finalSession, text: finalText, searches, sourceUrls };
}
