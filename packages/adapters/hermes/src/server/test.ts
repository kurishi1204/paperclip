/**
 * Environment test for the Hermes Agent adapter.
 *
 * Verifies that Hermes Agent is installed, accessible, and configured
 * before allowing the adapter to be used.
 */

import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck,
} from "@paperclipai/adapter-utils";

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { promisify } from "node:util";

import { HERMES_CLI, DEFAULT_MODEL, ADAPTER_TYPE, VALID_PROVIDERS } from "../shared/constants.js";
import { detectModel, resolveProvider, inferProviderFromModel } from "./detect-model.js";
import { resolveHermesCommand } from "./execute.js";
import { parseBoundedWebResult } from "./bounded-output.js";
import { buildHermesChildEnv, isBoundedHermesExecution, validateBoundedHermesCommand, validateBoundedHermesHome, validateBoundedRuntimeOptions, validateBoundedToolsets, validateHermesExtraArgs } from "./safe-runtime.js";

const execFileAsync = promisify(execFile);

// Hermes 0.21.6 emits JSON lines in stream-json mode. A model response alone
// cannot prove that its web tool was exposed or that the search backend worked.
export function verifyBoundedWebProbe(stdout: string): boolean {
  return parseBoundedWebResult(stdout, { exactlyOneSearch: true }) !== null;
}

function boundedProbeFailure(error: unknown): string {
  const failure = error as { code?: unknown; signal?: unknown; killed?: unknown; stderr?: unknown };
  if (failure.killed === true || failure.code === "ETIMEDOUT") return "timeout";
  const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
  const category = /No web search provider configured/i.test(stderr) ? "search_backend_missing" :
    /onboard|setup required/i.test(stderr) ? "onboarding_required" :
    /auth|login|credential|api.key/i.test(stderr) ? "authentication_failed" :
    /approval|permission denied/i.test(stderr) ? "tool_approval_failed" :
    "cli_or_search_failed";
  const exit = typeof failure.code === "number" ? `; exit=${failure.code}` :
    typeof failure.signal === "string" ? `; signal=${failure.signal}` : "";
  // Never copy raw stderr into a Paperclip check: a provider may echo tokens.
  return category + exit;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function checkCliInstalled(
  command: string,
  env: Record<string, string>,
): Promise<AdapterEnvironmentCheck | null> {
  try {
    // Try to run the command to see if it exists
    await execFileAsync(command, ["--version"], { env, timeout: 30_000 });
    return null; // OK — it ran successfully
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return {
        level: "error",
        message: `Hermes CLI "${command}" not found in PATH`,
        hint: "Install Hermes Agent: pip install hermes-agent",
        code: "hermes_cli_not_found",
      };
    }
    return {
      level: "error",
      message: "Hermes CLI exists but could not start with the selected runtime environment",
      hint: "Check the Hermes executable and its Python installation under this service account.",
      code: "hermes_cli_unusable",
    };
  }
}

async function checkCliVersion(
  command: string,
  env: Record<string, string>,
): Promise<AdapterEnvironmentCheck | null> {
  try {
    const { stdout } = await execFileAsync(command, ["--version"], {
      env, timeout: 30_000,
    });
    const version = stdout.trim();
    if (version) {
      return {
        level: "info",
        message: `Hermes Agent version: ${version}`,
        code: "hermes_version",
      };
    }
    return {
      level: "warn",
      message: "Could not determine Hermes Agent version",
      code: "hermes_version_unknown",
    };
  } catch {
    return {
      level: "warn",
      message:
        "Could not determine Hermes Agent version (hermes --version failed)",
      hint: "Make sure the hermes CLI is properly installed and functional",
      code: "hermes_version_failed",
    };
  }
}

function checkModel(
  config: Record<string, unknown>,
): AdapterEnvironmentCheck | null {
  const model = asString(config.model);
  if (!model) {
    return {
      level: "info",
      message: "No model specified — Hermes will use its configured default model",
      hint: "Set a model explicitly in Paperclip only if you want to override your local Hermes configuration.",
      code: "hermes_configured_default_model",
    };
  }
  return {
    level: "info",
    message: `Model: ${model}`,
    code: "hermes_model_configured",
  };
}

async function checkApiKeys(
  config: Record<string, unknown>,
  detectedConfig: Awaited<ReturnType<typeof detectModel>> | null,
  childEnv: Record<string, string>,
): Promise<AdapterEnvironmentCheck | null> {
  // The server resolves secret refs into config.env before calling testEnvironment.
  // Bounded children do not inherit host provider keys; standard mode keeps
  // the historical host environment.
  const envConfig = childEnv;
  const resolvedEnv = childEnv;

  // Read the same Hermes home that execute() will use. Never credit host keys
  // or a global ~/.hermes file as evidence for a bounded child process.
  const hermesEnvKeys: Record<string, string> = {};
  try {
    const hermesHome = asString(envConfig.HERMES_HOME) ||
      path.join(asString(envConfig.HOME) || process.env.HOME || process.env.USERPROFILE || "/root", ".hermes");
    const hermesEnvPath = path.join(hermesHome, ".env");
    const content = readFileSync(hermesEnvPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.substring(0, eqIdx).trim();
        const value = trimmed.substring(eqIdx + 1).trim();
        if (value.length > 0) hermesEnvKeys[key] = value;
      }
    }
  } catch {
    // ~/.hermes/.env may not exist — that's fine
  }

  const has = (key: string): boolean =>
    !!(resolvedEnv[key] ?? hermesEnvKeys[key]);

  const hasAnthropic = has("ANTHROPIC_API_KEY");
  const hasOpenRouter = has("OPENROUTER_API_KEY");
  const hasOpenAI = has("OPENAI_API_KEY");
  const hasZai = has("ZAI_API_KEY");
  const hasKimi = has("KIMI_API_KEY");
  const hasMiniMax = has("MINIMAX_API_KEY");

  const providers: string[] = [];
  if (hasAnthropic) providers.push("Anthropic");
  if (hasOpenRouter) providers.push("OpenRouter");
  if (hasOpenAI) providers.push("OpenAI");
  if (hasZai) providers.push("Z.AI");
  if (hasKimi) providers.push("Kimi");
  if (hasMiniMax) providers.push("MiniMax");

  if (providers.length > 0) {
    return {
      level: "info",
      message: `API keys found: ${providers.join(", ")}`,
      code: "hermes_api_keys_found",
    };
  }

  if (config.provider === "openai-codex") {
    const home = asString(envConfig.HERMES_HOME);
    if (home && existsSync(path.join(home, "auth.json"))) {
      return {
        level: "info",
        message: "Codex auth file exists in the selected Hermes home; use a managed connection probe to verify it works.",
        code: "hermes_codex_auth_file_present",
      };
    }
  }

  const requestedModel = asString(config.model);

  const supportedProviders = VALID_PROVIDERS as readonly string[];
  const modelMatchesRequested =
    !!detectedConfig?.model &&
    (!requestedModel || detectedConfig.model.toLowerCase() === requestedModel.toLowerCase());

  const matchingHermesConfigApiKey =
    !!detectedConfig?.hasApiKey &&
    modelMatchesRequested;

  if (matchingHermesConfigApiKey && detectedConfig) {
    const providerLabel = detectedConfig.provider.trim();

    if (!providerLabel) {
      return {
        level: "info",
        message: "Hermes config includes an API key for the requested model via ~/.hermes/config.yaml without an explicit provider",
        hint: "Skipping the built-in API-key warning because Hermes can use model.api_key from the local Hermes config.",
        code: "hermes_api_key_in_config",
      };
    }

    if (!supportedProviders.includes(providerLabel)) {
      return {
        level: "info",
        message: `Hermes config includes runtime settings for unsupported adapter provider "${providerLabel}" via ~/.hermes/config.yaml`,
        hint: "Skipping the built-in API-key warning because Hermes can resolve this provider at runtime.",
        code: "hermes_custom_provider_config",
      };
    }

    return {
      level: "info",
      message: `Hermes config includes an API key for provider "${providerLabel}" via ~/.hermes/config.yaml`,
      hint: "Skipping the built-in API-key warning because Hermes can use model.api_key from the local Hermes config.",
      code: "hermes_api_key_in_config",
    };
  }

  return {
    level: "warn",
    message: "No LLM API keys found in environment",
    hint: "Set API keys in the agent's env secrets or ~/.hermes/.env. Hermes supports: ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, ZAI_API_KEY, KIMI_API_KEY, MINIMAX_API_KEY",
    code: "hermes_no_api_keys",
  };
}

/**
 * Check provider/model consistency.
 * Warns if the configured provider might be wrong for the model.
 */
async function checkProviderConsistency(
  config: Record<string, unknown>,
  detectedConfig: Awaited<ReturnType<typeof detectModel>> | null,
): Promise<AdapterEnvironmentCheck | null> {
  const model = asString(config.model);
  if (!model) return null;

  const explicitProvider = asString(config.provider);

  const { provider: resolved, resolvedFrom } = resolveProvider({
    explicitProvider,
    detectedProvider: detectedConfig?.provider,
    detectedModel: detectedConfig?.model,
    detectedBaseUrl: detectedConfig?.baseUrl,
    detectedHasApiKey: detectedConfig?.hasApiKey,
    detectedApiMode: detectedConfig?.apiMode,
    model,
  });

  // If provider was explicitly set but doesn't match what Hermes config says,
  // that's worth flagging.
  if (explicitProvider && detectedConfig?.provider && explicitProvider !== detectedConfig.provider) {
    return {
      level: "warn",
      message: `Provider mismatch: adapterConfig has "${explicitProvider}" but ~/.hermes/config.yaml has "${detectedConfig.provider}". Using adapterConfig value.`,
      hint: `Model "${model}" may not work correctly with provider "${explicitProvider}". Consider aligning with your Hermes config or removing the explicit provider to use auto-detection.`,
      code: "hermes_provider_mismatch",
    };
  }

  // If Hermes config matches the requested model but uses an adapter-unsupported
  // provider such as "custom", do not report a false provider inference.
  if (!explicitProvider && resolvedFrom.startsWith("hermesConfigUnsupported:")) {
    const unsupportedProvider = resolvedFrom.split(":", 2)[1] || detectedConfig?.provider || "unknown";
    return {
      level: "info",
      message: `Hermes config uses unsupported adapter provider "${unsupportedProvider}" for model "${model}" — deferring to Hermes auto-detection`,
      hint: "Paperclip will avoid model-name provider inference here and let Hermes resolve the provider from ~/.hermes/config.yaml at runtime.",
      code: "hermes_provider_unsupported",
    };
  }

  // If matching Hermes config provides runtime signals without an explicit provider,
  // also defer to Hermes rather than inventing a provider from the model name.
  if (!explicitProvider && resolvedFrom === "hermesConfigRuntime") {
    return {
      level: "info",
      message: `Hermes config provides runtime settings for model "${model}" without an explicit adapter provider — deferring to Hermes auto-detection`,
      hint: "Paperclip will avoid model-name provider inference here and let Hermes resolve the provider from ~/.hermes/config.yaml at runtime.",
      code: "hermes_provider_runtime_config",
    };
  }

  // If provider was auto-detected (not explicitly set), log what was resolved
  if (!explicitProvider && resolvedFrom !== "auto") {
    return {
      level: "info",
      message: `Provider auto-detected as "${resolved}" (from ${resolvedFrom}) for model "${model}"`,
      code: "hermes_provider_detected",
    };
  }

  // If we couldn't resolve any provider, warn
  if (resolvedFrom === "auto" && !explicitProvider) {
    return {
      level: "warn",
      message: `Could not determine provider for model "${model}" — will use Hermes auto-detection`,
      hint: "Set an explicit provider in the agent config or ensure ~/.hermes/config.yaml has a matching provider for this model.",
      code: "hermes_provider_unknown",
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const rawConfig = (ctx.config ?? {}) as Record<string, unknown>;
  let command: string;
  const checks: AdapterEnvironmentCheck[] = [];
  let childEnv: Record<string, string>;
  let bounded: boolean;
  let config: Record<string, unknown>;
  try {
    bounded = isBoundedHermesExecution(rawConfig, ctx.agentId);
    config = bounded ? { ...rawConfig, boundedExecution: true } : rawConfig;
    command = resolveHermesCommand(config);
    childEnv = buildHermesChildEnv(config.env, bounded, process.env, process.platform, !bounded && config.managedAiRouting !== true);
    validateHermesExtraArgs(config.extraArgs, bounded);
    if (bounded) {
      validateBoundedRuntimeOptions(config);
      const toolsets = asString(config.toolsets) ||
        (Array.isArray(config.enabledToolsets) ? config.enabledToolsets.join(",") : undefined);
      validateBoundedToolsets(toolsets);
      await validateBoundedHermesCommand(command);
      await validateBoundedHermesHome(childEnv.HERMES_HOME);
    }
  } catch (error) {
    checks.push({ level: "error", code: "hermes_environment_invalid", message: error instanceof Error ? error.message : "Invalid Hermes environment" });
    return { adapterType: ADAPTER_TYPE, status: "fail", checks, testedAt: new Date().toISOString() };
  }
  const hasToolsets = Boolean(asString(config.toolsets)) ||
    (Array.isArray(config.enabledToolsets) && config.enabledToolsets.length > 0 &&
     config.enabledToolsets.every((value) => typeof value === "string" && value.length > 0));
  if (bounded &&
      (!asString(config.provider) || config.provider === "auto" ||
       !asString(config.model) || config.model === "auto" ||
       !hasToolsets || !Number.isInteger(config.maxTurnsPerRun) ||
       (config.maxTurnsPerRun as number) < 2)) {
    checks.push({ level: "error", code: "hermes_bounded_config_incomplete", message: "Bounded Hermes execution requires explicit provider, model, toolsets and maxTurnsPerRun of at least 2." });
    return { adapterType: ADAPTER_TYPE, status: "fail", checks, testedAt: new Date().toISOString() };
  }

  // Every bounded test must exercise the same empty HOME and real provider
  // invocation as execute. A version check cannot prove the first heartbeat.
  // Managed connections must also prove their selected destination.
  if (config.managedAiRouting || bounded) {
    const remote = ctx.executionTarget?.kind === "remote";
    if (remote) {
      checks.push({ level: "error", code: "hermes_remote_probe_unsupported", message: "Hermes connection testing requires a local execution environment." });
    } else {
      const args = ["chat", "-Q", "-q", bounded
        ? "Call web_search exactly once for 'OpenAI API overview official site' with limit 1. Summarize the official URL."
        : "Respond with hello. Do not use tools.", "--max-turns", bounded ? "2" : "1", "--source", "tool"];
      if (bounded) args.push("--format", "stream-json");
      if (bounded) args.push("--ignore-user-config", "--ignore-rules");
      const toolsets = asString(config.toolsets) ||
        (Array.isArray(config.enabledToolsets) ? config.enabledToolsets.join(",") : undefined);
      if (toolsets) args.push("-t", toolsets);
      if (asString(config.model)) args.push("-m", asString(config.model)!);
      const provider = asString(config.provider);
      if (provider && provider !== "auto") args.push("--provider", provider);
      const isolatedCwd = bounded ? await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-probe-")) : undefined;
      if (isolatedCwd) {
        childEnv.HOME = isolatedCwd;
        if (process.platform === "win32") childEnv.USERPROFILE = isolatedCwd;
      }
      try {
        const { stdout } = await execFileAsync(command, args, {
          env: childEnv, cwd: isolatedCwd ?? asString(config.cwd), timeout: bounded ? 90_000 : 45_000, maxBuffer: 1024 * 1024,
        });
        if (bounded) {
          if (!verifyBoundedWebProbe(stdout)) throw new Error("structured_web_result_unverified");
          // A first launch may create skills/SOUL after the preflight. It is
          // never a passing probe until the resulting home remains valid.
          await validateBoundedHermesHome(childEnv.HERMES_HOME);
          await validateBoundedHermesCommand(command);
          checks.push({ level: "info", code: "hermes_web_probe_passed", message: "Hermes completed a web_search with a successful structured result and HTTPS source." });
        } else {
          if (!/\bhello\b/i.test(stdout)) throw new Error("No hello response");
          checks.push({ level: "info", code: "hermes_hello_probe_passed", message: "Hermes responded through the selected connection." });
        }
      } catch (error) {
        if (bounded) {
          const detail = error instanceof Error && error.message === "structured_web_result_unverified"
            ? "structured_web_result_unverified" : boundedProbeFailure(error);
          checks.push({ level: "error", code: "hermes_web_probe_failed",
            message: `Hermes web_search could not be verified (${detail}).`,
            hint: "Check the pinned Hermes version, selected OAuth credential, web search backend, and tool approval." });
        } else {
          checks.push({ level: "error", code: "hermes_hello_probe_failed", message: "Hermes could not complete a request through this connection.", hint: "Check the Hermes installation, endpoint, credential, and model, then test again." });
        }
      } finally {
        if (isolatedCwd) await fs.rm(isolatedCwd, { recursive: true, force: true });
      }
    }
    return { adapterType: ADAPTER_TYPE, status: checks.some(check => check.level === "error") ? "fail" : "pass", checks, testedAt: new Date().toISOString() };
  }

  // 1. CLI installed?
  const cliCheck = await checkCliInstalled(command, childEnv);
  if (cliCheck) {
    checks.push(cliCheck);
    if (cliCheck.level === "error") {
      return {
        adapterType: ADAPTER_TYPE,
        status: "fail",
        checks,
        testedAt: new Date().toISOString(),
      };
    }
  }

  // 2. CLI version
  const versionCheck = await checkCliVersion(command, childEnv);
  if (versionCheck) checks.push(versionCheck);

  // 3. Model config
  const modelCheck = checkModel(config);
  if (modelCheck) checks.push(modelCheck);

  // 4. Detect Hermes config once for the remaining checks.
  let detectedConfig: Awaited<ReturnType<typeof detectModel>> | null = null;
  try {
    detectedConfig = await detectModel(childEnv.HERMES_HOME
      ? path.join(childEnv.HERMES_HOME, "config.yaml")
      : undefined);
  } catch {
    // Non-fatal
  }

  // 5. API keys (check config.env — server resolves secrets before calling us)
  const apiKeyCheck = await checkApiKeys(config, detectedConfig, childEnv);
  if (apiKeyCheck) checks.push(apiKeyCheck);

  // 6. Provider/model consistency
  const providerCheck = await checkProviderConsistency(config, detectedConfig);
  if (providerCheck) checks.push(providerCheck);

  // Determine overall status
  const hasErrors = checks.some((c) => c.level === "error");
  const hasWarnings = checks.some((c) => c.level === "warn");

  return {
    adapterType: ADAPTER_TYPE,
    status: hasErrors ? "fail" : hasWarnings ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
