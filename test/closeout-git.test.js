import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { observeGitResources, validateGitResource } from "#root/omp-plugin/closeout-git.js";

const execute = promisify(execFile);

async function git(root, ...args) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Closeout Test",
    GIT_AUTHOR_EMAIL: "closeout@example.invalid",
    GIT_COMMITTER_NAME: "Closeout Test",
    GIT_COMMITTER_EMAIL: "closeout@example.invalid",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const result = await execute("git", ["-c", "core.hooksPath=/dev/null", "-C", root, ...args], {
    env,
    encoding: "utf8",
  });
  return result.stdout.trim();
}

async function repositoryFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "closeout-git-"));
  t.after(async () => {
    await rm(root, {
      recursive: true,
      force: true,
    });
  });
  const repositoryRoot = join(root, "repository");
  const remote = join(root, "remote.git");
  await mkdir(repositoryRoot);
  await mkdir(remote);
  await git(repositoryRoot, "init", "--initial-branch=main");
  await git(remote, "init", "--bare", "--initial-branch=main");
  await git(repositoryRoot, "remote", "add", "origin", remote);
  await writeFile(join(repositoryRoot, "tracked.txt"), "base\n");
  await writeFile(join(repositoryRoot, ".gitignore"), "ignored.secret\ncache/\n");
  await git(repositoryRoot, "add", ".");
  await git(repositoryRoot, "commit", "-m", "base");
  const baseCommit = await git(repositoryRoot, "rev-parse", "HEAD");
  await git(repositoryRoot, "push", "origin", "main");
  return {
    root,
    repositoryRoot,
    remote,
    baseCommit,
  };
}

function localRef(ref, additions = {}) {
  return {
    id: "topic",
    kind: "git-ref",
    ref,
    disposition: "retained",
    ...additions,
  };
}

async function observe(repositoryRoot, resources) {
  return observeGitResources({
    repositoryRoot,
    resources,
  });
}

async function deliveryFixture(t, mode) {
  const fixture = await repositoryFixture(t);
  const { repositoryRoot, baseCommit } = fixture;
  await git(repositoryRoot, "checkout", "-b", "topic");
  await writeFile(join(repositoryRoot, "tracked.txt"), "task modification\n");
  await git(repositoryRoot, "commit", "-am", "first task change");
  await writeFile(join(repositoryRoot, "additional.txt"), "second task change\n");
  await git(repositoryRoot, "add", "additional.txt");
  await git(repositoryRoot, "commit", "-m", "second task change");
  const tipCommit = await git(repositoryRoot, "rev-parse", "HEAD");
  await git(repositoryRoot, "update-ref", "refs/backup/original", tipCommit);
  await git(repositoryRoot, "checkout", "main");
  await writeFile(join(repositoryRoot, "main-only.txt"), "independent main change\n");
  await git(repositoryRoot, "add", "main-only.txt");
  await git(repositoryRoot, "commit", "-m", "independent main change");
  const deliveredBaseCommit = await git(repositoryRoot, "rev-parse", "HEAD");
  if (mode === "merge") {
    await git(repositoryRoot, "merge", "--no-ff", "topic", "-m", "deliver merge");
  } else if (mode === "squash") {
    await git(repositoryRoot, "merge", "--squash", "topic");
    await git(repositoryRoot, "commit", "-m", "deliver squash");
  } else {
    await git(repositoryRoot, "checkout", "topic");
    await git(repositoryRoot, "rebase", "main");
    await git(repositoryRoot, "checkout", "main");
    await git(repositoryRoot, "merge", "--ff-only", "topic");
  }
  const deliveredCommit = await git(repositoryRoot, "rev-parse", "HEAD");
  await git(repositoryRoot, "push", "origin", "main");
  const delivery = {
    baseCommit,
    tipCommit,
    remote: "origin",
    targetRef: "refs/heads/main",
    deliveredCommit,
    deliveredBaseCommit,
  };
  const resource = localRef("refs/backup/original", {
    disposition: "absent",
    delivery,
  });
  return {
    ...fixture,
    delivery,
    resource,
  };
}

test("when a Git declaration uses a pattern or command-like remote, rejects it before observation", () => {
  // Arrange
  const invalidResources = [
    localRef("main"),
    localRef("refs/heads/*"),
    localRef("refs/heads/topic..other"),
    localRef("refs/heads/.hidden"),
    localRef("refs/heads/topic.lock"),
    {
      kind: "git-worktree",
      path: "relative/path",
    },
    {
      kind: "git-remote-ref",
      ref: "refs/heads/main",
      remote: "https://example.invalid/repo",
    },
  ];

  // Act / Assert
  for (const resource of invalidResources) {
    assert.throws(() => validateGitResource(resource), Error);
  }
});

test("when exact local refs include backup refs and tags, observes object identity without prefix matches", async (t) => {
  // Arrange
  const { repositoryRoot, baseCommit } = await repositoryFixture(t);
  await git(repositoryRoot, "update-ref", "refs/backup/task", baseCommit);
  await git(repositoryRoot, "tag", "-a", "release", "-m", "annotated tag");
  const tagObject = await git(repositoryRoot, "rev-parse", "refs/tags/release");
  const resources = [localRef("refs/backup/task"), localRef("refs/backup/tas"), localRef("refs/tags/release")];

  // Act
  const results = await observe(repositoryRoot, resources);

  // Assert
  assert.equal(results[0].identity.objectId, baseCommit);
  assert.equal(results[1].present, false);
  assert.equal(results[1].identity.objectId, null);
  assert.equal(results[2].identity.objectId, tagObject);
});

test("when a remote exact ref disappears, observes fresh absence while transport failure stays unavailable", async (t) => {
  // Arrange
  const { repositoryRoot } = await repositoryFixture(t);
  const resource = {
    id: "remote-main",
    kind: "git-remote-ref",
    remote: "origin",
    ref: "refs/heads/main",
    disposition: "retained",
  };
  const before = await observe(repositoryRoot, [resource]);
  await git(repositoryRoot, "push", "origin", "refs/heads/main:refs/heads/main-backup");
  await git(repositoryRoot, "--git-dir", join(repositoryRoot, "..", "remote.git"), "config", "receive.denyDeleteCurrent", "ignore");
  await git(repositoryRoot, "push", "origin", ":refs/heads/main");

  // Act
  const absent = await observe(repositoryRoot, [resource]);
  await git(repositoryRoot, "remote", "set-url", "origin", "file:///not-present/credential-secret.git");
  const failed = await observe(repositoryRoot, [resource]);

  // Assert
  assert.equal(before[0].present, true);
  assert.equal(absent[0].present, false);
  assert.match(failed[0].error, /unavailable/);
  assert.doesNotMatch(JSON.stringify(failed), /credential-secret/);
});

test("when a declared remote is not configured, does not interpret it as a URL or report absence", async (t) => {
  // Arrange
  const { repositoryRoot } = await repositoryFixture(t);
  const resource = {
    id: "remote",
    kind: "git-remote-ref",
    remote: "unconfigured",
    ref: "refs/heads/main",
  };

  // Act
  const [result] = await observe(repositoryRoot, [resource]);

  // Assert
  assert.equal(result.error, "Git remote is not configured");
  assert.equal(result.present, undefined);
});

test("when a registered checkout is dirty, inventories tracked, untracked and ignored content without mutation", async (t) => {
  // Arrange
  const { root, repositoryRoot, baseCommit } = await repositoryFixture(t);
  const path = join(root, "task-worktree");
  await git(repositoryRoot, "worktree", "add", "-b", "task", path);
  await writeFile(join(path, "tracked.txt"), "working edit\n");
  await writeFile(join(path, "new.txt"), "untracked secret body\n");
  await writeFile(join(path, "ignored.secret"), "ignored secret body\n");
  const resource = {
    id: "worktree",
    kind: "git-worktree",
    path,
    disposition: "retained",
  };
  const indexPath = await git(path, "rev-parse", "--path-format=absolute", "--git-path", "index");
  const beforeIndex = await readFile(indexPath);
  const beforeRefs = await git(repositoryRoot, "show-ref");
  const beforeWorktrees = await git(repositoryRoot, "worktree", "list", "--porcelain");

  // Act
  const [first] = await observe(repositoryRoot, [resource]);
  const [second] = await observe(repositoryRoot, [resource]);
  const afterIndex = await readFile(indexPath);
  const afterRefs = await git(repositoryRoot, "show-ref");
  const afterWorktrees = await git(repositoryRoot, "worktree", "list", "--porcelain");

  // Assert
  assert.equal(first.identity.head, baseCommit);
  assert.equal(first.present, true);
  assert.deepEqual(first.details, {
    trackedChanges: ["tracked.txt"],
    untrackedPaths: ["new.txt"],
    ignoredPaths: ["ignored.secret"],
  });
  assert.deepEqual(second.identity, first.identity);
  assert.deepEqual(afterIndex, beforeIndex);
  assert.equal(afterRefs, beforeRefs);
  assert.equal(afterWorktrees, beforeWorktrees);
  assert.doesNotMatch(JSON.stringify(first), /secret body|working edit/);
});

for (const filename of ["tracked.txt", "new.txt", "ignored.secret"]) {
  test(`when retained ${filename} content changes at the same path, content identity changes`, async (t) => {
    // Arrange
    const { repositoryRoot } = await repositoryFixture(t);
    await writeFile(join(repositoryRoot, "new.txt"), "before\n");
    await writeFile(join(repositoryRoot, "ignored.secret"), "before\n");
    const resource = {
      id: "retained",
      kind: "git-worktree",
      path: repositoryRoot,
      disposition: "retained",
    };
    const [before] = await observe(repositoryRoot, [resource]);

    // Act
    await writeFile(join(repositoryRoot, filename), "after!\n");
    const [after] = await observe(repositoryRoot, [resource]);

    // Assert
    assert.equal(before.error, undefined);
    assert.equal(after.error, undefined);
    assert.notEqual(after.identity.contentFingerprint, before.identity.contentFingerprint);
  });
}

test("when ignored content exceeds inventory bounds, blocks instead of certifying path-only preservation", async (t) => {
  // Arrange
  const { repositoryRoot } = await repositoryFixture(t);
  await writeFile(join(repositoryRoot, "ignored.secret"), Buffer.alloc(4 * 1024 * 1024 + 1));
  const resource = {
    id: "large",
    kind: "git-worktree",
    path: repositoryRoot,
    disposition: "retained",
  };

  // Act
  const [result] = await observe(repositoryRoot, [resource]);

  // Assert
  assert.match(result.error, /exceeds byte bound/);
  assert.equal(result.identity, undefined);
});

test("when a worktree directory is removed but still registered, does not mistake stale registration for absence", async (t) => {
  // Arrange
  const { root, repositoryRoot, baseCommit } = await repositoryFixture(t);
  const path = join(root, "missing-worktree");
  await git(repositoryRoot, "worktree", "add", "--detach", path);
  await rm(path, {
    recursive: true,
    force: true,
  });
  const resource = {
    id: "stale",
    kind: "git-worktree",
    path,
    disposition: "retained",
  };

  // Act
  const [result] = await observe(repositoryRoot, [resource]);
  const registrations = await git(repositoryRoot, "worktree", "list", "--porcelain");

  // Assert
  assert.equal(result.present, true);
  assert.equal(result.identity.registered, true);
  assert.equal(result.identity.pathExists, false);
  assert.equal(result.identity.head, baseCommit);
  assert.match(registrations, /missing-worktree/);
});

test("when existing paths are unregistered, foreign or aliases, refuses to infer resource ownership", async (t) => {
  // Arrange
  const { root, repositoryRoot } = await repositoryFixture(t);
  const foreign = await repositoryFixture(t);
  const arbitraryPath = join(root, "ordinary-directory");
  const aliasPath = join(root, "alias");
  await mkdir(arbitraryPath);
  await symlink(repositoryRoot, aliasPath);
  const resources = [arbitraryPath, foreign.repositoryRoot, aliasPath].map((path) => ({
    id: path,
    kind: "git-worktree",
    path,
    disposition: "retained",
  }));

  // Act
  const results = await observe(repositoryRoot, resources);

  // Assert
  for (const result of results) {
    assert.match(result.error, /not the exact registered/);
    assert.equal(result.present, undefined);
  }
});

test("when a checkout is replaced by a foreign repository at the registered path, refuses ownership", async (t) => {
  // Arrange
  const { root, repositoryRoot } = await repositoryFixture(t);
  const path = join(root, "replaced-worktree");
  await git(repositoryRoot, "worktree", "add", "--detach", path);
  await rm(path, {
    recursive: true,
    force: true,
  });
  await mkdir(path);
  await git(path, "init", "--initial-branch=main");
  const resource = {
    id: "replaced",
    kind: "git-worktree",
    path,
    disposition: "retained",
  };

  // Act
  const [result] = await observe(repositoryRoot, [resource]);

  // Assert
  assert.match(result.error, /different repository or checkout/);
});

test("when a resource was already absent without delivery, observes absence without inventing historical proof", async (t) => {
  // Arrange
  const { root, repositoryRoot } = await repositoryFixture(t);
  const resources = [
    localRef("refs/backup/already-absent", {
      disposition: "absent",
    }),
    {
      id: "missing-worktree",
      kind: "git-worktree",
      path: join(root, "never-created"),
      disposition: "absent",
    },
  ];

  // Act
  const results = await observe(repositoryRoot, resources);

  // Assert
  assert.equal(results[0].present, false);
  assert.equal(results[1].present, false);
});

test("when a present removal resource has no delivery, refuses an unproven cleanup baseline", async (t) => {
  // Arrange
  const { repositoryRoot } = await repositoryFixture(t);
  const resource = localRef("refs/heads/main", {
    disposition: "absent",
  });

  // Act
  const [result] = await observe(repositoryRoot, [resource]);

  // Assert
  assert.match(result.error, /requires delivery proof/);
});

for (const mode of ["merge", "squash", "rebase"]) {
  test(`when delivery uses ${mode}, proves complete delivery against the fresh exact remote target`, async (t) => {
    // Arrange
    const { repositoryRoot, resource, delivery } = await deliveryFixture(t, mode);

    // Act
    const [result] = await observe(repositoryRoot, [resource]);

    // Assert
    assert.equal(result.error, undefined);
    assert.equal(result.present, true);
    assert.equal(result.identity.objectId, delivery.tipCommit);
  });
}

test("when a rewritten delivery loses one changed path, rejects partial equivalence", async (t) => {
  // Arrange
  const { repositoryRoot, resource, delivery } = await deliveryFixture(t, "squash");
  await git(repositoryRoot, "reset", "--hard", delivery.deliveredBaseCommit);
  await writeFile(join(repositoryRoot, "tracked.txt"), "task modification\n");
  await git(repositoryRoot, "commit", "-am", "incomplete squash");
  const incompleteCommit = await git(repositoryRoot, "rev-parse", "HEAD");
  await git(repositoryRoot, "push", "--force", "origin", "main");
  resource.delivery.deliveredCommit = incompleteCommit;

  // Act
  const [result] = await observe(repositoryRoot, [resource]);

  // Assert
  assert.match(result.error, /changed paths or exact tree content differ/);
});

test("when changed paths match but delivered bytes differ, rejects rewritten equivalence", async (t) => {
  // Arrange
  const { repositoryRoot, resource } = await deliveryFixture(t, "squash");
  await writeFile(join(repositoryRoot, "additional.txt"), "different delivered content\n");
  await git(repositoryRoot, "commit", "-am", "alter delivered bytes");
  resource.delivery.deliveredCommit = await git(repositoryRoot, "rev-parse", "HEAD");
  await git(repositoryRoot, "push", "origin", "main");

  // Act
  const [result] = await observe(repositoryRoot, [resource]);

  // Assert
  assert.match(result.error, /exact tree content differ/);
});

test("when a remote delivery moves after removal, rechecks proof rather than reusing the previous result", async (t) => {
  // Arrange
  const { repositoryRoot, remote, resource, baseCommit } = await deliveryFixture(t, "merge");
  const [before] = await observe(repositoryRoot, [resource]);
  await git(repositoryRoot, "update-ref", "-d", resource.ref);
  const [removed] = await observe(repositoryRoot, [resource]);
  await git(remote, "update-ref", "refs/heads/main", baseCommit);

  // Act
  const [after] = await observe(repositoryRoot, [resource]);

  // Assert
  assert.equal(before.error, undefined);
  assert.equal(removed.present, false);
  assert.match(after.error, /not contained in the fresh remote target/);
});

test("when a remote target commit is not locally available, blocks without fetching objects", async (t) => {
  // Arrange
  const { repositoryRoot, remote, resource } = await deliveryFixture(t, "merge");
  const { repositoryRoot: otherRepository } = await repositoryFixture(t);
  await git(otherRepository, "remote", "set-url", "origin", remote);
  await writeFile(join(otherRepository, "remote-only.txt"), "remote-only object\n");
  await git(otherRepository, "add", "remote-only.txt");
  await git(otherRepository, "commit", "-m", "remote-only commit");
  const remoteOnlyCommit = await git(otherRepository, "rev-parse", "HEAD");
  await git(otherRepository, "push", "--force", "origin", "main");

  // Act
  const [result] = await observe(repositoryRoot, [resource]);
  const missingObject = await git(repositoryRoot, "rev-list", "--all");

  // Assert
  assert.match(result.error, /unavailable/);
  assert.doesNotMatch(missingObject, new RegExp(remoteOnlyCommit));
});

test("when a delivery tip mismatches the resource, blocks even if another tip was merged", async (t) => {
  // Arrange
  const { repositoryRoot, resource, baseCommit } = await deliveryFixture(t, "merge");
  resource.delivery.tipCommit = baseCommit;

  // Act
  const [result] = await observe(repositoryRoot, [resource]);

  // Assert
  assert.match(result.error, /tip does not match current resource identity/);
});

test("when repository prerequisites are missing, returns aligned errors instead of absence", async (t) => {
  // Arrange
  const { root } = await repositoryFixture(t);
  const repositoryRoot = join(root, "not-a-repository");
  const resources = [localRef("refs/heads/main"), localRef("refs/heads/other")];

  // Act
  const results = await observe(repositoryRoot, resources);

  // Assert
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.match(result.error, /unavailable/);
    assert.equal(result.present, undefined);
  }
});

test("when one resource is malformed, continues independently observing later resources", async (t) => {
  // Arrange
  const { repositoryRoot } = await repositoryFixture(t);
  const resources = [localRef("refs/heads/*"), localRef("refs/heads/main")];

  // Act
  const results = await observe(repositoryRoot, resources);

  // Assert
  assert.match(results[0].error, /fully qualified exact ref/);
  assert.equal(results[1].present, true);
});

test("when a remote configuration changes while both exact refs are absent, records changed authority", async (t) => {
  // Arrange
  const { repositoryRoot } = await repositoryFixture(t);
  const other = await repositoryFixture(t);
  const resource = {
    id: "remote-absent",
    kind: "git-remote-ref",
    remote: "origin",
    ref: "refs/heads/absent",
    disposition: "absent",
  };
  const [before] = await observe(repositoryRoot, [resource]);
  await git(repositoryRoot, "remote", "set-url", "origin", other.remote);

  // Act
  const [after] = await observe(repositoryRoot, [resource]);

  // Assert
  assert.equal(before.present, false);
  assert.equal(after.present, false);
  assert.notDeepEqual(after.provenance, before.provenance);
  assert.doesNotMatch(JSON.stringify(after.provenance), new RegExp(other.remote));
});

for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
  test(`when tracked changes are hidden with ${flag}, refuses to certify a clean inventory`, async (t) => {
    // Arrange
    const { repositoryRoot } = await repositoryFixture(t);
    await git(repositoryRoot, "update-index", flag, "tracked.txt");
    await writeFile(join(repositoryRoot, "tracked.txt"), "hidden tracked changes\n");
    const resource = {
      id: "hidden-changes",
      kind: "git-worktree",
      path: repositoryRoot,
      disposition: "retained",
    };

    // Act
    const [result] = await observe(repositoryRoot, [resource]);

    // Assert
    assert.match(result.error, /assume-unchanged or skip-worktree/);
    assert.equal(result.identity, undefined);
  });
}

test("when tracked content has an external clean filter, blocks before Git can execute that filter", async (t) => {
  // Arrange
  const { repositoryRoot } = await repositoryFixture(t);
  await git(repositoryRoot, "config", "filter.closeout.clean", "false");
  await git(repositoryRoot, "config", "filter.closeout.required", "true");
  await writeFile(join(repositoryRoot, ".gitattributes"), "tracked.txt filter=closeout\n");
  await writeFile(join(repositoryRoot, "tracked.txt"), "modified tracked content\n");
  const resource = {
    id: "filtered-content",
    kind: "git-worktree",
    path: repositoryRoot,
    disposition: "retained",
  };

  // Act
  const [result] = await observe(repositoryRoot, [resource]);

  // Assert
  assert.equal(result.error, "Git tracked inventory requires an external content filter");
});

test("when rewritten proof omits its delivered base, does not infer equivalence from commit messages", async (t) => {
  // Arrange
  const { repositoryRoot, resource } = await deliveryFixture(t, "squash");
  delete resource.delivery.deliveredBaseCommit;

  // Act
  const [result] = await observe(repositoryRoot, [resource]);

  // Assert
  assert.equal(result.error, "Rewritten Git delivery requires deliveredBaseCommit");
});

test("when an original delivery base is not an ancestor, rejects the declared range", async (t) => {
  // Arrange
  const { repositoryRoot, resource, delivery } = await deliveryFixture(t, "squash");
  resource.delivery.baseCommit = delivery.deliveredBaseCommit;

  // Act
  const [result] = await observe(repositoryRoot, [resource]);

  // Assert
  assert.equal(result.error, "Git delivery base is not an ancestor of the original tip");
});

test("when an explicit delivered base is not an ancestor, rejects it even for an ordinary merge", async (t) => {
  // Arrange
  const { repositoryRoot, resource } = await deliveryFixture(t, "merge");
  await writeFile(join(repositoryRoot, "later.txt"), "not part of delivered commit\n");
  await git(repositoryRoot, "add", "later.txt");
  await git(repositoryRoot, "commit", "-m", "later commit");
  resource.delivery.deliveredBaseCommit = await git(repositoryRoot, "rev-parse", "HEAD");

  // Act
  const [result] = await observe(repositoryRoot, [resource]);

  // Assert
  assert.equal(result.error, "Git delivered base is not an ancestor of the delivered commit");
});

test("when rewritten delivery changes file mode but not bytes, rejects unequal tree content", async (t) => {
  // Arrange
  const { repositoryRoot, resource } = await deliveryFixture(t, "squash");
  await git(repositoryRoot, "update-index", "--chmod=+x", "additional.txt");
  await git(repositoryRoot, "commit", "-m", "alter delivered mode");
  resource.delivery.deliveredCommit = await git(repositoryRoot, "rev-parse", "HEAD");
  await git(repositoryRoot, "push", "origin", "main");

  // Act
  const [result] = await observe(repositoryRoot, [resource]);

  // Assert
  assert.match(result.error, /exact tree content differ/);
});

test("when a delivered worktree is removed, verifies its exact HEAD first and remote delivery again afterward", async (t) => {
  // Arrange
  const { root, repositoryRoot, delivery } = await deliveryFixture(t, "merge");
  const path = join(root, "delivered-worktree ");
  await git(repositoryRoot, "worktree", "add", "--detach", path, delivery.tipCommit);
  const resource = {
    id: "delivered-worktree",
    kind: "git-worktree",
    path,
    disposition: "absent",
    delivery,
  };
  const [before] = await observe(repositoryRoot, [resource]);
  await git(repositoryRoot, "worktree", "remove", path);

  // Act
  const [after] = await observe(repositoryRoot, [resource]);

  // Assert
  assert.equal(before.error, undefined);
  assert.equal(before.identity.head, delivery.tipCommit);
  assert.equal(before.identity.path, path);
  assert.equal(after.error, undefined);
  assert.equal(after.present, false);
  assert.deepEqual(after.provenance, before.provenance);
});

test("when an untracked symlink target changes, fingerprints the link without reading its target", async (t) => {
  // Arrange
  const { repositoryRoot } = await repositoryFixture(t);
  const linkPath = join(repositoryRoot, "untracked-link");
  await symlink("/nonexistent/first-secret-target", linkPath);
  const resource = {
    id: "symlink",
    kind: "git-worktree",
    path: repositoryRoot,
    disposition: "retained",
  };
  const [before] = await observe(repositoryRoot, [resource]);
  await rm(linkPath);
  await symlink("/nonexistent/other-secret-target", linkPath);

  // Act
  const [after] = await observe(repositoryRoot, [resource]);

  // Assert
  assert.equal(before.error, undefined);
  assert.equal(after.error, undefined);
  assert.notEqual(after.identity.contentFingerprint, before.identity.contentFingerprint);
  assert.deepEqual(after.details.untrackedPaths, ["untracked-link"]);
  assert.doesNotMatch(JSON.stringify(after), /secret-target/);
});
