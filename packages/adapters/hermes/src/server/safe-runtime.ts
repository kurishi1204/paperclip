import path from "node:path";

// The server may hold credentials for unrelated agents. Only process settings
// needed to launch Hermes cross this boundary without explicit configuration.
const HOST_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "USER", "LOGNAME"] as const;
const BOUNDED_CONFIG_ENV_KEYS = new Set([
  ...HOST_ENV_KEYS,
  "HERMES_HOME",
  "HOME",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ZAI_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "EXA_API_KEY",
  "PARALLEL_API_KEY",
  "FIRECRAWL_API_KEY",
  "FIRECRAWL_API_URL",
  "TAVILY_API_KEY",
  "SEARXNG_URL",
  "BRAVE_SEARCH_API_KEY",
]);

const DENIED_EXTRA_ARG = /^--(?:yolo|ignore-rules|accept-hooks)(?:=|$)/i;
const DENIED_CONFIG_ENV_KEYS = new Set([
  "HERMES_YOLO_MODE", "HERMES_IGNORE_RULES", "HERMES_ACCEPT_HOOKS",
  "BASH_ENV", "ENV", "PYTHONPATH", "PYTHONSTARTUP", "NODE_OPTIONS",
]);

export function validateHermesExtraArgs(raw: unknown, bounded: boolean): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((arg) => typeof arg !== "string")) {
    throw new Error("Hermes extraArgs must be a string array");
  }
  const args = raw as string[];
  if (args.some((arg) => DENIED_EXTRA_ARG.test(arg) || /[\u0000-\u001f]/.test(arg))) {
    throw new Error("Hermes approval bypass and control characters are not allowed in extraArgs");
  }
  if (!bounded) return args;
  if (args.length === 0) return args;
  throw new Error("Bounded Hermes execution does not accept extraArgs");
}

export function buildHermesChildEnv(
  rawConfigEnv: unknown,
  bounded: boolean,
  hostEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of HOST_ENV_KEYS) {
    if (typeof hostEnv[key] === "string") env[key] = hostEnv[key];
  }
  if (typeof hostEnv.HOME === "string") env.HOME = hostEnv.HOME;

  if (rawConfigEnv !== undefined &&
      (typeof rawConfigEnv !== "object" || rawConfigEnv === null || Array.isArray(rawConfigEnv))) {
    throw new Error("Hermes env must be an object of string values");
  }
  const configEnv = (rawConfigEnv ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(configEnv)) {
    // These are always minted by the Paperclip harness. A stale adapter value
    // must not impersonate a run or carry wake data into a later run.
    if (key === "PAPERCLIP_API_KEY" || key === "PAPERCLIP_WAKE_PAYLOAD_JSON") continue;
    if (typeof value !== "string") throw new Error(`Hermes env ${key} must be a string`);
    if (DENIED_CONFIG_ENV_KEYS.has(key)) {
      throw new Error(`Hermes env ${key} is not allowed`);
    }
    if (bounded && !BOUNDED_CONFIG_ENV_KEYS.has(key)) {
      throw new Error(`Hermes env ${key} is not allowed in bounded execution`);
    }
    env[key] = value;
  }

  if (bounded) {
    const hermesHome = env.HERMES_HOME;
    if (!hermesHome || !path.isAbsolute(hermesHome) || path.normalize(hermesHome) !== hermesHome) {
      throw new Error("Bounded Hermes execution requires a normalized absolute HERMES_HOME");
    }
    if (configEnv.HOME !== undefined && configEnv.HOME !== hermesHome) {
      throw new Error("Bounded Hermes HOME must equal HERMES_HOME");
    }
    // Keep Python, Hermes and child tools inside the dedicated home. The CLI
    // uses HERMES_HOME directly, while libraries may still consult HOME.
    env.HOME = hermesHome;
  }
  return env;
}
