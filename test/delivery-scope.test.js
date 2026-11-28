import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { captureDeliveryScope } from "#root/omp-plugin/delivery-scope.js";

function git(repositoryRoot, ...args) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", repositoryRoot, ...args], { encoding: "utf8" }).trim();
}

async function repositoryFixture(t) {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "omp-verifier-delivery-scope-"));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  git(repositoryRoot, "init", "--quiet", "--initial-branch=main");
  git(repositoryRoot, "config", "user.email", "delivery-scope@example.invalid");
  git(repositoryRoot, "config", "user.name", "Delivery scope test");
  await writeFile(join(repositoryRoot, ".gitignore"), "ignored.txt\n");
  await writeFile(join(repositoryRoot, "tracked.txt"), "baseline\n");
  await writeFile(join(repositoryRoot, "staged.txt"), "baseline\n");
  await writeFile(join(repositoryRoot, "removed.txt"), "baseline\n");
  git(repositoryRoot, "add", ".");
  git(repositoryRoot, "commit", "--quiet", "-m", "baseline");
  git(repositoryRoot, "tag", "delivery-base");
  const baseCommit = git(repositoryRoot, "rev-parse", "HEAD");
  return { repositoryRoot, baseCommit };
}

test("when candidates are restored or temporary additions disappear, only net changes remain", async t => {
  // Arrange
  const { repositoryRoot } = await repositoryFixture(t);
  await writeFile(join(repositoryRoot, "tracked.txt"), "temporary edit\n");
  await writeFile(join(repositoryRoot, "tracked.txt"), "baseline\n");
  await writeFile(join(repositoryRoot, "staged.txt"), "staged edit\n");
  git(repositoryRoot, "add", "staged.txt");
  await writeFile(join(repositoryRoot, "staged.txt"), "baseline\n");
  await writeFile(join(repositoryRoot, "temporary.txt"), "temporary untracked file\n");
  await rm(join(repositoryRoot, "temporary.txt"));
  await writeFile(join(repositoryRoot, "staged-new.txt"), "temporary indexed file\n");
  git(repositoryRoot, "add", "staged-new.txt");
  await rm(join(repositoryRoot, "staged-new.txt"));

  // Act
  const scope = await captureDeliveryScope({
    repositoryRoot,
    baseRef: "delivery-base",
    candidatePaths: ["tracked.txt", "temporary.txt", "staged.txt", "staged-new.txt"],
  });

  // Assert
  assert.deepEqual(scope.changedPaths, []);
  assert.deepEqual(scope.candidatePaths, ["staged-new.txt", "staged.txt", "temporary.txt", "tracked.txt"]);
});

test("when a deletion is committed, its missing path remains even without candidates", async t => {
  // Arrange
  const { repositoryRoot, baseCommit } = await repositoryFixture(t);
  await rm(join(repositoryRoot, "removed.txt"));
  git(repositoryRoot, "add", "removed.txt");
  git(repositoryRoot, "commit", "--quiet", "-m", "remove obsolete file");
  const headCommit = git(repositoryRoot, "rev-parse", "HEAD");

  // Act
  const scope = await captureDeliveryScope({ repositoryRoot, baseRef: "delivery-base" });

  // Assert
  assert.deepEqual(scope.deletedPaths, ["removed.txt"]);
  assert.deepEqual(scope.lineRanges, {});
  assert.deepEqual(scope.changedPaths, ["removed.txt"]);
  assert.deepEqual(scope.candidatePaths, []);
  assert.equal(scope.baseRef, "delivery-base");
  assert.equal(scope.baseCommit, baseCommit);
  assert.equal(scope.mergeBaseCommit, baseCommit);
  assert.equal(scope.headCommit, headCommit);
});

test("when a committed rename is detected, both its removed and added paths remain", async t => {
  // Arrange
  const { repositoryRoot } = await repositoryFixture(t);
  await rename(join(repositoryRoot, "removed.txt"), join(repositoryRoot, "renamed.txt"));
  git(repositoryRoot, "add", ".");
  git(repositoryRoot, "commit", "--quiet", "-m", "rename file");

  // Act
  const scope = await captureDeliveryScope({ repositoryRoot, baseRef: "delivery-base", candidatePaths: ["renamed.txt"] });

  // Assert
  assert.deepEqual(scope.changedPaths, ["removed.txt", "renamed.txt"]);
  assert.deepEqual(scope.deletedPaths, []);
  assert.deepEqual(scope.lineRanges, {
    "renamed.txt": [],
  });
});

test("when candidates have live tracked or untracked changes, staged and working tree edits are included", async t => {
  // Arrange
  const { repositoryRoot } = await repositoryFixture(t);
  await writeFile(join(repositoryRoot, "tracked.txt"), "working tree edit\n");
  await writeFile(join(repositoryRoot, "staged.txt"), "indexed edit\n");
  git(repositoryRoot, "add", "staged.txt");
  await rm(join(repositoryRoot, "removed.txt"));
  await writeFile(join(repositoryRoot, "new.txt"), "indexed addition\n");
  git(repositoryRoot, "add", "new.txt");
  await writeFile(join(repositoryRoot, "untracked.txt"), "live untracked addition\n");
  const candidatePaths = ["untracked.txt", "./tracked.txt", "staged.txt", "removed.txt", "new.txt", "tracked.txt"];

  // Act
  const scope = await captureDeliveryScope({ repositoryRoot, baseRef: "delivery-base", candidatePaths });
  candidatePaths.push("later.txt");

  // Assert
  assert.deepEqual(scope.changedPaths, ["new.txt", "removed.txt", "staged.txt", "tracked.txt", "untracked.txt"]);
  assert.deepEqual(scope.candidatePaths, ["new.txt", "removed.txt", "staged.txt", "tracked.txt", "untracked.txt"]);
  assert.deepEqual(scope.deletedPaths, ["removed.txt"]);
  assert.deepEqual(scope.lineRanges, {
    "new.txt": [[1, 1]],
    "staged.txt": [[1, 1]],
    "tracked.txt": [[1, 1]],
    "untracked.txt": [[1, 1]],
  });
});

test("when untracked or tracked changes are unrelated to candidates, they are excluded and ignored candidates stay excluded", async t => {
  // Arrange
  const { repositoryRoot } = await repositoryFixture(t);
  await writeFile(join(repositoryRoot, "tracked.txt"), "unrelated tracked edit\n");
  await writeFile(join(repositoryRoot, "unrelated.txt"), "unrelated untracked addition\n");
  await writeFile(join(repositoryRoot, "ignored.txt"), "ignored candidate\n");
  await writeFile(join(repositoryRoot, "candidate.txt"), "selected untracked addition\n");

  // Act
  const scope = await captureDeliveryScope({ repositoryRoot, baseRef: "delivery-base", candidatePaths: ["ignored.txt", "candidate.txt"] });

  // Assert
  assert.deepEqual(scope.changedPaths, ["candidate.txt"]);
});

test("when a candidate contains Git pathspec metacharacters, only the literal candidate is included", async t => {
  // Arrange
  const { repositoryRoot } = await repositoryFixture(t);
  await writeFile(join(repositoryRoot, "[candidate].txt"), "literal candidate\n");
  await writeFile(join(repositoryRoot, "c.txt"), "not the literal candidate\n");

  // Act
  const scope = await captureDeliveryScope({ repositoryRoot, baseRef: "delivery-base", candidatePaths: ["[candidate].txt"] });

  // Assert
  assert.deepEqual(scope.changedPaths, ["[candidate].txt"]);
});

test("when the named base has diverged, capture uses the common ancestor and records immutable commit identities", async t => {
  // Arrange
  const { repositoryRoot, baseCommit: commonCommit } = await repositoryFixture(t);
  git(repositoryRoot, "checkout", "--quiet", "-b", "upstream");
  await writeFile(join(repositoryRoot, "upstream.txt"), "upstream only\n");
  git(repositoryRoot, "add", ".");
  git(repositoryRoot, "commit", "--quiet", "-m", "upstream change");
  const baseCommit = git(repositoryRoot, "rev-parse", "HEAD");
  git(repositoryRoot, "checkout", "--quiet", "main");
  await writeFile(join(repositoryRoot, "delivered.txt"), "delivery only\n");
  git(repositoryRoot, "add", ".");
  git(repositoryRoot, "commit", "--quiet", "-m", "delivery change");
  const headCommit = git(repositoryRoot, "rev-parse", "HEAD");

  // Act
  const scope = await captureDeliveryScope({ repositoryRoot, baseRef: "upstream" });
  git(repositoryRoot, "branch", "--force", "upstream", headCommit);

  // Assert
  assert.equal(scope.baseRef, "upstream");
  assert.equal(scope.baseCommit, baseCommit);
  assert.equal(scope.headCommit, headCommit);
  assert.equal(scope.mergeBaseCommit, commonCommit);
  assert.deepEqual(scope.changedPaths, ["delivered.txt"]);
});

for (const baseRef of [undefined, "", "missing-base", "--all"]) {
  test(`when the base is ${JSON.stringify(baseRef)}, capture rejects instead of returning an empty scope`, async t => {
    // Arrange
    const { repositoryRoot } = await repositoryFixture(t);

    // Act / Assert
    await assert.rejects(captureDeliveryScope({ repositoryRoot, baseRef }));
  });
}

test("when the base has unrelated history, capture rejects instead of returning an empty scope", async t => {
  // Arrange
  const { repositoryRoot, baseCommit } = await repositoryFixture(t);
  const unrelatedCommit = git(repositoryRoot, "commit-tree", `${baseCommit}^{tree}`, "-m", "unrelated root");

  // Act / Assert
  await assert.rejects(captureDeliveryScope({ repositoryRoot, baseRef: unrelatedCommit }));
});

test("when a committed rename edits source, only changed destination lines are eligible", async t => {
  // Arrange
  const { repositoryRoot } = await repositoryFixture(t);
  const oldPath = "old name.txt";
  const newPath = "new name\n@@ -12,0 +12 @@.txt";
  const lines = Array.from({
    length: 12,
  }, (_, index) => `line ${index + 1}: keeps the rename recognizable`);
  await writeFile(join(repositoryRoot, oldPath), `${lines.join("\n")}\n`);
  git(repositoryRoot, "add", ".");
  git(repositoryRoot, "commit", "--quiet", "-m", "parent implementation");
  git(repositoryRoot, "tag", "stacked-parent");
  await rm(join(repositoryRoot, oldPath));
  lines[3] = "@@ -40,0 +55,3 @@ fake hunk";
  lines[9] = "+++ b/unrelated.txt";
  await writeFile(join(repositoryRoot, newPath), `${lines.join("\n")}\n`);
  git(repositoryRoot, "add", ".");
  git(repositoryRoot, "commit", "--quiet", "-m", "rename and edit");

  // Act
  const scope = await captureDeliveryScope({
    repositoryRoot,
    baseRef: "stacked-parent",
  });

  // Assert
  assert.deepEqual(scope.changedPaths, [newPath, oldPath]);
  assert.deepEqual(scope.deletedPaths, []);
  assert.deepEqual(scope.renames, [{ from: oldPath, to: newPath }]);
  assert.deepEqual(scope.lineRanges, {
    [newPath]: [[4, 4], [10, 10]],
  });
});

test("when a committed file has a dirty noncandidate overlay, capture rejects misaligned coordinates", async t => {
  // Arrange
  const { repositoryRoot } = await repositoryFixture(t);
  const path = "tracked.txt";
  await writeFile(join(repositoryRoot, path), "baseline\ncommitted edit\n");
  git(repositoryRoot, "add", path);
  git(repositoryRoot, "commit", "--quiet", "-m", "authored change");
  git(repositoryRoot, "update-index", "--assume-unchanged", path);
  await writeFile(join(repositoryRoot, path), "workspace insertion\nbaseline\ncommitted edit\n");

  // Act
  const [unowned, authored] = await Promise.allSettled([
    captureDeliveryScope({
      repositoryRoot,
      baseRef: "delivery-base",
    }),
    captureDeliveryScope({
      repositoryRoot,
      baseRef: "delivery-base",
      candidatePaths: [path],
    }),
  ]);

  // Assert
  assert.equal(unowned.status, "rejected");
  assert.match(unowned.reason.message, /commit or restore it before PR review/);
  assert.equal(authored.status, "fulfilled");
  assert.deepEqual(authored.value.lineRanges, {
    [path]: [[1, 1], [3, 3]],
  });
});

test("when candidates delete lines or add untracked files, capture uses their current coordinates", async t => {
  // Arrange
  const { repositoryRoot } = await repositoryFixture(t);
  await writeFile(join(repositoryRoot, "tracked.txt"), "first\nremoved\nthird\nfourth\n");
  git(repositoryRoot, "add", ".");
  git(repositoryRoot, "commit", "--quiet", "-m", "fixture lines");
  git(repositoryRoot, "tag", "fixture-base");
  await writeFile(join(repositoryRoot, "tracked.txt"), "first\nthird\nfourth\n");
  const newPath = "__proto__";
  await writeFile(join(repositoryRoot, newPath), "first\n@@ -200,0 +300,7 @@ fake hunk\nlast");

  // Act
  const scope = await captureDeliveryScope({
    repositoryRoot,
    baseRef: "fixture-base",
    candidatePaths: ["tracked.txt", newPath],
  });

  // Assert
  assert.deepEqual(scope.lineRanges, {
    [newPath]: [[1, 3]],
    "tracked.txt": [],
  });
});

test("when a pure rename is still untracked, neither its unchanged lines nor its former path are eligible", async t => {
  // Arrange
  const { repositoryRoot } = await repositoryFixture(t);
  await rename(join(repositoryRoot, "removed.txt"), join(repositoryRoot, "renamed.txt"));

  // Act
  const scope = await captureDeliveryScope({
    repositoryRoot,
    baseRef: "delivery-base",
    candidatePaths: ["removed.txt", "renamed.txt"],
  });

  // Assert
  assert.deepEqual(scope.changedPaths, ["removed.txt", "renamed.txt"]);
  assert.deepEqual(scope.deletedPaths, []);
  assert.deepEqual(scope.lineRanges, {
    "renamed.txt": [],
  });
});

test("when a staged rename has later edits, capture uses working coordinates against the source baseline", async t => {
  // Arrange
  const { repositoryRoot } = await repositoryFixture(t);
  const oldPath = "source.txt";
  const newPath = "destination.txt";
  const lines = ["first unchanged line", "second unchanged line", "third unchanged line", "fourth unchanged line"];
  await writeFile(join(repositoryRoot, oldPath), `${lines.join("\n")}\n`);
  git(repositoryRoot, "add", oldPath);
  git(repositoryRoot, "commit", "--quiet", "-m", "tracked rename source");
  git(repositoryRoot, "tag", "rename-base");
  await rename(join(repositoryRoot, oldPath), join(repositoryRoot, newPath));
  git(repositoryRoot, "add", oldPath, newPath);
  await writeFile(join(repositoryRoot, newPath), `inserted line\n${lines.slice(0, 2).join("\n")}\nreplacement line\n${lines[3]}\n`);

  // Act
  const scope = await captureDeliveryScope({
    repositoryRoot,
    baseRef: "rename-base",
    candidatePaths: [newPath, oldPath],
  });

  // Assert
  assert.deepEqual(scope.changedPaths, [newPath, oldPath]);
  assert.deepEqual(scope.deletedPaths, []);
  assert.deepEqual(scope.lineRanges, {
    [newPath]: [[1, 1], [4, 4]],
  });
});

test("when cleanup paths are selected, only changed delivery files can be opted in", async t => {
  // Arrange
  const { repositoryRoot } = await repositoryFixture(t);
  await writeFile(join(repositoryRoot, "tracked.txt"), "baseline\ncleanup target\n");
  await writeFile(join(repositoryRoot, "fresh.txt"), "new cleanup target\n");

  // Act
  const scope = await captureDeliveryScope({
    repositoryRoot,
    baseRef: "delivery-base",
    candidatePaths: ["tracked.txt", "fresh.txt"],
    wholeFilePaths: ["./tracked.txt", "fresh.txt", "tracked.txt"],
  });

  // Assert
  assert.deepEqual(scope.changedPaths, ["fresh.txt", "tracked.txt"]);
  assert.deepEqual(scope.wholeFilePaths, ["fresh.txt", "tracked.txt"]);
  assert.deepEqual(scope.lineRanges, {
    "fresh.txt": [[1, 1]],
    "tracked.txt": [[2, 2]],
  });

  await assert.rejects(captureDeliveryScope({
    repositoryRoot,
    baseRef: "delivery-base",
    wholeFilePaths: ["staged.txt"],
  }), /whole-file cleanup must target a changed delivery path/);
  await assert.rejects(captureDeliveryScope({
    repositoryRoot,
    baseRef: "delivery-base",
    wholeFilePaths: ["../outside.txt"],
  }), /project-relative file paths without traversal/);
});

test("when changed lines are large, capture does not buffer the whole patch", async t => {
  // Arrange
  const { repositoryRoot } = await repositoryFixture(t);
  await writeFile(join(repositoryRoot, "tracked.txt"), `${"a".repeat(2_100_000)}\n`);
  git(repositoryRoot, "add", "tracked.txt");
  git(repositoryRoot, "commit", "--quiet", "-m", "large delivery edit");

  // Act
  const scope = await captureDeliveryScope({
    repositoryRoot,
    baseRef: "delivery-base",
  });

  // Assert
  assert.deepEqual(scope.lineRanges, {
    "tracked.txt": [[1, 1]],
  });
});

test("when a candidate restores committed source to its base, whole-file cleanup is unavailable", async t => {
  // Arrange
  const { repositoryRoot } = await repositoryFixture(t);
  const path = "tracked.txt";
  await writeFile(join(repositoryRoot, path), "committed edit\n");
  git(repositoryRoot, "add", path);
  git(repositoryRoot, "commit", "--quiet", "-m", "changed source");
  await writeFile(join(repositoryRoot, path), "baseline\n");

  // Act
  const [candidate, cleanup] = await Promise.allSettled([
    captureDeliveryScope({
      repositoryRoot,
      baseRef: "delivery-base",
      candidatePaths: [path],
    }),
    captureDeliveryScope({
      repositoryRoot,
      baseRef: "delivery-base",
      candidatePaths: [path],
      wholeFilePaths: [path],
    }),
  ]);

  // Assert
  assert.equal(candidate.status, "fulfilled");
  assert.deepEqual(candidate.value.changedPaths, []);
  assert.equal(cleanup.status, "rejected");
  assert.match(cleanup.reason.message, /whole-file cleanup must target a changed delivery path/);
});
