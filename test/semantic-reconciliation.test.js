import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { completeSemanticEvaluation, readSemanticEvaluation } from "#root/omp-plugin/semantic-evaluations.js";
import { paginateSemanticReview } from "#root/omp-plugin/semantic-review-pages.js";
import { runAutomaticVerificationForPaths, runInstalledVerificationChecks } from "#root/omp-plugin/verifications.js";

const ID = "publisher:scope";
const SOURCE = "export const live = 1;\n";
const CALLER_SOURCE = 'import { live } from "./src/live.js";';
const SIBLING_SOURCE = "export const restored = true;";
const UNRELATED_CALLER_LINE = 'export const edition = "internal";';

async function fixture({
  requiredContext = ["changed-code", "project-guidance"],
  optionalSourcePadding = "",
  callerSource = CALLER_SOURCE,
  unchangedLiveSource = "",
  extraSourceFiles = {},
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "verifier-reconcile-"));
  const cwd = join(root, "project");
  const packageDirectory = join(root, "plugins");
  const provider = join(packageDirectory, "publisher");
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(provider, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  await writeFile(join(cwd, "src/live.js"), `export const live = 0;\n${unchangedLiveSource}`);
  await writeFile(join(cwd, "src/restored.js"), `${SIBLING_SOURCE}\n${optionalSourcePadding}`);
  await writeFile(join(cwd, "src/removed.js"), "export const removed = true;\n");
  await writeFile(join(cwd, "caller.js"), `${callerSource}\n${optionalSourcePadding}`);

  for (const [path, content] of Object.entries(extraSourceFiles)) {
    await writeFile(join(cwd, path), content);
  }

  await writeFile(join(cwd, "AGENTS.md"), "Live exports equal one. Deleted source may remain deleted.\n");
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-qm", "base");
  const baseRef = git("rev-parse", "HEAD");
  await writeFile(join(cwd, "src/live.js"), `${SOURCE}${unchangedLiveSource}`);
  await rm(join(cwd, "src/removed.js"));
  git("add", ".");
  git("-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-qm", "delivery");
  const manifest = { name: "publisher", version: "1.0.0", omp: { extensions: ["./index.js"], verifications: [{
    id: ID, label: "Live Exports", description: "Validate live export values.", mode: "agentic", contract: "./contract.json", pathTriggers: ["src/*.js"],
  }] } };
  await writeFile(join(provider, "package.json"), JSON.stringify(manifest));
  await writeFile(join(provider, "standard.md"), "Live exports equal one. Deleted source may remain deleted.\n");
  await writeFile(join(provider, "contract.json"), JSON.stringify({
    version: 1,
    standardId: ID,
    source: "./standard.md",
    gold: "Live exports equal one.",
    requiredContext,
    rubric: [{
      id: "value",
      question: "Do live exports equal one?",
    }],
  }));
  const prepare = async (changedPaths = [], options = {}) => (await runAutomaticVerificationForPaths({ cwd, packageDirectory, baseRef, changedPaths, ...options })).find(result => result.id === ID);
  return { root, cwd, packageDirectory, provider, manifest, prepare, git };
}

function assessment(requestId) {
  return { requestId, status: "PASS", summary: "The live value equals one.", rationale: "The current source exports one; the other delivery path is an allowed deletion.", citations: [{ path: "src/live.js", line: 1, quote: SOURCE.trim() }] };
}

test("when a delivery base is supplied, unchanged candidates available to no-base review are excluded", async t => {
  // Arrange
  const f = await fixture({
    optionalSourcePadding: `// ${"optional project source ".repeat(4)}\n`.repeat(140),
  });
  t.after(() => rm(f.root, {
    recursive: true,
    force: true,
  }));

  const withoutBase = await f.prepare(["src/live.js", "src/removed.js"], {
    baseRef: undefined,
  });
  assert.equal(withoutBase.status, "PENDING", withoutBase.evidence);
  const eagerView = paginateSemanticReview(withoutBase);

  // Act
  const automatic = await f.prepare();
  assert.equal(automatic.status, "PENDING", automatic.evidence);
  const { context, missingContext, scope } = automatic.reviewRequest;
  const pageView = paginateSemanticReview(automatic);

  // Assert
  assert.deepEqual(missingContext, []);
  assert.equal(context.callers.status, "not-searched");
  assert.equal(context.siblings.status, "not-searched");
  assert.deepEqual(context.sourceInventory.files, ["src/live.js", "src/removed.js"]);
  assert.deepEqual(context.siblingInventory, []);
  assert.deepEqual(withoutBase.reviewRequest.scope.changedPaths, scope.changedPaths);
  assert.ok(withoutBase.reviewRequest.context.callers.some(record => record.path === "caller.js"));
  assert.ok(withoutBase.reviewRequest.context.siblings.some(record => record.path === "src/restored.js"));
  assert.ok(pageView.count < eagerView.count);
  assert.ok(pageView.totalBytes < eagerView.totalBytes);
});

test("when explicit context is named, continuation admits it without capturing other unchanged source", async t => {
  // Arrange
  const f = await fixture();
  t.after(() => rm(f.root, {
    recursive: true,
    force: true,
  }));
  const automatic = await f.prepare();
  const { path, requestId, scope } = automatic.reviewRequest;

  // Act
  const resumed = await readSemanticEvaluation({
    cwd: f.cwd,
    requestPath: path,
    resume: true,
  });
  const continued = await readSemanticEvaluation({
    cwd: f.cwd,
    requestPath: path,
    contextPaths: ["src/restored.js#L1"],
    callerContextPaths: ["caller.js#L1"],
    continuation: true,
  });
  assert.equal(continued.status, "PENDING", continued.evidence);
  const batch = continued.reviewRequest;

  const draft = assessment(batch.requestId);
  draft.citations.push(...batch.context.targetedContext.map(record => ({
    path: record.path,
    line: 1,
    quote: record.content,
  })));
  const checkpoint = await completeSemanticEvaluation({
    cwd: f.cwd,
    requestPath: batch.path,
    assessment: {
      ...draft,
      batchIndex: 0,
      crossBatchNotes: "Compare the selected caller and sibling evidence under the project guide.",
    },
  });
  assert.equal(checkpoint.status, "PENDING", checkpoint.evidence);
  assert.equal(checkpoint.reviewRequest.continuation.phase, "aggregate");
  const accepted = await completeSemanticEvaluation({
    cwd: f.cwd,
    requestPath: batch.path,
    assessment: {
      ...draft,
      coveredBatches: [0],
    },
  });

  // Assert
  assert.deepEqual(resumed.reviewRequest.context.sourceInventory.files, ["src/live.js", "src/removed.js"]);
  assert.deepEqual(batch.context.sourceInventory.files, ["caller.js", "src/live.js", "src/removed.js", "src/restored.js"]);
  assert.equal(resumed.reviewRequest.requestId, requestId);
  assert.notEqual(batch.requestId, requestId);
  assert.deepEqual(batch.scope.changedPaths, scope.changedPaths);
  assert.deepEqual(batch.scope.automatic.delivery, scope.automatic.delivery);
  assert.equal(batch.continuation.batchIndex, 0);
  assert.deepEqual(batch.context.targetedContext.map(record => [record.path, record.source, record.content]), [
    ["src/restored.js", "targeted-context", SIBLING_SOURCE],
    ["caller.js", "caller-context", CALLER_SOURCE],
  ]);
  assert.equal(accepted.status, "PASS", accepted.evidence);
});

for (const requiredCategory of ["callers", "siblings"]) {
  test(`when a contract requires ${requiredCategory}, the requirement does not trigger out-of-diff discovery`, async t => {
    // Arrange
    const f = await fixture({
      requiredContext: ["changed-code", requiredCategory],
    });
    t.after(() => rm(f.root, {
      recursive: true,
      force: true,
    }));

    // Act
    const automatic = await f.prepare();

    // Assert
    assert.equal(automatic.status, "PENDING", automatic.evidence);
    assert.deepEqual(automatic.reviewRequest.missingContext, []);
    const { context: { callers, siblings, projectGuidance }, standard, path, requestId } = automatic.reviewRequest;
    assert.ok(projectGuidance.some(record => record.path === "AGENTS.md"));
    assert.ok(standard.requiredContext.includes(requiredCategory));
    assert.equal(callers.status, "not-searched");
    assert.equal(siblings.status, "not-searched");
    const accepted = await completeSemanticEvaluation({ cwd: f.cwd, requestPath: path, assessment: assessment(requestId) });
    assert.equal(accepted.status, "PASS", accepted.evidence);
  });
}

test("when a caller is unchanged, base-backed review requires explicit selection before it can be cited", async t => {
  // Arrange
  const unchangedLine = "export const stable = true;";
  const f = await fixture({
    requiredContext: ["changed-code", "callers"],
    callerSource: ["// Local notes.", "// The removed endpoint stays retired.", CALLER_SOURCE, UNRELATED_CALLER_LINE].join("\n"),
    unchangedLiveSource: `${unchangedLine}\n`,
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));

  // Act
  const automatic = await f.prepare();
  assert.equal(automatic.status, "PENDING", automatic.evidence);
  const { context, missingContext, path, requestId, scope } = automatic.reviewRequest;
  const draft = assessment(requestId);
  draft.citations.push(
    { path: "src/live.js", line: 2, quote: unchangedLine },
    { path: "caller.js", line: 4, quote: UNRELATED_CALLER_LINE },
  );
  const rejected = await completeSemanticEvaluation({ cwd: f.cwd, requestPath: path, assessment: draft });
  const recovered = await readSemanticEvaluation({
    cwd: f.cwd,
    requestPath: path,
    callerContextPaths: ["caller.js#L4"],
  });
  assert.equal(recovered.status, "PENDING", recovered.evidence);
  const reviewed = recovered.reviewRequest;
  const accepted = await completeSemanticEvaluation({
    cwd: f.cwd,
    requestPath: reviewed.path,
    assessment: { ...draft, requestId: reviewed.requestId },
  });

  await writeFile(join(f.cwd, "caller.js"), `\n\n\n${CALLER_SOURCE}\n`);
  const renewed = await readSemanticEvaluation({ cwd: f.cwd, requestPath: reviewed.path, resume: true });

  // Assert
  assert.deepEqual(missingContext, []);
  assert.equal(context.callers.status, "not-searched");
  assert.ok(!context.sourceInventory.files.includes("caller.js"));
  assert.deepEqual(scope.changedPaths, ["src/live.js", "src/removed.js"]);
  assert.deepEqual(context.changedCode.map(({ path, state, content }) => [path, state, content]), [
    ["src/live.js", "present", `${SOURCE}${unchangedLine}\n`],
    ["src/removed.js", "deleted", "export const removed = true;\n"],
  ]);
  assert.equal(rejected.status, "BLOCKED", rejected.evidence);
  assert.equal(rejected.evaluation.requestId, requestId);
  assert.notEqual(reviewed.requestId, requestId);
  assert.deepEqual(reviewed.scope.changedPaths, scope.changedPaths);
  assert.deepEqual(reviewed.scope.automatic.delivery, scope.automatic.delivery);
  assert.deepEqual(reviewed.context.changedCode, context.changedCode);
  assert.equal(accepted.status, "PASS", accepted.evidence);

  assert.equal(renewed.status, "PENDING", renewed.evidence);
  assert.notEqual(renewed.reviewRequest.requestId, reviewed.requestId);
  assert.equal(renewed.reviewRequest.context.targetedContext[0].content, CALLER_SOURCE);
});

test("when a sibling caller changed, it is citable but unchanged neighbors are excluded", async t => {
  // Arrange
  const neighborMatch = 'import { live } from "./live.js";';
  const f = await fixture({
    requiredContext: ["changed-code", "callers", "siblings"],
    extraSourceFiles: {
      "src/worker.js": "export const revision = 2;\n",
      "src/zone.js": `// Zone configuration.\n${neighborMatch}\n${UNRELATED_CALLER_LINE}\n`,
    },
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(join(f.cwd, "src/zone.js"), `// Changed zone configuration.\n${neighborMatch}\n${UNRELATED_CALLER_LINE}\n`);
  f.git("add", "src/zone.js");
  f.git("-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-qm", "change one caller");

  // Act
  const automatic = await f.prepare();
  assert.equal(automatic.status, "PENDING", automatic.evidence);
  const { context, missingContext, path, requestId } = automatic.reviewRequest;
  const draft = assessment(requestId);
  draft.citations.push({ path: "src/restored.js", line: 1, quote: SIBLING_SOURCE });
  const rejected = await completeSemanticEvaluation({ cwd: f.cwd, requestPath: path, assessment: draft });
  draft.citations.pop();
  draft.citations.push({ path: "src/zone.js", line: 2, quote: neighborMatch });
  const accepted = await completeSemanticEvaluation({ cwd: f.cwd, requestPath: path, assessment: draft });

  // Assert
  assert.deepEqual(missingContext, []);
  assert.deepEqual(context.sourceInventory.files, ["src/live.js", "src/removed.js", "src/zone.js"]);
  assert.deepEqual(context.siblingInventory, []);
  assert.equal(rejected.status, "BLOCKED", rejected.evidence);
  assert.match(rejected.evidence, /src\/restored\.js:1 is not in the captured evidence/);
  assert.equal(accepted.status, "PASS", accepted.evidence);
});

test("when a named caller has a long line, the explicit selection recovers it without a preliminary search", async t => {
  // Arrange
  const oversizedMatch = `// live ${"é".repeat(350)}`;
  const f = await fixture({
    requiredContext: ["changed-code", "callers"],
    callerSource: `${oversizedMatch}\n${CALLER_SOURCE}`,
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));

  // Act
  const automatic = await f.prepare();
  assert.equal(automatic.status, "PENDING", automatic.evidence);
  const { context, missingContext, path } = automatic.reviewRequest;
  const recovered = await readSemanticEvaluation({
    cwd: f.cwd,
    requestPath: path,
    callerContextPaths: ["caller.js#L1"],
  });
  assert.equal(recovered.status, "PENDING", recovered.evidence);
  const reviewed = recovered.reviewRequest;
  const draft = assessment(reviewed.requestId);
  draft.citations.push({ path: "caller.js", line: 1, quote: oversizedMatch });
  const accepted = await completeSemanticEvaluation({ cwd: f.cwd, requestPath: reviewed.path, assessment: draft });

  // Assert
  assert.equal(context.callers.status, "not-searched");
  assert.ok(!context.sourceInventory.files.includes("caller.js"));
  assert.deepEqual(missingContext, []);
  assert.deepEqual(reviewed.missingContext, []);
  assert.equal(accepted.status, "PASS", accepted.evidence);
});

test("when review is manual, it retains full caller and sibling source without explicit recovery", async t => {
  // Arrange
  const callerSource = `${CALLER_SOURCE}\n${UNRELATED_CALLER_LINE}\n`;
  const f = await fixture({
    requiredContext: ["changed-code", "callers", "siblings"],
    callerSource: callerSource.trimEnd(),
    extraSourceFiles: { "src/worker.js": "export const revision = 2;\n" },
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(join(f.cwd, "src/live.js"), `${SOURCE}export const manualChange = true;\n`);

  // Act
  const [manual] = await runInstalledVerificationChecks({
    cwd: f.cwd,
    packageDirectory: f.packageDirectory,
    ids: [ID],
  });
  assert.equal(manual.status, "PENDING", manual.evidence);
  const { context, missingContext, path, requestId } = manual.reviewRequest;
  const draft = {
    ...assessment(requestId),
    rationale: "The edited source still exports one; the captured surrounding source supports the review.",
  };
  draft.citations.push(
    { path: "caller.js", line: 2, quote: UNRELATED_CALLER_LINE },
    { path: "src/worker.js", line: 1, quote: "export const revision = 2;" },
  );
  const accepted = await completeSemanticEvaluation({ cwd: f.cwd, requestPath: path, assessment: draft });

  // Assert
  assert.deepEqual(missingContext, []);
  assert.equal(context.callers.find(record => record.path === "caller.js")?.content, callerSource);
  assert.equal(accepted.status, "PASS", accepted.evidence);
});

test("when automatic candidates are obsolete, changed source excludes them but guidance and committed deletions remain", async () => {
  // Arrange
  const f = await fixture();
  try {
    // Act
    const result = await f.prepare(["src/restored.js", "src/temporary.js", "AGENTS.md"]);
    // Assert
    assert.equal(result.status, "PENDING");
    assert.deepEqual(result.reviewRequest.scope.changedPaths, ["src/live.js", "src/removed.js"]);
    assert.equal(result.reviewRequest.context.changedCode.find(record => record.path === "src/removed.js").state, "deleted");
    assert.ok(result.reviewRequest.context.projectGuidance.some(record => record.path === "AGENTS.md"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const mutation of [
  "restored source",
  "temporary cleanup",
  "provider update",
  "changed source",
  "guidance change",
]) {
  test(`when ${mutation} invalidates an automatic request, evaluation returns fresh evidence instead of accepting the old draft`, async () => {
    // Arrange
    const f = await fixture();
    try {
      await writeFile(join(f.cwd, "src/restored.js"), "export const restored = false;\n");
      await writeFile(join(f.cwd, "src/temporary.js"), "export const diagnostic = 1;\n");
      const original = await f.prepare(["src/live.js", "src/restored.js", "src/temporary.js"]);
      if (mutation === "restored source") f.git("checkout", "HEAD", "--", "src/restored.js");
      if (mutation === "temporary cleanup") await rm(join(f.cwd, "src/temporary.js"));
      if (mutation === "provider update") await writeFile(join(f.provider, "package.json"), JSON.stringify({ ...f.manifest, version: "2.0.0" }));
      if (mutation === "changed source") await writeFile(join(f.cwd, "src/live.js"), "export const live = -1;\n");
      if (mutation === "guidance change") await writeFile(join(f.cwd, "AGENTS.md"), "Live exports must now equal two.\n");
      // Act
      const result = await completeSemanticEvaluation({ cwd: f.cwd, requestPath: original.reviewRequest.path, assessment: assessment(original.reviewRequest.requestId) });
      // Assert
      assert.equal(result.status, "PENDING");
      assert.notEqual(result.reviewRequest.requestId, original.reviewRequest.requestId);
      assert.equal(result.evaluation.supersededBy, result.reviewRequest.requestId);
      const expected = ["src/live.js", "src/removed.js"];
      if (mutation !== "restored source") expected.push("src/restored.js");
      if (mutation !== "temporary cleanup") expected.push("src/temporary.js");
      assert.deepEqual(result.reviewRequest.scope.changedPaths, expected);
      if (mutation === "provider update") assert.equal(result.reviewRequest.standard.sourceDetails.version, "2.0.0");
      if (mutation === "changed source") assert.equal(result.reviewRequest.context.changedCode.find(record => record.path === "src/live.js").content, "export const live = -1;\n");
      if (mutation === "guidance change") assert.equal(result.reviewRequest.context.projectGuidance.find(record => record.path === "AGENTS.md").content, "Live exports must now equal two.\n");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

test("when unselected source changes, base-backed review and continuation retain their evidence", async t => {
  // Arrange
  const f = await fixture({ requiredContext: ["changed-code", "callers", "siblings"] });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const original = await f.prepare();
  const { path, requestId } = original.reviewRequest;

  // Act
  await writeFile(join(f.cwd, "caller.js"), `${CALLER_SOURCE}\nconsole.log(live);\n`);
  await writeFile(join(f.cwd, "src/diagnostic.js"), CALLER_SOURCE);
  const resumed = await readSemanticEvaluation({ cwd: f.cwd, requestPath: path, resume: true });

  const continued = await readSemanticEvaluation({ cwd: f.cwd, requestPath: path, continuation: true });
  const batch = continued.reviewRequest;
  await writeFile(join(f.cwd, "src/restored.js"), "export const restored = false;\n");
  const checkpoint = await completeSemanticEvaluation({
    cwd: f.cwd,
    requestPath: batch.path,
    assessment: { ...assessment(batch.requestId), batchIndex: 0, crossBatchNotes: "No material cross-batch relationships." },
  });

  // Assert
  assert.equal(resumed.reviewRequest.requestId, requestId);
  assert.equal(resumed.reviewRequest.context.fingerprint, original.reviewRequest.context.fingerprint);
  assert.deepEqual(batch.context.sourceInventory.files, ["src/live.js", "src/removed.js"]);
  assert.equal(checkpoint.reviewRequest.requestId, batch.requestId);
  assert.equal(checkpoint.reviewRequest.continuation.phase, "aggregate");
});

test("when a changed file is a symlink, review does not admit its unchanged target as changed source", async t => {
  // Arrange
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await symlink("restored.js", join(f.cwd, "src/linked.js"));
  f.git("add", "src/linked.js");
  f.git("-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-qm", "add link");

  // Act
  const prepared = await f.prepare();

  // Assert
  assert.equal(prepared.status, "PENDING", prepared.evidence);
  const { context, missingContext } = prepared.reviewRequest;
  assert.ok(missingContext.some(reason => reason.includes("src/linked.js")));
  const linked = context.changedCode.find(record => record.path === "src/linked.js");
  assert.equal(linked.state, "unavailable");
  assert.match(linked.reason, /cannot follow a symbolic file/);
  assert.ok(!JSON.stringify(context).includes(SIBLING_SOURCE));
});

test("when a committed rename removes the old directory, review preserves the old source from the merge base", async t => {
  // Arrange
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  f.manifest.omp.verifications[0].pathTriggers = ["**/*.js"];
  await writeFile(join(f.provider, "package.json"), JSON.stringify(f.manifest));
  f.git("mv", "src", "moved");
  f.git("-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-qm", "move source");

  // Act
  const prepared = await f.prepare();

  // Assert
  assert.equal(prepared.status, "PENDING", prepared.evidence);
  const { context, missingContext, scope } = prepared.reviewRequest;
  const byPath = new Map(context.changedCode.map(record => [record.path, record]));
  assert.deepEqual(missingContext, []);
  assert.equal(byPath.get("src/restored.js").content, `${SIBLING_SOURCE}\n`);
  assert.equal(byPath.get("src/restored.js").reference, `${scope.automatic.delivery.mergeBaseCommit}:src/restored.js`);
  assert.equal(byPath.get("src/restored.js").state, "deleted");
  assert.equal(byPath.get("moved/restored.js").state, "present");
  assert.equal(byPath.get("src/removed.js").state, "deleted");
  assert.ok(!context.sourceInventory.files.includes("caller.js"));
  assert.deepEqual(context.siblingInventory, []);
});

test("when a reference guide is declared, review captures binding ancestor instructions and defers the reference body", async t => {
  // Arrange
  const ancestorGuidance = "Keep the live export at one.";
  const guideSource = "# Reference examples\nExample: export one from live.js.\n";
  const f = await fixture({
    extraSourceFiles: {
      ".omp-verifier.json": JSON.stringify({ review: { referenceGuides: ["README.md"] } }),
      "README.md": guideSource,
      "src/AGENTS.md": `${ancestorGuidance}\n`,
    },
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const prepared = await f.prepare();
  const { context, path, requestId } = prepared.reviewRequest;
  const draft = assessment(requestId);
  draft.citations.push({ path: "src/AGENTS.md", line: 1, quote: ancestorGuidance });
  draft.citations.push({ path: "README.md", line: 2, quote: "Example: export one from live.js." });

  // Act
  await writeFile(join(f.cwd, "README.md"), `${guideSource}\n# New reference material\n`);
  const resumed = await readSemanticEvaluation({ cwd: f.cwd, requestPath: path, resume: true });
  const rejected = await completeSemanticEvaluation({ cwd: f.cwd, requestPath: path, assessment: draft });
  const recovered = await readSemanticEvaluation({ cwd: f.cwd, requestPath: path, contextPaths: ["README.md#L2"] });
  const accepted = await completeSemanticEvaluation({
    cwd: f.cwd,
    requestPath: recovered.reviewRequest.path,
    assessment: { ...draft, requestId: recovered.reviewRequest.requestId },
  });

  // Assert
  assert.equal(resumed.reviewRequest.requestId, requestId);
  assert.deepEqual(context.deferredGuidance.guides, [{ path: "README.md" }]);
  assert.ok(context.projectGuidance.some(record => record.path === "src/AGENTS.md" && record.content === `${ancestorGuidance}\n`));
  assert.ok(!context.sourceInventory.files.includes("src/AGENTS.md"));
  assert.equal(rejected.status, "BLOCKED", rejected.evidence);
  assert.match(rejected.evidence, /README\.md:2 is not in the captured evidence/);
  assert.equal(accepted.status, "PASS", accepted.evidence);
});

test("when a required semantic provider is replaced by an unscoped executable, resume reports the blocker without executing it", async t => {
  // Arrange
  const f = await fixture({
    extraSourceFiles: {
      ".omp-verifier.json": JSON.stringify({ requirements: [{ id: ID, path: "src/*.js" }] }),
    },
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const prepared = await f.prepare();
  const marker = join(f.root, "provider-ran");
  f.manifest.omp.verifications[0] = {
    id: ID,
    label: "Executable replacement",
    description: "A provider that has not declared changed-file support.",
    pathTriggers: ["src/*.js"],
    entry: "./verify.mjs",
  };
  await writeFile(join(f.provider, "package.json"), JSON.stringify(f.manifest));
  await writeFile(join(f.provider, "verify.mjs"), `import { writeFile } from "node:fs/promises";\nawait writeFile(${JSON.stringify(marker)}, "ran");\n`);

  // Act
  const result = await readSemanticEvaluation({ cwd: f.cwd, requestPath: prepared.reviewRequest.path, resume: true });

  // Assert
  assert.equal(result.status, "BLOCKED");
  assert.match(result.evidence, /Required verification provider does not support changed-file execution/);
  assert.equal(result.reviewRequest, undefined);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("when completed automatic evidence changes, exact recovery cannot reuse its prior PASS", async () => {
  // Arrange
  const f = await fixture();
  try {
    const original = await f.prepare(["src/live.js"]);
    const accepted = await completeSemanticEvaluation({ cwd: f.cwd, requestPath: original.reviewRequest.path, assessment: assessment(original.reviewRequest.requestId) });
    await writeFile(join(f.cwd, "src/live.js"), "export const live = -1;\n");
    // Act
    const result = await readSemanticEvaluation({ cwd: f.cwd, requestPath: original.reviewRequest.path });
    // Assert
    assert.equal(accepted.status, "PASS");
    assert.equal(accepted.evaluation.requestId, original.reviewRequest.requestId);
    assert.equal(result.status, "PENDING");
    assert.notEqual(result.reviewRequest.requestId, original.reviewRequest.requestId);
    assert.equal(result.reviewRequest.context.changedCode.find(record => record.path === "src/live.js").content, "export const live = -1;\n");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("when an automatic request is tampered with, reconciliation remains blocked", async () => {
  // Arrange
  const f = await fixture();
  try {
    const original = await f.prepare();
    await writeFile(original.reviewRequest.path, `${await readFile(original.reviewRequest.path, "utf8")}\n`);
    // Act
    const result = await readSemanticEvaluation({ cwd: f.cwd, requestPath: original.reviewRequest.path });
    // Assert
    assert.equal(result.status, "BLOCKED");
    assert.match(result.evidence, /tampered/);
    assert.equal(result.reviewRequest, undefined);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("when the current delivery no longer selects a removed provider, its old result is superseded without approval", async () => {
  // Arrange
  const f = await fixture();
  try {
    const original = await f.prepare();
    await rm(f.provider, { recursive: true });
    // Act
    const result = await readSemanticEvaluation({ cwd: f.cwd, requestPath: original.reviewRequest.path });
    // Assert
    assert.equal(result.status, "SUPERSEDED");
    assert.equal(result.reviewRequest, undefined);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("when a current requirement loses its provider, recovery reports that prerequisite instead of the stale manifest", async () => {
  // Arrange
  const f = await fixture();
  try {
    const original = await f.prepare();
    await writeFile(join(f.cwd, ".omp-verifier.json"), JSON.stringify({ requirements: [{ id: ID, path: "src/*.js" }] }));
    await rm(f.provider, { recursive: true });
    // Act
    const result = await readSemanticEvaluation({ cwd: f.cwd, requestPath: original.reviewRequest.path });
    // Assert
    assert.equal(result.status, "BLOCKED");
    assert.match(result.evidence, /required|Required/);
    assert.equal(result.reviewRequest, undefined);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("when automatic verification has no delivery base, explicit candidates are not silently dropped", async () => {
  // Arrange
  const f = await fixture();
  try {
    // Act
    const result = await f.prepare(["src/restored.js", "src/temporary.js"], { baseRef: undefined });
    // Assert
    assert.deepEqual(result.reviewRequest.scope.changedPaths, ["src/restored.js", "src/temporary.js"]);
    assert.equal(result.reviewRequest.scope.automatic, undefined);
    assert.ok(result.reviewRequest.missingContext.some(reason => reason.includes("src/temporary.js")));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
