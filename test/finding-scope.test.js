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
const CHANGED = { path: "src/value.js", line: 1, quote: "export const value = -1;" };
const CALLER = { path: "src/caller.js", line: 2, quote: "export const result = Math.sqrt(value);" };

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
  await writeFile(join(root, "src/value.js"), "export const value = 1;\n");
  await writeFile(join(root, "src/caller.js"), 'import { value } from "./value.js";\nexport const result = Math.sqrt(value);\n');
  await writeFile(join(root, "src/legacy.js"), "export const legacy = -10;\n");
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Finding scope tests");
  git("config", "user.email", "findings@example.invalid");
  git("add", ".");
  git("commit", "--quiet", "-m", "baseline");
  const baseRef = git("rev-parse", "HEAD");
  await writeFile(join(root, "src/value.js"), `${CHANGED.quote}\n`);
  git("add", "src/value.js");
  git("commit", "--quiet", "-m", "change value");
  const headCommit = git("rev-parse", "HEAD");
  const prepare = async () => (await runAutomaticVerificationForPaths({ cwd: root, packageDirectory, baseRef }))[0];
  return { root, provider, packageDirectory, baseRef, headCommit, git, prepare };
}

function failure(prepared, findings, citations = [CHANGED]) {
  return {
    requestId: prepared.reviewRequest.requestId,
    status: "FAIL", summary: "The changed value violates the standard.",
    rationale: "A negative export violates the nonnegative requirement.",
    findings, citations,
  };
}

async function evaluate(f, prepared, assessment) {
  return completeSemanticEvaluation({ cwd: f.root, requestPath: prepared.reviewRequest.path, assessment });
}

test("when legacy context is captured, it cannot become a finding without attributed regression evidence", async t => {
  // Arrange
  const f = await fixture(t);
  const initial = await f.prepare();
  const prepared = await readSemanticEvaluation({ cwd: f.root, requestPath: initial.reviewRequest.path, contextPaths: ["src/legacy.js"] });
  const citations = [CHANGED, { path: "src/legacy.js", line: 1, quote: "export const legacy = -10;" }];

  // Act
  const rejected = await evaluate(f, prepared, failure(prepared, [{ path: "src/legacy.js", summary: "Legacy value is negative." }], citations));
  const accepted = await evaluate(f, prepared, failure(prepared, [{ path: "src/value.js", summary: "The changed export is negative." }], citations));

  // Assert
  assert.equal(rejected.status, "BLOCKED");
  assert.match(rejected.evidence, /unchanged-context finding introducedBy/);
  assert.equal(accepted.status, "FAIL");
  assert.deepEqual(accepted.findings, [{ path: "src/value.js", summary: "The changed export is negative." }]);
  assert.match(accepted.evidence, /src\/legacy.js/);
});

test("when a changed export breaks an unchanged caller, its cited causal attribution survives reporting", async t => {
  // Arrange
  const f = await fixture(t);
  const initial = await f.prepare();
  const prepared = await readSemanticEvaluation({ cwd: f.root, requestPath: initial.reviewRequest.path, callerContextPaths: ["src/caller.js"] });
  const findings = [{
    path: "src/caller.js", summary: "The caller now exports NaN.", introducedBy: "src/value.js",
    regression: "The changed negative input makes the unchanged square root return NaN.",
  }];

  // Act
  const accepted = await evaluate(f, prepared, failure(prepared, findings, [CHANGED, CALLER]));
  const report = formatVerificationResults([accepted]);

  // Assert
  assert.equal(accepted.status, "FAIL", accepted.evidence);
  assert.deepEqual(accepted.findings, findings);
  assert.match(report, /Finding: src\/caller.js: The caller now exports NaN/);
  assert.match(report, /Introduced by: src\/value.js/);
  assert.equal(accepted.scope.baseCommit, f.baseRef);
  assert.equal(accepted.scope.headCommit, f.headCommit);
});

for (const findings of [undefined, [], [{ path: "src/missing.js", summary: "No captured evidence." }]]) {
  test(`when FAIL has ${findings === undefined ? "no" : JSON.stringify(findings)} attribution, correction can still complete the request`, async t => {
    // Arrange
    const f = await fixture(t);
    const prepared = await f.prepare();

    // Act
    const rejected = await evaluate(f, prepared, failure(prepared, findings));
    const accepted = await evaluate(f, prepared, failure(prepared, [{ path: "src/value.js", summary: "Negative export." }]));

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
  const findings = [{ path: "src/caller.js", summary: "Broken caller.", introducedBy: "src/legacy.js", regression: "The legacy export is negative." }];

  // Act
  const result = await evaluate(f, prepared, failure(prepared, findings, [CHANGED, CALLER, { path: "src/legacy.js", line: 1, quote: "export const legacy = -10;" }]));

  // Assert
  assert.equal(result.status, "BLOCKED");
  assert.match(result.evidence, /requires a cited changed path/);
});

test("when delivery changes before assessment, old findings are discarded and the new scope must be reviewed", async t => {
  // Arrange
  const f = await fixture(t);
  const prepared = await f.prepare();
  await writeFile(join(f.root, "src/value.js"), "export const value = 2;\n");
  f.git("add", "src/value.js");
  f.git("commit", "--quiet", "-m", "repair value");

  // Act
  const renewed = await evaluate(f, prepared, failure(prepared, [{ path: "src/value.js", summary: "Negative export." }]));

  // Assert
  assert.equal(renewed.status, "PENDING");
  assert.notEqual(renewed.reviewRequest.requestId, prepared.reviewRequest.requestId);
  assert.equal(renewed.reviewRequest.scope.automatic.delivery.headCommit, f.git("rev-parse", "HEAD"));
  assert.equal(renewed.findings, undefined);
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
