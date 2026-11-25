import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, readFile, rm, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { prepareResourceCloseout, verifyResourceCloseout } from "#root/omp-plugin/resource-closeout.js";

const cli = fileURLToPath(new URL("../bin/omp-verifier.js", import.meta.url));
const defaultContentLimit = 64 * 1024 ** 2;

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "verifier-closeout-"));
  const repositoryRoot = join(root, "repository");
  await mkdir(repositoryRoot);
  execFileSync("git", ["init", "--quiet", repositoryRoot]);
  const receipts = [];
  context.after(async () => {
    for (const path of receipts) {
      await rm(path, {
        force: true,
      });
    }
    await rm(root, {
      recursive: true,
      force: true,
    });
  });
  async function prepare(resources) {
    const declarationPath = join(root, "declaration.json");
    const declaration = {
      version: 1,
      taskId: "isolated-closeout",
      repositoryRoot,
      authorization: "Dispose only the isolated test resources",
      resources,
    };
    await writeFile(declarationPath, JSON.stringify(declaration));
    const result = await prepareResourceCloseout({
      cwd: repositoryRoot,
      declarationPath,
    });
    if (result.receiptPath) receipts.push(result.receiptPath);
    return result;
  }
  async function verify(receiptPath) {
    return verifyResourceCloseout({
      cwd: repositoryRoot,
      receiptPath,
    });
  }
  return {
    root,
    repositoryRoot,
    prepare,
    verify,
  };
}

function resource(path, overrides = {}) {
  return {
    id: "temporary-environment",
    kind: "path",
    path,
    disposition: "absent",
    ownership: "task",
    ownershipEvidence: "Created in this isolated fixture",
    reason: "Task is complete",
    ...overrides,
  };
}

test("when a disposable path remains or reappears, every closeout observes the current failure", async context => {
  // Arrange
  const current = await fixture(context);
  const path = join(current.root, ".env");
  await writeFile(path, "secret-value\n");
  const disposableEnvironment = resource(path);
  const prepared = await current.prepare([disposableEnvironment]);

  // Act
  const leftover = await current.verify(prepared.receiptPath);
  await rm(path);
  const removed = await current.verify(prepared.receiptPath);
  await writeFile(path, "reappeared\n");
  const reappeared = await current.verify(prepared.receiptPath);

  // Assert
  assert.equal(leftover.status, "FAIL");
  assert.equal(removed.status, "PASS");
  assert.equal(removed.dispositions[0].disposition, "removed");
  assert.equal(reappeared.status, "FAIL");
  assert.equal(JSON.stringify(leftover).includes("secret-value"), false);
});

test("when a protected resource changes, retention fails instead of certifying its existence", async context => {
  // Arrange
  const current = await fixture(context);
  const path = join(current.root, "protected.env");
  await writeFile(path, "original\n");
  const retained = resource(path, {
    ownership: "protected",
    disposition: "retained",
    reason: "User-owned environment is still needed",
  });
  const prepared = await current.prepare([retained]);

  // Act
  const unchanged = await current.verify(prepared.receiptPath);
  await writeFile(path, "modified\n");
  const changed = await current.verify(prepared.receiptPath);

  // Assert
  assert.equal(unchanged.status, "PASS");
  assert.equal(unchanged.dispositions[0].disposition, "intentionally retained");
  assert.equal(changed.status, "FAIL");
});

test("when a missing retained path shares a receipt with actionable findings, each keeps its own next action", async context => {
  // Arrange
  const current = await fixture(context);
  const keptPath = join(current.root, "protected.env");
  const disposablePath = join(current.root, "temporary.env");
  const inspectedPath = join(current.root, "inspect.env");
  await writeFile(keptPath, "protected\n");
  await writeFile(disposablePath, "temporary\n");
  await writeFile(inspectedPath, "");
  const prepared = await current.prepare([
    resource(disposablePath, {
      id: "leftover-environment",
    }),
    resource(keptPath, {
      id: "protected-environment",
      disposition: "retained",
      ownership: "protected",
    }),
    resource(inspectedPath, {
      id: "unavailable-environment",
      disposition: "retained",
      ownership: "protected",
    }),
  ]);

  // Act
  await rm(keptPath);
  await truncate(inspectedPath, defaultContentLimit + 1);
  const result = await current.verify(prepared.receiptPath);

  // Assert
  assert.equal(result.status, "FAIL");
  assert.deepEqual(result.dispositions.map(({ status }) => status), ["FAIL", "FAIL", "BLOCKED"]);
  assert.match(result.nextCheck, /preserve the failed receipt/i);
  assert.match(result.nextCheck, /recheck after cleanup/i);
  assert.match(result.nextCheck, /restore the missing evidence or access/i);
});

test("when a frozen runtime exceeds the default byte limit, explicit retention observes changed content at the same size", async context => {
  // Arrange
  const current = await fixture(context);
  const runtimePath = join(current.root, "frozen-runtime");
  const libraryPath = join(runtimePath, "native.so");
  const timestamp = new Date("2026-01-01T00:00:00Z");
  await mkdir(runtimePath);
  await writeFile(libraryPath, "");
  await truncate(libraryPath, defaultContentLimit + 1);
  await utimes(libraryPath, timestamp, timestamp);
  const retainedRuntime = resource(runtimePath, {
    id: "frozen-runtime",
    ownership: "protected",
    disposition: "retained",
    reason: "Frozen runtime is still needed",
  });
  const optedInRuntime = {
    ...retainedRuntime,
    largeArtifact: true,
  };

  // Act
  const ordinary = await current.prepare([retainedRuntime]);
  const prepared = await current.prepare([optedInRuntime]);

  assert.equal(prepared.status, "PREPARED", prepared.evidence);

  const unchanged = await current.verify(prepared.receiptPath);
  const library = await open(libraryPath, "r+");
  try {
    await library.write("!", defaultContentLimit, "utf8");
  } finally {
    await library.close();
  }
  await utimes(libraryPath, timestamp, timestamp);
  const changed = await current.verify(prepared.receiptPath);

  // Assert
  assert.equal(ordinary.status, "BLOCKED");
  assert.match(ordinary.evidence, /67108864 content bytes/);
  assert.equal(unchanged.status, "PASS");
  assert.equal(unchanged.dispositions[0].disposition, "intentionally retained");
  assert.equal(changed.status, "FAIL");
});

test("when an authorized disposable large artifact is removed, fresh verification reports it removed", async context => {
  // Arrange
  const current = await fixture(context);
  const path = join(current.root, "disposable-runtime.so");
  await writeFile(path, "");
  await truncate(path, defaultContentLimit + 1);
  const disposableArtifact = resource(path, {
    id: "disposable-artifact",
    largeArtifact: true,
  });
  const prepared = await current.prepare([disposableArtifact]);
  assert.equal(prepared.status, "PREPARED", prepared.evidence);

  // Act
  await rm(path);
  const removed = await current.verify(prepared.receiptPath);

  // Assert
  assert.equal(removed.status, "PASS");
  assert.equal(removed.dispositions[0].disposition, "removed");
});

test("when largeArtifact is supplied with anything other than true, preparation refuses it", async context => {
  // Arrange
  const current = await fixture(context);
  const path = join(current.root, "artifact");

  // Act / Assert
  for (const setting of [false, null, "true", 1024 ** 3]) {
    const invalid = resource(path, {
      largeArtifact: setting,
    });
    const result = await current.prepare([invalid]);
    assert.equal(result.status, "BLOCKED", `largeArtifact: ${JSON.stringify(setting)}`);
    assert.match(result.evidence, /largeArtifact/);
    assert.equal(result.receiptPath, undefined);
  }
});

test("when a Git resource opts into largeArtifact, preparation refuses the path-only setting", async context => {
  // Arrange
  const current = await fixture(context);
  const gitRef = resource(undefined, {
    id: "disposable-ref",
    kind: "git-ref",
    ref: "refs/heads/disposable",
    largeArtifact: true,
  });

  // Act
  const result = await current.prepare([gitRef]);

  // Assert
  assert.equal(result.status, "BLOCKED");
  assert.match(result.evidence, /largeArtifact/);
  assert.equal(result.receiptPath, undefined);
});

test("when marked paths together exceed 1 GiB, preparation and verification both block", async context => {
  // Arrange
  const current = await fixture(context);
  const manifestPath = join(current.root, "manifest");
  const libraryPath = join(current.root, "large-runtime.so");
  await writeFile(manifestPath, "v1");
  await writeFile(libraryPath, "");
  const manifest = resource(manifestPath, {
    id: "manifest",
    disposition: "retained",
    largeArtifact: true,
  });
  const library = resource(libraryPath, {
    id: "library",
    disposition: "retained",
    largeArtifact: true,
  });
  const artifacts = [manifest, library];
  const prepared = await current.prepare(artifacts);
  assert.equal(prepared.status, "PREPARED", prepared.evidence);

  // Act
  // Put the two-byte manifest first so the second file crosses the limit before hashing.
  await truncate(libraryPath, 1024 ** 3 - 1);
  const verified = await current.verify(prepared.receiptPath);
  const refused = await current.prepare(artifacts);

  // Assert
  assert.equal(verified.status, "BLOCKED");
  assert.match(verified.evidence, /1073741824|1 GiB/);
  assert.equal(refused.status, "BLOCKED");
  assert.match(refused.evidence, /1073741824|1 GiB/);
  assert.equal(refused.receiptPath, undefined);
});

test("when an inventory includes an absent path, closeout distinguishes already absent from removed", async context => {
  // Arrange
  const current = await fixture(context);
  const path = join(current.root, "absent");
  const absentResource = resource(path);
  const prepared = await current.prepare([absentResource]);

  // Act
  const result = await current.verify(prepared.receiptPath);

  // Assert
  assert.equal(result.status, "PASS");
  assert.equal(result.dispositions[0].disposition, "already absent");
});

test("when ownership is uncertain, an absent disposition cannot be prepared", async context => {
  // Arrange
  const current = await fixture(context);
  const path = join(current.root, "uncertain");
  const uncertain = resource(path, {
    ownership: "unknown",
  });

  // Act
  const result = await current.prepare([uncertain]);

  // Assert
  assert.equal(result.status, "BLOCKED");
  assert.match(result.evidence, /preserve uncertain\/shared resources/);
});

test("when a receipt is changed, verification refuses the altered inventory", async context => {
  // Arrange
  const current = await fixture(context);
  const path = join(current.root, "absent");
  const absentResource = resource(path);
  const prepared = await current.prepare([absentResource]);
  const receipt = JSON.parse(await readFile(prepared.receiptPath, "utf8"));
  receipt.payload.declaration.resources[0].path = join(current.root, "substituted");
  await writeFile(prepared.receiptPath, JSON.stringify(receipt));

  // Act
  const result = await current.verify(prepared.receiptPath);

  // Assert
  assert.equal(result.status, "BLOCKED");
  assert.match(result.evidence, /changed after preparation/);
});

test("when receipt permissions expose private evidence, verification reports the prerequisite", async context => {
  // Arrange
  const current = await fixture(context);
  const path = join(current.root, "absent");
  const absentResource = resource(path);
  const prepared = await current.prepare([absentResource]);
  await chmod(prepared.receiptPath, 0o644);

  // Act
  const result = await current.verify(prepared.receiptPath);

  // Assert
  assert.equal(result.status, "BLOCKED");
  assert.match(result.evidence, /privately owned/);
});

test("when automatic verification has no source paths, explicit closeout still rejects leftovers", async context => {
  // Arrange
  const current = await fixture(context);
  const path = join(current.root, "leftover");
  await writeFile(path, "owned temporary content\n");
  const leftoverResource = resource(path);
  const prepared = await current.prepare([leftoverResource]);

  // Act
  const failed = spawnSync(process.execPath, [cli, "automatic", "--closeout", prepared.receiptPath], {
    cwd: current.repositoryRoot,
    encoding: "utf8",
  });
  await rm(path);
  const passed = spawnSync(process.execPath, [cli, "closeout", "verify", prepared.receiptPath, "--reporter", "text", "--failures-only"], {
    cwd: current.repositoryRoot,
    encoding: "utf8",
  });

  // Assert
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(JSON.parse(failed.stdout)[0].status, "FAIL");
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.stdout, "");
});
