import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resumeCheckpoint } from "#root/omp-plugin/checkpoint-handoff.js";
import { discoverVerificationChecks } from "#root/omp-plugin/verification-catalog.js";
import {
  completeSemanticEvaluation,
  prepareSemanticEvaluation,
  readSemanticEvaluation,
  recordSemanticReviewPage,
} from "#root/omp-plugin/semantic-evaluations.js";
import { buildSemanticReviewPage, formatSemanticReviewPage } from "#root/omp-plugin/semantic-review-pages.js";

const CHECK_ID = "publisher:alignment";
const GUIDE = "# Source ownership\nKeep values nonnegative and review shared limits across files.\n";

function sourceFor(index, bytes) {
  const declaration = `export const value${index} = ${index};\n`;
  const padding = "// Retained complete source, not a selected excerpt.\n";
  return declaration + padding.repeat(Math.ceil((bytes - declaration.length) / padding.length));
}

async function createFixture({ count = 2, bytes = 140_000, guidance = GUIDE, untrackedLast = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-continuation-"));
  const packageDirectory = join(root, "plugins");
  const provider = join(packageDirectory, "publisher");
  await mkdir(provider, { recursive: true });
  await mkdir(join(root, "src"));
  await writeFile(join(provider, "package.json"), JSON.stringify({
    name: "publisher", version: "1.0.0", omp: { extensions: ["./index.js"], verifications: [{
      id: CHECK_ID, mode: "agentic", label: "Value Alignment",
      description: "Review nonnegative values and their shared limits.", contract: "./contract.json",
    }] },
  }));
  await writeFile(join(provider, "standard.md"), "# Value Alignment\nValues must be nonnegative and respect shared limits.\n");
  await writeFile(join(provider, "contract.json"), JSON.stringify({
    version: 1, standardId: CHECK_ID, source: "./standard.md", gold: "Values are nonnegative and agree across files.",
    requiredContext: ["changed-code", "project-guidance"],
    rubric: [{ id: "values", question: "Do values and shared limits agree?" }],
  }));
  await writeFile(join(root, "README.md"), "# Fixture\nFollow the source ownership guide.\n");
  await writeFile(join(root, "src/README.md"), guidance);
  const changedPaths = Array.from({ length: count }, (_, index) => `src/value-${index}.js`);
  for (const [index, path] of changedPaths.entries()) await writeFile(join(root, path), sourceFor(index, bytes));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  if (untrackedLast) execFileSync("git", ["rm", "--cached", "--quiet", "--", changedPaths.at(-1)], { cwd: root });
  execFileSync("git", ["-c", "user.name=Verifier Tests", "-c", "user.email=tests@example.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: root });
  const { checks } = await discoverVerificationChecks({ packageDirectory });
  const check = checks.find(entry => entry.id === CHECK_ID);
  const initial = await prepareSemanticEvaluation({ check, cwd: root, changedPaths, maxSourceBytes: 256_000 });
  if (!initial.reviewRequest) {
    await rm(root, { recursive: true, force: true });
    throw new Error(`Fixture preparation failed: ${JSON.stringify(initial)}`);
  }
  const continued = await readSemanticEvaluation({ cwd: root, requestPath: initial.reviewRequest.path, continuation: true });
  return { root, provider, initial, continued, changedPaths, check };
}

function assessmentFor(review, status = "PASS") {
  const batchIndex = review.reviewRequest.continuation.batchIndex;
  const sourcePath = review.reviewRequest.scope.changedPaths[0];
  const sourceIndex = Number(sourcePath.match(/value-(\d+)/)[1]);
  let citation = {
    path: sourcePath,
    line: 1,
    quote: `export const value${sourceIndex} = ${sourceIndex};`,
  };
  if (batchIndex !== null) {
    const context = review.reviewRequest.context;
    const record = [...context.changedCode, ...context.projectGuidance, ...context.targetedContext]
      .find(entry => entry.content?.trim());
    const lines = record.content.split("\n");
    const firstLine = lines.findIndex(line => line.trim());
    const citationLine = (record.startLine ?? 1) + firstLine;
    citation = {
      path: record.path,
      line: citationLine,
      quote: lines[firstLine],
    };
  }
  return {
    requestId: review.reviewRequest.requestId,
    status,
    summary: status === "PASS" ? "Values satisfy the supplied standard." : "A required value check remains unresolved.",
    rationale: "Source values are nonnegative; cross-file integration must also respect the shared limits.",
    citations: [citation],
    ...(status === "FAIL" ? {
      findings: [{
        path: sourcePath,
        summary: "The value violates the shared limit.",
      }],
    } : {}),
    ...(batchIndex === null
      ? { coveredBatches: review.reviewRequest.continuation.batches.map(batch => batch.index) }
      : { batchIndex, crossBatchNotes: "Compare the exported values with the other batches under the same source ownership guide." }),
  };
}

async function completeBatches(fixture, firstStatus = "PASS") {
  let review = fixture.continued;
  while (review.reviewRequest?.continuation.phase === "batch") {
    const status = review.reviewRequest.continuation.batchIndex === 0 ? firstStatus : "PASS";
    review = await completeSemanticEvaluation({ cwd: fixture.root, requestPath: review.reviewRequest.path, assessment: assessmentFor(review, status) });
  }
  return review;
}

async function finalize(fixture, review, overrides = {}) {
  return completeSemanticEvaluation({
    cwd: fixture.root, requestPath: review.reviewRequest.path,
    assessment: { ...assessmentFor(review), ...overrides },
  });
}

test("when a fresh session exits without assessing the aggregate, the checkpoint remains pending", async t => {
  // Arrange
  const fixture = await createFixture({
    count: 1,
    bytes: 200,
  });
  t.after(() => rm(fixture.root, {
    recursive: true,
    force: true,
  }));
  const { path: requestPath, requestId } = fixture.continued.reviewRequest;
  await completeBatches(fixture);

  // Act
  const result = await resumeCheckpoint({
    cwd: fixture.root,
    requestPath,
  }, async () => {});

  // Assert
  assert.equal(result.status, "PENDING");
  assert.equal(result.reviewRequest.requestId, requestId);
  assert.equal(result.reviewRequest.continuation.phase, "aggregate");
  assert.equal(result.reviewRequest.continuation.batches[0].assessment.status, "PASS");
});

test("when the origin also assesses during a handoff, only the fresh reviewer's verdict is accepted", async t => {
  // Arrange
  const fixture = await createFixture({
    count: 1,
    bytes: 200,
  });
  t.after(() => rm(fixture.root, {
    recursive: true,
    force: true,
  }));
  const aggregate = await completeBatches(fixture);
  const requestPath = aggregate.reviewRequest.path;
  const cli = fileURLToPath(new URL("../bin/omp-verifier.js", import.meta.url));
  let originatingResult;

  // Act
  const result = await resumeCheckpoint({
    cwd: fixture.root,
    requestPath,
  }, async () => {
    originatingResult = await finalize(fixture, aggregate);
    const assessment = {
      ...assessmentFor(aggregate),
      summary: "Fresh review confirms the nonnegative values.",
    };
    execFileSync(process.execPath, [cli, "evaluate", requestPath, "--assessment", "-"], {
      cwd: fixture.root,
      env: {
        ...process.env,
        OMP_VERIFIER_FRESH_REVIEWER: requestPath,
      },
      input: JSON.stringify(assessment),
    });
  });

  // Assert
  assert.equal(originatingResult.status, "PENDING");
  assert.equal(result.status, "PASS");
  assert.equal(result.summary, "Fresh review confirms the nonnegative values.");
});

test("when a handoff is attempted before a checkpoint, dispatch is refused", async t => {
  // Arrange
  const fixture = await createFixture({
    count: 1,
    bytes: 200,
  });
  t.after(() => rm(fixture.root, {
    recursive: true,
    force: true,
  }));
  const requestPath = fixture.continued.reviewRequest.path;

  // Act
  const handoff = resumeCheckpoint({
    cwd: fixture.root,
    requestPath,
  }, () => assert.fail("Dispatched before the first checkpoint"));

  // Assert
  await assert.rejects(handoff, /requires an accepted batch checkpoint/);
});

test("when required source exceeds the aggregate tier, complete checkpoints permit one whole-scope assessment", async () => {
  // Arrange
  const fixture = await createFixture({ count: 5, bytes: 220_000 });
  try {
    // Act
    const aggregate = await completeBatches(fixture);
    const final = await finalize(fixture, aggregate);

    // Assert
    assert.equal(final.status, "PASS", final.evidence);
    assert.deepEqual(aggregate.reviewRequest.scope.changedPaths, fixture.changedPaths);
    assert.equal(aggregate.status, "PENDING");
    assert.ok(fixture.initial.reviewRequest.missingContext.some(reason => reason.includes("required-scope")));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when a continuation partitions source, it captures shared guidance once across bounded batches", async () => {
  // Arrange
  const fixture = await createFixture();
  try {
    // Act
    const batches = [];
    for (const entry of fixture.continued.reviewRequest.continuation.batches) {
      const review = await readSemanticEvaluation({ cwd: fixture.root, requestPath: fixture.continued.reviewRequest.path, batchIndex: entry.index });
      batches.push(review.reviewRequest.context);
    }

    // Assert
    const guides = batches.flatMap(context => context.projectGuidance).filter(record => record.path === "src/README.md");
    assert.deepEqual(guides.map(record => record.content), [GUIDE]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when checkpoints remain unassessed, early final PASS leaves the continuation recoverable", async () => {
  // Arrange
  const fixture = await createFixture();
  try {
    const draft = assessmentFor(fixture.continued);
    delete draft.batchIndex;
    draft.coveredBatches = [0, 1];

    // Act
    const early = await completeSemanticEvaluation({ cwd: fixture.root, requestPath: fixture.continued.reviewRequest.path, assessment: draft });
    const aggregate = await completeBatches(fixture);
    const final = await finalize(fixture, aggregate);

    // Assert
    assert.equal(early.status, "BLOCKED");
    assert.match(early.evidence, /complete every batch checkpoint/);
    assert.equal(final.status, "PASS", final.evidence);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const status of ["FAIL", "BLOCKED"]) {
  test(`when a saved batch is ${status}, the final assessment cannot overwrite it with PASS`, async () => {
    // Arrange
    const fixture = await createFixture();
    try {
      const aggregate = await completeBatches(fixture, status);

      // Act
      const final = await finalize(fixture, aggregate);

      // Assert
      assert.equal(final.status, "BLOCKED");
      assert.match(final.evidence, /cannot override/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

for (const changedPath of ["src/value-0.js", "src/value-1.js", "src/README.md"]) {
  test(`when ${changedPath} changes after checkpoints, the whole-scope assessment rejects stale evidence`, async () => {
    // Arrange
    const fixture = await createFixture();
    try {
      const aggregate = await completeBatches(fixture);
      await writeFile(join(fixture.root, changedPath), "Changed source invalidates the saved review.\n");

      // Act
      const final = await finalize(fixture, aggregate);

      // Assert
      assert.equal(final.status, "BLOCKED");
      assert.match(final.evidence, /changed/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test("when a checkpoint has an invalid citation, correction on the same request can continue", async () => {
  // Arrange
  const fixture = await createFixture();
  try {
    const draft = assessmentFor(fixture.continued);
    draft.citations[0].quote = "not captured source";

    // Act
    const rejected = await completeSemanticEvaluation({ cwd: fixture.root, requestPath: fixture.continued.reviewRequest.path, assessment: draft });
    const next = await finalize(fixture, fixture.continued);

    // Assert
    assert.equal(rejected.summary, "Semantic assessment is invalid");
    assert.equal(next.status, "PENDING");
    assert.equal(next.reviewRequest.continuation.batchIndex, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when a different process resumes a request, it receives the next batch and saved cross-batch reasoning", async () => {
  // Arrange
  const fixture = await createFixture();
  const moduleUrl = new URL("../omp-plugin/semantic-evaluations.js", import.meta.url).href;
  try {
    await finalize(fixture, fixture.continued);

    // Act
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { readSemanticEvaluation } from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify(await readSemanticEvaluation({cwd:process.argv[1],requestPath:process.argv[2]})));
    `, fixture.root, fixture.continued.reviewRequest.path], { encoding: "utf8" });
    const resumed = JSON.parse(output);

    // Assert
    assert.equal(resumed.reviewRequest.continuation.batchIndex, 1);
    assert.equal(resumed.reviewRequest.continuation.batches[0].assessment.crossBatchNotes,
      "Compare the exported values with the other batches under the same source ownership guide.");
    assert.deepEqual(resumed.reviewRequest.scope.changedPaths, fixture.changedPaths);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when only the first page of a batch was delivered, its checkpoint remains pending on that batch", async () => {
  // Arrange
  const fixture = await createFixture();
  try {
    const page = buildSemanticReviewPage(fixture.continued);
    await recordSemanticReviewPage({ cwd: fixture.root, page });

    // Act
    const pending = await finalize(fixture, fixture.continued);

    // Assert
    assert.equal(pending.status, "PENDING");
    assert.equal(pending.reviewRequest.continuation.batchIndex, 0);
    assert.equal(pending.reviewProgress.nextPage, 1);
    assert.match(formatSemanticReviewPage(page), /--batch 0/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when context renewal supersedes a continuation, it discards earlier checkpoints", async () => {
  // Arrange
  const fixture = await createFixture();
  try {
    const next = await finalize(fixture, fixture.continued);

    // Act
    const renewed = await readSemanticEvaluation({ cwd: fixture.root, requestPath: next.reviewRequest.path, contextPaths: ["src/README.md#L1-L2"] });

    // Assert
    assert.notEqual(renewed.reviewRequest.requestId, next.reviewRequest.requestId);
    assert.equal(renewed.reviewRequest.continuation.batchIndex, 0);
    assert.ok(renewed.reviewRequest.continuation.batches.every(batch => batch.assessment === undefined));
    assert.deepEqual(renewed.reviewRequest.scope.changedPaths, fixture.changedPaths);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when the final review cites source from an earlier batch, exact saved source remains available", async () => {
  // Arrange
  const fixture = await createFixture();
  try {
    const aggregate = await completeBatches(fixture);
    const earlier = await readSemanticEvaluation({ cwd: fixture.root, requestPath: aggregate.reviewRequest.path, batchIndex: 0 });
    const citations = assessmentFor(earlier).citations;

    // Act
    const final = await finalize(fixture, aggregate, { citations });

    // Assert
    assert.equal(final.status, "PASS", final.evidence);
    assert.match(final.evidence, /src\/value-0.js:1/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when a saved batch is altered, request integrity rejects the continuation", async () => {
  // Arrange
  const fixture = await createFixture();
  try {
    const requestPath = fixture.continued.reviewRequest.path;
    const stored = JSON.parse(await readFile(requestPath, "utf8"));
    stored.payload.continuation.batches[0].changedPaths = [];
    await writeFile(requestPath, JSON.stringify(stored));

    // Act
    const result = await readSemanticEvaluation({ cwd: fixture.root, requestPath });

    // Assert
    assert.equal(result.status, "BLOCKED");
    assert.match(result.evidence, /tampered/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when required cardinality exceeds one capture, continuation retains every changed file", async () => {
  // Arrange
  const fixture = await createFixture({ count: 257, bytes: 1000 });
  try {
    // Act
    const aggregate = await completeBatches(fixture);
    const final = await finalize(fixture, aggregate);

    // Assert
    assert.equal(final.status, "PASS", final.evidence);
    const records = aggregate.reviewRequest.continuation.batches.flatMap(batch => batch.evidenceRecords);
    const changedPaths = records.filter(record => record.source === "changed-code").map(record => record.path);
    assert.deepEqual([...new Set(changedPaths)].toSorted(), fixture.changedPaths.toSorted());
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when a source and guide exceed a batch, evidence checkpoints retain both before whole-scope approval", async () => {
  // Arrange
  const fixture = await createFixture({
    count: 5,
    bytes: 250_000,
    guidance: GUIDE.repeat(190),
  });
  try {
    // Act
    const aggregate = await completeBatches(fixture);
    const final = await finalize(fixture, aggregate);

    // Assert
    assert.equal(final.status, "PASS", final.evidence);
    assert.deepEqual(aggregate.reviewRequest.scope.changedPaths, fixture.changedPaths);
    const ledger = aggregate.reviewRequest.continuation.batches;
    assert.ok(ledger.every(batch => batch.usedBytes <= 256_000));
    assert.ok(ledger.some(batch => batch.evidenceRecords.some(record => record.path === "src/README.md")));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when another batch has all page receipts, it cannot authorize an unread batch", async () => {
  // Arrange
  const fixture = await createFixture();
  try {
    await recordSemanticReviewPage({ cwd: fixture.root, page: buildSemanticReviewPage(fixture.continued) });
    const later = await readSemanticEvaluation({ cwd: fixture.root, requestPath: fixture.continued.reviewRequest.path, batchIndex: 1 });
    const firstPage = buildSemanticReviewPage(later);
    for (let index = 0; index < firstPage.count; index += 1) {
      await recordSemanticReviewPage({ cwd: fixture.root, page: buildSemanticReviewPage(later, index) });
    }

    // Act
    const result = await finalize(fixture, fixture.continued);

    // Assert
    assert.equal(result.status, "PENDING");
    assert.equal(result.reviewRequest.continuation.batchIndex, 0);
    assert.equal(result.reviewProgress.nextPage, 1);

    const cliPath = join(process.cwd(), "bin", "omp-verifier.js");
    const resumed = execFileSync(process.execPath, [
      cliPath, "review", fixture.continued.reviewRequest.path, "--resume", "--reporter", "text",
    ], {
      cwd: fixture.root,
      encoding: "utf8",
    });
    assert.match(resumed, /^Batch index: 0\b/m);
    assert.match(resumed, /^Page index: 1\b/m);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when an untracked late-batch source is deleted, renewal retains its authenticated full source", async () => {
  // Arrange
  const fixture = await createFixture({ count: 5, bytes: 220_000, untrackedLast: true });
  try {
    await completeBatches(fixture);
    const deletedPath = fixture.changedPaths.at(-1);
    await rm(join(fixture.root, deletedPath));

    // Act
    const renewed = await prepareSemanticEvaluation({
      check: fixture.check, cwd: fixture.root, changedPaths: fixture.changedPaths, maxSourceBytes: 256_000,
    });
    const aggregate = await completeBatches({ ...fixture, continued: renewed });
    const final = await finalize(fixture, aggregate, {
      citations: [{ path: deletedPath, line: 1, quote: "export const value4 = 4;" }],
    });

    // Assert
    assert.equal(final.status, "PASS", final.evidence);
    assert.match(final.evidence, /src\/value-4.js:1 \(deleted\)/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when integration finds a cross-batch violation after local checkpoints, the whole review can FAIL", async () => {
  // Arrange
  const fixture = await createFixture();
  try {
    const aggregate = await completeBatches(fixture);

    // Act
    const final = await finalize(fixture, aggregate, {
      status: "FAIL", summary: "The exported values disagree across boundaries.",
      rationale: "Local values are nonnegative, but value0 and value1 violate the required shared equality constraint.",
      findings: [{ path: "src/value-1.js", summary: "value1 differs from the required shared value0." }],
      citations: [
        { path: "src/value-0.js", line: 1, quote: "export const value0 = 0;" },
        { path: "src/value-1.js", line: 1, quote: "export const value1 = 1;" },
      ],
    });

    // Assert
    assert.equal(final.status, "FAIL");
    assert.match(final.evidence, /src\/value-0.js:1/);
    assert.match(final.evidence, /src\/value-1.js:1/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const status of ["FAIL", "BLOCKED"]) {
  test(`when final integration is ${status}, saved batch findings remain visible without duplicating an aggregate finding`, async () => {
    // Arrange
    const fixture = await createFixture();
    try {
      const aggregate = await completeBatches(fixture, "FAIL");
      const finding = {
        path: "src/value-0.js",
        summary: "The value violates the shared limit.",
      };

      // Act
      const final = await finalize(fixture, aggregate, {
        status,
        findings: status === "FAIL" ? [finding] : [],
      });

      // Assert
      assert.equal(final.status, status);
      assert.deepEqual(final.findings, [finding]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

for (const changedAfterCheckpoint of [false, true]) {
  test(`when one changed source spans batches, complete original-line coverage ${changedAfterCheckpoint ? "rejects a later mutation" : "supports one final assessment"}`, async () => {
    // Arrange
    const fixture = await createFixture({
      count: 1,
      bytes: 300_000,
    });
    try {
      const path = fixture.changedPaths[0];
      const original = await readFile(join(fixture.root, path), "utf8");
      const lineCount = original.split("\n").length;
      const contextPaths = [];
      for (let startLine = 1; startLine <= lineCount; startLine += 250) {
        const endLine = Math.min(startLine + 249, lineCount);
        contextPaths.push(`${path}#L${startLine}-L${endLine}`);
      }
      fixture.continued = await readSemanticEvaluation({
        cwd: fixture.root,
        requestPath: fixture.continued.reviewRequest.path,
        contextPaths,
        continuation: true,
      });
      const chunks = [];
      for (const batch of fixture.continued.reviewRequest.continuation.batches) {
        const review = await readSemanticEvaluation({
          cwd: fixture.root,
          requestPath: fixture.continued.reviewRequest.path,
          batchIndex: batch.index,
        });
        chunks.push(...review.reviewRequest.context.changedCode.filter(record => typeof record.content === "string"));
      }
      const aggregate = await completeBatches(fixture);
      if (changedAfterCheckpoint) {
        await writeFile(join(fixture.root, path), `${original}// Changed after the last captured line.\n`);
      }

      // Act
      const final = await finalize(fixture, aggregate);

      // Assert
      assert.equal(chunks.map(record => record.content).join("\n"), original);
      assert.equal(chunks[0].startLine ?? 1, 1);
      const lastChunk = chunks.at(-1);
      assert.equal((lastChunk.startLine ?? 1) + lastChunk.content.split("\n").length - 1, lineCount);
      assert.equal(final.status, changedAfterCheckpoint ? "BLOCKED" : "PASS", final.evidence);
      if (changedAfterCheckpoint) assert.match(final.evidence, /changed/);
    } finally {
      await rm(fixture.root, {
        recursive: true,
        force: true,
      });
    }
  });
}

test("when required evidence needs more than thirty-two batches, continuation retains an explicit capacity blocker", async () => {
  // Arrange
  const guidance = GUIDE.repeat(190);
  const fixture = await createFixture({
    count: 33,
    bytes: 250_000,
    guidance,
  });
  try {
    // Act
    const result = fixture.continued;

    // Assert
    assert.equal(result.status, "BLOCKED");
    assert.match(result.evidence, /32 batches of 256000 bytes \/ 256 paths/);
  } finally {
    await rm(fixture.root, {
      recursive: true,
      force: true,
    });
  }
});
