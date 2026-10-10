import * as fs from "node:fs/promises";
import path from "node:path";
import { sanitizeInheritedPaperclipEnv } from "@paperclipai/adapter-utils/server-utils";

import { HERMES_CLI } from "../shared/constants.js";

// The host can hold credentials for unrelated agents. Pass process settings
// needed by common Python installations, proxies and Windows shims.
const HOST_ENV_KEYS = [
  "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "USER", "LOGNAME",
  "HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
] as const;
const WINDOWS_HOST_ENV_KEYS = [
  "SystemRoot", "WINDIR", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PATHEXT", "COMSPEC",
] as const;
const BOUNDED_CONFIG_ENV_KEYS = new Set([
  "HERMES_HOME",
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
  "ZAI_API_KEY", "KIMI_API_KEY", "MINIMAX_API_KEY",
  "GOOGLE_API_KEY", "GEMINI_API_KEY",
  "EXA_API_KEY", "PARALLEL_API_KEY", "FIRECRAWL_API_KEY",
  "FIRECRAWL_API_URL", "TAVILY_API_KEY", "SEARXNG_URL",
  "BRAVE_SEARCH_API_KEY",
]);
const BOUNDED_DOTENV_KEYS = new Set(
  [...BOUNDED_CONFIG_ENV_KEYS].filter((key) => key !== "HERMES_HOME"),
);
const DENIED_CONFIG_ENV_KEYS = new Set([
  "HERMES_YOLO_MODE", "HERMES_IGNORE_RULES", "HERMES_ACCEPT_HOOKS",
  "HERMES_IGNORE_USER_CONFIG", "BASH_ENV", "ENV", "PYTHONPATH",
  "PYTHONSTARTUP", "NODE_OPTIONS",
]);

export function isBoundedHermesExecution(
  config: Record<string, unknown>,
  agentId: string | undefined,
  hostEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  const pinnedId = hostEnv.PAPERCLIP_HERMES_BOUNDED_AGENT_ID;
  if (pinnedId && agentId === pinnedId) return true;
  if (config.boundedExecution !== undefined && config.boundedExecution !== null && config.boundedExecution !== false) {
    throw new Error("Bounded Hermes execution requires this agent ID to match PAPERCLIP_HERMES_BOUNDED_AGENT_ID");
  }
  return false;
}

function platformPath(platform: NodeJS.Platform): typeof path {
  return (platform === "win32" ? path.win32 : path.posix) as typeof path;
}

function envKey(key: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? key.toUpperCase() : key;
}

function hostValue(hostEnv: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return hostEnv[key];
  const found = Object.keys(hostEnv).find((candidate) => candidate.toUpperCase() === key.toUpperCase());
  return found ? hostEnv[found] : undefined;
}

export function validateHermesExtraArgs(raw: unknown, bounded: boolean): string[] {
  // Standard mode keeps the historical CLI contract; bounded mode never takes
  // agent-configurable arguments, including argparse abbreviations of --yolo.
  if (!bounded) {
    return Array.isArray(raw) && raw.every((arg) => typeof arg === "string") ? raw : [];
  }
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((arg) => typeof arg !== "string")) {
    throw new Error("Bounded Hermes extraArgs must be an empty string array");
  }
  if (raw.length > 0) throw new Error("Bounded Hermes execution does not accept extraArgs");
  return [];
}

export function resolveHermesCommandForConfig(
  config: Record<string, unknown>,
  hostEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const command = typeof config.hermesCommand === "string" && config.hermesCommand
    ? config.hermesCommand
    : typeof config.command === "string" && config.command ? config.command : HERMES_CLI;
  if (config.boundedExecution !== true) return command;
  // Adapter config is agent-writable. Only the operator's server environment
  // may choose a custom binary in bounded mode.
  if (command !== HERMES_CLI) {
    throw new Error("Bounded Hermes execution does not accept a command override");
  }
  const trusted = hostEnv.PAPERCLIP_HERMES_TRUSTED_COMMAND;
  if (!trusted) return HERMES_CLI;
  const paths = platformPath(platform);
  if (!paths.isAbsolute(trusted) || paths.normalize(trusted) !== trusted) {
    throw new Error("PAPERCLIP_HERMES_TRUSTED_COMMAND must be an absolute normalized path");
  }
  return trusted;
}

export function buildHermesChildEnv(
  rawConfigEnv: unknown,
  bounded: boolean,
  hostEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  inheritHostEnv = !bounded,
): Record<string, string> {
  const env: Record<string, string> = {};
  // Standard mode retains the historical host environment, including Git,
  // shell and provider settings. The spawn helper sanitizes Paperclip keys.
  if (inheritHostEnv) {
    for (const [key, value] of Object.entries(sanitizeInheritedPaperclipEnv(hostEnv))) {
      if (typeof value === "string") env[key] = value;
    }
  }
  const hostKeys: readonly string[] = platform === "win32"
    ? [...HOST_ENV_KEYS, ...WINDOWS_HOST_ENV_KEYS]
    : HOST_ENV_KEYS;
  for (const key of hostKeys) {
    const value = hostValue(hostEnv, key, platform);
    if (typeof value === "string") env[key] = value;
  }
  if (platform === "win32" && !env.HOME && env.USERPROFILE) env.HOME = env.USERPROFILE;

  if (rawConfigEnv !== undefined &&
      (typeof rawConfigEnv !== "object" || rawConfigEnv === null || Array.isArray(rawConfigEnv))) {
    if (bounded) throw new Error("Bounded Hermes env must be an object of string values");
    rawConfigEnv = {};
  }
  const configEnv = (rawConfigEnv ?? {}) as Record<string, unknown>;
  for (const [key, rawValue] of Object.entries(configEnv)) {
    const normalized = envKey(key, platform);
    if (normalized === "PAPERCLIP_API_KEY" || normalized === "PAPERCLIP_WAKE_PAYLOAD_JSON") continue;
    if (bounded && DENIED_CONFIG_ENV_KEYS.has(normalized)) {
      throw new Error("Hermes env " + key + " is not allowed");
    }
    if (bounded && (!BOUNDED_CONFIG_ENV_KEYS.has(key) || normalized !== key)) {
      // The server also adds scratch and Git runtime variables to config.env.
      // They are unrelated to web research; ignore them instead of failing a
      // real heartbeat or passing them to the child.
      continue;
    }
    if (typeof rawValue !== "string" && bounded) {
      throw new Error("Bounded Hermes env " + key + " must be a string");
    }
    // Legacy standard configs used scalar values. Keep their stringification
    // while refusing object values that Node cannot meaningfully pass as env.
    if (typeof rawValue === "string" || typeof rawValue === "number" || typeof rawValue === "boolean") {
      env[key] = String(rawValue);
    }
  }

  if (bounded) {
    const hermesHome = env.HERMES_HOME;
    const paths = platformPath(platform);
    if (!hermesHome || !paths.isAbsolute(hermesHome) || paths.normalize(hermesHome) !== hermesHome) {
      throw new Error("Bounded Hermes execution requires a normalized absolute HERMES_HOME");
    }
    const hostHome = env.HOME;
    if (hostHome && (hermesHome === hostHome || hermesHome === paths.join(hostHome, ".hermes"))) {
      throw new Error("Bounded Hermes HERMES_HOME must be separate from the host home");
    }
    const trustedHome = hostEnv.PAPERCLIP_HERMES_BOUNDED_HOME;
    if (!trustedHome || !paths.isAbsolute(trustedHome) || paths.normalize(trustedHome) !== trustedHome) {
      throw new Error("Bounded Hermes execution requires an operator-pinned PAPERCLIP_HERMES_BOUNDED_HOME");
    }
    const sameHome = platform === "win32"
      ? hermesHome.toLowerCase() === trustedHome.toLowerCase()
      : hermesHome === trustedHome;
    if (!sameHome) throw new Error("Bounded Hermes HERMES_HOME does not match the operator-pinned home");
  }
  return env;
}

export function validateBoundedToolsets(raw: string | undefined): void {
  // Until a sandboxed control-plane tool exists, bounded runs are research
  // only. Terminal/file/browser/MCP toolsets can modify the credential home.
  if (raw !== "web") {
    throw new Error("Bounded Hermes execution currently supports only the web toolset");
  }
}

export function validateBoundedRuntimeOptions(config: Record<string, unknown>): void {
  // Research-only runs do not read operator files or ask Hermes to create a
  // worktree/checkpoint. Paperclip-owned assignment context remains available.
  // instructionsFilePath is server-injected for managed instruction bundles.
  // The bounded adapter tolerates it but never reads or injects that file.
  for (const key of ["cwd", "worktreeMode", "checkpoints"]) {
    if (config[key] !== undefined && config[key] !== null && config[key] !== false && config[key] !== "") {
      throw new Error("Bounded Hermes execution does not accept " + key);
    }
  }
}

export async function validateBoundedHermesHome(home: string): Promise<void> {
  const stat = await fs.lstat(home);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Bounded HERMES_HOME must be a real directory");
  if (await fs.realpath(home) !== home) throw new Error("Bounded HERMES_HOME cannot traverse symlinks");
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("Bounded HERMES_HOME must belong to the Paperclip runtime user");
    }
    if ((stat.mode & 0o077) !== 0) throw new Error("Bounded HERMES_HOME must be private to the runtime user");
  }
  for (const file of [".env", "auth.json"]) {
    const target = path.join(home, file);
    let fileStat;
    try {
      fileStat = await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error("Bounded Hermes " + file + " must be a regular file");
    if (process.platform !== "win32" &&
        ((typeof process.getuid === "function" && fileStat.uid !== process.getuid()) ||
         (fileStat.mode & 0o077) !== 0)) {
      throw new Error("Bounded Hermes " + file + " must be private to the runtime user");
    }
    if (file !== ".env") continue;
    const content = await fs.readFile(target, "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (!match || !BOUNDED_DOTENV_KEYS.has(match[1])) {
        throw new Error("Bounded Hermes .env contains an unsupported setting");
      }
    }
  }
}
