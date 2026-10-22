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

function oversizedHelperSource(ruleCount = 800) {
  const rules = Array.from({ length: ruleCount }, (_, index) => {
    const identifier = `event-${String(index + 1).padStart(4, "0")}`;
    return `  ["${identifier}", { owner: "team-${index % 17}", retryable: ${index % 2 === 0} }],`;
  });

  return [
    "const eventRules = new Map([",
    ...rules,
    "]);",
    "",
    "export function eventPolicy(identifier) {",
    "  const policy = eventRules.get(identifier);",
    "  if (!policy) throw new Error(`Unsupported event: ${identifier}`);",
    "  return policy;",
    "}",
    "",
  ].join("\n");
}

function citationFor(path, source, line) {
  return {
    path,
    line,
    quote: source.split(/\r?\n/)[line - 1],
  };
}

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

async function createSemanticFixture({ untrackedHelper = false, helperSource = HELPER_SOURCE } = {}) {
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
  await writeFile(join(root, "src", "helper.js"), helperSource);
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

function sourceRangeSelectors(path, lineCount, chunkSize = 180) {
  const selectors = [];
  for (let startLine = 1; startLine <= lineCount; startLine += chunkSize) {
    const endLine = Math.min(lineCount, startLine + chunkSize - 1);
    selectors.push(`${path}#L${startLine}-L${endLine}`);
  }
  return selectors;
}

test("when changed source exceeds the per-record limit, an unrequested assessment remains BLOCKED", async () => {
  // Arrange
  const source = oversizedHelperSource();
  const fixture = await createSemanticFixture({ helperSource: source });

  try {
    const prepared = await prepareSemanticEvaluation({
      check: await discoverSemanticCheck(fixture),
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js"],
    });
    const changedSource = prepared.reviewRequest.context.changedCode.find(record => record.path === "src/helper.js");

    // Act
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId, citationFor("src/helper.js", source, 4)),
    });

    // Assert
    assert.ok(Buffer.byteLength(source) > 16_000);
    assert.equal(changedSource.state, "unavailable");
    assert.ok(prepared.reviewRequest.context.missingChangedPaths.includes("src/helper.js"));
    assert.equal(completed.status, "BLOCKED");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when only part of oversized changed source is recovered, a cited assessment remains BLOCKED", async () => {
  // Arrange
  const source = oversizedHelperSource();
  const fixture = await createSemanticFixture({ helperSource: source });

  try {
    const prepared = await prepareSemanticEvaluation({
      check: await discoverSemanticCheck(fixture),
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js"],
    });
    const recovered = await readSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      contextPaths: ["src/helper.js#L1-L12"],
    });

    // Act
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: recovered.reviewRequest.path,
      assessment: passAssessment(recovered.reviewRequest.requestId, citationFor("src/helper.js", source, 4)),
    });

    // Assert
    const coverage = recovered.reviewRequest.context.changedCodeCoverage.find(record => record.path === "src/helper.js");
    assert.deepEqual(coverage.coveredRanges, [[1, 12]]);
    assert.ok(coverage.omittedRanges.length > 0);
    assert.equal(coverage.complete, false);
    assert.ok(recovered.reviewRequest.context.missingChangedPaths.includes("src/helper.js"));
    assert.equal(completed.status, "BLOCKED");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when bounded changed-source chunks cover the whole file, citations retain original source lines", async () => {
  // Arrange
  const source = oversizedHelperSource();
  const sourceLines = source.split(/\r?\n/);
  const lineCount = sourceLines.length;
  const chunkSize = 180;
  const selectors = sourceRangeSelectors("src/helper.js", lineCount, chunkSize);
  const fixture = await createSemanticFixture({ helperSource: source });

  try {
    const prepared = await prepareSemanticEvaluation({
      check: await discoverSemanticCheck(fixture),
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js"],
    });
    const recovered = await readSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      contextPaths: selectors,
    });

    // Act
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: recovered.reviewRequest.path,
      assessment: {
        ...passAssessment(recovered.reviewRequest.requestId, citationFor("src/helper.js", source, 2)),
        status: "PASS",
        summary: "The classifier uses a meaningful event-policy table.",
        rationale: "It owns supported-event lookup and rejects unknown identifiers.",
        citations: [
          citationFor("src/helper.js", source, 2),
          citationFor("src/helper.js", source, lineCount - 2),
        ],
      },
    });

    // Assert
    const coverage = recovered.reviewRequest.context.changedCodeCoverage.find(record => record.path === "src/helper.js");
    assert.equal(coverage.complete, true);
    assert.equal(coverage.coveredRanges[0][0], 1);
    assert.equal(coverage.coveredRanges.at(-1)[1], lineCount);
    assert.deepEqual(coverage.omittedRanges, []);
    assert.deepEqual(recovered.reviewRequest.context.missingChangedPaths, []);
    assert.equal(
      recovered.reviewRequest.context.targetedContext.some(record => record.path === "src/helper.js"),
      false,
    );
    assert.equal(completed.status, "PASS");
    assert.match(completed.evidence, new RegExp(`src/helper\\.js:2:`));
    assert.match(completed.evidence, new RegExp(`src/helper\\.js:${lineCount - 2}:`));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when recovery supersedes an oversized-source request, the older request cannot complete", async () => {
  // Arrange
  const source = oversizedHelperSource();
  const fixture = await createSemanticFixture({ helperSource: source });

  try {
    const prepared = await prepareSemanticEvaluation({
      check: await discoverSemanticCheck(fixture),
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js"],
    });

    // Act
    const recovered = await readSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      contextPaths: ["src/helper.js#L1-L12"],
    });
    const superseded = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId, citationFor("src/helper.js", source, 4)),
    });

    // Assert
    assert.notEqual(recovered.reviewRequest.requestId, prepared.reviewRequest.requestId);
    assert.equal(superseded.status, "BLOCKED");
    assert.match(superseded.evidence, /superseded/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when source changes outside the recovered excerpt, the captured request is stale", async () => {
  // Arrange
  const source = oversizedHelperSource();
  const fixture = await createSemanticFixture({ helperSource: source });

  try {
    const prepared = await prepareSemanticEvaluation({
      check: await discoverSemanticCheck(fixture),
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js"],
    });
    const recovered = await readSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      contextPaths: ["src/helper.js#L1-L12"],
    });
    const changedSource = source.replace(
      '["event-0500", { owner: "team-6", retryable: false }]',
      '["event-0500", { owner: "team-6", retryable: true }]',
    );
    await writeFile(join(fixture.root, "src", "helper.js"), changedSource);

    // Act
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: recovered.reviewRequest.path,
      assessment: passAssessment(recovered.reviewRequest.requestId, citationFor("src/helper.js", source, 4)),
    });

    // Assert
    assert.notEqual(changedSource, source);
    assert.equal(completed.status, "BLOCKED");
    assert.match(completed.evidence, /source or project context changed/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when changed source exceeds the source-size limit, requested excerpts cannot establish completeness", async () => {
  // Arrange
  const source = oversizedHelperSource(5_000);
  const fixture = await createSemanticFixture({ helperSource: source });

  try {
    const prepared = await prepareSemanticEvaluation({
      check: await discoverSemanticCheck(fixture),
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js"],
    });

    // Act
    const recovered = await readSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      contextPaths: ["src/helper.js#L1-L10", "src/helper.js#L4-L20"],
    });
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: recovered.reviewRequest.path,
      assessment: passAssessment(recovered.reviewRequest.requestId, citationFor("src/helper.js", source, 4)),
    });

    // Assert
    assert.ok(Buffer.byteLength(source) > 256_000);
    assert.ok(recovered.reviewRequest.context.missingChangedPaths.includes("src/helper.js"));
    assert.equal(completed.status, "BLOCKED");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when an oversized recovered file is deleted, a partial excerpt is not treated as complete prior source", async () => {
  // Arrange
  const source = oversizedHelperSource();
  const fixture = await createSemanticFixture({ untrackedHelper: true, helperSource: source });

  try {
    const check = await discoverSemanticCheck(fixture);
    const prepared = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js"],
    });
    const recovered = await readSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      contextPaths: ["src/helper.js#L1-L12"],
    });
    await rm(join(fixture.root, "src", "helper.js"));

    // Act
    const deleted = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js"],
    });
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: deleted.reviewRequest.path,
      assessment: passAssessment(deleted.reviewRequest.requestId, citationFor("src/helper.js", source, 4)),
    });

    // Assert
    assert.notEqual(recovered.reviewRequest.requestId, prepared.reviewRequest.requestId);
    assert.ok(deleted.reviewRequest.context.missingChangedPaths.includes("src/helper.js"));
    assert.equal(deleted.reviewRequest.context.changedCode.some(record => record.path === "src/helper.js" && record.state === "deleted"), false);
    assert.equal(completed.status, "BLOCKED");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when a changed source path is absent and unproven, an assessment cannot report PASS", async () => {
  // Arrange
  const fixture = await createSemanticFixture();

  try {
    const prepared = await prepareSemanticEvaluation({
      check: await discoverSemanticCheck(fixture),
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/missing.js"],
    });

    // Act
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId),
    });

    // Assert
    assert.ok(prepared.reviewRequest.context.missingChangedPaths.includes("src/missing.js"));
    assert.equal(completed.status, "BLOCKED");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

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

test("when a relevant guide exceeds the capture limit in a large repository, ranged CLI recovery preserves source identity", async () => {
  // Arrange
  const fixture = await createSemanticFixture();

  try {
    const guideLines = Array.from({ length: 500 }, (_, index) =>
      `Guidance line ${index + 1}: a module should own meaningful behavior.`,
    );
    await writeFile(join(fixture.root, "README.md"), `${guideLines.join("\n")}\n`);
    await mkdir(join(fixture.root, "noise"));
    for (let index = 0; index < 1_205; index += 1) {
      await writeFile(join(fixture.root, "noise", `unrelated-${index}.js`), "export const unrelated = true;\n");
    }
    for (let index = 0; index < 80; index += 1) {
      await writeFile(join(fixture.root, "src", `sibling-${index}.js`), "export const sibling = true;\n");
    }
    for (let index = 0; index < 45; index += 1) {
      const unrelatedDirectory = join(fixture.root, "unrelated", String(index));
      await mkdir(unrelatedDirectory, { recursive: true });
      await writeFile(join(unrelatedDirectory, "README.md"), "Only this unrelated subtree uses this guidance.\n".repeat(300));
    }

    const check = await discoverSemanticCheck(fixture);
    const prepared = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js"],
    });

    // Act
    let output;
    try {
      output = execFileSync(process.execPath, [
        join(process.cwd(), "bin/omp-verifier.js"),
        "review",
        prepared.reviewRequest.path,
        "--context",
        "README.md#L130-L150",
      ], { cwd: fixture.root, encoding: "utf8" });
    } catch (error) {
      assert.equal(error.status, 1);
      output = error.stdout;
    }
    // Assert
    const reviewed = JSON.parse(output)[0].reviewRequest;
    const guide = reviewed.context.targetedContext.find(record => record.path === "README.md");

    assert.ok(guide);
    assert.equal(guide.startLine, 130);
    assert.equal(guide.lineCount, 501);
    assert.equal(guide.partial, true);
    assert.equal(guide.content["130"], "Guidance line 130: a module should own meaningful behavior.");
    assert.equal(reviewed.context.sourceInventory.complete, false);
    assert.deepEqual(reviewed.missingContext, []);
    assert.equal(reviewed.context.evidenceTruncated.siblings, true);
    assert.ok(!reviewed.context.projectGuidance.some(record => record.path.startsWith("unrelated/")));

    // Act
    await writeFile(join(fixture.root, "README.md"), `${guideLines[0]}\n${guideLines.slice(1).join("\n")}\nChanged outside the recovered range.\n`);
    const staleReview = await readSemanticEvaluation({
      cwd: fixture.root,
      requestPath: JSON.parse(output)[0].reviewRequest.path,
    });
    // Assert
    assert.equal(staleReview.status, "BLOCKED");
    assert.match(staleReview.evidence, /source or project context changed/);
    assert.ok(reviewed.context.notes.some(note => note.includes("callers or siblings may be omitted")));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when guidance is recovered in separate chunks, citations retain both original locations", async () => {
  // Arrange
  const fixture = await createSemanticFixture();

  try {
    const guideLines = Array.from({ length: 500 }, (_, index) => `Boundary guidance at original line ${index + 1}.`);
    await writeFile(join(fixture.root, "README.md"), guideLines.join("\n"));
    const prepared = await prepareSemanticEvaluation({
      check: await discoverSemanticCheck(fixture),
      cwd: fixture.root,
      changedPaths: ["src/helper.js"],
      contextPaths: ["README.md#L130-L140", "README.md#L300-L310"],
    });

    // Act
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: {
        ...passAssessment(prepared.reviewRequest.requestId),
        status: "FAIL",
        summary: "The helper only forwards its input.",
        rationale: "The captured helper owns no invariant; the recovered guidance locations remain source citations.",
        citations: [
          CITATION,
          { path: "README.md", line: 130, quote: "Boundary guidance at original line 130." },
          { path: "README.md", line: 300, quote: "Boundary guidance at original line 300." },
        ],
      },
    });
    // Assert
    assert.equal(completed.status, "FAIL");
    assert.match(completed.evidence, /README\.md:130: "Boundary guidance at original line 130\."/);
    assert.match(completed.evidence, /README\.md:300: "Boundary guidance at original line 300\."/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when a citation names a real line outside the recovered chunks, the assessment remains BLOCKED", async () => {
  // Arrange
  const fixture = await createSemanticFixture();

  try {
    const guideLines = Array.from({ length: 500 }, (_, index) => `Boundary guidance at original line ${index + 1}.`);
    await writeFile(join(fixture.root, "README.md"), guideLines.join("\n"));
    const prepared = await prepareSemanticEvaluation({
      check: await discoverSemanticCheck(fixture),
      cwd: fixture.root,
      changedPaths: ["src/helper.js"],
      contextPaths: ["README.md#L130-L140"],
    });

    // Act
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: {
        ...passAssessment(prepared.reviewRequest.requestId),
        citations: [CITATION, { path: "README.md", line: 450, quote: "Boundary guidance at original line 450." }],
      },
    });
    // Assert
    assert.equal(completed.status, "BLOCKED");
    assert.match(completed.evidence, /citation README\.md:450 does not match the captured source excerpt/);
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
    const refreshed = await readSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      contextPaths: ["src/caller.js"],
    });

    // Assert
    assert.notEqual(refreshed.reviewRequest.requestId, prepared.reviewRequest.requestId);
    assert.notEqual(refreshed.reviewRequest.nonce, prepared.reviewRequest.nonce);
    assert.deepEqual(refreshed.reviewRequest.scope.contextPaths, ["src/caller.js"]);
    assert.equal(refreshed.reviewRequest.context.targetedContext[0].content, CALLER_SOURCE);

    // Act
    const oldAssessment = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId),
    });
    // Assert
    assert.equal(oldAssessment.status, "BLOCKED");
    assert.match(oldAssessment.evidence, /superseded/);

    // Act
    const newAssessment = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: refreshed.reviewRequest.path,
      assessment: passAssessment(refreshed.reviewRequest.requestId),
    });
    // Assert
    assert.equal(newAssessment.status, "PASS");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when requested context is unavailable, semantic completion cannot report PASS", async () => {
  // Arrange
  const fixture = await createSemanticFixture();

  try {
    const check = await discoverSemanticCheck(fixture);
    // Act
    const prepared = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js", "src/caller.js"],
      contextPaths: ["src/missing-caller.js"],
    });
    // Assert
    assert.equal(prepared.status, "BLOCKED");
    assert.equal(prepared.reviewRequest.missingContext.some(reason => reason.includes("src/missing-caller.js")), true);

    // Act
    const result = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId),
    });
    // Assert
    assert.equal(result.status, "BLOCKED");
    assert.match(result.evidence, /required context is unavailable/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when changed source becomes stale, an earlier assessment cannot complete", async () => {
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
    await writeFile(join(fixture.root, "src", "helper.js"), "export function helper(value) { return value + 1; }\n");

    // Act
    const staleRead = await readSemanticEvaluation({ cwd: fixture.root, requestPath: prepared.reviewRequest.path });
    // Assert
    assert.equal(staleRead.status, "BLOCKED");
    assert.equal(staleRead.reviewRequest, undefined);
    assert.match(staleRead.evidence, /source or project context changed/);

    // Act
    const staleAssessment = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId),
    });
    // Assert
    assert.equal(staleAssessment.status, "BLOCKED");
    assert.match(staleAssessment.evidence, /source or project context changed/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when a request file is tampered with, completion fails closed", async () => {
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
    const storedRequest = JSON.parse(await readFile(prepared.reviewRequest.path, "utf8"));
    storedRequest.payload.standard.gold = "Changed after the verifier captured the supplied standard.";
    await writeFile(prepared.reviewRequest.path, JSON.stringify(storedRequest));

    // Act
    const result = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId),
    });
    // Assert
    assert.equal(result.status, "BLOCKED");
    assert.match(result.evidence, /tampered with/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when an assessment has already been consumed, it cannot complete the request again", async () => {
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
    const assessment = passAssessment(prepared.reviewRequest.requestId);

    // Act
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment,
    });
    // Assert
    assert.equal(completed.status, "PASS");

    // Act
    const repeated = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment,
    });
    // Assert
    assert.equal(repeated.status, "BLOCKED");
    assert.match(repeated.evidence, /already been consumed/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when a newer request supersedes an older one, only the current assessment can complete", async () => {
  // Arrange
  const fixture = await createSemanticFixture();

  try {
    const check = await discoverSemanticCheck(fixture);
    const first = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js", "src/caller.js"],
    });

    // Act
    const second = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js", "src/caller.js"],
    });
    // Assert
    assert.notEqual(first.reviewRequest.requestId, second.reviewRequest.requestId);

    // Act
    const supersededAssessment = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: first.reviewRequest.path,
      assessment: passAssessment(first.reviewRequest.requestId),
    });
    // Assert
    assert.equal(supersededAssessment.status, "BLOCKED");
    assert.match(supersededAssessment.evidence, /superseded/);

    // Act
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
    // Assert
    assert.equal(currentAssessment.status, "FAIL");
    assert.equal(currentAssessment.evaluation.requestId, second.reviewRequest.requestId);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when a deletion was committed before any capture, Git history supplies the deleted source", async () => {
  // Arrange
  const fixture = await createSemanticFixture();

  try {
    await rm(join(fixture.root, "src", "helper.js"));
    await writeFile(join(fixture.root, "src", "caller.js"), "export const result = 1;\n");
    execFileSync("git", ["add", "src"], { cwd: fixture.root });
    execFileSync("git", ["commit", "--quiet", "-m", "remove forwarding helper"], { cwd: fixture.root });
    await writeFile(join(fixture.root, "later.txt"), "A later unrelated commit.\n");
    execFileSync("git", ["add", "later.txt"], { cwd: fixture.root });
    execFileSync("git", ["commit", "--quiet", "-m", "later work"], { cwd: fixture.root });

    // Act
    const prepared = await prepareSemanticEvaluation({
      check: await discoverSemanticCheck(fixture),
      cwd: fixture.root,
      changedPaths: ["src/helper.js", "src/caller.js"],
    });
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId),
    });

    // Assert
    const deleted = prepared.reviewRequest.context.changedCode.find(record => record.path === "src/helper.js");
    assert.equal(deleted.state, "deleted");
    assert.equal(deleted.content, HELPER_SOURCE);
    assert.match(deleted.previousSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(prepared.reviewRequest.missingContext, []);
    assert.equal(completed.status, "PASS");
    assert.match(completed.evidence, /src\/helper\.js:1 \(deleted\)/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when a corrected change deletes an untracked helper, the fresh request retains its prior source as deletion evidence", async () => {
  // Arrange
  const fixture = await createSemanticFixture({ untrackedHelper: true });

  try {
    const check = await discoverSemanticCheck(fixture);
    const first = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js", "src/caller.js"],
    });

    // Act
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
    // Assert
    assert.equal(initialFailure.status, "FAIL");

    // Act
    await writeFile(join(fixture.root, "src", "caller.js"), "export const result = 1;\n");
    await rm(join(fixture.root, "src", "helper.js"));
    const corrected = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      repositoryRoot: fixture.root,
      changedPaths: ["src/helper.js", "src/caller.js"],
    });
    // Assert
    const deletedHelper = corrected.reviewRequest.context.changedCode.find(record => record.path === "src/helper.js");
    assert.equal(deletedHelper.state, "deleted");
    assert.equal(deletedHelper.content, HELPER_SOURCE);
    assert.deepEqual(corrected.reviewRequest.missingContext, []);

    // Act
    const correctedPass = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: corrected.reviewRequest.path,
      assessment: passAssessment(corrected.reviewRequest.requestId),
    });
    // Assert
    assert.equal(correctedPass.status, "PASS");
    assert.match(correctedPass.evidence, /src\/helper\.js:1 \(deleted\)/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when a project requirement has no provider, it blocks unless a reasoned bounded suppression applies", async () => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-requirement-"));
  const packageDirectory = join(root, "plugins");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(root, "src", "example.js"), "export const example = true;\n");

  try {
    const projectConfigPath = join(root, ".omp-verifier.json");
    const requirements = [{ id: "publisher:required", path: "src/**" }];
    await writeFile(projectConfigPath, JSON.stringify({ requirements }));

    // Act
    const missingProvider = await runAutomaticVerification({
      cwd: root,
      repositoryRoot: root,
      changedPaths: ["src/example.js"],
      packageDirectory,
    });
    // Assert
    assert.equal(missingProvider.find(result => result.id === "publisher:required").status, "BLOCKED");
    assert.match(missingProvider.find(result => result.id === "publisher:required").summary, /provider is not installed/);

    // Arrange
    await writeFile(projectConfigPath, JSON.stringify({
      requirements,
      suppressions: [
        { id: "publisher:required", path: "src/**", reason: "The owner approved this bounded migration window." },
        { id: "publisher:undeclared", path: "src/**", reason: "This id is not declared as a project requirement." },
      ],
    }));
    // Act
    const suppressedProvider = await runAutomaticVerification({
      cwd: root,
      repositoryRoot: root,
      changedPaths: ["src/example.js"],
      packageDirectory,
    });
    // Assert
    assert.equal(suppressedProvider.find(result => result.id === "publisher:required").status, "SUPPRESSED");
    assert.match(suppressedProvider.find(result => result.id === "publisher:required").evidence, /owner approved/);
    assert.equal(suppressedProvider.find(result => result.id === "publisher:undeclared").status, "BLOCKED");

    // Arrange
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

    // Act
    const installedProvider = await runAutomaticVerification({
      cwd: root,
      repositoryRoot: root,
      changedPaths: ["src/example.js"],
      packageDirectory,
    });
    // Assert
    assert.equal(installedProvider.find(result => result.id === "publisher:required").status, "PASS");
    assert.deepEqual(installedProvider.find(result => result.id === "publisher:required").matches, [
      { path: "src/example.js", trigger: "src/**" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("when a manifest declares unsupported semantic modes or context, discovery blocks the actual check id", async () => {
  // Arrange
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
    // Act
    const discovery = await discoverVerificationChecks({ packageDirectory });
    // Assert
    assert.deepEqual(discovery.checks, []);
    assert.equal(discovery.blockedResults.find(result => result.id === "publisher:unknown-mode").status, "BLOCKED");
    assert.match(discovery.blockedResults.find(result => result.id === "publisher:unknown-mode").evidence, /unsupported verification mode/);
    assert.equal(discovery.blockedResults.find(result => result.id === CHECK_ID).status, "BLOCKED");
    assert.match(discovery.blockedResults.find(result => result.id === CHECK_ID).evidence, /requiredContext entries must be unique supported values/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
