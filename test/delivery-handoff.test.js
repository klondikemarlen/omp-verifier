import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  prepareDeliveryHandoff,
  recoverDeliveryHandoff,
  releaseDeliveryHandoff,
} from "#root/omp-plugin/delivery-handoff.js";

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
  return { root, primary, source, baseCommit, tipCommit, handoffs };
}

async function prepare(fixture) {
  const handoff = await prepareDeliveryHandoff({ cwd: fixture.source, baseRef: fixture.baseCommit });
  fixture.handoffs.push(handoff);
  return handoff;
}

function pin(handoff) {
  return `refs/omp-verifier/deliveries/${handoff.id}`;
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
    const recovered = await recoverDeliveryHandoff({ handoffPath: handoff.handoffPath });
    const path = state === "tracked" ? "src/helper.js" : "src/untracked.js";
    await writeFile(join(recovered.checkoutPath, path), "private review work\n");
    const before = git(recovered.checkoutPath, "status", "--porcelain");

    // Act / Assert
    await assert.rejects(recoverDeliveryHandoff({ handoffPath: handoff.handoffPath }));
    await assert.rejects(releaseDeliveryHandoff({ handoffPath: handoff.handoffPath }));
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
  const copiedPath = join(fixture.root, "copied-handoff.json");
  await copyFile(handoff.handoffPath, copiedPath);

  // Act / Assert
  await assert.rejects(recoverDeliveryHandoff({ handoffPath: copiedPath }));
  await assert.rejects(releaseDeliveryHandoff({ handoffPath: copiedPath }));
  const recovered = await recoverDeliveryHandoff({ handoffPath: handoff.handoffPath });
  assert.equal(recovered.status, "RECOVERED");
  assert.equal(git(fixture.primary, "rev-parse", pin(handoff)), fixture.tipCommit);
});

test("when the shared Git database is replaced at the same path, matching commits cannot authorize recovery or release", async t => {
  // Arrange
  const fixture = await deliveryFixture(t);
  const handoff = await prepare(fixture);
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
    const recovered = await recoverDeliveryHandoff({ handoffPath: handoff.handoffPath });
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
  const cancelled = await releaseDeliveryHandoff({ handoffPath: handoff.handoffPath, cancellationReason: "delivery abandoned" });
  assert.equal(cancelled.status, "CANCELLED");
  await assert.rejects(recoverDeliveryHandoff({ handoffPath: handoff.handoffPath }));
  assert.equal(git(fixture.source, "rev-parse", "HEAD"), fixture.tipCommit);
  assert.equal(git(fixture.source, "status", "--porcelain"), "");
  assert.equal(git(fixture.primary, "for-each-ref", "--format=%(refname)", pin(handoff)), "");
});
