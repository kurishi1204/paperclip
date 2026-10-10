#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const categoryNames = ["cas", "separateEvidence", "hold"];
const tablePattern = /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*pgTable\s*\(/g;
const explicitIssueIdPattern = /\b(?:[A-Za-z_$][\w$]*IssueId|issueId)\s*:\s*(?:uuid|text|integer|bigint)\s*\(/g;

// Keep source offsets while removing comments and literals. A schema inventory
// must not turn a comment or SQL string into a table or issue reference.
function codeOnly(source) {
  const chars = source.split("");
  let state = "code";
  for (let index = 0; index < chars.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (state === "code") {
      if (current === "/" && next === "/") {
        chars[index] = chars[index + 1] = " ";
        index += 1;
        state = "line-comment";
      } else if (current === "/" && next === "*") {
        chars[index] = chars[index + 1] = " ";
        index += 1;
        state = "block-comment";
      } else if (current === "'" || current === '"' || current === "`") {
        chars[index] = " ";
        state = current;
      }
    } else if (state === "line-comment") {
      if (current === "\n") state = "code";
      else chars[index] = " ";
    } else if (state === "block-comment") {
      if (current === "*" && next === "/") {
        chars[index] = chars[index + 1] = " ";
        index += 1;
        state = "code";
      } else if (current !== "\n") chars[index] = " ";
    } else if (current === "\\") {
      chars[index] = " ";
      if (index + 1 < chars.length) {
        index += 1;
        if (chars[index] !== "\n") chars[index] = " ";
      }
    } else if (current === state) {
      chars[index] = " ";
      state = "code";
    } else if (current !== "\n") chars[index] = " ";
  }
  if (state === "block-comment" || state === "'" || state === '"' || state === "`") {
    throw new Error(`Unterminated ${state} in schema source`);
  }
  return chars.join("");
}

function matchingParen(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("Unclosed pgTable call in schema source");
}

function schemaFiles(root) {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return schemaFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    })
    .sort();
}

/** Direct issue references only. Transitive documents, assets, and conversations are separate. */
export function discoverIssueTables(schemaDir) {
  const foreignKey = new Set();
  const explicitIssueId = new Set();
  const tableNames = new Set();
  for (const path of schemaFiles(schemaDir)) {
    const source = codeOnly(readFileSync(path, "utf8"));
    const ranges = [];
    for (const match of source.matchAll(tablePattern)) {
      const name = match[1];
      if (tableNames.has(name)) throw new Error(`Duplicate pgTable export: ${name}`);
      tableNames.add(name);
      const open = match.index + match[0].lastIndexOf("(");
      const close = matchingParen(source, open);
      const body = source.slice(open + 1, close);
      ranges.push([open, close]);
      if (/\bissues\s*\.\s*id\b/.test(body)) foreignKey.add(name);
      if (explicitIssueIdPattern.test(body)) explicitIssueId.add(name);
      explicitIssueIdPattern.lastIndex = 0;
    }
    // An alternate table declaration must fail visibly, instead of silently
    // disappearing from the denominator.
    const markers = /\bissues\s*\.\s*id\b|\b(?:[A-Za-z_$][\w$]*IssueId|issueId)\s*:\s*(?:uuid|text|integer|bigint)\s*\(/g;
    for (const marker of source.matchAll(markers)) {
      if (!ranges.some(([start, end]) => marker.index > start && marker.index < end)) {
        throw new Error(`Issue reference outside parsed pgTable: ${path}`);
      }
    }
  }
  const sorted = (set) => [...set].sort();
  return {
    foreignKey: sorted(foreignKey),
    explicitIssueId: sorted(explicitIssueId),
    direct: sorted(new Set([...foreignKey, ...explicitIssueId])),
  };
}

export function validateIssueMaterialLedger(schemaDir, ledger) {
  if (ledger?.ledgerVersion !== 1 || ledger?.scope !== "direct-issue-reference") {
    throw new Error("Unsupported ledger version or scope");
  }
  const categories = ledger.categories;
  if (!categories || typeof categories !== "object" || Array.isArray(categories)) {
    throw new Error("Missing ledger categories");
  }
  for (const name of Object.keys(categories)) {
    if (!categoryNames.includes(name)) throw new Error(`Unexpected category: ${name}`);
  }
  const classified = new Map();
  const counts = {};
  for (const category of categoryNames) {
    const names = categories[category];
    if (!Array.isArray(names)) throw new Error(`Missing category: ${category}`);
    counts[category] = names.length;
    for (const name of names) {
      if (typeof name !== "string" || !/^[A-Za-z_$][\w$]*$/.test(name)) {
        throw new Error(`Invalid table name in ${category}`);
      }
      if (classified.has(name)) throw new Error(`Duplicated classification: ${name}`);
      classified.set(name, category);
    }
  }
  const discovered = discoverIssueTables(schemaDir);
  const direct = new Set(discovered.direct);
  const unclassified = discovered.direct.filter((name) => !classified.has(name));
  if (unclassified.length) throw new Error(`Unclassified issue tables: ${unclassified.join(", ")}`);
  const phantom = [...classified.keys()].filter((name) => !direct.has(name)).sort();
  if (phantom.length) throw new Error(`Classified tables absent from schema: ${phantom.join(", ")}`);
  return { total: direct.size, counts, foreignKey: discovered.foreignKey.length,
    explicitIssueId: discovered.explicitIssueId.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const ledger = JSON.parse(readFileSync(join(repoRoot, "doc/issue-material-classification-v1.json"), "utf8"));
    const result = validateIssueMaterialLedger(join(repoRoot, "packages/db/src/schema"), ledger);
    process.stdout.write(`issue material ledger OK ${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
