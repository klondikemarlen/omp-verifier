import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { captureSemanticContext, validateSemanticCitations } from "#root/omp-plugin/semantic-context.js";
import { completeSemanticEvaluation, prepareSemanticEvaluation, readSemanticEvaluation } from "#root/omp-plugin/semantic-evaluations.js";
import { discoverVerificationChecks } from "#root/omp-plugin/verification-catalog.js";

const API_PATH = "node_modules/fixture-lib/index.js";
const API_SOURCE = "export function createFixture(attributes) { return { ...attributes }; }";
const LOCK_RECORD = '    "node_modules/fixture-lib": {\n      "version": "1.1.0"\n    }';
const SELECTORS = ["package-lock.json#L5-L7", `${API_PATH}#L1`];

async function fixture(t, lockfile) {
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-ranges-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = join(root, "plugins", "publisher");
  await mkdir(provider, { recursive: true });
  await mkdir(join(root, "node_modules", "fixture-lib"), { recursive: true });
  const content = lockfile ?? `{\n  "lockfileVersion": 3,\n  "padding": "${"x".repeat(538_608)}",\n  "packages": {\n${LOCK_RECORD}\n  }\n}\n`;
  await writeFile(join(root, "package-lock.json"), content);
  await writeFile(join(root, API_PATH), API_SOURCE);
  await writeFile(join(root, "usage.js"), 'import { createFixture } from "fixture-lib";\nexport const value = createFixture({ id: 1 });\n');
  await writeFile(join(provider, "standard.md"), "Fixture usage must match the resolved dependency and installed public API.\n");
  await writeFile(join(provider, "contract.json"), JSON.stringify({
    version: 1, standardId: "publisher:api", source: "./standard.md",
    gold: "Use the resolved public API.", requiredContext: ["changed-code"],
    rubric: [{ id: "api", question: "Does the call match the resolved public API?" }],
  }));
  await writeFile(join(provider, "package.json"), JSON.stringify({
    name: "publisher", version: "1.0.0", omp: { extensions: ["./index.js"], verifications: [{
      id: "publisher:api", label: "API", description: "Review fixture API use.", mode: "agentic", contract: "./contract.json",
    }] },
  }));
  const packageDirectory = join(root, "plugins");
  const { checks } = await discoverVerificationChecks({ packageDirectory });
  const check = checks.find(entry => entry.id === "publisher:api");
  const prepared = await prepareSemanticEvaluation({ cwd: root, check, changedPaths: ["usage.js"] });
  return { root, check, content, prepared };
}

function assessment(requestId) {
  return {
    requestId, status: "PASS", summary: "Fixture call matches the resolved API.",
    rationale: "The lock resolves fixture-lib 1.1.0 and the installed public function accepts the supplied attributes.",
    citations: [
      { path: "usage.js", line: 2, quote: "export const value = createFixture({ id: 1 });" },
      { path: "package-lock.json", line: 6, quote: '      "version": "1.1.0"' },
      { path: API_PATH, line: 1, quote: API_SOURCE },
    ],
  };
}

test("when a required lock record is in a large unchanged file, bounded recovery admits the resolved record and installed API", async t => {
  // Arrange
  const { root, prepared, content } = await fixture(t);
  // Act
  const recovered = await readSemanticEvaluation({ cwd: root, requestPath: prepared.reviewRequest.path, contextPaths: SELECTORS });
  const reviewedAssessment = assessment(recovered.reviewRequest.requestId);
  const completed = await completeSemanticEvaluation({ cwd: root, requestPath: recovered.reviewRequest.path, assessment: reviewedAssessment });
  // Assert
  assert.equal(completed.status, "PASS", completed.evidence);
  const record = recovered.reviewRequest.context.targetedContext.find(entry => entry.path === "package-lock.json");
  assert.equal(record.sha256, createHash("sha256").update(content).digest("hex"));
  assert.equal(record.content, LOCK_RECORD);
  assert.equal(record.startLine, 5);
  assert.equal(record.partial, true);
  assert.deepEqual(recovered.reviewRequest.scope.changedPaths, ["usage.js"]);
});

test("when the whole large lockfile is requested without a selector, the existing whole-file limit still applies", async t => {
  // Arrange
  const { root, prepared } = await fixture(t);
  // Act
  const recovered = await readSemanticEvaluation({ cwd: root, requestPath: prepared.reviewRequest.path, contextPaths: ["package-lock.json"] });
  // Assert
  assert.match(recovered.reviewRequest.context.targetedContext[0].reason, /16000-byte context limit/);
  assert.deepEqual(recovered.reviewRequest.context.missingContextPaths, ["package-lock.json"]);
});

test("when the large lockfile is changed source, a dependency excerpt cannot establish complete coverage", async t => {
  // Arrange
  const { root } = await fixture(t);
  // Act
  const captured = await captureSemanticContext({ repositoryRoot: root, changedPaths: ["package-lock.json"], contextPaths: [SELECTORS[0]] });
  // Assert
  assert.deepEqual(captured.context.missingChangedPaths, ["package-lock.json"]);
  assert.equal(captured.context.changedCodeCoverage[0].complete, false);
  assert.deepEqual(captured.context.changedCodeCoverage[0].omittedRanges, [[1, 4], [8, 10]]);
});

for (const sourceState of ["unchanged", "modified"]) {
  test(`when complete ranges recover a large changed source and it remains ${sourceState}, assessment preserves coverage and freshness`, async t => {
    // Arrange
    const entries = Array.from({
      length: 2_400,
    }, (_, index) => `  "package-${index}": "${"x".repeat(100)}"`);
    const content = `{\n${entries.join(",\n")}\n}\n`;
    const { root, check } = await fixture(t, content);
    const prepared = await prepareSemanticEvaluation({
      cwd: root,
      check,
      changedPaths: ["package-lock.json"],
    });
    const lineCount = content.split("\n").length;
    const contextPaths = [];
    for (let startLine = 1; startLine <= lineCount; startLine += 100) {
      const endLine = Math.min(startLine + 99, lineCount);
      contextPaths.push(`package-lock.json#L${startLine}-L${endLine}`);
    }
    const sourceHash = createHash("sha256").update(content).digest("hex");

    // Act
    const recovered = await readSemanticEvaluation({
      cwd: root,
      requestPath: prepared.reviewRequest.path,
      contextPaths,
    });
    const records = recovered.reviewRequest.context.changedCode;
    const coverage = recovered.reviewRequest.context.changedCodeCoverage[0];
    if (sourceState === "modified") {
      await writeFile(join(root, "package-lock.json"), content.replace("package-2399", "package-last"));
    }
    const reviewedAssessment = {
      requestId: recovered.reviewRequest.requestId,
      status: "PASS",
      summary: "All selected package entries are available for review.",
      rationale: "The complete changed lockfile is captured with original lines and a consistent source identity.",
      citations: [
        {
          path: "package-lock.json",
          line: 2,
          quote: `${entries[0]},`,
        },
      ],
    };
    const completed = await completeSemanticEvaluation({
      cwd: root,
      requestPath: recovered.reviewRequest.path,
      assessment: reviewedAssessment,
    });

    // Assert
    assert.equal(recovered.status, "PENDING");
    assert.deepEqual(recovered.reviewRequest.missingContext, []);
    assert.equal(coverage.complete, true);
    assert.deepEqual(coverage.coveredRanges, [[1, lineCount]]);
    assert.deepEqual(coverage.omittedRanges, []);
    assert.equal(records.map(record => record.content).join("\n"), content);
    assert.ok(records.every(record => record.sha256 === sourceHash));
    if (sourceState === "modified") {
      assert.equal(completed.status, "BLOCKED");
      assert.match(completed.evidence, /context changed/);
    } else {
      assert.equal(completed.status, "PASS", completed.evidence);
    }
  });
}

test("when unselected lockfile bytes change, evaluation rejects the stale dependency evidence", async t => {
  // Arrange
  const { root, prepared, content } = await fixture(t);
  const recovered = await readSemanticEvaluation({ cwd: root, requestPath: prepared.reviewRequest.path, contextPaths: SELECTORS });
  await writeFile(join(root, "package-lock.json"), content.replace("xxx", "yyy"));
  // Act
  const reviewedAssessment = assessment(recovered.reviewRequest.requestId);
  const completed = await completeSemanticEvaluation({ cwd: root, requestPath: recovered.reviewRequest.path, assessment: reviewedAssessment });
  // Assert
  assert.equal(completed.status, "BLOCKED");
  assert.match(completed.evidence, /context changed/);
});

test("when the installed public API is absent, successful lockfile capture cannot approve the review", async t => {
  // Arrange
  const { root, prepared } = await fixture(t);
  await rm(join(root, API_PATH));
  const recovered = await readSemanticEvaluation({ cwd: root, requestPath: prepared.reviewRequest.path, contextPaths: SELECTORS });
  // Act
  const reviewedAssessment = assessment(recovered.reviewRequest.requestId);
  const completed = await completeSemanticEvaluation({ cwd: root, requestPath: recovered.reviewRequest.path, assessment: reviewedAssessment });
  // Assert
  assert.notEqual(completed.status, "PASS");
  assert.deepEqual(recovered.reviewRequest.context.missingContextPaths, [API_PATH]);
});

const oversizedSelectedLine = `${"x".repeat(16_001)}\n`;
const sourceWithBinaryTail = `one\n${"x".repeat(270_000)}\0`;
const sourceBeyondScanCeiling = "x".repeat(8_000_001);

for (const [description, content, selector, reason] of [
  ["oversized selected line", oversizedSelectedLine, "#L1", /excerpt exceeds the 16000-byte evidence limit/],
  ["out-of-bounds range", "one\ntwo\n", "#L5", /requested line 5 is beyond end/],
  ["binary tail", sourceWithBinaryTail, "#L1", /file is not text/],
  ["scan ceiling", sourceBeyondScanCeiling, "#L1", /8000000-byte range scan limit/],
]) {
  test(`when targeted evidence has an ${description}, capture reports the specific unavailable prerequisite`, async t => {
    // Arrange
    const { root } = await fixture(t, content);
    // Act
    const captured = await captureSemanticContext({ repositoryRoot: root, changedPaths: ["usage.js"], contextPaths: [`package-lock.json${selector}`] });
    // Assert
    assert.match(captured.context.targetedContext[0].reason, reason);
    assert.deepEqual(captured.context.missingContextPaths, ["package-lock.json"]);
  });
}

for (const [description, content] of [
  ["binary tail", sourceWithBinaryTail],
  ["scan ceiling", sourceBeyondScanCeiling],
]) {
  test(`when changed-source ranges encounter a ${description}, capture cannot approve incomplete source`, async t => {
    // Arrange
    const { root } = await fixture(t, content);

    // Act
    const captured = await captureSemanticContext({
      repositoryRoot: root,
      changedPaths: ["package-lock.json"],
      contextPaths: ["package-lock.json#L1"],
    });

    // Assert
    assert.deepEqual(captured.context.missingChangedPaths, ["package-lock.json"]);
    assert.equal(captured.context.changedCodeCoverage[0].complete, false);
    assert.deepEqual(captured.context.changedCodeCoverage[0].coveredRanges, []);
  });
}

test("when UTF-8 and CRLF cross stream chunks, ranges retain exact text, original lines and the final empty line", async t => {
  // Arrange
  const line = "x".repeat(65_524);
  const content = `${line}\r\nresolved é\r\n`;
  const { root } = await fixture(t, content);
  // Act
  const captured = await captureSemanticContext({ repositoryRoot: root, changedPaths: ["usage.js"], contextPaths: ["package-lock.json#L2-L3"] });
  const citations = validateSemanticCitations([{ path: "package-lock.json", line: 2, quote: "resolved é" }], captured.context);
  // Assert
  assert.equal(captured.context.targetedContext[0].content, "resolved é\n");
  assert.equal(captured.context.targetedContext[0].lineCount, 3);
  assert.equal(citations[0].line, 2);
});

test("when selected dependency source resolves outside the project, bounded capture retains the project boundary", async t => {
  // Arrange
  const { root } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "omp-verifier-range-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "api.js"), API_SOURCE);
  await rm(join(root, API_PATH));
  await symlink(join(outside, "api.js"), join(root, API_PATH));
  // Act
  const captured = await captureSemanticContext({ repositoryRoot: root, changedPaths: ["usage.js"], contextPaths: [`${API_PATH}#L1`] });
  // Assert
  assert.equal(captured.context.targetedContext[0].reason, "path resolves outside the project");
});
