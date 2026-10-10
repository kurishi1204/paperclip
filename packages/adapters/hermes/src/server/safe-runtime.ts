import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
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
  for (const key of ["cwd", "worktreeMode", "checkpoints", "verbose"]) {
    if (config[key] !== undefined && config[key] !== null && config[key] !== false && config[key] !== "") {
      throw new Error("Bounded Hermes execution does not accept " + key);
    }
  }
}

function sameFile(before: import("node:fs").Stats, after: import("node:fs").Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino &&
    before.mode === after.mode && before.uid === after.uid && before.gid === after.gid &&
    before.size === after.size && before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs && before.nlink === after.nlink;
}

function pinnedSha256(name: string): string | undefined {
  const value = process.env[name];
  if (value !== undefined && !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Bounded Hermes " + name + " must be a SHA-256 digest");
  }
  return value;
}

async function readSealedFile(file: string, before: import("node:fs").Stats): Promise<Buffer> {
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened)) {
      throw new Error("Bounded Hermes file changed during inspection");
    }
    const data = await handle.readFile();
    if (!sameFile(opened, await handle.stat()) || data.length !== opened.size ||
        !sameFile(opened, await fs.lstat(file))) {
      throw new Error("Bounded Hermes file changed during inspection");
    }
    return data;
  } finally {
    await handle.close();
  }
}

// Hermes 0.21.6 copies its bundled skills into HERMES_HOME on first startup.
// The web-only CLI does not expose skill tools, but a later launch must still
// reject additions or edits in this same-UID extension surface.
export async function hashBoundedHermesSkillsTree(skillsHome: string): Promise<string> {
  const hash = createHash("sha256").update("hermes-bounded-skills-v1\n");
  let entriesSeen = 0;
  let bytesSeen = 0;
  const visit = async (full: string, relative: string): Promise<void> => {
    const before = await fs.lstat(full);
    if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile()) ||
        (process.platform !== "win32" &&
         ((typeof process.getuid === "function" && before.uid !== process.getuid()) ||
          (before.mode & 0o022) !== 0 || (before.mode & 0o7000) !== 0)) ||
        (before.isFile() && before.nlink !== 1)) {
      throw new Error("Bounded Hermes skills tree contains an unsafe entry");
    }
    entriesSeen += 1;
    if (entriesSeen > 5000) throw new Error("Bounded Hermes skills tree exceeds entry limit");
    if (before.isDirectory()) {
      hash.update(JSON.stringify({ path: relative, type: "directory", uid: before.uid,
        gid: before.gid, mode: before.mode & 0o7777 }) + "\n");
      const children = await fs.readdir(full);
      children.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      for (const name of children) {
        await visit(path.join(full, name), relative ? relative + "/" + name : name);
      }
      if (!sameFile(before, await fs.lstat(full))) {
        throw new Error("Bounded Hermes skills tree changed during inspection");
      }
      return;
    }
    bytesSeen += before.size;
    if (bytesSeen > 50_000_000) throw new Error("Bounded Hermes skills tree exceeds byte limit");
    const data = await readSealedFile(full, before);
    hash.update(JSON.stringify({ path: relative, type: "file", uid: before.uid,
      gid: before.gid, mode: before.mode & 0o7777, size: data.length,
      sha256: createHash("sha256").update(data).digest("hex") }) + "\n");
  };
  await visit(skillsHome, "");
  return hash.digest("hex");
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

  // Hermes discovers these from HERMES_HOME before its chat flags have taken
  // effect. Only the operator-pinned bundled skills tree may be non-empty.
  for (const directory of ["plugins", "hooks", "skills", "memories", "cron"]) {
    const target = path.join(home, directory);
    let entry;
    try {
      entry = await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (directory === "skills" && pinnedSha256("PAPERCLIP_HERMES_SKILLS_TREE_SHA256")) {
          throw new Error("Bounded Hermes pinned skills tree is missing");
        }
        continue;
      }
      throw error;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("Bounded Hermes " + directory + " must be a real directory");
    }
    if (process.platform !== "win32" &&
        ((typeof process.getuid === "function" && entry.uid !== process.getuid()) ||
         (entry.mode & 0o077) !== 0)) {
      throw new Error("Bounded Hermes " + directory + " must be private to the runtime user");
    }
    const entries = await fs.readdir(target);
    if (directory === "skills" && entries.length > 0) {
      const expected = pinnedSha256("PAPERCLIP_HERMES_SKILLS_TREE_SHA256");
      if (!expected || await hashBoundedHermesSkillsTree(target) !== expected) {
        throw new Error("Bounded Hermes skills tree does not match the operator pin");
      }
    } else if (entries.length !== 0) {
      throw new Error("Bounded Hermes " + directory + " must be empty");
    } else if (directory === "skills" && pinnedSha256("PAPERCLIP_HERMES_SKILLS_TREE_SHA256")) {
      throw new Error("Bounded Hermes pinned skills tree is missing");
    }
  }

  // --ignore-rules excludes SOUL.md from the CLI's model prompt. Pin the
  // default file generated by Hermes anyway so later CLI behavior cannot
  // silently start consuming an altered identity.
  const soul = path.join(home, "SOUL.md");
  const expectedSoul = pinnedSha256("PAPERCLIP_HERMES_SOUL_SHA256");
  let soulStat;
  try {
    soulStat = await fs.lstat(soul);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (soulStat) {
    if (!soulStat.isFile() || soulStat.isSymbolicLink() || soulStat.nlink !== 1 ||
        soulStat.size > 1_000_000 ||
        (process.platform !== "win32" &&
         ((typeof process.getuid === "function" && soulStat.uid !== process.getuid()) ||
          (soulStat.mode & 0o077) !== 0)) || !expectedSoul ||
        createHash("sha256").update(await readSealedFile(soul, soulStat)).digest("hex") !== expectedSoul) {
      throw new Error("Bounded Hermes SOUL.md does not match the operator pin");
    }
  } else if (expectedSoul) {
    throw new Error("Bounded Hermes pinned SOUL.md is missing");
  }

  // A non-default active profile can replace HERMES_HOME at CLI startup.
  const profile = path.join(home, "active_profile");
  let profileStat;
  try {
    profileStat = await fs.lstat(profile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (profileStat) {
    if (!profileStat.isFile() || profileStat.isSymbolicLink() ||
        (process.platform !== "win32" &&
         ((typeof process.getuid === "function" && profileStat.uid !== process.getuid()) ||
          (profileStat.mode & 0o077) !== 0))) {
      throw new Error("Bounded Hermes active_profile must be a private regular file");
    }
    if ((await fs.readFile(profile, "utf8")).trim() !== "default") {
      throw new Error("Bounded Hermes active_profile must be default");
    }
  }

  // An empty skills home may create this cache after the first chat. Hermes
  // validates only the manifest on reload, so also inspect the cached prompt.
  const snapshot = path.join(home, ".skills_prompt_snapshot.json");
  let snapshotStat;
  try {
    snapshotStat = await fs.lstat(snapshot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (snapshotStat) {
    if (!snapshotStat.isFile() || snapshotStat.isSymbolicLink() ||
        (process.platform !== "win32" &&
         ((typeof process.getuid === "function" && snapshotStat.uid !== process.getuid()) ||
          (snapshotStat.mode & 0o077) !== 0))) {
      throw new Error("Bounded Hermes skills snapshot must be a private regular file");
    }
    let data: unknown;
    try {
      data = JSON.parse(await fs.readFile(snapshot, "utf8"));
    } catch {
      throw new Error("Bounded Hermes skills snapshot must be empty");
    }
    const emptyRecord = (value: unknown): boolean =>
      typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
    if (typeof data !== "object" || data === null || Array.isArray(data) ||
        Object.keys(data).sort().join(",") !== "category_descriptions,manifest,skills,version" ||
        (data as Record<string, unknown>).version !== 1 ||
        !emptyRecord((data as Record<string, unknown>).manifest) ||
        !emptyRecord((data as Record<string, unknown>).category_descriptions) ||
        !Array.isArray((data as Record<string, unknown>).skills) ||
        ((data as Record<string, unknown>).skills as unknown[]).length !== 0) {
      throw new Error("Bounded Hermes skills snapshot must be empty");
    }
  }

  // config.yaml may be created by Hermes onboarding. The operator pins its
  // exact bytes; agents cannot approve an arbitrary plugin/MCP configuration.
  const config = path.join(home, "config.yaml");
  let configStat;
  try {
    configStat = await fs.lstat(config);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const expectedHash = process.env.PAPERCLIP_HERMES_CONFIG_SHA256;
  if (configStat) {
    if (!configStat.isFile() || configStat.isSymbolicLink() ||
        (process.platform !== "win32" &&
         ((typeof process.getuid === "function" && configStat.uid !== process.getuid()) ||
          (configStat.mode & 0o077) !== 0))) {
      throw new Error("Bounded Hermes config.yaml must be a private regular file");
    }
    if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash) ||
        createHash("sha256").update(await fs.readFile(config)).digest("hex") !== expectedHash) {
      throw new Error("Bounded Hermes config.yaml does not match the operator pin");
    }
  } else if (expectedHash) {
    throw new Error("Bounded Hermes pinned config.yaml is missing");
  }

  // Current Hermes loads MCP from config.yaml, but a future CLI may load this
  // file directly. Do not silently adopt it for the web-only worker.
  try {
    await fs.lstat(path.join(home, "mcp.json"));
    throw new Error("Bounded Hermes mcp.json is not supported");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
