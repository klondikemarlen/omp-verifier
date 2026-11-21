import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../bin/omp-verifier.js", import.meta.url));
const handoffModule = import.meta.resolve("#root/omp-plugin/closeout-handoff.js");
const prepareHandoffScript = `
import { prepareCloseoutHandoff } from ${JSON.stringify(handoffModule)};
const [repositoryRoot, ...receiptPaths] = process.argv.slice(1);
const id = await prepareCloseoutHandoff({
  repositoryRoot,
  receiptPaths,
});
process.stdout.write(id);
`;

async function closeoutFixture(context) {
  const temporaryDirectory = await realpath(tmpdir());
  const root = await mkdtemp(join(temporaryDirectory, "verifier-closeout-handoff-"));
  context.after(() => rm(root, {
    recursive: true,
    force: true,
  }));
  const repositoryRoot = join(root, "repository");
  const unrelatedDirectory = join(root, "unrelated");
  const storageRoot = join(root, "tmp");
  await mkdir(repositoryRoot);
  await mkdir(unrelatedDirectory);
  await mkdir(storageRoot, {
    mode: 0o700,
  });
  const env = {
    PATH: process.env.PATH,
    TMPDIR: storageRoot,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  execFileSync("git", ["init", "--quiet", repositoryRoot], {
    env,
  });

  async function prepareRetainedPath(id) {
    const path = join(root, id);
    await writeFile(path, "Preserved configuration\n");
    const declarationPath = join(root, `${id}.json`);
    const declaration = {
      version: 1,
      taskId: "retain-configurations",
      repositoryRoot,
      authorization: "Observe only isolated test resources",
      resources: [
        {
          id,
          kind: "path",
          path,
          disposition: "retained",
          ownership: "protected",
          ownershipEvidence: "Created by the isolated test fixture",
          reason: "Keep the protected configuration",
        },
      ],
    };
    await writeFile(declarationPath, JSON.stringify(declaration));
    const output = execFileSync(process.execPath, [cli, "closeout", "prepare", declarationPath], {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
    });
    const { receiptPath } = JSON.parse(output);
    return {
      path,
      receiptPath,
    };
  }

  function prepareHandoff(...receiptPaths) {
    return execFileSync(process.execPath, ["--input-type=module", "-e", prepareHandoffScript, repositoryRoot, ...receiptPaths], {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
    });
  }

  function review(id) {
    return spawnSync(process.execPath, [cli, "closeout", "review", id], {
      cwd: unrelatedDirectory,
      env,
      encoding: "utf8",
    });
  }

  return {
    prepareRetainedPath,
    prepareHandoff,
    review,
  };
}

function resourceOutcomes(review) {
  return JSON.parse(review.stdout).map(result => ({
    id: result.id,
    status: result.status,
    resources: result.dispositions.map(disposition => disposition.id),
  }));
}

test("when another handoff contains similar receipts, review uses only the named handoff in its original receipt order", async context => {
  // Arrange
  const fixture = await closeoutFixture(context);
  const first = await fixture.prepareRetainedPath("saved-config-a");
  const second = await fixture.prepareRetainedPath("saved-config-b");
  const third = await fixture.prepareRetainedPath("saved-config-c");

  // Act
  const id = fixture.prepareHandoff(second.receiptPath, first.receiptPath, second.receiptPath);
  const deduplicatedId = fixture.prepareHandoff(second.receiptPath, first.receiptPath);
  const reversedId = fixture.prepareHandoff(first.receiptPath, second.receiptPath);
  const otherId = fixture.prepareHandoff(third.receiptPath, first.receiptPath);
  const review = fixture.review(id);

  // Assert
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(id, deduplicatedId);
  assert.notEqual(id, reversedId);
  assert.notEqual(id, otherId);
  assert.equal(review.status, 0, review.stderr);
  assert.deepEqual(resourceOutcomes(review), [
    {
      id: "verifier:resource-closeout",
      status: "PASS",
      resources: ["saved-config-b"],
    },
    {
      id: "verifier:resource-closeout",
      status: "PASS",
      resources: ["saved-config-a"],
    },
  ]);
});

test("when retained resources change or disappear after a passing review, the same handoff freshly checks every receipt", async context => {
  // Arrange
  const fixture = await closeoutFixture(context);
  const changed = await fixture.prepareRetainedPath("saved-config-a");
  const missing = await fixture.prepareRetainedPath("saved-config-b");
  const untouched = await fixture.prepareRetainedPath("saved-config-c");
  const id = fixture.prepareHandoff(changed.receiptPath, missing.receiptPath, untouched.receiptPath);
  const originalReview = fixture.review(id);
  assert.equal(originalReview.status, 0, originalReview.stderr);

  // Act
  await writeFile(changed.path, "Modified configuration\n");
  await rm(missing.path);
  const review = fixture.review(id);

  // Assert
  assert.equal(review.status, 1, review.stderr);
  assert.deepEqual(resourceOutcomes(review), [
    {
      id: "verifier:resource-closeout",
      status: "FAIL",
      resources: ["saved-config-a"],
    },
    {
      id: "verifier:resource-closeout",
      status: "FAIL",
      resources: ["saved-config-b"],
    },
    {
      id: "verifier:resource-closeout",
      status: "PASS",
      resources: ["saved-config-c"],
    },
  ]);
});

test("when a handoff ID is mistyped or replaced with a receipt path, review blocks lookup without judging any resource", async context => {
  // Arrange
  const fixture = await closeoutFixture(context);
  const retained = await fixture.prepareRetainedPath("saved-config-a");
  const id = fixture.prepareHandoff(retained.receiptPath);
  const wrongFirstDigit = id.startsWith("0") ? "1" : "0";
  const mistypedId = `${wrongFirstDigit}${id.slice(1)}`;

  // Act
  const mistypedReview = fixture.review(mistypedId);
  const receiptPathReview = fixture.review(retained.receiptPath);
  const originalReview = fixture.review(id);

  // Assert
  for (const review of [mistypedReview, receiptPathReview]) {
    assert.equal(review.status, 1, review.stderr);
    const results = JSON.parse(review.stdout);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "verifier:closeout-handoff");
    assert.equal(results[0].status, "BLOCKED");
    assert.equal(results[0].dispositions, undefined);
  }
  assert.equal(originalReview.status, 0, originalReview.stderr);
  assert.deepEqual(resourceOutcomes(originalReview), [
    {
      id: "verifier:resource-closeout",
      status: "PASS",
      resources: ["saved-config-a"],
    },
  ]);
});

test("when a declared receipt is lost, review reports a resource blocker rather than a handoff error", async context => {
  const fixture = await closeoutFixture(context);
  const retained = await fixture.prepareRetainedPath("saved-config");
  const id = fixture.prepareHandoff(retained.receiptPath);
  await rm(retained.receiptPath);

  const review = fixture.review(id);

  assert.equal(review.status, 1, review.stderr);
  const [result] = JSON.parse(review.stdout);
  assert.equal(result.id, "verifier:resource-closeout");
  assert.equal(result.status, "BLOCKED");
});
