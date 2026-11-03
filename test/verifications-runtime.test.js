import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runVerificationCheck } from "#root/omp-plugin/verifications.js";

test("when OMP has a non-Node executable, runs verification checks with Node", async () => {
  // Arrange
  const checkDirectory = await mkdtemp(join(tmpdir(), "omp-verifier-runtime-"));
  const checkPath = join(checkDirectory, "check.mjs");
  const originalExecutable = process.execPath;

  try {
    await writeFile(
      checkPath,
      'process.stdout.write(JSON.stringify({ status: "PASS", summary: "Node ran the check" }));\n',
    );

    const runtimeCheck = {
      id: "runtime:node",
      entryPath: checkPath,
      timeoutMs: 1_000,
    };
    process.execPath = "missing-omp-runtime";

    // Act
    const result = await runVerificationCheck(runtimeCheck, checkDirectory);

    // Assert
    assert.deepEqual(result, {
      id: "runtime:node",
      status: "PASS",
      summary: "Node ran the check",
    });
  } finally {
    process.execPath = originalExecutable;
    await rm(checkDirectory, { recursive: true, force: true });
  }
});

test("when no automatic checks are installed, automatic CLI emits an empty result", async () => {
  // Arrange
  const projectDirectory = await mkdtemp(join(tmpdir(), "omp-verifier-cli-"));
  const agentDirectory = join(projectDirectory, "agent");

  try {
    // Act
    const output = execFileSync(process.execPath, [join(process.cwd(), "bin", "omp-verifier.js"), "automatic"], {
      cwd: projectDirectory,
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory },
    });

    // Assert
    assert.deepEqual(JSON.parse(output), []);
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});

test("when automatic CLI receives explicit paths, ignores stale worktree paths unless explicitly requested", async () => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-cli-paths-"));
  const agentDirectory = join(root, "agent");
  const packageDirectory = join(root, "plugins", "node_modules", "publisher");
  const projectDirectory = join(root, "project");
  const runAutomatic = paths => {
    try {
      return { exitCode: 0, output: execFileSync(process.execPath, [join(process.cwd(), "bin", "omp-verifier.js"), "automatic", ...paths], {
        cwd: projectDirectory,
        encoding: "utf8",
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory },
      }) };
    } catch (error) {
      return { exitCode: error.status, output: error.stdout };
    }
  };

  try {
    await mkdir(join(projectDirectory, "src"), { recursive: true });
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(projectDirectory, "src", "stale.ts"), "export {};\n");
    for (const args of [["init", "--quiet"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test"], ["add", "."], ["commit", "--quiet", "-m", "baseline"]]) {
      execFileSync("git", args, { cwd: projectDirectory });
    }
    await writeFile(join(projectDirectory, "src", "stale.ts"), "export {};\n// stale\n");
    await writeFile(join(projectDirectory, "now.cwli"), "fields @message\n");
    await writeFile(join(root, "plugins", "package.json"), JSON.stringify({
      name: "omp-plugins",
      dependencies: { publisher: "1.0.0" },
    }));
    await writeFile(join(packageDirectory, "package.json"), JSON.stringify({
      name: "publisher",
      omp: {
        extensions: ["./index.js"],
        verifications: [{
          id: "publisher:typescript",
          label: "TypeScript check",
          description: "Fails when selected",
          entry: "./check.mjs",
          pathTriggers: ["**/*.ts"],
        }],
      },
    }));
    await writeFile(join(packageDirectory, "check.mjs"), 'process.stdout.write(JSON.stringify({ status: "FAIL", summary: "fixture failure" })); process.exitCode = 1;\n');

    // Act
    const unrelated = runAutomatic(["now.cwli"]);
    await writeFile(join(projectDirectory, "src", "current.ts"), "export {};\n");
    const current = runAutomatic(["src/current.ts"]);
    const worktree = runAutomatic(["--worktree"]);

    // Assert
    assert.equal(unrelated.exitCode, 0);
    assert.deepEqual(JSON.parse(unrelated.output), []);
    assert.equal(current.exitCode, 1);
    assert.deepEqual(JSON.parse(current.output)[0].matches, [{ path: "src/current.ts", trigger: "**/*.ts" }]);
    assert.equal(JSON.parse(worktree.output)[0].matches.some(match => match.path === "src/stale.ts"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function baseScopeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-base-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectDirectory = join(root, "project");
  const packageDirectory = join(root, "plugins", "node_modules", "publisher");
  await mkdir(projectDirectory);
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(root, "plugins", "package.json"), JSON.stringify({ dependencies: { publisher: "1.0.0" } }));
  await writeFile(join(packageDirectory, "package.json"), JSON.stringify({
    name: "publisher",
    omp: { extensions: ["./index.js"], verifications: [{
      id: "publisher:syntax",
      label: "Source syntax",
      description: "Checks the syntax of selected existing JavaScript sources",
      entry: "./check.mjs",
      pathTriggers: ["**/*.js"],
    }] },
  }));
  await writeFile(join(packageDirectory, "check.mjs"), `
import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
const violations = [];
let inspected = 0;
for (const path of JSON.parse(process.env.OMP_VERIFIER_CHANGED_PATHS)) {
  try { await access(path); } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  inspected += 1;
  const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  if (result.status !== 0) violations.push(path + ": " + result.stderr);
}
process.stdout.write(JSON.stringify({
  status: violations.length ? "FAIL" : inspected ? "PASS" : "N/A",
  summary: violations.length ? "Selected source has invalid syntax" : inspected ? "Selected source syntax is valid" : "No existing source applies",
  evidence: violations.join("\\n"),
}));
if (violations.length) process.exitCode = 1;
`);
  const git = (...args) => execFileSync("git", args, { cwd: projectDirectory, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Scope fixture");
  const commit = message => {
    git("add", ".");
    git("commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const run = (command, ...args) => spawnSync(process.execPath, [join(process.cwd(), "bin/omp-verifier.js"), command, ...args], {
    cwd: projectDirectory,
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") },
  });
  return { projectDirectory, git, commit, run };
}

test("when PR verification has an earlier committed violation, the actual base includes it but excludes untouched baseline failures", async t => {
  // Arrange
  const { projectDirectory, commit, run } = await baseScopeFixture(t);
  await writeFile(join(projectDirectory, "untouched.js"), "const invalid = ;\n");
  const base = commit("baseline");
  await writeFile(join(projectDirectory, "earlier.js"), "const invalid = ;\n");
  commit("earlier invalid PR change");
  await writeFile(join(projectDirectory, "later.js"), "export const later = true;\n");
  commit("later valid PR change");
  await writeFile(join(projectDirectory, "current.js"), "export const current = true;\n");
  await writeFile(join(projectDirectory, "unrelated-dirty.js"), "const invalid = ;\n");

  // Act
  const failing = run("automatic", "--base", base, "current.js");
  await writeFile(join(projectDirectory, "earlier.js"), "export const earlier = true;\n");
  const repaired = run("automatic", "--base", base, "current.js");

  // Assert
  assert.equal(failing.status, 1);
  assert.match(JSON.parse(failing.stdout)[0].evidence, /earlier\.js/);
  assert.deepEqual(JSON.parse(failing.stdout)[0].matches, [
    { path: "earlier.js", trigger: "**/*.js" },
    { path: "later.js", trigger: "**/*.js" },
    { path: "current.js", trigger: "**/*.js" },
  ]);
  assert.equal(repaired.status, 0);
  assert.equal(JSON.parse(repaired.stdout)[0].status, "PASS");
});

test("when a stacked PR names its parent as base, parent-only violations are not attributed to the child", async t => {
  // Arrange
  const { projectDirectory, commit, run } = await baseScopeFixture(t);
  await writeFile(join(projectDirectory, "baseline.js"), "export const baseline = true;\n");
  const trunk = commit("trunk");
  await writeFile(join(projectDirectory, "parent.js"), "const invalid = ;\n");
  const parent = commit("parent change");
  await writeFile(join(projectDirectory, "child.js"), "export const child = true;\n");
  commit("child change");

  // Act
  const child = run("automatic", "--base", parent);
  const entireStack = run("automatic", "--base", trunk);

  // Assert
  assert.equal(child.status, 0);
  assert.equal(JSON.parse(child.stdout)[0].status, "PASS");
  assert.deepEqual(JSON.parse(child.stdout)[0].matches, [{ path: "child.js", trigger: "**/*.js" }]);
  assert.equal(entireStack.status, 1);
  assert.match(JSON.parse(entireStack.stdout)[0].evidence, /parent\.js/);
});

test("when PR source is renamed, selection retains the old deletion and checks the new source", async t => {
  // Arrange
  const { projectDirectory, commit, run } = await baseScopeFixture(t);
  await writeFile(join(projectDirectory, "old.js"), "export const old = true;\n");
  const base = commit("old source");
  await rename(join(projectDirectory, "old.js"), join(projectDirectory, "new.js"));
  await writeFile(join(projectDirectory, "new.js"), "const invalid = ;\n");
  commit("renamed invalid source");

  // Act
  const result = run("automatic", "--base", base);

  // Assert
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout)[0].evidence, /new\.js/);
  assert.deepEqual(JSON.parse(result.stdout)[0].matches, [
    { path: "new.js", trigger: "**/*.js" },
    { path: "old.js", trigger: "**/*.js" },
  ]);
});

test("when a PR deletes its only applicable source or has no diff, verification does not lint unrelated sources", async t => {
  // Arrange
  const { projectDirectory, commit, run } = await baseScopeFixture(t);
  await writeFile(join(projectDirectory, "removed.js"), "export const removed = true;\n");
  await writeFile(join(projectDirectory, "baseline.js"), "const invalid = ;\n");
  const base = commit("baseline");
  await rm(join(projectDirectory, "removed.js"));
  commit("delete source");

  // Act
  const deleted = run("automatic", "--base", base);
  const empty = run("automatic", "--base", "HEAD");

  // Assert
  assert.equal(deleted.status, 0);
  assert.deepEqual(JSON.parse(deleted.stdout), []);
  assert.equal(empty.status, 0);
  assert.deepEqual(JSON.parse(empty.stdout), []);
});

test("when the requested base is unavailable or has unrelated ancestry, verification remains BLOCKED", async t => {
  // Arrange
  const { projectDirectory, git, commit, run } = await baseScopeFixture(t);
  await writeFile(join(projectDirectory, "baseline.js"), "export const baseline = true;\n");
  const base = commit("baseline");
  git("checkout", "--quiet", "--orphan", "unrelated");
  git("rm", "-rf", "--quiet", ".");
  await writeFile(join(projectDirectory, "other.js"), "export const other = true;\n");
  commit("unrelated root");

  // Act
  const missing = run("automatic", "--base", "missing-ref");
  const unrelated = run("automatic", "--base", base);

  // Assert
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout)[0].status, "BLOCKED");
  assert.equal(unrelated.status, 1);
  assert.equal(JSON.parse(unrelated.stdout)[0].status, "BLOCKED");
});

test("when base selection is combined with another scope or command, the CLI rejects the ambiguous invocation", async t => {
  // Arrange
  const { projectDirectory, commit, run } = await baseScopeFixture(t);
  await writeFile(join(projectDirectory, "baseline.js"), "export const baseline = true;\n");
  commit("baseline");

  // Act
  const worktree = run("automatic", "--base", "HEAD", "--worktree");
  const manual = run("verify", "--base", "HEAD");

  // Assert
  assert.equal(worktree.status, 2);
  assert.equal(manual.status, 2);
});
