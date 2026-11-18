import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { prepareResourceCloseout, verifyResourceCloseout } from "#root/omp-plugin/resource-closeout.js";

const cli = fileURLToPath(new URL("../bin/omp-verifier.js", import.meta.url));

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
  const prepared = await current.prepare([resource(path)]);

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

test("when an inventory includes an absent path, closeout distinguishes already absent from removed", async context => {
  // Arrange
  const current = await fixture(context);
  const path = join(current.root, "absent");
  const prepared = await current.prepare([resource(path)]);

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
  const prepared = await current.prepare([resource(path)]);
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
  const prepared = await current.prepare([resource(path)]);
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
  const prepared = await current.prepare([resource(path)]);

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
