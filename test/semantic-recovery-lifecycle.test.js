import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  completeSemanticEvaluation,
  prepareSemanticEvaluation,
  readSemanticEvaluation,
  recordSemanticReviewPage,
} from "#root/omp-plugin/semantic-evaluations.js";
import { buildSemanticReviewPage } from "#root/omp-plugin/semantic-review-pages.js";
import { discoverVerificationChecks } from "#root/omp-plugin/verification-catalog.js";
import { runAutomaticVerificationForPaths, runInstalledVerificationChecks } from "#root/omp-plugin/verifications.js";

const CHECK_ID = "publisher:recovery";
const CHANGED_PATHS = ["src/present.js", "src/deleted.js"];
const SOURCE_RECOVERY = { chunkBytes: 16_000, maxSourceBytes: 256_000, modelContext: "unavailable" };

function largeSource(label) {
  return Array.from({ length: 439 }, (_, index) =>
    `export const ${label}${index + 1} = "${"x".repeat(70)}";`).join("\n");
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "verifier-recovery-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const packageDirectory = join(root, "plugins");
  const provider = join(packageDirectory, "publisher");
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(provider, { recursive: true });
  const present = largeSource("present");
  const deleted = largeSource("deleted");
  await writeFile(join(cwd, "src/present.js"), "export const baseline = true;\n");
  await writeFile(join(cwd, "src/deleted.js"), deleted);
  await writeFile(join(cwd, "src/helper.js"), "export const helper = true;\n");
  await writeFile(join(cwd, "AGENTS.md"), "Changed exports own their values. Deleted exports may be removed.\n");
  const git = (...args) => execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const commit = message => {
    git("add", ".");
    git("-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-qm", message);
  };
  git("init", "-q");
  commit("baseline");
  const baseRef = git("rev-parse", "HEAD");
  await writeFile(join(cwd, "src/present.js"), present);
  await rm(join(cwd, "src/deleted.js"));
  commit("delivery");
  await writeFile(join(provider, "standard.md"), "Changed exports own their values. Deleted exports may be removed.\n");
  await writeFile(join(provider, "contract.json"), JSON.stringify({
    version: 1, standardId: CHECK_ID, source: "./standard.md",
    gold: "Changed exports own their values.", requiredContext: ["changed-code", "project-guidance"],
    rubric: [{ id: "ownership", question: "Do changed exports own their values?" }],
  }));
  await writeFile(join(provider, "package.json"), JSON.stringify({
    name: "publisher", version: "1.0.0", omp: { extensions: ["./index.js"], verifications: [{
      id: CHECK_ID, label: "Source Recovery", description: "Reviews complete changed source.",
      mode: "agentic", contract: "./contract.json", pathTriggers: ["src/*.js"],
    }] },
  }));
  const automaticResults = (options = {}) => runAutomaticVerificationForPaths({
    cwd, packageDirectory, changedPaths: CHANGED_PATHS, baseRef, ...options,
  });
  const automatic = async options => (await automaticResults(options))[0];
  return { cwd, packageDirectory, present, deleted, automatic, automaticResults };
}

function assessment(result, source, path = "src/deleted.js") {
  return {
    requestId: result.reviewRequest.requestId, status: "PASS",
    summary: "Changed exports meet the standard.", rationale: "The complete changed source supports the ownership review.",
    citations: [{ path, line: 439, quote: source.split("\n")[438] }],
  };
}

function assertComplete(result) {
  assert.equal(result.status, "PENDING");
  assert.deepEqual(result.reviewRequest.scope.sourceRecovery, SOURCE_RECOVERY);
  assert.deepEqual(result.reviewRequest.scope.contextPaths, []);
  assert.deepEqual(result.reviewRequest.missingContext, []);
  assert.deepEqual(result.reviewRequest.context.missingChangedPaths, []);
  assert.equal(result.reviewRequest.context.changedCodeCoverage.length, 2);
  assert.ok(result.reviewRequest.context.changedCodeCoverage.every(record => record.complete));
}

async function deliverPages(cwd, result, start = 0) {
  const count = buildSemanticReviewPage(result).count;
  for (let index = start; index < count; index += 1) {
    await recordSemanticReviewPage({ cwd, page: buildSemanticReviewPage(result, index) });
  }
  return count;
}

for (const withBase of [true, false]) {
  test(`when automatic checks are ${withBase ? "base-backed" : "explicit no-base"}, complete present and historical source needs no selectors`, async t => {
    // Arrange
    const context = await fixture(t);

    // Act
    const results = await context.automaticResults(withBase ? {} : { baseRef: undefined });
    const prepared = results[0];
    const stored = JSON.parse(await readFile(prepared.reviewRequest.path, "utf8"));
    const reread = await readSemanticEvaluation({ cwd: context.cwd, requestPath: prepared.reviewRequest.path });
    const pages = await deliverPages(context.cwd, reread);
    const completed = await completeSemanticEvaluation({
      cwd: context.cwd, requestPath: reread.reviewRequest.path, assessment: assessment(reread, context.deleted),
    });

    // Assert
    assert.equal(results.length, 1, "one check remains one review obligation");
    assert.equal(prepared.id, CHECK_ID);
    assertComplete(prepared);
    assert.equal(Boolean(prepared.reviewRequest.scope.automatic), withBase);
    assert.deepEqual(stored.payload.scope.sourceRecovery, SOURCE_RECOVERY);
    assert.equal(reread.reviewRequest.requestId, prepared.reviewRequest.requestId);
    assertComplete(reread);
    assert.ok(pages > 1, "automatic source recovery still requires a complete paged review");
    assert.equal(completed.status, "PASS");
    assert.match(completed.evidence, /src\/deleted\.js:439 \(deleted\)/);
  });
}

test("when automatic evidence changes, renewal retains recovery policy and rejects the old assessment", async t => {
  // Arrange
  const context = await fixture(t);
  const prepared = await context.automatic();
  await deliverPages(context.cwd, prepared);
  const oldAssessment = assessment(prepared, context.deleted);
  await writeFile(join(context.cwd, "src/present.js"), context.present.replace("present300 =", "present300Updated ="));

  // Act
  const renewed = await completeSemanticEvaluation({
    cwd: context.cwd, requestPath: prepared.reviewRequest.path, assessment: oldAssessment,
  });
  const rejected = await completeSemanticEvaluation({
    cwd: context.cwd, requestPath: renewed.reviewRequest.path, assessment: oldAssessment,
  });
  await deliverPages(context.cwd, renewed);
  const completed = await completeSemanticEvaluation({
    cwd: context.cwd, requestPath: renewed.reviewRequest.path, assessment: assessment(renewed, context.deleted),
  });

  // Assert
  assertComplete(renewed);
  assert.notEqual(renewed.reviewRequest.requestId, prepared.reviewRequest.requestId);
  assert.equal(renewed.evaluation.supersededBy, renewed.reviewRequest.requestId);
  assert.equal(rejected.status, "BLOCKED");
  assert.match(rejected.evidence, /requestId does not match/);
  assert.equal(completed.status, "PASS");
});

test("when explicit no-base automatic evidence changes, the stale request invalidates until fresh capture", async t => {
  // Arrange
  const context = await fixture(t);
  const prepared = await context.automatic({ baseRef: undefined });
  await writeFile(join(context.cwd, "src/present.js"), `${context.present}\nexport const fresh = true;\n`);

  // Act
  const stale = await readSemanticEvaluation({ cwd: context.cwd, requestPath: prepared.reviewRequest.path });
  const recaptured = await context.automatic({ baseRef: undefined });

  // Assert
  assert.equal(stale.status, "BLOCKED");
  assert.match(stale.evidence, /captured source or project context changed/);
  assertComplete(recaptured);
  assert.notEqual(recaptured.reviewRequest.requestId, prepared.reviewRequest.requestId);
});

test("when context selectors renew a request, recovery policy persists and incomplete new pages prevent completion", async t => {
  // Arrange
  const context = await fixture(t);
  const prepared = await context.automatic();
  await deliverPages(context.cwd, prepared);

  // Act
  const renewed = await readSemanticEvaluation({
    cwd: context.cwd, requestPath: prepared.reviewRequest.path, contextPaths: ["src/helper.js#L1-L1"],
  });
  await recordSemanticReviewPage({ cwd: context.cwd, page: buildSemanticReviewPage(renewed) });
  const unread = await completeSemanticEvaluation({
    cwd: context.cwd, requestPath: renewed.reviewRequest.path, assessment: assessment(renewed, context.deleted),
  });
  await deliverPages(context.cwd, renewed, 1);
  const completed = await completeSemanticEvaluation({
    cwd: context.cwd, requestPath: renewed.reviewRequest.path, assessment: assessment(renewed, context.deleted),
  });

  // Assert
  assert.equal(renewed.status, "PENDING");
  assert.notEqual(renewed.reviewRequest.requestId, prepared.reviewRequest.requestId);
  assert.deepEqual(renewed.reviewRequest.scope.sourceRecovery, SOURCE_RECOVERY);
  assert.deepEqual(renewed.reviewRequest.missingContext, []);
  assert.equal(unread.status, "PENDING");
  assert.equal(unread.reviewRequest.requestId, renewed.reviewRequest.requestId);
  assert.ok(unread.reviewProgress.missingPages.length > 0);
  assert.equal(completed.status, "PASS");
});

test("when checks are manual or use explicit source caps, source recovery remains opt-in", async t => {
  // Arrange
  const context = await fixture(t);
  await context.automatic();
  const { checks } = await discoverVerificationChecks({ packageDirectory: context.packageDirectory });

  // Act
  const manual = await prepareSemanticEvaluation({ check: checks[0], cwd: context.cwd, changedPaths: CHANGED_PATHS });
  const reread = await readSemanticEvaluation({ cwd: context.cwd, requestPath: manual.reviewRequest.path });
  const explicit = await context.automatic({ maxSourceBytes: 256_000 });
  await writeFile(join(context.cwd, "src/present.js"), `${context.present}\nexport const manualChange = true;\n`);
  const defaultManual = (await runInstalledVerificationChecks({
    cwd: context.cwd, packageDirectory: context.packageDirectory, ids: [CHECK_ID],
  }))[0];
  const expandedManual = (await runInstalledVerificationChecks({
    cwd: context.cwd, packageDirectory: context.packageDirectory, ids: [CHECK_ID], maxSourceBytes: 256_000,
  }))[0];

  // Assert
  assert.equal(manual.reviewRequest.scope.sourceRecovery, undefined);
  assert.equal(manual.reviewRequest.scope.maxSourceBytes, 16_000);
  assert.ok(manual.reviewRequest.missingContext.length > 0);
  assert.equal(reread.reviewRequest.scope.sourceRecovery, undefined);
  assert.ok(reread.reviewRequest.missingContext.length > 0);
  assert.equal(explicit.reviewRequest.scope.sourceRecovery, undefined);
  assert.equal(explicit.reviewRequest.scope.maxSourceBytes, 256_000);
  assert.deepEqual(explicit.reviewRequest.missingContext, []);
  assert.equal(defaultManual.reviewRequest.scope.sourceRecovery, undefined);
  assert.equal(defaultManual.reviewRequest.scope.maxSourceBytes, 16_000);
  assert.deepEqual(defaultManual.reviewRequest.scope.changedPaths, ["src/present.js"]);
  assert.ok(defaultManual.reviewRequest.missingContext.length > 0);
  assert.equal(expandedManual.reviewRequest.scope.sourceRecovery, undefined);
  assert.equal(expandedManual.reviewRequest.scope.maxSourceBytes, 256_000);
});

test("when stored automatic requests lack recovery policy, freshness and renewal retain legacy semantics", async t => {
  // Arrange
  const context = await fixture(t);
  const automatic = await context.automatic();
  const { checks } = await discoverVerificationChecks({ packageDirectory: context.packageDirectory });
  const legacy = await prepareSemanticEvaluation({
    check: checks[0], cwd: context.cwd, changedPaths: CHANGED_PATHS,
    automaticScope: automatic.reviewRequest.scope.automatic,
  });

  // Act
  const unchanged = await readSemanticEvaluation({ cwd: context.cwd, requestPath: legacy.reviewRequest.path });
  await writeFile(join(context.cwd, "src/present.js"), `${context.present}\nexport const fresh = true;\n`);
  const renewed = await readSemanticEvaluation({ cwd: context.cwd, requestPath: legacy.reviewRequest.path });

  // Assert
  assert.equal(unchanged.reviewRequest.scope.sourceRecovery, undefined);
  assert.ok(unchanged.reviewRequest.missingContext.length > 0);
  assert.notEqual(renewed.reviewRequest.requestId, legacy.reviewRequest.requestId);
  assert.equal(renewed.reviewRequest.scope.sourceRecovery, undefined);
  assert.equal(renewed.reviewRequest.scope.maxSourceBytes, 16_000);
  assert.ok(renewed.reviewRequest.missingContext.length > 0);
});
