import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildSemanticReviewPage } from "#root/omp-plugin/semantic-review-pages.js";

import {
  checkDeliveryHandoff,
  prepareDeliveryHandoff,
  recoverDeliveryHandoff,
  releaseDeliveryHandoff,
} from "#root/omp-plugin/delivery-handoff.js";

const CLI_PATH = fileURLToPath(new URL("../bin/omp-verifier.js", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TIP_SOURCE = "export function helper(value) { return value + 1; }\n";
const TIP_CALLER = 'import { helper } from "./helper.js";\nexport const result = helper(2);\n';
const CHANGED_PATHS = ["src/caller.js", "src/helper.js", "src/new name.js", "src/old name.js", "src/removed.js"];

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function deliveryFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-delivery-test-"));
  const handoffs = [];
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    for (const handoff of handoffs) await rm(dirname(handoff.handoffPath), { recursive: true, force: true });
  });

  const packageDirectory = join(root, "plugins");
  await mkdir(packageDirectory);
  const previousPackageDirectory = process.env.OMP_VERIFIER_PACKAGE_DIRECTORY;
  process.env.OMP_VERIFIER_PACKAGE_DIRECTORY = packageDirectory;
  t.after(() => {
    if (previousPackageDirectory === undefined) {
      delete process.env.OMP_VERIFIER_PACKAGE_DIRECTORY;
    } else {
      process.env.OMP_VERIFIER_PACKAGE_DIRECTORY = previousPackageDirectory;
    }
  });

  const primary = join(root, "primary");
  const source = join(root, "source");
  await mkdir(join(primary, "src"), { recursive: true });
  git(primary, "init", "--quiet", "--initial-branch=main");
  git(primary, "config", "user.email", "delivery-test@example.invalid");
  git(primary, "config", "user.name", "Delivery handoff test");
  await writeFile(join(primary, ".gitignore"), "node_modules/\n");
  await writeFile(join(primary, "src/helper.js"), "export function helper(value) { return value; }\n");
  await writeFile(join(primary, "src/caller.js"), 'import { helper } from "./helper.js";\nexport const result = helper(1);\n');
  await writeFile(join(primary, "src/removed.js"), "export const obsolete = true;\n");
  await writeFile(join(primary, "src/old name.js"), "export const renamed = true;\n");
  git(primary, "add", ".");
  git(primary, "commit", "--quiet", "-m", "baseline");
  const baseCommit = git(primary, "rev-parse", "HEAD");
  git(primary, "worktree", "add", "--quiet", "-b", "delivery", source);
  await writeFile(join(source, "src/helper.js"), TIP_SOURCE);
  await writeFile(join(source, "src/caller.js"), TIP_CALLER);
  await rm(join(source, "src/removed.js"));
  git(source, "mv", "src/old name.js", "src/new name.js");
  git(source, "add", ".");
  git(source, "commit", "--quiet", "-m", "deliver source and caller changes");
  const tipCommit = git(source, "rev-parse", "HEAD");
  return {
    root,
    primary,
    source,
    packageDirectory,
    baseCommit,
    tipCommit,
    handoffs,
  };
}

async function prepare(fixture) {
  const handoff = await prepareDeliveryHandoff({ cwd: fixture.source, baseRef: fixture.baseCommit });
  fixture.handoffs.push(handoff);
  return handoff;
}

function pin(handoff) {
  return `refs/omp-verifier/deliveries/${handoff.id}`;
}

async function installProvider(fixture, verification) {
  const provider = join(fixture.packageDirectory, "publisher");
  await mkdir(provider);
  await writeFile(join(provider, "package.json"), JSON.stringify({
    name: "publisher",
    version: "1.0.0",
    omp: {
      extensions: ["./index.js"],
      verifications: [verification],
    },
  }));
  return provider;
}

async function installIdentityProvider(fixture) {
  const provider = await installProvider(fixture, {
    id: "publisher:identity",
    label: "Helper identity",
    description: "Reviews that the helper returns its input unchanged.",
    mode: "agentic",
    contract: "./contract.json",
    pathTriggers: ["src/helper.js"],
  });
  await writeFile(join(provider, "standard.md"), "The helper must return its input unchanged.\n");
  await writeFile(join(provider, "contract.json"), JSON.stringify({
    version: 1,
    standardId: "publisher:identity",
    source: "./standard.md",
    gold: "The helper returns its input unchanged.",
    requiredContext: ["changed-code"],
    rubric: [
      {
        id: "identity",
        question: "Does the helper return its input unchanged?",
      },
    ],
  }));
}

async function registerDeliveryProviders(fixture, dependencies) {
  await writeFile(join(fixture.root, "package.json"), JSON.stringify({
    name: "omp-plugins",
    dependencies,
  }));
}

async function installProjectLint(fixture, hasLintViolation) {
  await symlink(REPOSITORY_ROOT, join(fixture.packageDirectory, "omp-verifier"), "dir");
  const bin = join(fixture.source, "node_modules", ".bin");
  await mkdir(bin, {
    recursive: true,
  });
  await symlink(join(REPOSITORY_ROOT, "node_modules", ".bin", "eslint"), join(bin, "eslint"));
  await writeFile(join(fixture.source, "eslint.config.mjs"), `
export default [{
  rules: {
    "no-unused-vars": "error",
  },
}];
`);
  if (hasLintViolation) {
    await writeFile(join(fixture.source, "src/caller.js"), `${TIP_CALLER}const unused = true;\n`);
  }

  git(fixture.source, "add", "eslint.config.mjs", "src/caller.js");
  git(fixture.source, "commit", "--quiet", "-m", "configure project lint");
  fixture.tipCommit = git(fixture.source, "rev-parse", "HEAD");
}

function invokeCli(fixture, cwd, ...args) {
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: join(fixture.root, "agent"),
    OMP_VERIFIER_PACKAGE_DIRECTORY: fixture.packageDirectory,
    OMP_VERIFIER_SEMANTIC_CACHE: join(fixture.root, "semantic-cache"),
  };
  delete env.OMP_VERIFIER_GENERATION;
  delete env.OMP_VERIFIER_RUNTIME_ROOT;
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: "utf8",
    env,
    timeout: 15_000,
  });
  assert.ifError(result.error);
  return result;
}

function runCli(fixture, cwd, expectedExit, ...args) {
  const result = invokeCli(fixture, cwd, ...args);
  assert.equal(result.status, expectedExit, `${args.join(" ")}\n${result.stderr || result.stdout}`);
  assert.equal(result.stderr, "");
  return result.stdout;
}

function assertCliReleaseBlocked(fixture, handoff) {
  const [blocked] = JSON.parse(runCli(fixture, fixture.root, 1, "handoff", "release", handoff.handoffPath));
  assert.equal(blocked.id, "verifier:delivery-handoff");
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(git(fixture.primary, "rev-parse", pin(handoff)), fixture.tipCommit);
  return blocked.evidence;
}

test("when the source worktree is removed and the primary is dirty, recovery restores the pinned source and complete deletion scope", async t => {
  // Arrange
  const fixture = await deliveryFixture(t);
  await mkdir(join(fixture.source, "node_modules"));
  await writeFile(join(fixture.source, "node_modules/ignored"), "do not copy\n");
  const handoff = await prepare(fixture);
  await rm(join(fixture.source, "node_modules"), { recursive: true });
  git(fixture.primary, "worktree", "remove", fixture.source);
  git(fixture.primary, "branch", "-D", "delivery");
  const competingSource = "uncommitted primary work\n";
  await writeFile(join(fixture.primary, "src/helper.js"), competingSource);
  const primaryStatus = git(fixture.primary, "status", "--porcelain");
  const hookDirectory = join(fixture.root, "hooks");
  const hookMarker = join(fixture.root, "hook-ran");
  await mkdir(hookDirectory);
  await writeFile(join(hookDirectory, "post-checkout"), `#!/bin/sh\nprintf 'ran' > '${hookMarker}'\n`);
  await chmod(join(hookDirectory, "post-checkout"), 0o755);
  git(fixture.primary, "config", "core.hooksPath", hookDirectory);

  // Act
  const recovered = await recoverDeliveryHandoff({ handoffPath: handoff.handoffPath });
  const repeated = await recoverDeliveryHandoff({ handoffPath: handoff.handoffPath });

  // Assert
  assert.equal(handoff.status, "PREPARED");
  assert.equal(recovered.status, "RECOVERED");
  assert.equal(repeated.checkoutPath, recovered.checkoutPath);
  assert.equal(recovered.originalRoot, fixture.source);
  assert.equal(recovered.baseCommit, fixture.baseCommit);
  assert.equal(recovered.tipCommit, fixture.tipCommit);
  assert.deepEqual([...recovered.changedPaths].sort(), CHANGED_PATHS);
  assert.equal(git(recovered.checkoutPath, "rev-parse", "HEAD"), fixture.tipCommit);
  assert.equal(git(recovered.checkoutPath, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
  assert.equal(await readFile(join(recovered.checkoutPath, "src/helper.js"), "utf8"), TIP_SOURCE);
  assert.equal(await readFile(join(recovered.checkoutPath, "src/caller.js"), "utf8"), TIP_CALLER);
  await assert.rejects(access(join(recovered.checkoutPath, "src/removed.js")), { code: "ENOENT" });
  await assert.rejects(access(join(recovered.checkoutPath, "src/old name.js")), { code: "ENOENT" });
  await assert.rejects(access(join(recovered.checkoutPath, "node_modules")), { code: "ENOENT" });
  await assert.rejects(access(hookMarker), { code: "ENOENT" });
  assert.equal(await readFile(join(fixture.primary, "src/helper.js"), "utf8"), competingSource);
  assert.equal(git(fixture.primary, "status", "--porcelain"), primaryStatus);
  assert.equal(git(fixture.primary, "rev-parse", pin(handoff)), fixture.tipCommit);
  assert.equal((await stat(dirname(handoff.handoffPath))).mode & 0o777, 0o700);
  assert.equal((await stat(handoff.handoffPath)).mode & 0o777, 0o600);
});

test("when no bound check has completed, release preserves both prepared and recovered source", async t => {
  // Arrange
  const fixture = await deliveryFixture(t);
  const handoff = await prepare(fixture);
  git(fixture.primary, "worktree", "remove", fixture.source);

  // Act / Assert
  assert.match(assertCliReleaseBlocked(fixture, handoff), /completed handoff check/);
  const recovered = await recoverDeliveryHandoff({
    handoffPath: handoff.handoffPath,
  });
  await assert.rejects(releaseDeliveryHandoff({
    handoffPath: handoff.handoffPath,
  }), /completed handoff check/);
  assert.equal(git(fixture.primary, "rev-parse", pin(handoff)), fixture.tipCommit);
  assert.equal(git(recovered.checkoutPath, "rev-parse", "HEAD"), fixture.tipCommit);
});

test("when a new bound check cannot validate its source, earlier release permission is revoked", async t => {
  // Arrange
  const fixture = await deliveryFixture(t);
  const handoff = await prepare(fixture);
  assert.deepEqual(await checkDeliveryHandoff({
    handoffPath: handoff.handoffPath,
  }), []);
  const helperPath = join(fixture.source, "src/helper.js");
  await writeFile(helperPath, "changes made after verification\n");

  // Act / Assert
  await assert.rejects(checkDeliveryHandoff({
    handoffPath: handoff.handoffPath,
  }), /dirty or untracked/);
  await writeFile(helperPath, TIP_SOURCE);
  assert.equal(git(fixture.source, "status", "--porcelain"), "");
  assert.match(assertCliReleaseBlocked(fixture, handoff), /completed handoff check/);
});

test("when a bound deterministic check is running, release preserves the checkout and its environment", async t => {
  // Arrange
  const fixture = await deliveryFixture(t);
  await mkdir(join(fixture.source, "node_modules"));
  await writeFile(join(fixture.source, "node_modules/ignored"), "retained runtime prerequisite\n");
  const handoff = await prepare(fixture);
  assert.deepEqual(await checkDeliveryHandoff({
    handoffPath: handoff.handoffPath,
  }), []);

  const socketPath = join(fixture.root, "check.sock");
  const server = createServer();
  const listening = once(server, "listening");
  server.listen(socketPath);
  t.after(() => server.close());
  await listening;

  const provider = await installProvider(fixture, {
    id: "publisher:runtime",
    label: "Delivery runtime",
    description: "Checks the retained checkout's runtime prerequisite.",
    entry: "./check.mjs",
    pathTriggers: ["src/*.js"],
  });
  await writeFile(join(provider, "check.mjs"), `
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";

const prerequisite = await readFile("node_modules/ignored", "utf8");
const changedPaths = JSON.parse(process.env.OMP_VERIFIER_CHANGED_PATHS);
const { baseCommit, headCommit } = JSON.parse(process.env.OMP_VERIFIER_PR_SCOPE);
const socket = createConnection(${JSON.stringify(socketPath)});
await once(socket, "end");
process.stdout.write(JSON.stringify({
  status: "PASS",
  summary: "The retained prerequisite is available.",
  evidence: JSON.stringify({
    prerequisite,
    changedPaths,
    baseCommit,
    headCommit,
    cwd: process.cwd(),
  }),
}));
`);

  // Act
  const selected = await recoverDeliveryHandoff({
    handoffPath: handoff.handoffPath,
  });
  const connected = once(server, "connection");
  const checking = checkDeliveryHandoff({
    handoffPath: handoff.handoffPath,
  });
  const [socket] = await Promise.race([
    connected,
    checking.then(results => assert.fail(`The check exited before reaching its barrier: ${JSON.stringify(results)}`)),
  ]);
  let results;
  try {
    assert.match(assertCliReleaseBlocked(fixture, handoff), /busy/i);
  } finally {
    socket.end();
    results = await checking;
  }
  const released = await releaseDeliveryHandoff({
    handoffPath: handoff.handoffPath,
  });

  // Assert
  assert.equal(selected.checkoutPath, fixture.source);
  assert.equal(selected.status, "PREPARED");
  assert.equal(selected.baseCommit, fixture.baseCommit);
  assert.equal(selected.tipCommit, fixture.tipCommit);
  assert.deepEqual(selected.changedPaths, CHANGED_PATHS);
  assert.ok(Array.isArray(results));
  assert.equal(results.length, 1);
  const [result] = results;
  assert.equal(result.id, "publisher:runtime");
  assert.equal(result.status, "PASS");
  assert.equal(result.summary, "The retained prerequisite is available.");
  const evidence = JSON.parse(result.evidence);
  assert.deepEqual(evidence, {
    prerequisite: "retained runtime prerequisite\n",
    changedPaths: CHANGED_PATHS,
    baseCommit: fixture.baseCommit,
    headCommit: fixture.tipCommit,
    cwd: fixture.source,
  });
  assert.equal(released.status, "RELEASED");
  assert.equal(await readFile(join(selected.checkoutPath, "node_modules/ignored"), "utf8"), "retained runtime prerequisite\n");
  assert.equal(await readFile(join(selected.checkoutPath, "src/helper.js"), "utf8"), TIP_SOURCE);
  await assert.rejects(access(handoff.checkoutPath), { code: "ENOENT" });
  assert.equal(git(fixture.primary, "for-each-ref", "--format=%(refname)", pin(handoff)), "");
});

test("when a semantic assessment is pending, the handoff stays available until a full recheck observes its verdict", async t => {
  // Arrange
  const fixture = await deliveryFixture(t);
  await installIdentityProvider(fixture);
  const handoff = await prepare(fixture);
  git(fixture.primary, "worktree", "remove", fixture.source);
  const { checkoutPath } = await recoverDeliveryHandoff({
    handoffPath: handoff.handoffPath,
  });
  const failureAssessment = requestId => JSON.stringify({
    requestId,
    status: "FAIL",
    summary: "The helper changes its input.",
    rationale: "The delivered helper adds one instead of returning the input unchanged.",
    citations: [
      {
        path: "src/helper.js",
        line: 1,
        quote: TIP_SOURCE.trimEnd(),
      },
    ],
    findings: [
      {
        path: "src/helper.js",
        line: 1,
        summary: "Remove the added one to preserve the input.",
      },
    ],
  });
  const [ordinaryReview] = JSON.parse(runCli(
    fixture,
    checkoutPath,
    0,
    "automatic",
    "--base",
    fixture.baseCommit,
    ...CHANGED_PATHS,
  ));
  assert.equal(ordinaryReview.status, "PENDING");
  const ordinaryPath = ordinaryReview.reviewRequest.path;
  const ordinaryPages = buildSemanticReviewPage(ordinaryReview).count;
  for (let page = 0; page < ordinaryPages; page += 1) {
    runCli(fixture, checkoutPath, 0, "review", ordinaryPath, "--reporter", "text", "--page", String(page));
  }
  const ordinaryAssessment = failureAssessment(ordinaryReview.reviewRequest.requestId);
  const [ordinaryFailure] = JSON.parse(runCli(fixture, checkoutPath, 1, "evaluate", ordinaryPath, "--assessment", ordinaryAssessment));
  assert.equal(ordinaryFailure.status, "FAIL", ordinaryFailure.evidence);

  // Act / Assert
  assert.match(assertCliReleaseBlocked(fixture, handoff), /completed handoff check/);
  const results = JSON.parse(runCli(fixture, fixture.root, 0, "handoff", "check", handoff.handoffPath));
  assert.ok(Array.isArray(results));
  assert.equal(results.length, 1);
  const [pending] = results;
  assert.equal(pending.id, "publisher:identity");
  assert.equal(pending.status, "PENDING");
  assert.notEqual(pending.reviewRequest.requestId, ordinaryReview.reviewRequest.requestId);
  assert.equal(pending.reviewRequest.scope.repositoryRoot, checkoutPath);
  assert.deepEqual(pending.reviewRequest.scope.changedPaths, ["src/helper.js"]);
  assert.match(assertCliReleaseBlocked(fixture, handoff), /pending assessments/);
  assert.equal(git(checkoutPath, "rev-parse", "HEAD"), fixture.tipCommit);

  const boundPath = pending.reviewRequest.path;
  const boundPages = buildSemanticReviewPage(pending).count;
  for (let page = 0; page < boundPages; page += 1) {
    runCli(fixture, checkoutPath, 0, "review", boundPath, "--reporter", "text", "--page", String(page));
  }
  const boundAssessment = failureAssessment(pending.reviewRequest.requestId);
  const [assessed] = JSON.parse(runCli(fixture, checkoutPath, 1, "evaluate", boundPath, "--assessment", boundAssessment));
  assert.equal(assessed.status, "FAIL", assessed.evidence);
  assert.match(assertCliReleaseBlocked(fixture, handoff), /pending assessments/);
  const [rechecked] = JSON.parse(runCli(fixture, fixture.root, 1, "handoff", "check", handoff.handoffPath));
  assert.equal(rechecked.id, "publisher:identity");
  assert.equal(rechecked.status, "FAIL");
  assert.equal(rechecked.evaluation.requestId, pending.reviewRequest.requestId);
  assert.equal(rechecked.evidence, assessed.evidence);
  const released = JSON.parse(runCli(fixture, fixture.root, 0, "handoff", "release", handoff.handoffPath));
  assert.equal(released.status, "RELEASED");
  await assert.rejects(access(checkoutPath), {
    code: "ENOENT",
  });
  assert.equal(git(fixture.primary, "for-each-ref", "--format=%(refname)", pin(handoff)), "");
});

for (const expectedLintStatus of ["PASS", "FAIL"]) {
  test(`when a pending handoff increases its lint budget, a fresh ${expectedLintStatus} supersedes only the timed-out lint result`, async t => {
    // Arrange
    const fixture = await deliveryFixture(t);
    await installIdentityProvider(fixture);
    await installProjectLint(fixture, expectedLintStatus === "FAIL");
    const providers = {
      publisher: "1.0.0",
      "omp-verifier": "*",
    };
    await registerDeliveryProviders(fixture, providers);
    const handoff = await prepare(fixture);
    const check = ["handoff", "check", handoff.handoffPath, "--lint-budget-ms"];

    // Act / Assert
    const constrained = JSON.parse(runCli(fixture, fixture.root, 1, ...check, "1"));
    assert.equal(constrained.length, 2);
    const timeout = constrained.find(result => result.id === "verifier:project-lint");
    assert.equal(timeout.status, "BLOCKED");
    assert.equal(timeout.lintBudgetExhaustedMs, 1);
    assert.match(timeout.summary, /Shared project lint budget of 1 ms expired/);
    assert.match(timeout.nextCheck, /handoff check.*--lint-budget-ms/);
    const pending = constrained.find(result => result.id === "publisher:identity");
    assert.equal(pending.status, "PENDING");
    const constrainedRecord = JSON.parse(await readFile(handoff.handoffPath, "utf8")).verification;
    assert.equal(constrainedRecord.status, "PENDING");
    assert.deepEqual(constrainedRecord.blockers, [timeout]);

    await registerDeliveryProviders(fixture, {
      publisher: "1.0.0",
    });
    const unavailable = JSON.parse(runCli(fixture, fixture.root, 1, ...check, "10000"));
    assert.deepEqual(unavailable.find(result => result.id === "verifier:project-lint"), timeout);

    await registerDeliveryProviders(fixture, providers);
    const recoveredExit = expectedLintStatus === "FAIL" ? 1 : 0;
    const recovered = JSON.parse(runCli(fixture, fixture.root, recoveredExit, ...check, "10000"));
    assert.equal(recovered.length, 2);
    const lint = recovered.find(result => result.id === "verifier:project-lint");
    assert.equal(lint.status, expectedLintStatus);
    assert.equal(lint.lintBudgetExhaustedMs, undefined);
    assert.match(lint.evidence, new RegExp(`javascript \\(\\.\\): ${expectedLintStatus}`));
    if (expectedLintStatus === "FAIL") {
      assert.match(lint.evidence, /no-unused-vars/);
    }

    const continued = recovered.find(result => result.id === "publisher:identity");
    assert.equal(continued.status, "PENDING");
    assert.equal(continued.reviewRequest.requestId, pending.reviewRequest.requestId);
    const recoveredRecord = JSON.parse(await readFile(handoff.handoffPath, "utf8")).verification;
    assert.equal(recoveredRecord.status, "PENDING");
    const expectedBlockers = expectedLintStatus === "FAIL" ? [lint] : [];
    assert.deepEqual(recoveredRecord.blockers, expectedBlockers);
    assert.match(assertCliReleaseBlocked(fixture, handoff), /pending assessments/);

    if (expectedLintStatus === "PASS") {
      const defaultBudget = JSON.parse(runCli(fixture, fixture.root, 0, "handoff", "check", handoff.handoffPath));
      assert.equal(defaultBudget.find(result => result.id === "verifier:project-lint").status, "PASS");
    } else {
      await registerDeliveryProviders(fixture, {
        publisher: "1.0.0",
      });
      const higherWithoutLint = JSON.parse(runCli(fixture, fixture.root, 1, ...check, "20000"));
      assert.deepEqual(higherWithoutLint.find(result => result.id === "verifier:project-lint"), lint);
    }
  });
}

test("when a handoff lint budget is invalid, the CLI leaves the handoff unchanged", async t => {
  // Arrange
  const fixture = await deliveryFixture(t);
  const handoff = await prepare(fixture);
  const preparedRecord = await readFile(handoff.handoffPath, "utf8");
  const check = ["handoff", "check", handoff.handoffPath, "--lint-budget-ms"];

  // Act / Assert
  for (const budget of [[], ["0"], ["600001"], ["-1"], ["1.5"], ["invalid"]]) {
    const result = invokeCli(fixture, fixture.root, ...check, ...budget);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /--lint-budget-ms/);
  }
  assert.equal(await readFile(handoff.handoffPath, "utf8"), preparedRecord);
});

test("when a deleted path requires a missing provider, the check reports terminal BLOCKED before release", async t => {
  // Arrange
  const fixture = await deliveryFixture(t);
  await writeFile(join(fixture.source, ".omp-verifier.json"), JSON.stringify({
    requirements: [
      {
        id: "publisher:deletion-review",
        path: "src/removed.js",
      },
    ],
  }));
  git(fixture.source, "add", ".omp-verifier.json");
  git(fixture.source, "commit", "--quiet", "-m", "require a check for removed source");
  fixture.tipCommit = git(fixture.source, "rev-parse", "HEAD");
  const handoff = await prepare(fixture);

  // Act / Assert
  const results = JSON.parse(runCli(fixture, fixture.root, 1, "handoff", "check", handoff.handoffPath));
  assert.deepEqual(results, [
    {
      id: "publisher:deletion-review",
      status: "BLOCKED",
      summary: "Required verification provider is not installed",
      evidence: "Declared requirement applies to src/removed.js; no installed manifest provides publisher:deletion-review.",
      matches: [
        {
          path: "src/removed.js",
          trigger: "src/removed.js",
        },
      ],
    },
  ]);
  const released = JSON.parse(runCli(fixture, fixture.root, 0, "handoff", "release", handoff.handoffPath));
  assert.equal(released.status, "RELEASED");
  assert.equal(git(fixture.source, "rev-parse", "HEAD"), fixture.tipCommit);
  assert.equal(git(fixture.primary, "for-each-ref", "--format=%(refname)", pin(handoff)), "");
});

test("when the original is the primary checkout, recovery accepts its attached delivered tip", async t => {
  // Arrange
  const fixture = await deliveryFixture(t);
  git(fixture.primary, "merge", "--ff-only", "delivery");
  fixture.source = fixture.primary;
  const handoff = await prepare(fixture);

  // Act
  const selected = await recoverDeliveryHandoff({ handoffPath: handoff.handoffPath });

  // Assert
  assert.equal(selected.checkoutPath, fixture.primary);
  assert.equal(git(selected.checkoutPath, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(selected.tipCommit, fixture.tipCommit);
  await assert.rejects(access(handoff.checkoutPath), { code: "ENOENT" });
});

for (const state of ["tracked", "staged", "untracked", "moved tip", "foreign repository"]) {
  test(`when the retained checkout has ${state}, recovery refuses instead of substituting detached source`, async t => {
    // Arrange
    const fixture = await deliveryFixture(t);
    const handoff = await prepare(fixture);
    if (state === "moved tip") {
      git(fixture.source, "checkout", "--detach", fixture.baseCommit);
    } else if (state === "foreign repository") {
      git(fixture.primary, "worktree", "remove", fixture.source);
      git(fixture.primary, "clone", "--quiet", fixture.primary, fixture.source);
      git(fixture.source, "checkout", "--detach", fixture.tipCommit);
    } else {
      const path = state === "untracked" ? "src/untracked.js" : "src/helper.js";
      await writeFile(join(fixture.source, path), "preserve later work\n");
      if (state === "staged") git(fixture.source, "add", path);
    }
    const before = git(fixture.source, "status", "--porcelain");
    const head = git(fixture.source, "rev-parse", "HEAD");

    // Act / Assert
    await assert.rejects(recoverDeliveryHandoff({ handoffPath: handoff.handoffPath }), /dirty or untracked|changed repository or tip/);
    assert.equal(git(fixture.source, "status", "--porcelain"), before);
    assert.equal(git(fixture.source, "rev-parse", "HEAD"), head);
    await assert.rejects(access(handoff.checkoutPath), { code: "ENOENT" });
    assert.equal(git(fixture.primary, "rev-parse", pin(handoff)), fixture.tipCommit);
  });
}

for (const state of ["tracked", "staged", "untracked"]) {
  test(`when the source has ${state} changes, preparation refuses without altering the source`, async t => {
    // Arrange
    const fixture = await deliveryFixture(t);
    const path = state === "untracked" ? "src/untracked.js" : "src/helper.js";
    await writeFile(join(fixture.source, path), "preserve this work\n");
    if (state === "staged") git(fixture.source, "add", path);
    const before = git(fixture.source, "status", "--porcelain");

    // Act / Assert
    await assert.rejects(prepare(fixture));
    assert.equal(git(fixture.source, "status", "--porcelain"), before);
    assert.equal(await readFile(join(fixture.source, path), "utf8"), "preserve this work\n");
    assert.equal(git(fixture.primary, "for-each-ref", "--format=%(refname)", "refs/omp-verifier/deliveries/"), "");
  });
}

test("when the base is missing or unrelated, preparation refuses to create a pin", async t => {
  // Arrange
  const fixture = await deliveryFixture(t);
  const unrelated = git(fixture.source, "commit-tree", `${fixture.baseCommit}^{tree}`, "-m", "unrelated root");

  // Act / Assert
  for (const baseRef of ["refs/heads/missing-base", unrelated]) {
    await assert.rejects(prepareDeliveryHandoff({ cwd: fixture.source, baseRef }));
  }
  assert.equal(git(fixture.primary, "for-each-ref", "--format=%(refname)", "refs/omp-verifier/deliveries/"), "");
  assert.equal(git(fixture.source, "rev-parse", "HEAD"), fixture.tipCommit);
});

for (const state of ["tracked", "untracked"]) {
  test(`when the recovered checkout has ${state} changes, recovery and release preserve it and refuse`, async t => {
    // Arrange
    const fixture = await deliveryFixture(t);
    const handoff = await prepare(fixture);
    git(fixture.primary, "worktree", "remove", fixture.source);
    const recovered = await recoverDeliveryHandoff({ handoffPath: handoff.handoffPath });
    assert.deepEqual(await checkDeliveryHandoff({
      handoffPath: handoff.handoffPath,
    }), []);
    const path = state === "tracked" ? "src/helper.js" : "src/untracked.js";
    await writeFile(join(recovered.checkoutPath, path), "private review work\n");
    const before = git(recovered.checkoutPath, "status", "--porcelain");

    // Act / Assert
    await assert.rejects(recoverDeliveryHandoff({ handoffPath: handoff.handoffPath }));
    await assert.rejects(releaseDeliveryHandoff({
      handoffPath: handoff.handoffPath,
    }), /dirty or untracked/);
    await assert.rejects(releaseDeliveryHandoff({ handoffPath: handoff.handoffPath, cancellationReason: "stop review" }));
    assert.equal(await readFile(join(recovered.checkoutPath, path), "utf8"), "private review work\n");
    assert.equal(git(recovered.checkoutPath, "status", "--porcelain"), before);
    assert.equal(git(fixture.primary, "rev-parse", pin(handoff)), fixture.tipCommit);
    assert.equal(JSON.parse(await readFile(handoff.handoffPath, "utf8")).status === "RELEASED", false);
  });
}

test("when the pin is changed, recovery and release refuse without deleting the competing pin", async t => {
  // Arrange
  const fixture = await deliveryFixture(t);
  const handoff = await prepare(fixture);
  assert.deepEqual(await checkDeliveryHandoff({
    handoffPath: handoff.handoffPath,
  }), []);
  git(fixture.primary, "update-ref", pin(handoff), fixture.baseCommit, fixture.tipCommit);

  // Act / Assert
  await assert.rejects(recoverDeliveryHandoff({ handoffPath: handoff.handoffPath }));
  await assert.rejects(releaseDeliveryHandoff({ handoffPath: handoff.handoffPath }));
  assert.equal(git(fixture.primary, "rev-parse", pin(handoff)), fixture.baseCommit);
  assert.equal(git(fixture.source, "rev-parse", "HEAD"), fixture.tipCommit);
  await access(handoff.handoffPath);
});

test("when a record changes its committed path scope, recovery and release reject the tampered identity", async t => {
  // Arrange
  const fixture = await deliveryFixture(t);
  const handoff = await prepare(fixture);
  assert.deepEqual(await checkDeliveryHandoff({
    handoffPath: handoff.handoffPath,
  }), []);
  const record = JSON.parse(await readFile(handoff.handoffPath, "utf8"));
  record.changedPaths = ["src/helper.js"];
  await writeFile(handoff.handoffPath, JSON.stringify(record));

  // Act / Assert
  await assert.rejects(recoverDeliveryHandoff({ handoffPath: handoff.handoffPath }));
  await assert.rejects(releaseDeliveryHandoff({ handoffPath: handoff.handoffPath }));
  assert.equal(git(fixture.primary, "rev-parse", pin(handoff)), fixture.tipCommit);
  assert.equal(git(fixture.source, "status", "--porcelain"), "");
});

test("when a valid record is copied outside its owned location, neither recovery nor release accepts it", async t => {
  // Arrange
  const fixture = await deliveryFixture(t);
  const handoff = await prepare(fixture);
  assert.deepEqual(await checkDeliveryHandoff({
    handoffPath: handoff.handoffPath,
  }), []);
  const copiedPath = join(fixture.root, "copied-handoff.json");
  await copyFile(handoff.handoffPath, copiedPath);

  // Act / Assert
  await assert.rejects(recoverDeliveryHandoff({ handoffPath: copiedPath }));
  await assert.rejects(releaseDeliveryHandoff({ handoffPath: copiedPath }));
  const recovered = await recoverDeliveryHandoff({ handoffPath: handoff.handoffPath });
  assert.equal(recovered.checkoutPath, fixture.source);
  assert.equal(git(fixture.primary, "rev-parse", pin(handoff)), fixture.tipCommit);
});

test("when the shared Git database is replaced at the same path, matching commits cannot authorize recovery or release", async t => {
  // Arrange
  const fixture = await deliveryFixture(t);
  const handoff = await prepare(fixture);
  assert.deepEqual(await checkDeliveryHandoff({
    handoffPath: handoff.handoffPath,
  }), []);
  const originalDatabase = join(fixture.root, "original-git");
  await rename(join(fixture.primary, ".git"), originalDatabase);
  await cp(originalDatabase, join(fixture.primary, ".git"), { recursive: true });

  // Act / Assert
  await assert.rejects(recoverDeliveryHandoff({ handoffPath: handoff.handoffPath }));
  await assert.rejects(releaseDeliveryHandoff({ handoffPath: handoff.handoffPath }));
  assert.equal(git(fixture.primary, "rev-parse", pin(handoff)), fixture.tipCommit);
  assert.equal(git(fixture.primary, "rev-parse", "HEAD"), fixture.baseCommit);
  await access(handoff.handoffPath);
});

for (const cancellationReason of [undefined, "Maintainer explicitly cancelled the unreviewed delivery"]) {
  const status = cancellationReason ? "CANCELLED" : "RELEASED";
  test(`when a clean recovery is ${status.toLowerCase()}, only owned resources are removed and a nonverdict receipt remains`, async t => {
    // Arrange
    const fixture = await deliveryFixture(t);
    const handoff = await prepare(fixture);
    git(fixture.primary, "worktree", "remove", fixture.source);
    const recovered = await recoverDeliveryHandoff({ handoffPath: handoff.handoffPath });
    if (cancellationReason === undefined) {
      assert.deepEqual(await checkDeliveryHandoff({
        handoffPath: handoff.handoffPath,
      }), []);
    }

    git(fixture.primary, "worktree", "add", "--quiet", fixture.source, "delivery");
    await writeFile(join(fixture.source, "src/helper.js"), "source edits after handoff\n");
    await writeFile(join(fixture.primary, "src/helper.js"), "competing primary edits\n");
    const branches = git(fixture.primary, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads/");

    // Act
    const released = await releaseDeliveryHandoff({ handoffPath: handoff.handoffPath, cancellationReason });

    // Assert
    assert.equal(released.status, status);
    const receipt = JSON.parse(await readFile(handoff.handoffPath, "utf8"));
    assert.equal(receipt.status, status);
    if (cancellationReason) assert.equal(receipt.cancellationReason, cancellationReason);
    await assert.rejects(access(recovered.checkoutPath), { code: "ENOENT" });
    assert.equal(git(fixture.primary, "for-each-ref", "--format=%(refname)", pin(handoff)), "");
    assert.equal(git(fixture.primary, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads/"), branches);
    assert.equal(await readFile(join(fixture.source, "src/helper.js"), "utf8"), "source edits after handoff\n");
    assert.equal(await readFile(join(fixture.primary, "src/helper.js"), "utf8"), "competing primary edits\n");
    await assert.rejects(recoverDeliveryHandoff({ handoffPath: handoff.handoffPath }));
  });
}

test("when cancellation is requested before recovery, an explicit reason is required and the unreviewed handoff becomes unusable", async t => {
  // Arrange
  const fixture = await deliveryFixture(t);
  const handoff = await prepare(fixture);

  // Act / Assert
  await assert.rejects(releaseDeliveryHandoff({ handoffPath: handoff.handoffPath, cancellationReason: "   " }));
  assert.equal(git(fixture.primary, "rev-parse", pin(handoff)), fixture.tipCommit);
  const cancelled = JSON.parse(runCli(
    fixture,
    fixture.root,
    0,
    "handoff",
    "cancel",
    handoff.handoffPath,
    "--reason",
    "delivery abandoned",
  ));
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(cancelled.cancellationReason, "delivery abandoned");
  await assert.rejects(checkDeliveryHandoff({
    handoffPath: handoff.handoffPath,
  }));
  await assert.rejects(releaseDeliveryHandoff({
    handoffPath: handoff.handoffPath,
  }));
  await assert.rejects(recoverDeliveryHandoff({ handoffPath: handoff.handoffPath }));
  assert.equal(git(fixture.source, "rev-parse", "HEAD"), fixture.tipCommit);
  assert.equal(git(fixture.source, "status", "--porcelain"), "");
  assert.equal(git(fixture.primary, "for-each-ref", "--format=%(refname)", pin(handoff)), "");
});
