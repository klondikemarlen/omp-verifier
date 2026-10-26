import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  completeSemanticEvaluation,
  prepareSemanticEvaluation,
  readSemanticEvaluation,
} from "#root/omp-plugin/semantic-evaluations.js";
import { discoverVerificationChecks } from "#root/omp-plugin/verifications.js";

const CHECK_ID = "publisher:alignment";
const HELPER_SOURCE = "export function helper(value) { if (!Number.isInteger(value)) throw new TypeError(\"Expected integer\"); return value; }\n";

async function createEmptySiblingFixture({ noiseFiles = 1_197 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-siblings-"));
  const packageDirectory = join(root, "plugins");
  const packagePath = join(packageDirectory, "publisher");
  await mkdir(packagePath, { recursive: true });
  await mkdir(join(root, "src"));
  await mkdir(join(root, "noise"));
  await writeFile(join(packagePath, "package.json"), JSON.stringify({
    name: "publisher",
    version: "1.2.3",
    omp: {
      extensions: ["./index.js"],
      verifications: [{
        id: CHECK_ID,
        label: "Module Boundary Alignment",
        description: "Evaluates a supplied boundary standard.",
        mode: "agentic",
        contract: "./alignment.json",
      }],
    },
  }));
  await writeFile(join(packagePath, "alignment.json"), JSON.stringify({
    version: 1,
    standardId: CHECK_ID,
    source: "./standard.md",
    gold: "A changed module owns a meaningful invariant rather than forwarding alone.",
    requiredContext: ["changed-code", "callers", "siblings", "project-guidance"],
    rubric: [{ id: "boundary-ownership", question: "Which invariant does this module own?" }],
  }));
  await writeFile(join(packagePath, "standard.md"), "A module owns an invariant or reusable behavior.\n");
  await writeFile(join(root, "AGENTS.md"), "Modules own their input invariants.\n");
  await writeFile(join(root, "src", "helper.js"), HELPER_SOURCE);
  await writeFile(join(root, "caller.js"), 'import { helper } from "./src/helper.js";\nexport const result = helper(1);\n');
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=OMP Verifier Tests", "commit", "--quiet", "-m", "fixture baseline"], { cwd: root });
  for (let index = 0; index < noiseFiles; index += 1) {
    await writeFile(join(root, "noise", `unrelated-${index}.js`), "export const unrelated = true;\n");
  }
  return { root, packageDirectory };
}

async function discoverSemanticCheck(fixture) {
  const discovery = await discoverVerificationChecks({ packageDirectory: fixture.packageDirectory });
  return discovery.checks.find(check => check.id === CHECK_ID);
}

function passAssessment(requestId) {
  return {
    requestId,
    status: "PASS",
    summary: "The module owns integer validation.",
    rationale: "It rejects noninteger inputs before returning the accepted value.",
    citations: [{ path: "src/helper.js", line: 1, quote: HELPER_SOURCE.trim() }],
  };
}

test("when unrelated source exceeds the global inventory limit, complete empty siblings still permit assessment", async () => {
  // Arrange
  const fixture = await createEmptySiblingFixture();

  try {
    const check = await discoverSemanticCheck(fixture);
    const atLimit = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      changedPaths: ["src/helper.js"],
    });
    await writeFile(join(fixture.root, "noise", "one-more.js"), "export const unrelated = true;\n");

    // Act
    const prepared = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      changedPaths: ["src/helper.js"],
    });
    const reviewed = await readSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      contextPaths: ["caller.js"],
    });
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: reviewed.reviewRequest.path,
      assessment: passAssessment(reviewed.reviewRequest.requestId),
    });

    // Assert
    assert.equal(completed.status, "PASS");
    assert.equal(atLimit.reviewRequest.context.sourceInventory.complete, true);
    assert.deepEqual(atLimit.reviewRequest.missingContext, []);
    assert.equal(reviewed.reviewRequest.context.sourceInventory.complete, false);
    assert.deepEqual(reviewed.reviewRequest.context.siblingInventory, [
      { path: "src", files: [], complete: true },
    ]);
    assert.deepEqual(reviewed.reviewRequest.missingContext, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when empty siblings are complete but caller coverage is missing, assessment remains BLOCKED", async () => {
  // Arrange
  const fixture = await createEmptySiblingFixture();

  try {
    await rm(join(fixture.root, "caller.js"));
    await writeFile(join(fixture.root, "noise", "extra-a.js"), "export const unrelated = true;\n");
    await writeFile(join(fixture.root, "noise", "extra-b.js"), "export const unrelated = true;\n");
    const prepared = await prepareSemanticEvaluation({
      check: await discoverSemanticCheck(fixture),
      cwd: fixture.root,
      changedPaths: ["src/helper.js"],
    });

    // Act
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId),
    });

    // Assert
    assert.equal(prepared.reviewRequest.context.sourceInventory.complete, false);
    assert.ok(prepared.reviewRequest.context.callerRetrieval.omittedFiles > 0);
    assert.equal(completed.status, "BLOCKED");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when a sibling directory exceeds its entry budget, empty evidence cannot permit assessment", async () => {
  // Arrange
  const fixture = await createEmptySiblingFixture();

  try {
    for (let index = 0; index < 1_200; index += 1) {
      await writeFile(join(fixture.root, "src", `entry-${index}.txt`), "");
    }
    const prepared = await prepareSemanticEvaluation({
      check: await discoverSemanticCheck(fixture),
      cwd: fixture.root,
      changedPaths: ["src/helper.js"],
      contextPaths: ["caller.js"],
    });

    // Act
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId),
    });

    // Assert
    assert.equal(completed.status, "BLOCKED");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when the only sibling source is unreadable within capture limits, assessment remains BLOCKED", async () => {
  // Arrange
  const fixture = await createEmptySiblingFixture();

  try {
    await writeFile(join(fixture.root, "src", "large.js"), "x".repeat(256_001));
    const prepared = await prepareSemanticEvaluation({
      check: await discoverSemanticCheck(fixture),
      cwd: fixture.root,
      changedPaths: ["src/helper.js"],
      contextPaths: ["caller.js"],
    });

    // Act
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId),
    });

    // Assert
    assert.equal(completed.status, "BLOCKED");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when a sibling appears after empty-directory capture, the earlier assessment is stale", async () => {
  // Arrange
  const fixture = await createEmptySiblingFixture();

  try {
    const prepared = await prepareSemanticEvaluation({
      check: await discoverSemanticCheck(fixture),
      cwd: fixture.root,
      changedPaths: ["src/helper.js"],
    });
    await writeFile(join(fixture.root, "src", "new.js"), "export const sibling = true;\n");

    // Act
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId),
    });

    // Assert
    assert.equal(completed.status, "BLOCKED");
    assert.match(completed.evidence, /source or project context changed/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when a changed directory cannot be inspected, retained deletion source does not establish empty siblings", async () => {
  // Arrange
  const fixture = await createEmptySiblingFixture();

  try {
    await rm(join(fixture.root, "src"), { recursive: true });
    const prepared = await prepareSemanticEvaluation({
      check: await discoverSemanticCheck(fixture),
      cwd: fixture.root,
      changedPaths: ["src/helper.js"],
      contextPaths: ["caller.js"],
    });

    // Act
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId),
    });

    // Assert
    assert.equal(prepared.reviewRequest.context.changedCode[0].state, "deleted");
    assert.equal(completed.status, "BLOCKED");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when generic callers fill the budget, each changed directory retains representative sibling source", async () => {
  // Arrange
  const fixture = await createEmptySiblingFixture({ noiseFiles: 0 });
  const directories = ["src/first", "src/second", "src/third"];
  const changedPaths = directories.map(directory => `${directory}/create-service.js`);

  try {
    for (const directory of directories) {
      await mkdir(join(fixture.root, directory));
      await writeFile(join(fixture.root, directory, "create-service.js"), HELPER_SOURCE);
      const siblingCount = directory === directories[0] ? 44 : 1;
      for (let index = 0; index < siblingCount; index += 1) {
        await writeFile(join(fixture.root, directory, `sibling-${index}.js`), "export const sibling = true;\n");
      }
    }
    for (let index = 0; index < 45; index += 1) {
      await writeFile(join(fixture.root, "noise", `caller-${index}.js`), '// generic create-service candidate\nexport const unrelated = true;\n');
    }
    const check = await discoverSemanticCheck(fixture);

    // Act
    const prepared = await prepareSemanticEvaluation({ check, cwd: fixture.root, changedPaths });
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: {
        ...passAssessment(prepared.reviewRequest.requestId),
        citations: [{ path: changedPaths[0], line: 1, quote: HELPER_SOURCE.trim() }],
      },
    });

    // Assert
    const context = prepared.reviewRequest.context;
    for (const directory of directories) {
      assert.ok(Array.isArray(context.siblings)
        && context.siblings.some(record => record.path === `${directory}/sibling-0.js`));
    }
    assert.deepEqual(prepared.reviewRequest.missingContext, []);
    assert.equal(context.evidenceBudget.usedFiles, context.evidenceBudget.maxFiles);
    assert.ok(context.evidenceBudget.usedBytes <= context.evidenceBudget.maxBytes);
    assert.ok(context.evidenceBudget.rejections.some(record => record.source === "callers"));
    assert.equal(completed.status, "PASS");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when discovered sibling source exceeds capture limits, explicit ranges recover the same complete scope", async () => {
  // Arrange
  const fixture = await createEmptySiblingFixture({ noiseFiles: 0 });

  try {
    await writeFile(join(fixture.root, "src", "large.js"), `export const sibling = true;\n${"// bounded source\n".repeat(1_000)}`);
    const prepared = await prepareSemanticEvaluation({
      check: await discoverSemanticCheck(fixture),
      cwd: fixture.root,
      changedPaths: ["src/helper.js"],
    });

    // Act
    const blocked = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId),
    });
    const recovered = await readSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      contextPaths: ["src/large.js#L1-L1"],
    });
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: recovered.reviewRequest.path,
      assessment: passAssessment(recovered.reviewRequest.requestId),
    });

    // Assert
    assert.equal(blocked.status, "BLOCKED");
    assert.equal(prepared.reviewRequest.context.siblings.status, "not-captured");
    assert.ok(prepared.reviewRequest.context.evidenceBudget.rejections.some(record =>
      record.path === "src/large.js" && record.reason.includes("16000-byte")));
    assert.ok(prepared.reviewRequest.missingContext.some(reason =>
      reason.includes("src") && reason.includes("review --context")));
    assert.deepEqual(recovered.reviewRequest.scope.changedPaths, ["src/helper.js"]);
    assert.equal(recovered.reviewRequest.context.siblings.status, "captured-elsewhere");
    assert.deepEqual(recovered.reviewRequest.missingContext, []);
    assert.equal(completed.status, "PASS");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when sibling source is also the caller, incomplete global inventory does not hide its admitted evidence", async () => {
  // Arrange
  const fixture = await createEmptySiblingFixture();

  try {
    await rm(join(fixture.root, "caller.js"));
    await writeFile(join(fixture.root, "src", "caller.js"), 'import { helper } from "./helper.js";\nexport const result = helper(1);\n');
    await writeFile(join(fixture.root, "noise", "extra-a.js"), "export const unrelated = true;\n");
    await writeFile(join(fixture.root, "noise", "extra-b.js"), "export const unrelated = true;\n");
    const prepared = await prepareSemanticEvaluation({
      check: await discoverSemanticCheck(fixture),
      cwd: fixture.root,
      changedPaths: ["src/helper.js"],
    });

    // Act
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId),
    });

    // Assert
    assert.equal(prepared.reviewRequest.context.sourceInventory.complete, false);
    assert.equal(prepared.reviewRequest.context.callers.status, "captured-elsewhere");
    assert.deepEqual(prepared.reviewRequest.missingContext, []);
    assert.equal(completed.status, "PASS");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
