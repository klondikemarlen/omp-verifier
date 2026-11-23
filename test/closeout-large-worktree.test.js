import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, realpath, rm, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { prepareResourceCloseout, verifyResourceCloseout } from "#root/omp-plugin/resource-closeout.js";

const execute = promisify(execFile);
const mebibyte = 1024 ** 2;

async function git(root, ...args) {
  const result = await execute("git", ["-c", "core.hooksPath=/dev/null", "-C", root, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Closeout Test",
      GIT_AUTHOR_EMAIL: "closeout@example.invalid",
      GIT_COMMITTER_NAME: "Closeout Test",
      GIT_COMMITTER_EMAIL: "closeout@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    encoding: "utf8",
  });
  return result.stdout.trim();
}

async function fixture(t) {
  const temporaryDirectory = await realpath(tmpdir());
  const root = await mkdtemp(join(temporaryDirectory, "closeout-large-worktree-"));
  const repositoryRoot = join(root, "repository");
  const remote = join(root, "remote.git");
  const declarationPath = join(root, "declaration.json");
  const receipts = [];
  t.after(async () => {
    for (const receiptPath of receipts) {
      await rm(receiptPath, {
        force: true,
      });
    }
    await rm(root, {
      recursive: true,
      force: true,
    });
  });

  await mkdir(repositoryRoot);
  await mkdir(remote);
  await git(repositoryRoot, "init", "--initial-branch=main");
  await git(remote, "init", "--bare", "--initial-branch=main");
  await git(repositoryRoot, "remote", "add", "origin", remote);
  await writeFile(join(repositoryRoot, ".gitignore"), "cache/\n");
  await writeFile(join(repositoryRoot, "tracked.txt"), "base\n");
  await git(repositoryRoot, "add", ".");
  await git(repositoryRoot, "commit", "-m", "base");
  const baseCommit = await git(repositoryRoot, "rev-parse", "HEAD");
  await git(repositoryRoot, "checkout", "-b", "task");
  await writeFile(join(repositoryRoot, "tracked.txt"), "delivered task change\n");
  await git(repositoryRoot, "commit", "-am", "task change");
  const tipCommit = await git(repositoryRoot, "rev-parse", "HEAD");
  await git(repositoryRoot, "checkout", "main");
  await git(repositoryRoot, "merge", "--no-ff", "task", "-m", "deliver task");
  const deliveredCommit = await git(repositoryRoot, "rev-parse", "HEAD");
  await git(repositoryRoot, "push", "origin", "main");
  const delivery = {
    baseCommit,
    tipCommit,
    remote: "origin",
    targetRef: "refs/heads/main",
    deliveredCommit,
  };

  async function addWorktree(id, overrides = {}) {
    const path = join(root, id);
    await git(repositoryRoot, "worktree", "add", "--detach", path, tipCommit);
    await mkdir(join(path, "cache"));
    return {
      id,
      kind: "git-worktree",
      path,
      disposition: "absent",
      ownership: "task",
      ownershipEvidence: "Created in this isolated fixture",
      reason: "Task was delivered",
      disposableContents: true,
      delivery,
      ...overrides,
    };
  }

  async function prepare(resources) {
    const declaration = {
      version: 1,
      taskId: "isolated-large-worktree-closeout",
      repositoryRoot,
      authorization: "Dispose only the isolated test worktrees and their contents",
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
    repositoryRoot,
    addWorktree,
    prepare,
    verify,
  };
}

async function writeSparseFile(path, bytes) {
  await writeFile(path, "");
  await truncate(path, bytes);
}

async function writeIgnoredFiles(worktreePath, count) {
  for (let index = 0; index < count; index += 1) {
    await writeFile(join(worktreePath, "cache", `platform-native-runtime-build-dependency-${index}.node`), "");
  }
}

async function readWorktreeObservation({ receiptPath, evidence }) {
  if (!receiptPath) {
    throw new Error(`Cannot read worktree observation: ${evidence}`);
  }

  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  return receipt.payload.observations[0];
}

test("when an opted-in delivered worktree has 5,115 ignored paths and a 320 MiB file, captures exact inventory and verifies removal", async (t) => {
  // Arrange
  const current = await fixture(t);
  const worktree = await current.addWorktree("delivered-worktree");
  await writeIgnoredFiles(worktree.path, 5_114);
  const nativePath = join(worktree.path, "cache", "native.so");
  const nativeBytes = 320 * mebibyte;
  await writeSparseFile(nativePath, nativeBytes);
  const timestamp = new Date("2026-01-01T00:00:00Z");
  await utimes(nativePath, timestamp, timestamp);
  await writeFile(join(worktree.path, "local-notes.txt"), "local note\n");
  const optedInWorktree = {
    ...worktree,
    largeWorktree: true,
  };
  const protectedBranch = {
    id: "protected-branch",
    kind: "git-ref",
    ref: "refs/heads/task",
    disposition: "retained",
    ownership: "protected",
    ownershipEvidence: "The local branch is outside cleanup authorization",
    reason: "Preserve the local task branch",
  };

  // Act
  const ordinary = await current.prepare([worktree, protectedBranch]);
  const prepared = await current.prepare([optedInWorktree, protectedBranch]);
  const before = await readWorktreeObservation(prepared);
  const nativeFile = await open(nativePath, "r+");
  try {
    await nativeFile.write("!", nativeBytes - 1, "utf8");
  } finally {
    await nativeFile.close();
  }
  await utimes(nativePath, timestamp, timestamp);
  const changed = await current.prepare([optedInWorktree, protectedBranch]);
  const after = await readWorktreeObservation(changed);
  const remaining = await current.verify(changed.receiptPath);
  await git(current.repositoryRoot, "worktree", "remove", "--force", worktree.path);
  const removed = await current.verify(changed.receiptPath);

  // Assert
  assert.equal(ordinary.status, "BLOCKED", ordinary.evidence);
  assert.match(ordinary.evidence, /path bound/);
  assert.equal(ordinary.receiptPath, undefined);
  assert.deepEqual(before.details, {
    trackedChangeCount: 0,
    untrackedCount: 1,
    ignoredCount: 5_115,
  });
  assert.deepEqual(after.details, before.details);
  assert.match(before.identity.contentFingerprint, /^[a-f0-9]{64}$/);
  assert.match(after.identity.contentFingerprint, /^[a-f0-9]{64}$/);
  assert.notEqual(after.identity.contentFingerprint, before.identity.contentFingerprint);
  assert.equal(remaining.status, "FAIL");
  assert.match(remaining.evidence, /remains present/);
  assert.equal(removed.status, "PASS", removed.evidence);
  assert.equal(removed.dispositions[0].disposition, "removed");
  assert.equal(removed.dispositions[1].disposition, "intentionally retained");
});

test("when a worktree without opt-in has a file just over 4 MiB, blocks preparation", async (t) => {
  // Arrange
  const current = await fixture(t);
  const worktree = await current.addWorktree("ordinary-single-file");
  await writeSparseFile(join(worktree.path, "cache", "native.so"), 4 * mebibyte + 1);

  // Act
  const result = await current.prepare([worktree]);

  // Assert
  assert.equal(result.status, "BLOCKED", result.evidence);
  assert.match(result.evidence, /file exceeds byte bound/);
  assert.equal(result.receiptPath, undefined);
});

test("when an ordinary worktree has over 32 MiB of individually allowed files, blocks preparation", async (t) => {
  // Arrange
  const current = await fixture(t);
  const worktree = await current.addWorktree("ordinary-total-bytes");
  for (let index = 0; index < 8; index += 1) {
    await writeSparseFile(join(worktree.path, "cache", `library-${index}.so`), 4 * mebibyte);
  }

  // Act
  const result = await current.prepare([worktree]);

  // Assert
  assert.equal(result.status, "BLOCKED", result.evidence);
  assert.match(result.evidence, /inventory exceeds byte bound/);
  assert.equal(result.receiptPath, undefined);
});

test("when largeWorktree is supplied with a value other than literal true, blocks preparation", async (t) => {
  // Arrange
  const current = await fixture(t);
  const worktree = await current.addWorktree("invalid-opt-in");
  const invalidSettings = [false, null, "true", 1];

  // Act
  const results = [];
  for (const setting of invalidSettings) {
    const invalidWorktree = {
      ...worktree,
      largeWorktree: setting,
    };
    const result = await current.prepare([invalidWorktree]);
    results.push(result);
  }

  // Assert
  for (const result of results) {
    assert.equal(result.status, "BLOCKED", result.evidence);
    assert.match(result.evidence, /largeWorktree/);
    assert.equal(result.receiptPath, undefined);
  }
});

test("when largeWorktree lacks explicit authorization for checkout contents, blocks preparation", async (t) => {
  // Arrange
  const current = await fixture(t);
  const worktree = await current.addWorktree("unauthorized-contents", {
    disposableContents: undefined,
    largeWorktree: true,
  });

  // Act
  const result = await current.prepare([worktree]);

  // Assert
  assert.equal(result.status, "BLOCKED", result.evidence);
  assert.match(result.evidence, /largeWorktree.*disposableContents/);
  assert.equal(result.receiptPath, undefined);
});

test("when a retained worktree opts in to largeWorktree, blocks preparation", async (t) => {
  // Arrange
  const current = await fixture(t);
  const worktree = await current.addWorktree("retained-worktree", {
    disposition: "retained",
    largeWorktree: true,
  });

  // Act
  const result = await current.prepare([worktree]);

  // Assert
  assert.equal(result.status, "BLOCKED", result.evidence);
  assert.match(result.evidence, /largeWorktree/);
  assert.equal(result.receiptPath, undefined);
});

test("when an opted-in worktree's task ownership is uncertain, blocks preparation for removal", async (t) => {
  // Arrange
  const current = await fixture(t);
  const worktree = await current.addWorktree("uncertain-worktree", {
    ownership: "unknown",
    ownershipEvidence: "Task ownership is not established",
    largeWorktree: true,
  });

  // Act
  const result = await current.prepare([worktree]);

  // Assert
  assert.equal(result.status, "BLOCKED", result.evidence);
  assert.match(result.evidence, /task ownership|task-owned/);
  assert.equal(result.receiptPath, undefined);
});

test("when a Git ref opts in to largeWorktree, blocks preparation", async (t) => {
  // Arrange
  const current = await fixture(t);
  const taskRef = {
    id: "task-branch",
    kind: "git-ref",
    ref: "refs/heads/task",
    disposition: "absent",
    ownership: "task",
    ownershipEvidence: "Created in this isolated fixture",
    reason: "Task was delivered",
    disposableContents: true,
    largeWorktree: true,
  };

  // Act
  const result = await current.prepare([taskRef]);

  // Assert
  assert.equal(result.status, "BLOCKED", result.evidence);
  assert.match(result.evidence, /largeWorktree/);
  assert.equal(result.receiptPath, undefined);
});

test("when an opted-in worktree has dirty tracked content, blocks preparation for removal", async (t) => {
  // Arrange
  const current = await fixture(t);
  const worktree = await current.addWorktree("dirty-worktree", {
    largeWorktree: true,
  });
  await writeFile(join(worktree.path, "tracked.txt"), "uncommitted task change\n");

  // Act
  const result = await current.prepare([worktree]);

  // Assert
  assert.equal(result.status, "BLOCKED", result.evidence);
  assert.match(result.evidence, /preserve uncommitted tracked changes/);
  assert.equal(result.receiptPath, undefined);
});

test("when an opted-in worktree has no delivery proof, blocks preparation for removal", async (t) => {
  // Arrange
  const current = await fixture(t);
  const worktree = await current.addWorktree("unproven-worktree", {
    delivery: undefined,
    largeWorktree: true,
  });

  // Act
  const result = await current.prepare([worktree]);

  // Assert
  assert.equal(result.status, "BLOCKED", result.evidence);
  assert.match(result.evidence, /requires delivery proof/);
  assert.equal(result.receiptPath, undefined);
});

test("when an opted-in worktree has over 16,384 tracked and ignored paths combined, blocks preparation", async (t) => {
  // Arrange
  const current = await fixture(t);
  const worktree = await current.addWorktree("too-many-paths", {
    largeWorktree: true,
  });
  await writeIgnoredFiles(worktree.path, 16_383);

  // Act
  const result = await current.prepare([worktree]);

  // Assert
  assert.equal(result.status, "BLOCKED", result.evidence);
  assert.match(result.evidence, /path bound|16,?384/);
  assert.equal(result.receiptPath, undefined);
});

test("when an opted-in worktree has a file just over 512 MiB, blocks preparation", async (t) => {
  // Arrange
  const current = await fixture(t);
  const worktree = await current.addWorktree("oversized-file", {
    largeWorktree: true,
  });
  await writeSparseFile(join(worktree.path, "cache", "native.so"), 512 * mebibyte + 1);

  // Act
  const result = await current.prepare([worktree]);

  // Assert
  assert.equal(result.status, "BLOCKED", result.evidence);
  assert.match(result.evidence, /file exceeds byte bound|512 MiB|536870912/);
  assert.equal(result.receiptPath, undefined);
});

test("when opted-in worktrees exceed 1 GiB together after capture, blocks fresh observation of the excess", async (t) => {
  // Arrange
  const current = await fixture(t);
  const first = await current.addWorktree("first-worktree", {
    largeWorktree: true,
  });
  const second = await current.addWorktree("second-worktree", {
    largeWorktree: true,
  });
  const prepared = await current.prepare([first, second]);
  await writeSparseFile(join(first.path, "cache", "native.so"), 512 * mebibyte);
  await writeSparseFile(join(second.path, "cache", "native.so"), 512 * mebibyte);

  // Act
  const result = await current.verify(prepared.receiptPath);

  // Assert
  assert.equal(result.status, "FAIL", result.evidence);
  assert.equal(result.dispositions[0].status, "FAIL", result.evidence);
  assert.equal(result.dispositions[1].status, "BLOCKED", result.evidence);
  assert.match(result.dispositions[1].evidence, /exceeds byte bound/);
});
