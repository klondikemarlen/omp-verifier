import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  completeSemanticEvaluation,
  prepareSemanticEvaluation,
  readSemanticEvaluation,
} from "#root/omp-plugin/semantic-evaluations.js";
import { discoverVerificationChecks } from "#root/omp-plugin/verifications.js";

import { validateSourceByteLimit } from "#root/omp-plugin/semantic-context.js";

const CHECK_ID = "publisher:alignment";
const CALLER_SOURCE = 'import { helper } from "./helper.js";\nexport const result = helper(1);\n';

function semanticManifest() {
  return {
    name: "publisher",
    version: "1.2.3",
    omp: {
      extensions: ["./index.js"],
      verifications: [{
        id: CHECK_ID,
        label: "Module Boundary Alignment",
        description: "Evaluates changed module boundaries against a supplied standard.",
        mode: "agentic",
        contract: "./verifications/alignment.json",
        pathTriggers: ["**/*.js"],
      }],
    },
  };
}

function semanticContract() {
  return {
    version: 1,
    standardId: CHECK_ID,
    source: "./docs/standard.md#module-boundary-alignment",
    gold: "A changed module owns a meaningful invariant or behavior rather than forwarding alone.",
    requiredContext: ["changed-code", "callers", "siblings", "project-guidance"],
    rubric: [{
      id: "boundary-ownership",
      question: "What meaningful responsibility or invariant does this module own?",
    }],
  };
}

async function initializeGit(root) {
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "OMP Verifier Tests"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture baseline"], { cwd: root });
}

async function createSemanticFixture({ initialSources = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-semantic-capacity-"));
  const packagePath = join(root, "plugins", "publisher");
  await mkdir(join(packagePath, "verifications"), { recursive: true });
  await mkdir(join(packagePath, "docs"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(packagePath, "package.json"), JSON.stringify(semanticManifest()));
  await writeFile(join(packagePath, "verifications", "alignment.json"), JSON.stringify(semanticContract()));
  await writeFile(
    join(packagePath, "docs", "standard.md"),
    "# Supplied standard\n\n## Module Boundary Alignment\n\nA module owns an invariant or reusable behavior. Forwarding alone is not enough.\n",
  );
  await writeFile(join(root, "AGENTS.md"), "Keep project modules aligned with their owned invariants.\n");
  await writeFile(join(root, "src", "helper.js"), "export function helper(value) { return value; }\n");
  await writeFile(join(root, "src", "caller.js"), CALLER_SOURCE);
  for (const [path, source] of Object.entries(initialSources)) {
    const filePath = join(root, path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, source);
  }
  await initializeGit(root);
  return { root, packageDirectory: join(root, "plugins") };
}

async function discoverSemanticCheck(fixture) {
  const discovery = await discoverVerificationChecks({ packageDirectory: fixture.packageDirectory });
  const check = discovery.checks.find(candidate => candidate.id === CHECK_ID);
  assert.ok(check, "fixture semantic check should be discovered");
  assert.deepEqual(discovery.blockedResults, []);
  return check;
}

function largeChangedSource() {
  const lines = Array.from({ length: 200 }, (_, index) =>
    `export const boundaryValue${String(index).padStart(3, "0")} = "${"x".repeat(80)}";`);
  return `${lines.join("\n")}\n`;
}

function sourceWithByteLength(byteLength) {
  const prefix = 'export const value = "';
  const suffix = '";\n';
  return `${prefix}${"x".repeat(byteLength - prefix.length - suffix.length)}${suffix}`;
}

function sourceWithByteLengthAndLineCount(byteLength, lineCount) {
  const lines = Array.from({ length: lineCount }, (_, index) =>
    `export const originalLine${String(index + 1).padStart(3, "0")} = ${index + 1};`);
  const remainingLines = lines.slice(1).join("\n");
  const firstLineLength = byteLength - Buffer.byteLength(remainingLines) - 1;
  const prefix = 'export const deletedBoundary = "';
  const suffix = '";';
  const paddingLength = firstLineLength - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  lines[0] = `${prefix}${"x".repeat(paddingLength)}${suffix}`;
  return lines.join("\n");
}

function sourceRangeSelectors(path, lineCount, chunkSize = 100) {
  const selectors = [];
  for (let startLine = 1; startLine <= lineCount; startLine += chunkSize) {
    const endLine = Math.min(lineCount, startLine + chunkSize - 1);
    selectors.push(`${path}#L${startLine}-L${endLine}`);
  }
  return selectors;
}

function citationFor(path, source) {
  return { path, line: 1, quote: source.split(/\r?\n/)[0].slice(0, 80) };
}

function passAssessment(requestId, citation) {
  return {
    requestId,
    status: "PASS",
    summary: "The changed boundaries meet the supplied standard.",
    rationale: "The captured changed source supports the boundary assessment.",
    citations: [citation],
  };
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

test("when combined changed source exceeds 128 KB but fits the total budget, one complete review can PASS", async () => {
  // Arrange
  const source = largeChangedSource();
  const sources = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
    `src/boundary-${index}.js`,
    source,
  ]));
  const changedPaths = Object.keys(sources);
  const combinedBytes = Object.values(sources).reduce((total, content) => total + Buffer.byteLength(content), 0);
  const fixture = await createSemanticFixture({ initialSources: sources });

  try {
    const check = await discoverSemanticCheck(fixture);
    const prepared = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths,
    });
    const contextPaths = changedPaths.flatMap(path =>
      sourceRangeSelectors(path, sources[path].split(/\r?\n/).length));

    // Act
    const recovered = await readSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      contextPaths,
    });
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: recovered.reviewRequest.path,
      assessment: passAssessment(recovered.reviewRequest.requestId, citationFor(changedPaths[0], source)),
    });

    // Assert
    const context = recovered.reviewRequest.context;
    assert.ok(combinedBytes > 128_000);
    assert.ok(combinedBytes < 256_000);
    assert.ok(context.evidenceBudget.usedBytes > 128_000);
    assert.ok(context.evidenceBudget.usedBytes <= context.evidenceBudget.maxBytes);
    assert.deepEqual(context.missingChangedPaths, []);
    assert.equal(context.changedCodeCoverage.length, changedPaths.length);
    assert.ok(context.changedCodeCoverage.every(record => record.complete));
    assert.equal(completed.id, CHECK_ID);
    assert.equal(completed.status, "PASS");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when confirmed deletions exceed the remaining total budget, deleted source is accounted and BLOCKED", async () => {
  // Arrange
  const source = sourceWithByteLength(15_700);
  const deletedPaths = Array.from({ length: 16 }, (_, index) =>
    `src/deleted-${String(index).padStart(2, "0")}.js`);
  const initialSources = Object.fromEntries(deletedPaths.map(path => [path, source]));
  const fixture = await createSemanticFixture({ initialSources });

  try {
    const check = await discoverSemanticCheck(fixture);
    const initial = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: deletedPaths,
    });
    const initialContext = initial.reviewRequest.context;
    const initialChangedRecords = initialContext.changedCode.filter(record =>
      deletedPaths.includes(record.path) && record.state === "present");
    assert.equal(initialChangedRecords.length, deletedPaths.length);
    assert.ok(initialContext.evidenceBudget.usedBytes >= deletedPaths.length * 15_700);
    assert.ok(initialContext.evidenceBudget.usedBytes <= initialContext.evidenceBudget.maxBytes);

    for (const path of deletedPaths) await rm(join(fixture.root, path));
    const presentPath = "src/000-present.js";
    const presentSource = sourceWithByteLength(15_700);
    await writeFile(join(fixture.root, presentPath), presentSource);

    // Act
    const mixed = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: [...deletedPaths, presentPath],
    });
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: mixed.reviewRequest.path,
      assessment: passAssessment(mixed.reviewRequest.requestId, citationFor(presentPath, presentSource)),
    });

    // Assert
    const context = mixed.reviewRequest.context;
    const presentRecord = context.changedCode.find(record => record.path === presentPath);
    const admittedDeleted = context.changedCode.filter(record =>
      deletedPaths.includes(record.path) && record.state === "deleted");
    const rejectedPath = deletedPaths.at(-1);
    const rejectedDeletion = context.evidenceBudget.rejections.find(record => record.path === rejectedPath);
    assert.ok(rejectedDeletion);
    assert.equal(presentRecord.state, "present");
    assert.equal(presentRecord.source, "changed-code");
    assert.equal(presentRecord.sha256, sha256(presentSource));
    assert.equal(admittedDeleted.length, deletedPaths.length - 1);
    assert.ok(admittedDeleted.every(record =>
      record.source === "changed-code" && record.previousSha256 === sha256(source)));
    assert.ok(context.evidenceBudget.records.some(record =>
      record.path === presentPath && record.bytes === 15_700));
    const admittedDeletedBudgetRecords = context.evidenceBudget.records.filter(record =>
      deletedPaths.includes(record.path));
    assert.equal(admittedDeletedBudgetRecords.length, deletedPaths.length - 1);
    assert.equal(rejectedDeletion.source, "changed-code");
    assert.equal(rejectedDeletion.bytes, 15_700);
    assert.ok(context.evidenceBudget.usedBytes >= deletedPaths.length * 15_700);
    assert.ok(context.evidenceBudget.usedBytes + rejectedDeletion.bytes > context.evidenceBudget.maxBytes);
    assert.ok(context.missingChangedPaths.includes(rejectedPath));
    assert.equal(context.changedCode.find(record => record.path === rejectedPath).state, "unavailable");
    assert.equal(completed.status, "BLOCKED");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when 102 required changed files exceed the ordinary budget, one assessment retains present and deleted source", async () => {
  // Arrange
  const source = sourceWithByteLength(3_500);
  const changedPaths = Array.from({ length: 102 }, (_, index) => `src/module-${String(index).padStart(3, "0")}.js`);
  const initialSources = Object.fromEntries(changedPaths.map(path => [path, source]));
  const fixture = await createSemanticFixture({ initialSources });

  try {
    await rm(join(fixture.root, changedPaths.at(-1)));
    const prepared = await prepareSemanticEvaluation({
      check: await discoverSemanticCheck(fixture),
      cwd: fixture.root,
      changedPaths,
    });

    // Act
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId, citationFor(changedPaths[0], source)),
    });

    // Assert
    const context = prepared.reviewRequest.context;
    assert.deepEqual(prepared.reviewRequest.scope.changedPaths, changedPaths);
    assert.deepEqual(prepared.reviewRequest.missingContext, []);
    assert.ok(context.evidenceBudget.usedBytes > 256_000);
    assert.ok(context.evidenceBudget.usedBytes <= context.evidenceBudget.maxBytes);
    assert.ok(context.changedCode.every(record => record.state === "present" || record.state === "deleted"));
    const deleted = context.changedCode.find(record => record.path === changedPaths.at(-1));
    assert.equal(deleted.state, "deleted");
    assert.equal(deleted.previousSha256, sha256(source));
    assert.equal(completed.status, "PASS");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when mandatory code plus owning guidance exceeds 40 files, every boundary retains its guide", async () => {
  // Arrange
  const changedPaths = Array.from({ length: 21 }, (_, index) => `src/domain-${String(index).padStart(2, "0")}/module.js`);
  const initialSources = {};
  for (const path of changedPaths) {
    initialSources[path] = "export const invariant = true;\n";
    initialSources[`${dirname(path)}/README.md`] = "This domain owns its invariant.\n";
  }
  const fixture = await createSemanticFixture({ initialSources });

  try {
    // Act
    const prepared = await prepareSemanticEvaluation({
      check: await discoverSemanticCheck(fixture),
      cwd: fixture.root,
      changedPaths,
    });
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId, citationFor(changedPaths[0], initialSources[changedPaths[0]])),
    });

    // Assert
    const context = prepared.reviewRequest.context;
    assert.deepEqual(context.missingGuidancePaths, []);
    for (const path of changedPaths) {
      assert.ok(context.projectGuidance.some(record => record.path === `${dirname(path)}/README.md`));
    }
    assert.ok(context.evidenceBudget.usedFiles > 40);
    assert.deepEqual(prepared.reviewRequest.missingContext, []);
    assert.equal(completed.status, "PASS");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when required file cardinality exceeds large-scope capacity, optional recovery cannot admit a partial PASS", async () => {
  // Arrange
  const source = "export const invariant = true;\n";
  const changedPaths = Array.from({ length: 257 }, (_, index) => `src/module-${String(index).padStart(3, "0")}.js`);
  const fixture = await createSemanticFixture({ initialSources: Object.fromEntries(changedPaths.map(path => [path, source])) });

  try {
    const prepared = await prepareSemanticEvaluation({
      check: await discoverSemanticCheck(fixture),
      cwd: fixture.root,
      changedPaths,
    });

    // Act
    const recovered = await readSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      contextPaths: ["src/caller.js#L1-L1"],
    });
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: recovered.reviewRequest.path,
      assessment: passAssessment(recovered.reviewRequest.requestId, citationFor(changedPaths[0], source)),
    });

    // Assert
    assert.deepEqual(recovered.reviewRequest.scope.changedPaths, changedPaths);
    assert.ok(recovered.reviewRequest.missingContext.some(reason =>
      reason.includes("required-scope") && reason.includes("distinct")));
    assert.ok(recovered.reviewRequest.context.missingChangedPaths.includes(changedPaths.at(-1)));
    assert.equal(completed.status, "BLOCKED");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when required source exceeds the large-scope byte budget, missing complete source remains BLOCKED", async () => {
  // Arrange
  const source = sourceWithByteLength(15_700);
  const changedPaths = Array.from({ length: 70 }, (_, index) => `src/module-${String(index).padStart(3, "0")}.js`);
  const fixture = await createSemanticFixture({ initialSources: Object.fromEntries(changedPaths.map(path => [path, source])) });

  try {
    const prepared = await prepareSemanticEvaluation({
      check: await discoverSemanticCheck(fixture),
      cwd: fixture.root,
      changedPaths,
    });

    // Act
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId, citationFor(changedPaths[0], source)),
    });

    // Assert
    const budget = prepared.reviewRequest.context.evidenceBudget;
    assert.ok(budget.usedBytes <= budget.maxBytes);
    assert.ok(budget.rejections.some(record => record.source === "changed-code"
      && budget.usedBytes + record.bytes > budget.maxBytes));
    assert.ok(prepared.reviewRequest.missingContext.some(reason => reason.includes("required-scope")));
    assert.equal(completed.status, "BLOCKED");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when source byte limits are outside the supported range, validation rejects them", () => {
  // Arrange
  const invalidLimits = [
    15_999,
    256_001,
    16_000.5,
    Number.MAX_SAFE_INTEGER + 1,
    Infinity,
    -Infinity,
    NaN,
    "32768",
    null,
  ];

  // Act & Assert
  assert.equal(validateSourceByteLimit(), 16_000);
  assert.equal(validateSourceByteLimit(16_000), 16_000);
  assert.equal(validateSourceByteLimit(256_000), 256_000);
  for (const limit of invalidLimits) {
    assert.throws(() => validateSourceByteLimit(limit), RangeError);
  }
});

test("when a committed deletion exceeds the default source cap, explicit renewal succeeds and a later default rejects cached source", async () => {
  // Arrange
  const deletedPath = "src/deleted-boundary.js";
  const companionPath = "src/present-boundary.js";
  const source = sourceWithByteLengthAndLineCount(16_229, 439);
  const initialCompanion = "export const companion = false;\n";
  const companion = "export const companion = true;\n";
  assert.equal(Buffer.byteLength(source), 16_229);
  assert.equal(source.split(/\r?\n/).length, 439);
  const fixture = await createSemanticFixture({
    initialSources: {
      [deletedPath]: source,
      [companionPath]: initialCompanion,
    },
  });

  try {
    execFileSync("git", ["rm", "--", deletedPath], { cwd: fixture.root });
    execFileSync("git", ["commit", "--quiet", "-m", "delete oversized source"], { cwd: fixture.root });
    await writeFile(join(fixture.root, companionPath), companion);
    const check = await discoverSemanticCheck(fixture);
    const changedPaths = [deletedPath, companionPath];
    const defaultCapture = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      changedPaths,
    });
    const rejectedDeletion = defaultCapture.reviewRequest.context.changedCode.find(record =>
      record.path === deletedPath);

    // Act
    const expandedCapture = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      changedPaths,
      maxSourceBytes: 32_768,
    });
    const renewed = await readSemanticEvaluation({
      cwd: fixture.root,
      requestPath: expandedCapture.reviewRequest.path,
      contextPaths: ["src/helper.js#L1-L1"],
    });
    const citation = {
      path: deletedPath,
      line: 439,
      quote: source.split(/\r?\n/)[438],
    };
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: renewed.reviewRequest.path,
      assessment: passAssessment(renewed.reviewRequest.requestId, citation),
    });
    const resetCapture = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      changedPaths,
    });
    const resetDeletion = resetCapture.reviewRequest.context.changedCode.find(record =>
      record.path === deletedPath);

    // Assert
    assert.equal(defaultCapture.reviewRequest.scope.maxSourceBytes, 16_000);
    assert.equal(defaultCapture.reviewRequest.context.evidenceBudget.maxSourceBytes, 16_000);
    assert.equal(defaultCapture.status, "PENDING");
    assert.equal(rejectedDeletion.state, "unavailable");
    assert.match(rejectedDeletion.reason, /deleted source exceeds the 16000-byte changed-source limit/);
    const admittedDeletion = expandedCapture.reviewRequest.context.changedCode.find(record =>
      record.path === deletedPath);
    assert.equal(admittedDeletion.state, "deleted");
    assert.equal(admittedDeletion.content, source);
    assert.equal(admittedDeletion.previousSha256, sha256(source));
    assert.equal(expandedCapture.reviewRequest.scope.maxSourceBytes, 32_768);
    assert.equal(expandedCapture.reviewRequest.context.evidenceBudget.maxSourceBytes, 32_768);
    assert.ok(expandedCapture.reviewRequest.context.changedCode.some(record =>
      record.path === companionPath && record.state === "present" && record.content === companion));
    assert.equal(renewed.reviewRequest.scope.maxSourceBytes, 32_768);
    assert.equal(renewed.reviewRequest.context.evidenceBudget.maxSourceBytes, 32_768);
    assert.equal(renewed.reviewRequest.context.changedCode.find(record =>
      record.path === deletedPath).content, source);
    assert.equal(completed.status, "PASS");
    assert.ok(completed.evidence.includes(`${deletedPath}:439 (deleted)`));
    assert.equal(resetCapture.reviewRequest.scope.maxSourceBytes, 16_000);
    assert.equal(resetCapture.reviewRequest.context.evidenceBudget.maxSourceBytes, 16_000);
    assert.equal(resetDeletion.state, "unavailable");
    assert.match(resetDeletion.reason, /deleted source exceeds the 16000-byte changed-source limit/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
