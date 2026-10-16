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
} from "#root/omp-plugin/semantic-evaluations.js";
import { discoverVerificationChecks, runAutomaticVerification } from "#root/omp-plugin/verifications.js";

const CHECK_ID = "publisher:alignment";
const HELPER_SOURCE = "export function helper(value) { return value; }\n";
const CALLER_SOURCE = 'import { helper } from "./helper.js";\nexport const result = helper(1);\n';
const CITATION = {
  path: "src/helper.js",
  line: 1,
  quote: HELPER_SOURCE.trim(),
};

function semanticManifest(contract = "./verifications/alignment.json") {
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
        contract,
        pathTriggers: ["**/*.js"],
      }],
    },
  };
}

function semanticContract(overrides = {}) {
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
    ...overrides,
  };
}

async function initializeGit(root, { untrackedHelper = false } = {}) {
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "OMP Verifier Tests"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  if (untrackedHelper) execFileSync("git", ["reset", "--", "src/helper.js"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture baseline"], { cwd: root });
}

async function createSemanticFixture({ untrackedHelper = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-semantic-"));
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
  await writeFile(join(root, "src", "helper.js"), HELPER_SOURCE);
  await writeFile(join(root, "src", "caller.js"), CALLER_SOURCE);
  await initializeGit(root, { untrackedHelper });
  return { root, packageDirectory: join(root, "plugins"), packagePath };
}

async function discoverSemanticCheck(fixture) {
  const discovery = await discoverVerificationChecks({ packageDirectory: fixture.packageDirectory });
  const check = discovery.checks.find(candidate => candidate.id === CHECK_ID);
  assert.ok(check, "fixture semantic check should be discovered");
  assert.deepEqual(discovery.blockedResults, []);
  return check;
}

function passAssessment(requestId, citation = CITATION) {
  return {
    requestId,
    status: "PASS",
    summary: "The changed boundary meets the supplied standard.",
    rationale: "The changed scope owns meaningful behavior under the boundary-ownership condition.",
    citations: [citation],
  };
}

test("when an assessment cites unobserved source, completion is BLOCKED", async () => {
  // Arrange
  const fixture = await createSemanticFixture();

  try {
    const check = await discoverSemanticCheck(fixture);
    const prepared = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js", "src/caller.js"],
    });

    // Act
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId, { ...CITATION, quote: "not in the source" }),
    });

    // Assert
    assert.equal(completed.status, "BLOCKED");
    assert.match(completed.evidence, /does not match the captured source excerpt/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when README architecture guidance changes, an earlier assessment cannot report PASS", async () => {
  // Arrange
  const fixture = await createSemanticFixture();

  try {
    await writeFile(join(fixture.root, "README.md"), "Each helper owns an independent domain invariant.\n");
    const check = await discoverSemanticCheck(fixture);
    const prepared = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js"],
    });

    // Act
    await writeFile(join(fixture.root, "README.md"), "Keep direct forwarding in its caller; it is not an independent boundary.\n");
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId),
    });

    // Assert
    assert.equal(completed.status, "BLOCKED");
    assert.match(completed.evidence, /project context changed/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when architecture guidance cannot be captured, semantic completion cannot report PASS", async () => {
  // Arrange
  const fixture = await createSemanticFixture();

  try {
    await writeFile(join(fixture.root, "README.md"), "A transformation alone does not establish module ownership.\n".repeat(6_000));
    const check = await discoverSemanticCheck(fixture);
    const prepared = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js"],
    });

    // Act
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId),
    });

    // Assert
    assert.equal(completed.status, "BLOCKED");
    assert.match(completed.evidence, /could not capture project guidance: README.md/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when semantic requests overlap, only the current assessment can report PASS", async () => {
  // Arrange
  const fixture = await createSemanticFixture();

  try {
    const check = await discoverSemanticCheck(fixture);
    const prepared = await Promise.all(Array.from({ length: 8 }, () => prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js"],
    })));

    // Act
    const completed = await Promise.all(prepared.map(request => completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: request.reviewRequest.path,
      assessment: passAssessment(request.reviewRequest.requestId),
    })));

    // Assert
    assert.equal(completed.filter(result => result.status === "PASS").length, 1);
    assert.equal(completed.filter(result => result.status === "BLOCKED").length, 7);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when additional context is requested, the refreshed request renews its nonce and supersedes the previous one", async () => {
  const fixture = await createSemanticFixture();

  try {
    const check = await discoverSemanticCheck(fixture);
    const prepared = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js", "src/caller.js"],
    });
    const refreshed = await readSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      contextPaths: ["src/caller.js"],
    });

    assert.notEqual(refreshed.reviewRequest.requestId, prepared.reviewRequest.requestId);
    assert.notEqual(refreshed.reviewRequest.nonce, prepared.reviewRequest.nonce);
    assert.deepEqual(refreshed.reviewRequest.scope.contextPaths, ["src/caller.js"]);
    assert.equal(refreshed.reviewRequest.context.targetedContext[0].content, CALLER_SOURCE);

    const oldAssessment = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId),
    });
    assert.equal(oldAssessment.status, "BLOCKED");
    assert.match(oldAssessment.evidence, /superseded/);

    const newAssessment = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: refreshed.reviewRequest.path,
      assessment: passAssessment(refreshed.reviewRequest.requestId),
    });
    assert.equal(newAssessment.status, "PASS");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when requested context is unavailable, semantic completion cannot report PASS", async () => {
  const fixture = await createSemanticFixture();

  try {
    const check = await discoverSemanticCheck(fixture);
    const prepared = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js", "src/caller.js"],
      contextPaths: ["src/missing-caller.js"],
    });
    assert.equal(prepared.status, "BLOCKED");
    assert.equal(prepared.reviewRequest.missingContext.some(reason => reason.includes("src/missing-caller.js")), true);

    const result = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId),
    });
    assert.equal(result.status, "BLOCKED");
    assert.match(result.evidence, /required context is unavailable/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when changed source becomes stale, an earlier assessment cannot complete", async () => {
  const fixture = await createSemanticFixture();

  try {
    const check = await discoverSemanticCheck(fixture);
    const prepared = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js", "src/caller.js"],
    });
    await writeFile(join(fixture.root, "src", "helper.js"), "export function helper(value) { return value + 1; }\n");

    const staleRead = await readSemanticEvaluation({ cwd: fixture.root, requestPath: prepared.reviewRequest.path });
    assert.equal(staleRead.status, "BLOCKED");
    assert.equal(staleRead.reviewRequest, undefined);
    assert.match(staleRead.evidence, /source or project context changed/);

    const staleAssessment = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId),
    });
    assert.equal(staleAssessment.status, "BLOCKED");
    assert.match(staleAssessment.evidence, /source or project context changed/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when a request file is tampered with, completion fails closed", async () => {
  const fixture = await createSemanticFixture();

  try {
    const check = await discoverSemanticCheck(fixture);
    const prepared = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js", "src/caller.js"],
    });
    const storedRequest = JSON.parse(await readFile(prepared.reviewRequest.path, "utf8"));
    storedRequest.payload.standard.gold = "Changed after the verifier captured the supplied standard.";
    await writeFile(prepared.reviewRequest.path, JSON.stringify(storedRequest));

    const result = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId),
    });
    assert.equal(result.status, "BLOCKED");
    assert.match(result.evidence, /tampered with/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when an assessment has already been consumed, it cannot complete the request again", async () => {
  const fixture = await createSemanticFixture();

  try {
    const check = await discoverSemanticCheck(fixture);
    const prepared = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js", "src/caller.js"],
    });
    const assessment = passAssessment(prepared.reviewRequest.requestId);

    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment,
    });
    assert.equal(completed.status, "PASS");

    const repeated = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment,
    });
    assert.equal(repeated.status, "BLOCKED");
    assert.match(repeated.evidence, /already been consumed/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when a newer request supersedes an older one, only the current assessment can complete", async () => {
  const fixture = await createSemanticFixture();

  try {
    const check = await discoverSemanticCheck(fixture);
    const first = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js", "src/caller.js"],
    });
    const second = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js", "src/caller.js"],
    });
    assert.notEqual(first.reviewRequest.requestId, second.reviewRequest.requestId);

    const supersededAssessment = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: first.reviewRequest.path,
      assessment: passAssessment(first.reviewRequest.requestId),
    });
    assert.equal(supersededAssessment.status, "BLOCKED");
    assert.match(supersededAssessment.evidence, /superseded/);

    const currentAssessment = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: second.reviewRequest.path,
      assessment: {
        requestId: second.reviewRequest.requestId,
        status: "FAIL",
        summary: "The extracted helper only forwards its input.",
        rationale: "The extraction does not own a meaningful invariant under boundary-ownership.",
        citations: [CITATION],
      },
    });
    assert.equal(currentAssessment.status, "FAIL");
    assert.equal(currentAssessment.evaluation.requestId, second.reviewRequest.requestId);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when a corrected change deletes an untracked helper, the fresh request retains its prior source as deletion evidence", async () => {
  const fixture = await createSemanticFixture({ untrackedHelper: true });

  try {
    const check = await discoverSemanticCheck(fixture);
    const first = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js", "src/caller.js"],
    });
    const initialFailure = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: first.reviewRequest.path,
      assessment: {
        requestId: first.reviewRequest.requestId,
        status: "FAIL",
        summary: "The helper is a trivial forwarding extraction.",
        rationale: "It forwards without owning behavior, failing the boundary-ownership condition.",
        citations: [CITATION],
      },
    });
    assert.equal(initialFailure.status, "FAIL");

    await writeFile(join(fixture.root, "src", "caller.js"), "export const result = 1;\n");
    await rm(join(fixture.root, "src", "helper.js"));
    const corrected = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js", "src/caller.js"],
    });
    const deletedHelper = corrected.reviewRequest.context.changedCode.find(record => record.path === "src/helper.js");
    assert.equal(deletedHelper.state, "deleted");
    assert.equal(deletedHelper.content, HELPER_SOURCE);
    assert.deepEqual(corrected.reviewRequest.missingContext, []);

    const correctedPass = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: corrected.reviewRequest.path,
      assessment: passAssessment(corrected.reviewRequest.requestId),
    });
    assert.equal(correctedPass.status, "PASS");
    assert.match(correctedPass.evidence, /src\/helper\.js:1 \(deleted\)/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when a project requirement has no provider, it blocks unless a reasoned bounded suppression applies", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-requirement-"));
  const packageDirectory = join(root, "plugins");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(root, "src", "example.js"), "export const example = true;\n");

  try {
    const projectConfigPath = join(root, ".omp-verifier.json");
    const requirements = [{ id: "publisher:required", path: "src/**" }];
    await writeFile(projectConfigPath, JSON.stringify({ requirements }));
    const missingProvider = await runAutomaticVerification({
      cwd: root,
      repositoryRoot: root,
      changedPaths: ["src/example.js"],
      packageDirectory,
    });
    assert.equal(missingProvider.find(result => result.id === "publisher:required").status, "BLOCKED");
    assert.match(missingProvider.find(result => result.id === "publisher:required").summary, /provider is not installed/);

    await writeFile(projectConfigPath, JSON.stringify({
      requirements,
      suppressions: [
        { id: "publisher:required", path: "src/**", reason: "The owner approved this bounded migration window." },
        { id: "publisher:undeclared", path: "src/**", reason: "This id is not declared as a project requirement." },
      ],
    }));
    const suppressedProvider = await runAutomaticVerification({
      cwd: root,
      repositoryRoot: root,
      changedPaths: ["src/example.js"],
      packageDirectory,
    });
    assert.equal(suppressedProvider.find(result => result.id === "publisher:required").status, "SUPPRESSED");
    assert.match(suppressedProvider.find(result => result.id === "publisher:required").evidence, /owner approved/);
    assert.equal(suppressedProvider.find(result => result.id === "publisher:undeclared").status, "BLOCKED");

    const packagePath = join(packageDirectory, "publisher");
    await mkdir(packagePath, { recursive: true });
    await writeFile(join(packagePath, "package.json"), JSON.stringify({
      name: "publisher",
      omp: {
        extensions: ["./index.js"],
        verifications: [{
          id: "publisher:required",
          label: "Required project check",
          description: "Runs whenever project configuration requires it.",
          entry: "./required.mjs",
        }],
      },
    }));
    await writeFile(join(packagePath, "required.mjs"), 'process.stdout.write(JSON.stringify({ status: "PASS", summary: "Required provider ran" }));\n');
    await writeFile(projectConfigPath, JSON.stringify({ requirements }));

    const installedProvider = await runAutomaticVerification({
      cwd: root,
      repositoryRoot: root,
      changedPaths: ["src/example.js"],
      packageDirectory,
    });
    assert.equal(installedProvider.find(result => result.id === "publisher:required").status, "PASS");
    assert.deepEqual(installedProvider.find(result => result.id === "publisher:required").matches, [
      { path: "src/example.js", trigger: "src/**" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("when a manifest declares unsupported semantic modes or context, discovery blocks the actual check id", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-unsupported-mode-"));
  const packageDirectory = join(root, "plugins");
  const packagePath = join(packageDirectory, "publisher");
  await mkdir(join(packagePath, "verifications"), { recursive: true });
  await writeFile(join(packagePath, "package.json"), JSON.stringify({
    name: "publisher",
    omp: {
      extensions: ["./index.js"],
      verifications: [
        {
          id: "publisher:unknown-mode",
          label: "Unknown mode",
          description: "Must not be silently ignored.",
          mode: "prose-only",
        },
        {
          id: CHECK_ID,
          label: "Unsupported context",
          description: "The contract uses an unsupported context category.",
          mode: "agentic",
          contract: "./verifications/invalid-context.json",
        },
      ],
    },
  }));
  await writeFile(
    join(packagePath, "verifications", "invalid-context.json"),
    JSON.stringify(semanticContract({ requiredContext: ["free-form-policy"] })),
  );

  try {
    const discovery = await discoverVerificationChecks({ packageDirectory });
    assert.deepEqual(discovery.checks, []);
    assert.equal(discovery.blockedResults.find(result => result.id === "publisher:unknown-mode").status, "BLOCKED");
    assert.match(discovery.blockedResults.find(result => result.id === "publisher:unknown-mode").evidence, /unsupported verification mode/);
    assert.equal(discovery.blockedResults.find(result => result.id === CHECK_ID).status, "BLOCKED");
    assert.match(discovery.blockedResults.find(result => result.id === CHECK_ID).evidence, /requiredContext entries must be unique supported values/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
