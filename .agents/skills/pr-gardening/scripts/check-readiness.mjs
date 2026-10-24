#!/usr/bin/env node
import { pathToFileURL, fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  ghJson,
  isTerminalIssue,
  normalizeCheck,
  normalizeRepository,
  parseArgs,
  readJson,
  reason,
  summarizePullRequestBody,
  writeJson,
} from "./lib.mjs";

function assessChecks(contexts) {
  const checks = contexts.map(normalizeCheck);
  return {
    checks,
    pending: checks.filter((check) => check.pending),
    failing: checks.filter((check) => !check.pending && !check.green),
    allGreen: checks.length > 0 && checks.every((check) => check.green),
  };
}

function assessGreptile(checkRuns) {
  const runs = checkRuns.filter((run) => /greptile/i.test(run.name));
  const completed = runs.filter((run) => run.status === "completed");
  const clean = completed.filter((run) => run.conclusion === "success" || run.conclusion === "neutral");
  const blocking = completed.filter((run) => run.conclusion !== "success" && run.conclusion !== "neutral");
  return {
    present: runs.length > 0,
    pending: runs.some((run) => run.status !== "completed"),
    clean: clean.length > 0 && blocking.length === 0,
    runs: runs.map((run) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      detailsUrl: run.details_url ?? null,
    })),
  };
}

function fetchCheckRuns(repository, headSha) {
  const runs = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = ghJson([
      "api",
      `repos/${repository}/commits/${headSha}/check-runs?per_page=100&page=${page}`,
    ]);
    const pageRuns = response.check_runs ?? [];
    runs.push(...pageRuns);
    if (pageRuns.length < 100) return runs;
  }
  throw new Error(`Check-run pagination exceeded 100 pages for ${headSha}`);
}

function legacyReadinessVerdict({ pullRequest, checks, greptile, behindBy, originatingIssue }) {
  const reasons = [];
  if (pullRequest.state !== "OPEN") reasons.push(reason("pr_not_open", `PR is ${pullRequest.state.toLowerCase()}`));
  const mergeable = pullRequest.mergeable ?? "UNKNOWN";
  if (mergeable === "CONFLICTING") reasons.push(reason("merge_conflict", "GitHub reports merge conflicts"));
  if (mergeable === "UNKNOWN") reasons.push(reason("mergeability_unknown", "GitHub has not resolved mergeability"));
  if (checks.pending.length > 0) {
    reasons.push(reason("checks_pending", `${checks.pending.length} check(s) are pending`, "blocking", { names: checks.pending.map((check) => check.name) }));
  }
  if (checks.failing.length > 0) {
    reasons.push(reason("checks_failing", `${checks.failing.length} check(s) are not green`, "blocking", { names: checks.failing.map((check) => check.name) }));
  }
  if (checks.checks.length === 0) reasons.push(reason("checks_missing", "No status checks were found at the current head"));
  if (!greptile.present) reasons.push(reason("greptile_missing", "No Greptile check-run exists at the current head"));
  else if (greptile.pending) reasons.push(reason("greptile_pending", "Greptile has not completed at the current head"));
  else if (!greptile.clean) reasons.push(reason("greptile_not_clean", "Greptile did not conclude success or neutral at the current head"));
  if (pullRequest.reviewDecision === "CHANGES_REQUESTED") reasons.push(reason("changes_requested", "A review requests changes"));
  if (pullRequest.reviewDecision === "REVIEW_REQUIRED") reasons.push(reason("review_required", "Required review approval is missing"));
  if (behindBy > 0) reasons.push(reason("base_behind", `Head is ${behindBy} commit(s) behind base`, "blocking", { behindBy }));
  if (!originatingIssue) reasons.push(reason("originating_issue_missing", "No originating Paperclip issue was identified", "reporting"));
  else if (!isTerminalIssue(originatingIssue.status)) {
    reasons.push(reason("originating_issue_active", `Originating issue ${originatingIssue.identifier ?? originatingIssue.issueId} is ${originatingIssue.status}`, "reporting"));
  }

  if (pullRequest.isDraft) return { verdict: "report_only", reasons };
  return { verdict: reasons.some((entry) => entry.severity === "blocking") ? "needs_gardening" : "ready", reasons };
}

export function readinessVerdict(input) {
  return input.policy === "fork-v1" ? forkReadinessVerdict(input) : legacyReadinessVerdict(input);
}

export function confidenceFor(entry) {
  if (entry.verdict === "report_only") return "low";
  const codes = new Set(entry.reasons.map((entryReason) => entryReason.code));
  const lowConfidenceCodes = [
    "originating_issue_missing",
    "greptile_missing",
    "greptile_pending",
    "greptile_not_clean",
    "checks_missing",
    "checks_failing",
    "checks_pending",
    "merge_conflict",
    "mergeability_unknown",
    "changes_requested",
  ];
  if (lowConfidenceCodes.some((code) => codes.has(code))) {
    return "low";
  }
  if (entry.verdict === "ready" && !codes.has("originating_issue_active")) return "high";
  return "medium";
}

export async function checkReadiness(candidatesDocument, options = {}, dependencies = {}) {
  if (normalizeRepository(options.repo ?? candidatesDocument.repository).toLowerCase() === FORK_REPOSITORY) return checkForkReadiness(candidatesDocument, options, dependencies);
  const repository = normalizeRepository(options.repo ?? candidatesDocument.repository);
  const results = [];
  for (const candidate of candidatesDocument.candidates) {
    const pullRequest = ghJson([
      "pr",
      "view",
      String(candidate.number),
      "--repo",
      repository,
      "--json",
      "number,url,title,author,body,state,isDraft,headRefOid,baseRefName,headRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,updatedAt",
    ]);
    const checkRuns = fetchCheckRuns(repository, pullRequest.headRefOid);
    const comparison = ghJson([
      "api",
      `repos/${repository}/compare/${encodeURIComponent(pullRequest.baseRefName)}...${encodeURIComponent(pullRequest.headRefOid)}`,
    ]);
    const checks = assessChecks(pullRequest.statusCheckRollup ?? []);
    const greptile = assessGreptile(checkRuns);
    const assessment = readinessVerdict({
      pullRequest,
      checks,
      greptile,
      behindBy: comparison.behind_by ?? 0,
      originatingIssue: candidate.originatingIssue,
    });
    const entry = {
      number: pullRequest.number,
      url: pullRequest.url,
      title: pullRequest.title,
      author: pullRequest.author?.login ?? candidate.author ?? null,
      purpose: summarizePullRequestBody(pullRequest.body),
      state: pullRequest.state.toLowerCase(),
      isDraft: pullRequest.isDraft,
      headSha: pullRequest.headRefOid,
      baseRefName: pullRequest.baseRefName,
      headRefName: pullRequest.headRefName,
      mergeable: (pullRequest.mergeable ?? "UNKNOWN").toLowerCase(),
      mergeStateStatus: (pullRequest.mergeStateStatus ?? "UNKNOWN").toLowerCase(),
      reviewDecision: pullRequest.reviewDecision || null,
      behindBy: comparison.behind_by ?? 0,
      checks,
      greptile,
      originatingIssue: candidate.originatingIssue,
      sourceIssues: candidate.sourceIssues,
      ...assessment,
    };
    entry.confidence = confidenceFor(entry);
    results.push(entry);
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repository,
    windowDays: candidatesDocument.windowDays ?? null,
    authors: candidatesDocument.query?.authors ?? null,
    truncatedIssues: candidatesDocument.source?.truncatedIssues ?? [],
    candidatesGeneratedAt: candidatesDocument.generatedAt,
    dryRun: Boolean(options.dry_run ?? candidatesDocument.dryRun),
    summary: {
      total: results.length,
      ready: results.filter((entry) => entry.verdict === "ready").length,
      needsGardening: results.filter((entry) => entry.verdict === "needs_gardening").length,
      reportOnly: results.filter((entry) => entry.verdict === "report_only").length,
    },
    pullRequests: results,
  };
}

// This fork's advisory reader runs from trusted adopted code. Operator admission
// is a filesystem/executor trust boundary, not cryptographic provider attestation.
export const FORK_REPOSITORY = "kurishi1204/paperclip";
// GitHub's actual app ID, read from check-suite metadata, not a display-name match.
export const GREPTILE_APP = Object.freeze({ id: 867647, slug: "greptile-apps" });
const SOURCE_SCHEMA = "paperclip.fork-review-source/v1";
const SOURCE_BEGIN = "=== BEGIN PAPERCLIP REVIEW SOURCE ===\n";
const SOURCE_END = "\n=== END PAPERCLIP REVIEW SOURCE ===";
const hex = (value, length) => typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
export const digest = (value) => createHash("sha256").update(value).digest("hex");
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const sourceBlock = (value) => `${SOURCE_BEGIN}${canonical(value)}${SOURCE_END}`;
// Lossless v2 source codec. Journal admission requires an explicit v2 registry entry.
export const REVIEW_SOURCE_V2 = "paperclip.fork-review-source/v2";
const REVERSE_DIFF_V1 = "paperclip.exact-reverse-line-diff/v1";
const sourceKeys = ["schema", "repository", "headSha", "treeSha", "baseSha", "mergeBaseSha", "changedFiles", "dependencyFiles"];
function exactKeys(value, keys, code = "source_v2_shape") {
  ensure(value && typeof value === "object" && !Array.isArray(value) && canonical(Object.keys(value).sort()) === canonical([...keys].sort()), code);
}
function sourceText(value) {
  ensure(typeof value === "string" && !value.includes("\0") && Buffer.from(value, "utf8").toString("utf8") === value, "source_v2_utf8");
  return value;
}
function sourceBlob(value, withContent = true) {
  exactKeys(value, withContent ? ["path", "blobSha", "content"] : ["path", "blobSha"]);
  ensure(typeof value.path === "string" && value.path.length > 0 && !value.path.includes("\0") && hex(value.blobSha, 40), "source_v2_blob_identity");
  if (withContent) {
    const bytes = Buffer.from(sourceText(value.content), "utf8");
    ensure(createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest("hex") === value.blobSha, "source_v2_blob_mismatch");
  }
}
const sourceLines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
function sourceV1Shape(source) {
  exactKeys(source, sourceKeys);
  ensure(source.schema === SOURCE_SCHEMA, "source_schema_unsupported");
  ensure(typeof source.repository === "string" && source.repository.length > 0 && [source.headSha, source.treeSha, source.baseSha, source.mergeBaseSha].every(v => hex(v, 40)), "source_v2_identity");
  ensure(Array.isArray(source.changedFiles) && Array.isArray(source.dependencyFiles), "source_v2_shape");
  const paths = new Set();
  for (const file of source.changedFiles) {
    exactKeys(file, ["path", "status", "before", "after"]);
    ensure(typeof file.path === "string" && file.path && !paths.has(file.path), "source_v2_file_identity"); paths.add(file.path);
    ensure(["added", "removed", "modified", "renamed", "copied"].includes(file.status), "source_status_unsupported");
    ensure(file.status === "added" ? file.before === null : file.before !== null, "source_before_missing");
    ensure(file.status === "removed" ? file.after === null : file.after !== null, "source_after_missing");
    if (file.before) sourceBlob(file.before);
    if (file.after) { sourceBlob(file.after); ensure(file.after.path === file.path, "source_v2_file_identity"); }
    if (["modified", "removed"].includes(file.status)) ensure(file.before.path === file.path, "source_v2_file_identity");
  }
  const dependencies = new Set();
  for (const file of source.dependencyFiles) { sourceBlob(file); ensure(!dependencies.has(file.path), "source_dependencies"); dependencies.add(file.path); }
}
// Patience anchors make a deterministic exact diff without a candidate-supplied
// command or an external patch process. Repeated/unanchored regions remain whole.
function exactReverseDiff(afterText, beforeText) {
  const after = sourceLines(afterText), before = sourceLines(beforeText), edits = [];
  const emit = (start, end, b0, b1) => {
    const insert = before.slice(b0, b1).join("");
    if (start === end && !insert) return;
    const last = edits.at(-1);
    if (last && last.afterStartLine + last.deleteLineCount === start) { last.deleteLineCount += end - start; last.beforeText += insert; }
    else edits.push({ afterStartLine: start, deleteLineCount: end - start, beforeText: insert });
  };
  function walk(a0, a1, b0, b1) {
    while (a0 < a1 && b0 < b1 && after[a0] === before[b0]) { a0++; b0++; }
    while (a0 < a1 && b0 < b1 && after[a1 - 1] === before[b1 - 1]) { a1--; b1--; }
    if (a0 === a1 || b0 === b1) { emit(a0, a1, b0, b1); return; }
    const unique = (lines, lo, hi) => { const map = new Map(); for (let i = lo; i < hi; i++) map.set(lines[i], map.has(lines[i]) ? -1 : i); return map; };
    const a = unique(after, a0, a1), b = unique(before, b0, b1), pairs = [];
    for (let i = a0; i < a1; i++) if (a.get(after[i]) === i && b.has(after[i]) && b.get(after[i]) >= 0) pairs.push([i, b.get(after[i])]);
    const tails = [], previous = [];
    for (let i = 0; i < pairs.length; i++) {
      let lo = 0, hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tails[mid]][1] < pairs[i][1]) lo = mid + 1; else hi = mid; }
      previous[i] = lo ? tails[lo - 1] : -1; tails[lo] = i;
    }
    if (!tails.length) { emit(a0, a1, b0, b1); return; }
    const anchors = []; for (let i = tails.at(-1); i >= 0; i = previous[i]) anchors.push(pairs[i]); anchors.reverse();
    for (const [ai, bi] of anchors) { walk(a0, ai, b0, bi); a0 = ai + 1; b0 = bi + 1; }
    walk(a0, a1, b0, b1);
  }
  walk(0, after.length, 0, before.length);
  return { schema: REVERSE_DIFF_V1, afterLineCount: after.length, edits };
}
function restoreBefore(afterText, delta) {
  exactKeys(delta, ["schema", "afterLineCount", "edits"]);
  const lines = sourceLines(afterText);
  ensure(delta.schema === REVERSE_DIFF_V1 && delta.afterLineCount === lines.length && Array.isArray(delta.edits), "source_v2_diff_shape");
  const output = []; let cursor = 0, priorEnd = -1;
  for (const edit of delta.edits) {
    exactKeys(edit, ["afterStartLine", "deleteLineCount", "beforeText"]);
    ensure(Number.isSafeInteger(edit.afterStartLine) && Number.isSafeInteger(edit.deleteLineCount) && edit.afterStartLine >= cursor && edit.afterStartLine > priorEnd && edit.deleteLineCount >= 0 && edit.afterStartLine <= lines.length && edit.deleteLineCount <= lines.length - edit.afterStartLine, "source_v2_diff_range");
    sourceText(edit.beforeText); ensure(edit.deleteLineCount > 0 || edit.beforeText.length > 0, "source_v2_diff_empty");
    output.push(lines.slice(cursor, edit.afterStartLine).join(""), edit.beforeText); cursor = edit.afterStartLine + edit.deleteLineCount; priorEnd = cursor;
  }
  output.push(lines.slice(cursor).join(""));
  const before = output.join("");
  ensure(canonical(exactReverseDiff(afterText, before)) === canonical(delta), "source_v2_diff_noncanonical");
  return before;
}
export function reviewSourceV2(source) {
  sourceV1Shape(source);
  const result = { ...source, schema: REVIEW_SOURCE_V2, logicalSourceSHA256: digest(canonical(source)), changedFiles: source.changedFiles.map(file => ({ path: file.path, status: file.status,
    before: file.before ? (file.after ? { path: file.before.path, blobSha: file.before.blobSha } : { ...file.before }) : null,
    after: file.after ? { ...file.after } : null,
    reverseDiff: file.before && file.after ? exactReverseDiff(file.after.content, file.before.content) : null })), dependencyFiles: source.dependencyFiles.map(file => ({ ...file })) };
  ensure(canonical(restoreReviewSourceV2(result)) === canonical(source), "source_v2_roundtrip");
  return result;
}
export function restoreReviewSourceV2(source) {
  exactKeys(source, [...sourceKeys, "logicalSourceSHA256"]);
  ensure(source.schema === REVIEW_SOURCE_V2, "source_schema_unsupported");
  ensure(hex(source.logicalSourceSHA256, 64) && Array.isArray(source.changedFiles) && Array.isArray(source.dependencyFiles), "source_v2_shape");
  const changedFiles = source.changedFiles.map(file => {
    exactKeys(file, ["path", "status", "before", "after", "reverseDiff"]);
    let before = file.before;
    if (file.before && file.after) {
      sourceBlob(file.before, false); sourceBlob(file.after);
      before = { ...file.before, content: restoreBefore(file.after.content, file.reverseDiff) };
    } else ensure(file.reverseDiff === null, "source_v2_mixed_representation");
    return { path: file.path, status: file.status, before: before ? { ...before } : null, after: file.after ? { ...file.after } : null };
  });
  const result = { schema: SOURCE_SCHEMA, repository: source.repository, headSha: source.headSha, treeSha: source.treeSha, baseSha: source.baseSha, mergeBaseSha: source.mergeBaseSha, changedFiles, dependencyFiles: source.dependencyFiles.map(file => ({ ...file })) };
  sourceV1Shape(result);
  ensure(digest(canonical(result)) === source.logicalSourceSHA256, "source_v2_logical_mismatch");
  return result;
}
export function reviewSourceV2Block(source) { return sourceBlock(reviewSourceV2(source)); }
export function parseReviewSourceV2Block(block, expectedSource) {
  ensure(typeof block === "string" && block.startsWith(SOURCE_BEGIN), "source_v2_block_invalid");
  const text = block.endsWith("\n") ? block.slice(0, -1) : block;
  ensure(text.endsWith(SOURCE_END), "source_v2_block_invalid");
  const body = text.slice(SOURCE_BEGIN.length, -SOURCE_END.length);
  let encoded; try { encoded = JSON.parse(body); } catch { throw new Error("source_v2_block_invalid"); }
  ensure(body === canonical(encoded), "source_v2_block_noncanonical");
  const restored = restoreReviewSourceV2(encoded);
  if (expectedSource !== undefined) ensure(canonical(restored) === canonical(expectedSource), "source_v2_expected_mismatch");
  return restored;
}

function ensure(condition, code) { if (!condition) throw new Error(code); }
function inside(root, target) { return target === root || target.startsWith(`${root}${path.sep}`); }
function outsideCheckoutOutput(checkout, output, code) {
  if (output === "-") return;
  // File identity, rather than path spelling, also covers case-insensitive
  // aliases. The operator owns the filesystem and must keep it stable through
  // the write; this check does not authenticate against a same-user race.
  const checkoutInfo = fs.statSync(fs.realpathSync(checkout));
  let ancestor = path.resolve(output);
  const suffix = [];
  for (;;) {
    try { fs.lstatSync(ancestor); break; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      suffix.unshift(path.basename(ancestor));
      const parent = path.dirname(ancestor);
      ensure(parent !== ancestor, code);
      ancestor = parent;
    }
  }
  ancestor = fs.realpathSync(ancestor);
  const targetInfo = fs.statSync(ancestor);
  // Existing outputs must be single-link regular files. A hardlink outside the
  // checkout can otherwise modify an inside file without any inside ancestor.
  ensure(suffix.length ? targetInfo.isDirectory() : targetInfo.isFile() && targetInfo.nlink === 1, code);
  let directory = targetInfo.isDirectory() ? ancestor : path.dirname(ancestor);
  for (;;) {
    const info = fs.statSync(directory);
    ensure(info.dev !== checkoutInfo.dev || info.ino !== checkoutInfo.ino, code);
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}
function secureRead(file, root) {
  const resolved = fs.realpathSync(file);
  ensure(inside(root, resolved) && resolved === path.resolve(file), "journal_path");
  const info = fs.lstatSync(resolved);
  ensure(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && !(info.mode & 0o022), "journal_permissions");
  return fs.readFileSync(resolved);
}


// The pointer contains no authority. Only a separately operator-configured,
// pinned registry outside this checkout may admit a real launcher and artifacts.
export function admitTrustedJournal({ trustedRoot, registrySHA256, repository, pullRequest, headSha, source, pointer, checkoutRoot = process.cwd() }) {
  if (!trustedRoot || !registrySHA256 || !pointer) return { status: "unreceived", code: "independent_review_unreceived" };
  try {
    const root = fs.realpathSync(trustedRoot);
    const checkout = fs.realpathSync(checkoutRoot);
    ensure(!inside(checkout, root) && !inside(root, checkout), "admission_inside_checkout");
    const info = fs.lstatSync(root);
    ensure(info.isDirectory() && info.uid === process.getuid() && !(info.mode & 0o077), "admission_permissions");
    const registryBytes = secureRead(path.join(root, "registry.json"), root);
    ensure(hex(registrySHA256, 64) && digest(registryBytes) === registrySHA256, "admission_pin");
    const registry = JSON.parse(registryBytes);
    ensure(registry.schema === "paperclip.operator-review-registry/v1" && Array.isArray(registry.entries), "admission_schema");
    const entries = registry.entries.filter((entry) => entry.key === pointer.admissionKey && entry.repository === repository && entry.pullRequest === pullRequest && entry.headSha === headSha);
    ensure(entries.length === 1, "review_not_admitted");
    const entry = entries[0];
    const v1 = entry.kind === "trusted-cli-journal/v1" && entry.sourceSchema === undefined;
    const v2 = entry.kind === "trusted-cli-journal/v2" && entry.sourceSchema === REVIEW_SOURCE_V2;
    ensure((v1 || v2) && entry.purpose === "independent_implementation_review", "unsupported_review_source");
    const bytes = (name) => {
      const artifact = entry.artifacts?.[name];
      ensure(artifact && hex(artifact.sha256, 64) && typeof artifact.path === "string", "admission_artifact");
      const value = secureRead(path.resolve(root, artifact.path), root);
      ensure(digest(value) === artifact.sha256, "journal_artifact_changed");
      return value;
    };
    const start = JSON.parse(bytes("start"));
    const claim = JSON.parse(bytes("claim"));
    const processRecord = JSON.parse(bytes("process"));
    const terminal = JSON.parse(bytes("terminal"));
    const rawBytes = bytes("raw");
    const raw = JSON.parse(rawBytes);
    const report = bytes("report");
    const system = bytes("system");
    const material = bytes("material");
    const combined = Buffer.concat([system, Buffer.from([0]), material]);
    const launcher = bytes("launcher");
    // The admitted executor copies/pins its actual CLI artifact; its name alone
    // is not evidence. No CLI, model, company API or fallback is invoked here.
    const cli = bytes("cli");
    ensure(start.scriptSHA256 === digest(launcher) && entry.cliSHA256 === digest(cli), "executor_pin");
    ensure(start.argv?.[0] === entry.cliInvocationPath, "executor_path");
    ensure(start.combinedSHA256 === digest(combined) && start.combinedBytes === combined.length, "launch_input");
    ensure(entry.sourceInputSHA256 === digest(Buffer.from(canonical(source))), "review_source_binding");
    const materialText = material.toString("utf8");
    ensure(Buffer.from(materialText, "utf8").equals(material), "source_not_in_launch_input");
    // One complete source block is the only admitted representation. A second
    // block (including the other schema) cannot supply contradictory context.
    ensure(materialText.split(SOURCE_BEGIN).length === 2 && materialText.split(SOURCE_END).length === 2, "source_not_in_launch_input");
    const blockStart = materialText.indexOf(SOURCE_BEGIN);
    const blockEnd = materialText.indexOf(SOURCE_END, blockStart) + SOURCE_END.length;
    const actualBlock = materialText.slice(blockStart, blockEnd);
    const block = v2 ? reviewSourceV2Block(source) : sourceBlock(source);
    if (v2) parseReviewSourceV2Block(actualBlock, source);
    ensure(actualBlock === block, "source_not_in_launch_input");
    ensure(start.sessionID === processRecord.sessionID && start.sessionID === claim.sessionID && claim.singleAttempt === true && claim.noRetry === true && Number.isInteger(processRecord.pid) && processRecord.pid > 0, "journal_execution");
    const expectedArgv = [entry.cliInvocationPath, "--print", "--session-id", start.sessionID,
      "--max-turns", "1", "--model", "claude-opus-5-5", "--effort", "high", "--output-format", "json",
      "--safe-mode", "--restricted", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--setting-sources", "", "--settings", '{"disableAllHooks":true,"enabledPlugins":{}}',
      "--disable-slash-commands", "--no-chrome", "--permission-mode", "dontAsk", "--permission-prompts", "none",
      "--no-session-persistence", "--system-prompt", system.toString("utf8")];
    ensure(canonical(start.argv) === canonical(expectedArgv), "unsupported_launch_shape");
    ensure(typeof entry.implementationSessionID === "string" && entry.implementationSessionID.trim() && entry.implementationSessionID === entry.implementationSessionID.trim(), "implementation_session_unreceived");
    ensure(typeof start.sessionID === "string" && start.sessionID.trim() && start.sessionID === start.sessionID.trim(), "journal_execution");
    ensure(entry.implementationSessionID.toLowerCase() !== start.sessionID.toLowerCase(), "review_not_independent");
    ensure(terminal.nativeExit === 0 && terminal.inputSHA256 === digest(combined) && terminal.rawSHA256 === digest(rawBytes), "native_terminal");
    ensure(raw.type === "result" && raw.subtype === "success" && raw.is_error === false && raw.terminal_reason === "completed" && raw.num_turns === 1 && raw.queued_turn_count === 0, "provider_terminal");
    ensure(raw.session_id === start.sessionID && terminal.sessionID === raw.session_id, "provider_session");
    ensure(Object.keys(raw.modelUsage ?? {}).length === 1 && raw.modelUsage?.["claude-opus-5-5"]?.provider === "firstParty", "actual_model_provider");
    ensure(raw.permission_denials?.length === 0 && raw.subagent_stats?.spawned === 0, "review_execution_contract");
    ensure(typeof raw.result === "string" && Buffer.from(raw.result).equals(report), "actual_report");
    const lines = raw.result.replace(/\n+$/, "").split("\n");
    ensure(lines.at(-1) === "判定: GO" && lines.filter((line) => line.startsWith("判定: ")).length === 1, "review_not_go");
    return { status: "valid", model: "claude-opus-5-5", provider: "firstParty", implementationSessionID: entry.implementationSessionID, sessionID: raw.session_id, headSha, treeSha: source.treeSha, sourceSchema: v2 ? REVIEW_SOURCE_V2 : SOURCE_SCHEMA, evidenceKind: v2 ? "lossless-v2-reconstructed-source" : "inline-v1-whole-source", inputSHA256: digest(combined), reportSHA256: digest(report), report: raw.result, verdict: "判定: GO", trustBoundary: "operator-admitted executor and journal, not signed provider attestation" };
  } catch (error) {
    return { status: "invalid", code: "independent_review_invalid", subcode: /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : "journal_read_unavailable" };
  }
}

function getPages(get, route, field = null) {
  const rows = []; let total = null;
  for (let page = 1; page <= 100; page += 1) {
    const response = get(`${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const values = field ? response[field] : response;
    ensure(Array.isArray(values) && values.length <= 100, "pagination_shape");
    if (field) { ensure(Number.isInteger(response.total_count), "pagination_count"); total ??= response.total_count; ensure(total === response.total_count, "pagination_changed"); }
    rows.push(...values);
    if (values.length < 100) { ensure(total === null || rows.length === total, "pagination_incomplete"); return rows; }
  }
  throw new Error("pagination_incomplete");
}

export function buildReviewSource(get, repository, pr, files, treeSha, baseSha, mergeBaseSha, dependencyPaths = [], sourceSchema = SOURCE_SCHEMA) {
  ensure([SOURCE_SCHEMA, REVIEW_SOURCE_V2].includes(sourceSchema), "source_schema_unsupported");
  ensure([pr.head.sha, treeSha, baseSha, mergeBaseSha].every(v=>hex(v,40)), "source_identity");
  const prefix = `repos/${repository}`;
  const headTree = get(`${prefix}/git/trees/${treeSha}?recursive=1`);
  const baseCommit = get(`${prefix}/git/commits/${mergeBaseSha}`);
  const baseTree = get(`${prefix}/git/trees/${baseCommit.tree.sha}?recursive=1`);
  ensure(headTree.sha === treeSha && baseTree.sha === baseCommit.tree.sha && !headTree.truncated && !baseTree.truncated && Array.isArray(headTree.tree) && Array.isArray(baseTree.tree), "source_tree_incomplete");
  const head = new Map(headTree.tree.map(r=>[r.path,r]));
  const base = new Map(baseTree.tree.map(r=>[r.path,r]));
  const blob = (entry) => {
    ensure(entry?.type === "blob" && ["100644","100755"].includes(entry.mode), "source_file_unsupported");
    const data = get(`${prefix}/git/blobs/${entry.sha}`);
    ensure(data.encoding === "base64" && data.sha === entry.sha, "source_blob_encoding");
    const bytes = Buffer.from(data.content.replace(/\s/g,""),"base64");
    ensure(bytes.length === data.size && createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes])).digest("hex") === entry.sha, "source_blob_mismatch");
    const text = new TextDecoder("utf-8",{fatal:true,ignoreBOM:sourceSchema===REVIEW_SOURCE_V2}).decode(bytes);
    ensure(!text.includes("\0"),"source_binary_unsupported");
    return { path:entry.path,blobSha:entry.sha,content:text };
  };
  ensure(new Set(files.map(f=>f.filename)).size === files.length, "source_files_duplicate");
  const changedFiles = files.map((f) => {
    ensure(["added","modified","removed","renamed","copied"].includes(f.status), "source_status_unsupported");
    const beforeEntry = base.get(f.previous_filename ?? f.filename);
    const afterEntry = head.get(f.filename);
    ensure((f.status === "removed" ? beforeEntry?.sha : afterEntry?.sha) === f.sha, "source_files_mismatch");
    ensure(f.status === "added" ? !beforeEntry : Boolean(beforeEntry), "source_before_missing");
    ensure(f.status === "removed" ? !afterEntry : Boolean(afterEntry), "source_after_missing");
    return { path:f.filename,status:f.status,before:beforeEntry?blob(beforeEntry):null,after:afterEntry?blob(afterEntry):null };
  }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  ensure(Array.isArray(dependencyPaths) && dependencyPaths.every(p=>typeof p==="string") && new Set(dependencyPaths).size===dependencyPaths.length, "source_dependencies");
  const dependencyFiles = [...dependencyPaths].sort().map(p=>blob(head.get(p)));
  return { schema:SOURCE_SCHEMA,repository,headSha:pr.head.sha,treeSha,baseSha,mergeBaseSha,changedFiles,dependencyFiles };
}

function requiredChecks(rules, protection) {
  const result = [];
  for (const rule of rules) if (rule.type === "required_status_checks") {
    const checks = rule.parameters?.required_status_checks;
    ensure(Array.isArray(checks), "required_checks_unknown");
    for (const check of checks) result.push({ context: check.context, appID: check.integration_id ?? null });
  }
  for (const check of protection?.required_status_checks?.checks ?? []) result.push({ context: check.context, appID: check.app_id ?? null });
  for (const context of protection?.required_status_checks?.contexts ?? []) result.push({ context, appID: null });
  return result;
}

export function assessForkChecks(checkRuns, rollup, required = []) {
  const checkContexts = rollup.filter((c) => c.__typename === "CheckRun");
  const names = (rows, getter) => rows.map(getter).sort().join("\0");
  ensure(names(checkRuns, r=>r.name) === names(checkContexts, r=>r.name), "ci_inventory_mismatch");
  const isRequired = (run) => required.some((r) => r.context === run.name && (r.appID === null || r.appID === run.app?.id));
  const advisory = checkRuns.filter((r) => r.app?.id === GREPTILE_APP.id && r.app?.slug === GREPTILE_APP.slug && !isRequired(r));
  const excluded = new Set(advisory.map((r) => r.id));
  const checks = checkRuns.filter((r) => !excluded.has(r.id)).map((r) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion, green: r.status === "completed" && r.conclusion === "success", pending: r.status !== "completed" }));
  checks.push(...rollup.filter((c) => c.__typename === "StatusContext").map(normalizeCheck));
  ensure(rollup.every((c) => ["CheckRun", "StatusContext"].includes(c.__typename)), "ci_context_unknown");
  const missingRequired = required.filter((r) => !checkRuns.some((c) => c.name === r.context && (r.appID === null || r.appID === c.app?.id)) && !rollup.some((c) => c.__typename === "StatusContext" && c.context === r.context && r.appID === null));
  return { checks, pending: checks.filter(c=>c.pending), failing: checks.filter(c=>!c.pending&&!c.green), successes: checks.filter(c=>c.green), missingRequired, advisory };
}

function rollupSnapshot(rollup) {
  ensure(Array.isArray(rollup), "ci_context_unknown");
  // Keep the typed raw row as well as its normalized state: unknown fields and
  // same-name occurrences must not disappear from the final evidence read.
  return rollup.map(row => {
    ensure(row && ["CheckRun", "StatusContext"].includes(row.__typename), "ci_context_unknown");
    return canonical({ raw: row, normalized: normalizeCheck(row) });
  }).sort();
}

function collectCheckAnnotations(get, repository, head, runs) {
  ensure(new Set(runs.map(r=>r.id)).size === runs.length, "ci_head_mismatch");
  const sources = [];
  for (const run of runs) {
    ensure(Number.isSafeInteger(run.id) && run.id > 0 && run.head_sha === head, "ci_head_mismatch");
    const count = run.output?.annotations_count;
    ensure(Number.isSafeInteger(count) && count >= 0, "annotations_count_unknown");
    if (count === 0) continue;
    const url = `https://api.github.com/repos/${repository}/check-runs/${run.id}`;
    ensure(run.url === url && run.output.annotations_url === `${url}/annotations`, "annotations_source_mismatch");
    // Construct the same-repository route; never follow an output-provided URL.
    const annotations = getPages(get, `repos/${repository}/check-runs/${run.id}/annotations`);
    ensure(annotations.length === count, "annotations_incomplete");
    const occurrences = new Map();
    for (const annotation of annotations) {
      ensure(annotation && !Array.isArray(annotation) && typeof annotation === "object" && typeof annotation.path === "string" && Number.isInteger(annotation.start_line) && Number.isInteger(annotation.end_line) && typeof annotation.annotation_level === "string" && typeof annotation.message === "string", "annotations_shape");
      const bodySHA256 = digest(canonical(annotation));
      const occurrence = (occurrences.get(bodySHA256) ?? 0) + 1;
      occurrences.set(bodySHA256, occurrence);
      // GitHub annotations have no native ID. Preserve identical occurrences
      // under their owning check-run ID, and retain the complete response body.
      sources.push({ id: `check_annotation:${run.id}:${bodySHA256}:${occurrence}`, version: digest(canonical({ head, checkRunID: run.id, app: run.app, annotation })), bodySHA256, checkRunID: run.id, headSha: head, annotation });
    }
  }
  return sources;
}

function findingSources(comments, inline, reviews, runs, review, annotations) {
  const rows = [];
  const add = (kind, row, body) => rows.push({ id: `${kind}:${row.id}`, version: row.updated_at ?? row.submitted_at ?? row.created_at ?? "", bodySHA256: digest(Buffer.from(canonical({ body, state: row.state ?? null, commit: row.commit_id ?? null, path: row.path ?? null }))) });
  comments.forEach(r=>add("issue_comment",r,r.body));
  inline.forEach(r=>add("review_comment",r,r.body));
  reviews.forEach(r=>add("review",r,r.body));
  // Count/route fields are collection metadata; every other nonempty field is
  // received output, including future fields we cannot semantically classify.
  runs.filter(r=>r.output && Object.entries(r.output).some(([key,value])=>!["annotations_count","annotations_url"].includes(key) && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0))).forEach(r=>add("check_output",{ ...r, updated_at: r.completed_at ?? r.started_at },r.output));
  rows.push(...annotations);
  if (review.status === "valid") rows.push({ id: `independent_review:${review.reportSHA256}`, version: review.reportSHA256, bodySHA256: digest(Buffer.from(review.report)) });
  return rows;
}
export function assessDispositions(sources, dispositions = []) {
  ensure(Array.isArray(dispositions), "findings_disposition_shape");
  ensure(new Set(dispositions.map(d=>d.sourceID)).size === dispositions.length, "findings_duplicate_disposition");
  const missing = sources.filter((s) => !dispositions.some((d) => d.sourceID === s.id && d.sourceVersion === s.version && d.bodySHA256 === s.bodySHA256 && ["resolved", "rejected", "not_a_finding"].includes(d.disposition) && typeof d.reason === "string" && d.reason.trim() && typeof d.evidence === "string" && d.evidence.trim()));
  return { complete: missing.length === 0, sources, missing: missing.map(s=>s.id), orphaned: dispositions.filter(d=>!sources.some(s=>s.id===d.sourceID)).map(d=>d.sourceID) };
}

export function forkReadinessVerdict({ pullRequest, checks, review, findings, behindBy, changedHead = false, changedEvidence = false, requiredReview = false }) {
  const reasons = [];
  const block = (code, message, operatorAction = false) => reasons.push({ ...reason(code, message), operatorAction });
  if (pullRequest.state !== "open") block("pr_not_open", "PR is not open");
  if (!pullRequest.mergeable) block("mergeability_unknown_or_conflict", "Mergeability is unresolved or conflicting");
  if (["blocked", "dirty", "behind", "unknown", "draft"].includes(pullRequest.mergeable_state ?? "unknown")) block("merge_state_blocked", "GitHub reports a blocked or unresolved merge state");
  if (!checks.checks.length) block("checks_missing", "No required CI/status evidence at current head");
  if (checks.pending.length) block("checks_pending", "CI/status checks are pending");
  if (checks.failing.length) block("checks_failing", "CI/status checks did not complete successfully; skipped/neutral are not success");
  if (checks.missingRequired.length) block("required_checks_missing", "A repository-required status check is absent");
  if (requiredReview && pullRequest.reviewDecision !== "APPROVED") block("review_required", "Required reviewer/CODEOWNERS approval is unreceived", true);
  if (["REVIEW_REQUIRED", "CHANGES_REQUESTED"].includes(pullRequest.reviewDecision)) block(pullRequest.reviewDecision.toLowerCase(), "GitHub review requirement remains", true);
  if (behindBy > 0) block("base_behind", "Head is behind the target base");
  if (review.status !== "valid") block(review.code ?? "independent_review_unreceived", "Trusted exact-head independent Opus review is unreceived or invalid", true);
  if (!findings.complete) block("findings_undispositioned", "Review sources require current reasoned dispositions", true);
  if (changedEvidence) block("evidence_changed", "Check inventory or review sources changed during reads; repeat observation before readiness", true);
  if (changedHead) block("head_changed", "PR identity or finding counts changed during reads", true);
  return { verdict: pullRequest.draft ? "report_only" : reasons.length ? "needs_gardening" : "ready", reasons };
}

async function checkForkReadiness(document, options, dependencies) {
  const repository = FORK_REPOSITORY;
  const get = dependencies.getJson ?? ((route) => ghJson(["api", "--method", "GET", route]));
  const view = dependencies.viewPullRequest ?? ((number) => ghJson(["pr","view",String(number),"--repo",repository,"--json","headRefOid,reviewDecision,statusCheckRollup"]));
  let pointerFile = null;
  let pointerFailure = null;
  if (options.review_evidence !== undefined) {
    if (typeof options.review_evidence !== "string" || !options.review_evidence.trim()) {
      pointerFailure = "review_evidence_path_invalid";
    } else {
      try {
        pointerFile = readJson(options.review_evidence);
        ensure(pointerFile?.schema === "paperclip.review-pointer/v1" && pointerFile.repository === repository && Array.isArray(pointerFile.entries) && pointerFile.entries.every(entry => entry && typeof entry === "object"), "review_evidence_shape_invalid");
      } catch (error) {
        pointerFailure = error instanceof SyntaxError ? "review_evidence_invalid_json" : error.message === "review_evidence_shape_invalid" ? error.message : "review_evidence_unreadable";
      }
    }
  }
  const entries = [];
  for (const candidate of document.candidates) {
    let pr; let entry;
    try {
      ensure(!pointerFailure, pointerFailure);
      pr = get(`repos/${repository}/pulls/${candidate.number}`);
      const head = pr.head.sha;
      const metadata = view(candidate.number);
      ensure(metadata.headRefOid === head, "head_changed");
      const rollup = rollupSnapshot(metadata.statusCheckRollup);
      const runs = getPages(get, `repos/${repository}/commits/${head}/check-runs?filter=latest`, "check_runs");
      ensure(new Set(runs.map(r=>r.id)).size === runs.length && runs.every(r=>r.head_sha===head), "ci_head_mismatch");
      const normalRuns = getPages(get, `repos/${repository}/actions/runs?head_sha=${head}&event=pull_request`, "workflow_runs").filter(r=>r.path===".github/workflows/pr.yml"&&r.head_sha===head&&r.event==="pull_request").sort((a,b)=>b.id-a.id);
      ensure(normalRuns.length > 0,"normal_ci_unreceived");
      const normalRun = get(`repos/${repository}/actions/runs/${normalRuns[0].id}`);
      ensure(normalRun.head_sha===head && normalRun.status==="completed" && normalRun.conclusion==="success","normal_ci_not_success");
      ensure(normalRun.referenced_workflows?.some(r=>r.path==="kurishi1204/paperclip/.github/workflows/pr-trusted.yml@489b95bbf7b616a012464709da5dded3772f49b7"&&r.sha==="489b95bbf7b616a012464709da5dded3772f49b7"),"normal_ci_callee_mismatch");
      const jobs = getPages(get, `repos/${repository}/actions/runs/${normalRun.id}/jobs?filter=latest`, "jobs");
      ensure(jobs.length>0 && jobs.every(j=>j.status==="completed"&&j.conclusion==="success"),"normal_ci_jobs_not_success");
      ensure(jobs.every(j=>runs.some(r=>j.check_run_url===`https://api.github.com/repos/${repository}/check-runs/${r.id}`&&r.head_sha===head&&r.app?.slug==="github-actions")),"normal_ci_job_join");
      const rules = getPages(get, `repos/${repository}/rules/branches/${encodeURIComponent(pr.base.ref)}`);
      ensure(Array.isArray(rules), "rules_unreceived");
      const branch = get(`repos/${repository}/branches/${encodeURIComponent(pr.base.ref)}`);
      ensure(typeof branch.protected === "boolean" && hex(branch.commit?.sha,40), "branch_policy_unknown");
      const protection = branch.protected ? get(`repos/${repository}/branches/${encodeURIComponent(pr.base.ref)}/protection`) : null;
      const required = requiredChecks(rules, protection);
      const checks = assessForkChecks(runs, metadata.statusCheckRollup ?? [], required);
      const files = getPages(get, `repos/${repository}/pulls/${candidate.number}/files`);
      ensure(files.length === pr.changed_files, "changed_files_incomplete");
      const commit = get(`repos/${repository}/git/commits/${head}`);
      const comparison = get(`repos/${repository}/compare/${encodeURIComponent(pr.base.ref)}...${head}`);
      ensure(Number.isInteger(comparison.behind_by) && hex(comparison.merge_base_commit?.sha,40), "base_comparison_unknown");
      const pointers = pointerFile?.schema === "paperclip.review-pointer/v1" && pointerFile.repository === repository ? pointerFile.entries?.filter(e=>e.pullRequest===candidate.number&&e.headSha===head) ?? [] : [];
      ensure(pointers.length <= 1, "duplicate_review_pointer");
      const pointer = pointers[0];
      const source = buildReviewSource(get, repository, pr, files, commit.tree.sha, branch.commit.sha, comparison.merge_base_commit.sha, pointer?.dependencies ?? []);
      const review = admitTrustedJournal({ trustedRoot: options.trusted_review_root, registrySHA256: options.trusted_review_registry_sha256, repository, pullRequest: candidate.number, headSha: head, source, pointer, checkoutRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..") });
      const comments = getPages(get, `repos/${repository}/issues/${candidate.number}/comments`);
      const inline = getPages(get, `repos/${repository}/pulls/${candidate.number}/comments`);
      const reviews = getPages(get, `repos/${repository}/pulls/${candidate.number}/reviews`);
      ensure(comments.length === pr.comments && inline.length === pr.review_comments, "findings_enumeration_incomplete");
      const annotations = collectCheckAnnotations(get, repository, head, runs);
      const findings = assessDispositions(findingSources(comments, inline, reviews, runs, review, annotations), pointer?.dispositions);

      const finalRuns = getPages(get, `repos/${repository}/commits/${head}/check-runs?filter=latest`, "check_runs");
      const finalAnnotations = collectCheckAnnotations(get, repository, head, finalRuns);
      const finalComments = getPages(get, `repos/${repository}/issues/${candidate.number}/comments`);
      const finalInline = getPages(get, `repos/${repository}/pulls/${candidate.number}/comments`);
      const finalReviews = getPages(get, `repos/${repository}/pulls/${candidate.number}/reviews`);
      const snapshot = (checkRows, commentRows, inlineRows, reviewRows, annotationRows, rollupRows) => canonical({
        sources: findingSources(commentRows, inlineRows, reviewRows, checkRows, review, annotationRows).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),
        checks: checkRows.map(r=>({id:r.id,head:r.head_sha,name:r.name,status:r.status,conclusion:r.conclusion,app:r.app?.id,slug:r.app?.slug,annotations:r.output.annotations_count})).sort((a,b)=>a.id-b.id),
        rollup: rollupRows,
      });
      const final = get(`repos/${repository}/pulls/${candidate.number}`);
      const finalBranch = get(`repos/${repository}/branches/${encodeURIComponent(pr.base.ref)}`);
      const finalMetadata = view(candidate.number);
      const changedEvidence = snapshot(runs,comments,inline,reviews,annotations,rollup) !== snapshot(finalRuns,finalComments,finalInline,finalReviews,finalAnnotations,rollupSnapshot(finalMetadata.statusCheckRollup));
      const changedHead = final.head.sha!==head || final.base.sha!==pr.base.sha || finalBranch.commit.sha!==branch.commit.sha || final.comments!==pr.comments || final.review_comments!==pr.review_comments || final.state!==pr.state || final.draft!==pr.draft || finalMetadata.headRefOid!==head || finalMetadata.reviewDecision!==metadata.reviewDecision;
      const reviewPolicies = [protection?.required_pull_request_reviews, ...rules.filter(r=>r.type==="pull_request").map(r=>r.parameters)].filter(Boolean);
      const requiredReview = reviewPolicies.some(p=>p.required_approving_review_count>0 || p.require_code_owner_reviews===true || p.require_code_owner_review===true || p.require_last_push_approval===true);
      entry = { number: candidate.number, url: pr.html_url, title: pr.title, author: pr.user?.login, purpose: summarizePullRequestBody(pr.body), state: pr.state, isDraft: pr.draft, headSha: head, baseRefName: pr.base.ref, behindBy: comparison.behind_by, originatingIssue: candidate.originatingIssue, policy: "fork-v1", checks, normalCI:{runID:normalRun.id,jobs:jobs.length,conclusion:normalRun.conclusion}, independentReview: { ...review, report: undefined }, findings, greptile: { state: checks.advisory.length ? checks.advisory.map(r=>`${r.status}:${r.conclusion??"unreceived"}`).join(", ") : "unavailable/unreceived", score: null }, source, ...readinessVerdict({policy:"fork-v1",pullRequest:{...pr,reviewDecision:metadata.reviewDecision},checks,review,findings,behindBy:comparison.behind_by,changedHead,changedEvidence,requiredReview}) };
    } catch (error) {
      entry = { number: candidate.number, url: pr?.html_url, title: pr?.title ?? candidate.title ?? "Unreceived", state: pr?.state ?? "unknown", isDraft: pr?.draft ?? false, policy: "fork-v1", headSha: pr?.head?.sha ?? null, verdict: pr?.draft ? "report_only" : "needs_gardening", reasons:[{...reason("readiness_unknown", "Required GitHub or trusted-review evidence could not be verified"),subcode:/^[a-z][a-z0-9_]+$/.test(error.message)?error.message:"read_dependency_unavailable",operatorAction:true}] };
    }
    entry.confidence = entry.verdict === "ready" ? "high" : "low";
    entries.push(entry);
  }
  return { schemaVersion:2, repository, generatedAt:new Date().toISOString(), windowDays:document.windowDays??null, authors:document.query?.authors??null, truncatedIssues:document.source?.truncatedIssues??[], dryRun:Boolean(options.dry_run??document.dryRun), summary:{total:entries.length,ready:entries.filter(e=>e.verdict==="ready").length,needsGardening:entries.filter(e=>e.verdict==="needs_gardening").length,reportOnly:entries.filter(e=>e.verdict==="report_only").length},pullRequests:entries };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), { input: "candidates.json" });
  if (options.emit_review_input) {
    ensure(typeof options.output === "string" && options.output.trim(), "review_output_required");
    const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
    outsideCheckoutOutput(checkout, options.output, "review_output_inside_checkout");
    const repo = normalizeRepository(options.repo).toLowerCase();
    ensure(repo === FORK_REPOSITORY, "fork_source_only");
    const number = Number(options.emit_review_input);
    ensure(Number.isInteger(number) && number > 0,"invalid_pr");
    const get = (route) => ghJson(["api","--method","GET",route]);
    const pr = get(`repos/${repo}/pulls/${number}`);
    const branch = get(`repos/${repo}/branches/${encodeURIComponent(pr.base.ref)}`);
    const comparison = get(`repos/${repo}/compare/${encodeURIComponent(pr.base.ref)}...${pr.head.sha}`);
    const files = getPages(get,`repos/${repo}/pulls/${number}/files`);
    ensure(files.length === pr.changed_files,"changed_files_incomplete");
    const commit = get(`repos/${repo}/git/commits/${pr.head.sha}`);
    const schema = options.source_schema ?? "v1";
    ensure(["v1", "v2"].includes(schema), "source_schema_unsupported");
    const source = buildReviewSource(get,repo,pr,files,commit.tree.sha,branch.commit.sha,comparison.merge_base_commit.sha,options.review_dependencies ? options.review_dependencies.split(",").map(p=>p.trim()) : [], schema === "v2" ? REVIEW_SOURCE_V2 : SOURCE_SCHEMA);
    const final = get(`repos/${repo}/pulls/${number}`);
    const finalBranch = get(`repos/${repo}/branches/${encodeURIComponent(pr.base.ref)}`);
    ensure(final.head.sha===pr.head.sha && finalBranch.commit.sha===branch.commit.sha,"head_changed");
    // The default remains v1; v2 requires an explicit operator schema selection.
    const body = schema === "v2" ? reviewSourceV2Block(source) : sourceBlock(source);
    if (options.output === "-") process.stdout.write(body+"\n");
    else fs.writeFileSync(options.output,body+"\n");
    return;
  }
  const document = readJson(options.input);
  const output = options.output ?? "readiness.json";
  if (normalizeRepository(options.repo ?? document.repository).toLowerCase() === FORK_REPOSITORY) {
    const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
    ensure(typeof output === "string" && output.trim(), "readiness_output_required");
    outsideCheckoutOutput(checkout, output, "readiness_output_inside_checkout");
  }
  writeJson(output, await checkReadiness(document, options));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
