import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverIssueTables,
  validateIssueMaterialLedger,
} from "./check-issue-material-classification.mjs";

function fixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "paperclip-issue-material-"));
  const schemaDir = join(root, "schema");
  mkdirSync(schemaDir);
  const writeSchema = (name, source) => writeFileSync(join(schemaDir, `${name}.ts`), source);
  try {
    return callback({ schemaDir, writeSchema });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const baseLedger = () => ({
  ledgerVersion: 1,
  scope: "direct-issue-reference",
  categories: {
    cas: ["issueComments", "issues"],
    separateEvidence: ["issueWatchdogs"],
    hold: ["documentAnnotationComments"],
  },
});

const baseSchema = (writeSchema) => {
  writeSchema("issues", 'export const issues = pgTable("issues", { id: uuid("id"), parentId: uuid("parent_id").references(() => issues.id) });');
  writeSchema("issue_comments", 'export const issueComments = pgTable("issue_comments", { issueId: uuid("issue_id").references(() => issues.id) });');
  writeSchema("issue_watchdogs", 'export const issueWatchdogs = pgTable("issue_watchdogs", { watchedIssueId: uuid("watched_issue_id") });');
  writeSchema("annotations", 'export const documentAnnotationComments = pgTable("document_annotation_comments", { issueId: uuid("issue_id") });');
};

test("discovers FK and explicit IssueId columns from every pgTable, with both sets retained", () => fixture(({ schemaDir, writeSchema }) => {
  baseSchema(writeSchema);
  const found = discoverIssueTables(schemaDir);
  assert.deepEqual(found.foreignKey, ["issueComments", "issues"]);
  assert.deepEqual(found.explicitIssueId, ["documentAnnotationComments", "issueComments", "issueWatchdogs"]);
  assert.deepEqual(found.direct, ["documentAnnotationComments", "issueComments", "issueWatchdogs", "issues"]);
}));

test("new FK table is unclassified and fails closed", () => fixture(({ schemaDir, writeSchema }) => {
  baseSchema(writeSchema);
  writeSchema("new_child", 'export const newChild = pgTable("new_child", { source: uuid("source").references(() => issues.id) });');
  assert.throws(() => validateIssueMaterialLedger(schemaDir, baseLedger()), /Unclassified issue tables: newChild/);
}));

test("new explicit IssueId column without FK is unclassified and fails closed", () => fixture(({ schemaDir, writeSchema }) => {
  baseSchema(writeSchema);
  writeSchema("new_child", 'export const newChild = pgTable("new_child", { targetIssueId: uuid("target_issue_id") });');
  assert.throws(() => validateIssueMaterialLedger(schemaDir, baseLedger()), /Unclassified issue tables: newChild/);
}));

test("missing, duplicate, and phantom classifications fail with table names", () => fixture(({ schemaDir, writeSchema }) => {
  baseSchema(writeSchema);
  const missing = baseLedger();
  missing.categories.hold = [];
  assert.throws(() => validateIssueMaterialLedger(schemaDir, missing), /Unclassified issue tables: documentAnnotationComments/);

  const duplicate = baseLedger();
  duplicate.categories.hold.push("issueComments");
  assert.throws(() => validateIssueMaterialLedger(schemaDir, duplicate), /Duplicated classification: issueComments/);

  const phantom = baseLedger();
  phantom.categories.hold.push("retiredIssueTable");
  assert.throws(() => validateIssueMaterialLedger(schemaDir, phantom), /Classified tables absent from schema: retiredIssueTable/);
}));

test("rejects invalid ledger versions and categories", () => fixture(({ schemaDir, writeSchema }) => {
  baseSchema(writeSchema);
  const wrongVersion = baseLedger();
  wrongVersion.ledgerVersion = 2;
  assert.throws(() => validateIssueMaterialLedger(schemaDir, wrongVersion), /Unsupported ledger version/);
  const unexpected = baseLedger();
  unexpected.categories.unreviewed = [];
  assert.throws(() => validateIssueMaterialLedger(schemaDir, unexpected), /Unexpected category: unreviewed/);
}));

test("ignores strings and comments, but catches a second table in the same file", () => fixture(({ schemaDir, writeSchema }) => {
  baseSchema(writeSchema);
  writeSchema("more", [
    '// export const fake = pgTable("fake", { issueId: uuid("issue_id") });',
    'export const other = pgTable("other", { note: text("issueId: uuid(\\"issue_id\\")") });',
    'export const latest = pgTable("latest", { originIssueId: uuid("origin_issue_id") });',
  ].join("\n"));
  assert.deepEqual(discoverIssueTables(schemaDir).direct, ["documentAnnotationComments", "issueComments", "issueWatchdogs", "issues", "latest"]);
}));

test("current repository ledger covers the discovered schema exactly", () => {
  const root = join(import.meta.dirname, "..");
  const schemaDir = join(root, "packages/db/src/schema");
  const ledger = JSON.parse(requireLedger());
  const result = validateIssueMaterialLedger(schemaDir, ledger);
  assert.equal(result.total, 74);
  assert.deepEqual(result.counts, { cas: 9, separateEvidence: 65, hold: 0 });
});

function requireLedger() {
  const root = join(import.meta.dirname, "..");
  return readFileSync(join(root, "doc/issue-material-classification-v1.json"), "utf8");
}
