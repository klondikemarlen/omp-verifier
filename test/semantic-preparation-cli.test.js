import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const CLI = join(process.cwd(), "bin", "omp-verifier.js");
const POLICY_SOURCE = "export function positive(value) { if (value <= 0) throw new RangeError(); return value; }\n";
const LARGE_HISTORICAL_SOURCE = [
  ...Array.from({ length: 438 }, () => `//${"x".repeat(34)}`),
  `//${"x".repeat(21)}`,
].join("\n");

const PAGED_SOURCE_PATHS = [
  "src/context-a.js",
  "src/context-b.js",
  "src/context-c.js",
  "src/context-d.js",
];

function reviewPageDetails(output) {
  const requestPath = output.match(/^Request path: (.+)$/m)?.[1];
  const requestId = output.match(/^Request ID: (.+)$/m)?.[1];
  const page = output.match(/^Page index: (\d+) of (\d+) \(zero-based\)$/m);
  if (!requestPath || !requestId || !page) return undefined;
  return {
    requestPath,
    requestId,
    index: Number(page[1]),
    count: Number(page[2]),
  };
}

function assessmentFor(requestId) {
  return {
    requestId,
    status: "PASS",
    summary: "The positive function rejects non-positive inputs.",
    rationale: "Its value <= 0 guard throws before returning the input.",
    citations: [{ path: "src/policy.js", line: 1, quote: POLICY_SOURCE.trim() }],
  };
}

function evaluateAssessment(fixture, requestPath, assessment, reporter) {
  return fixture.runInput(
    ["evaluate", requestPath, "--assessment", "-", "--reporter", reporter],
    `${JSON.stringify(assessment)}\n`,
  );
}

async function preparationFixture(t, {
  checkIds = ["publisher:alignment"],
  includeBlockedCheck = false,
  pagedReview = false,
  policySource = POLICY_SOURCE,
  changedPolicySource,
  deletedSource = "export const obsolete = true;\n",
} = {}) {
  let pagedSourcePaths = [];
  if (pagedReview) {
    pagedSourcePaths = PAGED_SOURCE_PATHS;
  }

  const root = await mkdtemp(join(tmpdir(), "omp-verifier-preparation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = join(root, "plugins", "node_modules", "publisher");
  await mkdir(provider, { recursive: true });
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "policy.js"), policySource);
  for (const [index, path] of pagedSourcePaths.entries()) {
    await writeFile(join(root, path), `export const context${index} = "baseline";\n`);
  }

  await writeFile(join(root, "src", "obsolete.js"), deletedSource);
  await writeFile(join(provider, "standard.md"), "The changed positive function rejects non-positive inputs.\n");
  const verifications = [];
  for (const id of checkIds) {
    const contract = `./${id.split(":")[1]}.json`;
    await writeFile(join(provider, contract), JSON.stringify({
      version: 1,
      standardId: id,
      source: "./standard.md",
      gold: "The positive function rejects non-positive inputs.",
      requiredContext: ["changed-code"],
      rubric: [{ id: "validation", question: "Does positive enforce its input invariant?" }],
    }));
    verifications.push({
      id,
      label: "Positive Validation",
      description: "Assesses the supplied validation contract.",
      mode: "agentic",
      contract,
      pathTriggers: ["src/*.js"],
    });
  }
  if (includeBlockedCheck) {
    await writeFile(join(provider, "blocked.mjs"), `
process.stdout.write(JSON.stringify({
  status: "BLOCKED",
  summary: "A required comparison base is unavailable.",
}));
process.exitCode = 1;
`);
    verifications.push({
      id: "publisher:baseline",
      label: "Baseline",
      description: "Requires an available comparison base.",
      entry: "./blocked.mjs",
      pathTriggers: ["src/*.js"],
    });
  }
  await writeFile(join(provider, "package.json"), JSON.stringify({
    name: "publisher",
    version: "1.0.0",
    omp: { extensions: ["./index.js"], verifications },
  }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Verifier Tests", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "baseline"], { cwd: root });
  if (changedPolicySource !== undefined) {
    await writeFile(join(root, "src", "policy.js"), changedPolicySource);
  }
  for (const [index, path] of pagedSourcePaths.entries()) {
    const source = `// ${"review context. ".repeat(900)}\nexport const context${index} = true;\n`;
    await writeFile(join(root, path), source);
  }
  await rm(join(root, "src", "obsolete.js"));
  return {
    run: args => spawnSync(process.execPath, [CLI, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") },
    }),
    runInput: (args, input) => spawnSync(process.execPath, [CLI, ...args], {
      cwd: root,
      encoding: "utf8",
      input,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") },
    }),
    runCommand: (command, input) => spawnSync(command, {
      shell: true,
      cwd: root,
      encoding: "utf8",
      input,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") },
    }),
    pagedSourcePaths,
  };
}

test("when automatic receives a larger source cap, it recovers a full authenticated historical deletion", async t => {
  // Arrange
  const changedPolicySource = POLICY_SOURCE.replace("value <= 0", "value < 1");
  const fixture = await preparationFixture(t, {
    changedPolicySource,
    deletedSource: LARGE_HISTORICAL_SOURCE,
  });

  // Act
  const prepared = fixture.run([
    "automatic", "src/policy.js", "src/obsolete.js",
    "--max-source-bytes", "32768",
  ]);
  const result = JSON.parse(prepared.stdout)[0];
  const firstPage = fixture.run(["review", result.reviewRequest.path, "--reporter", "text"]);
  const review = reviewPageDetails(firstPage.stdout);
  const pageReads = [firstPage];
  for (let pageIndex = 1; pageIndex < review.count; pageIndex += 1) {
    pageReads.push(fixture.run([
      "review", result.reviewRequest.path,
      "--reporter", "text",
      "--page", String(pageIndex),
    ]));
  }
  const deletedLine = LARGE_HISTORICAL_SOURCE.split("\n")[438];
  const assessment = {
    requestId: result.reviewRequest.requestId,
    status: "PASS",
    summary: "The changed positive function rejects values below one.",
    rationale: "Its value < 1 guard throws before returning the input.",
    citations: [
      {
        path: "src/policy.js",
        line: 1,
        quote: changedPolicySource.trim(),
      },
      {
        path: "src/obsolete.js",
        line: 439,
        quote: deletedLine,
      },
    ],
  };
  const evaluation = fixture.runInput(
    ["evaluate", result.reviewRequest.path, "--assessment", "-"],
    `${JSON.stringify(assessment)}\n`,
  );
  const completed = JSON.parse(evaluation.stdout)[0];

  // Assert
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(Buffer.byteLength(LARGE_HISTORICAL_SOURCE), 16229);
  assert.equal(LARGE_HISTORICAL_SOURCE.split("\n").length, 439);
  assert.ok(pageReads.every(page => page.status === 0), pageReads.map(page => page.stderr).join("\n"));
  assert.equal(result.status, "PENDING");
  assert.deepEqual(result.reviewRequest.scope.changedPaths, ["src/obsolete.js", "src/policy.js"]);
  assert.equal(result.reviewRequest.scope.maxSourceBytes, 32768);
  assert.equal(result.reviewRequest.context.evidenceBudget.maxSourceBytes, 32768);
  const changedPolicy = result.reviewRequest.context.changedCode.find(record => record.path === "src/policy.js");
  const deletion = result.reviewRequest.context.changedCode.find(record => record.path === "src/obsolete.js");
  assert.equal(changedPolicy.content, changedPolicySource);
  assert.equal(deletion.state, "deleted");
  assert.equal(deletion.content, LARGE_HISTORICAL_SOURCE);
  assert.equal(evaluation.status, 0, evaluation.stderr);
  assert.equal(completed.status, "PASS");
  assert.match(completed.evidence, /src\/obsolete\.js:439 \(deleted\)/);
});

test("when manual verify receives a larger source cap, changed historical deletions remain in its review scope", async t => {
  // Arrange
  const fixture = await preparationFixture(t, {
    changedPolicySource: POLICY_SOURCE.replace("value <= 0", "value < 1"),
    deletedSource: LARGE_HISTORICAL_SOURCE,
  });

  // Act
  const prepared = fixture.run([
    "verify", "publisher:alignment",
    "--max-source-bytes", "32768",
  ]);
  const result = JSON.parse(prepared.stdout)[0];

  // Assert
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(result.status, "PENDING");
  assert.equal(result.reviewRequest.scope.maxSourceBytes, 32768);
  assert.deepEqual(result.reviewRequest.scope.changedPaths, ["src/obsolete.js", "src/policy.js"]);
  assert.equal(result.reviewRequest.context.changedCode.find(record => record.path === "src/obsolete.js").content,
    LARGE_HISTORICAL_SOURCE);
});

test("when worktree automatic receives a larger source cap, it recovers deleted source from the current worktree", async t => {
  // Arrange
  const fixture = await preparationFixture(t, {
    changedPolicySource: POLICY_SOURCE.replace("value <= 0", "value < 1"),
    deletedSource: LARGE_HISTORICAL_SOURCE,
  });

  // Act
  const prepared = fixture.run([
    "automatic", "--worktree",
    "--max-source-bytes", "32768",
  ]);
  const result = JSON.parse(prepared.stdout)[0];

  // Assert
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(result.status, "PENDING");
  assert.equal(result.reviewRequest.scope.maxSourceBytes, 32768);
  assert.deepEqual(result.reviewRequest.scope.changedPaths, ["src/obsolete.js", "src/policy.js"]);
  assert.equal(result.reviewRequest.context.changedCode.find(record => record.path === "src/obsolete.js").content,
    LARGE_HISTORICAL_SOURCE);
});

test("when a default automatic capture follows an explicit override, cached large deletion is rejected again", async t => {
  // Arrange
  const changedPolicySource = POLICY_SOURCE.replace("value <= 0", "value < 1");
  const fixture = await preparationFixture(t, {
    changedPolicySource,
    deletedSource: LARGE_HISTORICAL_SOURCE,
  });
  const admitted = fixture.run([
    "automatic", "src/policy.js", "src/obsolete.js",
    "--max-source-bytes", "32768",
  ]);
  const admittedResult = JSON.parse(admitted.stdout)[0];

  // Act
  const defaultCapture = fixture.run(["automatic", "src/policy.js", "src/obsolete.js"]);
  const defaultResult = JSON.parse(defaultCapture.stdout)[0];
  const rejectedDeletion = defaultResult.reviewRequest.context.changedCode.find(record => record.path === "src/obsolete.js");
  const assessment = {
    requestId: defaultResult.reviewRequest.requestId,
    status: "PASS",
    summary: "The changed positive function rejects values below one.",
    rationale: "Its value < 1 guard throws before returning the input.",
    citations: [
      {
        path: "src/policy.js",
        line: 1,
        quote: changedPolicySource.trim(),
      },
    ],
  };
  const evaluation = fixture.runInput(
    ["evaluate", defaultResult.reviewRequest.path, "--assessment", "-"],
    `${JSON.stringify(assessment)}\n`,
  );
  const completed = JSON.parse(evaluation.stdout)[0];

  // Assert
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(admittedResult.status, "PENDING");
  assert.equal(admittedResult.reviewRequest.scope.maxSourceBytes, 32768);
  assert.equal(defaultCapture.status, 0, defaultCapture.stderr);
  assert.equal(defaultResult.status, "PENDING");
  assert.equal(defaultResult.reviewRequest.scope.maxSourceBytes, 16000);
  assert.equal(rejectedDeletion.state, "unavailable");
  assert.ok(defaultResult.reviewRequest.context.missingChangedPaths.includes("src/obsolete.js"));
  assert.ok(defaultResult.reviewRequest.missingContext.some(reason => reason.includes("src/obsolete.js")));
  assert.equal(evaluation.status, 1, evaluation.stderr);
  assert.equal(completed.status, "BLOCKED");
});

test("when checks, review or evaluate receives a source cap, CLI rejects the unsupported command before dispatch", async t => {
  // Arrange
  const fixture = await preparationFixture(t);
  const unsupportedCommands = [
    ["checks"],
    ["review", "unavailable.json"],
    ["evaluate", "unavailable.json", "--assessment", "{}"],
  ];

  // Act
  const results = unsupportedCommands.map(args => fixture.run([...args, "--max-source-bytes", "32768"]));

  // Assert
  for (const result of results) {
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--max-source-bytes is only supported by fresh automatic or verify commands/);
  }
});

test("when automatic receives a malformed or out-of-range source cap, CLI rejects it before preparation", async t => {
  // Arrange
  const fixture = await preparationFixture(t);
  const invalidCaps = ["15999", "32768.5"];

  // Act
  const results = invalidCaps.map(value =>
    fixture.run(["automatic", "src/policy.js", "--max-source-bytes", value]));

  // Assert
  for (const result of results) {
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /16000|whole number/);
  }
});

test("when preparation returns one pending review, its first text response exposes current code and authenticated deletions", async t => {
  // Arrange
  const fixture = await preparationFixture(t);

  // Act
  const prepared = fixture.run([
    "automatic", "src/policy.js", "src/obsolete.js",
    "--reporter", "text", "--failures-only",
  ]);

  // Assert
  assert.equal(prepared.status, 0);
  const fragment = prepared.stdout.split("JSON fragment:\n")[1].split("\nNext page index:")[0].replaceAll("\\\n", "");
  const result = JSON.parse(fragment)[0];
  assert.equal(result.status, "PENDING");
  assert.deepEqual(result.reviewRequest.scope.changedPaths, ["src/obsolete.js", "src/policy.js"]);
  assert.deepEqual(result.reviewRequest.context.changedCode.find(record => record.path === "src/policy.js").content, {
    1: POLICY_SOURCE.trim(),
    2: "",
  });
  assert.equal(result.reviewRequest.context.changedCode.find(record => record.path === "src/obsolete.js").state, "deleted");
});

test("when preparation returns multiple pending reviews, each handle remains separately inspectable without concatenated pages", async t => {
  // Arrange
  const fixture = await preparationFixture(t, {
    checkIds: ["publisher:first", "publisher:second"],
  });

  // Act
  const prepared = fixture.run([
    "automatic", "src/policy.js", "src/obsolete.js",
    "--reporter", "text", "--failures-only",
  ]);

  // Assert
  assert.equal(prepared.status, 0);
  assert.deepEqual(prepared.stdout.match(/^PENDING publisher:[a-z]+$/gm), [
    "PENDING publisher:first",
    "PENDING publisher:second",
  ]);
  const paths = [...prepared.stdout.matchAll(/^  Review request: (.+)$/gm)].map(match => match[1]);
  const inspected = paths.map(path => fixture.run(["review", path]));
  assert.deepEqual(inspected.map(result => JSON.parse(result.stdout)[0].id), [
    "publisher:first",
    "publisher:second",
  ]);
});

test("when a final review page supplies evaluation, its command consumes the current request before silent completion", async t => {
  // Arrange
  const fixture = await preparationFixture(t);
  const prepared = fixture.run([
    "automatic", "src/policy.js", "src/obsolete.js",
    "--reporter", "text", "--failures-only",
  ]);
  const fragment = prepared.stdout.split("JSON fragment:\n")[1].split("\nNext page index:")[0].replaceAll("\\\n", "");
  const result = JSON.parse(fragment)[0];
  const nextCommand = prepared.stdout.match(/^Next command: (.+)$/m)[1];
  const assessment = `${JSON.stringify({
    requestId: result.reviewRequest.requestId,
    status: "PASS",
    summary: "The positive function rejects non-positive inputs.",
    rationale: "Its explicit value <= 0 guard throws before returning the input.",
    citations: [
      {
        path: "src/policy.js",
        line: 1,
        quote: POLICY_SOURCE.trim(),
      },
    ],
  })}\n`;

  // Act
  const evaluated = fixture.runCommand(nextCommand, assessment);
  const replay = fixture.runCommand(nextCommand, assessment);

  // Assert
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.equal(evaluated.stdout, "");
  assert.equal(replay.status, 1, replay.stderr);
  assert.match(replay.stdout, /^BLOCKED publisher:alignment$/m);
});

test("when pending review and final blocked checks are mixed, failure-only retains both and final BLOCKED wins", async t => {
  // Arrange
  const fixture = await preparationFixture(t, {
    includeBlockedCheck: true,
  });

  // Act
  const result = fixture.run([
    "automatic", "src/policy.js", "src/obsolete.js",
    "--reporter", "text", "--failures-only",
  ]);

  // Assert
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^PENDING publisher:alignment$/m);
  assert.match(result.stdout, /^BLOCKED publisher:baseline$/m);
});

test("when an invalid retained range is replaced, recovery preserves earlier evidence and complete scope", async t => {
  // Arrange
  const source = [
    POLICY_SOURCE.trimEnd(),
    "export const validationRules = [",
    ...Array.from({ length: 250 }, (_, index) =>
      `  { id: "rule-${index}", minimum: 0, maximum: 10, domain: "threshold-validation" },`),
    "];",
    "",
  ].join("\n");
  const firstSelector = "src/policy.js#L1-L120";
  const invalidSelector = "src/policy.js#L121-L300";
  const correctedSelector = `src/policy.js#L121-L${source.split("\n").length}`;
  const standardPath = "plugins/node_modules/publisher/standard.md";
  const fixture = await preparationFixture(t, { policySource: source });
  const prepared = JSON.parse(fixture.run(["automatic", "src/policy.js", "src/obsolete.js"]).stdout)[0];
  const partial = JSON.parse(fixture.run([
    "review", prepared.reviewRequest.path, "--context", firstSelector, "--context", standardPath,
  ]).stdout)[0];
  const invalid = JSON.parse(fixture.run([
    "review", partial.reviewRequest.path, "--context", invalidSelector,
  ]).stdout)[0];

  // Act
  const correction = fixture.run([
    "review", invalid.reviewRequest.path,
    "--remove-context", invalidSelector, "--context", correctedSelector,
  ]);
  const recovered = JSON.parse(correction.stdout)[0];
  const evaluation = evaluateAssessment(fixture, recovered.reviewRequest.path,
    assessmentFor(recovered.reviewRequest.requestId), "json");
  const completed = JSON.parse(evaluation.stdout)[0];

  // Assert
  assert.ok(invalid.reviewRequest.context.missingChangedPaths.includes("src/policy.js"));
  assert.equal(correction.status, 0, correction.stderr);
  assert.notEqual(recovered.reviewRequest.requestId, invalid.reviewRequest.requestId);
  assert.deepEqual(recovered.reviewRequest.scope.changedPaths, ["src/obsolete.js", "src/policy.js"]);
  assert.deepEqual(recovered.reviewRequest.scope.contextPaths, [firstSelector, standardPath, correctedSelector]);
  assert.deepEqual(recovered.reviewRequest.context.missingChangedPaths, []);
  const coverage = recovered.reviewRequest.context.changedCodeCoverage.find(record => record.path === "src/policy.js");
  assert.equal(coverage.complete, true);
  const deletion = recovered.reviewRequest.context.changedCode.find(record => record.path === "src/obsolete.js");
  assert.equal(deletion.state, "deleted");
  assert.equal(deletion.content[1], "export const obsolete = true;");
  assert.equal(evaluation.status, 0, evaluation.stderr);
  assert.equal(completed.status, "PASS");
});

test("when removal names an unretained selector, the current request remains assessable", async t => {
  // Arrange
  const fixture = await preparationFixture(t);
  const prepared = JSON.parse(fixture.run(["automatic", "src/policy.js"]).stdout)[0];
  const request = prepared.reviewRequest;

  // Act
  const rejected = fixture.run(["review", request.path, "--remove-context", "src/policy.js#L99-L100"]);
  const completed = evaluateAssessment(fixture, request.path, assessmentFor(request.requestId), "json");

  // Assert
  assert.equal(rejected.status, 1, rejected.stderr);
  const failure = JSON.parse(rejected.stdout)[0];
  assert.equal(failure.status, "BLOCKED");
  assert.ok(failure.evidence.includes("src/policy.js#L99-L100"));
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout)[0].status, "PASS");
});

test("when a text review skips pages, evaluation remains pending until every missing page is delivered", async t => {
  // Arrange
  const fixture = await preparationFixture(t, {
    pagedReview: true,
  });
  const sourcePaths = ["src/policy.js", "src/obsolete.js", ...fixture.pagedSourcePaths];
  const prepared = fixture.run([
    "automatic", ...sourcePaths, "--reporter", "text", "--failures-only",
  ]);
  const firstPage = reviewPageDetails(prepared.stdout);
  const finalPage = fixture.run([
    "review", firstPage.requestPath, "--reporter", "text", "--page", String(firstPage.count - 1),
  ]);
  const skippedPages = Array.from({ length: firstPage.count - 2 }, (_, index) => index + 1);
  const assessment = assessmentFor(firstPage.requestId);

  // Act
  const jsonAttempt = evaluateAssessment(fixture, firstPage.requestPath, assessment, "json");
  const pending = JSON.parse(jsonAttempt.stdout)[0];
  const textAttempt = evaluateAssessment(fixture, firstPage.requestPath, assessment, "text");
  const recoveredPage = reviewPageDetails(textAttempt.stdout);
  for (const pageIndex of skippedPages.slice(1)) {
    fixture.run(["review", firstPage.requestPath, "--reporter", "text", "--page", String(pageIndex)]);
  }
  const completed = evaluateAssessment(fixture, firstPage.requestPath, assessment, "text");
  const replay = evaluateAssessment(fixture, firstPage.requestPath, assessment, "text");

  // Assert
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.ok(firstPage.count >= 3);
  assert.equal(finalPage.status, 0, finalPage.stderr);
  assert.equal(jsonAttempt.status, 0, jsonAttempt.stderr);
  assert.equal(pending.status, "PENDING");
  assert.equal(pending.reviewRequest.requestId, firstPage.requestId);
  assert.deepEqual(pending.reviewProgress.missingPages, skippedPages);
  assert.equal(textAttempt.status, 0, textAttempt.stderr);
  assert.equal(recoveredPage.requestId, firstPage.requestId);
  assert.equal(recoveredPage.index, skippedPages[0]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.match(completed.stdout, /^PASS publisher:alignment$/m);
  assert.equal(replay.status, 1, replay.stderr);
  assert.match(replay.stdout, /^BLOCKED publisher:alignment$/m);
});

test("when context renewal replaces a fully delivered review, the new request cannot reuse old page receipts", async t => {
  // Arrange
  const fixture = await preparationFixture(t, {
    pagedReview: true,
  });
  const sourcePaths = ["src/policy.js", "src/obsolete.js", ...fixture.pagedSourcePaths];
  const prepared = fixture.run([
    "automatic", ...sourcePaths, "--reporter", "text", "--failures-only",
  ]);
  const original = reviewPageDetails(prepared.stdout);
  for (let index = 1; index < original.count; index += 1) {
    fixture.run(["review", original.requestPath, "--reporter", "text", "--page", String(index)]);
  }

  // Act
  const contextRenewal = fixture.run([
    "review", original.requestPath,
    "--context", "plugins/node_modules/publisher/standard.md",
    "--reporter", "text",
  ]);
  const renewed = reviewPageDetails(contextRenewal.stdout);
  const lateRead = fixture.run([
    "review", original.requestPath, "--reporter", "text", "--page", String(original.count - 1),
  ]);
  const replacementPage = reviewPageDetails(lateRead.stdout);
  const assessment = evaluateAssessment(fixture, renewed.requestPath, assessmentFor(renewed.requestId), "json");
  const pending = JSON.parse(assessment.stdout)[0];

  // Assert
  assert.equal(contextRenewal.status, 0, contextRenewal.stderr);
  assert.notEqual(renewed.requestId, original.requestId);
  assert.equal(renewed.index, 0);
  assert.equal(lateRead.status, 0, lateRead.stderr);
  assert.equal(replacementPage.requestId, renewed.requestId);
  assert.equal(replacementPage.index, 0);
  assert.equal(assessment.status, 0, assessment.stderr);
  assert.equal(pending.status, "PENDING");
  assert.equal(pending.reviewRequest.requestId, renewed.requestId);
  assert.deepEqual(pending.reviewProgress.missingPages,
    Array.from({ length: renewed.count - 1 }, (_, index) => index + 1));
});
