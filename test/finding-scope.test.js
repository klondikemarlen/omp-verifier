import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { completeSemanticEvaluation, readSemanticEvaluation } from "#root/omp-plugin/semantic-evaluations.js";
import { runAutomaticVerificationForPaths } from "#root/omp-plugin/verifications.js";
import { formatVerificationResults } from "#root/omp-plugin/reporters.js";

const CLI = fileURLToPath(new URL("../bin/omp-verifier.js", import.meta.url));
const ID = "publisher:values";
const CHANGED = {
  path: "src/value.js",
  line: 1,
  quote: "export const value = -1;",
};
const UNCHANGED = {
  path: "src/value.js",
  line: 2,
  quote: "export const untouched = -2;",
};
const UNCHANGED_CALCULATION = {
  path: "src/value.js",
  line: 3,
  quote: "export const computed = Math.sqrt(value);",
};
const UNCHANGED_SOURCE = `${UNCHANGED.quote}\n${UNCHANGED_CALCULATION.quote}\n`;
const CALLER = {
  path: "src/caller.js",
  line: 2,
  quote: "export const result = Math.sqrt(value);",
};
const LEGACY = {
  path: "src/legacy.js",
  line: 1,
  quote: "export const legacy = -10;",
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-findings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDirectory = join(root, "plugins", "node_modules");
  const provider = join(packageDirectory, "publisher");
  await mkdir(provider, { recursive: true });
  await mkdir(join(root, "src"));
  await writeFile(join(provider, "package.json"), JSON.stringify({
    name: "publisher", version: "1.0.0", omp: {
      extensions: ["./index.js"],
      verifications: [{
        id: ID, label: "Values", description: "Keep exported values nonnegative.",
        mode: "agentic", contract: "./contract.json", pathTriggers: ["src/*.js"],
      }],
    },
  }));
  await writeFile(join(provider, "standard.md"), "# Values\nExported values must be nonnegative.\n");
  await writeFile(join(provider, "contract.json"), JSON.stringify({
    version: 1, standardId: ID, source: "./standard.md",
    gold: "Exported values must be nonnegative.", requiredContext: ["changed-code"],
    rubric: [{ id: "nonnegative", question: "Are exported values nonnegative?" }],
  }));
  await writeFile(join(root, CHANGED.path), `export const value = 1;\n${UNCHANGED_SOURCE}`);
  await writeFile(join(root, "src/caller.js"), 'import { value } from "./value.js";\nexport const result = Math.sqrt(value);\n');
  await writeFile(join(root, LEGACY.path), `${LEGACY.quote}\n`);
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Finding scope tests");
  git("config", "user.email", "findings@example.invalid");
  git("add", ".");
  git("commit", "--quiet", "-m", "baseline");
  const baseRef = git("rev-parse", "HEAD");
  await writeFile(join(root, CHANGED.path), `${CHANGED.quote}\n${UNCHANGED_SOURCE}`);
  git("add", "src/value.js");
  git("commit", "--quiet", "-m", "change value");
  const headCommit = git("rev-parse", "HEAD");
  const prepare = async (options = {}) => (await runAutomaticVerificationForPaths({
    cwd: root,
    packageDirectory,
    baseRef,
    ...options,
  }))[0];
  return { root, provider, packageDirectory, baseRef, headCommit, git, prepare };
}

function failure(prepared, findings, citations = [CHANGED]) {
  return {
    requestId: prepared.reviewRequest.requestId,
    status: "FAIL",
    summary: "The delivery violates the standard.",
    rationale: "A negative export violates the nonnegative requirement.",
    findings,
    citations,
  };
}

async function evaluate(f, prepared, assessment) {
  return completeSemanticEvaluation({ cwd: f.root, requestPath: prepared.reviewRequest.path, assessment });
}

function findingAt(citation, summary) {
  return {
    path: citation.path,
    line: citation.line,
    summary,
  };
}

test("when legacy context is captured, it cannot become a finding without attributed regression evidence", async t => {
  // Arrange
  const f = await fixture(t);
  const initial = await f.prepare();
  const prepared = await readSemanticEvaluation({ cwd: f.root, requestPath: initial.reviewRequest.path, contextPaths: ["src/legacy.js"] });
  const citations = [CHANGED, LEGACY];
  const changedFinding = findingAt(CHANGED, "The changed export is negative.");

  // Act
  const rejected = await evaluate(f, prepared, failure(prepared, [findingAt(LEGACY, "Legacy value is negative.")], citations));
  const accepted = await evaluate(f, prepared, failure(prepared, [changedFinding], citations));

  // Assert
  assert.equal(rejected.status, "BLOCKED");
  assert.match(rejected.evidence, /unchanged-context finding introducedBy/);
  assert.equal(accepted.status, "FAIL");
  assert.deepEqual(accepted.findings, [changedFinding]);
  assert.match(accepted.evidence, /src\/legacy.js/);
});

test("when a file has changed and unchanged lines, only exact citations to changed lines support direct findings", async t => {
  // Arrange
  const f = await fixture(t);
  const prepared = await f.prepare();
  const unchangedFinding = findingAt(UNCHANGED, "Untouched export is negative.");
  const changedFinding = findingAt(CHANGED, "Changed export is negative.");

  // Act
  const wrongLine = await evaluate(f, prepared, failure(prepared, [unchangedFinding]));
  const unchangedLine = await evaluate(f, prepared, failure(prepared, [unchangedFinding], [CHANGED, UNCHANGED]));
  const accepted = await evaluate(f, prepared, failure(prepared, [changedFinding], [CHANGED, UNCHANGED]));

  // Assert
  assert.equal(wrongLine.status, "BLOCKED");
  assert.match(wrongLine.evidence, /requires an exact captured source citation: src\/value\.js:2/);
  assert.equal(unchangedLine.status, "BLOCKED");
  assert.match(unchangedLine.evidence, /unchanged-context finding introducedBy/);
  assert.equal(accepted.status, "FAIL", accepted.evidence);
  assert.equal(accepted.scope.mode, "changed-lines");
  assert.deepEqual(accepted.scope.lineRanges, {
    "src/value.js": [[1, 1]],
  });
  assert.deepEqual(accepted.findings, [changedFinding]);
});

test("when an unchanged line regresses in the same file, its finding requires an actually changed introducer line", async t => {
  // Arrange
  const f = await fixture(t);
  const prepared = await f.prepare();
  const finding = {
    ...findingAt(UNCHANGED_CALCULATION, "Unchanged calculation now exports NaN."),
    introducedBy: CHANGED.path,
    introducedByLine: UNCHANGED.line,
    regression: "The changed negative input makes the existing square root return NaN.",
  };
  const citations = [CHANGED, UNCHANGED, UNCHANGED_CALCULATION];

  // Act
  const wrongIntroducer = await evaluate(f, prepared, failure(prepared, [finding], citations));
  const causalFinding = {
    ...finding,
    introducedByLine: CHANGED.line,
  };
  const accepted = await evaluate(f, prepared, failure(prepared, [causalFinding], citations));

  // Assert
  assert.equal(wrongIntroducer.status, "BLOCKED");
  assert.match(wrongIntroducer.evidence, /requires a cited changed line: src\/value\.js:2/);
  assert.equal(accepted.status, "FAIL", accepted.evidence);
  assert.deepEqual(accepted.findings, [causalFinding]);
});

test("when a request with whole-file cleanup is reconciled, untouched lines remain eligible", async t => {
  // Arrange
  const f = await fixture(t);
  const wholeFilePaths = [CHANGED.path];
  const prepared = await f.prepare({
    wholeFilePaths,
  });
  f.git("commit", "--quiet", "--allow-empty", "-m", "update delivery head");
  const finding = findingAt(UNCHANGED, "Clean up the untouched negative export.");

  // Act
  const renewed = await evaluate(f, prepared, failure(prepared, [finding], [UNCHANGED]));
  const accepted = await evaluate(f, renewed, failure(renewed, [finding], [UNCHANGED]));

  // Assert
  assert.equal(renewed.status, "PENDING");
  assert.notEqual(renewed.reviewRequest.requestId, prepared.reviewRequest.requestId);
  assert.deepEqual(renewed.reviewRequest.scope.automatic.delivery.wholeFilePaths, wholeFilePaths);
  assert.equal(accepted.status, "FAIL", accepted.evidence);
  assert.deepEqual(accepted.findings, [finding]);
  assert.equal(accepted.scope.mode, "changed-lines-and-files");
  assert.deepEqual(accepted.scope.wholeFilePaths, wholeFilePaths);
  assert.match(formatVerificationResults([accepted]), /Whole-file cleanup: src\/value\.js/);
});

test("when a changed export breaks an unchanged caller, its cited causal attribution survives reporting", async t => {
  // Arrange
  const f = await fixture(t);
  const initial = await f.prepare();
  const findings = [{
    ...findingAt(CALLER, "The caller now exports NaN."),
    introducedBy: CHANGED.path,
    introducedByLine: CHANGED.line,
    regression: "The changed negative input makes the unchanged square root return NaN.",
  }];

  // Act
  const unseen = await evaluate(f, initial, failure(initial, findings, [CHANGED, CALLER]));
  const prepared = await readSemanticEvaluation({
    cwd: f.root,
    requestPath: initial.reviewRequest.path,
    callerContextPaths: ["src/caller.js"],
  });
  const accepted = await evaluate(f, prepared, failure(prepared, findings, [CHANGED, CALLER]));
  const report = formatVerificationResults([accepted]);

  // Assert
  assert.equal(unseen.status, "BLOCKED");
  assert.match(unseen.evidence, /citation src\/caller\.js:2 is not in the captured evidence/);
  assert.equal(accepted.status, "FAIL", accepted.evidence);
  assert.deepEqual(accepted.findings, findings);
  assert.match(report, /Finding: src\/caller.js:2: The caller now exports NaN/);
  assert.match(report, /Introduced by: src\/value.js:1/);
  assert.equal(accepted.scope.baseCommit, f.baseRef);
  assert.equal(accepted.scope.headCommit, f.headCommit);
});

const missingCitation = {
  path: "src/missing.js",
  line: 1,
};
for (const findings of [
  undefined,
  [],
  [{
    path: CHANGED.path,
    summary: "Missing finding line.",
  }],
  [findingAt(missingCitation, "No captured evidence.")],
]) {
  test(`when FAIL has ${findings === undefined ? "no" : JSON.stringify(findings)} attribution, correction can still complete the request`, async t => {
    // Arrange
    const f = await fixture(t);
    const prepared = await f.prepare();

    // Act
    const rejected = await evaluate(f, prepared, failure(prepared, findings));
    const accepted = await evaluate(f, prepared, failure(prepared, [findingAt(CHANGED, "Negative export.")]));

    // Assert
    assert.equal(rejected.status, "BLOCKED");
    assert.equal(rejected.summary, "Semantic assessment is invalid");
    assert.equal(accepted.status, "FAIL");
    assert.equal(accepted.evaluation.requestId, prepared.reviewRequest.requestId);
  });
}

test("when a named regression introducer is outside the selected delivery, its finding is rejected", async t => {
  // Arrange
  const f = await fixture(t);
  const initial = await f.prepare();
  const prepared = await readSemanticEvaluation({ cwd: f.root, requestPath: initial.reviewRequest.path, contextPaths: ["src/caller.js", "src/legacy.js"] });
  const findings = [{
    ...findingAt(CALLER, "Broken caller."),
    introducedBy: LEGACY.path,
    introducedByLine: LEGACY.line,
    regression: "The legacy export is negative.",
  }];

  // Act
  const result = await evaluate(f, prepared, failure(prepared, findings, [CHANGED, CALLER, LEGACY]));

  // Assert
  assert.equal(result.status, "BLOCKED");
  assert.match(result.evidence, /requires a cited changed line/);
});

test("when delivery changes before assessment, old findings are discarded and the new scope must be reviewed", async t => {
  // Arrange
  const f = await fixture(t);
  const prepared = await f.prepare();
  await writeFile(join(f.root, CHANGED.path), `export const value = 2;\n${UNCHANGED_SOURCE}`);
  f.git("add", "src/value.js");
  f.git("commit", "--quiet", "-m", "repair value");

  // Act
  const renewed = await evaluate(f, prepared, failure(prepared, [findingAt(CHANGED, "Negative export.")]));

  // Assert
  assert.equal(renewed.status, "PENDING");
  assert.notEqual(renewed.reviewRequest.requestId, prepared.reviewRequest.requestId);
  assert.equal(renewed.reviewRequest.scope.automatic.delivery.headCommit, f.git("rev-parse", "HEAD"));
  assert.equal(renewed.findings, undefined);
});

test("when a line is deleted after an intermediate edit, only the merge-base source authenticates its finding", async t => {
  // Arrange
  const f = await fixture(t);
  const intermediate = {
    ...LEGACY,
    quote: "export const legacy = 5;",
  };
  await writeFile(join(f.root, LEGACY.path), `${intermediate.quote}\n`);
  f.git("add", LEGACY.path);
  f.git("commit", "--quiet", "-m", "intermediate legacy edit");
  const prepared = await f.prepare();
  await rm(join(f.root, LEGACY.path));
  f.git("add", LEGACY.path);
  f.git("commit", "--quiet", "-m", "remove a required export");
  const finding = findingAt(LEGACY, "The required legacy export was removed.");
  const renewed = await readSemanticEvaluation({
    cwd: f.root,
    requestPath: prepared.reviewRequest.path,
  });

  // Act
  const wrongBase = await evaluate(f, renewed, failure(renewed, [finding], [intermediate]));
  const accepted = await evaluate(f, renewed, failure(renewed, [finding], [LEGACY]));

  // Assert
  assert.equal(wrongBase.status, "BLOCKED");
  assert.match(wrongBase.evidence, /does not match the captured source excerpt/);
  assert.equal(accepted.status, "FAIL", accepted.evidence);
  assert.deepEqual(accepted.findings, [{
    ...finding,
    state: "deleted",
  }]);
  assert.deepEqual(accepted.scope.deletedPaths, [LEGACY.path]);
  assert.match(formatVerificationResults([accepted]), /Finding: src\/legacy\.js:1 \(deleted\)/);
});

test("when a file is renamed without edits, neither path authorizes findings on its unchanged source", async t => {
  // Arrange
  const f = await fixture(t);
  const renamed = {
    ...LEGACY,
    path: "src/renamed.js",
  };
  f.git("mv", LEGACY.path, renamed.path);
  f.git("commit", "--quiet", "-m", "rename the legacy export without editing");
  const prepared = await f.prepare();

  // Act
  const source = await evaluate(f, prepared, failure(prepared, [findingAt(LEGACY, "Old-path legacy export.")], [CHANGED, LEGACY]));
  const target = await evaluate(f, prepared, failure(prepared, [findingAt(renamed, "New-path legacy export.")], [CHANGED, renamed]));

  // Assert
  assert.equal(source.status, "BLOCKED");
  assert.match(source.evidence, /unchanged-context finding introducedBy/);
  assert.equal(target.status, "BLOCKED");
  assert.match(target.evidence, /unchanged-context finding introducedBy/);
});

test("when a finding is outside eligible lines, checkpoints and final aggregation both reject it", async t => {
  // Arrange
  const f = await fixture(t);
  const prepared = await f.prepare();
  const batch = await readSemanticEvaluation({
    cwd: f.root,
    requestPath: prepared.reviewRequest.path,
    continuation: true,
  });
  const changedFinding = findingAt(CHANGED, "Changed export is negative.");
  const unchangedFinding = findingAt(UNCHANGED, "Untouched export is negative.");
  const citations = [CHANGED, UNCHANGED];
  const batchAssessment = {
    ...failure(batch, [unchangedFinding], citations),
    batchIndex: 0,
    crossBatchNotes: "The only batch contains the complete value source.",
  };

  // Act
  const rejectedBatch = await evaluate(f, batch, batchAssessment);
  const aggregate = await evaluate(f, batch, {
    ...batchAssessment,
    findings: [changedFinding],
  });
  const aggregateAssessment = {
    ...failure(aggregate, [unchangedFinding], citations),
    coveredBatches: [0],
  };
  const rejectedAggregate = await evaluate(f, aggregate, aggregateAssessment);
  const accepted = await evaluate(f, aggregate, {
    ...aggregateAssessment,
    findings: [changedFinding],
  });

  // Assert
  assert.equal(rejectedBatch.status, "BLOCKED");
  assert.match(rejectedBatch.evidence, /unchanged-context finding introducedBy/);
  assert.equal(aggregate.reviewRequest.continuation.phase, "aggregate");
  assert.equal(rejectedAggregate.status, "BLOCKED");
  assert.match(rejectedAggregate.evidence, /unchanged-context finding introducedBy/);
  assert.equal(accepted.status, "FAIL", accepted.evidence);
  assert.deepEqual(accepted.findings, [changedFinding]);
});

test("when unrelated dirty files exist, the CLI selects only delivery paths and labels opaque findings as provider owned", async t => {
  // Arrange
  const f = await fixture(t);
  await writeFile(join(f.root, "src/saved.js"), "BROKEN saved work\n");
  await writeFile(join(f.provider, "package.json"), JSON.stringify({
    name: "publisher", version: "1.0.0", omp: {
      extensions: ["./index.js"], verifications: [{
        id: ID, label: "Values", description: "Check selected files.", entry: "./check.mjs", pathTriggers: ["src/*.js"],
      }],
    },
  }));
  await writeFile(join(f.provider, "check.mjs"), `import { readFileSync } from "node:fs";
const paths = JSON.parse(process.env.OMP_VERIFIER_CHANGED_PATHS);
const broken = paths.filter(path => readFileSync(path, "utf8").includes("BROKEN"));
console.log(JSON.stringify({ status: broken.length ? "FAIL" : "PASS", summary: broken.length ? "Broken selected source" : "Selected source is intact", evidence: paths.join(", ") }));
`);

  // Act
  const run = spawnSync(process.execPath, [CLI, "automatic", "--base", f.baseRef], {
    cwd: f.root, encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: join(f.root, "agent") },
  });
  const [result] = JSON.parse(run.stdout);

  // Assert
  assert.equal(run.status, 0, run.stderr);
  assert.equal(result.status, "PASS");
  assert.equal(result.evidence, "src/value.js");
  assert.deepEqual(result.scope.changedPaths, ["src/value.js"]);
  assert.equal(result.scope.attribution, "provider-owned");
  assert.equal(result.scope.headCommit, f.headCommit);
});
