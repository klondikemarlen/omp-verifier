import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const CLI = join(process.cwd(), "bin", "omp-verifier.js");
const TEST_SOURCE = 'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("when a policy is disabled, excludes it from enabled events", () => { assert.deepEqual([{ enabled: false }].filter(policy => policy.enabled), []); });\n';

async function createCallerFixture() {
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-callers-"));
  const provider = join(root, "plugins", "node_modules", "publisher");
  await mkdir(provider, { recursive: true });
  await mkdir(join(root, "tests"));
  await mkdir(join(root, "noise"));
  await writeFile(join(root, "tests", "policy.test.js"), TEST_SOURCE);
  await writeFile(join(root, "package.json"), '{\n  "scripts": { "test": "node --test tests/*.test.js" }\n}\n');
  await writeFile(join(root, "README.md"), "Tests own observable policy scenarios; the Node runner discovers entrypoints.\n");
  await writeFile(join(provider, "standard.md"), "Each changed test owns an observable policy scenario.\n");
  await writeFile(join(provider, "contract.json"), JSON.stringify({
    version: 1,
    standardId: "publisher:alignment",
    source: "./standard.md",
    gold: "Changed tests own observable policy scenarios.",
    requiredContext: ["changed-code", "callers", "siblings", "project-guidance"],
    rubric: [{ id: "ownership", question: "Does the test own an observable scenario?" }],
  }));
  await writeFile(join(provider, "package.json"), JSON.stringify({
    name: "publisher",
    version: "1.0.0",
    omp: {
      extensions: ["./index.js"],
      verifications: [{
        id: "publisher:alignment",
        label: "Policy Scenario Alignment",
        description: "Assesses changed tests and their runtime entrypoints.",
        mode: "agentic",
        contract: "./contract.json",
        pathTriggers: ["**/*.test.js"],
      }],
    },
  }));
  for (let index = 0; index < 1_205; index += 1) {
    await writeFile(join(root, "noise", `${index}.js`), "export const noise = true;\n");
  }
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Verifier Tests", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "baseline"], { cwd: root });
  return { root };
}

function cli(fixture, ...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: fixture.root,
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: join(fixture.root, "agent") },
    maxBuffer: 4_000_000,
  });
  assert.ok(result.status === 0 || result.status === 1 || result.status === 3, result.stderr);
  return JSON.parse(result.stdout)[0];
}

function assessment(requestId, additionalCitations = []) {
  return JSON.stringify({
    requestId,
    status: "PASS",
    summary: "The changed test is a runner-discovered policy scenario.",
    rationale: "The captured caller or runner source explains how this observable policy scenario is executed.",
    citations: [
      { path: "tests/policy.test.js", line: 3, quote: TEST_SOURCE.split("\n")[2] },
      ...additionalCitations,
    ],
  });
}

test("when a runner discovers tests without filename references, explicit runtime caller context permits source-cited assessment", async () => {
  // Arrange
  const fixture = await createCallerFixture();

  try {
    const prepared = cli(fixture, "automatic", "tests/policy.test.js");

    // Act
    const recovered = cli(fixture, "review", prepared.reviewRequest.path, "--caller-context", "package.json");
    const completed = cli(fixture, "evaluate", recovered.reviewRequest.path, "--assessment", assessment(recovered.reviewRequest.requestId, [
      { path: "package.json", line: 2, quote: '  "scripts": { "test": "node --test tests/*.test.js" }' },
    ]));

    // Assert
    assert.notEqual(recovered.reviewRequest.requestId, prepared.reviewRequest.requestId);
    assert.equal(recovered.reviewRequest.context.sourceInventory.complete, false);
    assert.deepEqual(recovered.reviewRequest.missingContext, []);
    const runner = recovered.reviewRequest.context.targetedContext.find(record => record.path === "package.json");
    assert.equal(runner.source, "caller-context");
    assert.equal(runner.content["2"], '  "scripts": { "test": "node --test tests/*.test.js" }');
    assert.equal(completed.status, "PASS");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when a real caller is outside the inventory, missing evidence remains BLOCKED until that caller is recovered", async () => {
  // Arrange
  const fixture = await createCallerFixture();

  try {
    await mkdir(join(fixture.root, "zz"));
    await writeFile(join(fixture.root, "zz", "material.js"), 'import "../tests/policy.test.js";\n');
    const prepared = cli(fixture, "automatic", "tests/policy.test.js");

    // Act
    const premature = cli(fixture, "evaluate", prepared.reviewRequest.path, "--assessment", assessment(prepared.reviewRequest.requestId));
    const recovered = cli(fixture, "review", prepared.reviewRequest.path, "--context", "zz/material.js");
    const completed = cli(fixture, "evaluate", recovered.reviewRequest.path, "--assessment", assessment(recovered.reviewRequest.requestId));

    // Assert
    assert.equal(premature.status, "BLOCKED");
    assert.ok(prepared.reviewRequest.context.callerRetrieval.omittedPathExamples.includes("zz/material.js"));
    assert.deepEqual(recovered.reviewRequest.missingContext, []);
    assert.equal(completed.status, "PASS");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when requested runtime caller source is unavailable, an entrypoint claim cannot clear the context gap", async () => {
  // Arrange
  const fixture = await createCallerFixture();

  try {
    const prepared = cli(fixture, "automatic", "tests/policy.test.js");

    // Act
    const recovered = cli(fixture, "review", prepared.reviewRequest.path, "--caller-context", "missing.config.js");
    const completed = cli(fixture, "evaluate", recovered.reviewRequest.path, "--assessment", assessment(recovered.reviewRequest.requestId));

    // Assert
    assert.deepEqual(recovered.reviewRequest.context.missingContextPaths, ["missing.config.js"]);
    assert.equal(completed.status, "BLOCKED");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when relied-on runner configuration changes, its earlier source-cited assessment is stale", async () => {
  // Arrange
  const fixture = await createCallerFixture();

  try {
    const prepared = cli(fixture, "automatic", "tests/policy.test.js");
    const recovered = cli(fixture, "review", prepared.reviewRequest.path, "--caller-context", "package.json");
    await writeFile(join(fixture.root, "package.json"), '{"scripts":{"test":"node --test other/*.test.js"}}\n');

    // Act
    const completed = cli(fixture, "evaluate", recovered.reviewRequest.path, "--assessment", assessment(recovered.reviewRequest.requestId));

    // Assert
    assert.equal(completed.status, "BLOCKED");
    assert.match(completed.evidence, /source or project context changed/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when a runtime-entrypoint claim omits its runner citation, the assessment remains BLOCKED", async () => {
  // Arrange
  const fixture = await createCallerFixture();

  try {
    const prepared = cli(fixture, "automatic", "tests/policy.test.js");
    const recovered = cli(fixture, "review", prepared.reviewRequest.path, "--caller-context", "package.json");

    // Act
    const completed = cli(fixture, "evaluate", recovered.reviewRequest.path, "--assessment", assessment(recovered.reviewRequest.requestId));

    // Assert
    assert.equal(completed.status, "BLOCKED");
    assert.match(completed.evidence, /must cite its captured caller or runtime source/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when a later review page requests new caller context, the original request remains current", async () => {
  // Arrange
  const fixture = await createCallerFixture();
  const prepared = cli(fixture, "automatic", "tests/policy.test.js");

  try {
    // Act
    const rejected = spawnSync(process.execPath, [
      CLI,
      "review",
      prepared.reviewRequest.path,
      "--reporter",
      "text",
      "--page",
      "1",
      "--caller-context",
      "package.json",
    ], {
      cwd: fixture.root,
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: join(fixture.root, "agent") },
    });
    const current = cli(fixture, "review", prepared.reviewRequest.path);

    // Assert
    assert.equal(rejected.status, 2);
    assert.equal(current.reviewRequest.requestId, prepared.reviewRequest.requestId);
    assert.deepEqual(current.reviewRequest.scope.callerContextPaths, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
